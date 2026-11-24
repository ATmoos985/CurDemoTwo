package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.algorithm.api.NestingSolver;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
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

import java.util.*;
import java.util.stream.Collectors;

/**
 * 排程方案物理物化协作者：
 * 负责将 2D/1D 排程方案在受控写事务内校验几何与疵点并落库为 PENDING 机台切割计划，
 * 以及虚拟画布几何校验、母卷空闲起切段搜索与同款补片/旋转许可同步。
 */
final class StudioMaterializer {

    record MaterializationResult(List<String> planIds, double startY, double occupiedLengthMm) {}

    private final NestingSolver solverFactory;

    StudioMaterializer(NestingSolver solverFactory) {
        this.solverFactory = solverFactory;
    }

    MaterializationResult materialize2DPlanOnMaterial(
            CuttingStatePort.WriteTx tx,
            CuttingTask task,
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
            startY = requestedStartY != null && requestedStartY >= roll.getUsedLength()
                    ? requestedStartY
                    : nextAvailableRollStart(tx, roll, effectiveLen, selfSchemeId);
            if (startY + effectiveLen > roll.getTotalLength() + 0.001) {
                throw new IllegalArgumentException("母卷 " + roll.getRollId() + " 剩余连续可用长度不足（需 " + round1(effectiveLen)
                        + " mm，起切位置 Y=" + round1(startY) + " mm，总长 " + round1(roll.getTotalLength()) + " mm）");
            }
        }

        boolean isContour = task.demands().stream().anyMatch(d -> d.shape() != null);
        Map<Integer, Integer> countByDemand = new LinkedHashMap<>();
        for (SchedulingScheme.PlacementItem p : layout.placements()) {
            countByDemand.merge(p.demandId(), 1, Integer::sum);
        }

        List<PieceDemand> reqDemands = new ArrayList<>();
        for (Map.Entry<Integer, Integer> e : countByDemand.entrySet()) {
            CuttingTask.Line line = task.demands().stream().filter(d -> d.id() == e.getKey()).findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("方案裁片缺少对应任务需求行: #" + e.getKey()));
            PieceDemand pd = new PieceDemand(line.id(), line.name(), line.width(), line.length(), e.getValue(), line.allowRotation());
            pd.setShape(line.shape());
            if (line.allowHalfTurn() != null) pd.setAllowHalfTurn(line.allowHalfTurn());
            boolean hasHalfTurnPlacement = layout.placements().stream()
                    .anyMatch(p -> p.demandId() == line.id() && Math.abs(p.rotationDegrees()) == 180);
            boolean has90Placement = layout.placements().stream()
                    .anyMatch(p -> p.demandId() == line.id() && (Math.abs(p.rotationDegrees()) % 180 == 90));
            if (isContour && hasHalfTurnPlacement) pd.setAllowHalfTurn(true);
            if (!isContour && has90Placement) pd.setAllowRotation(true);
            reqDemands.add(pd);
        }

        task = syncTaskRotationPermissionsIfNeeded(tx, task, reqDemands, isContour);

        SolveRequest solveReq = new SolveRequest();
        solveReq.setTaskId(task.id());
        solveReq.setTaskRevision(task.revision());
        solveReq.setFeedPortType(remnantMode ? "remnant" : "roll");
        solveReq.setRollId(remnantMode ? remnant.getSourceRollId() : roll.getRollId());
        solveReq.setSourceRemnantId(remnantMode ? remnant.getId() : null);
        solveReq.setRollModel(task.materialModel());
        solveReq.setRollW(widthMm);
        solveReq.setRollL(effectiveLen);
        solveReq.setTotalRollL(remnantMode ? remnant.getLength() : roll.getTotalLength());
        solveReq.setWindowStartY(remnantMode ? 0 : startY);
        solveReq.setTrimStart(isContour ? 0 : trimStartMm);
        solveReq.setPieceGap(pieceGapMm);
        solveReq.setCutOrigin("left-top");
        solveReq.setFirstStageOrientation("horizontal");
        solveReq.setAllowLongitudinal(true);
        solveReq.setAllowRotation(reqDemands.stream().anyMatch(PieceDemand::isAllowRotation));
        solveReq.setMinRemnantWidth(150);
        solveReq.setMinRemnantLength(150);
        solveReq.setTimeLimitSeconds(5);
        solveReq.setDemands(reqDemands);

        tx.prepareTaskSolve(solveReq);
        for (PieceDemand pd : solveReq.getDemands()) {
            CuttingTask.Line line = task.demands().stream().filter(d -> d.id() == pd.getId()).findFirst().orElseThrow();
            if (line.allowHalfTurn() != null) pd.setAllowHalfTurn(line.allowHalfTurn());
        }
        List<Defect> rawDefs = remnantMode
                ? (remnant.getDefects() == null ? List.of() : remnant.getDefects())
                : (roll.getDefects() == null ? List.of() : roll.getDefects());
        solveReq.setDefects(CuttingWorkflowService.windowDefects(rawDefs, remnantMode ? 0 : startY, effectiveLen, widthMm));

        List<PlacedPiece> pieces = new ArrayList<>();
        Set<Integer> usedPieceIds = new HashSet<>();
        int seqId = 1;
        for (SchedulingScheme.PlacementItem p : layout.placements()) {
            CuttingTask.Line line = task.demands().stream().filter(d -> d.id() == p.demandId()).findFirst().orElseThrow();
            int pid = p.id();
            if (pid <= 0 || !usedPieceIds.add(pid)) {
                while (!usedPieceIds.add(seqId)) {
                    seqId++;
                }
                pid = seqId;
            }
            seqId = Math.max(seqId, pid + 1);
            if (isContour) {
                NestingProblem.Shape placedShape = p.shape() != null ? p.shape() : line.shape();
                PlacedPiece pp = new PlacedPiece(
                        pid, line.name(), p.x(), p.y(),
                        placedShape.width(), placedShape.height(),
                        Math.abs(p.rotationDegrees()) % 180 != 0,
                        line.id()
                );
                pp.setShape(placedShape);
                pp.setRotationDegrees(((p.rotationDegrees() % 360) + 360) % 360);
                pieces.add(pp);
            } else {
                boolean rotated = (Math.abs(p.rotationDegrees()) % 180 != 0)
                        || (Math.abs(p.w() - line.length()) < 0.01 && Math.abs(p.l() - line.width()) < 0.01 && Math.abs(line.width() - line.length()) > 0.01);
                double pw = rotated ? line.length() : line.width();
                double pl = rotated ? line.width() : line.length();
                pieces.add(new PlacedPiece(pid, line.name(), round1(p.x()), round1(p.y()), pw, pl, rotated, line.id()));
            }
        }

        SolveResponse validated = FabricSolveAdapter.adjust(solverFactory, solveReq, pieces);
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
            CuttingTask task,
            MotherRollInfo roll,
            SchedulingScheme.Slitting1DPayload slit,
            boolean avoidDefects,
            Double requestedStartY,
            String selfSchemeId
    ) {
        double fixedLen = slit.fixedLengthMm();
        double cursorY = requestedStartY != null && requestedStartY >= roll.getUsedLength()
                ? requestedStartY
                : nextAvailableRollStart(tx, roll, fixedLen, selfSchemeId);
        double firstStartY = -1;
        double lastEndY = cursorY;

        Map<String, Integer> completed = tx.completedQuantities(task.id());
        Map<Integer, Integer> remainingByLine = new LinkedHashMap<>();
        for (CuttingTask.Line line : task.demands()) {
            int rem = Math.max(0, line.quantity() - completed.getOrDefault(String.valueOf(line.id()), 0));
            remainingByLine.put(line.id(), rem);
        }

        List<String> planIds = new ArrayList<>();
        for (SchedulingScheme.SlittingPatternItem pat : slit.patterns()) {
            int carLen = pat.lengthMm() > 0 ? pat.lengthMm() : (int) fixedLen;
            for (int rep = 0; rep < pat.repetitions(); rep++) {
                List<PlacedPiece> carPieces = new ArrayList<>();
                Map<Integer, Integer> carDemandCounts = new LinkedHashMap<>();
                double xCursor = slit.leftTrimMm();
                int pieceSeq = 1;

                for (SchedulingScheme.StationItem st : pat.stations()) {
                    for (int k = 0; k < st.countPerRepetition(); k++) {
                        CuttingTask.Line chosen = pickBestLineForWidth(task.demands(), st.widthMm(), remainingByLine);
                        if (chosen == null) continue;
                        int remBefore = remainingByLine.getOrDefault(chosen.id(), 0);
                        if (remBefore <= 0) continue;
                        remainingByLine.put(chosen.id(), remBefore - 1);
                        carDemandCounts.merge(chosen.id(), 1, Integer::sum);
                        carPieces.add(new PlacedPiece(pieceSeq++, chosen.name(), xCursor, 0, chosen.width(), carLen, false, chosen.id()));
                        xCursor += chosen.width();
                    }
                }
                if (carPieces.isEmpty()) continue;

                double carStart = avoidDefects
                        ? findDefectFreeCarStart(roll, cursorY, carLen, carPieces)
                        : cursorY;
                if (carStart + carLen > roll.getTotalLength() + 0.001) {
                    if (planIds.isEmpty()) {
                        throw new IllegalArgumentException("母卷 " + roll.getRollId() + " 剩余长度不足以排入第 1 车（每车 " + carLen + "mm）");
                    }
                    break;
                }

                List<PieceDemand> reqDemands = new ArrayList<>();
                for (Map.Entry<Integer, Integer> entry : carDemandCounts.entrySet()) {
                    CuttingTask.Line line = task.demands().stream().filter(d -> d.id() == entry.getKey()).findFirst().orElseThrow();
                    reqDemands.add(new PieceDemand(line.id(), line.name(), line.width(), carLen, entry.getValue(), false));
                }

                SolveRequest req = new SolveRequest();
                req.setTaskId(task.id());
                req.setTaskRevision(task.revision());
                req.setFeedPortType("roll");
                req.setRollId(roll.getRollId());
                req.setRollModel(task.materialModel());
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

                tx.prepareTaskSolve(req);
                req.setDefects(CuttingWorkflowService.windowDefects(
                        roll.getDefects() == null ? List.of() : roll.getDefects(),
                        carStart, carLen, roll.getWidth()
                ));

                SolveResponse validated = FabricSolveAdapter.adjust(solverFactory, req, carPieces);
                if (!validated.isSuccess() || validated.getPieces().isEmpty()) {
                    throw new IllegalArgumentException("分切车次在母卷 Y=" + round1(carStart) + "mm 处未通过几何/疵点校验：" + Objects.toString(validated.getMessage(), ""));
                }
                String pid = tx.savePendingPlan(req, validated);
                planIds.add(pid);

                if (firstStartY < 0) firstStartY = carStart;
                lastEndY = carStart + carLen;
                cursorY = lastEndY;
            }
        }

        if (planIds.isEmpty()) {
            throw new IllegalArgumentException("未能生成任何有效分切出车计划，请检查订单剩余量与母卷余长");
        }
        return new MaterializationResult(planIds, firstStartY, lastEndY - firstStartY);
    }

    void validateVirtual2DGeometry(SchedulingScheme.Layout2DPayload layout, double widthMm, double heightMm, double gapMm) {
        if (widthMm <= 0 || heightMm <= 0) throw new IllegalArgumentException("画布门幅与长度必须为正数");
        for (SchedulingScheme.PlacementItem p : layout.placements()) {
            double pw = p.shape() != null ? p.shape().width() : p.w();
            double ph = p.shape() != null ? p.shape().height() : p.l();
            if (p.x() < -0.5 || p.y() < -0.5 || p.x() + pw > widthMm + 1.0 || p.y() + ph > heightMm + 1.0) {
                throw new IllegalArgumentException("裁片「" + p.name() + "」超出虚拟母卷画布边界");
            }
            if (p.shape() != null && "POLYGON".equals(p.shape().type())) {
                PolygonGeometry.validate(p.shape());
            }
        }
        voidGapRef(gapMm);
    }

    CuttingTask appendGapFillLinesIfNeeded(CuttingStatePort.WriteTx tx, CuttingTask task, SchedulingScheme.Layout2DPayload layout) {
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
        return tx.saveTask(new CuttingTask(
                task.id(), task.name(), task.materialModel(), task.externalRef(),
                task.revision(), nextLines, task.process(), task.problemType(), task.slitting()
        ));
    }

    private CuttingTask syncTaskRotationPermissionsIfNeeded(
            CuttingStatePort.WriteTx tx, CuttingTask task, List<PieceDemand> reqDemands, boolean isContour
    ) {
        if (!tx.completedQuantities(task.id()).isEmpty()) return task;
        Map<Integer, PieceDemand> map = reqDemands.stream().collect(Collectors.toMap(PieceDemand::getId, d -> d, (a, b) -> a));
        List<CuttingTask.Line> updatedLines = new ArrayList<>();
        boolean changed = false;
        for (CuttingTask.Line line : task.demands()) {
            PieceDemand pd = map.get(line.id());
            boolean nextRot = line.allowRotation() || (!isContour && pd != null && pd.isAllowRotation());
            Boolean nextHalf = (Boolean.TRUE.equals(line.allowHalfTurn()) || (isContour && pd != null && Boolean.TRUE.equals(pd.getAllowHalfTurn())))
                    ? Boolean.TRUE : null;
            if (nextRot != line.allowRotation() || !Objects.equals(nextHalf, line.allowHalfTurn())) {
                changed = true;
                updatedLines.add(new CuttingTask.Line(
                        line.id(), line.name(), line.width(), line.length(), line.quantity(),
                        nextRot, line.shape(), nextHalf, line.sizeLabel(), line.sourceTemplateId(), line.surfaceTreatment()
                ));
            } else {
                updatedLines.add(line);
            }
        }
        if (!changed) return task;
        return tx.saveTask(new CuttingTask(
                task.id(), task.name(), task.materialModel(), task.externalRef(),
                task.revision(), updatedLines, task.process(), task.problemType(), task.slitting()
        ));
    }

    private double findDefectFreeCarStart(MotherRollInfo roll, double fromY, double carLen, List<PlacedPiece> strips) {
        double y = fromY;
        List<Defect> defs = roll.getDefects() == null ? List.of() : roll.getDefects();
        for (int guard = 0; guard < 200 && y + carLen <= roll.getTotalLength(); guard++) {
            double candidateY = y;
            Defect hit = defs.stream().filter(d -> {
                double m = d.getMargin();
                double dx0 = Math.max(0, d.getX() - m), dx1 = Math.min(roll.getWidth(), d.getX() + d.getW() + m);
                double dy0 = Math.max(0, d.getY() - m), dy1 = Math.min(roll.getTotalLength(), d.getY() + d.getH() + m);
                if (dy1 <= candidateY + 0.001 || dy0 >= candidateY + carLen - 0.001) return false;
                return strips.stream().anyMatch(s -> s.getX() + s.getW() > dx0 + 0.001 && s.getX() < dx1 - 0.001);
            }).findFirst().orElse(null);
            if (hit == null) return candidateY;
            y = Math.max(y + 10, hit.getY() + hit.getH() + hit.getMargin());
        }
        return y;
    }

    private double nextAvailableRollStart(CuttingStatePort.ReadView tx, MotherRollInfo roll, double neededLen, String exceptSchemeId) {
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
        intervals.sort(Comparator.comparingDouble(a -> a[0]));
        double cursor = roll.getUsedLength();
        for (double[] iv : intervals) {
            if (iv[1] <= cursor + 0.001) continue;
            if (iv[0] - cursor >= neededLen - 0.001) return cursor;
            cursor = Math.max(cursor, iv[1]);
        }
        return cursor;
    }

    private static CuttingTask.Line pickBestLineForWidth(List<CuttingTask.Line> lines, int widthMm, Map<Integer, Integer> remaining) {
        return lines.stream()
                .filter(l -> Math.abs(l.width() - widthMm) < 0.5)
                .max(Comparator.comparingInt(l -> remaining.getOrDefault(l.id(), 0)))
                .orElse(null);
    }

    private static void voidGapRef(double ignored) {}

    private static double round1(double v) {
        return Math.rint(v * 10.0) / 10.0;
    }
}
