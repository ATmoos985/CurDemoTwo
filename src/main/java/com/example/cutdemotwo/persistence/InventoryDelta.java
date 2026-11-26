package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.ExecutionOrder;
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

import java.util.List;
import java.util.Map;

/**
 * 写事务精确变更集（Delta）：
 * 仅携带本次事务实际变动的聚合记录与追加表尾部新增行，供 JDBC 存储执行定点 SQL 提交，
 * 彻底消除全表 SELECT Diff 与全历史追加表反序列化。
 */
public record InventoryDelta(
        long expectedRevision,
        int remnantSeq,
        int defectSeq,
        List<IndexedItem<MotherRollInfo>> upsertedRolls,
        List<String> deletedRollIds,
        List<IndexedItem<RemnantStock>> upsertedRemnants,
        List<String> deletedRemnantIds,
        List<IndexedItem<CuttingTask>> upsertedTasks,
        List<String> deletedTaskIds,
        List<IndexedItem<CuttingPlan>> upsertedPlans,
        List<String> deletedPlanIds,
        List<IndexedItem<Map<String, Object>>> upsertedReceipts,
        List<String> deletedReceiptIds,
        List<IndexedItem<ExecutionOrder>> upsertedExecutions,
        List<String> deletedExecutionIds,
        List<IndexedItem<SchedulingScheme>> upsertedSchemes,
        List<String> deletedSchemeIds,
        List<InventoryTransfer> appendedTransfers,
        List<InventoryCount> appendedCounts,
        List<QualityReleaseDocument> appendedQualityReleases,
        List<InventoryReceiptDocument> appendedInventoryReceipts,
        List<MaterialIssueDocument> appendedMaterialIssues,
        long priorLedgerSize,
        List<InventoryLedgerEntry> appendedLedger,
        long priorOutboxSize,
        List<InventoryEvent> appendedOutbox
) {
    public record IndexedItem<T>(String id, long sortOrder, T value) {}
}
