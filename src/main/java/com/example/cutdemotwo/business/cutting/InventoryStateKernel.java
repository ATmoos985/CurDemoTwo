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
import com.example.cutdemotwo.persistence.HotColdModels;
import com.example.cutdemotwo.persistence.InventoryConflictException;
import com.example.cutdemotwo.persistence.InventoryDelta;
import com.example.cutdemotwo.persistence.InventorySnapshot;
import com.example.cutdemotwo.persistence.InventoryStore;
import tools.jackson.databind.ObjectMapper;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import java.util.function.BiPredicate;
import java.util.function.Supplier;

/**
 * 库存与裁切聚合状态内核：
 * 统一封装热态聚合容器、ReentrantReadWriteLock 读写锁与锁降级刷新、零 JSON 写前备份、
 * 热冷数据按需回源与提交后裁剪、InventoryDelta 定点增量落库、防篡改增量记账与流式对账。
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
    final Map<String, Long> activeCountRevisions = new HashMap<>();
    volatile long revision;
    volatile long ledgerSize;
    volatile long outboxSize;
    volatile String outboxStreamHeadId;
    volatile double measurementToleranceMm = 5;

    private final ReentrantReadWriteLock rwLock = new ReentrantReadWriteLock();
    private final ThreadLocal<StateKernelHotColdSupport.AccessFrame> accessFrame = new ThreadLocal<>();
    private StateKernelHotColdSupport.TxBackup activeWriteBackup;
    private InventoryJournal.BalanceIndex balanceIndex;
    private final StateKernelHotColdSupport.TableSortIndex rollSort = new StateKernelHotColdSupport.TableSortIndex();
    private final StateKernelHotColdSupport.TableSortIndex remnantSort = new StateKernelHotColdSupport.TableSortIndex();
    private final StateKernelHotColdSupport.TableSortIndex taskSort = new StateKernelHotColdSupport.TableSortIndex();
    private final StateKernelHotColdSupport.TableSortIndex planSort = new StateKernelHotColdSupport.TableSortIndex();
    private final StateKernelHotColdSupport.TableSortIndex receiptSort = new StateKernelHotColdSupport.TableSortIndex();
    private final StateKernelHotColdSupport.TableSortIndex executionSort = new StateKernelHotColdSupport.TableSortIndex();
    private final StateKernelHotColdSupport.TableSortIndex schemeSort = new StateKernelHotColdSupport.TableSortIndex();

    InventoryStateKernel(InventoryStore store) {
        this.store = store;
    }

    long currentOperationTime() {
        StateKernelHotColdSupport.AccessFrame frame = accessFrame.get();
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
        ledgerSize = ledger.size();
        outboxSize = outbox.size();
        outboxStreamHeadId = outbox.isEmpty() ? null : outbox.get(0).id();
        counts.clear(); counts.putAll(snapshot.counts());
        transfers.clear(); transfers.putAll(snapshot.transfers());
        templates.clear(); if (snapshot.templates() != null) templates.putAll(snapshot.templates());
        schemes.clear(); if (snapshot.schemes() != null) schemes.putAll(snapshot.schemes());
        qualityReleases.clear(); if (snapshot.qualityReleases() != null) qualityReleases.putAll(snapshot.qualityReleases());
        inventoryReceipts.clear(); if (snapshot.inventoryReceipts() != null) inventoryReceipts.putAll(snapshot.inventoryReceipts());
        materialIssues.clear(); if (snapshot.materialIssues() != null) materialIssues.putAll(snapshot.materialIssues());
        activeCountRevisions.clear();
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

    void restoreHot(HotColdModels.HotInventoryBootstrap hot) {
        motherRolls.clear(); hot.hotRolls().forEach(e -> motherRolls.put(e.id(), e.value()));
        remnantPool.clear(); hot.hotRemnants().forEach(e -> remnantPool.put(e.id(), e.value()));
        tasks.clear(); hot.hotTasks().forEach(e -> tasks.put(e.id(), e.value()));
        plans.clear(); hot.hotPlans().forEach(e -> plans.put(e.id(), e.value()));
        executions.clear(); hot.hotExecutions().forEach(e -> executions.put(e.id(), e.value()));
        schemes.clear(); hot.hotSchemes().forEach(e -> schemes.put(e.id(), e.value()));
        receipts.clear();
        transfers.clear();
        counts.clear();
        templates.clear();
        qualityReleases.clear();
        inventoryReceipts.clear();
        materialIssues.clear();
        ledger = List.of();
        outbox = List.of();
        activeCountRevisions.clear();
        activeCountRevisions.putAll(hot.activeCountRevisions());
        revision = hot.revision();
        ledgerSize = hot.ledgerSize();
        outboxSize = hot.outboxSize();
        outboxStreamHeadId = hot.outboxStreamHeadId();
        remnantSeq.set(hot.remnantSeq());
        defectSeq.set(hot.defectSeq());
        balanceIndex = null;
        rollSort.resetOrdered(hot.hotRolls(), hot.nextRollSortOrder());
        remnantSort.resetOrdered(hot.hotRemnants(), hot.nextRemnantSortOrder());
        taskSort.resetOrdered(hot.hotTasks(), hot.nextTaskSortOrder());
        planSort.resetOrdered(hot.hotPlans(), hot.nextPlanSortOrder());
        receiptSort.resetOrdered(List.of(), hot.nextReceiptSortOrder());
        executionSort.resetOrdered(hot.hotExecutions(), hot.nextExecutionSortOrder());
        schemeSort.resetOrdered(hot.hotSchemes(), hot.nextSchemeSortOrder());
    }

    StateKernelHotColdSupport.TxBackup captureBackup() {
        Map<String, MotherRollInfo> rollsCopy = new LinkedHashMap<>(motherRolls.size() * 2);
        for (var e : motherRolls.entrySet()) rollsCopy.put(e.getKey(), e.getValue().deepCopy());
        Map<String, RemnantStock> remnantsCopy = new LinkedHashMap<>(remnantPool.size() * 2);
        for (var e : remnantPool.entrySet()) remnantsCopy.put(e.getKey(), e.getValue().deepCopy());
        return new StateKernelHotColdSupport.TxBackup(
                rollsCopy, remnantsCopy,
                new LinkedHashMap<>(receipts), new LinkedHashMap<>(tasks), new LinkedHashMap<>(plans),
                new LinkedHashMap<>(executions), new LinkedHashMap<>(transfers), new LinkedHashMap<>(counts),
                new LinkedHashMap<>(templates), new LinkedHashMap<>(schemes),
                new LinkedHashMap<>(qualityReleases), new LinkedHashMap<>(inventoryReceipts), new LinkedHashMap<>(materialIssues),
                new HashMap<>(activeCountRevisions),
                ledger, outbox, revision, ledgerSize, outboxSize, outboxStreamHeadId, remnantSeq.get(), defectSeq.get()
        );
    }

    void restoreBackup(StateKernelHotColdSupport.TxBackup backup) {
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
        activeCountRevisions.clear(); activeCountRevisions.putAll(backup.activeCountRevisions());
        ledger = backup.ledger();
        outbox = backup.outbox();
        revision = backup.revision();
        ledgerSize = backup.ledgerSize();
        outboxSize = backup.outboxSize();
        outboxStreamHeadId = backup.outboxStreamHeadId();
        remnantSeq.set(backup.remnantSeq());
        defectSeq.set(backup.defectSeq());
    }

    // ==================== 按需冷数据回源（写事务内自动挂载 TxBackup 防误删） ====================

    MotherRollInfo findOrLoadRoll(String rollId) {
        if (rollId == null) return null;
        MotherRollInfo hot = motherRolls.get(rollId);
        if (hot != null || !store.supportsHotColdLoading()) return hot;
        var found = store.findMotherRoll(rollId).orElse(null);
        if (found == null) return null;
        if (activeWriteBackup != null) {
            rollSort.seedExistingOrder(found.id(), found.sortOrder());
            activeWriteBackup.rolls().put(found.id(), found.value().deepCopy());
            motherRolls.put(found.id(), found.value());
        }
        return found.value();
    }

    RemnantStock findOrLoadRemnant(String remnantId) {
        if (remnantId == null) return null;
        RemnantStock hot = remnantPool.get(remnantId);
        if (hot != null || !store.supportsHotColdLoading()) return hot;
        var found = store.findRemnant(remnantId).orElse(null);
        if (found == null) return null;
        if (activeWriteBackup != null) {
            remnantSort.seedExistingOrder(found.id(), found.sortOrder());
            activeWriteBackup.remnants().put(found.id(), found.value().deepCopy());
            remnantPool.put(found.id(), found.value());
        }
        return found.value();
    }

    CuttingTask findOrLoadTask(String taskId) {
        if (taskId == null) return null;
        CuttingTask hot = tasks.get(taskId);
        if (hot != null || !store.supportsHotColdLoading()) return hot;
        var found = store.findCuttingTask(taskId).orElse(null);
        if (found == null) return null;
        if (activeWriteBackup != null) {
            taskSort.seedExistingOrder(found.id(), found.sortOrder());
            activeWriteBackup.tasks().put(found.id(), found.value());
            tasks.put(found.id(), found.value());
        }
        return found.value();
    }

    CuttingPlan findOrLoadPlan(String planId) {
        if (planId == null) return null;
        CuttingPlan hot = plans.get(planId);
        if (hot != null || !store.supportsHotColdLoading()) return hot;
        var found = store.findCuttingPlan(planId).orElse(null);
        if (found == null) return null;
        if (activeWriteBackup != null) {
            planSort.seedExistingOrder(found.id(), found.sortOrder());
            activeWriteBackup.plans().put(found.id(), found.value());
            plans.put(found.id(), found.value());
        }
        return found.value();
    }

    ExecutionOrder findOrLoadExecution(String execId) {
        if (execId == null) return null;
        ExecutionOrder hot = executions.get(execId);
        if (hot != null || !store.supportsHotColdLoading()) return hot;
        var found = store.findExecutionOrder(execId).orElse(null);
        if (found == null) return null;
        if (activeWriteBackup != null) {
            executionSort.seedExistingOrder(found.id(), found.sortOrder());
            activeWriteBackup.executions().put(found.id(), found.value());
            executions.put(found.id(), found.value());
        }
        return found.value();
    }

    SchedulingScheme findOrLoadScheme(String schemeId) {
        if (schemeId == null) return null;
        SchedulingScheme hot = schemes.get(schemeId);
        if (hot != null || !store.supportsHotColdLoading()) return hot;
        var found = store.findSchedulingScheme(schemeId).orElse(null);
        if (found == null) return null;
        if (activeWriteBackup != null) {
            schemeSort.seedExistingOrder(found.id(), found.sortOrder());
            activeWriteBackup.schemes().put(found.id(), found.value());
            schemes.put(found.id(), found.value());
        }
        return found.value();
    }

    Map<String, Object> findOrLoadReceipt(String planId) {
        if (planId == null) return null;
        Map<String, Object> hot = receipts.get(planId);
        if (hot != null || !store.supportsHotColdLoading()) return hot;
        var found = store.findCutReport(planId).orElse(null);
        if (found == null) return null;
        if (activeWriteBackup != null) {
            receiptSort.seedExistingOrder(found.id(), found.sortOrder());
            activeWriteBackup.receipts().put(found.id(), found.value());
            receipts.put(found.id(), found.value());
        }
        return found.value();
    }

    private static <T> List<InventoryDelta.IndexedItem<T>> diffUpserts(
            Map<String, T> before, Map<String, T> after, BiPredicate<T, T> unchanged,
            StateKernelHotColdSupport.TableSortIndex sortIndex, Map<String, Long> stagedNewOrders, long[] stagedNext, Set<String> dirtyIdCollector
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
        StateKernelHotColdSupport.AccessFrame existing = accessFrame.get();
        if (existing != null && !existing.writing) throw new IllegalStateException("只读事务上下文禁止升级为写事务");
        rwLock.writeLock().lock();
        boolean root = existing == null;
        if (root) {
            try {
                refreshUnderWriteLock();
                accessFrame.set(new StateKernelHotColdSupport.AccessFrame(true, store.now()));
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
            StateKernelHotColdSupport.TxBackup backup = captureBackup();
            StateKernelHotColdSupport.TxBackup prevActiveBackup = activeWriteBackup;
            activeWriteBackup = backup;
            try {
                T result = command.get();
                if (!root) return result;
                commitRootMutation(backup, eventType, businessId, actor, opTime);
                return result;
            } catch (RuntimeException error) {
                restoreBackup(backup);
                throw error;
            } finally {
                activeWriteBackup = prevActiveBackup;
            }
        } finally {
            if (root) accessFrame.remove();
            else existing.depth--;
            rwLock.writeLock().unlock();
        }
    }

    private void commitRootMutation(StateKernelHotColdSupport.TxBackup backup, String eventType, String businessId, String actor, long opTime) {
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
                dirtyTransfers, dirtyCounts, dirtyReleases, dirtyInvReceipts, dirtyIssues, affectedReceiptTaskIds);

        if (store.supportsHotColdLoading()) {
            List<InventoryLedgerEntry> appendedLedger = InventoryJournal.appendDeltaIncremental(
                    store, backup.revision(), backup.ledgerSize(), backup::toSnapshot,
                    backup.rolls(), backup.remnants(), backup.receipts(), backup.tasks(),
                    motherRolls, remnantPool, receipts, tasks,
                    transfers, counts, qualityReleases, inventoryReceipts, materialIssues,
                    dirtyLedgerKeys, eventType, businessId, actor, opTime
            );
            List<InventoryEvent> appendedOutbox = InventoryEvent.appendDelta(
                    backup.outboxSize(), appendedLedger, eventType, businessId, opTime, backup.revision() + 1);
            InventoryDelta delta = new InventoryDelta(
                    backup.revision(), remnantSeq.get(), defectSeq.get(),
                    upsertedRolls, deletedRolls, upsertedRemnants, deletedRemnants,
                    upsertedTasks, deletedTasks, upsertedPlans, deletedPlans,
                    upsertedReceipts, deletedReceipts, upsertedExecutions, deletedExecutions,
                    upsertedSchemes, deletedSchemes,
                    appendedTransfers, appendedCounts, appendedReleases, appendedInvReceipts, appendedIssues,
                    backup.ledgerSize(), appendedLedger, backup.outboxSize(), appendedOutbox
            );
            java.util.function.Supplier<InventorySnapshot> saveSupplier = backup.revision() == 0L
                    ? () -> new InventorySnapshot(
                            new ArrayList<>(motherRolls.values()), new ArrayList<>(remnantPool.values()),
                            receipts, remnantSeq.get(), defectSeq.get(), tasks, plans, backup.revision(),
                            executions, appendedLedger, transfers, appendedOutbox, counts, templates,
                            schemes, qualityReleases, inventoryReceipts, materialIssues)
                    : this::snapshot;
            revision = store.saveDelta(delta, saveSupplier);
            ledgerSize = backup.ledgerSize() + appendedLedger.size();
            outboxSize = backup.outboxSize() + appendedOutbox.size();
            if (outboxStreamHeadId == null && !appendedOutbox.isEmpty()) outboxStreamHeadId = appendedOutbox.get(0).id();
            for (InventoryCount c : appendedCounts) {
                for (var line : c.lines()) {
                    activeCountRevisions.merge(line.type() + "/" + line.id(), c.inventoryRevision(), Math::max);
                }
            }
            if (backup.revision() == 0L) {
                rollSort.reset(motherRolls.keySet());
                remnantSort.reset(remnantPool.keySet());
                taskSort.reset(tasks.keySet());
                planSort.reset(plans.keySet());
                receiptSort.reset(receipts.keySet());
                executionSort.reset(executions.keySet());
                schemeSort.reset(schemes.keySet());
            } else {
                rollSort.commit(newRollOrders, deletedRolls, nextRollOrder[0]);
                remnantSort.commit(newRemOrders, deletedRemnants, nextRemOrder[0]);
                taskSort.commit(newTaskOrders, deletedTasks, nextTaskOrder[0]);
                planSort.commit(newPlanOrders, deletedPlans, nextPlanOrder[0]);
                receiptSort.commit(newRecOrders, deletedReceipts, nextRecOrder[0]);
                executionSort.commit(newExecOrders, deletedExecutions, nextExecOrder[0]);
                schemeSort.commit(newSchemeOrders, deletedSchemes, nextSchemeOrder[0]);
            }
            Set<String> evictTaskCandidates = new LinkedHashSet<>(dirtyTasks);
            evictTaskCandidates.removeAll(newTaskOrders.keySet());
            evictTaskCandidates.addAll(affectedReceiptTaskIds);
            evictColdAfterCommit(evictTaskCandidates, affectedReceiptTaskIds);
        } else {
            int beforeLedgerSize = backup.ledger().size();
            int beforeOutboxSize = backup.outbox().size();
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
                    upsertedRolls, deletedRolls, upsertedRemnants, deletedRemnants,
                    upsertedTasks, deletedTasks, upsertedPlans, deletedPlans,
                    upsertedReceipts, deletedReceipts, upsertedExecutions, deletedExecutions,
                    upsertedSchemes, deletedSchemes,
                    appendedTransfers, appendedCounts, appendedReleases, appendedInvReceipts, appendedIssues,
                    beforeLedgerSize, appendedLedger, beforeOutboxSize, appendedOutbox
            );
            revision = store.saveDelta(delta, this::snapshot);
            journalOutcome.commitIndex();
            balanceIndex = journalOutcome.baseIndex();
            ledgerSize = ledger.size();
            outboxSize = outbox.size();
            if (outboxStreamHeadId == null && !outbox.isEmpty()) outboxStreamHeadId = outbox.get(0).id();
            rollSort.commit(newRollOrders, deletedRolls, nextRollOrder[0]);
            remnantSort.commit(newRemOrders, deletedRemnants, nextRemOrder[0]);
            taskSort.commit(newTaskOrders, deletedTasks, nextTaskOrder[0]);
            planSort.commit(newPlanOrders, deletedPlans, nextPlanOrder[0]);
            receiptSort.commit(newRecOrders, deletedReceipts, nextRecOrder[0]);
            executionSort.commit(newExecOrders, deletedExecutions, nextExecOrder[0]);
            schemeSort.commit(newSchemeOrders, deletedSchemes, nextSchemeOrder[0]);
        }
    }

    private void evictColdAfterCommit(Set<String> dirtyTasks, Set<String> affectedReceiptTaskIds) {
        ledger = List.of();
        outbox = List.of();
        StateKernelHotColdSupport.evictColdAfterCommit(
                store, motherRolls, remnantPool, receipts, tasks, plans, executions, schemes,
                transfers, counts, qualityReleases, inventoryReceipts, materialIssues, activeCountRevisions,
                rollSort, remnantSort, taskSort, planSort, receiptSort, executionSort, schemeSort,
                dirtyTasks, affectedReceiptTaskIds
        );
    }

    <T> T withWriteLock(Supplier<T> action) {
        StateKernelHotColdSupport.AccessFrame existing = accessFrame.get();
        if (existing != null && !existing.writing) throw new IllegalStateException("只读事务上下文禁止升级为写锁推演");
        rwLock.writeLock().lock();
        boolean root = existing == null;
        if (root) {
            try {
                refreshUnderWriteLock();
                accessFrame.set(new StateKernelHotColdSupport.AccessFrame(true, store.now()));
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
            if (root) accessFrame.remove();
            else existing.depth--;
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
            if (remoteRevision != null && remoteRevision == revision) return;
            if (store.supportsHotColdLoading()) {
                HotColdModels.HotInventoryBootstrap latestHot = store.loadHotSnapshot();
                if (latestHot != null && latestHot.revision() != revision) restoreHot(latestHot);
            } else {
                InventorySnapshot latest = store.load();
                if (latest != null && latest.revision() != revision) restore(latest);
            }
        }
    }

    <T> T read(Supplier<T> query) {
        StateKernelHotColdSupport.AccessFrame existing = accessFrame.get();
        if (existing != null) return query.get();
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
            accessFrame.set(new StateKernelHotColdSupport.AccessFrame(false, store.now()));
            try {
                return query.get();
            } finally {
                accessFrame.remove();
            }
        } finally {
            if (readLocked) rwLock.readLock().unlock();
        }
    }

    // ==================== 独立模板存储、Outbox、健康与账本查询 ====================

    List<DemandTemplate> listTemplatesIndependent() {
        if (store.supportsIndependentTemplates()) return List.copyOf(store.loadTemplates());
        return read(() -> List.copyOf(templates.values()));
    }

    DemandTemplate saveTemplateIndependent(DemandTemplate template) {
        if (template == null || template.id() == null || template.id().isBlank())
            throw new IllegalArgumentException("需求模板及其编号不能为空");
        if (store.supportsIndependentTemplates()) { store.upsertTemplate(template); return template; }
        return mutate("SYSTEM_UPDATE", template.id(), "UNAUTHENTICATED_LOCAL", () -> { templates.put(template.id(), template); return template; });
    }

    boolean deleteTemplateIndependent(String id) {
        if (id == null || id.isBlank()) return false;
        String trimmed = id.trim();
        if (store.supportsIndependentTemplates()) return store.deleteTemplate(trimmed);
        return mutate("SYSTEM_UPDATE", trimmed, "UNAUTHENTICATED_LOCAL", () -> templates.remove(trimmed) != null);
    }

    List<InventoryEvent> integrationEvents() {
        return read(() -> {
            if (store.supportsHotColdLoading()) return store.queryOutboxPage(0L, 5000);
            return outbox;
        });
    }

    Map<String, Object> healthStatus() {
        String storageError;
        try { storageError = store.healthCheckError(); }
        catch (Exception e) { storageError = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName(); }
        long availableRemnants = remnantPool.values().stream().filter(r -> "AVAILABLE".equalsIgnoreCase(r.getStatus())).count();
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("storageHealthy", storageError == null);
        if (storageError != null) status.put("storageError", storageError);
        status.put("revision", revision);
        status.put("remnantsInStock", (int) availableRemnants);
        return status;
    }

    Map<String, Object> inventoryLedger(String aggregateType, String aggregateId, long after, int limit) {
        if (after < 0 || limit < 1 || limit > 500) throw new IllegalArgumentException("流水游标不得为负，分页大小为 1–500");
        return read(() -> {
            if (store.supportsHotColdLoading()) return store.queryLedgerPage(aggregateType, aggregateId, after, limit);
            var page = ledger.stream().filter(e -> e.sequence() > after
                    && (aggregateType == null || aggregateType.equals(e.aggregateType()))
                    && (aggregateId == null || aggregateId.equals(e.aggregateId()))).limit(limit + 1L).toList();
            var items = page.stream().limit(limit).toList();
            return Map.of("items", items, "hasMore", page.size() > limit,
                    "nextCursor", items.isEmpty() ? after : items.get(items.size() - 1).sequence(), "revision", revision);
        });
    }

    Map<String, Object> reconcileInventory() {
        return read(() -> store.supportsHotColdLoading()
                ? InventoryJournal.reconcileStreaming(store, revision)
                : InventoryJournal.reconcile(snapshot()));
    }

    // ==================== 跨垂直领域共享只读与不变量原语 ====================

    long countRevision(String type, String id) {
        if (store.supportsHotColdLoading()) {
            Long cached = activeCountRevisions.get(type + "/" + id);
            return cached != null ? cached : store.findMaxCountRevision(type, id);
        }
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
                var rec = findOrLoadReceipt(pid);
                if (rec != null && !"REVERSED".equals(rec.get("status"))) accumulateReceiptDemandForTask(rec, taskId, reportedInScheme);
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
        return planId != null && schemes.values().stream().anyMatch(s -> s.isMaterialLockActive() && s.linkedPlanIds().contains(planId));
    }

    boolean isRollIntervalReservedByOtherScheme(String rollId, double startY, double length, String exceptPlan) {
        double endY = startY + length;
        for (var s : schemes.values()) {
            if (!s.occupiesRoll(rollId)) continue;
            if (exceptPlan != null && s.linkedPlanIds().contains(exceptPlan)) continue;
            double otherStart = s.windowStartY(), otherEnd = otherStart + s.occupiedLengthMm();
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
            RemnantStock item = findOrLoadRemnant(request.getSourceRemnantId());
            if (item == null) throw new IllegalArgumentException("料头不存在，请重新选料");
            return countedFingerprint("remnant", item.getId(), Arrays.asList(item.getId(), item.getWidth(), item.getLength(),
                    item.getMaterialBatch(), item.getSourceRollId(), item.isHasDefect(), item.getDefects()));
        }
        MotherRollInfo roll = findOrLoadRoll(request.getRollId());
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
        return ColdStateQueryBridge.qualityEvents(json, receipt);
    }

    int qualityRevisionOf(List<QualityDisposition> events) {
        return ColdStateQueryBridge.qualityRevisionOf(events);
    }

    Map<String, Object> qualityProjection(Map<String, Object> receipt) {
        return ColdStateQueryBridge.qualityProjection(json, receipt);
    }

    List<Map<String, Object>> taskReportsInternal(String taskId) {
        return ColdStateQueryBridge.loadTaskReports(json, store, receipts, taskId);
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
        return ColdStateQueryBridge.computeTaskCompleted(store, receipts, taskId);
    }

    void prepareTaskSolveInternal(SolveRequest request) {
        if (request == null) throw new IllegalArgumentException("排料请求不能为空");
        if (request.getTaskId() == null) return;
        CuttingTask task = findOrLoadTask(request.getTaskId());
        if (task == null || task.revision() != request.getTaskRevision()) throw new IllegalArgumentException("任务已更新，请重新载入需求");
        boolean remnant = "remnant".equals(request.getFeedPortType());
        if (!remnant && !"roll".equals(request.getFeedPortType())) throw new IllegalArgumentException("无效的材料来源");
        MotherRollInfo roll = findOrLoadRoll(request.getRollId());
        RemnantStock stock = remnant ? findOrLoadRemnant(request.getSourceRemnantId()) : null;
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
                .sorted(Comparator.comparing(RemnantStock::getId)).toList();
    }

    List<RemnantStock> getRemnantsByRollIdInternal(String rollId) {
        if (rollId == null || rollId.trim().isEmpty() || "ALL".equalsIgnoreCase(rollId)) return getAvailableRemnantsInternal();
        String cleanRollId = rollId.trim();
        return remnantPool.values().stream()
                .filter(r -> "AVAILABLE".equalsIgnoreCase(r.getStatus()))
                .filter(r -> cleanRollId.equalsIgnoreCase(r.getSourceRollId()))
                .sorted(Comparator.comparing(RemnantStock::getId)).toList();
    }

    MotherRollInfo getMotherRollInternal(String rollId) {
        if (rollId == null) return null;
        MotherRollInfo info = findOrLoadRoll(rollId);
        if (info == null) return null;
        List<RemnantStock> rollRemnants = getRemnantsByRollIdInternal(rollId);
        double totalArea = rollRemnants.stream().mapToDouble(RemnantStock::getArea).sum();
        return info.copyWithRemnantStats(rollRemnants.size(), totalArea);
    }

    void inheritLineageMetadata(RemnantStock target, MotherRollInfo roll, RemnantStock parent) {
        StateKernelHotColdSupport.inheritLineageMetadata(target, roll, parent);
    }

    boolean matchesBatchAndColor(CuttingTask task, MotherRollInfo roll, RemnantStock remnant) {
        try { validateBatchAndColorInternal(task, roll, remnant); return true; }
        catch (IllegalArgumentException e) { return false; }
    }

    void validateBatchAndColorInternal(CuttingTask task, MotherRollInfo roll, RemnantStock remnant) {
        StateKernelHotColdSupport.validateBatchAndColor(
                task, roll, remnant, store, receipts, schemes, this::findOrLoadRoll, this::findOrLoadRemnant);
    }

    void verifyReportReplay(Map<String, Object> receipt, CutReport report) {
        Object hash = receipt.get("reportContent");
        if (hash != null && !hash.equals(json.writeValueAsString(report)))
            throw new InventoryConflictException("该方案已报工，重复提交的内容不同");
    }

    static String normalizePriority(String priority) { return StateKernelHotColdSupport.normalizePriority(priority); }
    static String requireIdempotencyKey(String key) { return StateKernelHotColdSupport.requireIdempotencyKey(key); }
    static String requireText(String value, int maxLen, String message) { return StateKernelHotColdSupport.requireText(value, maxLen, message); }
    static String blankToNull(String value) { return StateKernelHotColdSupport.blankToNull(value); }
}
