package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.algorithm.api.NestingSolver;
import com.example.cutdemotwo.algorithm.api.ToolpathOptimizer;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.PieceDemand;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.business.model.SolveResponse;
import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.contracts.geometry.RemnantPiece;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.persistence.InventoryConflictException;

import java.awt.geom.Area;
import java.awt.geom.Line2D;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 排程方案物理物化与无副作用手调校验协作者：
 * 1. 负责将 2D/1D 排程方案（含单任务与跨任务多族合排）在受控写事务内校验几何、旋转许可、区间互斥与疵点并落库为 PENDING 计划；
 * 2. 严格禁止反向篡改原任务 allowRotation / allowHalfTurn 许可，越权旋转直接报错拒绝；
 * 3. 1D 物化严格使用算法每车 allocations、禁止静默丢车，且 pieceSeq 跨车次全局递增；
 * 4. 提供无副作用手调几何校验与刀路/余料重建能力（仅通过 algorithm/api 与 algorithm/geometry 注入）。
 */
final class StudioMaterializer {

    record MaterializationResult(List<String> planIds, double startY, double occupiedLengthMm) {}

    private record SlittingSlot(String taskId, CuttingTask.Line line, int localDemandId) {}

    private final NestingSolver solverFactory;
    private final ToolpathOptimizer toolpathOptimizer;

    StudioMaterializer(NestingSolver solverFactory) {
        this(solverFactory, null);
    }

    StudioMaterializer(NestingSolver solverFactory, ToolpathOptimizer toolpathOptimizer) {
        this.solverFactory = solverFactory;
        this.toolpathOptimizer = toolpathOptimizer;
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
                    : nextAvailableRollStart(tx, roll, effectiveLen, selfSchemeId);
            assertRollIntervalFree(tx, roll, startY, effectiveLen, selfSchemeId);
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
            validatePlacementRotation(line.name(), line.width(), line.length(), line.allowRotation(), line.allowHalfTurn(),
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
                NestingProblem.Shape placedShape = preserveLineHoles(p.shape(), line.shape(), normDeg);
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
            cursorY = nextAvailableRollStart(tx, roll, totalEstimatedLen, selfSchemeId);
        }
        double firstStartY = -1;
        double lastEndY = cursorY;

        // 建立全局剩余可分配配额（支持单任务与跨任务合排；跨任务严格按 targetAllocations 的 1-based 下标作为 localDemandId）
        Map<String, SlittingSlot> slotsByKey = new LinkedHashMap<>();
        Map<String, Integer> globalRemaining = new LinkedHashMap<>();
        if (multiTask) {
            for (int i = 0; i < targetAllocations.size(); i++) {
                SchedulingScheme.TaskDemandAllocation alloc = targetAllocations.get(i);
                CuttingTask t = sourceTasks.get(alloc.taskId());
                if (t == null) continue;
                CuttingTask.Line line = t.demands().stream().filter(l -> l.id() == alloc.lineId()).findFirst()
                        .orElseThrow(() -> new IllegalArgumentException("合排分切需求行不存在: " + alloc.taskId() + "#" + alloc.lineId()));
                String key = alloc.taskId() + ":" + alloc.lineId();
                slotsByKey.put(key, new SlittingSlot(alloc.taskId(), line, i + 1));
                globalRemaining.merge(key, alloc.quantity(), Integer::sum);
            }
        } else {
            Map<String, Integer> completed = tx.completedQuantities(primaryTask.id());
            for (CuttingTask.Line line : primaryTask.demands()) {
                String key = primaryTask.id() + ":" + line.id();
                slotsByKey.put(key, new SlittingSlot(primaryTask.id(), line, line.id()));
                int rem = Math.max(0, line.quantity() - completed.getOrDefault(String.valueOf(line.id()), 0));
                globalRemaining.put(key, rem);
            }
        }

        // 若未传 pattern.allocations，则按 fulfillment 顺序约束配额上限，避免跨订单串单
        Map<String, Integer> fulfillmentRemaining = new LinkedHashMap<>();
        for (SchedulingScheme.SlittingFulfillmentItem f : slit.fulfillment()) {
            SlittingSlot slot = resolveSlotForOrderId(slotsByKey, primaryTask.id(), f.orderId(), f.widthMm(), null, globalRemaining);
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
                    SlittingSlot slot = resolveSlotForOrderId(slotsByKey, primaryTask.id(), allocItem.orderId(), -1, pat.surfaceTreatment(), globalRemaining);
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
                Map<Integer, SlittingSlot> carLocalIdToSlot = new LinkedHashMap<>();
                double xCursor = slit.leftTrimMm();

                for (SchedulingScheme.StationItem st : pat.stations()) {
                    for (int k = 0; k < st.countPerRepetition(); k++) {
                        SlittingSlot chosen = pickSlittingSlot(
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

                double carStart = findAvailableCarStart(tx, roll, cursorY, carLen, carPieces, avoidDefects, selfSchemeId, allocatedCarIntervals);
                // 严禁 break 静默丢车：母卷余长放不下全部车次时必须报错拒绝并整事务回滚！
                if (carStart + carLen > roll.getTotalLength() + 0.001) {
                    throw new IllegalArgumentException("母卷 " + roll.getRollId() + " 剩余长度不足以排入全部 "
                            + expectedTotalCars + " 车（第 " + carIndex + " 车需区间 Y=" + round1(carStart) + "~"
                            + round1(carStart + carLen) + "mm，超出母卷总长 " + round1(roll.getTotalLength()) + "mm）");
                }
                assertRollIntervalFree(tx, roll, carStart, carLen, selfSchemeId);
                allocatedCarIntervals.add(new double[]{carStart, carStart + carLen});

                List<PieceDemand> reqDemands = new ArrayList<>();
                for (Map.Entry<Integer, Integer> entry : carDemandCounts.entrySet()) {
                    SlittingSlot slot = carLocalIdToSlot.get(entry.getKey());
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

    /**
     * 虚拟母卷 2D 几何四重校验：
     * 1. 画布尺寸、修边 trimStartMm 与片间距 pieceGapMm 合法性；
     * 2. 每片坐标有限、尺寸正数、不越画布边界、不侵占卷头修边区 trimStartMm；
     * 3. 异形多边形轮廓合法性（PolygonGeometry.validate）；
     * 4. 两两裁片碰撞重叠与最小间距 pieceGapMm 真实校验（矩形 AABB + 异形布尔交集与多边形边距离）。
     */
    void validateVirtual2DGeometry(
            SchedulingScheme.Layout2DPayload layout,
            double widthMm,
            double heightMm,
            double trimStartMm,
            double pieceGapMm
    ) {
        List<String> errors = collect2DGeometryErrors(layout == null ? List.of() : layout.placements(), widthMm, heightMm, trimStartMm, pieceGapMm);
        if (!errors.isEmpty()) {
            throw new IllegalArgumentException(errors.get(0));
        }
    }

    /**
     * 无副作用手调几何校验与刀路/余料重建（纯计算只读，绝不写库存）：
     * 校验裁片越界、修边侵入、两两重叠、间距不足、疵点碰撞、旋转许可，合法时通过 NestingSolver / ToolpathOptimizer 重建刀路与余料。
     */
    Map<String, Object> validateManualLayout(
            CuttingStatePort.ReadView tx,
            StudioCommandContracts.ValidateLayoutInput req
    ) {
        List<String> errors = new ArrayList<>();
        if (req == null) {
            return invalidLayoutResult(List.of("校验请求体不能为空"));
        }
        double widthMm = req.materialWidthMm();
        double heightMm = req.materialLengthMm();
        double trimStartMm = Math.max(0.0, req.trimStartMm());
        double pieceGapMm = Math.max(0.0, req.pieceGapMm());
        boolean avoidDefects = req.avoidDefects() == null || req.avoidDefects();

        if (!Double.isFinite(widthMm) || widthMm <= 0 || !Double.isFinite(heightMm) || heightMm <= 0) {
            errors.add("材料幅宽与长度必须为有效正数");
        }
        if (!Double.isFinite(req.trimStartMm()) || req.trimStartMm() < 0 || (Double.isFinite(heightMm) && trimStartMm >= heightMm)) {
            errors.add("卷头修边长度不能为负且必须小于材料长度");
        }
        try {
            SolveRequest.validatePieceGap(pieceGapMm);
        } catch (IllegalArgumentException e) {
            errors.add(e.getMessage());
        }
        List<SchedulingScheme.PlacementItem> placements = req.placements() == null ? List.of() : req.placements();
        if (placements.isEmpty()) {
            errors.add("至少需要包含 1 件有效裁片");
        }
        if (!errors.isEmpty()) {
            return invalidLayoutResult(errors);
        }

        // 1. 解析真实材料与窗口疵点（只读）
        boolean remnantMode = req.remnantId() != null && !req.remnantId().isBlank();
        boolean rollMode = !remnantMode && req.rollId() != null && !req.rollId().isBlank();
        double windowStartY = req.windowStartY() != null && Double.isFinite(req.windowStartY()) ? Math.max(0.0, req.windowStartY()) : 0.0;
        List<Defect> effectiveDefects = new ArrayList<>();
        if (remnantMode) {
            Optional<RemnantStock> remOpt = tx.findRemnant(req.remnantId().trim());
            if (remOpt.isEmpty()) {
                errors.add("指定料头不存在: " + req.remnantId());
                return invalidLayoutResult(errors);
            }
            RemnantStock rem = remOpt.get();
            if (avoidDefects && rem.getDefects() != null) {
                effectiveDefects.addAll(DefectWindowSupport.sliceForWindow(rem.getDefects(), 0, heightMm, widthMm));
            }
        } else if (rollMode) {
            Optional<MotherRollInfo> rollOpt = tx.findRoll(req.rollId().trim());
            if (rollOpt.isEmpty()) {
                errors.add("指定母卷不存在: " + req.rollId());
                return invalidLayoutResult(errors);
            }
            MotherRollInfo roll = rollOpt.get();
            if (avoidDefects && roll.getDefects() != null) {
                effectiveDefects.addAll(DefectWindowSupport.sliceForWindow(roll.getDefects(), windowStartY, heightMm, widthMm));
            }
        } else if (avoidDefects && req.defects() != null) {
            effectiveDefects.addAll(DefectWindowSupport.sliceForWindow(req.defects(), 0, heightMm, widthMm));
        }

        // 2. 几何边界、修边、重叠、间距检查
        errors.addAll(collect2DGeometryErrors(placements, widthMm, heightMm, trimStartMm, pieceGapMm));

        // 3. 旋转许可与需求一致性检查
        Map<Integer, StudioCommandContracts.DemandLineView> demandMap = new LinkedHashMap<>();
        if (req.demands() != null) {
            int fallbackId = 1;
            for (StudioCommandContracts.DemandLineView d : req.demands()) {
                if (d == null) continue;
                int id = (d.id() != null && d.id() > 0) ? d.id() : fallbackId++;
                demandMap.put(id, d);
            }
        }

        boolean isContour = placements.stream().anyMatch(p -> p != null && p.shape() != null && "POLYGON".equals(p.shape().type()))
                || demandMap.values().stream().anyMatch(d -> d.shape() != null && "POLYGON".equals(d.shape().type()));

        for (SchedulingScheme.PlacementItem p : placements) {
            if (p == null) continue;
            StudioCommandContracts.DemandLineView dem = demandMap.get(p.demandId());
            if (dem != null) {
                double pw = p.shape() != null ? p.shape().width() : p.w();
                double pl = p.shape() != null ? p.shape().height() : p.l();
                try {
                    validatePlacementRotation(
                            dem.name() != null ? dem.name() : p.name(),
                            dem.width(), dem.length(),
                            Boolean.TRUE.equals(dem.allowRotation()),
                            dem.allowHalfTurn(),
                            p.rotationDegrees(), pw, pl, isContour
                    );
                } catch (IllegalArgumentException rotErr) {
                    errors.add(rotErr.getMessage());
                }
            }
        }

        // 4. 疵点碰撞检查
        if (avoidDefects && !effectiveDefects.isEmpty()) {
            for (SchedulingScheme.PlacementItem p : placements) {
                if (p == null) continue;
                NestingProblem.Shape shape = effectiveShape(p);
                if (shape == null) continue;
                boolean poly = "POLYGON".equals(shape.type());
                Area pieceArea = poly ? PolygonGeometry.region(shape, p.x(), p.y()) : null;
                for (Defect d : effectiveDefects) {
                    if ("PENETRABLE".equalsIgnoreCase(d.getAvoidanceStrategy())) continue;
                    double dx0 = Math.max(0, d.getX() - d.getMargin());
                    double dy0 = Math.max(0, d.getY() - d.getMargin());
                    double dx1 = Math.min(widthMm, d.getX() + d.getW() + d.getMargin());
                    double dy1 = Math.min(heightMm, d.getY() + d.getH() + d.getMargin());
                    if (dx1 <= dx0 || dy1 <= dy0) continue;
                    boolean hit;
                    if (!poly) {
                        hit = p.x() < dx1 - 0.001 && p.x() + shape.width() > dx0 + 0.001
                                && p.y() < dy1 - 0.001 && p.y() + shape.height() > dy0 + 0.001;
                    } else {
                        Area inter = new Area(pieceArea);
                        inter.intersect(PolygonGeometry.region(NestingProblem.Shape.rectangle(dx1 - dx0, dy1 - dy0), dx0, dy0));
                        hit = PolygonGeometry.area(inter) > 1e-3;
                    }
                    if (hit) {
                        errors.add("裁片「" + Objects.toString(p.name(), "#" + p.id()) + "」与疵点 #" + d.getId() + " 发生碰撞");
                    }
                }
            }
        }

        if (!errors.isEmpty()) {
            return invalidLayoutResult(errors);
        }

        // 5. 构造标准 SolveRequest 并通过 NestingSolver / ToolpathOptimizer 重建权威刀路与余料
        try {
            Map<Integer, Integer> countByDemand = new LinkedHashMap<>();
            Map<Integer, SchedulingScheme.PlacementItem> sampleByDemand = new LinkedHashMap<>();
            for (SchedulingScheme.PlacementItem p : placements) {
                countByDemand.merge(p.demandId(), 1, Integer::sum);
                sampleByDemand.putIfAbsent(p.demandId(), p);
            }

            List<PieceDemand> reqDemands = new ArrayList<>();
            for (Map.Entry<Integer, Integer> e : countByDemand.entrySet()) {
                int did = e.getKey();
                StudioCommandContracts.DemandLineView dem = demandMap.get(did);
                SchedulingScheme.PlacementItem sample = sampleByDemand.get(did);
                String name = dem != null && dem.name() != null && !dem.name().isBlank()
                        ? dem.name() : Objects.toString(sample.name(), "裁片#" + did);
                NestingProblem.Shape baseShape = dem != null && dem.shape() != null
                        ? dem.shape()
                        : (isContour ? effectiveShape(sample) : null);
                double dw = dem != null && dem.width() > 0 ? dem.width() : (baseShape != null ? baseShape.width() : sample.w());
                double dl = dem != null && dem.length() > 0 ? dem.length() : (baseShape != null ? baseShape.height() : sample.l());
                boolean allowRot = dem != null && Boolean.TRUE.equals(dem.allowRotation());
                PieceDemand pd = new PieceDemand(did, name, dw, dl, e.getValue(), allowRot);
                if (isContour) {
                    if (baseShape == null || !"POLYGON".equals(baseShape.type())) {
                        baseShape = new NestingProblem.Shape("POLYGON", dw, dl, List.of(
                                new NestingProblem.Point(0, 0),
                                new NestingProblem.Point(dw, 0),
                                new NestingProblem.Point(dw, dl),
                                new NestingProblem.Point(0, dl)
                        ));
                    }
                    pd.setShape(baseShape);
                    if (dem != null && dem.allowHalfTurn() != null) pd.setAllowHalfTurn(dem.allowHalfTurn());
                }
                reqDemands.add(pd);
            }

            List<PlacedPiece> placedPieces = new ArrayList<>();
            Set<Integer> usedIds = new HashSet<>();
            int nextPid = 1;
            for (SchedulingScheme.PlacementItem p : placements) {
                int pid = p.id();
                if (pid <= 0 || !usedIds.add(pid)) {
                    while (!usedIds.add(nextPid)) nextPid++;
                    pid = nextPid;
                }
                nextPid = Math.max(nextPid, pid + 1);
                int normDeg = Math.floorMod(p.rotationDegrees(), 360);
                if (isContour) {
                    NestingProblem.Shape placedShape = effectiveShape(p);
                    if (!"POLYGON".equals(placedShape.type())) {
                        placedShape = new NestingProblem.Shape("POLYGON", placedShape.width(), placedShape.height(), List.of(
                                new NestingProblem.Point(0, 0),
                                new NestingProblem.Point(placedShape.width(), 0),
                                new NestingProblem.Point(placedShape.width(), placedShape.height()),
                                new NestingProblem.Point(0, placedShape.height())
                        ));
                    }
                    PlacedPiece pp = new PlacedPiece(pid, Objects.toString(p.name(), "裁片#" + pid),
                            p.x(), p.y(), placedShape.width(), placedShape.height(), normDeg % 180 != 0, p.demandId());
                    pp.setShape(placedShape);
                    pp.setRotationDegrees(normDeg);
                    placedPieces.add(pp);
                } else {
                    StudioCommandContracts.DemandLineView dem = demandMap.get(p.demandId());
                    boolean rotated = (normDeg % 180 != 0)
                            || (dem != null && Math.abs(p.w() - dem.length()) < 0.01 && Math.abs(p.l() - dem.width()) < 0.01 && Math.abs(dem.width() - dem.length()) > 0.01);
                    double pw = dem != null ? (rotated ? dem.length() : dem.width()) : p.w();
                    double pl = dem != null ? (rotated ? dem.width() : dem.length()) : p.l();
                    placedPieces.add(new PlacedPiece(pid, Objects.toString(p.name(), "裁片#" + pid),
                            round1(p.x()), round1(p.y()), round1(pw), round1(pl), rotated, p.demandId()));
                }
            }

            SolveRequest solveReq = new SolveRequest();
            solveReq.setFeedPortType(remnantMode ? "remnant" : "roll");
            solveReq.setRollId(rollMode ? req.rollId().trim() : "VIRTUAL-VALIDATE");
            solveReq.setSourceRemnantId(remnantMode ? req.remnantId().trim() : null);
            solveReq.setRollW(widthMm);
            solveReq.setRollL(heightMm);
            solveReq.setTotalRollL(heightMm);
            solveReq.setWindowStartY(0);
            solveReq.setTrimStart(isContour ? 0 : trimStartMm);
            solveReq.setPieceGap(pieceGapMm);
            solveReq.setCutOrigin("left-top");
            solveReq.setFirstStageOrientation("horizontal");
            solveReq.setAllowLongitudinal(true);
            solveReq.setAllowRotation(!reqDemands.isEmpty() && reqDemands.stream().allMatch(PieceDemand::isAllowRotation));
            solveReq.setMinRemnantWidth(150);
            solveReq.setMinRemnantLength(150);
            solveReq.setTimeLimitSeconds(5);
            solveReq.setDemands(reqDemands);
            solveReq.setDefects(effectiveDefects);

            SolveResponse validated;
            if (isContour) {
                validated = FabricSolveAdapter.adjust(solverFactory, solveReq, placedPieces);
            } else {
                try {
                    validated = FabricSolveAdapter.adjust(solverFactory, solveReq, placedPieces);
                } catch (IllegalArgumentException horizErr) {
                    // 直刀布局若水平首刀无法贯通分割，尝试垂直首刀以支持合理手调
                    solveReq.setFirstStageOrientation("vertical");
                    try {
                        validated = FabricSolveAdapter.adjust(solverFactory, solveReq, placedPieces);
                    } catch (IllegalArgumentException vertErr) {
                        throw horizErr;
                    }
                }
            }

            if (!validated.isSuccess()) {
                return invalidLayoutResult(List.of(Objects.toString(validated.getMessage(), "手调布局未通过几何与刀路校验")));
            }

            List<CutStep> cutSteps = validated.getCuts() == null ? List.of() : validated.getCuts();
            if (!isContour && toolpathOptimizer != null && !cutSteps.isEmpty()) {
                cutSteps = toolpathOptimizer.optimizeAndChain(cutSteps, 0, 0, true);
            }

            List<Map<String, Object>> cutsOut = new ArrayList<>();
            int seq = 1;
            for (CutStep c : cutSteps) {
                String kind = "横切".equals(c.getType()) ? "HORIZONTAL"
                        : "纵切".equals(c.getType()) ? "VERTICAL"
                        : "CONTOUR";
                double sx = c.getStartX() != null ? c.getStartX() : ("HORIZONTAL".equals(kind) ? c.getStart() : c.getPos());
                double sy = c.getStartY() != null ? c.getStartY() : ("HORIZONTAL".equals(kind) ? c.getPos() : c.getStart());
                double ex = c.getEndX() != null ? c.getEndX() : ("HORIZONTAL".equals(kind) ? c.getEnd() : c.getPos());
                double ey = c.getEndY() != null ? c.getEndY() : ("HORIZONTAL".equals(kind) ? c.getPos() : c.getEnd());
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("sequence", seq++);
                row.put("kind", kind);
                row.put("startX", round1(sx));
                row.put("startY", round1(sy));
                row.put("endX", round1(ex));
                row.put("endY", round1(ey));
                if (c.getDesc() != null) row.put("description", c.getDesc());
                if (c.getAirDistance() != null) row.put("airDistanceMm", round1(c.getAirDistance()));
                row.put("stage", c.getStage());
                cutsOut.add(row);
            }

            List<Map<String, Object>> leftoversOut = new ArrayList<>();
            if (validated.getRemnants() != null) {
                for (RemnantPiece rm : validated.getRemnants()) {
                    Map<String, Object> item = new LinkedHashMap<>();
                    item.put("id", rm.getId());
                    item.put("x", round1(rm.getX()));
                    item.put("y", round1(rm.getY()));
                    item.put("w", round1(rm.getW()));
                    item.put("l", round1(rm.getL()));
                    item.put("hasDefect", rm.isHasDefect());
                    leftoversOut.add(item);
                }
            }

            Map<String, Object> ok = new LinkedHashMap<>();
            ok.put("feasible", true);
            ok.put("errors", List.of());
            ok.put("cuts", cutsOut);
            ok.put("leftovers", leftoversOut);
            return ok;
        } catch (IllegalArgumentException e) {
            return invalidLayoutResult(List.of(e.getMessage()));
        }
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
        int normDeg = Math.floorMod(rotationDegrees, 360);
        if (isContour) {
            if (normDeg == 0) return;
            if (normDeg == 180) {
                if (!allowRotation && !Boolean.TRUE.equals(allowHalfTurn)) {
                    throw new IllegalArgumentException("裁片「" + pieceName + "」需求未允许 180° 掉头旋转，拒绝越权排布");
                }
                return;
            }
            if (!allowRotation) {
                throw new IllegalArgumentException("裁片「" + pieceName + "」需求禁止旋转（当前角度 " + normDeg + "°），拒绝越权排布");
            }
            return;
        }
        if (normDeg != 0 && normDeg != 90 && normDeg != 180 && normDeg != 270) {
            throw new IllegalArgumentException("矩形裁片「" + pieceName + "」仅支持正交旋转角度（当前 " + normDeg + "°）");
        }
        boolean swappedDims = Math.abs(placedW - lineL) < 0.01 && Math.abs(placedL - lineW) < 0.01 && Math.abs(lineW - lineL) > 0.01;
        boolean rotated90 = (normDeg % 180 != 0) || swappedDims;
        if (rotated90 && !allowRotation) {
            throw new IllegalArgumentException("裁片「" + pieceName + "」需求禁止 90° 旋转，拒绝越权排布");
        }
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

    // ==================== 区间互斥、几何碰撞与分切匹配辅助 ====================

    private void assertRollIntervalFree(
            CuttingStatePort.ReadView tx,
            MotherRollInfo roll,
            double startY,
            double lengthMm,
            String exceptSchemeId
    ) {
        if (!Double.isFinite(startY) || startY < 0) {
            throw new IllegalArgumentException("母卷起切位置无效: " + startY);
        }
        if (startY < roll.getUsedLength() - 0.001) {
            throw new InventoryConflictException("起切位置 Y=" + round1(startY) + "mm 落入母卷 " + roll.getRollId()
                    + " 已切割区域 [0, " + round1(roll.getUsedLength()) + "mm]");
        }
        double endY = startY + lengthMm;
        if (endY > roll.getTotalLength() + 0.001) {
            throw new IllegalArgumentException("母卷 " + roll.getRollId() + " 剩余连续可用长度不足（需 " + round1(lengthMm)
                    + " mm，起切位置 Y=" + round1(startY) + " mm，总长 " + round1(roll.getTotalLength()) + " mm）");
        }
        for (Map<String, Object> r : tx.listReceipts()) {
            if ("REVERSED".equals(r.get("status")) || !"roll".equals(r.get("feedPortType")) || !roll.getRollId().equals(r.get("rollId"))) {
                continue;
            }
            double s = ((Number) r.get("windowStartY")).doubleValue();
            double e = s + ((Number) r.get("actualCutLen")).doubleValue();
            if (Math.min(endY, e) - Math.max(startY, s) > 0.001) {
                throw new InventoryConflictException("母卷 " + roll.getRollId() + " 区间 [" + round1(startY) + ", " + round1(endY)
                        + "mm] 与已报工切割区 [" + round1(s) + ", " + round1(e) + "mm] 重叠");
            }
        }
        for (SchedulingScheme sc : tx.listSchemes()) {
            if (Objects.equals(exceptSchemeId, sc.id()) || !sc.occupiesRoll(roll.getRollId())) {
                continue;
            }
            double s = sc.windowStartY();
            double e = s + sc.occupiedLengthMm();
            if (Math.min(endY, e) - Math.max(startY, s) > 0.001) {
                throw new InventoryConflictException("母卷 " + roll.getRollId() + " 区间 [" + round1(startY) + ", " + round1(endY)
                        + "mm] 与活跃排程方案 " + sc.id() + " 预占区 [" + round1(s) + ", " + round1(e) + "mm] 重叠");
            }
        }
    }

    private double findAvailableCarStart(
            CuttingStatePort.ReadView tx,
            MotherRollInfo roll,
            double fromY,
            double carLen,
            List<PlacedPiece> strips,
            boolean avoidDefects,
            String exceptSchemeId,
            List<double[]> allocatedCarIntervals
    ) {
        double y = fromY;
        List<double[]> blocked = collectRollOccupiedIntervals(tx, roll, exceptSchemeId);
        blocked.addAll(allocatedCarIntervals);
        blocked.sort(Comparator.comparingDouble(a -> a[0]));

        List<Defect> defs = (avoidDefects && roll.getDefects() != null) ? roll.getDefects() : List.of();
        for (int guard = 0; guard < 300 && y + carLen <= roll.getTotalLength() + 0.001; guard++) {
            double candidateY = y;
            double candidateEnd = candidateY + carLen;

            // 先跳过与其他方案/报工/已排车次重叠的区间
            double[] overlap = blocked.stream()
                    .filter(iv -> Math.min(candidateEnd, iv[1]) - Math.max(candidateY, iv[0]) > 0.001)
                    .findFirst().orElse(null);
            if (overlap != null) {
                y = Math.max(y + 10, overlap[1]);
                continue;
            }

            // 再跳过与本车分切条冲突的 MUST_AVOID 疵点
            Defect hit = defs.stream().filter(d -> {
                if ("PENETRABLE".equalsIgnoreCase(d.getAvoidanceStrategy())) return false;
                double m = d.getMargin();
                double dx0 = Math.max(0, d.getX() - m), dx1 = Math.min(roll.getWidth(), d.getX() + d.getW() + m);
                double dy0 = Math.max(0, d.getY() - m), dy1 = Math.min(roll.getTotalLength(), d.getY() + d.getH() + m);
                if (dy1 <= candidateY + 0.001 || dy0 >= candidateEnd - 0.001) return false;
                return strips.stream().anyMatch(s -> s.getX() + s.getW() > dx0 + 0.001 && s.getX() < dx1 - 0.001);
            }).findFirst().orElse(null);
            if (hit == null) return candidateY;
            y = Math.max(y + 10, hit.getY() + hit.getH() + hit.getMargin());
        }
        return y;
    }

    private List<double[]> collectRollOccupiedIntervals(CuttingStatePort.ReadView tx, MotherRollInfo roll, String exceptSchemeId) {
        List<double[]> intervals = new ArrayList<>();
        if (roll.getUsedLength() > 0) intervals.add(new double[]{0, roll.getUsedLength()});
        for (Map<String, Object> r : tx.listReceipts()) {
            if (!"REVERSED".equals(r.get("status")) && "roll".equals(r.get("feedPortType")) && roll.getRollId().equals(r.get("rollId"))) {
                double s = ((Number) r.get("windowStartY")).doubleValue();
                double l = ((Number) r.get("actualCutLen")).doubleValue();
                intervals.add(new double[]{s, s + l});
            }
        }
        for (SchedulingScheme sc : tx.listSchemes()) {
            if (!Objects.equals(exceptSchemeId, sc.id()) && sc.occupiesRoll(roll.getRollId())) {
                intervals.add(new double[]{sc.windowStartY(), sc.windowStartY() + sc.occupiedLengthMm()});
            }
        }
        return intervals;
    }

    private double nextAvailableRollStart(CuttingStatePort.ReadView tx, MotherRollInfo roll, double neededLen, String exceptSchemeId) {
        List<double[]> intervals = collectRollOccupiedIntervals(tx, roll, exceptSchemeId);
        intervals.sort(Comparator.comparingDouble(a -> a[0]));
        double cursor = roll.getUsedLength();
        for (double[] iv : intervals) {
            if (iv[1] <= cursor + 0.001) continue;
            if (iv[0] - cursor >= neededLen - 0.001) return cursor;
            cursor = Math.max(cursor, iv[1]);
        }
        return cursor;
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

    private static SlittingSlot resolveSlotForOrderId(
            Map<String, SlittingSlot> slotsByKey,
            String primaryTaskId,
            String orderId,
            int fallbackWidthMm,
            String surfaceTreatment,
            Map<String, Integer> remaining
    ) {
        if (orderId != null && !orderId.isBlank()) {
            String clean = orderId.trim();
            if (slotsByKey.containsKey(clean)) return slotsByKey.get(clean);
            String withPrimary = primaryTaskId + ":" + clean;
            if (slotsByKey.containsKey(withPrimary)) return slotsByKey.get(withPrimary);
            // 兼容跨任务合排时算法用 localDemandId（1-based 数字）作为 orderId 的情况
            try {
                int numericId = Integer.parseInt(clean);
                for (SlittingSlot slot : slotsByKey.values()) {
                    if (slot.localDemandId() == numericId) return slot;
                }
            } catch (NumberFormatException ignored) {
                // 非数字 orderId，继续按宽度兜底
            }
        }
        if (fallbackWidthMm > 0) {
            return pickByPredicate(slotsByKey, (k, slot) -> matchesSlittingSlot(slot, fallbackWidthMm, surfaceTreatment), remaining);
        }
        return null;
    }

    private static SlittingSlot pickByPredicate(
            Map<String, SlittingSlot> map,
            java.util.function.BiPredicate<String, SlittingSlot> pred,
            Map<String, Integer> score
    ) {
        SlittingSlot best = null;
        int bestScore = Integer.MIN_VALUE;
        for (Map.Entry<String, SlittingSlot> e : map.entrySet()) {
            if (!pred.test(e.getKey(), e.getValue())) continue;
            int sc = score == null ? 0 : score.getOrDefault(e.getKey(), 0);
            if (sc > bestScore) {
                bestScore = sc;
                best = e.getValue();
            }
        }
        return best;
    }

    private static SlittingSlot pickSlittingSlot(
            Map<String, SlittingSlot> rawSlots,
            int widthMm,
            String surfaceTreatment,
            Map<String, Integer> patternAllocQuota,
            Map<String, Integer> fulfillmentRemaining,
            Map<String, Integer> globalRemaining
    ) {
        // 先尝试带明确 patternAllocQuota 的精确配额分配
        if (patternAllocQuota != null) {
            return pickByPredicate(rawSlots, (key, slot) ->
                    patternAllocQuota.getOrDefault(key, 0) > 0 && matchesSlittingSlot(slot, widthMm, surfaceTreatment),
                    patternAllocQuota);
        }
        // 次选 fulfillmentRemaining 中仍有配额且表面处理与宽度匹配的行
        if (!fulfillmentRemaining.isEmpty()) {
            SlittingSlot hit = pickByPredicate(rawSlots, (key, slot) ->
                    fulfillmentRemaining.getOrDefault(key, 0) > 0 && matchesSlittingSlot(slot, widthMm, surfaceTreatment),
                    fulfillmentRemaining);
            if (hit != null) return hit;
        }
        // 最后在同表面处理同宽度有剩余需求的行中匹配
        return pickByPredicate(rawSlots, (key, slot) ->
                globalRemaining.getOrDefault(key, 0) > 0 && matchesSlittingSlot(slot, widthMm, surfaceTreatment),
                globalRemaining);
    }

    private static boolean matchesSlittingSlot(SlittingSlot slot, int widthMm, String surfaceTreatment) {
        CuttingTask.Line line = slot.line();
        if (Math.abs(line.width() - widthMm) >= 0.5) return false;
        if (surfaceTreatment != null && !surfaceTreatment.isBlank()
                && line.surfaceTreatment() != null && !line.surfaceTreatment().isBlank()) {
            return surfaceTreatment.trim().equalsIgnoreCase(line.surfaceTreatment().trim());
        }
        return true;
    }

    private List<String> collect2DGeometryErrors(
            List<SchedulingScheme.PlacementItem> placements,
            double widthMm,
            double heightMm,
            double trimStartMm,
            double pieceGapMm
    ) {
        List<String> errors = new ArrayList<>();
        if (!Double.isFinite(widthMm) || widthMm <= 0 || !Double.isFinite(heightMm) || heightMm <= 0) {
            errors.add("画布门幅与长度必须为正数");
            return errors;
        }
        if (!Double.isFinite(trimStartMm) || trimStartMm < 0 || trimStartMm >= heightMm) {
            errors.add("卷头修边长度无效或大于等于画布长度");
            return errors;
        }
        try {
            SolveRequest.validatePieceGap(pieceGapMm);
        } catch (IllegalArgumentException e) {
            errors.add(e.getMessage());
            return errors;
        }

        record GeomEntry(SchedulingScheme.PlacementItem item, NestingProblem.Shape shape, double x, double y, double w, double h,
                         boolean polygon, Area area, List<NestingProblem.Point> worldVerts) {}
        List<GeomEntry> validItems = new ArrayList<>();

        for (SchedulingScheme.PlacementItem p : placements) {
            if (p == null) {
                errors.add("存在空的裁片位置项");
                continue;
            }
            NestingProblem.Shape shape = effectiveShape(p);
            double pw = shape != null ? shape.width() : p.w();
            double ph = shape != null ? shape.height() : p.l();
            String label = Objects.toString(p.name(), "#" + p.id());

            if (!Double.isFinite(p.x()) || !Double.isFinite(p.y()) || !Double.isFinite(pw) || !Double.isFinite(ph) || pw <= 0 || ph <= 0) {
                errors.add("裁片「" + label + "」坐标或尺寸无效");
                continue;
            }
            boolean isPoly = shape != null && "POLYGON".equals(shape.type());
            if (isPoly) {
                try {
                    PolygonGeometry.validate(shape);
                } catch (RuntimeException polyErr) {
                    errors.add("裁片「" + label + "」轮廓无效：" + polyErr.getMessage());
                    continue;
                }
            }
            if (p.x() < -0.001 || p.x() + pw > widthMm + 0.001 || p.y() + ph > heightMm + 0.001) {
                errors.add("裁片「" + label + "」超出画布边界（" + round1(widthMm) + "×" + round1(heightMm) + "mm）");
            }
            if (p.y() < trimStartMm - 0.001) {
                errors.add("裁片「" + label + "」侵入卷头修边区（Y=" + round1(p.y()) + "mm < trimStart=" + round1(trimStartMm) + "mm）");
            }
            Area area = isPoly ? PolygonGeometry.region(shape, p.x(), p.y()) : null;
            List<NestingProblem.Point> worldVerts = isPoly
                    ? PolygonGeometry.vertices(shape).stream().map(v -> new NestingProblem.Point(v.x() + p.x(), v.y() + p.y())).toList()
                    : List.of(
                            new NestingProblem.Point(p.x(), p.y()),
                            new NestingProblem.Point(p.x() + pw, p.y()),
                            new NestingProblem.Point(p.x() + pw, p.y() + ph),
                            new NestingProblem.Point(p.x(), p.y() + ph)
                    );
            validItems.add(new GeomEntry(p, shape, p.x(), p.y(), pw, ph, isPoly, area, worldVerts));
        }

        // 两两碰撞与最小片间距检查
        for (int i = 0; i < validItems.size(); i++) {
            GeomEntry a = validItems.get(i);
            for (int j = i + 1; j < validItems.size(); j++) {
                GeomEntry b = validItems.get(j);
                boolean aabbGapHit = a.x + a.w + pieceGapMm > b.x + 0.001
                        && b.x + b.w + pieceGapMm > a.x + 0.001
                        && a.y + a.h + pieceGapMm > b.y + 0.001
                        && b.y + b.h + pieceGapMm > a.y + 0.001;
                if (!aabbGapHit) continue;

                String nameA = Objects.toString(a.item.name(), "#" + a.item.id());
                String nameB = Objects.toString(b.item.name(), "#" + b.item.id());
                if (!a.polygon && !b.polygon) {
                    boolean directOverlap = a.x + a.w > b.x + 0.001 && b.x + b.w > a.x + 0.001
                            && a.y + a.h > b.y + 0.001 && b.y + b.h > a.y + 0.001;
                    if (directOverlap) {
                        errors.add("裁片「" + nameA + "」与「" + nameB + "」发生几何重叠");
                    } else if (pieceGapMm > 0) {
                        errors.add("裁片「" + nameA + "」与「" + nameB + "」间距不足（须保留至少 " + round1(pieceGapMm) + "mm）");
                    }
                } else {
                    Area areaA = a.area != null ? a.area : PolygonGeometry.region(NestingProblem.Shape.rectangle(a.w, a.h), a.x, a.y);
                    Area areaB = b.area != null ? b.area : PolygonGeometry.region(NestingProblem.Shape.rectangle(b.w, b.h), b.x, b.y);
                    Area inter = new Area(areaA);
                    inter.intersect(areaB);
                    if (PolygonGeometry.area(inter) > 1e-3) {
                        errors.add("异形裁片「" + nameA + "」与「" + nameB + "」发生几何重叠");
                    } else if (pieceGapMm > 0) {
                        double minDist = minPolygonEdgeDistance(a.worldVerts, b.worldVerts);
                        if (minDist < pieceGapMm - 0.001) {
                            errors.add("异形裁片「" + nameA + "」与「" + nameB + "」间距不足（当前 " + round1(minDist)
                                    + "mm，须至少 " + round1(pieceGapMm) + "mm）");
                        }
                    }
                }
            }
        }
        return errors;
    }

    private static double minPolygonEdgeDistance(List<NestingProblem.Point> polyA, List<NestingProblem.Point> polyB) {
        double min = Double.POSITIVE_INFINITY;
        int nA = polyA.size();
        int nB = polyB.size();
        for (int i = 0; i < nA; i++) {
            NestingProblem.Point p = polyA.get(i);
            for (int j = 0; j < nB; j++) {
                NestingProblem.Point b1 = polyB.get(j);
                NestingProblem.Point b2 = polyB.get((j + 1) % nB);
                double d = Line2D.ptSegDist(b1.x(), b1.y(), b2.x(), b2.y(), p.x(), p.y());
                if (d < min) min = d;
            }
        }
        for (int j = 0; j < nB; j++) {
            NestingProblem.Point p = polyB.get(j);
            for (int i = 0; i < nA; i++) {
                NestingProblem.Point a1 = polyA.get(i);
                NestingProblem.Point a2 = polyA.get((i + 1) % nA);
                double d = Line2D.ptSegDist(a1.x(), a1.y(), a2.x(), a2.y(), p.x(), p.y());
                if (d < min) min = d;
            }
        }
        return min;
    }

    /**
     * 方案落库与物理物化时兜底透传内孔洞 {@code shape.holes}：
     * 若放置图形已自带孔洞则原样保留；若放置图形缺失孔洞但源需求行包含孔洞，
     * 按对应旋转角度同步旋转源需求图形并补回孔洞（外接尺寸匹配时），防止全链路任一环节丢失内孔。
     */
    static NestingProblem.Shape preserveLineHoles(
            NestingProblem.Shape placedShape,
            NestingProblem.Shape lineShape,
            int rotationDegrees
    ) {
        int normDeg = Math.floorMod(rotationDegrees, 360);
        if (placedShape == null) {
            if (lineShape == null) return null;
            return normDeg == 0 ? lineShape : PolygonGeometry.rotate(lineShape, normDeg);
        }
        if (placedShape.hasHoles() || lineShape == null || !lineShape.hasHoles()) {
            return placedShape;
        }
        NestingProblem.Shape rotated = normDeg == 0 ? lineShape : PolygonGeometry.rotate(lineShape, normDeg);
        if (Math.abs(rotated.width() - placedShape.width()) <= 0.25
                && Math.abs(rotated.height() - placedShape.height()) <= 0.25) {
            return new NestingProblem.Shape(
                    placedShape.type(),
                    placedShape.width(),
                    placedShape.height(),
                    placedShape.vertices(),
                    rotated.holes()
            );
        }
        return placedShape;
    }

    private static NestingProblem.Shape effectiveShape(SchedulingScheme.PlacementItem p) {
        if (p == null) return null;
        if (p.shape() != null) return p.shape();
        if (Double.isFinite(p.w()) && p.w() > 0 && Double.isFinite(p.l()) && p.l() > 0) {
            return NestingProblem.Shape.rectangle(p.w(), p.l());
        }
        return null;
    }

    private static Map<String, Object> invalidLayoutResult(List<String> errors) {
        Map<String, Object> res = new LinkedHashMap<>();
        res.put("feasible", false);
        res.put("errors", List.copyOf(errors));
        res.put("cuts", List.of());
        res.put("leftovers", List.of());
        return res;
    }

    private static double round1(double v) {
        return Math.rint(v * 10.0) / 10.0;
    }
}
