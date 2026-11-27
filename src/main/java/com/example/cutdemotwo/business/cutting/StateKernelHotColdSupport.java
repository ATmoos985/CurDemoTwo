package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.DemandTemplate;
import com.example.cutdemotwo.business.model.ExecutionOrder;
import com.example.cutdemotwo.business.model.InventoryBatchImportDocument;
import com.example.cutdemotwo.business.model.InventoryCount;
import com.example.cutdemotwo.business.model.InventoryEvent;
import com.example.cutdemotwo.business.model.InventoryLedgerEntry;
import com.example.cutdemotwo.business.model.InventoryReceiptDocument;
import com.example.cutdemotwo.business.model.InventoryTransfer;
import com.example.cutdemotwo.business.model.MaterialIssueDocument;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.QualityReleaseDocument;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.persistence.HotColdModels;
import com.example.cutdemotwo.persistence.InventorySnapshot;
import com.example.cutdemotwo.persistence.InventoryStore;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Function;

/**
 * {@link InventoryStateKernel} 的状态索引、事务备份与基础字段规范化辅助类型（包级私有，严禁反向依赖 Kernel 或业务服务）。
 */
final class StateKernelHotColdSupport {
    private StateKernelHotColdSupport() {}

    static final class TableSortIndex {
        final Map<String, Long> orders = new LinkedHashMap<>();
        long nextOrder = 0L;

        void reset(Collection<String> ids) {
            orders.clear();
            nextOrder = 0L;
            for (String id : ids) orders.put(id, nextOrder++);
        }

        <T> void resetOrdered(List<HotColdModels.OrderedEntry<T>> items, long next) {
            orders.clear();
            for (var item : items) orders.put(item.id(), item.sortOrder());
            this.nextOrder = next;
        }

        void seedExistingOrder(String id, long sortOrder) {
            orders.putIfAbsent(id, sortOrder);
        }

        void evict(Collection<String> coldIds) {
            for (String id : coldIds) orders.remove(id);
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
            if (stagedNewOrders != null && !stagedNewOrders.isEmpty()) orders.putAll(stagedNewOrders);
            this.nextOrder = newNext;
        }
    }

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
            Map<String, InventoryBatchImportDocument> batchImports,
            Map<String, Long> activeCountRevisions,
            List<InventoryLedgerEntry> ledger,
            List<InventoryEvent> outbox,
            long revision,
            long ledgerSize,
            long outboxSize,
            String outboxStreamHeadId,
            int remnantSeq,
            int defectSeq
    ) {
        InventorySnapshot toSnapshot() {
            return new InventorySnapshot(new ArrayList<>(rolls.values()), new ArrayList<>(remnants.values()),
                    receipts, remnantSeq, defectSeq, tasks, plans, revision, executions, ledger, transfers,
                    outbox, counts, templates, schemes, qualityReleases, inventoryReceipts, materialIssues, batchImports);
        }
    }

    static final class AccessFrame {
        int depth;
        final boolean writing;
        final long operationTime;

        AccessFrame(boolean writing, long operationTime) {
            this.depth = 1;
            this.writing = writing;
            this.operationTime = operationTime;
        }
    }

    static void inheritLineageMetadata(RemnantStock target, MotherRollInfo roll, RemnantStock parent) {
        if (target == null) return;
        if (blankToNull(target.getBatchNo()) == null) {
            String inheritedBatch = (parent != null && blankToNull(parent.getBatchNo()) != null) ? parent.getBatchNo().trim()
                    : (roll != null ? blankToNull(roll.getBatchNo()) : null);
            target.setBatchNo(inheritedBatch);
        }
        if (blankToNull(target.getColor()) == null) {
            String inheritedColor = (parent != null && blankToNull(parent.getColor()) != null) ? parent.getColor().trim()
                    : (roll != null ? blankToNull(roll.getColor()) : null);
            target.setColor(inheritedColor);
        }
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
        if (clean == null || clean.length() > 128) throw new IllegalArgumentException("请提供 1–128 字符的有效幂等键 idempotencyKey");
        return clean;
    }

    static String requireText(String value, int maxLen, String message) {
        String clean = blankToNull(value);
        if (clean == null || clean.length() > maxLen) throw new IllegalArgumentException(message);
        return clean;
    }

    static String blankToNull(String value) {
        return (value == null || value.isBlank()) ? null : value.trim();
    }

    static void validateBatchAndColor(
            CuttingTask task,
            MotherRollInfo roll,
            RemnantStock remnant,
            InventoryStore store,
            Map<String, Map<String, Object>> hotReceipts,
            Map<String, SchedulingScheme> hotSchemes,
            Function<String, MotherRollInfo> rollFinder,
            Function<String, RemnantStock> remnantFinder
    ) {
        if (task == null) return;
        String reqBatch = blankToNull(task.requiredBatchNo()), reqColor = blankToNull(task.requiredColor());
        boolean strict = Boolean.TRUE.equals(task.strictBatchMatch());
        if (reqBatch == null && reqColor == null && !strict) return;
        MotherRollInfo effectiveRoll = roll;
        if (effectiveRoll == null && remnant != null && remnant.getSourceRollId() != null) {
            effectiveRoll = rollFinder.apply(remnant.getSourceRollId());
        }
        String actualBatch = (remnant != null && blankToNull(remnant.getBatchNo()) != null) ? remnant.getBatchNo().trim()
                : (effectiveRoll != null ? blankToNull(effectiveRoll.getBatchNo()) : null);
        String actualColor = (remnant != null && blankToNull(remnant.getColor()) != null) ? remnant.getColor().trim()
                : (effectiveRoll != null ? blankToNull(effectiveRoll.getColor()) : null);
        String label = remnant != null ? ("料头 " + remnant.getId()) : (effectiveRoll != null ? ("母卷 " + effectiveRoll.getRollId()) : "所选材料");
        if (reqBatch != null && (actualBatch == null || !reqBatch.equalsIgnoreCase(actualBatch))) {
            throw new IllegalArgumentException("缸号不匹配（防色差拦截）：任务「" + task.name() + "」要求缸号「"
                    + reqBatch + "」，但" + label + "缸号为「" + Objects.toString(actualBatch, "未登记") + "」");
        }
        if (reqColor != null && (actualColor == null || !reqColor.equalsIgnoreCase(actualColor))) {
            throw new IllegalArgumentException("色号不匹配（防色差拦截）：任务「" + task.name() + "」要求色号「"
                    + reqColor + "」，但" + label + "色号为「" + Objects.toString(actualColor, "未登记") + "」");
        }
        if (strict) {
            if (actualBatch == null) throw new IllegalArgumentException("同单同缸强约束拦截：任务「" + task.name() + "」要求严格同缸，但" + label + "未登记缸号");
            String establishedBatch = findEstablishedTaskBatchNo(task.id(), store, hotReceipts, hotSchemes, rollFinder, remnantFinder);
            if (establishedBatch != null && !establishedBatch.equalsIgnoreCase(actualBatch)) {
                throw new IllegalArgumentException("同单同缸强约束拦截（防色差）：任务「" + task.name() + "」已锁定缸号「"
                        + establishedBatch + "」，不能混用缸号「" + actualBatch + "」");
            }
        }
    }

    private static String findEstablishedTaskBatchNo(
            String taskId,
            InventoryStore store,
            Map<String, Map<String, Object>> hotReceipts,
            Map<String, SchedulingScheme> hotSchemes,
            Function<String, MotherRollInfo> rollFinder,
            Function<String, RemnantStock> remnantFinder
    ) {
        if (taskId == null) return null;
        List<Map<String, Object>> taskReceipts = store.supportsHotColdLoading()
                ? store.findCutReportsByTaskId(taskId)
                : new ArrayList<>(hotReceipts.values());
        for (Map<String, Object> rec : taskReceipts) {
            if ("REVERSED".equals(rec.get("status"))) continue;
            if (!InventoryJournal.receiptTaskIds(rec).contains(taskId)) continue;
            String batch = resolveMaterialBatchNo(
                    rec.get("rollId") != null ? rec.get("rollId").toString() : null,
                    rec.get("sourceRemnantId") != null ? rec.get("sourceRemnantId").toString() : null,
                    rollFinder, remnantFinder);
            if (batch != null) return batch;
        }
        for (SchedulingScheme sc : hotSchemes.values()) {
            if (!sc.isMaterialLockActive() || !sc.involvesTask(taskId)) continue;
            String batch = resolveMaterialBatchNo(sc.rollId(), sc.remnantId(), rollFinder, remnantFinder);
            if (batch != null) return batch;
        }
        return null;
    }

    private static String resolveMaterialBatchNo(
            String rollId,
            String remnantId,
            Function<String, MotherRollInfo> rollFinder,
            Function<String, RemnantStock> remnantFinder
    ) {
        if (remnantId != null) {
            RemnantStock rem = remnantFinder.apply(remnantId);
            if (rem != null) {
                if (blankToNull(rem.getBatchNo()) != null) return rem.getBatchNo().trim();
                if (rem.getSourceRollId() != null) {
                    MotherRollInfo parentRoll = rollFinder.apply(rem.getSourceRollId());
                    if (parentRoll != null && blankToNull(parentRoll.getBatchNo()) != null) return parentRoll.getBatchNo().trim();
                }
            }
        }
        if (rollId != null) {
            MotherRollInfo roll = rollFinder.apply(rollId);
            if (roll != null) return blankToNull(roll.getBatchNo());
        }
        return null;
    }

    static void evictColdAfterCommit(
            InventoryStore store,
            Map<String, MotherRollInfo> motherRolls,
            Map<String, RemnantStock> remnantPool,
            Map<String, Map<String, Object>> receipts,
            Map<String, CuttingTask> tasks,
            Map<String, CuttingPlan> plans,
            Map<String, ExecutionOrder> executions,
            Map<String, SchedulingScheme> schemes,
            Map<String, InventoryTransfer> transfers,
            Map<String, InventoryCount> counts,
            Map<String, QualityReleaseDocument> qualityReleases,
            Map<String, InventoryReceiptDocument> inventoryReceipts,
            Map<String, MaterialIssueDocument> materialIssues,
            Map<String, InventoryBatchImportDocument> batchImports,
            Map<String, Long> activeCountRevisions,
            TableSortIndex rollSort,
            TableSortIndex remnantSort,
            TableSortIndex taskSort,
            TableSortIndex planSort,
            TableSortIndex receiptSort,
            TableSortIndex executionSort,
            TableSortIndex schemeSort,
            Set<String> dirtyTasks,
            Set<String> affectedReceiptTaskIds
    ) {
        receiptSort.evict(receipts.keySet());
        receipts.clear();
        transfers.clear();
        counts.clear();
        qualityReleases.clear();
        inventoryReceipts.clear();
        materialIssues.clear();
        batchImports.clear();

        List<String> coldExecs = executions.values().stream()
                .filter(e -> !ColdStateQueryBridge.isHotExecution(e)).map(ExecutionOrder::id).toList();
        coldExecs.forEach(executions::remove);
        executionSort.evict(coldExecs);

        List<String> coldSchemes = schemes.values().stream()
                .filter(s -> !ColdStateQueryBridge.isHotScheme(s)).map(SchedulingScheme::id).toList();
        coldSchemes.forEach(schemes::remove);
        schemeSort.evict(coldSchemes);

        Set<String> pinnedPlans = new HashSet<>();
        Set<String> pinnedRolls = new HashSet<>();
        Set<String> pinnedRemnants = new HashSet<>();
        Set<String> pinnedTasks = new HashSet<>();
        for (ExecutionOrder e : executions.values()) {
            pinnedPlans.add(e.planId());
            pinnedTasks.add(e.taskId());
            if ("roll".equalsIgnoreCase(e.materialType())) pinnedRolls.add(e.materialId());
            else pinnedRemnants.add(e.materialId());
        }
        for (SchedulingScheme s : schemes.values()) {
            pinnedPlans.addAll(s.linkedPlanIds());
            pinnedTasks.addAll(s.involvedTaskIds());
            if (s.rollId() != null) pinnedRolls.add(s.rollId());
            if (s.remnantId() != null) pinnedRemnants.add(s.remnantId());
        }

        List<String> coldPlans = plans.values().stream()
                .filter(p -> !ColdStateQueryBridge.isHotPlan(p, pinnedPlans)).map(CuttingPlan::id).toList();
        coldPlans.forEach(plans::remove);
        planSort.evict(coldPlans);

        for (CuttingPlan p : plans.values()) {
            if (p.request().getTaskId() != null) pinnedTasks.add(p.request().getTaskId());
            if ("PENDING".equals(p.status())) {
                if (p.request().getRollId() != null) pinnedRolls.add(p.request().getRollId());
                if (p.request().getSourceRemnantId() != null) pinnedRemnants.add(p.request().getSourceRemnantId());
            }
        }

        List<String> coldRolls = motherRolls.values().stream()
                .filter(r -> !ColdStateQueryBridge.isHotRoll(r, pinnedRolls)).map(MotherRollInfo::getRollId).toList();
        coldRolls.forEach(r -> { motherRolls.remove(r); activeCountRevisions.remove("roll/" + r); });
        rollSort.evict(coldRolls);

        List<String> coldRemnants = remnantPool.values().stream()
                .filter(r -> !ColdStateQueryBridge.isHotRemnant(r, pinnedRemnants)).map(RemnantStock::getId).toList();
        coldRemnants.forEach(r -> { remnantPool.remove(r); activeCountRevisions.remove("remnant/" + r); });
        remnantSort.evict(coldRemnants);

        Set<String> checkTaskIds = new HashSet<>(dirtyTasks);
        checkTaskIds.addAll(affectedReceiptTaskIds);
        List<String> coldTasks = new ArrayList<>();
        for (String tid : checkTaskIds) {
            CuttingTask task = tasks.get(tid);
            if (task != null && !pinnedTasks.contains(tid)) {
                Map<String, Integer> done = ColdStateQueryBridge.computeTaskCompleted(store, receipts, tid);
                if (!ColdStateQueryBridge.isHotTask(task, done, pinnedTasks)) coldTasks.add(tid);
            }
        }
        coldTasks.forEach(tasks::remove);
        taskSort.evict(coldTasks);
    }
}
