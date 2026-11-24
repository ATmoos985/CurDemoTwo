package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.algorithm.api.NestingSolver;
import com.example.cutdemotwo.business.model.CutReport;
import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.DemandTemplate;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
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
 * 串联「需求模板库 → 多维待排需求池 → 搭切方案冻结落库（虚拟新母卷 / 在库实卷）→ 实卷绑定 / 一键完工过账 / 母卷切割空间图 / MES 协同」。
 * 通过 {@link CuttingStatePort} 与底层库存事务引擎解耦，并将模板/需求池、物理物化与空间剖面查询委托给内聚协作者。
 */
@Service
public class SchedulingStudioService {
    private static final DateTimeFormatter TS_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private final CuttingStatePort statePort;
    private final StudioDemandPoolService demandPoolService;
    private final StudioMaterializer materializer;
    private final MotherRollSpatialMapQuery spatialMapQuery;

    @Autowired
    public SchedulingStudioService(RemnantService inventory, NestingSolver solverFactory) {
        this((CuttingStatePort) inventory, solverFactory);
    }

    SchedulingStudioService(CuttingStatePort statePort, NestingSolver solverFactory) {
        this.statePort = statePort;
        this.demandPoolService = new StudioDemandPoolService(statePort);
        this.materializer = new StudioMaterializer(solverFactory);
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
            List<DemandLineInput> demands
    ) {}

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
            NestingProblem.Shape shape
    ) {}

    public List<Map<String, Object>> listDemandPool() {
        return demandPoolService.listDemandPool();
    }

    public Map<String, Object> getDemandFamily(String taskId) {
        return demandPoolService.getDemandFamily(taskId);
    }

    public Map<String, Object> saveOrMergeDemandFamily(SaveDemandFamilyCommand cmd) {
        return demandPoolService.saveOrMergeDemandFamily(cmd);
    }

    // ==================== 3. 搭切后选定方案、绑实卷、完工过账与回滚 ====================

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
            SchedulingScheme.Slitting1DPayload slitting1D
    ) {}

    public record BindRollCommand(
            String rollId,
            Boolean autoCreateRoll,
            Double newRollLengthMm,
            String storageLocation,
            Double windowStartY
    ) {}

    public record CompleteSchemeCommand(
            Double actualCutLenMm,
            List<Integer> rejectedPieceIds,
            Boolean recoverRemnants,
            String remnantLocation,
            String operator
    ) {}

    public List<Map<String, Object>> listSchemes(String stateFilter, String taskIdFilter) {
        return statePort.inRead(tx -> {
            List<SchedulingScheme> list = new ArrayList<>(tx.listSchemes());
            Collections.reverse(list);
            List<Map<String, Object>> out = new ArrayList<>();
            for (SchedulingScheme s : list) {
                if (stateFilter != null && !stateFilter.isBlank() && !"ALL".equalsIgnoreCase(stateFilter)
                        && !stateFilter.equalsIgnoreCase(s.state())) {
                    continue;
                }
                if (taskIdFilter != null && !taskIdFilter.isBlank() && !taskIdFilter.equals(s.taskId())) {
                    continue;
                }
                out.add(enrichSchemeView(tx, s));
            }
            return out;
        });
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

        return statePort.inWrite("DEMAND_ADJUSTMENT", idemKey, "UNAUTHENTICATED_LOCAL", tx -> {
            Optional<SchedulingScheme> existingScheme = tx.findSchemeByIdempotencyKey(idemKey);
            if (existingScheme.isPresent()) {
                return enrichSchemeView(tx, existingScheme.get());
            }

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

            // 1. 解析或自动创建所属需求族 (CuttingTask)
            String effectiveMaterialModel = resolveSchemeMaterialModel(tx, cmd, mode);
            CuttingTask task = resolveOrCreateTaskForScheme(tx, cmd, dim, effectiveMaterialModel);

            // 2. 核算本次扣减的待排需求 (allocatedDemands) 并校验不超出 openQty
            Map<String, Integer> completedMap = tx.completedQuantities(task.id());
            Map<String, Integer> plannedMap = demandPoolService.plannedQuantitiesForTask(tx, task.id(), null);
            Map<String, Integer> allocated = new LinkedHashMap<>();
            int placedCount = 0;
            int gapFillCount = 0;
            int requestedCount = task.demands().stream().mapToInt(CuttingTask.Line::quantity).sum();

            if (!isSlit) {
                Map<Integer, Integer> rawPlacedByDemand = new LinkedHashMap<>();
                for (SchedulingScheme.PlacementItem p : cmd.layout2D().placements()) {
                    placedCount++;
                    if (Boolean.TRUE.equals(p.gapFill())) {
                        gapFillCount++;
                    } else {
                        rawPlacedByDemand.merge(p.demandId(), 1, Integer::sum);
                    }
                }
                for (Map.Entry<Integer, Integer> entry : rawPlacedByDemand.entrySet()) {
                    String lineKey = String.valueOf(entry.getKey());
                    CuttingTask.Line line = task.demands().stream().filter(l -> l.id() == entry.getKey()).findFirst()
                            .orElseThrow(() -> new IllegalArgumentException("排布裁片引用的需求行不存在: #" + entry.getKey()));
                    int open = Math.max(0, line.quantity() - completedMap.getOrDefault(lineKey, 0) - plannedMap.getOrDefault(lineKey, 0));
                    if (entry.getValue() > open) {
                        throw new InventoryConflictException("需求「" + line.name() + "」当前剩余待排量为 " + open + "，小于方案排入量 " + entry.getValue());
                    }
                    allocated.put(lineKey, entry.getValue());
                }
                if (gapFillCount > 0 && completedMap.isEmpty()) {
                    task = materializer.appendGapFillLinesIfNeeded(tx, task, cmd.layout2D());
                }
            } else {
                SchedulingScheme.Slitting1DPayload slit = cmd.slitting1D();
                placedCount = slit.fulfillment().stream().mapToInt(SchedulingScheme.SlittingFulfillmentItem::produced).sum();
                for (SchedulingScheme.SlittingFulfillmentItem f : slit.fulfillment()) {
                    CuttingTask.Line line = findSlittingLine(task, f);
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

            String schemeId = "SCH-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("MMddHHmm"))
                    + "-" + UUID.randomUUID().toString().substring(0, 4).toUpperCase();
            String nowStr = LocalDateTime.now().format(TS_FMT);
            double occupiedLen = isSlit
                    ? (double) cmd.slitting1D().totalCars() * cmd.slitting1D().fixedLengthMm()
                    : Math.max(1, cmd.occupiedLengthMm());

            SchedulingScheme.SuggestedRollSpec suggestedRoll = new SchedulingScheme.SuggestedRollSpec(
                    task.materialModel(),
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
                StudioMaterializer.MaterializationResult mat = isSlit
                        ? materializer.materialize1DPlansOnRoll(tx, task, roll, cmd.slitting1D(), Boolean.TRUE.equals(cmd.avoidDefects()), cmd.windowStartY(), null)
                        : materializer.materialize2DPlanOnMaterial(tx, task, roll, null, cmd.layout2D(), cmd.widthMm(), occupiedLen, cmd.trimStartMm(), cmd.pieceGapMm(), cmd.windowStartY(), null);
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
                StudioMaterializer.MaterializationResult mat = materializer.materialize2DPlanOnMaterial(
                        tx, task, null, rem, cmd.layout2D(), rem.getWidth(), rem.getLength(), cmd.trimStartMm(), cmd.pieceGapMm(), 0.0, null);
                linkedPlans = mat.planIds();
                startY = 0;
                occupiedLen = rem.getLength();
                boundRollId = rem.getSourceRollId();
                boundRemnantId = rem.getId();
                initialState = SchedulingScheme.STATE_READY_TO_CUT;
            } else {
                if (!isSlit) {
                    materializer.validateVirtual2DGeometry(cmd.layout2D(), cmd.widthMm(), Math.max(cmd.canvasLengthMm(), occupiedLen), cmd.pieceGapMm());
                }
            }

            boolean isComplete = allocated.values().stream().mapToInt(Integer::intValue).sum()
                    + completedMap.values().stream().mapToInt(Integer::intValue).sum()
                    + plannedMap.values().stream().mapToInt(Integer::intValue).sum() >= requestedCount;

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
                    task.id(),
                    task.name(),
                    task.externalRef(),
                    mode,
                    boundRollId,
                    boundRemnantId,
                    task.materialModel(),
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
                    cmd.layout2D(),
                    cmd.slitting1D(),
                    null,
                    nowStr,
                    null,
                    null,
                    null,
                    null
            );

            tx.putScheme(scheme);
            Map<String, Object> response = new LinkedHashMap<>(enrichSchemeView(tx, scheme));
            response.put("demandFamily", demandPoolService.buildDemandFamilyView(tx, task));
            return response;
        });
    }

    /**
     * 将虚拟新母卷方案（AWAITING_ROLL）绑定到真实在库母卷（或按建议规格一键入库新母卷并绑定）。
     */
    public Map<String, Object> bindRollToScheme(String schemeId, BindRollCommand cmd) {
        if (schemeId == null || schemeId.isBlank()) throw new IllegalArgumentException("请指定排程方案编号");
        return statePort.inWrite("ROLL_RECEIPT_OR_UPDATE", schemeId, "UNAUTHENTICATED_LOCAL", tx -> {
            SchedulingScheme scheme = tx.findScheme(schemeId)
                    .orElseThrow(() -> new IllegalArgumentException("排程方案不存在: " + schemeId));
            if (SchedulingScheme.STATE_READY_TO_CUT.equals(scheme.state()) && Objects.equals(scheme.rollId(), cmd != null ? cmd.rollId() : null)) {
                return enrichSchemeView(tx, scheme);
            }
            if (!SchedulingScheme.STATE_AWAITING_ROLL.equals(scheme.state())
                    && !(SchedulingScheme.STATE_DISPATCHED_MES.equals(scheme.state()) && scheme.linkedPlanIds().isEmpty())) {
                throw new InventoryConflictException("仅未绑定实卷的虚拟母卷方案可执行绑卷，当前状态：" + scheme.state());
            }

            CuttingTask task = tx.findTask(scheme.taskId())
                    .orElseThrow(() -> new IllegalArgumentException("方案关联的需求族不存在"));

            MotherRollInfo roll;
            if (cmd != null && Boolean.TRUE.equals(cmd.autoCreateRoll())) {
                String newRollId = (cmd.rollId() == null || cmd.rollId().isBlank())
                        ? "ROLL-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("MMddHHmm")) + "-" + UUID.randomUUID().toString().substring(0, 3).toUpperCase()
                        : cmd.rollId().trim();
                double minReqLen = Math.max(5000, Math.ceil(scheme.occupiedLengthMm() + scheme.trimStartMm()));
                double totalLen = (cmd.newRollLengthMm() != null && cmd.newRollLengthMm() >= minReqLen)
                        ? cmd.newRollLengthMm()
                        : Math.max(minReqLen, Math.ceil(minReqLen / 1000.0) * 1000.0 + 10000);
                MotherRollInfo fresh = new MotherRollInfo(
                        newRollId,
                        task.materialModel(),
                        "BAT-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd")),
                        "按方案备料入库",
                        task.materialModel(),
                        "标准色",
                        220.0,
                        "标准材质",
                        scheme.widthMm(),
                        totalLen,
                        (cmd.storageLocation() == null || cmd.storageLocation().isBlank()) ? "裁床线边备料区 L-01" : cmd.storageLocation().trim()
                );
                fresh.setInspectionStatus("PASSED");
                fresh.setInspector("系统备料直通合格");
                fresh.setInspectionDate(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd")));
                roll = tx.saveRoll(fresh);
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
                if (!Objects.equals(task.materialModel(), roll.getRollModel())
                        && tx.completedQuantities(task.id()).isEmpty()) {
                    CuttingTask aligned = new CuttingTask(
                            task.id(), task.name(), roll.getRollModel(), task.externalRef(),
                            task.revision(), task.demands(), task.process(), task.problemType(), task.slitting()
                    );
                    task = tx.saveTask(aligned);
                }
            }

            boolean isSlit = "SLITTING_1D".equals(scheme.dimension());
            if (!isSlit && scheme.gapFillCount() > 0 && tx.completedQuantities(task.id()).isEmpty()) {
                task = materializer.appendGapFillLinesIfNeeded(tx, task, scheme.layout2D());
            }

            StudioMaterializer.MaterializationResult mat = isSlit
                    ? materializer.materialize1DPlansOnRoll(tx, task, roll, scheme.slitting1D(), true, cmd != null ? cmd.windowStartY() : null, scheme.id())
                    : materializer.materialize2DPlanOnMaterial(tx, task, roll, null, scheme.layout2D(), roll.getWidth(), scheme.occupiedLengthMm(), scheme.trimStartMm(), scheme.pieceGapMm(), cmd != null ? cmd.windowStartY() : null, scheme.id());

            SchedulingScheme updated = new SchedulingScheme(
                    scheme.id(), scheme.idempotencyKey(), scheme.title(), scheme.dimension(),
                    scheme.scenarioId(), scheme.strategyId(), scheme.strategyName(),
                    task.id(), task.name(), scheme.externalOrderNo(),
                    "STOCK_ROLL", roll.getRollId(), null, task.materialModel(),
                    roll.getWidth(), scheme.canvasLengthMm(), mat.startY(), mat.occupiedLengthMm(),
                    scheme.trimStartMm(), scheme.pieceGapMm(), scheme.utilizationPct(), scheme.pieceAreaM2(),
                    scheme.placedCount(), scheme.requestedCount(), scheme.gapFillCount(), scheme.complete(),
                    scheme.allocatedDemands(), mat.planIds(), null,
                    SchedulingScheme.STATE_DISPATCHED_MES.equals(scheme.state())
                            ? SchedulingScheme.STATE_DISPATCHED_MES
                            : SchedulingScheme.STATE_READY_TO_CUT,
                    scheme.suggestedRoll(),
                    scheme.layout2D(), scheme.slitting1D(), scheme.mesWorkOrderNo(),
                    scheme.createdAt(), scheme.dispatchedAt(), scheme.completedAt(), scheme.cancelledAt(), scheme.cancelReason()
            );
            tx.putScheme(updated);
            return enrichSchemeView(tx, updated);
        });
    }

    /**
     * 一键完工记账（或 MES 实切完工核销）：
     * 原子执行底层 CuttingPlan 报工，扣减实卷长度（转为已切割区域）、登记派生余料入库、将 plannedQty 结转为 completedQty。
     */
    public Map<String, Object> completeScheme(String schemeId, CompleteSchemeCommand cmd) {
        if (schemeId == null || schemeId.isBlank()) throw new IllegalArgumentException("请指定排程方案编号");
        return statePort.inWrite("CUT_REPORT", schemeId, "UNAUTHENTICATED_LOCAL", tx -> {
            SchedulingScheme scheme = tx.findScheme(schemeId)
                    .orElseThrow(() -> new IllegalArgumentException("排程方案不存在: " + schemeId));
            if (SchedulingScheme.STATE_COMPLETED.equals(scheme.state())) {
                return enrichSchemeView(tx, scheme);
            }
            if (SchedulingScheme.STATE_AWAITING_ROLL.equals(scheme.state())) {
                throw new IllegalArgumentException("该方案使用的是虚拟新母卷，请先绑定在库实卷（或一键建卷绑定）后再执行完工过账");
            }
            if (SchedulingScheme.STATE_CANCELLED.equals(scheme.state())) {
                throw new InventoryConflictException("已作废方案不能执行完工过账");
            }
            if (scheme.linkedPlanIds().isEmpty()) {
                throw new IllegalArgumentException("方案缺少已锁定的机台切割计划明细");
            }

            Set<Integer> rejectedIds = (cmd != null && cmd.rejectedPieceIds() != null)
                    ? new HashSet<>(cmd.rejectedPieceIds())
                    : Set.of();
            boolean recoverRems = cmd == null || cmd.recoverRemnants() == null || cmd.recoverRemnants();
            String remLoc = (cmd != null && cmd.remnantLocation() != null && !cmd.remnantLocation().isBlank())
                    ? cmd.remnantLocation().trim()
                    : "裁床余料架 A-01";

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
                for (PlacedPiece pc : plan.result().getPieces()) {
                    boolean isRejected = rejectedIds.contains(pc.getId());
                    pieceResults.add(new CutReport.PieceResult(
                            pc.getId(),
                            isRejected ? "REJECTED" : "QUALIFIED",
                            isRejected ? "实切异常判废" : ""
                    ));
                    if (!isRejected) qualifiedCount++;
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
                Map<String, Object> confirmed = tx.confirmPlan(report, batchReported);
                receiptsOut.add(confirmed);
                batchReported.add(planId);
            }

            SchedulingScheme completedScheme = scheme.withCompleted(LocalDateTime.now().format(TS_FMT));
            tx.putScheme(completedScheme);

            Map<String, Object> out = new LinkedHashMap<>(enrichSchemeView(tx, completedScheme));
            out.put("receipts", receiptsOut);
            tx.findTask(scheme.taskId()).ifPresent(task ->
                    out.put("demandFamily", demandPoolService.buildDemandFamilyView(tx, task)));
            return out;
        });
    }

    /**
     * 作废未实切的排程方案：自动取消底层未报工计划，释放实卷预占区段，并将占用的 plannedQty 退回待排需求池 openQty。
     */
    public Map<String, Object> cancelScheme(String schemeId, String reason) {
        if (schemeId == null || schemeId.isBlank()) throw new IllegalArgumentException("请指定排程方案编号");
        String why = (reason == null || reason.isBlank()) ? "排料员手动取消方案重排" : reason.trim();
        return statePort.inWrite("DEMAND_ADJUSTMENT", schemeId, "UNAUTHENTICATED_LOCAL", tx -> {
            SchedulingScheme scheme = tx.findScheme(schemeId)
                    .orElseThrow(() -> new IllegalArgumentException("排程方案不存在: " + schemeId));
            if (SchedulingScheme.STATE_CANCELLED.equals(scheme.state())) {
                return enrichSchemeView(tx, scheme);
            }
            if (SchedulingScheme.STATE_COMPLETED.equals(scheme.state())) {
                throw new InventoryConflictException("已完工记账方案不可直接作废；若发现裁片不良请使用「复检补排」功能");
            }
            for (String pid : scheme.linkedPlanIds()) {
                tx.cancelPendingPlan(pid);
            }
            SchedulingScheme cancelled = scheme.withCancelled(LocalDateTime.now().format(TS_FMT), why);
            tx.putScheme(cancelled);
            Map<String, Object> out = new LinkedHashMap<>(enrichSchemeView(tx, cancelled));
            tx.findTask(scheme.taskId()).ifPresent(task ->
                    out.put("demandFamily", demandPoolService.buildDemandFamilyView(tx, task)));
            return out;
        });
    }

    // ==================== 4. 母卷切割与疵点空间剖面图 (Mother Roll Spatial Map) ====================

    public Map<String, Object> getMotherRollSpatialMap(String rollId) {
        return spatialMapQuery.getMotherRollSpatialMap(rollId);
    }

    // ==================== 5. MES 协同接口 (Orders / Dispatch Package / Feedback) ====================

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

    public Map<String, Object> syncMesOrder(MesOrderSyncCommand cmd) {
        if (cmd == null || cmd.mesWorkOrderNo() == null || cmd.mesWorkOrderNo().isBlank()) {
            throw new IllegalArgumentException("MES 工单号 (mesWorkOrderNo) 不能为空");
        }
        String wo = cmd.mesWorkOrderNo().trim();
        CuttingTask existing = statePort.inRead(tx -> tx.findTaskByExternalRef(wo).orElse(null));
        if (existing != null) {
            return getDemandFamily(existing.id());
        }
        return saveOrMergeDemandFamily(new SaveDemandFamilyCommand(
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
    }

    public Map<String, Object> dispatchSchemeToMes(String schemeId, String mesWorkOrderNo) {
        return statePort.inWrite("SYSTEM_UPDATE", schemeId, "MES_DISPATCHER", tx -> {
            SchedulingScheme s = tx.findScheme(schemeId)
                    .orElseThrow(() -> new IllegalArgumentException("排程方案不存在: " + schemeId));
            if (SchedulingScheme.STATE_CANCELLED.equals(s.state())) {
                throw new InventoryConflictException("已作废方案不能下发 MES");
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

    public Map<String, Object> receiveMesFeedback(MesFeedbackCommand cmd) {
        if (cmd == null || cmd.schemeId() == null || cmd.schemeId().isBlank()) {
            throw new IllegalArgumentException("请提供回传的排程方案号 schemeId");
        }
        SchedulingScheme current = statePort.inRead(tx -> tx.findScheme(cmd.schemeId()).orElse(null));
        if (current == null) throw new IllegalArgumentException("排程方案不存在: " + cmd.schemeId());
        if (SchedulingScheme.STATE_COMPLETED.equals(current.state())) {
            return getSchemeDetail(current.id());
        }
        if (SchedulingScheme.STATE_AWAITING_ROLL.equals(current.state()) || current.linkedPlanIds().isEmpty()) {
            if (cmd.scannedRollId() == null || cmd.scannedRollId().isBlank()) {
                throw new IllegalArgumentException("虚拟母卷方案在 MES 完工回传时必须携带机台实扫母卷条码 scannedRollId");
            }
            bindRollToScheme(current.id(), new BindRollCommand(cmd.scannedRollId().trim(), false, null, null, null));
        }
        return completeScheme(current.id(), new CompleteSchemeCommand(
                cmd.actualCutLenMm(),
                cmd.rejectedPieceIds(),
                cmd.recoverRemnants(),
                cmd.remnantLocation(),
                "MES:" + Objects.toString(cmd.mesReceiptNo(), "CALLBACK")
        ));
    }

    // ==================== 内部视图装配与方案解析辅助 ====================

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
                CuttingTask aligned = new CuttingTask(
                        existing.id(), existing.name(), effectiveModel, existing.externalRef(),
                        existing.revision(), existing.demands(), existing.process(), existing.problemType(), existing.slitting()
                );
                return tx.saveTask(aligned);
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

    private Map<String, Object> enrichSchemeView(CuttingStatePort.ReadView tx, SchedulingScheme s) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("scheme", s);
        MotherRollInfo roll = s.rollId() != null ? tx.findRoll(s.rollId()).orElse(null) : null;
        if (roll != null) {
            map.put("rollInfo", Map.of(
                    "rollId", roll.getRollId(),
                    "rollModel", roll.getRollModel(),
                    "width", roll.getWidth(),
                    "totalLength", roll.getTotalLength(),
                    "usedLength", roll.getUsedLength(),
                    "remainingLength", roll.getCurrentRemainingLength(),
                    "storageLocation", Objects.toString(roll.getStorageLocation(), ""),
                    "defectCount", roll.getDefects() != null ? roll.getDefects().size() : 0
            ));
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
