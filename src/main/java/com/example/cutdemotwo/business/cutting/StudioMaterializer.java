package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.algorithm.api.NestingSolver;
import com.example.cutdemotwo.algorithm.api.ToolpathOptimizer;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.PieceDemand;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.business.model.SolveResponse;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.persistence.InventoryConflictException;

import java.util.*;
import java.util.stream.Collectors;

/**
 * 排程方案物理物化与无副作用手调校验协作者：
 * 1. 负责将 2D/1D 排程方案（含单任务与跨任务多族合排）在受控写事务内校验几何、旋转许可、区间互斥与疵点并落库为 PENDING 计划；
 * 2. 严格禁止反向篡改原任务 allowRotation / allowHalfTurn 许可，越权旋转直接报错拒绝；
 * 3. 1D 物化严格使用算法每车 allocations、禁止静默丢车，且 pieceSeq 跨车次全局递增；
 * 4. 将纯 2D 几何/刀路校验与母卷区间/槽位分配委托给 {@link StudioLayoutValidator} 与 {@link StudioRollSlotAllocator}。
 */
final class StudioMaterializer {

    record MaterializationResult(List<String> planIds, double startY, double occupiedLengthMm) {}

    private final NestingSolver solverFactory;
    private final StudioLayoutValidator layoutValidator;

    StudioMaterializer(NestingSolver solverFactory) {
        this(solverFactory, null);
    }

    StudioMaterializer(NestingSolver solverFactory, ToolpathOptimizer toolpathOptimizer) {
        this.solverFactory = solverFactory;
        this.layoutValidator = new StudioLayoutValidator(solverFactory, toolpathOptimizer);
    }

    MaterializationResult materialize2DPlanOnMaterial(
            CuttingStatePort.WriteTx tx,
            CuttingTask primaryTask,
            Map<String, CuttingTask> sourceTasks,
            List<SchedulingScheme.TaskDemandAllocation> sourceAllocations,
            boolean multiTask,
            MotherRollInfo roll,
            RemnantStock remnant,
            SchedulingScheme.Layout2DPayload layout,
            double widthMm,
            double occupiedLengthMm,
            double trimStartMm,
            double pieceGapMm,
            Double requestedStartY,
            String selfSchemeId
    ) {
        boolean remnantMode = remnant != null;
        double maxPieceEnd = layout.placements().stream()
                .mapToDouble(p -> p.y() + (p.shape() != null ? p.shape().height() : p.l()))
                .max().orElse(occupiedLengthMm);
        double effectiveLen = remnantMode
                ? remnant.getLength()
                : Math.max(Math.ceil(Math.max(occupiedLengthMm, maxPieceEnd) * 10.0) / 10.0, trimStartMm + 10);

        double startY = 0;
        if (!remnantMode) {
            startY = requestedStartY != null
                    ? requestedStartY
                    : StudioRollSlotAllocator.nextAvailableRollStart(tx, roll, effectiveLen, selfSchemeId);
            StudioRollSlotAllocator.assertRollIntervalFree(tx, roll, startY, effectiveLen, selfSchemeId);
        }

        boolean isContour = layout.placements().stream().anyMatch(p -> p.shape() != null && "POLYGON".equals(p.shape().type()))
                || (!multiTask && primaryTask.demands().stream().anyMatch(d -> d.shape() != null))
                || (multiTask && sourceTasks.values().stream().flatMap(t -> t.demands().stream()).anyMatch(d -> d.shape() != null));

        // 跨任务合排时，为每个 (taskId, lineId) 固定映射到 sourceAllocations 的 1-based 序号，确保持久化与重启后 100% 确定还原源任务归属
        Map<String, Integer> allocKeyToLocalId = new LinkedHashMap<>();
        if (multiTask && sourceAllocations != null) {
            for (int i = 0; i < sourceAllocations.size(); i++) {
                SchedulingScheme.TaskDemandAllocation a = sourceAllocations.get(i);
                allocKeyToLocalId.put(a.taskId() + ":" + a.lineId(), i + 1);
            }
        }

        // 统计每个局部 demandId 对应的源任务需求行与数量，并严格校验旋转许可（严禁篡改任务许可！）
        Map<Integer, CuttingTask.Line> lineByLocalDemandId = new LinkedHashMap<>();
        Map<Integer, Integer> countByLocalDemandId = new LinkedHashMap<>();
        List<Integer> resolvedLocalIds = new ArrayList<>(layout.placements().size());
        for (SchedulingScheme.PlacementItem p : layout.placements()) {
            CuttingTask.Line line = resolveSourceLineForPlacement(primaryTask, sourceTasks, multiTask, p);
            double pw = p.shape() != null ? p.shape().width() : p.w();
            double pl = p.shape() != null ? p.shape().height() : p.l();
            StudioLayoutValidator.validatePlacementRotation(line.name(), line.width(), line.length(), line.allowRotation(), line.allowHalfTurn(),
                    p.rotationDegrees(), pw, pl, isContour);
            int localId;
            if (multiTask && p.sourceTaskId() != null && p.sourceLineId() != null) {
                Integer mapped = allocKeyToLocalId.get(p.sourceTaskId() + ":" + p.sourceLineId());
                if (mapped == null) {
                    throw new IllegalArgumentException("合排裁片归属 " + p.sourceTaskId() + "#" + p.sourceLineId() + " 未登记在 sourceAllocations 中");
                }
                localId = mapped;
            } else {
                localId = p.demandId();
            }
            resolvedLocalIds.add(localId);
            lineByLocalDemandId.putIfAbsent(localId, line);
            countByLocalDemandId.merge(localId, 1, Integer::sum);
        }

        List<PieceDemand> reqDemands = new ArrayList<>();
        for (Map.Entry<Integer, Integer> e : countByLocalDemandId.entrySet()) {
            int localId = e.getKey();
            CuttingTask.Line line = lineByLocalDemandId.get(localId);
            PieceDemand pd = new PieceDemand(localId, line.name(), line.width(), line.length(), e.getValue(), line.allowRotation());
            pd.setShape(line.shape());
            if (line.allowHalfTurn() != null) pd.setAllowHalfTurn(line.allowHalfTurn());
            reqDemands.add(pd);
        }

        SolveRequest solveReq = new SolveRequest();
        if (!multiTask) {
            solveReq.setTaskId(primaryTask.id());
            solveReq.setTaskRevision(primaryTask.revision());
        }
        solveReq.setFeedPortType(remnantMode ? "remnant" : "roll");
        solveReq.setRollId(remnantMode ? remnant.getSourceRollId() : roll.getRollId());
        solveReq.setSourceRemnantId(remnantMode ? remnant.getId() : null);
        solveReq.setRollModel(remnantMode ? remnant.getMaterialBatch() : roll.getRollModel());
        solveReq.setRollW(widthMm);
        solveReq.setRollL(effectiveLen);
        solveReq.setTotalRollL(remnantMode ? remnant.getLength() : roll.getTotalLength());
        solveReq.setWindowStartY(remnantMode ? 0 : startY);
        solveReq.setTrimStart(isContour ? 0 : trimStartMm);
        solveReq.setPieceGap(pieceGapMm);
        solveReq.setCutOrigin("left-top");
        solveReq.setFirstStageOrientation("horizontal");
        solveReq.setAllowLongitudinal(true);
        // 注意：矩形工艺的全局 allowRotation 会覆盖单项 allowRotation，仅当所有参与需求都允许旋转时才置 true，防止误放行不可旋转件
        boolean allAllowRotation = !reqDemands.isEmpty() && reqDemands.stream().allMatch(PieceDemand::isAllowRotation);
        solveReq.setAllowRotation(allAllowRotation);
        solveReq.setMinRemnantWidth(150);
        solveReq.setMinRemnantLength(150);
        solveReq.setTimeLimitSeconds(5);
        solveReq.setDemands(reqDemands);

        if (!multiTask) {
            tx.prepareTaskSolve(solveReq);
            for (PieceDemand pd : solveReq.getDemands()) {
                CuttingTask.Line line = primaryTask.demands().stream().filter(d -> d.id() == pd.getId()).findFirst().orElseThrow();
                if (line.allowHalfTurn() != null) pd.setAllowHalfTurn(line.allowHalfTurn());
            }
        }
        List<Defect> rawDefs = remnantMode
                ? (remnant.getDefects() == null ? List.of() : remnant.getDefects())
                : (roll.getDefects() == null ? List.of() : roll.getDefects());
        solveReq.setDefects(DefectWindowSupport.sliceForWindow(rawDefs, remnantMode ? 0 : startY, effectiveLen, widthMm));

        List<PlacedPiece> pieces = new ArrayList<>();
        Set<Integer> usedPieceIds = new HashSet<>();
        int seqId = 1;
        for (int idx = 0; idx < layout.placements().size(); idx++) {
            SchedulingScheme.PlacementItem p = layout.placements().get(idx);
            int localId = resolvedLocalIds.get(idx);
            CuttingTask.Line line = lineByLocalDemandId.get(localId);
            int pid = p.id();
            if (pid <= 0 || !usedPieceIds.add(pid)) {
                while (!usedPieceIds.add(seqId)) {
                    seqId++;
                }
                pid = seqId;
            }
            seqId = Math.max(seqId, pid + 1);
            if (isContour) {
                int normDeg = Math.floorMod(p.rotationDegrees(), 360);
                NestingProblem.Shape placedShape = StudioLayoutValidator.preserveLineHoles(p.shape(), line.shape(), normDeg);
                if (placedShape == null) {
                    placedShape = NestingProblem.Shape.rectangle(line.width(), line.length());
                }
                PlacedPiece pp = new PlacedPiece(
                        pid, line.name(), p.x(), p.y(),
                        placedShape.width(), placedShape.height(),
                        normDeg % 180 != 0,
                        localId
                );
                pp.setShape(placedShape);
                pp.setRotationDegrees(normDeg);
                pieces.add(pp);
            } else {
                boolean rotated = (Math.floorMod(p.rotationDegrees(), 180) != 0)
                        || (Math.abs(p.w() - line.length()) < 0.01 && Math.abs(p.l() - line.width()) < 0.01 && Math.abs(line.width() - line.length()) > 0.01);
                double pw = rotated ? line.length() : line.width();
                double pl = rotated ? line.width() : line.length();
                pieces.add(new PlacedPiece(pid, line.name(), round1(p.x()), round1(p.y()), pw, pl, rotated, localId));
            }
        }

        SolveResponse validated;
        if (isContour) {
            validated = FabricSolveAdapter.adjust(solverFactory, solveReq, pieces);
        } else {
            try {
                validated = FabricSolveAdapter.adjust(solverFactory, solveReq, pieces);
            } catch (IllegalArgumentException horizErr) {
                // 单排满高或垂直首刀直刀方案无法以水平首刀分割时，尝试垂直首刀进行贯通切割校验
                solveReq.setFirstStageOrientation("vertical");
                try {
                    validated = FabricSolveAdapter.adjust(solverFactory, solveReq, pieces);
                } catch (IllegalArgumentException vertErr) {
                    solveReq.setFirstStageOrientation("horizontal");
                    throw horizErr;
                }
            }
        }
        if (!validated.isSuccess() || validated.getPieces() == null || validated.getPieces().isEmpty()) {
            throw new IllegalArgumentException(validated.getMessage() != null && !validated.getMessage().isBlank()
                    ? ("实卷几何/疵点校验未通过：" + validated.getMessage())
                    : "实卷区段内存在疵点干涉或边界越界，请更换母卷或开启实卷避疵重排");
        }

        String planId = tx.savePendingPlan(solveReq, validated);
        double finalLen = remnantMode ? remnant.getLength() : (validated.getDeductLen() > 0 ? validated.getDeductLen() : effectiveLen);
        return new MaterializationResult(List.of(planId), startY, finalLen);
    }

    MaterializationResult materialize1DPlansOnRoll(
            CuttingStatePort.WriteTx tx,
            CuttingTask primaryTask,
            Map<String, CuttingTask> sourceTasks,
            boolean multiTask,
            MotherRollInfo roll,
            SchedulingScheme.Slitting1DPayload slit,
            List<SchedulingScheme.TaskDemandAllocation> targetAllocations,
            boolean avoidDefects,
            Double requestedStartY,
            String selfSchemeId
    ) {
        double fixedLen = slit.fixedLengthMm();
        if (fixedLen <= 0) {
            throw new IllegalArgumentException("一维分切定长必须为正数");
        }
        int expectedTotalCars = slit.patterns().stream().mapToInt(p -> Math.max(0, p.repetitions())).sum();
        if (expectedTotalCars <= 0) {
            throw new IllegalArgumentException("一维分切方案缺少有效出车次数");
        }

        double totalEstimatedLen = slit.patterns().stream()
                .mapToDouble(p -> (double) (p.lengthMm() > 0 ? p.lengthMm() : (int) fixedLen) * Math.max(0, p.repetitions()))
                .sum();
        double cursorY;
        if (requestedStartY != null) {
            if (!Double.isFinite(requestedStartY) || requestedStartY < roll.getUsedLength() - 0.001) {
                throw new InventoryConflictException("分切起切位置 Y=" + requestedStartY + "mm 落入母卷已切割区 [0, " + round1(roll.getUsedLength()) + "mm]");
            }
            cursorY = requestedStartY;
        } else {
            cursorY = StudioRollSlotAllocator.nextAvailableRollStart(tx, roll, totalEstimatedLen, selfSchemeId);
        }
        double firstStartY = -1;
        double lastEndY = cursorY;

        // 建立全局剩余可分配配额（支持单任务与跨任务合排；跨任务严格按 targetAllocations 的 1-based 下标作为 localDemandId）
        Map<String, StudioRollSlotAllocator.SlittingSlot> slotsByKey = new LinkedHashMap<>();
        Map<String, Integer> globalRemaining = new LinkedHashMap<>();
        if (multiTask) {
            for (int i = 0; i < targetAllocations.size(); i++) {
                SchedulingScheme.TaskDemandAllocation alloc = targetAllocations.get(i);
                CuttingTask t = sourceTasks.get(alloc.taskId());
                if (t == null) continue;
                CuttingTask.Line line = t.demands().stream().filter(l -> l.id() == alloc.lineId()).findFirst()
                        .orElseThrow(() -> new IllegalArgumentException("合排分切需求行不存在: " + alloc.taskId() + "#" + alloc.lineId()));
                String key = alloc.taskId() + ":" + alloc.lineId();
                slotsByKey.put(key, new StudioRollSlotAllocator.SlittingSlot(alloc.taskId(), line, i + 1));
                globalRemaining.merge(key, alloc.quantity(), Integer::sum);
            }
        } else {
            Map<String, Integer> completed = tx.completedQuantities(primaryTask.id());
            for (CuttingTask.Line line : primaryTask.demands()) {
                String key = primaryTask.id() + ":" + line.id();
                slotsByKey.put(key, new StudioRollSlotAllocator.SlittingSlot(primaryTask.id(), line, line.id()));
                int rem = Math.max(0, line.quantity() - completed.getOrDefault(String.valueOf(line.id()), 0));
                globalRemaining.put(key, rem);
            }
        }

        // 若未传 pattern.allocations，则按 fulfillment 顺序约束配额上限，避免跨订单串单
        Map<String, Integer> fulfillmentRemaining = new LinkedHashMap<>();
        for (SchedulingScheme.SlittingFulfillmentItem f : slit.fulfillment()) {
            StudioRollSlotAllocator.SlittingSlot slot = StudioRollSlotAllocator.resolveSlotForOrderId(
                    slotsByKey, primaryTask.id(), f.orderId(), f.widthMm(), null, globalRemaining);
            if (slot != null && f.produced() > 0) {
                fulfillmentRemaining.merge(slot.taskId() + ":" + slot.line().id(), f.produced(), Integer::sum);
            }
        }

        List<String> planIds = new ArrayList<>();
        List<double[]> allocatedCarIntervals = new ArrayList<>();
        // 关键：全局递增 pieceSeq，彻底消除多车方案中每车从 1 编号导致单件判废误伤其他车次的问题
        int globalPieceSeq = 1;
        int carIndex = 0;

        for (SchedulingScheme.SlittingPatternItem pat : slit.patterns()) {
            if (pat.repetitions() <= 0) continue;
            int carLen = pat.lengthMm() > 0 ? pat.lengthMm() : (int) fixedLen;
            int requiredRollWidth = pat.usedWidthMm() + slit.leftTrimMm() + slit.rightTrimMm();
            if (requiredRollWidth > roll.getWidth() + 0.001) {
                throw new IllegalArgumentException("分切刀组 " + pat.id() + " 所需总门幅 " + requiredRollWidth
                        + "mm 超过母卷 " + roll.getRollId() + " 幅宽 " + round1(roll.getWidth()) + "mm");
            }

            // 为本 pattern 建立严格校验后的每刀组归属配额（若算法提供了 allocations 则严格按其分配，绝不盲猜）
            Map<String, Integer> patternAllocQuota = null;
            if (pat.allocations() != null && !pat.allocations().isEmpty()) {
                patternAllocQuota = new LinkedHashMap<>();
                for (SchedulingScheme.SlittingAllocationItem allocItem : pat.allocations()) {
                    if (allocItem == null || allocItem.quantity() <= 0) continue;
                    StudioRollSlotAllocator.SlittingSlot slot = StudioRollSlotAllocator.resolveSlotForOrderId(
                            slotsByKey, primaryTask.id(), allocItem.orderId(), -1, pat.surfaceTreatment(), globalRemaining);
                    if (slot == null) {
                        throw new IllegalArgumentException("分切刀组 " + pat.id() + " 的订单分配 " + allocItem.orderId()
                                + " 无法匹配有效任务需求行或表面处理工艺不一致");
                    }
                    if (pat.surfaceTreatment() != null && !pat.surfaceTreatment().isBlank()
                            && slot.line().surfaceTreatment() != null && !slot.line().surfaceTreatment().isBlank()
                            && !pat.surfaceTreatment().trim().equalsIgnoreCase(slot.line().surfaceTreatment().trim())) {
                        throw new IllegalArgumentException("分切刀组 " + pat.id() + " 表面处理(" + pat.surfaceTreatment()
                                + ")与订单「" + slot.line().name() + "」表面处理(" + slot.line().surfaceTreatment() + ")冲突");
                    }
                    String slotKey = slot.taskId() + ":" + slot.line().id();
                    patternAllocQuota.merge(slotKey, allocItem.quantity(), Integer::sum);
                }
            }

            for (int rep = 0; rep < pat.repetitions(); rep++) {
                carIndex++;
                List<PlacedPiece> carPieces = new ArrayList<>();
                Map<Integer, Integer> carDemandCounts = new LinkedHashMap<>();
                Map<Integer, StudioRollSlotAllocator.SlittingSlot> carLocalIdToSlot = new LinkedHashMap<>();
                double xCursor = slit.leftTrimMm();

                for (SchedulingScheme.StationItem st : pat.stations()) {
                    for (int k = 0; k < st.countPerRepetition(); k++) {
                        StudioRollSlotAllocator.SlittingSlot chosen = StudioRollSlotAllocator.pickSlittingSlot(
                                slotsByKey, st.widthMm(), pat.surfaceTreatment(),
                                patternAllocQuota, fulfillmentRemaining, globalRemaining
                        );
                        if (chosen == null) {
                            throw new IllegalArgumentException("分切刀组 " + pat.id() + " 第 " + carIndex
                                    + " 车工位宽度 " + st.widthMm() + "mm 缺少可匹配需求行或超出已校验分配配额");
                        }
                        String slotKey = chosen.taskId() + ":" + chosen.line().id();
                        if (patternAllocQuota != null) {
                            patternAllocQuota.put(slotKey, patternAllocQuota.get(slotKey) - 1);
                        }
                        if (fulfillmentRemaining.containsKey(slotKey)) {
                            fulfillmentRemaining.put(slotKey, Math.max(0, fulfillmentRemaining.get(slotKey) - 1));
                        }
                        if (globalRemaining.getOrDefault(slotKey, 0) > 0) {
                            globalRemaining.put(slotKey, globalRemaining.get(slotKey) - 1);
                        }
                        carDemandCounts.merge(chosen.localDemandId(), 1, Integer::sum);
                        carLocalIdToSlot.put(chosen.localDemandId(), chosen);
                        carPieces.add(new PlacedPiece(
                                globalPieceSeq++, chosen.line().name(), xCursor, 0,
                                chosen.line().width(), carLen, false, chosen.localDemandId()
                        ));
                        xCursor += chosen.line().width();
                    }
                }
                if (xCursor + slit.rightTrimMm() > roll.getWidth() + 0.001) {
                    throw new IllegalArgumentException("分切第 " + carIndex + " 车累计分条宽度与切边("
                            + round1(xCursor + slit.rightTrimMm()) + "mm)超过母卷幅宽(" + round1(roll.getWidth()) + "mm)");
                }
                if (carPieces.isEmpty()) {
                    throw new IllegalArgumentException("分切第 " + carIndex + " 车未能生成任何有效分切条");
                }

                double carStart = StudioRollSlotAllocator.findAvailableCarStart(
                        tx, roll, cursorY, carLen, carPieces, avoidDefects, selfSchemeId, allocatedCarIntervals);
                // 严禁 break 静默丢车：母卷余长放不下全部车次时必须报错拒绝并整事务回滚！
                if (carStart + carLen > roll.getTotalLength() + 0.001) {
                    throw new IllegalArgumentException("母卷 " + roll.getRollId() + " 剩余长度不足以排入全部 "
                            + expectedTotalCars + " 车（第 " + carIndex + " 车需区间 Y=" + round1(carStart) + "~"
                            + round1(carStart + carLen) + "mm，超出母卷总长 " + round1(roll.getTotalLength()) + "mm）");
                }
                StudioRollSlotAllocator.assertRollIntervalFree(tx, roll, carStart, carLen, selfSchemeId);
                allocatedCarIntervals.add(new double[]{carStart, carStart + carLen});

                List<PieceDemand> reqDemands = new ArrayList<>();
                for (Map.Entry<Integer, Integer> entry : carDemandCounts.entrySet()) {
                    StudioRollSlotAllocator.SlittingSlot slot = carLocalIdToSlot.get(entry.getKey());
                    reqDemands.add(new PieceDemand(slot.localDemandId(), slot.line().name(), slot.line().width(), carLen, entry.getValue(), false));
                }

                SolveRequest req = new SolveRequest();
                if (!multiTask) {
                    req.setTaskId(primaryTask.id());
                    req.setTaskRevision(primaryTask.revision());
                }
                req.setFeedPortType("roll");
                req.setRollId(roll.getRollId());
                req.setRollModel(roll.getRollModel());
                req.setRollW(roll.getWidth());
                req.setRollL(carLen);
                req.setTotalRollL(roll.getTotalLength());
                req.setWindowStartY(carStart);
                req.setTrimStart(0);
                req.setPieceGap(0);
                req.setCutOrigin("left-top");
                req.setFirstStageOrientation("vertical");
                req.setAllowLongitudinal(true);
                req.setAllowRotation(false);
                req.setMinRemnantWidth(150);
                req.setMinRemnantLength(150);
                req.setTimeLimitSeconds(5);
                req.setDemands(reqDemands);

                if (!multiTask) {
                    tx.prepareTaskSolve(req);
                }
                req.setDefects(DefectWindowSupport.sliceForWindow(
                        roll.getDefects() == null ? List.of() : roll.getDefects(),
                        carStart, carLen, roll.getWidth()
                ));

                SolveResponse validated = FabricSolveAdapter.adjust(solverFactory, req, carPieces);
                if (!validated.isSuccess() || validated.getPieces().isEmpty()) {
                    throw new IllegalArgumentException("分切第 " + carIndex + " 车在母卷 Y=" + round1(carStart)
                            + "mm 处未通过几何/疵点校验：" + Objects.toString(validated.getMessage(), ""));
                }
                String pid = tx.savePendingPlan(req, validated);
                planIds.add(pid);

                if (firstStartY < 0) firstStartY = carStart;
                lastEndY = carStart + carLen;
                cursorY = lastEndY;
            }
        }

        if (planIds.size() != expectedTotalCars) {
            throw new IllegalArgumentException("分切实际生成车次(" + planIds.size() + ")与方案车次(" + expectedTotalCars + ")不一致");
        }
        return new MaterializationResult(planIds, firstStartY, lastEndY - firstStartY);
    }

    void validateVirtual2DGeometry(
            SchedulingScheme.Layout2DPayload layout,
            double widthMm,
            double heightMm,
            double trimStartMm,
            double pieceGapMm
    ) {
        layoutValidator.validateVirtual2DGeometry(layout, widthMm, heightMm, trimStartMm, pieceGapMm);
    }

    Map<String, Object> validateManualLayout(
            CuttingStatePort.ReadView tx,
            StudioCommandContracts.ValidateLayoutInput req
    ) {
        return layoutValidator.validateManualLayout(tx, req);
    }

    static void validatePlacementRotation(
            String pieceName,
            double lineW,
            double lineL,
            boolean allowRotation,
            Boolean allowHalfTurn,
            int rotationDegrees,
            double placedW,
            double placedL,
            boolean isContour
    ) {
        StudioLayoutValidator.validatePlacementRotation(
                pieceName, lineW, lineL, allowRotation, allowHalfTurn, rotationDegrees, placedW, placedL, isContour);
    }

    CuttingTask appendGapFillLinesIfNeeded(CuttingStatePort.WriteTx tx, CuttingTask task, SchedulingScheme.Layout2DPayload layout, String exceptSchemeId) {
        if (layout == null) return task;
        Map<Integer, Long> totalPlacedByDemand = layout.placements().stream()
                .collect(Collectors.groupingBy(SchedulingScheme.PlacementItem::demandId, Collectors.counting()));
        List<CuttingTask.Line> nextLines = new ArrayList<>(task.demands());
        boolean changed = false;
        for (int i = 0; i < nextLines.size(); i++) {
            CuttingTask.Line line = nextLines.get(i);
            long needed = totalPlacedByDemand.getOrDefault(line.id(), 0L);
            if (needed > line.quantity()) {
                nextLines.set(i, new CuttingTask.Line(
                        line.id(), line.name(), line.width(), line.length(),
                        (int) needed, line.allowRotation(), line.shape(),
                        line.allowHalfTurn(), line.sizeLabel(), line.sourceTemplateId(), line.surfaceTreatment()
                ));
                changed = true;
            }
        }
        if (!changed) return task;
        return tx.saveTaskForScheme(task.withDemands(nextLines), exceptSchemeId);
    }

    private CuttingTask.Line resolveSourceLineForPlacement(
            CuttingTask primaryTask,
            Map<String, CuttingTask> sourceTasks,
            boolean multiTask,
            SchedulingScheme.PlacementItem p
    ) {
        if (multiTask && p.sourceTaskId() != null && p.sourceLineId() != null) {
            CuttingTask t = sourceTasks.get(p.sourceTaskId());
            if (t == null) {
                throw new IllegalArgumentException("合排裁片引用的源需求族不存在: " + p.sourceTaskId());
            }
            return t.demands().stream().filter(d -> d.id() == p.sourceLineId()).findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("合排裁片引用的源需求行不存在: " + p.sourceTaskId() + "#" + p.sourceLineId()));
        }
        return primaryTask.demands().stream().filter(d -> d.id() == p.demandId()).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("方案裁片缺少对应任务需求行: #" + p.demandId()));
    }

    static NestingProblem.Shape preserveLineHoles(
            NestingProblem.Shape placedShape,
            NestingProblem.Shape lineShape,
            int rotationDegrees
    ) {
        return StudioLayoutValidator.preserveLineHoles(placedShape, lineShape, rotationDegrees);
    }

    private static double round1(double v) {
        return Math.rint(v * 10.0) / 10.0;
    }
}
