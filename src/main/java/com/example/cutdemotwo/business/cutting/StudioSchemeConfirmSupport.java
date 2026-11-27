package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.persistence.InventoryConflictException;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;

/**
 * 排程方案确认落库与多族合排分配校验协作者。
 */
final class StudioSchemeConfirmSupport {
    private static final DateTimeFormatter TS_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private final CuttingStatePort statePort;
    private final StudioDemandPoolService demandPoolService;
    private final StudioMaterializer materializer;
    private final StudioSchemeViewSupport viewSupport;

    StudioSchemeConfirmSupport(
            CuttingStatePort statePort,
            StudioDemandPoolService demandPoolService,
            StudioMaterializer materializer,
            StudioSchemeViewSupport viewSupport
    ) {
        this.statePort = statePort;
        this.demandPoolService = demandPoolService;
        this.materializer = materializer;
        this.viewSupport = viewSupport;
    }

    Map<String, Object> confirmScheme(StudioCommandContracts.ConfirmSchemeInput cmd) {
        if (cmd == null) throw new IllegalArgumentException("方案确认请求不能为空");
        String idemKey = (cmd.idempotencyKey() == null || cmd.idempotencyKey().isBlank())
                ? "SCH-KEY-" + UUID.randomUUID()
                : cmd.idempotencyKey().trim();

        return statePort.inWrite(
                "DEMAND_ADJUSTMENT",
                idemKey,
                "UNAUTHENTICATED_LOCAL",
                tx -> tx.findSchemeByIdempotencyKey(idemKey).map(existing -> viewSupport.enrichWithDemandFamilies(tx, existing)).orElse(null),
                tx -> confirmSchemeInTx(tx, cmd, idemKey)
        );
    }

    private Map<String, Object> confirmSchemeInTx(
            CuttingStatePort.WriteTx tx,
            StudioCommandContracts.ConfirmSchemeInput cmd,
            String idemKey
    ) {
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
                            ? StudioLayoutValidator.preserveLineHoles(p.shape(), line.shape(), p.rotationDegrees())
                            : p.shape();
                    if (preservedShape != p.shape()) {
                        shapeEnriched = true;
                    }
                    double pw = preservedShape != null ? preservedShape.width() : p.w();
                    double pl = preservedShape != null ? preservedShape.height() : p.l();
                    StudioLayoutValidator.validatePlacementRotation(
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
            if (tx.listActiveSchemes().stream().anyMatch(s -> s.occupiesRemnant(rem.getId()))) {
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
        return viewSupport.enrichWithDemandFamilies(tx, scheme);
    }

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
            List<? extends StudioCommandContracts.DemandLineView> cmdDemands,
            List<SchedulingScheme.TaskDemandAllocation> sourceAllocs,
            Map<String, CuttingTask> sourceTasks,
            boolean isContour
    ) {
        Map<Integer, StudioCommandContracts.DemandLineView> demandByLocalId = new HashMap<>();
        if (cmdDemands != null) {
            for (StudioCommandContracts.DemandLineView d : cmdDemands) {
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
                StudioCommandContracts.DemandLineView dInput = demandByLocalId.get(p.demandId());
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
                    ? StudioLayoutValidator.preserveLineHoles(p.shape(), line.shape(), p.rotationDegrees())
                    : p.shape();
            double pw = preservedShape != null ? preservedShape.width() : p.w();
            double pl = preservedShape != null ? preservedShape.height() : p.l();
            StudioLayoutValidator.validatePlacementRotation(
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

    private String resolveSchemeMaterialModel(
            CuttingStatePort.ReadView tx,
            StudioCommandContracts.ConfirmSchemeInput cmd,
            String mode
    ) {
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

    private CuttingTask resolveOrCreateTaskForScheme(
            CuttingStatePort.WriteTx tx,
            StudioCommandContracts.ConfirmSchemeInput cmd,
            String dim,
            String effectiveModel
    ) {
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
        return demandPoolService.saveOrMergeTask(tx, new StudioCommandContracts.SimpleSaveDemandFamilyInput(
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
