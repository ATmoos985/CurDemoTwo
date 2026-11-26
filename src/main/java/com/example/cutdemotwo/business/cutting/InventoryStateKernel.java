package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.CutReport;
import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.DemandTemplate;
import com.example.cutdemotwo.business.model.ExecutionOrder;
import com.example.cutdemotwo.business.model.InventoryCount;
import com.example.cutdemotwo.business.model.InventoryEvent;
import com.example.cutdemotwo.business.model.InventoryLedgerEntry;
import com.example.cutdemotwo.business.model.InventoryReceiptDocument;
import com.example.cutdemotwo.business.model.InventoryTransfer;
import com.example.cutdemotwo.business.model.MaterialIssueDocument;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.QualityDisposition;
import com.example.cutdemotwo.business.model.QualityReleaseDocument;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.persistence.InventoryConflictException;
import com.example.cutdemotwo.persistence.InventoryDelta;
import com.example.cutdemotwo.persistence.InventorySnapshot;
import com.example.cutdemotwo.persistence.InventoryStore;
import tools.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import java.util.function.BiPredicate;
import java.util.function.Supplier;
import java.util.stream.Collectors;

/**
 * 库存与裁切聚合状态内核：
 * 统一封装内存态聚合容器、ReentrantReadWriteLock 读写锁与锁降级刷新、零 JSON 写前备份、
 * InventoryDelta 定点增量落库、InventoryJournal 增量账本索引、独立需求模板持久化及跨垂直域共享不变量原语。
 * 严格保持下三角依赖：绝不依赖上层业务垂直服务或 RemnantService 门面。
 */
final class InventoryStateKernel {

    final Map<String, RemnantStock> remnantPool = new ConcurrentHashMap<>();
    final Map<String, MotherRollInfo> motherRolls = new LinkedHashMap<>();
    final AtomicInteger remnantSeq = new AtomicInteger(10);
    final AtomicInteger defectSeq = new AtomicInteger(20);
    final Map<String, Map<String, Object>> receipts = new LinkedHashMap<>();
    final Map<String, CuttingTask> tasks = new LinkedHashMap<>();
    final ObjectMapper json = new ObjectMapper();
    final InventoryStore store;
    final Map<String, CuttingPlan> plans = new LinkedHashMap<>();
    final Map<String, ExecutionOrder> executions = new LinkedHashMap<>();
    final Map<String, InventoryTransfer> transfers = new LinkedHashMap<>();
    List<InventoryLedgerEntry> ledger = List.of();
    List<InventoryEvent> outbox = List.of();
    final Map<String, InventoryCount> counts = new LinkedHashMap<>();
    final Map<String, DemandTemplate> templates = new LinkedHashMap<>();
    final Map<String, SchedulingScheme> schemes = new LinkedHashMap<>();
    final Map<String, QualityReleaseDocument> qualityReleases = new LinkedHashMap<>();
    final Map<String, InventoryReceiptDocument> inventoryReceipts = new LinkedHashMap<>();
    final Map<String, MaterialIssueDocument> materialIssues = new LinkedHashMap<>();
    volatile long revision;
    volatile double measurementToleranceMm = 5;

    private final ReentrantReadWriteLock rwLock = new ReentrantReadWriteLock();
    private final ThreadLocal<AccessFrame> accessFrame = new ThreadLocal<>();
    private InventoryJournal.BalanceIndex balanceIndex;
    private final TableSortIndex rollSort = new TableSortIndex();
    private final TableSortIndex remnantSort = new TableSortIndex();
    private final TableSortIndex taskSort = new TableSortIndex();
    private final TableSortIndex planSort = new TableSortIndex();
    private final TableSortIndex receiptSort = new TableSortIndex();
    private final TableSortIndex executionSort = new TableSortIndex();
    private final TableSortIndex schemeSort = new TableSortIndex();

    InventoryStateKernel(InventoryStore store) {
        this.store = store;
    }

    /** 维护各可变主表的稳定 sort_order 映射，支持 JDBC 定点 UPSERT 时保持原有行序且不重排未变动行。 */
    private static final class TableSortIndex {
        final Map<String, Long> orders = new LinkedHashMap<>();
        long nextOrder = 0L;

        void reset(Collection<String> ids) {
            orders.clear();
            nextOrder = 0L;
            for (String id : ids) {
                orders.put(id, nextOrder++);
            }
        }

        long peekOrder(String id, Map<String, Long> stagedNewOrders, long[] stagedNext) {
            Long existing = orders.get(id);
            if (existing != null) return existing;
            Long staged = stagedNewOrders.get(id);
            if (staged != null) return staged;
            long assigned = stagedNext[0]++;
            stagedNewOrders.put(id, assigned);
            return assigned;
        }

        void commit(Map<String, Long> stagedNewOrders, Collection<String> deletedIds, long newNext) {
            if (deletedIds != null) {
                for (String id : deletedIds) orders.remove(id);
            }
            if (stagedNewOrders != null && !stagedNewOrders.isEmpty()) {
                orders.putAll(stagedNewOrders);
            }
            this.nextOrder = newNext;
        }
    }

    /** 写事务轻量写前备份：不可变 Record 集合仅浅拷贝 Map 引用，零 JSON 序列化、零全库历史深拷贝。 */
    record TxBackup(
            Map<String, MotherRollInfo> rolls,
            Map<String, RemnantStock> remnants,
            Map<String, Map<String, Object>> receipts,
            Map<String, CuttingTask> tasks,
            Map<String, CuttingPlan> plans,
            Map<String, ExecutionOrder> executions,
            Map<String, InventoryTransfer> transfers,
            Map<String, InventoryCount> counts,
            Map<String, DemandTemplate> templates,
            Map<String, SchedulingScheme> schemes,
            Map<String, QualityReleaseDocument> qualityReleases,
            Map<String, InventoryReceiptDocument> inventoryReceipts,
            Map<String, MaterialIssueDocument> materialIssues,
            List<InventoryLedgerEntry> ledger,
            List<InventoryEvent> outbox,
            long revision,
            int remnantSeq,
            int defectSeq
    ) {
        InventorySnapshot toSnapshot() {
            return new InventorySnapshot(new ArrayList<>(rolls.values()), new ArrayList<>(remnants.values()),
                    receipts, remnantSeq, defectSeq, tasks, plans, revision, executions, ledger, transfers,
                    outbox, counts, templates, schemes, qualityReleases, inventoryReceipts, materialIssues);
        }
    }

    private static final class AccessFrame {
        int depth;
        boolean writing;
        long operationTime;

        AccessFrame(boolean writing, long operationTime) {
            this.depth = 1;
            this.writing = writing;
            this.operationTime = operationTime;
        }
    }

    long currentOperationTime() {
        AccessFrame frame = accessFrame.get();
        return frame != null ? frame.operationTime : store.now();
    }

    InventorySnapshot snapshot() {
        return new InventorySnapshot(new ArrayList<>(motherRolls.values()), new ArrayList<>(remnantPool.values()),
                receipts, remnantSeq.get(), defectSeq.get(), tasks, plans, revision, executions, ledger, transfers,
                outbox, counts, templates, schemes, qualityReleases, inventoryReceipts, materialIssues);
    }

    void restore(InventorySnapshot snapshot) {
        motherRolls.clear(); snapshot.rolls().forEach(r -> motherRolls.put(r.getRollId(), r));
        remnantPool.clear(); snapshot.remnants().forEach(r -> remnantPool.put(r.getId(), r));
        receipts.clear(); receipts.putAll(snapshot.receipts());
        tasks.clear(); if (snapshot.tasks() != null) tasks.putAll(snapshot.tasks());
        plans.clear(); if (snapshot.plans() != null) plans.putAll(snapshot.plans());
        executions.clear(); executions.putAll(snapshot.executions());
        ledger = snapshot.ledger();
        outbox = snapshot.outbox();
        counts.clear(); counts.putAll(snapshot.counts());
        transfers.clear(); transfers.putAll(snapshot.transfers());
        templates.clear(); if (snapshot.templates() != null) templates.putAll(snapshot.templates());
        schemes.clear(); if (snapshot.schemes() != null) schemes.putAll(snapshot.schemes());
        qualityReleases.clear(); if (snapshot.qualityReleases() != null) qualityReleases.putAll(snapshot.qualityReleases());
        inventoryReceipts.clear(); if (snapshot.inventoryReceipts() != null) inventoryReceipts.putAll(snapshot.inventoryReceipts());
        materialIssues.clear(); if (snapshot.materialIssues() != null) materialIssues.putAll(snapshot.materialIssues());
        revision = snapshot.revision();
        remnantSeq.set(snapshot.remnantSeq());
        defectSeq.set(snapshot.defectSeq());
        balanceIndex = null;
        rollSort.reset(snapshot.rolls().stream().map(MotherRollInfo::getRollId).toList());
        remnantSort.reset(snapshot.remnants().stream().map(RemnantStock::getId).toList());
        taskSort.reset(tasks.keySet());
        planSort.reset(plans.keySet());
        receiptSort.reset(receipts.keySet());
        executionSort.reset(executions.keySet());
        schemeSort.reset(schemes.keySet());
    }

    TxBackup captureBackup() {
        Map<String, MotherRollInfo> rollsCopy = new LinkedHashMap<>(motherRolls.size() * 2);
        for (var e : motherRolls.entrySet()) {
            rollsCopy.put(e.getKey(), e.getValue().deepCopy());
        }
        Map<String, RemnantStock> remnantsCopy = new LinkedHashMap<>(remnantPool.size() * 2);
        for (var e : remnantPool.entrySet()) {
            remnantsCopy.put(e.getKey(), e.getValue().deepCopy());
        }
        return new TxBackup(
                rollsCopy, remnantsCopy,
                new LinkedHashMap<>(receipts), new LinkedHashMap<>(tasks), new LinkedHashMap<>(plans),
                new LinkedHashMap<>(executions), new LinkedHashMap<>(transfers), new LinkedHashMap<>(counts),
                new LinkedHashMap<>(templates), new LinkedHashMap<>(schemes),
                new LinkedHashMap<>(qualityReleases), new LinkedHashMap<>(inventoryReceipts), new LinkedHashMap<>(materialIssues),
                ledger, outbox, revision, remnantSeq.get(), defectSeq.get()
        );
    }

    void restoreBackup(TxBackup backup) {
        motherRolls.clear(); motherRolls.putAll(backup.rolls());
        remnantPool.clear(); remnantPool.putAll(backup.remnants());
        receipts.clear(); receipts.putAll(backup.receipts());
        tasks.clear(); tasks.putAll(backup.tasks());
        plans.clear(); plans.putAll(backup.plans());
        executions.clear(); executions.putAll(backup.executions());
        transfers.clear(); transfers.putAll(backup.transfers());
        counts.clear(); counts.putAll(backup.counts());
        templates.clear(); templates.putAll(backup.templates());
        schemes.clear(); schemes.putAll(backup.schemes());
        qualityReleases.clear(); qualityReleases.putAll(backup.qualityReleases());
        inventoryReceipts.clear(); inventoryReceipts.putAll(backup.inventoryReceipts());
        materialIssues.clear(); materialIssues.putAll(backup.materialIssues());
        ledger = backup.ledger();
        outbox = backup.outbox();
        revision = backup.revision();
        remnantSeq.set(backup.remnantSeq());
        defectSeq.set(backup.defectSeq());
    }

    private static <T> List<InventoryDelta.IndexedItem<T>> diffUpserts(
            Map<String, T> before, Map<String, T> after, BiPredicate<T, T> unchanged,
            TableSortIndex sortIndex, Map<String, Long> stagedNewOrders, long[] stagedNext, Set<String> dirtyIdCollector
    ) {
        List<InventoryDelta.IndexedItem<T>> upserts = new ArrayList<>();
        for (var e : after.entrySet()) {
            String id = e.getKey();
            T current = e.getValue();
            T prev = before.get(id);
            if (prev == null || !unchanged.test(prev, current)) {
                long order = sortIndex.peekOrder(id, stagedNewOrders, stagedNext);
                upserts.add(new InventoryDelta.IndexedItem<>(id, order, current));
                if (dirtyIdCollector != null) dirtyIdCollector.add(id);
            }
        }
        return upserts;
    }

    private static <T> List<String> diffDeletes(Map<String, T> before, Map<String, T> after, Set<String> dirtyIdCollector) {
        List<String> deleted = new ArrayList<>();
        for (String id : before.keySet()) {
            if (!after.containsKey(id)) {
                deleted.add(id);
                if (dirtyIdCollector != null) dirtyIdCollector.add(id);
            }
        }
        return deleted;
    }

    private static <T> List<T> diffAppends(Map<String, T> before, Map<String, T> after, Set<String> dirtyIdCollector) {
        List<T> appended = new ArrayList<>();
        for (var e : after.entrySet()) {
            if (!before.containsKey(e.getKey())) {
                appended.add(e.getValue());
                if (dirtyIdCollector != null) dirtyIdCollector.add(e.getKey());
            }
        }
        return appended;
    }

    <T> T mutate(Supplier<T> command) {
        return mutate("SYSTEM_UPDATE", null, "UNAUTHENTICATED_LOCAL", command);
    }

    <T> T mutate(String eventType, String businessId, String actor, Supplier<T> command) {
        return mutate(eventType, businessId, actor, () -> null, command);
    }

    <T> T mutate(String eventType, String businessId, String actor, Supplier<T> replay, Supplier<T> command) {
        AccessFrame existing = accessFrame.get();
        if (existing != null && !existing.writing) {
            throw new IllegalStateException("只读事务上下文禁止升级为写事务");
        }
        rwLock.writeLock().lock();
        boolean root = existing == null;
        if (root) {
            try {
                refreshUnderWriteLock();
                long now = store.now();
                accessFrame.set(new AccessFrame(true, now));
            } catch (RuntimeException error) {
                rwLock.writeLock().unlock();
                throw error;
            }
        } else {
            existing.depth++;
        }
        try {
            T previous = replay.get();
            if (previous != null) return previous;
            long opTime = currentOperationTime();
            TxBackup backup = captureBackup();
            int beforeLedgerSize = backup.ledger().size();
            int beforeOutboxSize = backup.outbox().size();
            try {
                T result = command.get();

                var dirtyRolls = new LinkedHashSet<String>();
                var dirtyRemnants = new LinkedHashSet<String>();
                var dirtyReceipts = new LinkedHashSet<String>();
                var dirtyTasks = new LinkedHashSet<String>();
                var dirtyTransfers = new LinkedHashSet<String>();
                var dirtyCounts = new LinkedHashSet<String>();
                var dirtyReleases = new LinkedHashSet<String>();
                var dirtyInvReceipts = new LinkedHashSet<String>();
                var dirtyIssues = new LinkedHashSet<String>();

                Map<String, Long> newRollOrders = new LinkedHashMap<>(); long[] nextRollOrder = {rollSort.nextOrder};
                Map<String, Long> newRemOrders = new LinkedHashMap<>(); long[] nextRemOrder = {remnantSort.nextOrder};
                Map<String, Long> newTaskOrders = new LinkedHashMap<>(); long[] nextTaskOrder = {taskSort.nextOrder};
                Map<String, Long> newPlanOrders = new LinkedHashMap<>(); long[] nextPlanOrder = {planSort.nextOrder};
                Map<String, Long> newRecOrders = new LinkedHashMap<>(); long[] nextRecOrder = {receiptSort.nextOrder};
                Map<String, Long> newExecOrders = new LinkedHashMap<>(); long[] nextExecOrder = {executionSort.nextOrder};
                Map<String, Long> newSchemeOrders = new LinkedHashMap<>(); long[] nextSchemeOrder = {schemeSort.nextOrder};

                var upsertedRolls = diffUpserts(backup.rolls(), motherRolls, MotherRollInfo::equalsContent, rollSort, newRollOrders, nextRollOrder, dirtyRolls);
                var deletedRolls = diffDeletes(backup.rolls(), motherRolls, dirtyRolls);
                var upsertedRemnants = diffUpserts(backup.remnants(), remnantPool, RemnantStock::equalsContent, remnantSort, newRemOrders, nextRemOrder, dirtyRemnants);
                var deletedRemnants = diffDeletes(backup.remnants(), remnantPool, dirtyRemnants);
                var upsertedTasks = diffUpserts(backup.tasks(), tasks, (a, b) -> a == b, taskSort, newTaskOrders, nextTaskOrder, dirtyTasks);
                var deletedTasks = diffDeletes(backup.tasks(), tasks, dirtyTasks);
                var upsertedPlans = diffUpserts(backup.plans(), plans, (a, b) -> a == b, planSort, newPlanOrders, nextPlanOrder, null);
                var deletedPlans = diffDeletes(backup.plans(), plans, null);
                var upsertedReceipts = diffUpserts(backup.receipts(), receipts, (a, b) -> a == b, receiptSort, newRecOrders, nextRecOrder, dirtyReceipts);
                var deletedReceipts = diffDeletes(backup.receipts(), receipts, dirtyReceipts);
                var upsertedExecutions = diffUpserts(backup.executions(), executions, (a, b) -> a == b, executionSort, newExecOrders, nextExecOrder, null);
                var deletedExecutions = diffDeletes(backup.executions(), executions, null);
                var upsertedSchemes = diffUpserts(backup.schemes(), schemes, (a, b) -> a == b, schemeSort, newSchemeOrders, nextSchemeOrder, null);
                var deletedSchemes = diffDeletes(backup.schemes(), schemes, null);

                var appendedTransfers = diffAppends(backup.transfers(), transfers, dirtyTransfers);
                var appendedCounts = diffAppends(backup.counts(), counts, dirtyCounts);
                var appendedReleases = diffAppends(backup.qualityReleases(), qualityReleases, dirtyReleases);
                var appendedInvReceipts = diffAppends(backup.inventoryReceipts(), inventoryReceipts, dirtyInvReceipts);
                var appendedIssues = diffAppends(backup.materialIssues(), materialIssues, dirtyIssues);

                var affectedReceiptTaskIds = new LinkedHashSet<String>();
                for (String rid : dirtyReceipts) {
                    affectedReceiptTaskIds.addAll(InventoryJournal.receiptTaskIds(backup.receipts().get(rid)));
                    affectedReceiptTaskIds.addAll(InventoryJournal.receiptTaskIds(receipts.get(rid)));
                }

                var dirtyLedgerKeys = new InventoryJournal.DirtyLedgerKeys(
                        dirtyRolls, dirtyRemnants, dirtyReceipts, dirtyTasks,
                        dirtyTransfers, dirtyCounts, dirtyReleases, dirtyInvReceipts, dirtyIssues,
                        affectedReceiptTaskIds
                );
                InventoryJournal.AppendOutcome journalOutcome = InventoryJournal.appendIncremental(
                        balanceIndex, backup.revision(), backup.ledger(), backup::toSnapshot,
                        motherRolls, remnantPool, receipts, tasks,
                        transfers, counts, qualityReleases, inventoryReceipts, materialIssues,
                        dirtyLedgerKeys, eventType, businessId, actor, opTime
                );
                ledger = journalOutcome.ledger();
                outbox = InventoryEvent.append(backup.outbox(), beforeLedgerSize,
                        ledger, eventType, businessId, opTime, backup.revision() + 1);

                List<InventoryLedgerEntry> appendedLedger = ledger.size() > beforeLedgerSize
                        ? List.copyOf(ledger.subList(beforeLedgerSize, ledger.size())) : List.of();
                List<InventoryEvent> appendedOutbox = outbox.size() > beforeOutboxSize
                        ? List.copyOf(outbox.subList(beforeOutboxSize, outbox.size())) : List.of();

                InventoryDelta delta = new InventoryDelta(
                        backup.revision(), remnantSeq.get(), defectSeq.get(),
                        upsertedRolls, deletedRolls,
                        upsertedRemnants, deletedRemnants,
                        upsertedTasks, deletedTasks,
                        upsertedPlans, deletedPlans,
                        upsertedReceipts, deletedReceipts,
                        upsertedExecutions, deletedExecutions,
                        upsertedSchemes, deletedSchemes,
                        appendedTransfers, appendedCounts, appendedReleases, appendedInvReceipts, appendedIssues,
                        beforeLedgerSize, appendedLedger,
                        beforeOutboxSize, appendedOutbox
                );
                revision = store.saveDelta(delta, this::snapshot);

                journalOutcome.commitIndex();
                balanceIndex = journalOutcome.baseIndex();
                rollSort.commit(newRollOrders, deletedRolls, nextRollOrder[0]);
                remnantSort.commit(newRemOrders, deletedRemnants, nextRemOrder[0]);
                taskSort.commit(newTaskOrders, deletedTasks, nextTaskOrder[0]);
                planSort.commit(newPlanOrders, deletedPlans, nextPlanOrder[0]);
                receiptSort.commit(newRecOrders, deletedReceipts, nextRecOrder[0]);
                executionSort.commit(newExecOrders, deletedExecutions, nextExecOrder[0]);
                schemeSort.commit(newSchemeOrders, deletedSchemes, nextSchemeOrder[0]);
                return result;
            } catch (RuntimeException error) {
                restoreBackup(backup);
                throw error;
            }
        } finally {
            if (root) {
                accessFrame.remove();
            } else {
                existing.depth--;
            }
            rwLock.writeLock().unlock();
        }
    }

    /** 在写锁下执行只读推演（如批量报工试算），确保临时内存模拟对并发读线程完全不可见。 */
    <T> T withWriteLock(Supplier<T> action) {
        AccessFrame existing = accessFrame.get();
        if (existing != null && !existing.writing) {
            throw new IllegalStateException("只读事务上下文禁止升级为写锁推演");
        }
        rwLock.writeLock().lock();
        boolean root = existing == null;
        if (root) {
            try {
                refreshUnderWriteLock();
                accessFrame.set(new AccessFrame(true, store.now()));
            } catch (RuntimeException error) {
                rwLock.writeLock().unlock();
                throw error;
            }
        } else {
            existing.depth++;
        }
        try {
            return action.get();
        } finally {
            if (root) {
                accessFrame.remove();
            } else {
                existing.depth--;
            }
            rwLock.writeLock().unlock();
        }
    }

    private boolean needsRefresh() {
        if (!store.shared()) return false;
        Long remoteRevision = store.currentRevision();
        return remoteRevision == null || remoteRevision != revision;
    }

    private void refreshUnderWriteLock() {
        if (store.shared()) {
            Long remoteRevision = store.currentRevision();
            if (remoteRevision != null && remoteRevision == revision) {
                return;
            }
            InventorySnapshot latest = store.load();
            if (latest != null && latest.revision() != revision) restore(latest);
        }
    }

    <T> T read(Supplier<T> query) {
        AccessFrame existing = accessFrame.get();
        if (existing != null) {
            return query.get();
        }
        rwLock.readLock().lock();
        boolean readLocked = true;
        try {
            if (needsRefresh()) {
                rwLock.readLock().unlock();
                readLocked = false;
                rwLock.writeLock().lock();
                try {
                    refreshUnderWriteLock();
                    rwLock.readLock().lock();
                    readLocked = true;
                } finally {
                    rwLock.writeLock().unlock();
                }
            }
            accessFrame.set(new AccessFrame(false, store.now()));
            try {
                return query.get();
            } finally {
                accessFrame.remove();
            }
        } finally {
            if (readLocked) {
                rwLock.readLock().unlock();
            }
        }
    }

    // ==================== 独立模板存储与健康/账本查询 ====================

    List<DemandTemplate> listTemplatesIndependent() {
        if (store.supportsIndependentTemplates()) {
            return List.copyOf(store.loadTemplates());
        }
        return read(() -> List.copyOf(templates.values()));
    }

    DemandTemplate saveTemplateIndependent(DemandTemplate template) {
        if (template == null || template.id() == null || template.id().isBlank()) {
            throw new IllegalArgumentException("需求模板及其编号不能为空");
        }
        if (store.supportsIndependentTemplates()) {
            store.upsertTemplate(template);
            return template;
        }
        return mutate("SYSTEM_UPDATE", template.id(), "UNAUTHENTICATED_LOCAL", () -> {
            templates.put(template.id(), template);
            return template;
        });
    }

    boolean deleteTemplateIndependent(String id) {
        if (id == null || id.isBlank()) return false;
        String trimmed = id.trim();
        if (store.supportsIndependentTemplates()) {
            return store.deleteTemplate(trimmed);
        }
        return mutate("SYSTEM_UPDATE", trimmed, "UNAUTHENTICATED_LOCAL", () -> templates.remove(trimmed) != null);
    }

    List<InventoryEvent> integrationEvents() {
        return read(() -> outbox);
    }

    Map<String, Object> healthStatus() {
        String storageError;
        try {
            storageError = store.healthCheckError();
        } catch (Exception e) {
            storageError = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
        }
        long availableRemnants = remnantPool.values().stream()
                .filter(r -> "AVAILABLE".equalsIgnoreCase(r.getStatus()))
                .count();
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("storageHealthy", storageError == null);
        if (storageError != null) {
            status.put("storageError", storageError);
        }
        status.put("revision", revision);
        status.put("remnantsInStock", (int) availableRemnants);
        return status;
    }

    Map<String, Object> inventoryLedger(String aggregateType, String aggregateId, long after, int limit) {
        if (after < 0 || limit < 1 || limit > 500) throw new IllegalArgumentException("流水游标不得为负，分页大小为 1–500");
        return read(() -> {
            var page = ledger.stream().filter(e -> e.sequence() > after
                    && (aggregateType == null || aggregateType.equals(e.aggregateType()))
                    && (aggregateId == null || aggregateId.equals(e.aggregateId()))).limit(limit + 1L).toList();
            var items = page.stream().limit(limit).toList();
            return Map.of("items", items, "hasMore", page.size() > limit,
                    "nextCursor", items.isEmpty() ? after : items.get(items.size() - 1).sequence(), "revision", revision);
        });
    }

    Map<String, Object> reconcileInventory() {
        return read(() -> InventoryJournal.reconcile(snapshot()));
    }

    // ==================== 跨垂直领域共享只读与不变量原语 ====================

    long countRevision(String type, String id) {
        return counts.values().stream().filter(c -> c.lines().stream().anyMatch(l -> type.equals(l.type()) && id.equals(l.id())))
                .mapToLong(InventoryCount::inventoryRevision).max().orElse(0);
    }

    Map<String, Integer> reservedQuantities(String taskId, String exceptPlan) {
        var result = new LinkedHashMap<String, Integer>();
        long now = currentOperationTime();
        var coveredPlans = new HashSet<String>();
        for (var s : schemes.values()) {
            if (!s.occupiesDemand()) continue;
            if (exceptPlan != null && s.linkedPlanIds().contains(exceptPlan)) {
                coveredPlans.addAll(s.linkedPlanIds());
                continue;
            }
            if (!s.involvesTask(taskId)) continue;
            coveredPlans.addAll(s.linkedPlanIds());
            var reportedInScheme = new HashMap<String, Integer>();
            for (var pid : s.linkedPlanIds()) {
                var rec = receipts.get(pid);
                if (rec != null && !"REVERSED".equals(rec.get("status"))) {
                    accumulateReceiptDemandForTask(rec, taskId, reportedInScheme);
                }
            }
            for (var alloc : s.effectiveAllocations()) {
                if (!Objects.equals(taskId, alloc.taskId())) continue;
                String lineKey = String.valueOf(alloc.lineId());
                int net = Math.max(0, alloc.quantity() - reportedInScheme.getOrDefault(lineKey, 0));
                if (net > 0) result.merge(lineKey, net, Integer::sum);
            }
        }
        executions.values().stream()
                .filter(e -> Objects.equals(e.taskId(), taskId) && !Objects.equals(e.planId(), exceptPlan)
                        && !coveredPlans.contains(e.planId()) && e.reserves(now))
                .forEach(e -> e.demandQuantities().forEach((id, n) -> result.merge(id, n, Integer::sum)));
        return result;
    }

    boolean isMaterialReservedByExecution(String type, String id, String exceptPlan) {
        return executions.values().stream().anyMatch(e -> e.materialType().equalsIgnoreCase(type) && Objects.equals(e.materialId(), id)
                && !Objects.equals(e.planId(), exceptPlan) && e.reserves(currentOperationTime()));
    }

    boolean isMaterialReservedByScheme(String type, String id, String exceptPlan) {
        return schemes.values().stream().anyMatch(s -> s.occupiesMaterial(type, id)
                && (exceptPlan == null || !s.linkedPlanIds().contains(exceptPlan)));
    }

    boolean isPlanLinkedToActiveScheme(String planId) {
        if (planId == null) return false;
        return schemes.values().stream().anyMatch(s -> s.isMaterialLockActive() && s.linkedPlanIds().contains(planId));
    }

    boolean isRollIntervalReservedByOtherScheme(String rollId, double startY, double length, String exceptPlan) {
        double endY = startY + length;
        for (var s : schemes.values()) {
            if (!s.occupiesRoll(rollId)) continue;
            if (exceptPlan != null && s.linkedPlanIds().contains(exceptPlan)) continue;
            double otherStart = s.windowStartY();
            double otherEnd = otherStart + s.occupiedLengthMm();
            if (Math.min(endY, otherEnd) - Math.max(startY, otherStart) > 0.001) return true;
        }
        return false;
    }

    void ensureMaterialNotReserved(String type, String id, String exceptPlan) {
        if (isMaterialReservedByExecution(type, id, exceptPlan))
            throw new InventoryConflictException("材料已被其他执行单预约或正在加工，请先处理原执行单");
        if (isMaterialReservedByScheme(type, id, exceptPlan))
            throw new InventoryConflictException("材料已被活跃排程方案预约或下发，请先完工或作废原排程方案");
    }

    void ensurePlanNotExecuting(String planId) {
        if (executions.values().stream().anyMatch(e -> e.planId().equals(planId) && e.reserves(currentOperationTime())))
            throw new InventoryConflictException("方案已有有效执行单，请先取消未开工执行单；已开工须实际报工");
        if (isPlanLinkedToActiveScheme(planId))
            throw new InventoryConflictException("切割计划已被活跃排程方案锁定，请通过排程结果管理作废或完工");
    }

    String materialFingerprintInternal(SolveRequest request) {
        if ("remnant".equalsIgnoreCase(request.getFeedPortType())) {
            RemnantStock item = remnantPool.get(request.getSourceRemnantId());
            if (item == null) throw new IllegalArgumentException("料头不存在，请重新选料");
            return countedFingerprint("remnant", item.getId(), Arrays.asList(item.getId(), item.getWidth(), item.getLength(),
                    item.getMaterialBatch(), item.getSourceRollId(), item.isHasDefect(), item.getDefects()));
        }
        MotherRollInfo roll = motherRolls.get(request.getRollId());
        if (roll == null) throw new IllegalArgumentException("母卷不存在，请重新选料");
        return countedFingerprint("roll", roll.getRollId(), Arrays.asList(roll.getRollId(), roll.getWidth(), roll.getTotalLength(),
                roll.getRollModel(), roll.getBatchNo(), roll.getColor(), roll.getInspectionStatus(), roll.getDefects()));
    }

    private String countedFingerprint(String type, String id, List<?> original) {
        var values = new ArrayList<Object>(original);
        long counted = countRevision(type, id);
        if (counted > 0) values.add(Map.of("inventoryCountRevision", counted));
        return json.writeValueAsString(values);
    }

    List<QualityDisposition> qualityEvents(Map<String, Object> receipt) {
        if (!(receipt.get("qualityDispositions") instanceof List<?> events)) return List.of();
        return events.stream().map(event -> json.convertValue(event, QualityDisposition.class)).toList();
    }

    int qualityRevisionOf(List<QualityDisposition> events) {
        int revoked = (int) events.stream().filter(QualityDisposition::hasRevocation).count();
        return events.size() + revoked;
    }

    /** Read projection: original production facts are never overwritten by reinspection. Areas are m². */
    Map<String, Object> qualityProjection(Map<String, Object> receipt) {
        if (receipt == null) return null;
        var result = new LinkedHashMap<>(receipt);
        if (receipt.get("inventoryCountRevision") instanceof Number counted)
            result.put("inventoryCountRevision", counted.longValue());
        var events = qualityEvents(receipt);
        var activeEvents = events.stream().filter(e -> !e.hasRevocation()).toList();
        var removed = activeEvents.stream().filter(e -> "QUALIFIED".equals(e.originalOutcome())).toList();
        double removedArea = removed.stream().mapToDouble(QualityDisposition::pieceAreaMm2).sum() / 1_000_000;
        double recovered = activeEvents.stream().mapToDouble(QualityDisposition::recoveredAreaMm2).sum() / 1_000_000;
        double goodArea = ((Number) receipt.get("pieceArea")).doubleValue() - removedArea;
        double usedArea = ((Number) receipt.get("usedArea")).doubleValue();
        result.put("qualityDispositions", events);
        result.put("qualityRevision", qualityRevisionOf(events));
        result.put("netFinishedPieceCount", ((Number) receipt.get("finishedPieceCount")).intValue() - removed.size());
        result.put("netPieceArea", Math.max(0, goodArea));
        result.put("netRemArea", ((Number) receipt.get("remArea")).doubleValue() + recovered);
        result.put("netWasteArea", Math.max(0, ((Number) receipt.get("wasteArea")).doubleValue() + removedArea - recovered));
        result.put("netUtilization", usedArea > 0 ? Math.max(0, goodArea) / usedArea * 100 : 0);
        return result;
    }

    List<Map<String, Object>> taskReportsInternal(String taskId) {
        return receipts.values().stream()
                .filter(r -> Objects.equals(taskId, r.get("taskId"))
                        || (r.get("taskDemandQuantities") instanceof Map<?, ?> multi && multi.containsKey(taskId)))
                .map(this::qualityProjection).toList();
    }

    void accumulateReceiptDemandForTask(Map<String, Object> receipt, String taskId, Map<String, Integer> targetCounts) {
        if (receipt.get("taskDemandQuantities") instanceof Map<?, ?> multi) {
            if (multi.get(taskId) instanceof Map<?, ?> taskOutput) {
                taskOutput.forEach((id, n) -> targetCounts.merge(id.toString(), ((Number) n).intValue(), Integer::sum));
            }
            return;
        }
        if (Objects.equals(taskId, receipt.get("taskId")) && receipt.get("demandQuantities") instanceof Map<?, ?> output) {
            output.forEach((id, n) -> targetCounts.merge(id.toString(), ((Number) n).intValue(), Integer::sum));
        }
    }

    Map<String, Integer> completedQuantitiesInternal(String taskId) {
        Map<String, Integer> result = new LinkedHashMap<>();
        for (Map<String, Object> receipt : taskReportsInternal(taskId)) {
            if ("REVERSED".equals(receipt.get("status"))) continue;
            boolean multiTask = receipt.get("taskDemandQuantities") instanceof Map<?, ?>;
            accumulateReceiptDemandForTask(receipt, taskId, result);
            Map<?, ?> pieceSources = receipt.get("pieceSources") instanceof Map<?, ?> ps ? ps : null;
            for (var event : qualityEvents(receipt)) {
                if (event.hasRevocation() || !"QUALIFIED".equals(event.originalOutcome())) continue;
                if (multiTask && pieceSources != null) {
                    Object srcObj = pieceSources.get(String.valueOf(event.command().pieceId()));
                    if (srcObj == null) srcObj = pieceSources.get(event.command().pieceId());
                    if (srcObj instanceof Map<?, ?> srcMap
                            && Objects.equals(taskId, srcMap.get("taskId"))
                            && srcMap.get("lineId") instanceof Number ln) {
                        result.merge(String.valueOf(ln.intValue()), -1, Integer::sum);
                    }
                } else if (!multiTask && Objects.equals(taskId, receipt.get("taskId"))) {
                    result.merge(String.valueOf(event.demandId()), -1, Integer::sum);
                }
            }
        }
        return result;
    }

    void prepareTaskSolveInternal(SolveRequest request) {
        if (request == null) throw new IllegalArgumentException("排料请求不能为空");
        if (request.getTaskId() == null) return;
        CuttingTask task = tasks.get(request.getTaskId());
        if (task == null || task.revision() != request.getTaskRevision()) throw new IllegalArgumentException("任务已更新，请重新载入需求");
        boolean remnant = "remnant".equals(request.getFeedPortType());
        if (!remnant && !"roll".equals(request.getFeedPortType())) throw new IllegalArgumentException("无效的材料来源");
        MotherRollInfo roll = motherRolls.get(request.getRollId());
        RemnantStock stock = remnant ? remnantPool.get(request.getSourceRemnantId()) : null;
        if (remnant ? stock == null || !"AVAILABLE".equals(stock.getStatus()) : roll == null || "SCRAPPED".equalsIgnoreCase(roll.getInspectionStatus()))
            throw new IllegalArgumentException("所选材料已不可用或已报废，请重新选料");
        String model = remnant ? stock.getMaterialBatch() : roll.getRollModel();
        if (!task.materialModel().equals(model)) throw new IllegalArgumentException("材料型号与任务需求不一致");
        validateBatchAndColorInternal(task, roll, stock);
        double width = remnant ? stock.getWidth() : roll.getWidth();
        if (!Double.isFinite(request.getRollW()) || Math.abs(request.getRollW() - width) > .001 ||
                !Double.isFinite(request.getRollL()) || request.getRollL() <= 0 ||
                (remnant ? Math.abs(request.getRollL() - stock.getLength()) > .001 : request.getRollL() > roll.getCurrentRemainingLength()))
            throw new IllegalArgumentException("加工尺寸与所选材料库存不一致");
        double start = request.getWindowStartY();
        if (!Double.isFinite(start) || (remnant ? start != 0 : start < roll.getUsedLength() || start + request.getRollL() > roll.getTotalLength()))
            throw new IllegalArgumentException("工位超出母料可用范围，请重新装载");
        if (remnant && !Objects.equals(stock.getSourceRollId(), request.getRollId())) throw new IllegalArgumentException("料头来源母卷不一致");
        request.setRollModel(model);
        if (request.getDemands() == null || request.getDemands().isEmpty()) throw new IllegalArgumentException("没有待切需求");
        Map<String, Integer> completed = completedQuantitiesInternal(task.id());
        Set<Integer> seen = new HashSet<>();
        for (var demand : request.getDemands()) {
            if (demand == null || !seen.add(demand.getId())) throw new IllegalArgumentException("排料需求编号重复或为空");
            CuttingTask.Line line = task.demands().stream().filter(d -> d.id() == demand.getId()).findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("需求不属于当前任务"));
            if (!Objects.equals(demand.getShape(), line.shape()) || demand.getWidth() != line.width() || demand.getLength() != line.length() ||
                    demand.getDemand() <= 0 || demand.getDemand() > line.quantity() - completed.getOrDefault(String.valueOf(line.id()), 0))
                throw new IllegalArgumentException("需求尺寸或剩余数量已变化，请刷新任务后重新排料");
            demand.setName(line.name());
            demand.setAllowRotation(line.allowRotation());
            if (line.allowHalfTurn() != null) demand.setAllowHalfTurn(line.allowHalfTurn());
        }
    }

    List<RemnantStock> getAvailableRemnantsInternal() {
        return remnantPool.values().stream()
                .filter(r -> "AVAILABLE".equalsIgnoreCase(r.getStatus()))
                .sorted(Comparator.comparing(RemnantStock::getId))
                .collect(Collectors.toList());
    }

    List<RemnantStock> getRemnantsByRollIdInternal(String rollId) {
        if (rollId == null || rollId.trim().isEmpty() || "ALL".equalsIgnoreCase(rollId)) {
            return getAvailableRemnantsInternal();
        }
        String cleanRollId = rollId.trim();
        return remnantPool.values().stream()
                .filter(r -> "AVAILABLE".equalsIgnoreCase(r.getStatus()))
                .filter(r -> cleanRollId.equalsIgnoreCase(r.getSourceRollId()))
                .sorted(Comparator.comparing(RemnantStock::getId))
                .collect(Collectors.toList());
    }

    MotherRollInfo getMotherRollInternal(String rollId) {
        if (rollId == null) return null;
        MotherRollInfo info = motherRolls.get(rollId);
        if (info == null) return null;
        List<RemnantStock> rollRemnants = getRemnantsByRollIdInternal(rollId);
        double totalArea = rollRemnants.stream().mapToDouble(RemnantStock::getArea).sum();
        return info.copyWithRemnantStats(rollRemnants.size(), totalArea);
    }

    void inheritLineageMetadata(RemnantStock target, MotherRollInfo roll, RemnantStock parent) {
        if (target == null) return;
        if (blankToNull(target.getBatchNo()) == null) {
            String inheritedBatch = (parent != null && blankToNull(parent.getBatchNo()) != null)
                    ? parent.getBatchNo().trim()
                    : (roll != null ? blankToNull(roll.getBatchNo()) : null);
            target.setBatchNo(inheritedBatch);
        }
        if (blankToNull(target.getColor()) == null) {
            String inheritedColor = (parent != null && blankToNull(parent.getColor()) != null)
                    ? parent.getColor().trim()
                    : (roll != null ? blankToNull(roll.getColor()) : null);
            target.setColor(inheritedColor);
        }
    }

    boolean matchesBatchAndColor(CuttingTask task, MotherRollInfo roll, RemnantStock remnant) {
        try {
            validateBatchAndColorInternal(task, roll, remnant);
            return true;
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    void validateBatchAndColorInternal(CuttingTask task, MotherRollInfo roll, RemnantStock remnant) {
        if (task == null) return;
        String reqBatch = blankToNull(task.requiredBatchNo());
        String reqColor = blankToNull(task.requiredColor());
        boolean strict = Boolean.TRUE.equals(task.strictBatchMatch());
        if (reqBatch == null && reqColor == null && !strict) return;

        MotherRollInfo effectiveRoll = roll;
        if (effectiveRoll == null && remnant != null && remnant.getSourceRollId() != null) {
            effectiveRoll = motherRolls.get(remnant.getSourceRollId());
        }
        String actualBatch = (remnant != null && blankToNull(remnant.getBatchNo()) != null)
                ? remnant.getBatchNo().trim()
                : (effectiveRoll != null ? blankToNull(effectiveRoll.getBatchNo()) : null);
        String actualColor = (remnant != null && blankToNull(remnant.getColor()) != null)
                ? remnant.getColor().trim()
                : (effectiveRoll != null ? blankToNull(effectiveRoll.getColor()) : null);
        String label = remnant != null ? ("料头 " + remnant.getId())
                : (effectiveRoll != null ? ("母卷 " + effectiveRoll.getRollId()) : "所选材料");

        if (reqBatch != null) {
            if (actualBatch == null || !reqBatch.equalsIgnoreCase(actualBatch)) {
                throw new IllegalArgumentException("缸号不匹配（防色差拦截）：任务「" + task.name() + "」要求缸号「"
                        + reqBatch + "」，但" + label + "缸号为「" + Objects.toString(actualBatch, "未登记") + "」");
            }
        }
        if (reqColor != null) {
            if (actualColor == null || !reqColor.equalsIgnoreCase(actualColor)) {
                throw new IllegalArgumentException("色号不匹配（防色差拦截）：任务「" + task.name() + "」要求色号「"
                        + reqColor + "」，但" + label + "色号为「" + Objects.toString(actualColor, "未登记") + "」");
            }
        }
        if (strict) {
            if (actualBatch == null) {
                throw new IllegalArgumentException("同单同缸强约束拦截：任务「" + task.name() + "」要求严格同缸，但" + label + "未登记缸号");
            }
            String establishedBatch = findEstablishedTaskBatchNo(task.id());
            if (establishedBatch != null && !establishedBatch.equalsIgnoreCase(actualBatch)) {
                throw new IllegalArgumentException("同单同缸强约束拦截（防色差）：任务「" + task.name() + "」已锁定缸号「"
                        + establishedBatch + "」，不能混用缸号「" + actualBatch + "」");
            }
        }
    }

    private String findEstablishedTaskBatchNo(String taskId) {
        if (taskId == null) return null;
        for (Map<String, Object> rec : receipts.values()) {
            if ("REVERSED".equals(rec.get("status"))) continue;
            boolean belongs = taskId.equals(rec.get("taskId"))
                    || (rec.get("taskDemandQuantities") instanceof Map<?, ?> multi && multi.containsKey(taskId));
            if (!belongs) continue;
            String batch = resolveMaterialBatchNo(
                    rec.get("rollId") != null ? rec.get("rollId").toString() : null,
                    rec.get("sourceRemnantId") != null ? rec.get("sourceRemnantId").toString() : null
            );
            if (batch != null) return batch;
        }
        for (SchedulingScheme sc : schemes.values()) {
            if (!sc.isMaterialLockActive() || !sc.involvesTask(taskId)) continue;
            String batch = resolveMaterialBatchNo(sc.rollId(), sc.remnantId());
            if (batch != null) return batch;
        }
        return null;
    }

    private String resolveMaterialBatchNo(String rollId, String remnantId) {
        if (remnantId != null && remnantPool.containsKey(remnantId)) {
            RemnantStock rem = remnantPool.get(remnantId);
            if (blankToNull(rem.getBatchNo()) != null) return rem.getBatchNo().trim();
            if (rem.getSourceRollId() != null && motherRolls.containsKey(rem.getSourceRollId())) {
                String rb = blankToNull(motherRolls.get(rem.getSourceRollId()).getBatchNo());
                if (rb != null) return rb;
            }
        }
        if (rollId != null && motherRolls.containsKey(rollId)) {
            return blankToNull(motherRolls.get(rollId).getBatchNo());
        }
        return null;
    }

    void verifyReportReplay(Map<String, Object> receipt, CutReport report) {
        Object hash = receipt.get("reportContent");
        if (hash != null && !hash.equals(json.writeValueAsString(report)))
            throw new InventoryConflictException("该方案已报工，重复提交的内容不同");
    }

    static String normalizePriority(String priority) {
        String clean = blankToNull(priority);
        if (clean == null) return null;
        String upper = clean.toUpperCase(Locale.ROOT);
        if (!Set.of(CuttingTask.PRIORITY_NORMAL, CuttingTask.PRIORITY_HIGH, CuttingTask.PRIORITY_URGENT).contains(upper)) {
            throw new IllegalArgumentException("任务优先级仅支持 NORMAL、HIGH 或 URGENT");
        }
        return upper;
    }

    static String requireIdempotencyKey(String key) {
        String clean = blankToNull(key);
        if (clean == null || clean.length() > 128) {
            throw new IllegalArgumentException("请提供 1–128 字符的有效幂等键 idempotencyKey");
        }
        return clean;
    }

    static String requireText(String value, int maxLen, String message) {
        String clean = blankToNull(value);
        if (clean == null || clean.length() > maxLen) {
            throw new IllegalArgumentException(message);
        }
        return clean;
    }

    static String blankToNull(String value) {
        return (value == null || value.isBlank()) ? null : value.trim();
    }
}
