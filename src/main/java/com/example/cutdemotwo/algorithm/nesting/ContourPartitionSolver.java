package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.algorithm.nesting.constraints.CurtainConstraintPack;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Material;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Part;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;

/**
 * 大批量二维异形“均衡互补分区求解 → 子区条带拼接 → 全局跨缝联动压紧”编排器。
 *
 * <p>核心流程：
 * <ol>
 *   <li><b>严格门控</b>：仅当矩形母板、无禁入区、窗帘约束 NOOP、{@code left-top} 起角且总件数
 *       {@code >= 48}、理论面积可行且剩余时间预算充足时触发；其余算例 100% 零变化沿用既有路径；</li>
 *   <li><b>均衡互补分桶</b>：按 {@code K = clamp((totalCount + 29) / 30, 2, 4)} 将每种 {@link Part}
 *       按比例均摊到各子区（大件+中件+补空小件同比例互补，严格保证总需求 100% 守恒）；</li>
 *   <li><b>高频同款等价原型去重 + 有界并行求解</b>：完全等价的子区原型仅求解一次并确定性复用，
 *       唯一原型通过 {@link NestingParallelExecutor} 并行调用 {@link DeepnestSolverEngine} 子区内核
 *       （共享线程安全 2048 LRU JTS NFP 缓存）；</li>
 *   <li><b>条带拼接（正向 + 交替 180° 互补翻转择优）+ 三明治全局跨缝压紧</b>：
 *       按 {@code yOffset = prevMaxY + pieceGap + safety} 拼接，调用
 *       {@link AxisMarkerCompactor} 与 {@link MarkerCompactor} 将后区裁片整体推入前区锯齿凹腔并填补残余空洞；</li>
 *   <li><b>零容忍出口验真与安全回退</b>：最终核对满排件数、母板总高上限并通过
 *       {@link PolygonResultValidator#validate}；任何一步不满足即返回 {@code null}，由主引擎安全回退常规直跑。</li>
 * </ol>
 */
final class ContourPartitionSolver {
    static final int MIN_PARTITION_PIECES = 48;
    static final int MIN_BUCKETS = 2;
    static final int MAX_BUCKETS = 4;
    static final int TARGET_BUCKET_PIECES = 30;
    private static final long MIN_BUDGET_NANOS = 500_000_000L;
    private static final double SEAM_GAP_SAFETY_MM = 0.05;
    private static final double SEAM_ZERO_GAP_SAFETY_MM = 0.005;
    private static final double MAX_STITCH_OVERFLOW_RATIO = 1.35;

    private ContourPartitionSolver() {}

    record Bucket(int index, List<Part> parts, int totalCount, double totalArea,
                  double minBboxArea, double maxPartHeight, double widePartsStackHeight,
                  String signature) {}

    record Diagnostics(int bucketCount, int uniquePrototypes,
                       long subSolveMs, long axis1Ms, long gapCompactMs, long seamLnsMs, long axis2Ms,
                       double stitchedFwdLen, double stitchedAltLen,
                       double afterAxis1Len, double afterGapLen, double afterSeamLnsLen, double finalLen,
                       boolean choseAlternating) {}

    private static final ThreadLocal<Diagnostics> LAST_DIAGNOSTICS = new ThreadLocal<>();

    static Diagnostics lastDiagnostics() {
        return LAST_DIAGNOSTICS.get();
    }

    static void clearDiagnostics() {
        LAST_DIAGNOSTICS.remove();
    }

    private record Prototype(String signature, Bucket representative, NestingProblem subProblem) {}

    private record SubSolution(List<Placement> placements, double extentY) {}

    static boolean isEligible(NestingProblem problem,
                              boolean isRectMat,
                              boolean pipelineIsNoop,
                              boolean preferRight,
                              boolean preferBottom,
                              int totalCount,
                              double totalRequestedArea,
                              double sheetArea,
                              long availableBudgetNanos) {
        boolean pureSelvedge = !pipelineIsNoop && CurtainConstraintPack.isPureSelvedgeOnly(problem, false);
        if (!isRectMat || (!pipelineIsNoop && !pureSelvedge) || preferRight || preferBottom) {
            return false;
        }
        if (MarkerCompactor.hasAnyHoles(problem)) {
            return false;
        }
        String corner = problem.process().startCorner();
        if (corner != null && !"left-top".equalsIgnoreCase(corner)) {
            return false;
        }
        if (!problem.material().exclusions().isEmpty()) {
            return false;
        }
        if (totalCount < MIN_PARTITION_PIECES) {
            return false;
        }
        if (availableBudgetNanos < MIN_BUDGET_NANOS) {
            return false;
        }
        double effectiveSheetArea = sheetArea;
        if (pureSelvedge) {
            double effW = problem.width()
                    - MarkerCompactor.pureSelvedgeLeft(problem)
                    - MarkerCompactor.pureSelvedgeRight(problem);
            if (effW <= 1e-6) {
                return false;
            }
            effectiveSheetArea = effW * problem.height();
        }
        // 物理面积必然超有效母板上限时不可能完整满排，直接走原常规路径
        return totalRequestedArea <= effectiveSheetArea + 1e-3;
    }

    static int computeBucketCount(int totalCount) {
        return Math.max(MIN_BUCKETS, Math.min(MAX_BUCKETS, (totalCount + TARGET_BUCKET_PIECES - 1) / TARGET_BUCKET_PIECES));
    }

    /**
     * 按面积降序遍历每种 {@link Part}，先按 {@code q / K} 均摊到全部子区，再将余数 {@code q % K}
     * 确定性地分摊给当前（件数最少、次优面积最小、再按桶号升序）的子区，确保大中小件同比例互补且总需求 100% 守恒。
     */
    static List<Bucket> buildBalancedBuckets(NestingProblem problem, int bucketCount) {
        List<Part> originalParts = problem.parts();
        int m = originalParts.size();
        double matW = problem.width();

        record PartMeta(int origIdx, Part part, double area, double minBboxArea,
                        double maxAllowedHeight, double minAllowedWidth, double minHeightAtMinWidth) {}
        List<PartMeta> metas = new ArrayList<>(m);
        for (int i = 0; i < m; i++) {
            ComputationCancellation.check();
            Part part = originalParts.get(i);
            double area = PolygonGeometry.area(part.shape());
            double minBbox = Double.POSITIVE_INFINITY;
            double maxH = 0.0;
            double minW = Double.POSITIVE_INFINITY;
            double hAtMinW = 0.0;
            for (int deg : part.contourAngles()) {
                Shape rot = PolygonGeometry.rotate(part.shape(), deg);
                double bbox = rot.width() * rot.height();
                if (bbox < minBbox) minBbox = bbox;
                if (rot.height() > maxH) maxH = rot.height();
                if (rot.width() < minW - 1e-9 || (Math.abs(rot.width() - minW) <= 1e-9 && rot.height() < hAtMinW)) {
                    minW = rot.width();
                    hAtMinW = rot.height();
                }
            }
            if (!Double.isFinite(minBbox)) {
                minBbox = part.shape().width() * part.shape().height();
            }
            if (!Double.isFinite(minW)) {
                minW = part.shape().width();
                hAtMinW = part.shape().height();
            }
            metas.add(new PartMeta(i, part, area, minBbox, maxH, minW, hAtMinW));
        }

        // 大件 → 中件 → 补空小件降序分配，使各桶余数大件与小件形成蛇形互补
        List<PartMeta> sorted = new ArrayList<>(metas);
        sorted.sort(Comparator
                .comparingDouble(PartMeta::area).reversed()
                .thenComparingInt(pm -> pm.part().id())
                .thenComparingInt(PartMeta::origIdx));

        int[][] qtyMatrix = new int[bucketCount][m];
        int[] bucketCounts = new int[bucketCount];
        double[] bucketAreas = new double[bucketCount];
        Integer[] bucketOrder = new Integer[bucketCount];
        for (int b = 0; b < bucketCount; b++) {
            bucketOrder[b] = b;
        }

        for (PartMeta pm : sorted) {
            ComputationCancellation.check();
            int q = pm.part().quantity();
            if (q <= 0) continue;
            int base = q / bucketCount;
            int rem = q % bucketCount;
            if (base > 0) {
                for (int b = 0; b < bucketCount; b++) {
                    qtyMatrix[b][pm.origIdx()] += base;
                    bucketCounts[b] += base;
                    bucketAreas[b] += base * pm.area();
                }
            }
            if (rem > 0) {
                java.util.Arrays.sort(bucketOrder, Comparator
                        .comparingInt((Integer b) -> bucketCounts[b])
                        .thenComparingDouble(b -> bucketAreas[b])
                        .thenComparingInt(Integer::intValue));
                for (int r = 0; r < rem; r++) {
                    int b = bucketOrder[r];
                    qtyMatrix[b][pm.origIdx()] += 1;
                    bucketCounts[b] += 1;
                    bucketAreas[b] += pm.area();
                }
            }
        }

        List<Bucket> buckets = new ArrayList<>(bucketCount);
        for (int b = 0; b < bucketCount; b++) {
            List<Part> subParts = new ArrayList<>();
            StringBuilder sig = new StringBuilder();
            int count = 0;
            double area = 0.0;
            double bboxArea = 0.0;
            double maxH = 0.0;
            double wideStackH = 0.0;
            for (int i = 0; i < m; i++) {
                int subQ = qtyMatrix[b][i];
                if (subQ <= 0) continue;
                PartMeta pm = metas.get(i);
                Part orig = pm.part();
                subParts.add(new Part(
                        orig.id(), orig.name(), orig.shape(), subQ,
                        orig.allowRotation(), orig.allowHalfTurn(), orig.rule()
                ));
                sig.append(orig.id()).append(':').append(subQ).append(';');
                count += subQ;
                area += subQ * pm.area();
                bboxArea += subQ * pm.minBboxArea();
                if (pm.maxAllowedHeight() > maxH) {
                    maxH = pm.maxAllowedHeight();
                }
                if (pm.minAllowedWidth() > matW * 0.5) {
                    wideStackH += subQ * pm.minHeightAtMinWidth();
                }
            }
            buckets.add(new Bucket(b, List.copyOf(subParts), count, area, bboxArea, maxH, wideStackH, sig.toString()));
        }

        // 防御性守恒校验：确保分桶总件数与每种零件数量 100% 严格守恒
        for (int i = 0; i < m; i++) {
            int sum = 0;
            for (int b = 0; b < bucketCount; b++) {
                sum += qtyMatrix[b][i];
            }
            if (sum != originalParts.get(i).quantity()) {
                throw new IllegalStateException("分区需求守恒校验失败: partId=" + originalParts.get(i).id());
            }
        }
        return buckets;
    }

    /**
     * 执行均衡互补分区并行求解 + 条带拼接 + 全局接缝压紧 + 零容忍验真。
     * 若任一子区未能完整满排、拼接压紧后仍超出母板高度或未通过零容忍校验，返回 {@code null} 触发安全回退。
     */
    static EngineResult solve(DeepnestSolverEngine engine,
                              NestingProblem problem,
                              int totalCount,
                              boolean stripMode,
                              long globalDeadlineNanos) {
        LAST_DIAGNOSTICS.remove();
        ComputationCancellation.check();
        long now = System.nanoTime();
        long availableNanos = globalDeadlineNanos - now;
        if (availableNanos < MIN_BUDGET_NANOS) {
            return null;
        }

        // 若仅含纯左右布边禁区，剥离布边进入等效净幅宽高速分区管线，出口再平移回物理坐标并按原问题零容忍终检
        boolean pureSelvedge = !CurtainConstraintPack.forProblem(problem).isNoop()
                && CurtainConstraintPack.isPureSelvedgeOnly(problem, false);
        double leftShift = pureSelvedge ? MarkerCompactor.pureSelvedgeLeft(problem) : 0.0;
        NestingProblem solveProblem = pureSelvedge ? MarkerCompactor.stripPureSelvedgeProblem(problem) : problem;

        int bucketCount = computeBucketCount(totalCount);
        List<Bucket> buckets = buildBalancedBuckets(solveProblem, bucketCount);
        if (buckets.stream().anyMatch(b -> b.totalCount() <= 0)) {
            return null;
        }

        // 等价子区原型去重（按首次出现的桶号保持确定性顺序），高频同款大单可成倍省算力
        Map<String, Prototype> uniquePrototypes = new LinkedHashMap<>();
        double matW = solveProblem.width();
        double matH = solveProblem.height();
        double pieceGap = Math.max(Math.max(0.0, solveProblem.process().pieceGap()), Math.max(0.0, solveProblem.process().kerf()));

        for (Bucket bucket : buckets) {
            if (!uniquePrototypes.containsKey(bucket.signature())) {
                double subMatH = computeCompactSubHeight(bucket, matW, matH, pieceGap);
                Material subMat = new Material(
                        solveProblem.material().id() + "#part" + uniquePrototypes.size(),
                        Shape.rectangle(matW, subMatH),
                        List.of(),
                        false,
                        null
                );
                NestingProblem subProblem = new NestingProblem(
                        solveProblem.schemaVersion(),
                        solveProblem.unit(),
                        subMat,
                        bucket.parts(),
                        solveProblem.process(),
                        solveProblem.engine(),
                        solveProblem.timeLimitSeconds()
                );
                uniquePrototypes.put(bucket.signature(), new Prototype(bucket.signature(), bucket, subProblem));
            }
        }

        List<Prototype> prototypeList = new ArrayList<>(uniquePrototypes.values());
        int uniqueCount = prototypeList.size();

        // 预算划分：子区并行求解占约 52%（留足空间给全局接缝压紧，及万一回退常规直跑的余量）
        long subSolveBudget = Math.max(250_000_000L, (long) (availableNanos * 0.52));
        long subDeadlineNanos = System.nanoTime() + subSolveBudget;

        // 仅 1 个唯一原型时在当前线程求解并开放内层并行；多个原型时外层并行、内层串行以杜绝线程池嵌套阻塞
        final boolean allowInnerParallel = (uniqueCount == 1);
        List<Callable<SubSolution>> tasks = new ArrayList<>(uniqueCount);
        for (Prototype proto : prototypeList) {
            final int subN = proto.representative().totalCount();
            final NestingProblem subProblem = proto.subProblem();
            tasks.add(() -> solveSinglePrototype(engine, subProblem, subN, uniqueCount, stripMode, allowInnerParallel, subDeadlineNanos));
        }

        long tSub0 = System.nanoTime();
        List<SubSolution> protoSolutions = NestingParallelExecutor.runDeterministic(tasks);
        long subSolveMs = (System.nanoTime() - tSub0) / 1_000_000L;
        ComputationCancellation.check();

        Map<String, SubSolution> solutionBySig = new HashMap<>(uniqueCount * 2);
        for (int i = 0; i < uniqueCount; i++) {
            SubSolution sol = protoSolutions.get(i);
            if (sol == null) {
                return null;
            }
            solutionBySig.put(prototypeList.get(i).signature(), sol);
        }

        List<SubSolution> orderedSubs = new ArrayList<>(bucketCount);
        for (Bucket bucket : buckets) {
            SubSolution sol = solutionBySig.get(bucket.signature());
            if (sol == null || sol.placements().size() != bucket.totalCount()) {
                return null;
            }
            orderedSubs.add(sol);
        }

        Map<Integer, Part> partById = new HashMap<>(solveProblem.parts().size() * 2);
        for (Part part : solveProblem.parts()) {
            partById.put(part.id(), part);
        }

        // 候选 1：正向条带拼接
        List<Placement> forwardStitched = stitchBuckets(orderedSubs, false, matW, pieceGap, partById);
        if (forwardStitched == null || forwardStitched.size() != totalCount) {
            return null;
        }

        // 候选 2：交替 180° 互补翻转拼接（仅当奇数区全员允许 +180° 时启用，让相邻子区锯齿对咬、平底贴平顶）
        List<Placement> alternatingStitched = stitchBuckets(orderedSubs, true, matW, pieceGap, partById);

        double fwdInitLen = placementsExtentY(forwardStitched);
        double altInitLen = alternatingStitched != null ? placementsExtentY(alternatingStitched) : Double.NaN;
        double minInitialExtent = alternatingStitched != null ? Math.min(fwdInitLen, altInitLen) : fwdInitLen;
        // 拼接高度严重超出母板上限时放弃压紧，直接安全回退常规直跑
        if (minInitialExtent > matH * MAX_STITCH_OVERFLOW_RATIO + 100.0) {
            return null;
        }

        // 记录各条子区接缝的近似 Y 位置，供局部跨缝微调定点发力
        List<Double> seamYs = new ArrayList<>(Math.max(0, orderedSubs.size() - 1));
        double accY = 0.0;
        double seamStepEst = pieceGap > 0.0 ? (pieceGap + SEAM_GAP_SAFETY_MM) : SEAM_ZERO_GAP_SAFETY_MM;
        for (int b = 0; b < orderedSubs.size() - 1; b++) {
            accY += orderedSubs.get(b).extentY() + seamStepEst;
            seamYs.add(accY);
        }

        // ==================== 全局跨缝联动压紧（Axis1 → MarkerCompactor → 跨缝微调 → Axis2） ====================
        long remainingForCompact = globalDeadlineNanos - System.nanoTime();
        long maxCompactCap = Math.min(2_200_000_000L, Math.max(300_000_000L, (long) (availableNanos * 0.35)));
        long compactBudget = Math.min(maxCompactCap, Math.max(0L, remainingForCompact - 60_000_000L));
        long compactDeadline = System.nanoTime() + compactBudget;

        long[] phaseMs = new long[4];
        double[] phaseLens = new double[4];
        boolean[] choseAlt = new boolean[1];
        List<Placement> bestLayout = compactStitchedCandidates(
                engine, solveProblem, forwardStitched, alternatingStitched, seamYs, compactDeadline, phaseMs, phaseLens, choseAlt);
        ComputationCancellation.check();

        if (bestLayout == null || bestLayout.size() != totalCount) {
            return null;
        }
        double finalExtentY = placementsExtentY(bestLayout);
        if (finalExtentY > matH + 1e-6) {
            return null;
        }
        if (pureSelvedge && leftShift > 0.0) {
            bestLayout = MarkerCompactor.shiftPlacementsX(bestLayout, leftShift);
        }

        EngineResult result = new EngineResult();
        result.setSuccess(true);
        result.setPlacements(bestLayout);
        // 出口零容忍几何与原始布边约束终检：不通过则安全回退原路径
        if (PolygonResultValidator.validate(problem, result) != null) {
            return null;
        }
        LAST_DIAGNOSTICS.set(new Diagnostics(
                bucketCount, uniqueCount, subSolveMs,
                phaseMs[0], phaseMs[1], phaseMs[2], phaseMs[3],
                fwdInitLen, altInitLen,
                phaseLens[0], phaseLens[1], phaseLens[2], finalExtentY, choseAlt[0]
        ));
        return result;
    }

    private static double computeCompactSubHeight(Bucket bucket, double matW, double matH, double pieceGap) {
        double safeW = Math.max(1.0, matW);
        double areaBased = (bucket.totalArea() / safeW) * 2.5 + bucket.maxPartHeight() * 1.6 + bucket.totalCount() * pieceGap;
        double bboxBased = (bucket.minBboxArea() / safeW) * 2.0 + bucket.maxPartHeight() * 1.4 + bucket.totalCount() * pieceGap;
        double wideBased = bucket.widePartsStackHeight() + bucket.maxPartHeight() * 1.2 + bucket.totalCount() * pieceGap;
        double est = Math.max(Math.max(areaBased, bboxBased), wideBased);
        return Math.min(matH, Math.max(bucket.maxPartHeight() + 1.0, est));
    }

    private static SubSolution solveSinglePrototype(DeepnestSolverEngine engine,
                                                    NestingProblem subProblem,
                                                    int expectedCount,
                                                    int uniqueCount,
                                                    boolean stripMode,
                                                    boolean allowInnerParallel,
                                                    long subDeadlineNanos) {
        ComputationCancellation.check();
        // 为子区配置高质量且确定性收敛的搜索上限：
        // 单一去重原型可独享多核，保持适度精修以保留尾部可咬合轮廓并兼顾极速；
        // 多原型并行则使用精炼种群与充分 LNS 兼顾速度与紧凑度。
        int popCap = uniqueCount == 1 ? 12 : 10;
        int maxGen = uniqueCount == 1 ? (expectedCount >= 32 ? 5 : 6) : 6;
        int maxStagnant = 3;
        int maxLnsRounds = uniqueCount == 1 ? 12 : 14;
        int maxLnsStagnant = uniqueCount == 1 ? 4 : 5;

        EngineResult subRes = engine.solveSubproblem(
                subProblem, stripMode, allowInnerParallel, subDeadlineNanos,
                popCap, maxGen, maxStagnant, maxLnsRounds, maxLnsStagnant
        );
        ComputationCancellation.check();
        if (subRes == null || !subRes.isSuccess() || subRes.getPlacements().size() != expectedCount) {
            return null;
        }
        List<Placement> placements = subRes.getPlacements();
        double extentY = placementsExtentY(placements);
        return new SubSolution(placements, extentY);
    }

    private static List<Placement> stitchBuckets(List<SubSolution> orderedSubs,
                                                 boolean flipOddBuckets180,
                                                 double matW,
                                                 double pieceGap,
                                                 Map<Integer, Part> partById) {
        int totalSize = 0;
        for (SubSolution sub : orderedSubs) {
            totalSize += sub.placements().size();
        }
        List<Placement> stitched = new ArrayList<>(totalSize);
        double seamStep = pieceGap > 0.0
                ? (pieceGap + SEAM_GAP_SAFETY_MM)
                : SEAM_ZERO_GAP_SAFETY_MM;
        double yOffset = 0.0;
        int nextId = 1;

        for (int b = 0; b < orderedSubs.size(); b++) {
            ComputationCancellation.check();
            SubSolution sub = orderedSubs.get(b);
            List<Placement> localPlacements = sub.placements();
            if (flipOddBuckets180 && (b % 2 == 1)) {
                localPlacements = flipBucket180(localPlacements, matW, sub.extentY(), partById);
                if (localPlacements == null) {
                    return null;
                }
            }
            double blockMaxY = yOffset;
            for (Placement p : localPlacements) {
                double py = p.y() + yOffset;
                stitched.add(new Placement(
                        nextId++, p.demandId(), p.name(),
                        p.x(), py, p.shape(), p.rotationDegrees()
                ));
                blockMaxY = Math.max(blockMaxY, py + p.shape().height());
            }
            yOffset = blockMaxY + seamStep;
        }
        return stitched;
    }

    private static List<Placement> flipBucket180(List<Placement> subPlacements,
                                                 double matW,
                                                 double subMaxY,
                                                 Map<Integer, Part> partById) {
        List<Placement> flipped = new ArrayList<>(subPlacements.size());
        for (Placement p : subPlacements) {
            Part part = partById.get(p.demandId());
            if (part == null) {
                return null;
            }
            int newAngle = Math.floorMod(p.rotationDegrees() + 180, 360);
            if (!part.contourAngles().contains(newAngle)) {
                return null;
            }
            Shape rotated = PolygonGeometry.rotate(part.shape(), newAngle);
            double nx = matW - p.x() - rotated.width();
            double ny = subMaxY - p.y() - rotated.height();
            if (nx < -1e-4 || ny < -1e-4
                    || nx + rotated.width() > matW + 1e-4
                    || ny + rotated.height() > subMaxY + 1e-4) {
                return null;
            }
            nx = Math.max(0.0, Math.min(matW - rotated.width(), nx));
            ny = Math.max(0.0, Math.min(subMaxY - rotated.height(), ny));
            flipped.add(new Placement(p.id(), p.demandId(), p.name(), nx, ny, rotated, newAngle));
        }
        return flipped;
    }

    private static List<Placement> compactStitchedCandidates(DeepnestSolverEngine engine,
                                                             NestingProblem originalProblem,
                                                             List<Placement> forwardStitched,
                                                             List<Placement> alternatingStitched,
                                                             List<Double> seamYs,
                                                             long compactDeadline,
                                                             long[] phaseMs,
                                                             double[] phaseLens,
                                                             boolean[] choseAlt) {
        ComputationCancellation.check();
        List<Placement> current = forwardStitched;
        double currentExtent = placementsExtentY(current);
        phaseLens[0] = currentExtent;
        phaseLens[1] = currentExtent;
        phaseLens[2] = currentExtent;
        phaseLens[3] = currentExtent;
        long now = System.nanoTime();
        long remaining = compactDeadline - now;
        if (remaining <= 10_000_000L || current.size() > MarkerCompactor.MAX_COMPACT_PIECES) {
            return current;
        }

        // 第 1 层：AxisMarkerCompactor 跨缝整体同步推紧（若存在交替翻转候选则双路快评择优，给足单路安全预算避免半途截断）
        long t0 = System.nanoTime();
        long axisPhase1Budget = Math.min(900_000_000L, Math.max(120_000_000L, (long) (remaining * 0.35)));
        if (alternatingStitched != null) {
            long halfBudget = axisPhase1Budget / 2;
            NestingProblem fwdCompactProb = problemWithMinHeight(originalProblem, currentExtent + 1.0);
            List<Placement> fwdAxis = AxisMarkerCompactor.compact(fwdCompactProb, forwardStitched, System.nanoTime() + halfBudget);
            double fwdExt = placementsExtentY(fwdAxis);

            ComputationCancellation.check();
            double altInitExtent = placementsExtentY(alternatingStitched);
            NestingProblem altCompactProb = problemWithMinHeight(originalProblem, altInitExtent + 1.0);
            List<Placement> altAxis = AxisMarkerCompactor.compact(altCompactProb, alternatingStitched, System.nanoTime() + halfBudget);
            double altExt = placementsExtentY(altAxis);

            if (altExt < fwdExt - 1e-6) {
                current = altAxis;
                currentExtent = altExt;
                choseAlt[0] = true;
            } else {
                current = fwdAxis;
                currentExtent = fwdExt;
            }
        } else {
            NestingProblem compactProb = problemWithMinHeight(originalProblem, currentExtent + 1.0);
            List<Placement> axis1 = AxisMarkerCompactor.compact(compactProb, current, System.nanoTime() + axisPhase1Budget);
            double axis1Ext = placementsExtentY(axis1);
            if (axis1Ext < currentExtent - 1e-6) {
                current = axis1;
                currentExtent = axis1Ext;
            }
        }
        phaseMs[0] = (System.nanoTime() - t0) / 1_000_000L;
        phaseLens[0] = currentExtent;

        ComputationCancellation.check();
        now = System.nanoTime();
        remaining = compactDeadline - now;
        if (remaining <= 15_000_000L) {
            phaseLens[1] = currentExtent;
            phaseLens[2] = currentExtent;
            phaseLens[3] = currentExtent;
            return current;
        }

        // 第 2 层：MarkerCompactor 末端剥皮跨缝空隙重插压紧（内置大批量确定性早停，给足上限避免半途撞墙）
        long t1 = System.nanoTime();
        NestingProblem activeCompactProb = problemWithMinHeight(originalProblem, currentExtent + 1.0);
        if (MarkerCompactor.supportsGapSearch(activeCompactProb)) {
            long gapBudget = Math.min(450_000_000L, Math.max(40_000_000L, (long) (remaining * 0.30)));
            List<Placement> gapCompacted = MarkerCompactor.compact(activeCompactProb, current, now + gapBudget);
            if (gapCompacted != current && gapCompacted.size() == current.size()) {
                double gapExt = placementsExtentY(gapCompacted);
                if (gapExt < currentExtent - 1e-6) {
                    current = gapCompacted;
                    currentExtent = gapExt;
                }
            }
        }
        phaseMs[1] = (System.nanoTime() - t1) / 1_000_000L;
        phaseLens[1] = currentExtent;

        // 第 3 层：局部跨缝 + 末端精确 NFP 微调（拔出接缝带与末端瓶颈件用精确 NFP 重新融合插入）
        ComputationCancellation.check();
        now = System.nanoTime();
        remaining = compactDeadline - now;
        if (remaining > 80_000_000L) {
            long t2 = System.nanoTime();
            long seamLnsBudget = Math.max(40_000_000L, remaining - 200_000_000L);
            int seamRounds = current.size() <= 80 ? 4 : 3;
            NestingProblem lnsProb = problemWithMinHeight(originalProblem, currentExtent + 1.0);
            List<Placement> refined = engine.refineSeamAndTail(lnsProb, current, seamYs, seamRounds, now + seamLnsBudget);
            if (refined != current && refined.size() == current.size()) {
                double refExt = placementsExtentY(refined);
                if (refExt < currentExtent - 1e-6) {
                    current = refined;
                    currentExtent = refExt;
                }
            }
            phaseMs[2] = (System.nanoTime() - t2) / 1_000_000L;
        }
        phaseLens[2] = currentExtent;

        ComputationCancellation.check();
        now = System.nanoTime();
        if (compactDeadline - now > 15_000_000L) {
            // 第 4 层：再次 AxisMarkerCompactor 收尾同步推紧，吃掉微调后腾出的全部残余缝隙
            long t3 = System.nanoTime();
            NestingProblem finalCompactProb = problemWithMinHeight(originalProblem, currentExtent + 1.0);
            List<Placement> axis2 = AxisMarkerCompactor.compact(finalCompactProb, current, compactDeadline);
            if (axis2 != current && axis2.size() == current.size()) {
                double axis2Ext = placementsExtentY(axis2);
                if (axis2Ext < currentExtent - 1e-6) {
                    current = axis2;
                    currentExtent = axis2Ext;
                }
            }
            phaseMs[3] = (System.nanoTime() - t3) / 1_000_000L;
        }
        phaseLens[3] = currentExtent;

        return current;
    }

    private static NestingProblem problemWithMinHeight(NestingProblem problem, double minRequiredH) {
        if (minRequiredH <= problem.height() + 1e-9) {
            return problem;
        }
        Material mat = problem.material();
        Material expanded = new Material(
                mat.id(),
                Shape.rectangle(problem.width(), minRequiredH),
                mat.exclusions(),
                mat.continuesAfterRegion(),
                mat.fabricRule()
        );
        return new NestingProblem(
                problem.schemaVersion(),
                problem.unit(),
                expanded,
                problem.parts(),
                problem.process(),
                problem.engine(),
                problem.timeLimitSeconds()
        );
    }

    private static double placementsExtentY(List<Placement> placements) {
        double maxY = 0.0;
        for (Placement p : placements) {
            maxY = Math.max(maxY, p.y() + p.shape().height());
        }
        return maxY;
    }
}
