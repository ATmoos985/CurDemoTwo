package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.algorithm.api.NestingSolver;
import com.example.cutdemotwo.algorithm.api.ToolpathOptimizer;
import com.example.cutdemotwo.business.model.DemandTemplate;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;

/**
 * 统一搭切排程领域服务：
 * 串联「需求模板库 → 多维待排需求池（含跨任务多族合排）→ 搭切方案冻结落库 → 实卷绑定 / 一键完工过账 / 冲销联动 / 母卷空间图 / MES 单事务协同 / 无副作用手调校验」。
 * 通过 {@link CuttingStatePort} 与底层库存事务引擎解耦，并将模板/需求池、物理物化、空间剖面查询、方案视图、确认落库、生命周期管理与 MES 协同委托给单向内聚协作者。
 */
@Service
public class SchedulingStudioService {
    private final CuttingStatePort statePort;
    private final StudioDemandPoolService demandPoolService;
    private final StudioMaterializer materializer;
    private final MotherRollSpatialMapQuery spatialMapQuery;
    private final StudioSchemeViewSupport viewSupport;
    private final StudioSchemeConfirmSupport confirmSupport;
    private final StudioSchemeLifecycleSupport lifecycleSupport;
    private final StudioMesSyncSupport mesSyncSupport;

    public SchedulingStudioService(RemnantService inventory, NestingSolver solverFactory) {
        this((CuttingStatePort) inventory, solverFactory, null);
    }

    @Autowired
    public SchedulingStudioService(
            RemnantService inventory,
            NestingSolver solverFactory,
            @Autowired(required = false) ToolpathOptimizer toolpathOptimizer
    ) {
        this((CuttingStatePort) inventory, solverFactory, toolpathOptimizer);
    }

    SchedulingStudioService(CuttingStatePort statePort, NestingSolver solverFactory) {
        this(statePort, solverFactory, null);
    }

    SchedulingStudioService(CuttingStatePort statePort, NestingSolver solverFactory, ToolpathOptimizer toolpathOptimizer) {
        this.statePort = statePort;
        this.demandPoolService = new StudioDemandPoolService(statePort);
        this.materializer = new StudioMaterializer(solverFactory, toolpathOptimizer);
        this.spatialMapQuery = new MotherRollSpatialMapQuery(statePort);
        this.viewSupport = new StudioSchemeViewSupport(statePort, demandPoolService);
        this.confirmSupport = new StudioSchemeConfirmSupport(statePort, demandPoolService, materializer, viewSupport);
        this.lifecycleSupport = new StudioSchemeLifecycleSupport(statePort, demandPoolService, materializer, viewSupport);
        this.mesSyncSupport = new StudioMesSyncSupport(statePort, demandPoolService, viewSupport, lifecycleSupport);
    }

    // ==================== 1. 需求模板库 (Demand Templates) ====================

    public List<DemandTemplate> listTemplates() {
        return demandPoolService.listTemplates();
    }

    public DemandTemplate saveTemplate(DemandTemplate input) {
        return demandPoolService.saveTemplate(input);
    }

    public Map<String, Object> deleteTemplate(String id) {
        return demandPoolService.deleteTemplate(id);
    }

    // ==================== 2. 多维待排需求池 (Demand Pool & Families) ====================

    public record SaveDemandFamilyCommand(
            String id,
            String mergeIntoTaskId,
            String name,
            String materialModel,
            String externalRef,
            String dimension,
            Double bedLengthMm,
            Double trimStartMm,
            Double pieceGapMm,
            Integer leftTrimMm,
            Integer rightTrimMm,
            Integer minWidthMm,
            Integer maxWidthMm,
            Integer widthStepMm,
            Integer totalOverCap,
            List<DemandLineInput> demands,
            String dueDate,
            String priority,
            String customerName,
            String kittingGroup,
            String requiredBatchNo,
            String requiredColor,
            Boolean strictBatchMatch,
            String machineId,
            String shiftTeam
    ) implements StudioCommandContracts.SaveDemandFamilyInput {
        public SaveDemandFamilyCommand(
                String id, String mergeIntoTaskId, String name, String materialModel, String externalRef,
                String dimension, Double bedLengthMm, Double trimStartMm, Double pieceGapMm,
                Integer leftTrimMm, Integer rightTrimMm, Integer minWidthMm, Integer maxWidthMm,
                Integer widthStepMm, Integer totalOverCap, List<DemandLineInput> demands
        ) {
            this(id, mergeIntoTaskId, name, materialModel, externalRef, dimension, bedLengthMm, trimStartMm,
                    pieceGapMm, leftTrimMm, rightTrimMm, minWidthMm, maxWidthMm, widthStepMm, totalOverCap, demands,
                    null, null, null, null, null, null, null, null, null);
        }
    }

    public record DemandLineInput(
            Integer id,
            String name,
            double width,
            double length,
            int quantity,
            Boolean allowRotation,
            Boolean allowHalfTurn,
            String sizeLabel,
            String sourceTemplateId,
            String surfaceTreatment,
            NestingProblem.Shape shape,
            String sourceTaskId,
            Integer sourceLineId
    ) implements StudioCommandContracts.DemandLineView {
        public DemandLineInput(
                Integer id, String name, double width, double length, int quantity,
                Boolean allowRotation, Boolean allowHalfTurn, String sizeLabel,
                String sourceTemplateId, String surfaceTreatment, NestingProblem.Shape shape
        ) {
            this(id, name, width, length, quantity, allowRotation, allowHalfTurn, sizeLabel,
                    sourceTemplateId, surfaceTreatment, shape, null, null);
        }
    }

    public List<Map<String, Object>> listDemandPool() {
        return demandPoolService.listDemandPool();
    }

    public Map<String, Object> getDemandFamily(String taskId) {
        return demandPoolService.getDemandFamily(taskId);
    }

    public Map<String, Object> saveOrMergeDemandFamily(SaveDemandFamilyCommand cmd) {
        return demandPoolService.saveOrMergeDemandFamily(cmd);
    }

    // ==================== 3. 搭切后选定方案、绑实卷、完工过账、回滚与手调校验 ====================

    public record ConfirmSchemeCommand(
            String idempotencyKey,
            String title,
            String dimension,
            String scenarioId,
            String strategyId,
            String strategyName,
            String taskId,
            String taskName,
            String externalOrderNo,
            String materialMode,
            String rollId,
            String remnantId,
            String materialModel,
            double widthMm,
            double canvasLengthMm,
            Double windowStartY,
            double occupiedLengthMm,
            double trimStartMm,
            double pieceGapMm,
            double utilizationPct,
            double pieceAreaM2,
            Boolean avoidDefects,
            List<DemandLineInput> demands,
            SchedulingScheme.Layout2DPayload layout2D,
            SchedulingScheme.Slitting1DPayload slitting1D,
            List<SchedulingScheme.TaskDemandAllocation> sourceAllocations,
            String draftId
    ) implements StudioCommandContracts.ConfirmSchemeInput {
        public ConfirmSchemeCommand(
                String idempotencyKey, String title, String dimension, String scenarioId,
                String strategyId, String strategyName, String taskId, String taskName,
                String externalOrderNo, String materialMode, String rollId, String remnantId,
                String materialModel, double widthMm, double canvasLengthMm, Double windowStartY,
                double occupiedLengthMm, double trimStartMm, double pieceGapMm,
                double utilizationPct, double pieceAreaM2, Boolean avoidDefects,
                List<DemandLineInput> demands, SchedulingScheme.Layout2DPayload layout2D,
                SchedulingScheme.Slitting1DPayload slitting1D,
                List<SchedulingScheme.TaskDemandAllocation> sourceAllocations
        ) {
            this(idempotencyKey, title, dimension, scenarioId, strategyId, strategyName, taskId, taskName,
                    externalOrderNo, materialMode, rollId, remnantId, materialModel, widthMm, canvasLengthMm,
                    windowStartY, occupiedLengthMm, trimStartMm, pieceGapMm, utilizationPct, pieceAreaM2,
                    avoidDefects, demands, layout2D, slitting1D, sourceAllocations, null);
        }

        public ConfirmSchemeCommand(
                String idempotencyKey, String title, String dimension, String scenarioId,
                String strategyId, String strategyName, String taskId, String taskName,
                String externalOrderNo, String materialMode, String rollId, String remnantId,
                String materialModel, double widthMm, double canvasLengthMm, Double windowStartY,
                double occupiedLengthMm, double trimStartMm, double pieceGapMm,
                double utilizationPct, double pieceAreaM2, Boolean avoidDefects,
                List<DemandLineInput> demands, SchedulingScheme.Layout2DPayload layout2D,
                SchedulingScheme.Slitting1DPayload slitting1D
        ) {
            this(idempotencyKey, title, dimension, scenarioId, strategyId, strategyName, taskId, taskName,
                    externalOrderNo, materialMode, rollId, remnantId, materialModel, widthMm, canvasLengthMm,
                    windowStartY, occupiedLengthMm, trimStartMm, pieceGapMm, utilizationPct, pieceAreaM2,
                    avoidDefects, demands, layout2D, slitting1D, null, null);
        }
    }

    public record BindRollCommand(
            String rollId,
            Boolean autoCreateRoll,
            Double newRollLengthMm,
            String storageLocation,
            Double windowStartY,
            String inspectionStatus,
            String inspector
    ) implements StudioCommandContracts.BindRollInput {
        public BindRollCommand(
                String rollId, Boolean autoCreateRoll, Double newRollLengthMm,
                String storageLocation, Double windowStartY
        ) {
            this(rollId, autoCreateRoll, newRollLengthMm, storageLocation, windowStartY, null, null);
        }
    }

    public record CompleteSchemeCommand(
            Double actualCutLenMm,
            List<Integer> rejectedPieceIds,
            Boolean recoverRemnants,
            String remnantLocation,
            String operator
    ) implements StudioCommandContracts.CompleteSchemeInput {}

    /** 无副作用手调几何校验与刀路重建请求。 */
    public record ValidateLayoutRequest(
            double materialWidthMm,
            double materialLengthMm,
            double trimStartMm,
            double pieceGapMm,
            Boolean avoidDefects,
            String rollId,
            String remnantId,
            Double windowStartY,
            List<Defect> defects,
            List<SchedulingScheme.PlacementItem> placements,
            List<DemandLineInput> demands
    ) implements StudioCommandContracts.ValidateLayoutInput {}

    /**
     * 纯计算只读手调几何校验与刀路/余料重建（绝不修改库存或递增 revision）。
     */
    public Map<String, Object> validateManualLayout(ValidateLayoutRequest req) {
        return statePort.inRead(tx -> materializer.validateManualLayout(tx, req));
    }

    public record ReplenishTaskCommand(String idempotencyKey, String operator, String reason)
            implements StudioCommandContracts.ReplenishTaskInput {}

    public List<Map<String, Object>> listSchemes(String stateFilter, String taskIdFilter) {
        return listSchemes(stateFilter, taskIdFilter, false);
    }

    public List<Map<String, Object>> listSchemes(String stateFilter, String taskIdFilter, boolean summary) {
        return viewSupport.listSchemes(stateFilter, taskIdFilter, summary);
    }

    public Map<String, Object> getSchemeDetail(String id) {
        return viewSupport.getSchemeDetail(id);
    }

    public Map<String, Object> confirmScheme(ConfirmSchemeCommand cmd) {
        return confirmSupport.confirmScheme(cmd);
    }

    public Map<String, Object> bindRollToScheme(String schemeId, BindRollCommand cmd) {
        return lifecycleSupport.bindRollToScheme(schemeId, cmd);
    }

    public Map<String, Object> completeScheme(String schemeId, CompleteSchemeCommand cmd) {
        return lifecycleSupport.completeScheme(schemeId, cmd);
    }

    public Map<String, Object> createReplenishTaskFromScheme(String schemeId, ReplenishTaskCommand cmd) {
        return lifecycleSupport.createReplenishTaskFromScheme(schemeId, cmd);
    }

    public Map<String, Object> cancelScheme(String schemeId, String reason) {
        return lifecycleSupport.cancelScheme(schemeId, reason);
    }

    // ==================== 4. 母卷切割与疵点空间剖面图 (Mother Roll Spatial Map) ====================

    public Map<String, Object> getMotherRollSpatialMap(String rollId) {
        return spatialMapQuery.getMotherRollSpatialMap(rollId);
    }

    // ==================== 5. MES 协同接口 (原子单事务 Orders / Dispatch / Feedback) ====================

    public record MesOrderSyncCommand(
            String mesWorkOrderNo,
            String name,
            String materialModel,
            String dimension,
            Double widthMm,
            List<DemandLineInput> demands
    ) implements StudioCommandContracts.MesOrderSyncInput {}

    public record MesFeedbackCommand(
            String schemeId,
            String mesReceiptNo,
            String scannedRollId,
            Double actualCutLenMm,
            List<Integer> rejectedPieceIds,
            Boolean recoverRemnants,
            String remnantLocation
    ) implements StudioCommandContracts.MesFeedbackInput {}

    public Map<String, Object> syncMesOrder(MesOrderSyncCommand cmd) {
        return mesSyncSupport.syncMesOrder(cmd);
    }

    public Map<String, Object> dispatchSchemeToMes(String schemeId, String mesWorkOrderNo) {
        return mesSyncSupport.dispatchSchemeToMes(schemeId, mesWorkOrderNo);
    }

    public Map<String, Object> getMesDispatchPackage(String schemeId) {
        return mesSyncSupport.getMesDispatchPackage(schemeId);
    }

    public Map<String, Object> receiveMesFeedback(MesFeedbackCommand cmd) {
        return mesSyncSupport.receiveMesFeedback(cmd);
    }
}
