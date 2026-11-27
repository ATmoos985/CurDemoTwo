package com.example.cutdemotwo.persistence;

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

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Consumer;

public interface InventoryStore {
    InventorySnapshot load();
    long save(InventorySnapshot snapshot);
    default boolean shared() { return false; }
    default long now() { return System.currentTimeMillis(); }

    /**
     * 轻量无锁查询当前存储版本号：返回 null 表示该存储实现不支持轻量探测，调用方退回完整 load()。
     */
    default Long currentRevision() { return null; }

    /**
     * 轻量无锁健康检查：返回 null 表示存储可用，非空返回具体故障原因。
     */
    default String healthCheckError() { return null; }

    /**
     * 是否支持需求模板独立持久化（不占用库存全局 revision 锁与账本事务）。
     */
    default boolean supportsIndependentTemplates() { return false; }

    default List<DemandTemplate> loadTemplates() { return List.of(); }

    default void upsertTemplate(DemandTemplate template) {
        throw new UnsupportedOperationException("当前存储实现不支持独立写入需求模板");
    }

    default boolean deleteTemplate(String id) {
        throw new UnsupportedOperationException("当前存储实现不支持独立删除需求模板");
    }

    /**
     * 增量提交变更集：默认回退至全量快照 save()，保证文件存储及测试桩 100% 兼容；
     * JDBC 存储实现为定点 SQL UPSERT/DELETE + 追加表尾行 INSERT，消除全表扫描。
     */
    default long saveDelta(InventoryDelta delta, java.util.function.Supplier<InventorySnapshot> fullSnapshotSupplier) {
        return save(fullSnapshotSupplier.get());
    }

    // ==================== 热冷数据分离与按需分页/点查端口（默认兜底兼容 File 模式与测试桩） ====================

    default boolean supportsHotColdLoading() { return false; }

    default HotColdModels.HotInventoryBootstrap loadHotSnapshot() {
        throw new UnsupportedOperationException("当前存储实现不支持热冷分离引导加载");
    }

    default long countLedgerEntries() { return 0L; }

    default Optional<String> findLatestAggregateAfterJson(String aggregateType, String aggregateId) {
        return Optional.empty();
    }

    default List<String> findReversalLedgerIds(String aggregateType, String aggregateId, String businessId, boolean dispositionRevoke) {
        return List.of();
    }

    default Map<String, Object> queryLedgerPage(String aggregateType, String aggregateId, long after, int limit) {
        throw new UnsupportedOperationException("当前存储实现不支持分页查询库存流水");
    }

    default void streamLedgerEntries(int batchSize, Consumer<List<InventoryLedgerEntry>> consumer) {
        throw new UnsupportedOperationException("当前存储实现不支持流式读取库存流水");
    }

    default long countOutboxEvents() { return 0L; }

    default Optional<String> findOutboxFirstEventId() { return Optional.empty(); }

    default Optional<InventoryEvent> findOutboxBySequence(long sequence) { return Optional.empty(); }

    default List<InventoryEvent> queryOutboxPage(long after, int limit) { return List.of(); }

    default List<InventoryTransfer> listTransfers(int limit, int offset) { return List.of(); }

    default Optional<InventoryTransfer> findTransferByIdempotencyKey(String key) { return Optional.empty(); }

    default boolean hasTransferForMaterial(String type, String id) { return false; }

    default void streamTransfers(int batchSize, Consumer<List<InventoryTransfer>> consumer) {}

    default List<InventoryCount> listCounts(int limit, int offset) { return List.of(); }

    default Optional<InventoryCount> findCountByIdempotencyKey(String key) { return Optional.empty(); }

    default long findMaxCountRevision(String type, String id) { return 0L; }

    default void streamCounts(int batchSize, Consumer<List<InventoryCount>> consumer) {}

    default List<QualityReleaseDocument> listQualityReleases(int limit, int offset) { return List.of(); }

    default Optional<QualityReleaseDocument> findQualityReleaseByIdempotencyKey(String key) { return Optional.empty(); }

    default boolean hasQualityReleaseForRemnant(String remnantId) { return false; }

    default void streamQualityReleases(int batchSize, Consumer<List<QualityReleaseDocument>> consumer) {}

    default List<InventoryReceiptDocument> listInventoryReceipts(int limit, int offset) { return List.of(); }

    default Optional<InventoryReceiptDocument> findInventoryReceiptByIdempotencyKey(String key) { return Optional.empty(); }

    default boolean hasInventoryReceiptForRoll(String rollId) { return false; }

    default void streamInventoryReceipts(int batchSize, Consumer<List<InventoryReceiptDocument>> consumer) {}

    default List<MaterialIssueDocument> listMaterialIssues(int limit, int offset) { return List.of(); }

    default Optional<MaterialIssueDocument> findMaterialIssueByIdempotencyKey(String key) { return Optional.empty(); }

    default boolean hasMaterialIssueForRoll(String rollId) { return false; }

    default void streamMaterialIssues(int batchSize, Consumer<List<MaterialIssueDocument>> consumer) {}

    default Optional<InventoryBatchImportDocument> findBatchImportByIdempotencyKey(String key) { return Optional.empty(); }

    default Optional<HotColdModels.OrderedEntry<Map<String, Object>>> findCutReport(String planId) {
        return Optional.empty();
    }

    default List<Map<String, Object>> findCutReportsByRollId(String rollId) { return List.of(); }

    default List<Map<String, Object>> findCutReportsByTaskId(String taskId) { return List.of(); }

    default HotColdModels.PagedSlice<Map<String, Object>> queryCutReportsPage(int limit, int offset, String statusFilter, String taskIdFilter) {
        return new HotColdModels.PagedSlice<>(List.of(), 0L, limit, offset, false);
    }

    default void streamActiveCutReports(int batchSize, Consumer<List<Map<String, Object>>> consumer) {}

    default void streamAllCutReports(int batchSize, Consumer<List<Map<String, Object>>> consumer) {}

    default Optional<Map<String, Object>> findLatestActiveCutReportForRoll(String rollId) { return Optional.empty(); }

    default boolean hasAnyCutReportForRoll(String rollId) { return false; }

    default Optional<Map<String, Object>> findCutReportByDispositionRevokeKey(String idempotencyKey) {
        return Optional.empty();
    }

    default Optional<HotColdModels.OrderedEntry<CuttingTask>> findCuttingTask(String id) { return Optional.empty(); }

    default Optional<HotColdModels.OrderedEntry<CuttingTask>> findTaskByExternalRef(String externalRef) { return Optional.empty(); }

    default Optional<HotColdModels.OrderedEntry<CuttingTask>> findTaskByReplenishKey(String key) { return Optional.empty(); }

    default List<CuttingTask> listAllTasks() { return List.of(); }

    default void streamCuttingTasks(int batchSize, Consumer<List<CuttingTask>> consumer) {}

    default Optional<HotColdModels.OrderedEntry<CuttingPlan>> findCuttingPlan(String id) { return Optional.empty(); }

    default List<CuttingPlan> listTaskPlans(String taskId) { return List.of(); }

    default Optional<HotColdModels.OrderedEntry<ExecutionOrder>> findExecutionOrder(String id) { return Optional.empty(); }

    default List<ExecutionOrder> listTaskExecutions(String taskId) { return List.of(); }

    default Optional<HotColdModels.OrderedEntry<SchedulingScheme>> findSchedulingScheme(String id) { return Optional.empty(); }

    default Optional<SchedulingScheme> findSchemeByIdempotencyKey(String key) { return Optional.empty(); }

    default Optional<SchedulingScheme> findSchemeByMesReceiptNo(String receiptNo) { return Optional.empty(); }

    default List<SchedulingScheme> listAllSchemes() { return List.of(); }

    default List<SchedulingScheme> findSchemesForPlanIds(Set<String> planIds, Set<String> taskIds) { return List.of(); }

    default List<SchedulingScheme> findActiveSchemesByPlanId(String planId) { return List.of(); }

    default List<SchedulingScheme> findSchemesByRollId(String rollId) { return List.of(); }

    default List<SchedulingScheme> querySchemes(String stateFilter, String taskIdFilter) { return List.of(); }

    default long countActiveSchemesForTask(String taskId) { return 0L; }

    default Optional<HotColdModels.OrderedEntry<MotherRollInfo>> findMotherRoll(String rollId) { return Optional.empty(); }

    default Optional<MotherRollInfo> findMotherRollByScrapKey(String key) { return Optional.empty(); }

    default List<MotherRollInfo> listAllMotherRolls() { return List.of(); }

    default List<MotherRollInfo> listMotherRollsPage(int limit, int offset) { return List.of(); }

    default void streamMotherRolls(int batchSize, Consumer<List<MotherRollInfo>> consumer) {}

    default Optional<HotColdModels.OrderedEntry<RemnantStock>> findRemnant(String id) { return Optional.empty(); }

    default List<RemnantStock> listAllRemnants() { return List.of(); }

    default List<RemnantStock> listRemnantsBySourceRoll(String rollId) { return List.of(); }

    default void streamRemnants(int batchSize, Consumer<List<RemnantStock>> consumer) {}
}
