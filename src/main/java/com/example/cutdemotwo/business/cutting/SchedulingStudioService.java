package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.algorithm.api.NestingSolver;
import com.example.cutdemotwo.algorithm.api.ToolpathOptimizer;
import com.example.cutdemotwo.business.model.CutReport;
import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.DemandTemplate;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.QualityDisposition;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.contracts.geometry.RemnantPiece;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.persistence.InventoryConflictException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;

/**
 * 统一搭切排程领域服务：
 * 串联「需求模板库 → 多维待排需求池（含跨任务多族合排）→ 搭切方案冻结落库 → 实卷绑定 / 一键完工过账 / 冲销联动 / 母卷空间图 / MES 单事务协同 / 无副作用手调校验」。
 * 通过 {@link CuttingStatePort} 与底层库存事务引擎解耦，并将模板/需求池、物理物化与空间剖面查询委托给内聚协作者。
 */
@Service
public class SchedulingStudioService {
    private static final DateTimeFormatter TS_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private final CuttingStatePort statePort;
    private final StudioDemandPoolService demandPoolService;
    private final StudioMaterializer materializer;
    private final MotherRollSpatialMapQuery spatialMapQuery;

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
    ) {
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
    ) {
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
    ) {}

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

    public record ReplenishTaskCommand(String idempotencyKey, String operator, String reason) {}

    public List<Map<String, Object>> listSchemes(String stateFilter, String taskIdFilter) {
        return listSchemes(stateFilter, taskIdFilter, false);
    }

    public List<Map<String, Object>> listSchemes(String stateFilter, String taskIdFilter, boolean summary) {
        return statePort.inRead(tx -> {
            List<SchedulingScheme> list = new ArrayList<>(tx.listSchemes());
            Collections.reverse(list);
            List<Map<String, Object>> out = new ArrayList<>();
            for (SchedulingScheme s : list) {
                if (stateFilter != null && !stateFilter.isBlank() && !"ALL".equalsIgnoreCase(stateFilter)
                        && !stateFilter.equalsIgnoreCase(s.state())) {
                    continue;
                }
                if (taskIdFilter != null && !taskIdFilter.isBlank() && !s.involvesTask(taskIdFilter)) {
                    continue;
                }
                out.add(enrichSchemeView(tx, summary ? summarizeScheme(s) : s));
            }
            return out;
        });
    }

    private static SchedulingScheme summarizeScheme(SchedulingScheme s) {
        if (s.layout2D() == null) return s;
        return new SchedulingScheme(
                s.id(), s.idempotencyKey(), s.title(), s.dimension(), s.scenarioId(), s.strategyId(), s.strategyName(),
                s.taskId(), s.taskName(), s.externalOrderNo(), s.materialMode(), s.rollId(), s.remnantId(),
                s.materialModel(), s.widthMm(), s.canvasLengthMm(), s.windowStartY(), s.occupiedLengthMm(),
                s.trimStartMm(), s.pieceGapMm(), s.utilizationPct(), s.pieceAreaM2(), s.placedCount(),
                s.requestedCount(), s.gapFillCount(), s.complete(), s.allocatedDemands(), s.linkedPlanIds(),
                s.linkedExecutionId(), s.state(), s.suggestedRoll(), null, s.slitting1D(), s.mesWorkOrderNo(),
                s.createdAt(), s.dispatchedAt(), s.completedAt(), s.cancelledAt(), s.cancelReason(),
                s.sourceAllocations(), s.mesReceiptNo()
        );
    }

    public Map<String, Object> getSchemeDetail(String id) {
        return statePort.inRead(tx -> {
            SchedulingScheme s = tx.findScheme(id)
                    .orElseThrow(() -> new IllegalArgumentException("排程方案不存在: " + id));
            return enrichSchemeView(tx, s);
        });
    }

    public Map<String, Object> confirmScheme(ConfirmSchemeCommand cmd) {
        if (cmd == null) throw new IllegalArgumentException("方案确认请求不能为空");
        String idemKey = (cmd.idempotencyKey() == null || cmd.idempotencyKey().isBlank())
                ? "SCH-KEY-" + UUID.randomUUID()
                : cmd.idempotencyKey().trim();

        return statePort.inWrite(
                "DEMAND_ADJUSTMENT",
                idemKey,
                "UNAUTHENTICATED_LOCAL",
                tx -> tx.findSchemeByIdempotencyKey(idemKey).map(existing -> enrichWithDemandFamilies(tx, existing)).orElse(null),
                tx -> confirmSchemeInTx(tx, cmd, idemKey)
        );
    }

    private Map<String, Object> confirmSchemeInTx(CuttingStatePort.WriteTx tx, ConfirmSchemeCommand cmd, String idemKey) {
        String dim = StudioDemandPoolService.normalizeDimension(cmd.dimension(), null);
        boolean isSlit = "SLITTING_1D".equals(dim);
        if (!isSlit && (cmd.layout2D() == null || cmd.layout2D().placements().isEmpty())) {
            throw new IllegalArgumentException("二维方案缺少已排入的裁片位置明细");
        }
        if (isSlit && (cmd.slitting1D() == null || cmd.slitting1D().patterns().isEmpty())) {
            throw new IllegalArgumentException("一维分切方案缺少分切组合明细");
        }

        String mode = (cmd.materialMode() == null || cmd.materialMode().isBlank())
                ? "VIRTUAL_ROLL"
                : cmd.materialMode().trim().toUpperCase();
        if ("FREE_CANVAS".equals(mode)) mode = "VIRTUAL_ROLL";
        if (!Set.of("VIRTUAL_ROLL", "STOCK_ROLL", "REMNANT").contains(mode)) {
            throw new IllegalArgumentException("投料模式仅支持 VIRTUAL_ROLL、STOCK_ROLL 或 REMNANT");
        }

        String effectiveMaterialModel = resolveSchemeMaterialModel(tx, cmd, mode);
        boolean hasExplicitSourceAllocations = cmd.sourceAllocations() != null && !cmd.sourceAllocations().isEmpty();

        CuttingTask primaryTask;
        Map<String, CuttingTask> sourceTasks = new LinkedHashMap<>();
        List<SchedulingScheme.TaskDemandAllocation> normalizedSourceAllocs = List.of();
        Map<String, Integer> allocated = new LinkedHashMap<>();
        SchedulingScheme.Layout2DPayload effectiveLayout2D = cmd.layout2D();
        boolean multiTask = false;
        int placedCount = 0;
        int gapFillCount = 0;
        int requestedCount = 0;
        boolean isComplete;

        if (hasExplicitSourceAllocations) {
            // 跨任务/显式多族合排：原子校验每个原任务 openQty，绝不创建孤立重复 CuttingTask
            normalizedSourceAllocs = normalizeAndValidateSourceAllocations(tx, cmd.sourceAllocations(), dim, sourceTasks);
            multiTask = sourceTasks.size() > 1;
            primaryTask = sourceTasks.values().iterator().next();

            if (!multiTask && ("STOCK_ROLL".equals(mode) || "REMNANT".equals(mode))
                    && !Objects.equals(primaryTask.materialModel(), effectiveMaterialModel)
                    && tx.completedQuantities(primaryTask.id()).isEmpty()) {
                CuttingTask aligned = primaryTask.withMaterialModel(effectiveMaterialModel);
                primaryTask = tx.saveTaskForScheme(aligned, null);
                sourceTasks.put(primaryTask.id(), primaryTask);
            }

            for (CuttingTask t : sourceTasks.values()) {
                requestedCount += t.demands().stream().mapToInt(CuttingTask.Line::quantity).sum();
            }

            if (!isSlit) {
                boolean isContour = "CONTOUR_2D".equals(dim)
                        || cmd.layout2D().placements().stream().anyMatch(p -> p.shape() != null
                        && ("POLYGON".equals(p.shape().type()) || p.shape().hasHoles()));
                effectiveLayout2D = bindPlacementsToSourceAllocations(cmd.layout2D(), cmd.demands(), normalizedSourceAllocs, sourceTasks, isContour);
                for (SchedulingScheme.PlacementItem p : effectiveLayout2D.placements()) {
                    placedCount++;
                    if (Boolean.TRUE.equals(p.gapFill())) gapFillCount++;
                }
                if (!multiTask && gapFillCount > 0 && tx.completedQuantities(primaryTask.id()).isEmpty()) {
                    primaryTask = materializer.appendGapFillLinesIfNeeded(tx, primaryTask, effectiveLayout2D, null);
                    sourceTasks.put(primaryTask.id(), primaryTask);
                }
            } else {
                SchedulingScheme.Slitting1DPayload slit = cmd.slitting1D();
                placedCount = slit.fulfillment().stream().mapToInt(SchedulingScheme.SlittingFulfillmentItem::produced).sum();
                int allocTotal = normalizedSourceAllocs.stream().mapToInt(SchedulingScheme.TaskDemandAllocation::quantity).sum();
                if (placedCount > 0 && allocTotal > placedCount) {
                    throw new IllegalArgumentException("合排分切分配总量(" + allocTotal + ")超出方案产出总量(" + placedCount + ")");
                }
            }

            for (SchedulingScheme.TaskDemandAllocation alloc : normalizedSourceAllocs) {
                String key = multiTask ? (alloc.taskId() + ":" + alloc.lineId()) : String.valueOf(alloc.lineId());
                allocated.merge(key, alloc.quantity(), Integer::sum);
            }

            // 核查所有参与任务是否已全部满足（已完成 + 已规划 + 本次分配 >= 总需求）
            int allDoneAfter = 0;
            for (CuttingTask t : sourceTasks.values()) {
                Map<String, Integer> cMap = tx.completedQuantities(t.id());
                Map<String, Integer> pMap = demandPoolService.plannedQuantitiesForTask(tx, t.id(), null);
                allDoneAfter += cMap.values().stream().mapToInt(Integer::intValue).sum()
                        + pMap.values().stream().mapToInt(Integer::intValue).sum();
            }
            allDoneAfter += normalizedSourceAllocs.stream().mapToInt(SchedulingScheme.TaskDemandAllocation::quantity).sum();
            isComplete = allDoneAfter >= requestedCount;
        } else {
            // 传统单任务模式（兼容既有接口调用）
            primaryTask = resolveOrCreateTaskForScheme(tx, cmd, dim, effectiveMaterialModel);
            sourceTasks.put(primaryTask.id(), primaryTask);
            Map<String, Integer> completedMap = tx.completedQuantities(primaryTask.id());
            Map<String, Integer> plannedMap = demandPoolService.plannedQuantitiesForTask(tx, primaryTask.id(), null);
            requestedCount = primaryTask.demands().stream().mapToInt(CuttingTask.Line::quantity).sum();

            if (!isSlit) {
                boolean isContour = "CONTOUR_2D".equals(dim)
                        || primaryTask.demands().stream().anyMatch(d -> d.shape() != null);
                Map<Integer, Integer> rawPlacedByDemand = new LinkedHashMap<>();
                List<SchedulingScheme.PlacementItem> enrichedPlacements = new ArrayList<>(cmd.layout2D().placements().size());
                boolean shapeEnriched = false;
                for (SchedulingScheme.PlacementItem p : cmd.layout2D().placements()) {
                    CuttingTask.Line line = primaryTask.demands().stream().filter(l -> l.id() == p.demandId()).findFirst()
                            .orElseThrow(() -> new IllegalArgumentException("排布裁片引用的需求行不存在: #" + p.demandId()));
                    NestingProblem.Shape preservedShape = isContour
                            ? StudioMaterializer.preserveLineHoles(p.shape(), line.shape(), p.rotationDegrees())
                            : p.shape();
                    if (preservedShape != p.shape()) {
                        shapeEnriched = true;
                    }
                    double pw = preservedShape != null ? preservedShape.width() : p.w();
                    double pl = preservedShape != null ? preservedShape.height() : p.l();
                    StudioMaterializer.validatePlacementRotation(
                            line.name(), line.width(), line.length(), line.allowRotation(), line.allowHalfTurn(),
                            p.rotationDegrees(), pw, pl, isContour
                    );
                    enrichedPlacements.add(preservedShape == p.shape()
                            ? p
                            : new SchedulingScheme.PlacementItem(
                                    p.id(), p.demandId(), p.name(), p.x(), p.y(), p.w(), p.l(),
                                    p.rotationDegrees(), p.gapFill(), preservedShape, p.sourceTaskId(), p.sourceLineId()));
                    placedCount++;
                    if (Boolean.TRUE.equals(p.gapFill())) {
                        gapFillCount++;
                    } else {
                        rawPlacedByDemand.merge(p.demandId(), 1, Integer::sum);
                    }
                }
                if (shapeEnriched) {
                    effectiveLayout2D = new SchedulingScheme.Layout2DPayload(
                            enrichedPlacements, cmd.layout2D().leftovers(), cmd.layout2D().cuts());
                }
                for (Map.Entry<Integer, Integer> entry : rawPlacedByDemand.entrySet()) {
                    String lineKey = String.valueOf(entry.getKey());
                    CuttingTask.Line line = primaryTask.demands().stream().filter(l -> l.id() == entry.getKey()).findFirst().orElseThrow();
                    int open = Math.max(0, line.quantity() - completedMap.getOrDefault(lineKey, 0) - plannedMap.getOrDefault(lineKey, 0));
                    if (entry.getValue() > open) {
                        throw new InventoryConflictException("需求「" + line.name() + "」当前剩余待排量为 " + open + "，小于方案排入量 " + entry.getValue());
                    }
                    allocated.put(lineKey, entry.getValue());
                }
                if (gapFillCount > 0 && completedMap.isEmpty()) {
                    primaryTask = materializer.appendGapFillLinesIfNeeded(tx, primaryTask, cmd.layout2D(), null);
                    sourceTasks.put(primaryTask.id(), primaryTask);
                }
            } else {
                SchedulingScheme.Slitting1DPayload slit = cmd.slitting1D();
                placedCount = slit.fulfillment().stream().mapToInt(SchedulingScheme.SlittingFulfillmentItem::produced).sum();
                for (SchedulingScheme.SlittingFulfillmentItem f : slit.fulfillment()) {
                    CuttingTask.Line line = findSlittingLine(primaryTask, f);
                    if (line == null) continue;
                    String lineKey = String.valueOf(line.id());
                    int open = Math.max(0, line.quantity() - completedMap.getOrDefault(lineKey, 0) - plannedMap.getOrDefault(lineKey, 0));
                    int deduct = Math.min(open, Math.max(0, f.produced()));
                    if (deduct > 0) {
                        allocated.put(lineKey, deduct);
                    }
                }
                if (allocated.isEmpty()) {
                    throw new InventoryConflictException("当前分切需求族已无剩余待排量可扣减");
                }
            }
            isComplete = allocated.values().stream().mapToInt(Integer::intValue).sum()
                    + completedMap.values().stream().mapToInt(Integer::intValue).sum()
                    + plannedMap.values().stream().mapToInt(Integer::intValue).sum() >= requestedCount;
        }

        String schemeId = "SCH-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("MMddHHmm"))
                + "-" + UUID.randomUUID().toString().substring(0, 4).toUpperCase();
        String nowStr = LocalDateTime.now().format(TS_FMT);
        double occupiedLen = isSlit
                ? (double) cmd.slitting1D().totalCars() * cmd.slitting1D().fixedLengthMm()
                : Math.max(1, cmd.occupiedLengthMm());

        String schemeMaterialModel = multiTask ? effectiveMaterialModel : primaryTask.materialModel();
        SchedulingScheme.SuggestedRollSpec suggestedRoll = new SchedulingScheme.SuggestedRollSpec(
                schemeMaterialModel,
                cmd.widthMm(),
                Math.ceil(occupiedLen + Math.max(0, cmd.trimStartMm())),
                isSlit ? cmd.slitting1D().totalCars() : 1
        );

        List<String> linkedPlans = List.of();
        double startY = 0;
        String boundRollId = null;
        String boundRemnantId = null;
        String initialState = SchedulingScheme.STATE_AWAITING_ROLL;

        if ("STOCK_ROLL".equals(mode)) {
            MotherRollInfo roll = tx.findRoll(cmd.rollId())
                    .orElseThrow(() -> new IllegalArgumentException("所选在库母卷不存在: " + cmd.rollId()));
            if (!"PASSED".equals(roll.getInspectionStatus())) {
                throw new IllegalArgumentException("母卷 " + roll.getRollId() + " 尚未验布合格，请先完成跑布验疵或选用合格母卷");
            }
            for (CuttingTask t : sourceTasks.values()) {
                tx.validateBatchAndColorForTask(t, roll, null);
            }
            if (tx.isMaterialReservedByExecution("roll", roll.getRollId(), null)) {
                throw new InventoryConflictException("母卷 " + roll.getRollId() + " 已被执行单预约或正在加工，不能重复锁卷");
            }
            StudioMaterializer.MaterializationResult mat = isSlit
                    ? materializer.materialize1DPlansOnRoll(tx, primaryTask, sourceTasks, multiTask, roll, cmd.slitting1D(), normalizedSourceAllocs, Boolean.TRUE.equals(cmd.avoidDefects()), cmd.windowStartY(), null)
                    : materializer.materialize2DPlanOnMaterial(tx, primaryTask, sourceTasks, normalizedSourceAllocs, multiTask, roll, null, effectiveLayout2D, cmd.widthMm(), occupiedLen, cmd.trimStartMm(), cmd.pieceGapMm(), cmd.windowStartY(), null);
            linkedPlans = mat.planIds();
            startY = mat.startY();
            occupiedLen = mat.occupiedLengthMm();
            boundRollId = roll.getRollId();
            initialState = SchedulingScheme.STATE_READY_TO_CUT;
        } else if ("REMNANT".equals(mode)) {
            if (isSlit) throw new IllegalArgumentException("一维定长分切不支持单块料头出车，请选用母卷或虚拟新母卷");
            RemnantStock rem = tx.findRemnant(cmd.remnantId()).orElse(null);
            if (rem == null || !"AVAILABLE".equals(rem.getStatus())) {
                throw new IllegalArgumentException("所选在库料头不可用: " + cmd.remnantId());
            }
            MotherRollInfo parentRoll = rem.getSourceRollId() != null ? tx.findRoll(rem.getSourceRollId()).orElse(null) : null;
            for (CuttingTask t : sourceTasks.values()) {
                tx.validateBatchAndColorForTask(t, parentRoll, rem);
            }
            // P0-6：料头整块互斥锁检查（执行单 + 其他活跃排程方案）
            if (tx.isMaterialReservedByExecution("remnant", rem.getId(), null)) {
                throw new InventoryConflictException("料头 " + rem.getId() + " 已被执行单预约或正在加工，禁止重复绑定");
            }
            if (tx.listSchemes().stream().anyMatch(s -> s.occupiesRemnant(rem.getId()))) {
                throw new InventoryConflictException("料头 " + rem.getId() + " 已被其他活跃排程方案锁定，禁止重复绑定");
            }
            StudioMaterializer.MaterializationResult mat = materializer.materialize2DPlanOnMaterial(
                    tx, primaryTask, sourceTasks, normalizedSourceAllocs, multiTask, null, rem, effectiveLayout2D,
                    rem.getWidth(), rem.getLength(), cmd.trimStartMm(), cmd.pieceGapMm(), 0.0, null);
            linkedPlans = mat.planIds();
            startY = 0;
            occupiedLen = rem.getLength();
            boundRollId = rem.getSourceRollId();
            boundRemnantId = rem.getId();
            initialState = SchedulingScheme.STATE_READY_TO_CUT;
        } else {
            if (!isSlit) {
                materializer.validateVirtual2DGeometry(
                        effectiveLayout2D,
                        cmd.widthMm(),
                        Math.max(cmd.canvasLengthMm(), occupiedLen),
                        cmd.trimStartMm(),
                        cmd.pieceGapMm()
                );
            }
        }

        String displayTaskName = multiTask
                ? (primaryTask.name() + " 等 " + sourceTasks.size() + " 族合排")
                : primaryTask.name();

        SchedulingScheme scheme = new SchedulingScheme(
                schemeId,
                idemKey,
                (cmd.title() == null || cmd.title().isBlank())
                        ? (cmd.strategyName() + " (" + Math.round(cmd.widthMm()) + "mm)")
                        : cmd.title().trim(),
                dim,
                cmd.scenarioId(),
                cmd.strategyId(),
                cmd.strategyName() == null ? "智能优化方案" : cmd.strategyName(),
                primaryTask.id(),
                displayTaskName,
                primaryTask.externalRef(),
                mode,
                boundRollId,
                boundRemnantId,
                schemeMaterialModel,
                cmd.widthMm(),
                Math.max(cmd.canvasLengthMm(), occupiedLen),
                startY,
                Math.round(occupiedLen * 10.0) / 10.0,
                cmd.trimStartMm(),
                cmd.pieceGapMm(),
                cmd.utilizationPct(),
                cmd.pieceAreaM2(),
                placedCount,
                requestedCount,
                gapFillCount,
                isComplete,
                allocated,
                linkedPlans,
                null,
                initialState,
                suggestedRoll,
                effectiveLayout2D,
                cmd.slitting1D(),
                null,
                nowStr,
                null,
                null,
                null,
                null,
                normalizedSourceAllocs,
                null
        );

        tx.putScheme(scheme);
        return enrichWithDemandFamilies(tx, scheme);
    }

    /**
     * 将虚拟新母卷方案（AWAITING_ROLL）绑定到真实在库母卷（或按建议规格入库待检新母卷）：
     * - 自动建卷默认 inspectionStatus="PENDING"、inspector=""（严禁硬编码直通 PASSED）；
     * - 新建母卷处于 PENDING 时仅落库母卷、方案保持 AWAITING_ROLL 等待质检放行后再锁卷；
     * - 仅对已验布合格（PASSED）母卷执行物理物化与锁卷，进入 READY_TO_CUT。
     */
    public Map<String, Object> bindRollToScheme(String schemeId, BindRollCommand cmd) {
        if (schemeId == null || schemeId.isBlank()) throw new IllegalArgumentException("请指定排程方案编号");
        return statePort.inWrite("ROLL_RECEIPT_OR_UPDATE", schemeId, "UNAUTHENTICATED_LOCAL", tx -> {
            SchedulingScheme scheme = tx.findScheme(schemeId)
                    .orElseThrow(() -> new IllegalArgumentException("排程方案不存在: " + schemeId));
            return bindRollInTx(tx, scheme, cmd);
        });
    }

    private Map<String, Object> bindRollInTx(CuttingStatePort.WriteTx tx, SchedulingScheme scheme, BindRollCommand cmd) {
        if (SchedulingScheme.STATE_READY_TO_CUT.equals(scheme.state()) && Objects.equals(scheme.rollId(), cmd != null ? cmd.rollId() : null)) {
            return enrichSchemeView(tx, scheme);
        }
        if (!SchedulingScheme.STATE_AWAITING_ROLL.equals(scheme.state())
                && !(SchedulingScheme.STATE_DISPATCHED_MES.equals(scheme.state()) && scheme.linkedPlanIds().isEmpty())) {
            throw new InventoryConflictException("仅未绑定实卷的虚拟母卷方案可执行绑卷，当前状态：" + scheme.state());
        }

        Map<String, CuttingTask> sourceTasks = loadSourceTasksForScheme(tx, scheme);
        boolean multiTask = scheme.isMultiTaskMerged();
        CuttingTask primaryTask = sourceTasks.get(scheme.taskId());
        if (primaryTask == null) {
            throw new IllegalArgumentException("方案关联的需求族不存在");
        }

        MotherRollInfo roll;
        boolean newlyCreated = false;
        if (cmd != null && Boolean.TRUE.equals(cmd.autoCreateRoll())) {
            String newRollId = (cmd.rollId() == null || cmd.rollId().isBlank())
                    ? "ROLL-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("MMddHHmm")) + "-" + UUID.randomUUID().toString().substring(0, 3).toUpperCase()
                    : cmd.rollId().trim();
            double minReqLen = Math.max(5000, Math.ceil(scheme.occupiedLengthMm() + scheme.trimStartMm()));
            double totalLen = (cmd.newRollLengthMm() != null && cmd.newRollLengthMm() >= minReqLen)
                    ? cmd.newRollLengthMm()
                    : Math.max(minReqLen, Math.ceil(minReqLen / 1000.0) * 1000.0 + 10000);
            String defaultBatch = (primaryTask.requiredBatchNo() != null && !primaryTask.requiredBatchNo().isBlank())
                    ? primaryTask.requiredBatchNo()
                    : "BAT-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd"));
            String defaultColor = (primaryTask.requiredColor() != null && !primaryTask.requiredColor().isBlank())
                    ? primaryTask.requiredColor()
                    : "标准色";
            MotherRollInfo fresh = new MotherRollInfo(
                    newRollId,
                    scheme.materialModel(),
                    defaultBatch,
                    "按方案备料入库",
                    scheme.materialModel(),
                    defaultColor,
                    220.0,
                    "标准材质",
                    scheme.widthMm(),
                    totalLen,
                    (cmd.storageLocation() == null || cmd.storageLocation().isBlank()) ? "裁床线边备料区 L-01" : cmd.storageLocation().trim()
            );
            // 默认待检（PENDING），禁止硬编码直通 PASSED；仅允许显式传入已核验的 PASSED 与真实检验员
            if ("PASSED".equalsIgnoreCase(cmd.inspectionStatus()) && cmd.inspector() != null && !cmd.inspector().isBlank()) {
                fresh.setInspectionStatus("PASSED");
                fresh.setInspector(cmd.inspector().trim());
                fresh.setInspectionDate(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd")));
            } else {
                fresh.setInspectionStatus("PENDING");
                fresh.setInspector("");
                fresh.setInspectionDate(null);
            }
            roll = tx.saveRoll(fresh);
            newlyCreated = true;
        } else {
            if (cmd == null || cmd.rollId() == null || cmd.rollId().isBlank()) {
                throw new IllegalArgumentException("请选择要绑定的在库母卷编号，或勾选按建议规格自动建卷");
            }
            roll = tx.findRoll(cmd.rollId().trim())
                    .orElseThrow(() -> new IllegalArgumentException("在库母卷不存在: " + cmd.rollId()));
            if (!"PASSED".equals(roll.getInspectionStatus())) {
                throw new IllegalArgumentException("母卷 " + roll.getRollId() + " 尚未验布合格，不能直接锁卷切割");
            }
            if (Math.abs(roll.getWidth() - scheme.widthMm()) > 1.0) {
                throw new IllegalArgumentException("所选母卷幅宽 (" + roll.getWidth() + "mm) 与方案设定门幅 (" + scheme.widthMm() + "mm) 不一致");
            }
            for (CuttingTask t : sourceTasks.values()) {
                tx.validateBatchAndColorForTask(t, roll, null);
            }
            if (!multiTask && !Objects.equals(primaryTask.materialModel(), roll.getRollModel())
                    && tx.completedQuantities(primaryTask.id()).isEmpty()) {
                CuttingTask aligned = primaryTask.withMaterialModel(roll.getRollModel());
                primaryTask = tx.saveTaskForScheme(aligned, scheme.id());
                sourceTasks.put(primaryTask.id(), primaryTask);
            }
        }

        // 若自动建卷为待检状态（PENDING），落库母卷但绝不跳过质检直接进入 READY_TO_CUT
        if (newlyCreated && !"PASSED".equals(roll.getInspectionStatus())) {
            Map<String, Object> pendingOut = new LinkedHashMap<>(enrichSchemeView(tx, scheme));
            pendingOut.put("createdRoll", roll);
            pendingOut.put("rollInfo", rollSummaryMap(roll));
            pendingOut.put("awaitingInspection", true);
            pendingOut.put("message", "已按建议规格创建待检母卷 " + roll.getRollId() + "（当前状态 PENDING），请完成跑布验疵并质检放行后再执行锁卷绑定");
            return pendingOut;
        }

        if (tx.isMaterialReservedByExecution("roll", roll.getRollId(), null)) {
            throw new InventoryConflictException("母卷 " + roll.getRollId() + " 已被执行单预约或正在加工，不能重复锁卷");
        }

        boolean isSlit = "SLITTING_1D".equals(scheme.dimension());
        if (!isSlit && !multiTask && scheme.gapFillCount() > 0 && tx.completedQuantities(primaryTask.id()).isEmpty()) {
            primaryTask = materializer.appendGapFillLinesIfNeeded(tx, primaryTask, scheme.layout2D(), scheme.id());
            sourceTasks.put(primaryTask.id(), primaryTask);
        }

        StudioMaterializer.MaterializationResult mat = isSlit
                ? materializer.materialize1DPlansOnRoll(tx, primaryTask, sourceTasks, multiTask, roll, scheme.slitting1D(), scheme.effectiveAllocations(), true, cmd != null ? cmd.windowStartY() : null, scheme.id())
                : materializer.materialize2DPlanOnMaterial(tx, primaryTask, sourceTasks, scheme.effectiveAllocations(), multiTask, roll, null, scheme.layout2D(), roll.getWidth(), scheme.occupiedLengthMm(), scheme.trimStartMm(), scheme.pieceGapMm(), cmd != null ? cmd.windowStartY() : null, scheme.id());

        SchedulingScheme updated = new SchedulingScheme(
                scheme.id(), scheme.idempotencyKey(), scheme.title(), scheme.dimension(),
                scheme.scenarioId(), scheme.strategyId(), scheme.strategyName(),
                primaryTask.id(), scheme.taskName(), scheme.externalOrderNo(),
                "STOCK_ROLL", roll.getRollId(), null, multiTask ? roll.getRollModel() : primaryTask.materialModel(),
                roll.getWidth(), scheme.canvasLengthMm(), mat.startY(), mat.occupiedLengthMm(),
                scheme.trimStartMm(), scheme.pieceGapMm(), scheme.utilizationPct(), scheme.pieceAreaM2(),
                scheme.placedCount(), scheme.requestedCount(), scheme.gapFillCount(), scheme.complete(),
                scheme.allocatedDemands(), mat.planIds(), null,
                SchedulingScheme.STATE_DISPATCHED_MES.equals(scheme.state())
                        ? SchedulingScheme.STATE_DISPATCHED_MES
                        : SchedulingScheme.STATE_READY_TO_CUT,
                scheme.suggestedRoll(),
                scheme.layout2D(), scheme.slitting1D(), scheme.mesWorkOrderNo(),
                scheme.createdAt(), scheme.dispatchedAt(), scheme.completedAt(), scheme.cancelledAt(), scheme.cancelReason(),
                scheme.sourceAllocations(), scheme.mesReceiptNo()
        );
        tx.putScheme(updated);
        return enrichSchemeView(tx, updated);
    }

    /**
     * 一键完工记账（或 MES 实切完工核销）：
     * 原子执行底层 CuttingPlan 报工，扣减实卷长度、登记派生余料入库、将 plannedQty 结转为 completedQty，
     * 并真实透传操作人（DECLARED:<op> / MES:<op>）至审计流水。
     */
    public Map<String, Object> completeScheme(String schemeId, CompleteSchemeCommand cmd) {
        if (schemeId == null || schemeId.isBlank()) throw new IllegalArgumentException("请指定排程方案编号");
        String actor = resolveActor(cmd != null ? cmd.operator() : null, "UNAUTHENTICATED_LOCAL");
        return statePort.inWrite(
                "CUT_REPORT",
                schemeId,
                actor,
                tx -> tx.findScheme(schemeId)
                        .filter(s -> SchedulingScheme.STATE_COMPLETED.equals(s.state()))
                        .map(s -> enrichWithDemandFamilies(tx, s))
                        .orElse(null),
                tx -> {
                    SchedulingScheme scheme = tx.findScheme(schemeId)
                            .orElseThrow(() -> new IllegalArgumentException("排程方案不存在: " + schemeId));
                    return completeSchemeInTx(tx, scheme, cmd, null);
                }
        );
    }

    private Map<String, Object> completeSchemeInTx(
            CuttingStatePort.WriteTx tx,
            SchedulingScheme scheme,
            CompleteSchemeCommand cmd,
            String mesReceiptNo
    ) {
        if (SchedulingScheme.STATE_COMPLETED.equals(scheme.state())) {
            return enrichWithDemandFamilies(tx, scheme);
        }
        if (SchedulingScheme.STATE_AWAITING_ROLL.equals(scheme.state())) {
            throw new IllegalArgumentException("该方案使用的是虚拟新母卷，请先绑定在库实卷（或建卷质检放行后绑定）再执行完工过账");
        }
        if (SchedulingScheme.STATE_CANCELLED.equals(scheme.state())) {
            throw new InventoryConflictException("已作废方案不能执行完工过账");
        }
        if (SchedulingScheme.STATE_REVERSED.equals(scheme.state())) {
            throw new InventoryConflictException("已冲销方案不能再次执行完工过账，请重新排程确认");
        }
        if (scheme.linkedPlanIds().isEmpty()) {
            throw new IllegalArgumentException("方案缺少已锁定的机台切割计划明细");
        }
        if ("STOCK_ROLL".equals(scheme.materialMode()) && scheme.rollId() != null) {
            MotherRollInfo roll = tx.findRoll(scheme.rollId())
                    .orElseThrow(() -> new IllegalArgumentException("方案绑定母卷不存在: " + scheme.rollId()));
            if (!"PASSED".equals(roll.getInspectionStatus())) {
                throw new InventoryConflictException("母卷 " + roll.getRollId() + " 未通过质检验布，禁止完工过账");
            }
        }

        Set<Integer> rejectedIds = (cmd != null && cmd.rejectedPieceIds() != null)
                ? new HashSet<>(cmd.rejectedPieceIds())
                : Set.of();
        boolean recoverRems = cmd == null || cmd.recoverRemnants() == null || cmd.recoverRemnants();
        String remLoc = (cmd != null && cmd.remnantLocation() != null && !cmd.remnantLocation().isBlank())
                ? cmd.remnantLocation().trim()
                : "裁床余料架 A-01";
        boolean multiTask = scheme.isMultiTaskMerged();
        List<SchedulingScheme.TaskDemandAllocation> sourceAllocs = scheme.sourceAllocations();

        Set<String> batchReported = new HashSet<>();
        List<Map<String, Object>> receiptsOut = new ArrayList<>();

        for (String planId : scheme.linkedPlanIds()) {
            CuttingPlan plan = tx.findPlan(planId)
                    .orElseThrow(() -> new IllegalArgumentException("底层切割计划缺失: " + planId));
            Optional<Map<String, Object>> existingReceipt = tx.findReceipt(planId);
            if ("CONFIRMED".equals(plan.status()) && existingReceipt.isPresent()) {
                receiptsOut.add(tx.projectQuality(existingReceipt.get()));
                batchReported.add(planId);
                continue;
            }

            boolean remnantFeed = "remnant".equalsIgnoreCase(plan.request().getFeedPortType());
            double defaultCutLen = remnantFeed ? 0 : (plan.result().getDeductLen() > 0 ? plan.result().getDeductLen() : plan.request().getRollL());
            double actualCutLen = (!remnantFeed && cmd != null && cmd.actualCutLenMm() != null && scheme.linkedPlanIds().size() == 1)
                    ? cmd.actualCutLenMm()
                    : defaultCutLen;

            List<CutReport.PieceResult> pieceResults = new ArrayList<>();
            int qualifiedCount = 0;
            Map<String, Map<String, Integer>> taskDemandQuantities = multiTask ? new LinkedHashMap<>() : null;
            Map<Integer, SchedulingScheme.TaskDemandAllocation> pieceSources = multiTask ? new LinkedHashMap<>() : null;

            for (PlacedPiece pc : plan.result().getPieces()) {
                boolean isRejected = rejectedIds.contains(pc.getId());
                pieceResults.add(new CutReport.PieceResult(
                        pc.getId(),
                        isRejected ? "REJECTED" : "QUALIFIED",
                        isRejected ? "实切异常判废" : ""
                ));
                if (!isRejected) qualifiedCount++;

                if (multiTask) {
                    int idx = pc.getDemandId() != null ? pc.getDemandId() - 1 : -1;
                    if (idx < 0 || idx >= sourceAllocs.size()) {
                        throw new IllegalStateException("跨任务合排裁片 #" + pc.getId() + " 缺少有效的源任务归属索引");
                    }
                    SchedulingScheme.TaskDemandAllocation src = sourceAllocs.get(idx);
                    pieceSources.put(pc.getId(), new SchedulingScheme.TaskDemandAllocation(src.taskId(), src.lineId(), 1));
                    if (!isRejected) {
                        taskDemandQuantities
                                .computeIfAbsent(src.taskId(), k -> new LinkedHashMap<>())
                                .merge(String.valueOf(src.lineId()), 1, Integer::sum);
                    }
                }
            }

            List<RemnantPiece> actualRemnants = new ArrayList<>();
            if (!remnantFeed && recoverRems && plan.result().getRemnants() != null) {
                double minW = Math.max(150, plan.request().getMinRemnantWidth());
                double minL = Math.max(150, plan.request().getMinRemnantLength());
                for (RemnantPiece rp : plan.result().getRemnants()) {
                    if (rp.getW() >= minW && rp.getL() >= minL && rp.getY() + rp.getL() <= actualCutLen + 0.001) {
                        actualRemnants.add(new RemnantPiece(
                                rp.getId(), rp.getStatus(), rp.getX(), rp.getY(),
                                rp.getW(), rp.getL(), (rp.getW() * rp.getL()) / 1_000_000.0, rp.isHasDefect()
                        ));
                    }
                }
            }

            CutReport report = new CutReport(planId, actualCutLen, qualifiedCount, actualRemnants, remLoc, pieceResults);
            Map<String, Object> confirmed = multiTask
                    ? tx.confirmPlan(report, batchReported, taskDemandQuantities, pieceSources)
                    : tx.confirmPlan(report, batchReported);
            receiptsOut.add(confirmed);
            batchReported.add(planId);
        }

        SchedulingScheme completedScheme = scheme.withCompleted(LocalDateTime.now().format(TS_FMT), mesReceiptNo);
        tx.putScheme(completedScheme);

        Map<String, Object> out = new LinkedHashMap<>(enrichWithDemandFamilies(tx, completedScheme));
        out.put("receipts", receiptsOut);
        return out;
    }

    /**
     * 基于源方案报工/复检判废或未满足缺口，一键创建高优先级（URGENT）、强制同缸匹配（strictBatchMatch=true）的同缸补片任务。
     */
    public Map<String, Object> createReplenishTaskFromScheme(String schemeId, ReplenishTaskCommand cmd) {
        if (schemeId == null || schemeId.isBlank()) throw new IllegalArgumentException("请指定源排程方案编号");
        if (cmd == null || cmd.idempotencyKey() == null || cmd.idempotencyKey().isBlank() || cmd.idempotencyKey().trim().length() > 128) {
            throw new IllegalArgumentException("请提供 1–128 字符的有效幂等键 idempotencyKey");
        }
        String cleanSchemeId = schemeId.trim();
        String key = cmd.idempotencyKey().trim();
        String reason = cmd.reason() == null ? "" : cmd.reason().trim();
        if (reason.length() > 500) throw new IllegalArgumentException("补片原因不能超过 500 字");
        String actor = resolveActor(cmd.operator(), "UNAUTHENTICATED_LOCAL");

        return statePort.inWrite(
                "REPLENISH_TASK",
                cleanSchemeId,
                actor,
                tx -> {
                    Optional<CuttingTask> existing = tx.findTaskByReplenishIdempotencyKey(key);
                    if (existing.isPresent()) {
                        CuttingTask hit = existing.get();
                        if (!cleanSchemeId.equals(hit.sourceSchemeId())) {
                            throw new InventoryConflictException("同一幂等键已用于其他排程方案的补片任务: " + hit.sourceSchemeId());
                        }
                        Map<String, Object> replayOut = new LinkedHashMap<>();
                        replayOut.put("task", hit);
                        replayOut.put("sourceSchemeId", cleanSchemeId);
                        replayOut.put("revision", tx.currentRevision());
                        return replayOut;
                    }
                    return null;
                },
                tx -> {
                    SchedulingScheme source = tx.findScheme(cleanSchemeId)
                            .orElseThrow(() -> new IllegalArgumentException("排程方案不存在: " + cleanSchemeId));
                    if (SchedulingScheme.STATE_CANCELLED.equals(source.state()) || SchedulingScheme.STATE_REVERSED.equals(source.state())) {
                        throw new InventoryConflictException("已作废或已冲销方案不能发起同缸补片");
                    }

                    Map<String, CuttingTask> sourceTasks = loadSourceTasksForScheme(tx, source);
                    CuttingTask primaryTask = sourceTasks.get(source.taskId());
                    if (primaryTask == null && !sourceTasks.isEmpty()) {
                        primaryTask = sourceTasks.values().iterator().next();
                    }

                    // 1. 优先精确汇总源方案关联有效报工中的判废、未切与复检淘汰缺口
                    Map<String, Integer> shortageQty = new LinkedHashMap<>();
                    Map<String, CuttingTask.Line> shortageLineDef = new LinkedHashMap<>();

                    for (String pid : source.linkedPlanIds()) {
                        Map<String, Object> rawReceipt = tx.findReceipt(pid).orElse(null);
                        if (rawReceipt == null || "REVERSED".equals(rawReceipt.get("status"))) continue;
                        Map<String, Object> projected = tx.projectQuality(rawReceipt);
                        Map<?, ?> pieceSources = rawReceipt.get("pieceSources") instanceof Map<?, ?> ps ? ps : null;
                        String receiptTaskId = rawReceipt.get("taskId") != null ? rawReceipt.get("taskId").toString() : source.taskId();

                        Set<Integer> activeDisposedGoodPieceIds = new HashSet<>();
                        if (projected.get("qualityDispositions") instanceof List<?> qList) {
                            for (Object qObj : qList) {
                                if (qObj instanceof QualityDisposition qd
                                        && !qd.hasRevocation()
                                        && "QUALIFIED".equals(qd.originalOutcome())) {
                                    activeDisposedGoodPieceIds.add(qd.command().pieceId());
                                }
                            }
                        }

                        if (rawReceipt.get("pieceResults") instanceof List<?> pieces) {
                            for (Object pObj : pieces) {
                                int pieceId;
                                Integer demandId;
                                String outcome;
                                if (pObj instanceof ReportOutput.ReportedPiece rp) {
                                    pieceId = rp.pieceId();
                                    demandId = rp.demandId();
                                    outcome = rp.outcome();
                                } else if (pObj instanceof Map<?, ?> pm) {
                                    pieceId = pm.get("pieceId") instanceof Number n ? n.intValue() : -1;
                                    demandId = pm.get("demandId") instanceof Number n ? n.intValue() : null;
                                    outcome = Objects.toString(pm.get("outcome"), "");
                                } else {
                                    continue;
                                }
                                boolean needsReplenish = "REJECTED".equals(outcome)
                                        || "UNCUT".equals(outcome)
                                        || ("QUALIFIED".equals(outcome) && activeDisposedGoodPieceIds.contains(pieceId));
                                if (!needsReplenish) continue;

                                String targetTaskId = receiptTaskId;
                                Integer targetLineId = demandId;
                                if (pieceSources != null) {
                                    Object srcObj = pieceSources.get(String.valueOf(pieceId));
                                    if (srcObj == null) srcObj = pieceSources.get(pieceId);
                                    if (srcObj instanceof Map<?, ?> sm && sm.get("taskId") != null && sm.get("lineId") instanceof Number ln) {
                                        targetTaskId = sm.get("taskId").toString();
                                        targetLineId = ln.intValue();
                                    }
                                }
                                if (targetTaskId == null || targetLineId == null) continue;
                                CuttingTask srcTask = sourceTasks.computeIfAbsent(targetTaskId, id -> tx.findTask(id).orElse(null));
                                if (srcTask == null) continue;
                                int finalLineId = targetLineId;
                                CuttingTask.Line srcLine = srcTask.demands().stream().filter(l -> l.id() == finalLineId).findFirst().orElse(null);
                                if (srcLine == null) continue;
                                String lineKey = targetTaskId + ":" + finalLineId;
                                shortageQty.merge(lineKey, 1, Integer::sum);
                                shortageLineDef.putIfAbsent(lineKey, srcLine);
                            }
                        }
                    }

                    // 2. 若报工/复检无判废缺口，则检查源方案关联任务的未满足缺口（openQty > 0）
                    if (shortageQty.isEmpty()) {
                        for (CuttingTask t : sourceTasks.values()) {
                            if (t == null) continue;
                            Map<String, Integer> completedMap = tx.completedQuantities(t.id());
                            Map<String, Integer> plannedMap = demandPoolService.plannedQuantitiesForTask(tx, t.id(), null);
                            for (CuttingTask.Line line : t.demands()) {
                                String k = String.valueOf(line.id());
                                int open = Math.max(0, line.quantity() - completedMap.getOrDefault(k, 0) - plannedMap.getOrDefault(k, 0));
                                if (open > 0) {
                                    String lineKey = t.id() + ":" + line.id();
                                    shortageQty.merge(lineKey, open, Integer::sum);
                                    shortageLineDef.putIfAbsent(lineKey, line);
                                }
                            }
                        }
                    }

                    if (shortageQty.isEmpty()) {
                        throw new IllegalArgumentException("源方案暂无判废或未满足缺口，无需创建补片任务");
                    }

                    MotherRollInfo roll = source.rollId() != null ? tx.findRoll(source.rollId()).orElse(null) : null;
                    RemnantStock rem = source.remnantId() != null ? tx.findRemnant(source.remnantId()).orElse(null) : null;
                    String inheritedBatch = (rem != null && rem.getBatchNo() != null && !rem.getBatchNo().isBlank())
                            ? rem.getBatchNo().trim()
                            : (roll != null && roll.getBatchNo() != null && !roll.getBatchNo().isBlank())
                            ? roll.getBatchNo().trim()
                            : (primaryTask != null ? primaryTask.requiredBatchNo() : null);
                    String inheritedColor = (rem != null && rem.getColor() != null && !rem.getColor().isBlank())
                            ? rem.getColor().trim()
                            : (roll != null && roll.getColor() != null && !roll.getColor().isBlank())
                            ? roll.getColor().trim()
                            : (primaryTask != null ? primaryTask.requiredColor() : null);
                    String inheritedModel = (roll != null && roll.getRollModel() != null && !roll.getRollModel().isBlank())
                            ? roll.getRollModel().trim()
                            : source.materialModel();

                    List<CuttingTask.Line> replenishLines = new ArrayList<>();
                    int nextId = 1;
                    for (Map.Entry<String, Integer> e : shortageQty.entrySet()) {
                        CuttingTask.Line orig = shortageLineDef.get(e.getKey());
                        replenishLines.add(new CuttingTask.Line(
                                nextId++,
                                orig.name(),
                                orig.width(),
                                orig.length(),
                                e.getValue(),
                                orig.allowRotation(),
                                orig.shape(),
                                orig.allowHalfTurn(),
                                orig.sizeLabel(),
                                orig.sourceTemplateId(),
                                orig.surfaceTreatment()
                        ));
                    }

                    String titleSuffix = reason.isEmpty() ? "" : ("（" + (reason.length() > 30 ? reason.substring(0, 30) : reason) + "）");
                    String taskName = "同缸补片 · " + source.title() + titleSuffix;
                    String kittingGroup = (primaryTask != null && primaryTask.kittingGroup() != null && !primaryTask.kittingGroup().isBlank())
                            ? primaryTask.kittingGroup()
                            : ("补片-" + source.id());

                    CuttingTask payload = new CuttingTask(
                            null,
                            taskName,
                            inheritedModel,
                            "REPLENISH-" + source.id(),
                            0,
                            replenishLines,
                            primaryTask != null ? primaryTask.process() : null,
                            primaryTask != null ? primaryTask.problemType() : null,
                            primaryTask != null ? primaryTask.slitting() : null,
                            primaryTask != null ? primaryTask.dueDate() : null,
                            CuttingTask.PRIORITY_URGENT,
                            primaryTask != null ? primaryTask.customerName() : null,
                            kittingGroup,
                            inheritedBatch,
                            inheritedColor,
                            Boolean.TRUE,
                            primaryTask != null ? primaryTask.machineId() : null,
                            primaryTask != null ? primaryTask.shiftTeam() : null,
                            source.id(),
                            key
                    );

                    CuttingTask created = tx.saveTask(payload);
                    Map<String, Object> out = new LinkedHashMap<>();
                    out.put("task", created);
                    out.put("sourceSchemeId", cleanSchemeId);
                    out.put("revision", tx.currentRevision() + 1);
                    return out;
                }
        );
    }

    /**
     * 作废未实切的排程方案：自动取消底层未报工计划，释放实卷/料头预占，并将占用的 plannedQty 退回各源任务待排需求池 openQty。
     */
    public Map<String, Object> cancelScheme(String schemeId, String reason) {
        if (schemeId == null || schemeId.isBlank()) throw new IllegalArgumentException("请指定排程方案编号");
        String why = (reason == null || reason.isBlank()) ? "排料员手动取消方案重排" : reason.trim();
        return statePort.inWrite(
                "DEMAND_ADJUSTMENT",
                schemeId,
                "UNAUTHENTICATED_LOCAL",
                tx -> tx.findScheme(schemeId)
                        .filter(s -> SchedulingScheme.STATE_CANCELLED.equals(s.state()))
                        .map(s -> enrichWithDemandFamilies(tx, s))
                        .orElse(null),
                tx -> {
                    SchedulingScheme scheme = tx.findScheme(schemeId)
                            .orElseThrow(() -> new IllegalArgumentException("排程方案不存在: " + schemeId));
                    if (SchedulingScheme.STATE_COMPLETED.equals(scheme.state())) {
                        throw new InventoryConflictException("已完工记账方案不可直接作废；若发现裁片不良请使用「复检补排」或报工冲销");
                    }
                    if (SchedulingScheme.STATE_REVERSED.equals(scheme.state())) {
                        throw new InventoryConflictException("已冲销方案已释放需求，无需再次作废");
                    }
                    for (String pid : scheme.linkedPlanIds()) {
                        tx.cancelPendingPlan(pid);
                    }
                    SchedulingScheme cancelled = scheme.withCancelled(LocalDateTime.now().format(TS_FMT), why);
                    tx.putScheme(cancelled);
                    return enrichWithDemandFamilies(tx, cancelled);
                }
        );
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
    ) {}

    public record MesFeedbackCommand(
            String schemeId,
            String mesReceiptNo,
            String scannedRollId,
            Double actualCutLenMm,
            List<Integer> rejectedPieceIds,
            Boolean recoverRemnants,
            String remnantLocation
    ) {}

    /**
     * MES 工单同步：收敛至单一写事务内原子查重 + 建单，彻底消除并发 TOCTOU 建重单风险。
     */
    public Map<String, Object> syncMesOrder(MesOrderSyncCommand cmd) {
        if (cmd == null || cmd.mesWorkOrderNo() == null || cmd.mesWorkOrderNo().isBlank()) {
            throw new IllegalArgumentException("MES 工单号 (mesWorkOrderNo) 不能为空");
        }
        if (cmd.demands() == null || cmd.demands().isEmpty()) {
            throw new IllegalArgumentException("请至少提供 1 项有效需求明细");
        }
        String wo = cmd.mesWorkOrderNo().trim();
        return statePort.inWrite(
                "DEMAND_ADJUSTMENT",
                wo,
                "MES_SYNC",
                tx -> tx.findTaskByExternalRef(wo).map(existing -> demandPoolService.buildDemandFamilyView(tx, existing)).orElse(null),
                tx -> {
                    CuttingTask saved = demandPoolService.saveOrMergeTask(tx, new SaveDemandFamilyCommand(
                            null,
                            null,
                            cmd.name() == null || cmd.name().isBlank() ? ("MES工单 · " + wo) : cmd.name().trim(),
                            cmd.materialModel() == null || cmd.materialModel().isBlank() ? "MES-STD" : cmd.materialModel().trim(),
                            wo,
                            cmd.dimension(),
                            null, 0.0, 0.0, 10, 10, null,
                            cmd.widthMm() != null ? cmd.widthMm().intValue() : null,
                            10, 20,
                            cmd.demands()
                    ));
                    return demandPoolService.buildDemandFamilyView(tx, saved);
                }
        );
    }

    public Map<String, Object> dispatchSchemeToMes(String schemeId, String mesWorkOrderNo) {
        return statePort.inWrite("SYSTEM_UPDATE", schemeId, "MES_DISPATCHER", tx -> {
            SchedulingScheme s = tx.findScheme(schemeId)
                    .orElseThrow(() -> new IllegalArgumentException("排程方案不存在: " + schemeId));
            if (SchedulingScheme.STATE_CANCELLED.equals(s.state()) || SchedulingScheme.STATE_REVERSED.equals(s.state())) {
                throw new InventoryConflictException("已作废或已冲销方案不能下发 MES");
            }
            String wo = (mesWorkOrderNo != null && !mesWorkOrderNo.isBlank())
                    ? mesWorkOrderNo.trim()
                    : (s.externalOrderNo() != null && !s.externalOrderNo().isBlank() ? s.externalOrderNo() : "WO-" + s.id());
            SchedulingScheme next = SchedulingScheme.STATE_COMPLETED.equals(s.state())
                    ? s
                    : s.withDispatched(wo, LocalDateTime.now().format(TS_FMT));
            tx.putScheme(next);
            return buildMesDispatchPackage(next);
        });
    }

    public Map<String, Object> getMesDispatchPackage(String schemeId) {
        return statePort.inRead(tx -> {
            SchedulingScheme s = tx.findScheme(schemeId)
                    .orElseThrow(() -> new IllegalArgumentException("排程方案不存在: " + schemeId));
            return buildMesDispatchPackage(s);
        });
    }

    /**
     * MES 实切完工回传：在单一原子写事务内完成「mesReceiptNo 幂等防重校验 → 绑卷（若未绑定）→ 完工扣库与持久化 mesReceiptNo」。
     * 任一步校验失败均原子回滚，绝不留下半提交的绑卷脏态。
     */
    public Map<String, Object> receiveMesFeedback(MesFeedbackCommand cmd) {
        if (cmd == null || cmd.schemeId() == null || cmd.schemeId().isBlank()) {
            throw new IllegalArgumentException("请提供回传的排程方案号 schemeId");
        }
        String schemeId = cmd.schemeId().trim();
        String receiptNo = (cmd.mesReceiptNo() == null || cmd.mesReceiptNo().isBlank()) ? null : cmd.mesReceiptNo().trim();
        String actor = "MES:" + (receiptNo != null ? receiptNo : "CALLBACK");

        return statePort.inWrite(
                "CUT_REPORT",
                schemeId,
                actor,
                tx -> {
                    if (receiptNo != null) {
                        Optional<SchedulingScheme> byReceipt = tx.findSchemeByMesReceiptNo(receiptNo);
                        if (byReceipt.isPresent()) {
                            SchedulingScheme hit = byReceipt.get();
                            if (!hit.id().equals(schemeId)) {
                                throw new InventoryConflictException("MES 回执号 " + receiptNo + " 已用于其他排程方案: " + hit.id());
                            }
                            if (SchedulingScheme.STATE_COMPLETED.equals(hit.state())) {
                                return enrichWithDemandFamilies(tx, hit);
                            }
                        }
                    }
                    SchedulingScheme existing = tx.findScheme(schemeId).orElse(null);
                    if (existing != null && SchedulingScheme.STATE_COMPLETED.equals(existing.state())) {
                        if (receiptNo != null && existing.mesReceiptNo() != null && !receiptNo.equals(existing.mesReceiptNo())) {
                            throw new InventoryConflictException("排程方案 " + schemeId + " 已由 MES 回执号 " + existing.mesReceiptNo() + " 核销，不能重复提交不同回执号");
                        }
                        return enrichWithDemandFamilies(tx, existing);
                    }
                    return null;
                },
                tx -> {
                    SchedulingScheme current = tx.findScheme(schemeId)
                            .orElseThrow(() -> new IllegalArgumentException("排程方案不存在: " + schemeId));
                    if (SchedulingScheme.STATE_CANCELLED.equals(current.state()) || SchedulingScheme.STATE_REVERSED.equals(current.state())) {
                        throw new InventoryConflictException("排程方案状态为 " + current.state() + "，拒绝 MES 完工回传");
                    }
                    if (SchedulingScheme.STATE_AWAITING_ROLL.equals(current.state()) || current.linkedPlanIds().isEmpty()) {
                        if (cmd.scannedRollId() == null || cmd.scannedRollId().isBlank()) {
                            throw new IllegalArgumentException("虚拟母卷方案在 MES 完工回传时必须携带机台实扫母卷条码 scannedRollId");
                        }
                        bindRollInTx(tx, current, new BindRollCommand(cmd.scannedRollId().trim(), false, null, null, null));
                        current = tx.findScheme(schemeId).orElseThrow();
                    }
                    return completeSchemeInTx(tx, current, new CompleteSchemeCommand(
                            cmd.actualCutLenMm(),
                            cmd.rejectedPieceIds(),
                            cmd.recoverRemnants(),
                            cmd.remnantLocation(),
                            actor
                    ), receiptNo);
                }
        );
    }

    // ==================== 内部视图装配、多族合排校验与辅助 ====================

    private List<SchedulingScheme.TaskDemandAllocation> normalizeAndValidateSourceAllocations(
            CuttingStatePort.ReadView tx,
            List<SchedulingScheme.TaskDemandAllocation> rawAllocs,
            String targetDimension,
            Map<String, CuttingTask> sourceTasksOut
    ) {
        Map<String, SchedulingScheme.TaskDemandAllocation> merged = new LinkedHashMap<>();
        for (SchedulingScheme.TaskDemandAllocation raw : rawAllocs) {
            if (raw == null || raw.taskId() == null || raw.taskId().isBlank() || raw.lineId() <= 0 || raw.quantity() <= 0) {
                throw new IllegalArgumentException("多族合排分配项必须提供有效 taskId、正整数 lineId 与正数 quantity");
            }
            String tid = raw.taskId().trim();
            String key = tid + ":" + raw.lineId();
            merged.merge(key, new SchedulingScheme.TaskDemandAllocation(tid, raw.lineId(), raw.quantity()),
                    (a, b) -> new SchedulingScheme.TaskDemandAllocation(a.taskId(), a.lineId(), a.quantity() + b.quantity()));
        }
        if (merged.isEmpty()) {
            throw new IllegalArgumentException("多族合排分配列表不能为空");
        }

        boolean expectSlit = "SLITTING_1D".equals(targetDimension);
        Map<String, Map<String, Integer>> completedByTask = new HashMap<>();
        Map<String, Map<String, Integer>> plannedByTask = new HashMap<>();

        for (SchedulingScheme.TaskDemandAllocation alloc : merged.values()) {
            CuttingTask task = sourceTasksOut.computeIfAbsent(alloc.taskId(), id ->
                    tx.findTask(id).orElseThrow(() -> new IllegalArgumentException("合排源需求族不存在: " + id)));
            String taskDim = StudioDemandPoolService.inferTaskDimension(task);
            if (expectSlit != "SLITTING_1D".equals(taskDim)) {
                throw new IllegalArgumentException("合排源需求族「" + task.name() + "」维度(" + taskDim + ")与方案维度(" + targetDimension + ")冲突");
            }
            CuttingTask.Line line = task.demands().stream().filter(l -> l.id() == alloc.lineId()).findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("合排源需求行不存在: " + task.id() + "#" + alloc.lineId()));
            Map<String, Integer> cMap = completedByTask.computeIfAbsent(task.id(), tx::completedQuantities);
            Map<String, Integer> pMap = plannedByTask.computeIfAbsent(task.id(), id -> demandPoolService.plannedQuantitiesForTask(tx, id, null));
            String lineKey = String.valueOf(line.id());
            int open = Math.max(0, line.quantity() - cMap.getOrDefault(lineKey, 0) - pMap.getOrDefault(lineKey, 0));
            if (alloc.quantity() > open) {
                throw new InventoryConflictException("源需求族「" + task.name() + "」的「" + line.name()
                        + "」当前剩余待排量为 " + open + "，小于本次合排分配量 " + alloc.quantity());
            }
        }
        return List.copyOf(merged.values());
    }

    /**
     * 为跨任务合排的 2D 裁片解析并回填精确的 (sourceTaskId, sourceLineId)，
     * 校验非补片总数量与 sourceAllocations 一致，并立即校验旋转许可。
     */
    private SchedulingScheme.Layout2DPayload bindPlacementsToSourceAllocations(
            SchedulingScheme.Layout2DPayload layout,
            List<DemandLineInput> cmdDemands,
            List<SchedulingScheme.TaskDemandAllocation> sourceAllocs,
            Map<String, CuttingTask> sourceTasks,
            boolean isContour
    ) {
        Map<Integer, DemandLineInput> demandByLocalId = new HashMap<>();
        if (cmdDemands != null) {
            for (DemandLineInput d : cmdDemands) {
                if (d != null && d.id() != null) demandByLocalId.put(d.id(), d);
            }
        }

        Map<String, Integer> remainingQuota = new LinkedHashMap<>();
        Map<String, CuttingTask.Line> lineByAllocKey = new LinkedHashMap<>();
        for (SchedulingScheme.TaskDemandAllocation alloc : sourceAllocs) {
            String key = alloc.taskId() + ":" + alloc.lineId();
            remainingQuota.put(key, alloc.quantity());
            CuttingTask t = sourceTasks.get(alloc.taskId());
            CuttingTask.Line line = t.demands().stream().filter(l -> l.id() == alloc.lineId()).findFirst().orElseThrow();
            lineByAllocKey.put(key, line);
        }

        List<SchedulingScheme.PlacementItem> boundPlacements = new ArrayList<>(layout.placements().size());
        for (SchedulingScheme.PlacementItem p : layout.placements()) {
            boolean isGapFill = Boolean.TRUE.equals(p.gapFill());
            String resolvedTaskId = p.sourceTaskId();
            Integer resolvedLineId = p.sourceLineId();

            if (resolvedTaskId == null || resolvedLineId == null) {
                DemandLineInput dInput = demandByLocalId.get(p.demandId());
                if (dInput != null && dInput.sourceTaskId() != null && dInput.sourceLineId() != null) {
                    resolvedTaskId = dInput.sourceTaskId().trim();
                    resolvedLineId = dInput.sourceLineId();
                }
            }

            if (resolvedTaskId != null && resolvedLineId != null) {
                String key = resolvedTaskId + ":" + resolvedLineId;
                CuttingTask.Line line = lineByAllocKey.get(key);
                if (line == null) {
                    throw new IllegalArgumentException("裁片「" + p.name() + "」标注的源需求 " + key + " 不在 sourceAllocations 中");
                }
                if (!isGapFill) {
                    int rem = remainingQuota.getOrDefault(key, 0);
                    if (rem <= 0) {
                        throw new IllegalArgumentException("裁片「" + p.name() + "」排入数量超出 sourceAllocations 声明量: " + key);
                    }
                    remainingQuota.put(key, rem - 1);
                }
            } else {
                // 未显式标注 sourceTaskId 时，按需求规格（宽/长/名称/demandId）从 sourceAllocations 剩余配额中匹配
                String matchedKey = matchPlacementToAllocationKey(p, remainingQuota, lineByAllocKey, isGapFill);
                if (matchedKey == null) {
                    throw new IllegalArgumentException("无法将合排裁片「" + p.name() + "」匹配到任何有效的 sourceAllocations 源需求行");
                }
                String[] parts = matchedKey.split(":", 2);
                resolvedTaskId = parts[0];
                resolvedLineId = Integer.parseInt(parts[1]);
                if (!isGapFill) {
                    remainingQuota.put(matchedKey, remainingQuota.get(matchedKey) - 1);
                }
            }

            CuttingTask.Line line = lineByAllocKey.get(resolvedTaskId + ":" + resolvedLineId);
            NestingProblem.Shape preservedShape = isContour
                    ? StudioMaterializer.preserveLineHoles(p.shape(), line.shape(), p.rotationDegrees())
                    : p.shape();
            double pw = preservedShape != null ? preservedShape.width() : p.w();
            double pl = preservedShape != null ? preservedShape.height() : p.l();
            StudioMaterializer.validatePlacementRotation(
                    line.name(), line.width(), line.length(), line.allowRotation(), line.allowHalfTurn(),
                    p.rotationDegrees(), pw, pl, isContour
            );

            boundPlacements.add(new SchedulingScheme.PlacementItem(
                    p.id(), p.demandId(), p.name(), p.x(), p.y(), p.w(), p.l(),
                    p.rotationDegrees(), p.gapFill(), preservedShape, resolvedTaskId, resolvedLineId
            ));
        }

        int unconsumed = remainingQuota.values().stream().mapToInt(Integer::intValue).sum();
        if (unconsumed > 0) {
            throw new IllegalArgumentException("sourceAllocations 声明总量超出实际排入非补片件数（多声明 " + unconsumed + " 件）");
        }
        return new SchedulingScheme.Layout2DPayload(boundPlacements, layout.leftovers(), layout.cuts());
    }

    private String matchPlacementToAllocationKey(
            SchedulingScheme.PlacementItem p,
            Map<String, Integer> remainingQuota,
            Map<String, CuttingTask.Line> lineByAllocKey,
            boolean isGapFill
    ) {
        double pw = p.shape() != null ? p.shape().width() : p.w();
        double pl = p.shape() != null ? p.shape().height() : p.l();
        String bestKey = null;
        int bestScore = -1;
        for (Map.Entry<String, CuttingTask.Line> entry : lineByAllocKey.entrySet()) {
            String key = entry.getKey();
            if (!isGapFill && remainingQuota.getOrDefault(key, 0) <= 0) continue;
            CuttingTask.Line line = entry.getValue();
            boolean sameDims = (Math.abs(line.width() - pw) < 0.5 && Math.abs(line.length() - pl) < 0.5)
                    || (Math.abs(line.width() - pl) < 0.5 && Math.abs(line.length() - pw) < 0.5);
            if (!sameDims) continue;
            int score = 1;
            if (line.name() != null && line.name().equals(p.name())) score += 4;
            if (line.id() == p.demandId()) score += 2;
            if (score > bestScore) {
                bestScore = score;
                bestKey = key;
            }
        }
        return bestKey;
    }

    private Map<String, CuttingTask> loadSourceTasksForScheme(CuttingStatePort.ReadView tx, SchedulingScheme scheme) {
        Map<String, CuttingTask> map = new LinkedHashMap<>();
        for (String tid : scheme.involvedTaskIds()) {
            tx.findTask(tid).ifPresent(t -> map.put(t.id(), t));
        }
        return map;
    }

    private Map<String, Object> enrichWithDemandFamilies(CuttingStatePort.ReadView tx, SchedulingScheme scheme) {
        Map<String, Object> out = new LinkedHashMap<>(enrichSchemeView(tx, scheme));
        List<Map<String, Object>> families = new ArrayList<>();
        for (String tid : scheme.involvedTaskIds()) {
            tx.findTask(tid).ifPresent(t -> families.add(demandPoolService.buildDemandFamilyView(tx, t)));
        }
        if (!families.isEmpty()) {
            out.put("demandFamily", families.get(0));
            if (families.size() > 1 || (scheme.sourceAllocations() != null && !scheme.sourceAllocations().isEmpty())) {
                out.put("demandFamilies", families);
            }
        }
        return out;
    }

    private static String resolveActor(String operator, String fallback) {
        if (operator == null || operator.isBlank()) return fallback;
        String clean = operator.trim();
        if (clean.length() > 100) clean = clean.substring(0, 100);
        if (clean.startsWith("MES:") || clean.startsWith("DECLARED:")) return clean;
        return "DECLARED:" + clean;
    }

    private Map<String, Object> buildMesDispatchPackage(SchedulingScheme s) {
        Map<String, Object> pkg = new LinkedHashMap<>();
        pkg.put("packageVersion", "2.0");
        pkg.put("schemeId", s.id());
        pkg.put("mesWorkOrderNo", s.mesWorkOrderNo() != null ? s.mesWorkOrderNo() : s.externalOrderNo());
        pkg.put("state", s.state());
        pkg.put("dimension", s.dimension());
        pkg.put("strategyName", s.strategyName());
        pkg.put("taskId", s.taskId());
        pkg.put("taskName", s.taskName());
        if (s.sourceAllocations() != null && !s.sourceAllocations().isEmpty()) {
            pkg.put("sourceAllocations", s.sourceAllocations());
        }
        pkg.put("materialBinding", Map.of(
                "mode", s.materialMode(),
                "materialModel", s.materialModel(),
                "rollId", Objects.toString(s.rollId(), ""),
                "remnantId", Objects.toString(s.remnantId(), ""),
                "widthMm", s.widthMm(),
                "windowStartY", s.windowStartY(),
                "occupiedLengthMm", s.occupiedLengthMm(),
                "suggestedRoll", s.suggestedRoll() != null ? s.suggestedRoll() : Map.of()
        ));
        pkg.put("metrics", Map.of(
                "utilizationPct", s.utilizationPct(),
                "pieceAreaM2", s.pieceAreaM2(),
                "placedCount", s.placedCount(),
                "requestedCount", s.requestedCount()
        ));
        pkg.put("allocatedDemands", s.allocatedDemands());
        pkg.put("layout2D", s.layout2D());
        pkg.put("slitting1D", s.slitting1D());
        pkg.put("linkedPlanIds", s.linkedPlanIds());
        return pkg;
    }

    private String resolveSchemeMaterialModel(CuttingStatePort.ReadView tx, ConfirmSchemeCommand cmd, String mode) {
        if ("STOCK_ROLL".equals(mode) && cmd.rollId() != null) {
            MotherRollInfo roll = tx.findRoll(cmd.rollId()).orElse(null);
            if (roll != null && roll.getRollModel() != null && !roll.getRollModel().isBlank()) {
                return roll.getRollModel();
            }
        }
        if ("REMNANT".equals(mode) && cmd.remnantId() != null) {
            RemnantStock rem = tx.findRemnant(cmd.remnantId()).orElse(null);
            if (rem != null && rem.getMaterialBatch() != null && !rem.getMaterialBatch().isBlank()) {
                return rem.getMaterialBatch();
            }
        }
        if (cmd.materialModel() != null && !cmd.materialModel().isBlank()) {
            return cmd.materialModel().trim();
        }
        return "VIRTUAL-" + Math.round(cmd.widthMm());
    }

    private CuttingTask resolveOrCreateTaskForScheme(CuttingStatePort.WriteTx tx, ConfirmSchemeCommand cmd, String dim, String effectiveModel) {
        if (cmd.taskId() != null && !cmd.taskId().isBlank()) {
            CuttingTask existing = tx.findTask(cmd.taskId().trim())
                    .orElseThrow(() -> new IllegalArgumentException("关联的需求族不存在: " + cmd.taskId()));
            if (!Objects.equals(existing.materialModel(), effectiveModel)
                    && ("STOCK_ROLL".equalsIgnoreCase(cmd.materialMode()) || "REMNANT".equalsIgnoreCase(cmd.materialMode()))
                    && tx.completedQuantities(existing.id()).isEmpty()) {
                CuttingTask aligned = existing.withMaterialModel(effectiveModel);
                return tx.saveTaskForScheme(aligned, null);
            }
            return existing;
        }
        if (cmd.demands() == null || cmd.demands().isEmpty()) {
            throw new IllegalArgumentException("请提供本次排程的需求明细或指定已有需求族编号");
        }
        SchedulingScheme.Slitting1DPayload slit = cmd.slitting1D();
        return demandPoolService.saveOrMergeTask(tx, new SaveDemandFamilyCommand(
                null,
                null,
                cmd.taskName() != null && !cmd.taskName().isBlank()
                        ? cmd.taskName().trim()
                        : ("排程需求 · " + (cmd.title() != null ? cmd.title() : LocalDateTime.now().format(DateTimeFormatter.ofPattern("MMdd-HHmm")))),
                effectiveModel,
                cmd.externalOrderNo(),
                dim,
                Math.max(500, cmd.occupiedLengthMm() + cmd.trimStartMm()),
                cmd.trimStartMm(),
                cmd.pieceGapMm(),
                slit != null ? slit.leftTrimMm() : 10,
                slit != null ? slit.rightTrimMm() : 10,
                slit != null ? slit.minWidthMm() : null,
                slit != null ? slit.maxWidthMm() : (int) Math.round(cmd.widthMm()),
                slit != null ? slit.widthStepMm() : 10,
                slit != null ? slit.totalOverCap() : 20,
                cmd.demands()
        ));
    }

    private Map<String, Object> rollSummaryMap(MotherRollInfo roll) {
        Map<String, Object> info = new LinkedHashMap<>();
        info.put("rollId", roll.getRollId());
        info.put("rollModel", roll.getRollModel());
        info.put("width", roll.getWidth());
        info.put("totalLength", roll.getTotalLength());
        info.put("usedLength", roll.getUsedLength());
        info.put("remainingLength", roll.getCurrentRemainingLength());
        info.put("storageLocation", Objects.toString(roll.getStorageLocation(), ""));
        info.put("inspectionStatus", Objects.toString(roll.getInspectionStatus(), ""));
        info.put("inspector", Objects.toString(roll.getInspector(), ""));
        info.put("defectCount", roll.getDefects() != null ? roll.getDefects().size() : 0);
        return info;
    }

    private Map<String, Object> enrichSchemeView(CuttingStatePort.ReadView tx, SchedulingScheme s) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("scheme", s);
        MotherRollInfo roll = s.rollId() != null ? tx.findRoll(s.rollId()).orElse(null) : null;
        if (roll != null) {
            map.put("rollInfo", rollSummaryMap(roll));
        }
        List<Map<String, Object>> planReceipts = new ArrayList<>();
        for (String pid : s.linkedPlanIds()) {
            Map<String, Object> r = tx.findReceipt(pid).orElse(null);
            if (r != null && !"REVERSED".equals(r.get("status"))) {
                planReceipts.add(tx.projectQuality(r));
            }
        }
        map.put("receipts", planReceipts);
        boolean needsRoll = SchedulingScheme.STATE_AWAITING_ROLL.equals(s.state())
                || (SchedulingScheme.STATE_DISPATCHED_MES.equals(s.state()) && s.linkedPlanIds().isEmpty());
        map.put("canBindRoll", needsRoll);
        map.put("canComplete", !needsRoll && (SchedulingScheme.STATE_READY_TO_CUT.equals(s.state()) || SchedulingScheme.STATE_DISPATCHED_MES.equals(s.state())));
        map.put("canCancel", s.occupiesDemand() && planReceipts.isEmpty());
        return map;
    }

    private static CuttingTask.Line findSlittingLine(CuttingTask task, SchedulingScheme.SlittingFulfillmentItem f) {
        if (f.orderId() != null) {
            for (CuttingTask.Line l : task.demands()) {
                if (String.valueOf(l.id()).equals(f.orderId().trim())) return l;
            }
        }
        return task.demands().stream()
                .filter(l -> Math.abs(l.width() - f.widthMm()) < 0.5)
                .findFirst().orElse(null);
    }
}
