package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.CutReport;
import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.DemandTemplate;
import com.example.cutdemotwo.business.model.ExecutionOrder;
import com.example.cutdemotwo.business.model.InventoryCount;
import com.example.cutdemotwo.business.model.InventoryEvent;
import com.example.cutdemotwo.business.model.InventoryReceiptDocument;
import com.example.cutdemotwo.business.model.InventoryTransfer;
import com.example.cutdemotwo.business.model.MaterialIssueDocument;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.QualityDisposition;
import com.example.cutdemotwo.business.model.QualityReleaseDocument;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.business.model.SolveResponse;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.persistence.FileInventoryStore;
import com.example.cutdemotwo.persistence.InventoryConflictException;
import com.example.cutdemotwo.persistence.InventorySnapshot;
import com.example.cutdemotwo.persistence.InventoryStore;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;

/**
 * 工业母卷、料头与裁切业务统一门面 (Compatible Domain Facade)：
 * 对外保持既有 Spring Bean、公共方法签名及 {@link CuttingStatePort} 契约 100% 兼容，
 * 内部将状态锁与增量持久化下沉至 {@link InventoryStateKernel}，并将业务逻辑按单一职责垂直委托至 4 个彼此独立的领域服务：
 * {@link RollAndRemnantDomainService}、{@link FactoryDocumentDomainService}、
 * {@link CuttingTaskDomainService}、{@link CuttingExecutionAndReportService}。
 */
@Service
public class RemnantService implements CuttingStatePort {

    private final InventoryStateKernel kernel;
    private final RollAndRemnantDomainService rollAndRemnantService;
    private final FactoryDocumentDomainService factoryDocumentService;
    private final CuttingTaskDomainService taskService;
    private final CuttingExecutionAndReportService executionAndReportService;

    @Value("${cutdemo.measurement.tolerance-mm:5}")
    private double measurementToleranceMm = 5;

    public RemnantService(String statePath) {
        this(new FileInventoryStore(statePath), true);
    }

    @Autowired
    public RemnantService(InventoryStore store, @Value("${cutdemo.seed-demo-data:}") String seedDemo) {
        this(store, seedDemo.isBlank() ? !store.shared() : Boolean.parseBoolean(seedDemo));
        if (seedDemo.isBlank() ? !store.shared() : Boolean.parseBoolean(seedDemo)) prepareOrderDemoInventory();
    }

    public RemnantService(InventoryStore store, boolean seedDemo) {
        this.kernel = new InventoryStateKernel(store);
        this.rollAndRemnantService = new RollAndRemnantDomainService(kernel);
        this.factoryDocumentService = new FactoryDocumentDomainService(kernel);
        this.taskService = new CuttingTaskDomainService(kernel);
        this.executionAndReportService = new CuttingExecutionAndReportService(kernel, () -> this.measurementToleranceMm);
        if (store.supportsHotColdLoading()) {
            var hot = store.loadHotSnapshot();
            if (hot != null) kernel.restoreHot(hot);
            else if (seedDemo) rollAndRemnantService.seedDefaultDemoData();
        } else {
            InventorySnapshot loaded = store.load();
            if (loaded != null) kernel.restore(loaded);
            else if (seedDemo) rollAndRemnantService.seedDefaultDemoData();
        }
    }

    // ==================== 公开命令与快照契约（保持向后兼容） ====================

    public record InspectionInput(double width, double totalLength, List<Defect> defects) {}

    /** Detached read snapshot: trial nesting never holds the inventory lock or persists a plan. */
    public record RecommendationSnapshot(long revision, List<RemnantStock> stocks) {}

    public record QualityReleaseCommand(String idempotencyKey, String decision, String inspector, String reason) {}

    public record RevokeDispositionCommand(String idempotencyKey, String operator, String reason) {}

    public record InventoryReceiptRollInput(
            String id,
            String materialModel,
            String materialType,
            String color,
            String batchNo,
            double widthMm,
            double totalLengthMm,
            Double grammage,
            Double shrinkageRate,
            String storageLocation,
            String inspectionStatus,
            String inspector
    ) {}

    public record InventoryReceiptCommand(
            String idempotencyKey,
            String supplierName,
            String deliveryNoteNo,
            String operator,
            String remarks,
            String inspector,
            List<InventoryReceiptRollInput> rolls
    ) {
        public InventoryReceiptCommand(
                String idempotencyKey, String supplierName, String deliveryNoteNo,
                String operator, String remarks, List<InventoryReceiptRollInput> rolls
        ) {
            this(idempotencyKey, supplierName, deliveryNoteNo, operator, remarks, null, rolls);
        }
    }

    public record MaterialIssueCommand(
            String idempotencyKey,
            String direction,
            String rollId,
            String machineId,
            String shiftTeam,
            String operator,
            String targetLocation,
            String reason
    ) {}

    public record ScrapRollCommand(String idempotencyKey, String operator, String reason) {}

    public record MotherRollInspectionCommand(String status, String inspector, String remarks) {}

    // ==================== 1. 内核健康、账本、对账与 Outbox ====================

    public List<InventoryEvent> integrationEvents() { return kernel.integrationEvents(); }

    public long outboxCount() {
        return kernel.read(() -> kernel.store.supportsHotColdLoading() ? kernel.outboxSize : kernel.outbox.size());
    }

    public Optional<String> outboxFirstEventId() {
        return kernel.read(() -> kernel.store.supportsHotColdLoading()
                ? (kernel.outboxStreamHeadId != null ? Optional.of(kernel.outboxStreamHeadId) : kernel.store.findOutboxFirstEventId())
                : (kernel.outbox.isEmpty() ? Optional.empty() : Optional.of(kernel.outbox.get(0).id())));
    }

    public Optional<InventoryEvent> outboxBySequence(long sequence) {
        if (sequence < 1) return Optional.empty();
        return kernel.read(() -> {
            if (kernel.store.supportsHotColdLoading()) return kernel.store.findOutboxBySequence(sequence);
            int idx = (int) sequence - 1;
            return idx < kernel.outbox.size() ? Optional.of(kernel.outbox.get(idx)) : Optional.empty();
        });
    }

    public List<InventoryEvent> outboxPage(long after, int limit) {
        return kernel.read(() -> {
            if (kernel.store.supportsHotColdLoading()) return kernel.store.queryOutboxPage(after, limit);
            return kernel.outbox.stream().filter(e -> e.sequence() > after).limit(limit).toList();
        });
    }

    public Map<String, Object> healthStatus() { return kernel.healthStatus(); }

    public Map<String, Object> inventoryLedger(String aggregateType, String aggregateId, long after, int limit) {
        return kernel.inventoryLedger(aggregateType, aggregateId, after, limit);
    }

    public Map<String, Object> reconcileInventory() { return kernel.reconcileInventory(); }

    // ==================== 2. 母卷、验疵、演示数据与料头生命周期 ====================

    public Map<String, Integer> initializeDemoInventory() { return rollAndRemnantService.initializeDemoInventory(); }

    public Map<String, Integer> prepareOrderDemoInventory() { return rollAndRemnantService.prepareOrderDemoInventory(); }

    public boolean resetRoll(String rollId) { return rollAndRemnantService.resetRoll(rollId); }

    /** 兼容旧调用签名；严禁通过 force 绕过报工、盘点、移库、执行单或排程方案追溯保护。 */
    @Deprecated
    public boolean resetRoll(String rollId, boolean ignoredForce) { return rollAndRemnantService.resetRoll(rollId); }

    public List<MotherRollInfo> getMotherRolls() { return rollAndRemnantService.getMotherRolls(); }

    public MotherRollInfo getMotherRoll(String rollId) { return rollAndRemnantService.getMotherRoll(rollId); }

    public MotherRollInfo saveOrUpdateMotherRoll(MotherRollInfo roll) { return rollAndRemnantService.saveOrUpdateMotherRoll(roll); }

    public Defect addDefectToRoll(String rollId, Defect defect) { return rollAndRemnantService.addDefectToRoll(rollId, defect); }

    public MotherRollInfo voidDefect(String rollId, int defectId, String reason) {
        return rollAndRemnantService.voidDefect(rollId, defectId, reason);
    }

    public MotherRollInfo createInspectionRoll(MotherRollInfo input) { return rollAndRemnantService.createInspectionRoll(input); }

    public MotherRollInfo saveInspection(String rollId, InspectionInput input) {
        if (input == null) throw new IllegalArgumentException("母卷尺寸已变化，请重新载入后核对标记");
        return rollAndRemnantService.saveInspection(rollId, input.width(), input.totalLength(), input.defects());
    }

    public Map<String, Object> scrapMotherRoll(String rollId, ScrapRollCommand cmd) {
        if (cmd == null) throw new IllegalArgumentException("请提供母卷报废请求体");
        return rollAndRemnantService.scrapMotherRoll(rollId, cmd.idempotencyKey(), cmd.operator(), cmd.reason());
    }

    public Map<String, Object> completeMotherRollInspection(String rollId, MotherRollInspectionCommand cmd) {
        if (cmd == null) throw new IllegalArgumentException("请提供母卷质检判定请求体");
        return rollAndRemnantService.completeMotherRollInspection(rollId, cmd.status(), cmd.inspector());
    }

    public boolean scrapRemnant(String id, String reason) { return rollAndRemnantService.scrapRemnant(id, reason); }

    public List<RemnantStock> getAvailableRemnants() { return rollAndRemnantService.getAvailableRemnants(); }

    public List<RemnantStock> getRemnantsByRollId(String rollId) { return rollAndRemnantService.getRemnantsByRollId(rollId); }

    public List<RemnantStock> getAllRemnants() { return rollAndRemnantService.getAllRemnants(); }

    public RemnantStock scanOrGetById(String id) { return rollAndRemnantService.scanOrGetById(id); }

    public List<RemnantStock> matchRemnants(String rollId, double pieceW, double pieceL, boolean allowRotation) {
        return rollAndRemnantService.matchRemnants(rollId, pieceW, pieceL, allowRotation);
    }

    public RemnantStock registerRemnant(RemnantStock item) { return rollAndRemnantService.registerRemnant(item); }

    public RemnantStock autoRegisterCutRemnant(String rollId, String parentRemnantId, double w, double l, boolean hasDefect, String desc) {
        return rollAndRemnantService.autoRegisterCutRemnant(rollId, parentRemnantId, w, l, hasDefect, desc);
    }

    public boolean consumeRemnant(String id) { return rollAndRemnantService.consumeRemnant(id); }

    public boolean updateStatus(String id, String status) { return rollAndRemnantService.updateStatus(id, status); }

    // ==================== 3. 工厂单据（移库 / 盘点 / 隔离放行 / 采购入库 / 车间领退料） ====================

    public Map<String, Object> transferOptions() { return factoryDocumentService.transferOptions(); }

    public List<InventoryTransfer> inventoryTransfers() { return factoryDocumentService.inventoryTransfers(); }

    public InventoryTransfer transferInventory(String key, InventoryTransfer.Command command) {
        return factoryDocumentService.transferInventory(key, command);
    }

    public List<InventoryCount> inventoryCounts() { return factoryDocumentService.inventoryCounts(); }

    public Map<String, Object> countOptions() { return factoryDocumentService.countOptions(); }

    public InventoryCount countInventory(String key, InventoryCount.Command command) {
        return factoryDocumentService.countInventory(key, command);
    }

    public List<QualityReleaseDocument> listQualityReleases() { return factoryDocumentService.listQualityReleases(); }

    public Map<String, Object> releaseQuarantinedRemnant(String remnantId, QualityReleaseCommand cmd) {
        if (cmd == null) throw new IllegalArgumentException("请提供质量放行请求体");
        return factoryDocumentService.releaseQuarantinedRemnant(
                remnantId, cmd.idempotencyKey(), cmd.decision(), cmd.inspector(), cmd.reason());
    }

    public List<InventoryReceiptDocument> listInventoryReceipts() { return factoryDocumentService.listInventoryReceipts(); }

    public Map<String, Object> receiveInventoryBatch(InventoryReceiptCommand cmd) {
        if (cmd == null) throw new IllegalArgumentException("采购入库请求不能为空");
        List<FactoryDocumentDomainService.ReceiptRollLineInput> lines = cmd.rolls() == null ? null : cmd.rolls().stream()
                .map(r -> r == null ? null : new FactoryDocumentDomainService.ReceiptRollLineInput(
                        r.id(), r.materialModel(), r.materialType(), r.color(), r.batchNo(),
                        r.widthMm(), r.totalLengthMm(), r.grammage(), r.shrinkageRate(),
                        r.storageLocation(), r.inspectionStatus(), r.inspector()))
                .toList();
        return factoryDocumentService.receiveInventoryBatch(
                cmd.idempotencyKey(), cmd.supplierName(), cmd.deliveryNoteNo(),
                cmd.operator(), cmd.remarks(), cmd.inspector(), lines);
    }

    public List<MaterialIssueDocument> listMaterialIssues() { return factoryDocumentService.listMaterialIssues(); }

    public Map<String, Object> postMaterialIssue(MaterialIssueCommand cmd) {
        if (cmd == null) throw new IllegalArgumentException("车间领退料请求不能为空");
        return factoryDocumentService.postMaterialIssue(
                cmd.idempotencyKey(), cmd.direction(), cmd.rollId(), cmd.machineId(),
                cmd.shiftTeam(), cmd.operator(), cmd.targetLocation(), cmd.reason());
    }

    // ==================== 4. 切割任务、候选材料与推荐快照 ====================

    public List<Defect> materialDefects(SolveRequest request) { return taskService.materialDefects(request); }

    public String materialFingerprint(SolveRequest request) { return taskService.materialFingerprint(request); }

    public CuttingTask getTask(String id) { return taskService.getTask(id); }

    public List<CuttingTask> listTasks() { return taskService.listTasks(); }

    public List<Map<String, Object>> taskSummaries() { return taskService.taskSummaries(); }

    public Map<String, Object> taskDetail(String id) {
        return kernel.read(() -> taskService.buildTaskDetail(id, executionAndReportService.executionOrdersInternal(id)));
    }

    public CuttingTask saveTask(CuttingTask input) { return taskService.saveTask(input); }

    public void prepareTaskSolve(SolveRequest request) { taskService.prepareTaskSolve(request); }

    public List<Map<String, Object>> materialCandidates(SolveRequest request) { return taskService.materialCandidates(request); }

    public RecommendationSnapshot recommendationSnapshot(SolveRequest request, Map<String, Integer> completedBaseline) {
        var detached = taskService.recommendationSnapshot(request, completedBaseline);
        return new RecommendationSnapshot(detached.revision(), detached.stocks());
    }

    public void verifyRecommendationRevision(long expected) { taskService.verifyRecommendationRevision(expected); }

    // ==================== 5. 执行单、计划、报工、冲销、复检与对账 ====================

    public ExecutionOrder createExecution(String key, ExecutionOrder.Create input) {
        return executionAndReportService.createExecution(key, input);
    }

    public List<Map<String, Object>> executionOrders(String taskId) { return executionAndReportService.executionOrders(taskId); }

    public Map<String, Object> executionOrder(String id) { return executionAndReportService.executionOrder(id); }

    public ExecutionOrder changeExecution(String id, String action, ExecutionOrder.Command command) {
        return executionAndReportService.changeExecution(id, action, command);
    }

    public Map<String, Object> reportExecution(String id, CutReport report) {
        return executionAndReportService.reportExecution(id, report);
    }

    public void rememberPlan(CuttingPlan plan) { executionAndReportService.rememberPlan(plan); }

    public CuttingPlan getPlan(String id) { return executionAndReportService.getPlan(id); }

    public CuttingPlan rememberAdjustment(String parentId, String id, SolveResponse result) {
        return executionAndReportService.rememberAdjustment(parentId, id, result);
    }

    public List<CuttingPlan> taskPlans(String taskId) { return executionAndReportService.taskPlans(taskId); }

    public List<CuttingPlan> taskPlans(String taskId, boolean summary) { return executionAndReportService.taskPlans(taskId, summary); }

    public Map<String, String> planChecks(String taskId) { return executionAndReportService.planChecks(taskId); }

    public CuttingPlan changePlanStatus(String id, boolean restore) { return executionAndReportService.changePlanStatus(id, restore); }

    public Map<String, Object> planDetail(String id) { return executionAndReportService.planDetail(id); }

    public Map<String, Object> confirmPlan(CutReport report) { return executionAndReportService.confirmPlan(report); }

    public Map<String, Object> confirm(SolveRequest request, SolveResponse plan, CutReport report) {
        return executionAndReportService.confirm(request, plan, report);
    }

    public Map<String, Object> confirm(SolveRequest request, SolveResponse plan, CutReport report, String baseline) {
        return executionAndReportService.confirm(request, plan, report, baseline);
    }

    public Map<String, Object> getReceipt(String planId) { return executionAndReportService.getReceipt(planId); }

    public Map<String, Object> qualityReview(String planId) { return executionAndReportService.qualityReview(planId); }

    public QualityDisposition disposeQuality(String planId, QualityDisposition.Command command) {
        return executionAndReportService.disposeQuality(planId, command);
    }

    public Map<String, Object> revokeQualityDisposition(String reportId, String dispositionId, RevokeDispositionCommand cmd) {
        if (cmd == null) throw new IllegalArgumentException("请提供撤销请求体");
        return executionAndReportService.revokeQualityDisposition(
                reportId, dispositionId, cmd.idempotencyKey(), cmd.operator(), cmd.reason());
    }

    public List<Map<String, Object>> reportBatch(List<CutReport> reports, boolean preview) {
        return executionAndReportService.reportBatch(reports, preview);
    }

    public Map<String, Object> reverseReport(String planId, String reason) {
        return executionAndReportService.reverseReport(planId, reason);
    }

    public List<Map<String, Object>> taskReports(String taskId) { return executionAndReportService.taskReports(taskId); }

    public Map<String, Integer> completedQuantities(String taskId) { return executionAndReportService.completedQuantities(taskId); }

    public Map<String, Object> reconciliationReports(int limit, int offset, String statusFilter, String taskIdFilter) {
        return executionAndReportService.reconciliationReports(limit, offset, statusFilter, taskIdFilter);
    }

    // ==================== 6. 受控 CuttingStatePort 实现 ====================

    @Override
    public <T> T inRead(Function<CuttingStatePort.ReadView, T> query) {
        return kernel.read(() -> {
            TxContext tx = new TxContext(false);
            try {
                return query.apply(tx);
            } finally {
                tx.close();
            }
        });
    }

    @Override
    public <T> T inWrite(String eventType, String businessId, String actor, Function<CuttingStatePort.WriteTx, T> command) {
        return kernel.mutate(eventType, businessId, actor, () -> {
            TxContext tx = new TxContext(true);
            try {
                return command.apply(tx);
            } finally {
                tx.close();
            }
        });
    }

    @Override
    public <T> T inWrite(
            String eventType,
            String businessId,
            String actor,
            Function<CuttingStatePort.ReadView, T> replay,
            Function<CuttingStatePort.WriteTx, T> command
    ) {
        return kernel.mutate(eventType, businessId, actor, () -> {
            TxContext readTx = new TxContext(false);
            try {
                return replay.apply(readTx);
            } finally {
                readTx.close();
            }
        }, () -> {
            TxContext tx = new TxContext(true);
            try {
                return command.apply(tx);
            } finally {
                tx.close();
            }
        });
    }

    @Override
    public List<DemandTemplate> listTemplatesIndependent() {
        return kernel.listTemplatesIndependent();
    }

    @Override
    public DemandTemplate saveTemplateIndependent(DemandTemplate template) {
        return kernel.saveTemplateIndependent(template);
    }

    @Override
    public boolean deleteTemplateIndependent(String id) {
        return kernel.deleteTemplateIndependent(id);
    }

    private final class TxContext implements CuttingStatePort.WriteTx {
        private final boolean writable;
        private boolean active = true;

        private TxContext(boolean writable) {
            this.writable = writable;
        }

        private void close() {
            this.active = false;
        }

        private void ensureActive() {
            if (!active) throw new IllegalStateException("事务上下文已关闭，禁止在事务外访问状态");
        }

        private void ensureWritable() {
            ensureActive();
            if (!writable) throw new IllegalStateException("只读事务上下文禁止写入操作");
        }

        @Override public long operationTime() { ensureActive(); return kernel.currentOperationTime(); }

        @Override public long currentRevision() { ensureActive(); return kernel.revision; }

        @Override
        public List<DemandTemplate> listTemplates() {
            ensureActive();
            if (kernel.store.supportsIndependentTemplates()) {
                return List.copyOf(kernel.store.loadTemplates());
            }
            return List.copyOf(kernel.templates.values());
        }

        @Override public List<SchedulingScheme> listSchemes() {
            ensureActive();
            if (kernel.store.supportsHotColdLoading() && !writable) {
                return kernel.store.listAllSchemes();
            }
            return List.copyOf(kernel.schemes.values());
        }

        @Override
        public Optional<SchedulingScheme> findScheme(String id) {
            ensureActive();
            return Optional.ofNullable(kernel.findOrLoadScheme(id));
        }

        @Override
        public Optional<SchedulingScheme> findSchemeByIdempotencyKey(String idempotencyKey) {
            ensureActive();
            if (idempotencyKey == null) return Optional.empty();
            for (SchedulingScheme existing : kernel.schemes.values()) {
                if (idempotencyKey.equals(existing.idempotencyKey())) return Optional.of(existing);
            }
            return kernel.store.supportsHotColdLoading()
                    ? kernel.store.findSchemeByIdempotencyKey(idempotencyKey)
                    : Optional.empty();
        }

        @Override
        public Optional<SchedulingScheme> findSchemeByMesReceiptNo(String mesReceiptNo) {
            ensureActive();
            if (mesReceiptNo == null || mesReceiptNo.isBlank()) return Optional.empty();
            String target = mesReceiptNo.trim();
            for (SchedulingScheme existing : kernel.schemes.values()) {
                if (target.equals(existing.mesReceiptNo())) return Optional.of(existing);
            }
            return kernel.store.supportsHotColdLoading()
                    ? kernel.store.findSchemeByMesReceiptNo(target)
                    : Optional.empty();
        }

        @Override public List<CuttingTask> listTasks() { ensureActive(); return List.copyOf(kernel.tasks.values()); }

        @Override
        public Optional<CuttingTask> findTask(String id) {
            ensureActive();
            return Optional.ofNullable(kernel.findOrLoadTask(id));
        }

        @Override
        public Optional<CuttingTask> findTaskByExternalRef(String externalRef) {
            ensureActive();
            if (externalRef == null) return Optional.empty();
            Optional<CuttingTask> hot = kernel.tasks.values().stream().filter(t -> externalRef.equals(t.externalRef())).findFirst();
            if (hot.isPresent() || !kernel.store.supportsHotColdLoading()) return hot;
            return kernel.store.findTaskByExternalRef(externalRef).map(e -> e.value());
        }

        @Override
        public Optional<CuttingTask> findTaskByReplenishIdempotencyKey(String idempotencyKey) {
            ensureActive();
            if (idempotencyKey == null || idempotencyKey.isBlank()) return Optional.empty();
            String clean = idempotencyKey.trim();
            Optional<CuttingTask> hot = kernel.tasks.values().stream().filter(t -> clean.equals(t.replenishIdempotencyKey())).findFirst();
            if (hot.isPresent() || !kernel.store.supportsHotColdLoading()) return hot;
            return kernel.store.findTaskByReplenishKey(clean).map(e -> e.value());
        }

        @Override
        public void validateBatchAndColorForTask(CuttingTask task, MotherRollInfo roll, RemnantStock remnant) {
            ensureActive();
            kernel.validateBatchAndColorInternal(task, roll, remnant);
        }

        @Override public List<CuttingPlan> listPlans() { ensureActive(); return List.copyOf(kernel.plans.values()); }

        @Override
        public Optional<CuttingPlan> findPlan(String id) {
            ensureActive();
            return Optional.ofNullable(kernel.findOrLoadPlan(id));
        }

        @Override public List<ExecutionOrder> listExecutions() { ensureActive(); return List.copyOf(kernel.executions.values()); }

        @Override
        public Optional<MotherRollInfo> findRoll(String id) {
            ensureActive();
            return Optional.ofNullable(kernel.findOrLoadRoll(id));
        }

        @Override
        public Optional<RemnantStock> findRemnant(String id) {
            ensureActive();
            return Optional.ofNullable(kernel.findOrLoadRemnant(id));
        }

        @Override
        public List<RemnantStock> listRemnantsBySourceRoll(String rollId) {
            ensureActive();
            if (rollId == null) return List.of();
            if (kernel.store.supportsHotColdLoading()) return kernel.store.listRemnantsBySourceRoll(rollId);
            return kernel.remnantPool.values().stream()
                    .filter(rm -> rollId.equalsIgnoreCase(rm.getSourceRollId()))
                    .toList();
        }

        @Override
        public Optional<Map<String, Object>> findReceipt(String planId) {
            ensureActive();
            return Optional.ofNullable(kernel.findOrLoadReceipt(planId));
        }

        @Override public List<Map<String, Object>> listReceipts() { ensureActive(); return List.copyOf(kernel.receipts.values()); }

        @Override
        public List<Map<String, Object>> findCutReportsByRollId(String rollId) {
            ensureActive();
            if (rollId == null) return List.of();
            if (kernel.store.supportsHotColdLoading()) return kernel.store.findCutReportsByRollId(rollId);
            return kernel.receipts.values().stream()
                    .filter(r -> rollId.equals(r.get("rollId")))
                    .toList();
        }

        @Override
        public void streamActiveCutReports(int batchSize, java.util.function.Consumer<List<Map<String, Object>>> consumer) {
            ensureActive();
            if (kernel.store.supportsHotColdLoading()) {
                kernel.store.streamActiveCutReports(batchSize, consumer);
                return;
            }
            consumer.accept(List.copyOf(kernel.receipts.values()));
        }

        @Override public Map<String, Integer> completedQuantities(String taskId) { ensureActive(); return kernel.completedQuantitiesInternal(taskId); }

        @Override public Map<String, Object> projectQuality(Map<String, Object> receipt) { ensureActive(); return kernel.qualityProjection(receipt); }

        @Override
        public boolean isMaterialReservedByExecution(String materialType, String materialId, String exceptPlanId) {
            ensureActive();
            return kernel.isMaterialReservedByExecution(materialType, materialId, exceptPlanId);
        }

        @Override
        public void putTemplate(DemandTemplate template) {
            ensureWritable();
            if (template == null || template.id() == null || template.id().isBlank()) {
                throw new IllegalArgumentException("需求模板及其编号不能为空");
            }
            kernel.templates.put(template.id(), template);
        }

        @Override
        public boolean removeTemplate(String id) {
            ensureWritable();
            if (id == null || id.isBlank()) return false;
            return kernel.templates.remove(id.trim()) != null;
        }

        @Override
        public void putScheme(SchedulingScheme scheme) {
            ensureWritable();
            if (scheme == null || scheme.id() == null || scheme.id().isBlank()) {
                throw new IllegalArgumentException("排程方案及其编号不能为空");
            }
            kernel.schemes.put(scheme.id(), scheme);
        }

        @Override
        public CuttingTask saveTask(CuttingTask input) {
            ensureWritable();
            return taskService.saveTaskInternal(input, null);
        }

        @Override
        public CuttingTask saveTaskForScheme(CuttingTask input, String exceptSchemeId) {
            ensureWritable();
            return taskService.saveTaskInternal(input, exceptSchemeId);
        }

        @Override
        public MotherRollInfo saveRoll(MotherRollInfo roll) {
            ensureWritable();
            return rollAndRemnantService.saveOrUpdateMotherRollInternal(roll);
        }

        @Override
        public void prepareTaskSolve(SolveRequest request) {
            ensureWritable();
            kernel.prepareTaskSolveInternal(request);
        }

        @Override
        public String savePendingPlan(SolveRequest request, SolveResponse validated) {
            ensureWritable();
            String planId = UUID.randomUUID().toString();
            validated.setPlanId(planId);
            String baseline = kernel.materialFingerprintInternal(request);
            CuttingPlan plan = new CuttingPlan(planId, request, validated, baseline, "PENDING", LocalDateTime.now().toString());
            kernel.plans.put(planId, kernel.json.readValue(kernel.json.writeValueAsBytes(plan), CuttingPlan.class));
            return planId;
        }

        @Override
        public void cancelPendingPlan(String planId) {
            ensureWritable();
            Map<String, Object> receipt = kernel.receipts.get(planId);
            if (receipt != null && !"REVERSED".equals(receipt.get("status"))) {
                throw new InventoryConflictException("方案包含已实切报工记录，无法直接作废");
            }
            CuttingPlan plan = kernel.plans.get(planId);
            if (plan != null && "PENDING".equals(plan.status())) {
                kernel.plans.put(planId, plan.withStatus("CANCELLED"));
            }
        }

        @Override
        public Map<String, Object> confirmPlan(CutReport report, Set<String> pendingBatchPlans) {
            ensureWritable();
            return executionAndReportService.confirmPlanInternal(report, pendingBatchPlans, null, null);
        }

        @Override
        public Map<String, Object> confirmPlan(
                CutReport report,
                Set<String> pendingBatchPlans,
                Map<String, Map<String, Integer>> taskDemandQuantities,
                Map<Integer, SchedulingScheme.TaskDemandAllocation> pieceSources
        ) {
            ensureWritable();
            return executionAndReportService.confirmPlanInternal(report, pendingBatchPlans, taskDemandQuantities, pieceSources);
        }
    }
}
