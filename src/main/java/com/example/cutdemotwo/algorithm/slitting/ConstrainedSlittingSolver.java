package com.example.cutdemotwo.algorithm.slitting;

import com.example.cutdemotwo.contracts.slitting.SlittingProblem;
import com.example.cutdemotwo.contracts.slitting.SlittingResult;
import com.example.cutdemotwo.contracts.slitting.SlittingValidation;
import com.google.ortools.Loader;
import com.google.ortools.linearsolver.MPConstraint;
import com.google.ortools.linearsolver.MPObjective;
import com.google.ortools.linearsolver.MPSolver;
import com.google.ortools.linearsolver.MPVariable;

import java.util.*;
import java.util.concurrent.TimeUnit;

/**
 * 物理刀架硬约束与多宽母卷联合选料一维分切求解器。
 * 严格落实：
 * 1. 单车最大刀数/切条数上限（maxKnives）；
 * 2. 刀片最小物理间距（minBladeSpacingMm）；
 * 3. 危险细边丝禁区（forbiddenNarrowEdgeMinMm..MaxMm，0 视为无边丝合法）；
 * 4. 每刀切缝损耗（kerfMm，计入单车总占用宽度与尾边核算）；
 * 5. 多规格母卷宽幅池联合择优与各规格可用母卷上限（candidateRollWidths）。
 * 求解后自动接入 {@link KnifeSetupSequenceOptimizer} 最小化相邻车次换刀次数，并经 {@link SlittingValidation} 独立验真。
 */
final class ConstrainedSlittingSolver {
    private static final int MAX_DFS_NODES_PER_SPEC = 120_000;
    private static final int MAX_PATTERNS_PER_SPEC = 800;
    private static final int MAX_COLGEN_ITERATIONS = 40;
    private static final long MAX_DP_STATES = 1_500_000L;
    private static final double EPS = 1e-6;
    private static volatile boolean nativeLoaded = false;

    private ConstrainedSlittingSolver() {}

    private record GroupKey(long lengthMm, String surfaceTreatment) implements Comparable<GroupKey> {
        @Override
        public int compareTo(GroupKey other) {
            int cmp = Long.compare(this.lengthMm, other.lengthMm);
            if (cmp != 0) return cmp;
            return this.surfaceTreatment.compareTo(other.surfaceTreatment);
        }
    }

    private record RollSpec(int specIndex, int motherWidthMm, int usableWidthMm, Integer availableRolls, int[] legalRollWidths) {
        int maxLegalRollWidth() {
            return legalRollWidths[legalRollWidths.length - 1];
        }
    }

    private record FeasiblePattern(
            GroupKey groupKey,
            int specIndex,
            int motherWidthMm,
            int usableWidthMm,
            int rollWidthMm,
            int pieceWidthMm,
            int totalStrips,
            int tailEdgeMm,
            int[] widths,
            int[] counts
    ) {
        String signature() {
            StringBuilder sb = new StringBuilder();
            sb.append(groupKey.lengthMm).append('|').append(groupKey.surfaceTreatment)
                    .append('|').append(motherWidthMm).append('|').append(rollWidthMm).append('|');
            for (int i = 0; i < widths.length; i++) {
                if (counts[i] > 0) {
                    sb.append(widths[i]).append('x').append(counts[i]).append(',');
                }
            }
            return sb.toString();
        }
    }

    static SlittingResult solve(SlittingProblem problem, long budgetMs) {
        SlittingValidation.validateProblem(problem);
        ensureOrToolsLoaded();
        long deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(Math.max(500L, budgetMs));

        // 1. 按 (lengthMm, surfaceTreatment) 确定性分组
        TreeMap<GroupKey, List<SlittingProblem.Order>> groups = new TreeMap<>();
        for (SlittingProblem.Order order : problem.orders()) {
            groups.computeIfAbsent(new GroupKey(order.lengthMm(), order.surfaceTreatment()), k -> new ArrayList<>()).add(order);
        }

        // 2. 构建候选母卷规格列表
        boolean multiPool = problem.hasCandidateRollWidths();
        List<RollSpec> rollSpecs = buildRollSpecs(problem, multiPool);

        // 3. 为每个工艺组与母卷规格生成严格满足全部物理硬约束的可行花型池
        Map<GroupKey, TreeMap<Integer, Integer>> groupDemands = new LinkedHashMap<>();
        List<FeasiblePattern> allPatterns = new ArrayList<>();
        Set<String> seenSignatures = new HashSet<>();
        boolean anyTruncated = false;

        for (var entry : groups.entrySet()) {
            GroupKey gk = entry.getKey();
            TreeMap<Integer, Integer> demandMap = new TreeMap<>();
            for (SlittingProblem.Order o : entry.getValue()) {
                demandMap.merge(o.widthMm(), o.quantity(), Integer::sum);
            }
            groupDemands.put(gk, demandMap);

            int[] widthsDesc = demandMap.keySet().stream()
                    .sorted(Comparator.reverseOrder())
                    .mapToInt(Integer::intValue)
                    .toArray();

            for (RollSpec spec : rollSpecs) {
                if (System.nanoTime() >= deadlineNanos) {
                    break;
                }
                GenerationResult generated = generatePatternsForGroupAndSpec(problem, gk, spec, widthsDesc, deadlineNanos);
                if (generated.truncated) {
                    anyTruncated = true;
                }
                for (FeasiblePattern fp : generated.patterns) {
                    if (seenSignatures.add(fp.signature())) {
                        allPatterns.add(fp);
                    }
                }
            }
        }

        if (allPatterns.isEmpty()) {
            return buildEmptyResult(problem);
        }

        // 4. 若组合空间被截断且仍有时间预算，运行带物理约束的 GLOP 列生成定价补充优质花型
        if (anyTruncated && System.nanoTime() < deadlineNanos) {
            enrichWithColumnGeneration(problem, groupDemands, rollSpecs, allPatterns, seenSignatures, deadlineNanos);
        }

        // 5. 联合求解 OR-Tools 整数规划（全局超产上限 + 多宽母卷库存上限 + 最小化欠产与母卷耗用面积）
        Map<Integer, Integer> selectedRepetitions = solveUnifiedMip(problem, groupDemands, rollSpecs, allPatterns, deadlineNanos);
        if (selectedRepetitions.isEmpty()) {
            return buildEmptyResult(problem);
        }

        // 6. 将选定花型确定性映射到订单分配并执行换刀排序与独立验真
        return buildVerifiedResult(problem, groups, allPatterns, selectedRepetitions, multiPool);
    }

    private static synchronized void ensureOrToolsLoaded() {
        if (!nativeLoaded) {
            Loader.loadNativeLibraries();
            nativeLoaded = true;
        }
    }

    private static List<RollSpec> buildRollSpecs(SlittingProblem p, boolean multiPool) {
        int leftTrim = p.leftTrimMm();
        int rightTrim = p.rightTrimMm();
        List<RollSpec> specs = new ArrayList<>();
        if (multiPool) {
            List<SlittingProblem.CandidateRollWidth> sorted = new ArrayList<>(p.candidateRollWidths());
            sorted.sort(Comparator.comparingInt(SlittingProblem.CandidateRollWidth::widthMm));
            for (int i = 0; i < sorted.size(); i++) {
                var c = sorted.get(i);
                int usable = c.widthMm() - leftTrim - rightTrim;
                specs.add(new RollSpec(i, c.widthMm(), usable, c.availableRolls(), new int[]{usable}));
            }
        } else {
            int usable = p.motherWidthMm() - leftTrim - rightTrim;
            List<Integer> legalWidths = new ArrayList<>();
            for (int w = p.minWidthMm(); w <= p.maxWidthMm(); w += p.widthStepMm()) {
                legalWidths.add(w);
            }
            int[] arr = legalWidths.stream().mapToInt(Integer::intValue).toArray();
            specs.add(new RollSpec(0, p.motherWidthMm(), usable, null, arr));
        }
        return specs;
    }

    private record GenerationResult(List<FeasiblePattern> patterns, boolean truncated) {}

    private static GenerationResult generatePatternsForGroupAndSpec(
            SlittingProblem problem,
            GroupKey gk,
            RollSpec spec,
            int[] allWidthsDesc,
            long deadlineNanos
    ) {
        int maxRollWidth = spec.maxLegalRollWidth();
        int kerf = problem.effectiveKerfMm();
        int[] widths = Arrays.stream(allWidthsDesc).filter(w -> w <= maxRollWidth).toArray();
        if (widths.length == 0) {
            return new GenerationResult(List.of(), false);
        }

        int minWidth = widths[widths.length - 1];
        int physicalCapByWidth = (maxRollWidth + kerf) / (minWidth + kerf);
        int maxKnives = problem.maxKnives() != null ? Math.min(problem.maxKnives(), physicalCapByWidth) : physicalCapByWidth;
        if (maxKnives < 1) {
            return new GenerationResult(List.of(), false);
        }
        int maxDistinct = problem.maxDistinctWidths() != null
                ? Math.min(problem.maxDistinctWidths(), widths.length)
                : Math.min(widths.length, 6);

        int poolLimit = problem.maxPatterns() != null
                ? Math.max(64, Math.min(problem.maxPatterns(), MAX_PATTERNS_PER_SPEC))
                : MAX_PATTERNS_PER_SPEC;

        // 使用按废边升序、条数升序的优先队列（最大堆维护 Top-poolLimit）保证最优花型不被淘汰
        Comparator<FeasiblePattern> qualityOrder = Comparator
                .comparingInt(FeasiblePattern::tailEdgeMm)
                .thenComparingInt(FeasiblePattern::rollWidthMm)
                .thenComparingInt(FeasiblePattern::totalStrips)
                .thenComparing(FeasiblePattern::signature);
        PriorityQueue<FeasiblePattern> topHeap = new PriorityQueue<>(qualityOrder.reversed());
        Set<String> localSeen = new HashSet<>();

        // 1. 单宽纯切优先保底（保证每个可切宽幅至少存在合法覆盖列，包括避开细边禁区的降条数版本）
        for (int i = 0; i < widths.length; i++) {
            int w = widths[i];
            int maxC = Math.min(maxKnives, (maxRollWidth + kerf) / (w + kerf));
            int foundForWidth = 0;
            for (int c = maxC; c >= 1 && foundForWidth < 2; c--) {
                int pieceW = c * w;
                int occW = pieceW + (c - 1) * kerf;
                int rollW = pickBestLegalRollWidth(occW, spec.legalRollWidths(), problem);
                if (rollW > 0) {
                    int[] counts = new int[widths.length];
                    counts[i] = c;
                    FeasiblePattern fp = new FeasiblePattern(
                            gk, spec.specIndex(), spec.motherWidthMm(), spec.usableWidthMm(),
                            rollW, pieceW, c, rollW - occW, widths, counts);
                    if (localSeen.add(fp.signature())) {
                        offerPattern(topHeap, fp, poolLimit, qualityOrder);
                    }
                    foundForWidth++;
                }
            }
        }

        // 2. 受控分支定界 DFS 枚举高质量多宽组合花型
        int[] counts = new int[widths.length];
        int[] nodeCounter = new int[]{0};
        boolean[] truncated = new boolean[]{false};
        dfsEnumerate(problem, gk, spec, widths, kerf, maxKnives, maxDistinct, minWidth,
                0, 0, 0, 0, counts, topHeap, localSeen, poolLimit, qualityOrder, nodeCounter, truncated, deadlineNanos);

        List<FeasiblePattern> sorted = new ArrayList<>(topHeap);
        sorted.sort(qualityOrder);
        return new GenerationResult(sorted, truncated[0]);
    }

    private static void dfsEnumerate(
            SlittingProblem problem,
            GroupKey gk,
            RollSpec spec,
            int[] widths,
            int kerf,
            int maxKnives,
            int maxDistinct,
            int minWidth,
            int idx,
            int usedStrips,
            int usedDistinct,
            int pieceWidth,
            int[] counts,
            PriorityQueue<FeasiblePattern> topHeap,
            Set<String> localSeen,
            int poolLimit,
            Comparator<FeasiblePattern> qualityOrder,
            int[] nodeCounter,
            boolean[] truncated,
            long deadlineNanos
    ) {
        if (truncated[0]) {
            return;
        }
        nodeCounter[0]++;
        if (nodeCounter[0] > MAX_DFS_NODES_PER_SPEC || (nodeCounter[0] & 1023) == 0 && System.nanoTime() >= deadlineNanos) {
            truncated[0] = true;
            return;
        }

        int maxRollWidth = spec.maxLegalRollWidth();
        int occupiedWidth = usedStrips > 0 ? pieceWidth + (usedStrips - 1) * kerf : 0;
        int remainingWidth = maxRollWidth - occupiedWidth;
        int minNextNeed = usedStrips > 0 ? minWidth + kerf : minWidth;

        boolean canExtend = idx < widths.length
                && usedStrips < maxKnives
                && usedDistinct < maxDistinct
                && remainingWidth >= minNextNeed;

        // 当无法继续扩展，或启用细边禁区时允许在合法中间节点截断（少切一条可能正好避开危险细边丝）
        if (usedStrips > 0 && (!canExtend || problem.hasForbiddenNarrowEdge())) {
            int rollW = pickBestLegalRollWidth(occupiedWidth, spec.legalRollWidths(), problem);
            if (rollW > 0) {
                FeasiblePattern fp = new FeasiblePattern(
                        gk, spec.specIndex(), spec.motherWidthMm(), spec.usableWidthMm(),
                        rollW, pieceWidth, usedStrips, rollW - occupiedWidth, widths, counts.clone());
                if (localSeen.add(fp.signature())) {
                    offerPattern(topHeap, fp, poolLimit, qualityOrder);
                }
            }
        }

        if (!canExtend) {
            return;
        }

        int w = widths[idx];
        int remainingStrips = maxKnives - usedStrips;
        int maxCount;
        if (usedStrips == 0) {
            maxCount = Math.min(remainingStrips, (maxRollWidth + kerf) / (w + kerf));
        } else {
            maxCount = Math.min(remainingStrips, remainingWidth / (w + kerf));
        }

        for (int c = maxCount; c >= 0; c--) {
            counts[idx] = c;
            int nextStrips = usedStrips + c;
            int nextDistinct = usedDistinct + (c > 0 ? 1 : 0);
            int nextPieceW = pieceWidth + c * w;
            dfsEnumerate(problem, gk, spec, widths, kerf, maxKnives, maxDistinct, minWidth,
                    idx + 1, nextStrips, nextDistinct, nextPieceW, counts,
                    topHeap, localSeen, poolLimit, qualityOrder, nodeCounter, truncated, deadlineNanos);
        }
        counts[idx] = 0;
    }

    private static void offerPattern(
            PriorityQueue<FeasiblePattern> maxHeap,
            FeasiblePattern candidate,
            int limit,
            Comparator<FeasiblePattern> qualityOrder
    ) {
        if (maxHeap.size() < limit) {
            maxHeap.offer(candidate);
        } else {
            FeasiblePattern worst = maxHeap.peek();
            if (worst != null && qualityOrder.compare(candidate, worst) < 0) {
                maxHeap.poll();
                maxHeap.offer(candidate);
            }
        }
    }

    /**
     * 在候选有效幅宽集合中寻找能容纳 occupiedWidth 且不落入危险细边丝禁区的最佳幅宽（优先零尾边，其次最小尾边）。
     * 若无任何合法幅宽则返回 -1。
     */
    static int pickBestLegalRollWidth(int occupiedWidth, int[] legalRollWidths, SlittingProblem problem) {
        if (occupiedWidth <= 0) {
            return -1;
        }
        boolean hasForbidden = problem.hasForbiddenNarrowEdge();
        int fMin = hasForbidden ? problem.forbiddenNarrowEdgeMinMm() : -1;
        int fMax = hasForbidden ? problem.forbiddenNarrowEdgeMaxMm() : -1;

        for (int rollW : legalRollWidths) {
            if (rollW < occupiedWidth) {
                continue;
            }
            int tailEdge = rollW - occupiedWidth;
            if (hasForbidden && tailEdge > 0 && tailEdge >= fMin && tailEdge <= fMax) {
                continue;
            }
            return rollW;
        }
        return -1;
    }

    /**
     * 当初始组合搜索因规模截断时，基于 GLOP 线性松弛对偶价做带物理硬约束（maxKnives + kerfMm + 细边禁区）的列生成补充。
     */
    private static void enrichWithColumnGeneration(
            SlittingProblem problem,
            Map<GroupKey, TreeMap<Integer, Integer>> groupDemands,
            List<RollSpec> rollSpecs,
            List<FeasiblePattern> allPatterns,
            Set<String> seenSignatures,
            long deadlineNanos
    ) {
        int maxIters = problem.maxIterations() != null ? Math.min(problem.maxIterations(), MAX_COLGEN_ITERATIONS) : MAX_COLGEN_ITERATIONS;
        int kerf = problem.effectiveKerfMm();
        for (var entry : groupDemands.entrySet()) {
            GroupKey gk = entry.getKey();
            TreeMap<Integer, Integer> demands = entry.getValue();
            int[] widthsDesc = demands.keySet().stream().sorted(Comparator.reverseOrder()).mapToInt(Integer::intValue).toArray();

            for (int iter = 0; iter < maxIters && System.nanoTime() < deadlineNanos; iter++) {
                Map<Integer, Double> duals = solveGroupMasterLpDuals(gk, demands, allPatterns);
                if (duals == null || duals.isEmpty()) {
                    break;
                }
                int added = 0;
                for (RollSpec spec : rollSpecs) {
                    FeasiblePattern priced = priceNewPattern(problem, gk, spec, widthsDesc, duals, kerf);
                    if (priced != null && seenSignatures.add(priced.signature())) {
                        allPatterns.add(priced);
                        added++;
                    }
                }
                if (added == 0) {
                    break;
                }
            }
        }
    }

    private static Map<Integer, Double> solveGroupMasterLpDuals(
            GroupKey gk,
            TreeMap<Integer, Integer> demands,
            List<FeasiblePattern> allPatterns
    ) {
        MPSolver lp = MPSolver.createSolver("GLOP");
        if (lp == null) {
            return null;
        }
        try {
            double totalDemand = demands.values().stream().mapToInt(Integer::intValue).sum();
            MPObjective obj = lp.objective();
            obj.setMinimization();

            Map<Integer, MPConstraint> constraints = new LinkedHashMap<>();
            for (var e : demands.entrySet()) {
                MPConstraint c = lp.makeConstraint(e.getValue(), Double.POSITIVE_INFINITY, "d_" + e.getKey());
                MPVariable slack = lp.makeNumVar(0.0, totalDemand, "u_" + e.getKey());
                c.setCoefficient(slack, 1.0);
                obj.setCoefficient(slack, 1e6);
                constraints.put(e.getKey(), c);
            }

            int idx = 0;
            for (FeasiblePattern fp : allPatterns) {
                if (!fp.groupKey().equals(gk)) continue;
                MPVariable x = lp.makeNumVar(0.0, totalDemand, "x_" + (idx++));
                obj.setCoefficient(x, fp.motherWidthMm());
                for (int i = 0; i < fp.widths().length; i++) {
                    if (fp.counts()[i] > 0) {
                        MPConstraint c = constraints.get(fp.widths()[i]);
                        if (c != null) {
                            c.setCoefficient(x, fp.counts()[i]);
                        }
                    }
                }
            }

            MPSolver.ResultStatus status = lp.solve();
            if (status != MPSolver.ResultStatus.OPTIMAL) {
                return null;
            }
            Map<Integer, Double> duals = new HashMap<>();
            for (var e : constraints.entrySet()) {
                duals.put(e.getKey(), e.getValue().dualValue());
            }
            return duals;
        } finally {
            lp.delete();
        }
    }

    /**
     * 带 maxKnives、kerfMm 与危险细边禁区的有界二维背包定价（容量维度自动按 GCD 压缩）。
     */
    private static FeasiblePattern priceNewPattern(
            SlittingProblem problem,
            GroupKey gk,
            RollSpec spec,
            int[] allWidthsDesc,
            Map<Integer, Double> duals,
            int kerf
    ) {
        int maxRollW = spec.maxLegalRollWidth();
        int[] widths = Arrays.stream(allWidthsDesc)
                .filter(w -> w <= maxRollW && duals.getOrDefault(w, 0.0) > EPS)
                .toArray();
        if (widths.length == 0) {
            return null;
        }
        int minW = widths[widths.length - 1];
        int capK = (maxRollW + kerf) / (minW + kerf);
        int maxK = problem.maxKnives() != null ? Math.min(problem.maxKnives(), capK) : capK;
        if (maxK < 1) {
            return null;
        }

        int capEff = maxRollW + kerf;
        int gcd = capEff;
        int[] effWidths = new int[widths.length];
        for (int i = 0; i < widths.length; i++) {
            effWidths[i] = widths[i] + kerf;
            gcd = gcd(gcd, effWidths[i]);
        }
        int scaledCap = capEff / gcd;
        if ((long) (maxK + 1) * (scaledCap + 1) > MAX_DP_STATES) {
            return null;
        }

        double[][] dp = new double[maxK + 1][scaledCap + 1];
        int[][] choice = new int[maxK + 1][scaledCap + 1];
        for (int k = 0; k <= maxK; k++) {
            Arrays.fill(dp[k], Double.NEGATIVE_INFINITY);
            Arrays.fill(choice[k], -1);
        }
        dp[0][0] = 0.0;

        for (int k = 1; k <= maxK; k++) {
            for (int c = 1; c <= scaledCap; c++) {
                double bestVal = Double.NEGATIVE_INFINITY;
                int bestItem = -1;
                for (int i = 0; i < widths.length; i++) {
                    int sw = effWidths[i] / gcd;
                    if (c >= sw && dp[k - 1][c - sw] > Double.NEGATIVE_INFINITY / 2) {
                        double cand = dp[k - 1][c - sw] + duals.getOrDefault(widths[i], 0.0);
                        if (cand > bestVal + 1e-12) {
                            bestVal = cand;
                            bestItem = i;
                        }
                    }
                }
                dp[k][c] = bestVal;
                choice[k][c] = bestItem;
            }
        }

        double bestValue = spec.motherWidthMm() + 1e-4;
        int bestK = -1;
        int bestC = -1;
        int bestRollW = -1;
        for (int k = 1; k <= maxK; k++) {
            for (int c = 1; c <= scaledCap; c++) {
                if (dp[k][c] <= bestValue) continue;
                int occW = c * gcd - kerf;
                int rollW = pickBestLegalRollWidth(occW, spec.legalRollWidths(), problem);
                if (rollW > 0) {
                    bestValue = dp[k][c];
                    bestK = k;
                    bestC = c;
                    bestRollW = rollW;
                }
            }
        }
        if (bestK < 0) {
            return null;
        }

        int[] counts = new int[widths.length];
        int curK = bestK;
        int curC = bestC;
        int pieceW = 0;
        while (curK > 0) {
            int item = choice[curK][curC];
            if (item < 0) return null;
            counts[item]++;
            pieceW += widths[item];
            curC -= effWidths[item] / gcd;
            curK--;
        }
        int distinct = 0;
        for (int cnt : counts) {
            if (cnt > 0) distinct++;
        }
        if (problem.maxDistinctWidths() != null && distinct > problem.maxDistinctWidths()) {
            return null;
        }
        int occW = pieceW + (bestK - 1) * kerf;
        return new FeasiblePattern(
                gk, spec.specIndex(), spec.motherWidthMm(), spec.usableWidthMm(),
                bestRollW, pieceW, bestK, bestRollW - occW, widths, counts);
    }

    private static int gcd(int a, int b) {
        int x = Math.abs(a);
        int y = Math.abs(b);
        while (y != 0) {
            int t = x % y;
            x = y;
            y = t;
        }
        return x == 0 ? 1 : x;
    }

    private static Map<Integer, Integer> solveUnifiedMip(
            SlittingProblem problem,
            Map<GroupKey, TreeMap<Integer, Integer>> groupDemands,
            List<RollSpec> rollSpecs,
            List<FeasiblePattern> allPatterns,
            long deadlineNanos
    ) {
        MPSolver mip = MPSolver.createSolver("SCIP");
        if (mip == null) {
            mip = MPSolver.createSolver("CBC");
        }
        if (mip == null) {
            throw new IllegalStateException("无法创建 OR-Tools 整数规划求解器（SCIP/CBC）");
        }
        try {
            long remainingMs = Math.max(500L, TimeUnit.NANOSECONDS.toMillis(deadlineNanos - System.nanoTime()));
            mip.setTimeLimit(remainingMs);
            mip.setNumThreads(1);

            MPObjective objective = mip.objective();
            objective.setMinimization();

            // 面积尺度归一化，保证多长度/多宽幅目标数值稳定
            double maxCarArea = 1.0;
            for (FeasiblePattern fp : allPatterns) {
                double area = (double) fp.motherWidthMm() * fp.groupKey().lengthMm();
                if (area > maxCarArea) {
                    maxCarArea = area;
                }
            }
            double underWeight = problem.underPenalty() != null && problem.underPenalty() > 0.0
                    ? Math.max(10_000.0, problem.underPenalty())
                    : 100_000.0;

            Map<GroupKey, Integer> groupMaxReps = new HashMap<>();
            for (var e : groupDemands.entrySet()) {
                int sumD = e.getValue().values().stream().mapToInt(Integer::intValue).sum();
                groupMaxReps.put(e.getKey(), sumD + problem.totalOverCap());
            }

            // 创建花型车次变量
            MPVariable[] xVars = new MPVariable[allPatterns.size()];
            MPConstraint totalProducedConstraint = mip.makeConstraint(0.0, 100_000.0, "max_total_produced");
            Map<Integer, MPConstraint> rollCapConstraints = new HashMap<>();
            for (RollSpec spec : rollSpecs) {
                if (spec.availableRolls() != null) {
                    rollCapConstraints.put(spec.specIndex(),
                            mip.makeConstraint(0.0, spec.availableRolls(), "roll_cap_" + spec.motherWidthMm()));
                }
            }

            for (int i = 0; i < allPatterns.size(); i++) {
                FeasiblePattern fp = allPatterns.get(i);
                int ub = groupMaxReps.getOrDefault(fp.groupKey(), 1);
                RollSpec spec = rollSpecs.get(fp.specIndex());
                if (spec.availableRolls() != null) {
                    ub = Math.min(ub, spec.availableRolls());
                }
                MPVariable x = mip.makeIntVar(0.0, ub, "x_" + i);
                xVars[i] = x;

                double normalizedMotherArea = ((double) fp.motherWidthMm() * fp.groupKey().lengthMm()) / maxCarArea;
                // 主目标最小化母卷总耗用面积，极小次级惩罚抑制不必要碎车次与尾边
                objective.setCoefficient(x, normalizedMotherArea + 1e-4 + (fp.tailEdgeMm() / (double) Math.max(1, fp.motherWidthMm())) * 1e-5);
                totalProducedConstraint.setCoefficient(x, fp.totalStrips());

                MPConstraint rollCap = rollCapConstraints.get(fp.specIndex());
                if (rollCap != null) {
                    rollCap.setCoefficient(x, 1.0);
                }
            }

            // 创建逐组逐宽幅需求平衡约束与全局超产上限约束
            MPConstraint globalOverCap = mip.makeConstraint(0.0, problem.totalOverCap(), "global_over_cap");
            Map<String, MPConstraint> demandConstraints = new LinkedHashMap<>();

            for (var entry : groupDemands.entrySet()) {
                GroupKey gk = entry.getKey();
                for (var wd : entry.getValue().entrySet()) {
                    int width = wd.getKey();
                    int demand = wd.getValue();
                    String key = gk.lengthMm() + "|" + gk.surfaceTreatment() + "|" + width;
                    MPConstraint c = mip.makeConstraint(demand, demand, "dem_" + key);
                    MPVariable under = mip.makeIntVar(0.0, demand, "under_" + key);
                    MPVariable over = mip.makeIntVar(0.0, problem.totalOverCap(), "over_" + key);
                    c.setCoefficient(under, 1.0);
                    c.setCoefficient(over, -1.0);
                    objective.setCoefficient(under, underWeight);
                    objective.setCoefficient(over, 1e-3);
                    globalOverCap.setCoefficient(over, 1.0);
                    demandConstraints.put(key, c);
                }
            }

            for (int i = 0; i < allPatterns.size(); i++) {
                FeasiblePattern fp = allPatterns.get(i);
                for (int j = 0; j < fp.widths().length; j++) {
                    if (fp.counts()[j] > 0) {
                        String key = fp.groupKey().lengthMm() + "|" + fp.groupKey().surfaceTreatment() + "|" + fp.widths()[j];
                        MPConstraint c = demandConstraints.get(key);
                        if (c != null) {
                            c.setCoefficient(xVars[i], fp.counts()[j]);
                        }
                    }
                }
            }

            MPSolver.ResultStatus status = mip.solve();
            if (status != MPSolver.ResultStatus.OPTIMAL && status != MPSolver.ResultStatus.FEASIBLE) {
                return Map.of();
            }

            Map<Integer, Integer> selected = new LinkedHashMap<>();
            for (int i = 0; i < xVars.length; i++) {
                int reps = (int) Math.round(xVars[i].solutionValue());
                if (reps > 0) {
                    selected.put(i, reps);
                }
            }
            return selected;
        } finally {
            mip.delete();
        }
    }

    private static SlittingResult buildVerifiedResult(
            SlittingProblem problem,
            TreeMap<GroupKey, List<SlittingProblem.Order>> groups,
            List<FeasiblePattern> allPatterns,
            Map<Integer, Integer> selectedRepetitions,
            boolean multiPool
    ) {
        // 为每个 (GroupKey, width) 跟踪待满足的订单余量
        Map<String, List<SlittingProblem.Order>> ordersByGroupWidth = new LinkedHashMap<>();
        Map<String, Integer> remainingByOrderId = new LinkedHashMap<>();
        for (var e : groups.entrySet()) {
            GroupKey gk = e.getKey();
            for (SlittingProblem.Order o : e.getValue()) {
                String key = gk.lengthMm() + "|" + gk.surfaceTreatment() + "|" + o.widthMm();
                ordersByGroupWidth.computeIfAbsent(key, k -> new ArrayList<>()).add(o);
                remainingByOrderId.put(o.id(), o.quantity());
            }
        }

        List<SlittingResult.Pattern> rawPatterns = new ArrayList<>();
        Map<String, Integer> producedByOrderId = new HashMap<>();
        long pieceArea = 0;
        long motherArea = 0;
        long usableArea = 0;

        for (var entry : selectedRepetitions.entrySet()) {
            FeasiblePattern fp = allPatterns.get(entry.getKey());
            int reps = entry.getValue();

            // 工位按宽幅升序确定性输出
            List<SlittingResult.Station> stations = new ArrayList<>();
            Map<String, Integer> allocations = new LinkedHashMap<>();
            for (int i = fp.widths().length - 1; i >= 0; i--) {
                int cnt = fp.counts()[i];
                if (cnt <= 0) continue;
                int w = fp.widths()[i];
                stations.add(new SlittingResult.Station(w, cnt));

                int totalForWidth = Math.multiplyExact(cnt, reps);
                String key = fp.groupKey().lengthMm() + "|" + fp.groupKey().surfaceTreatment() + "|" + w;
                List<SlittingProblem.Order> bucket = ordersByGroupWidth.get(key);
                int leftToAssign = totalForWidth;
                for (SlittingProblem.Order o : bucket) {
                    if (leftToAssign <= 0) break;
                    int rem = remainingByOrderId.getOrDefault(o.id(), 0);
                    if (rem > 0) {
                        int give = Math.min(rem, leftToAssign);
                        allocations.merge(o.id(), give, Math::addExact);
                        producedByOrderId.merge(o.id(), give, Math::addExact);
                        remainingByOrderId.put(o.id(), rem - give);
                        leftToAssign -= give;
                    }
                }
                if (leftToAssign > 0) {
                    // 合法超产部分确定性归属同组同宽首条订单
                    SlittingProblem.Order target = bucket.get(0);
                    allocations.merge(target.id(), leftToAssign, Math::addExact);
                    producedByOrderId.merge(target.id(), leftToAssign, Math::addExact);
                }
            }

            List<SlittingResult.Allocation> allocList = allocations.entrySet().stream()
                    .map(e -> new SlittingResult.Allocation(e.getKey(), e.getValue()))
                    .toList();

            rawPatterns.add(new SlittingResult.Pattern(
                    "PAT-" + (rawPatterns.size() + 1),
                    fp.rollWidthMm(),
                    fp.pieceWidthMm(),
                    fp.groupKey().lengthMm(),
                    fp.groupKey().surfaceTreatment(),
                    reps,
                    stations,
                    allocList,
                    multiPool ? fp.motherWidthMm() : null
            ));

            long repeatedLength = Math.multiplyExact(fp.groupKey().lengthMm(), reps);
            pieceArea = Math.addExact(pieceArea, Math.multiplyExact((long) fp.pieceWidthMm(), repeatedLength));
            motherArea = Math.addExact(motherArea, Math.multiplyExact((long) fp.motherWidthMm(), repeatedLength));
            usableArea = Math.addExact(usableArea, Math.multiplyExact((long) fp.usableWidthMm(), repeatedLength));
        }

        // 执行刀架换刀 TSP 排序并按最终顺序重编 PAT-1..PAT-N
        var knifeOptimized = KnifeSetupSequenceOptimizer.optimize(rawPatterns, problem.leftTrimMm(), problem.effectiveKerfMm());
        List<SlittingResult.Pattern> orderedPatterns = renumberPatterns(knifeOptimized.orderedPatterns());

        List<SlittingResult.Fulfillment> fulfillment = problem.orders().stream().map(o -> {
            int n = producedByOrderId.getOrDefault(o.id(), 0);
            return new SlittingResult.Fulfillment(
                    o.id(), o.quantity(), n, Math.max(0, o.quantity() - n), Math.max(0, n - o.quantity()));
        }).toList();
        int totalOver = fulfillment.stream().mapToInt(SlittingResult.Fulfillment::overproduced).sum();

        SlittingResult result = new SlittingResult(
                "1", "mm", "ortools-1d", "constrained-mip-ortools-9.10",
                orderedPatterns.isEmpty() ? "NO_SOLUTION_FOUND" : "FEASIBLE",
                false, orderedPatterns, fulfillment, pieceArea, motherArea, usableArea, totalOver,
                knifeOptimized.estimatedKnifeChanges(), knifeOptimized.knifeChangesSaved()
        );
        SlittingValidation.validateResult(problem, result);
        return result;
    }

    private static SlittingResult buildEmptyResult(SlittingProblem problem) {
        List<SlittingResult.Fulfillment> fulfillment = problem.orders().stream()
                .map(o -> new SlittingResult.Fulfillment(o.id(), o.quantity(), 0, o.quantity(), 0))
                .toList();
        SlittingResult result = new SlittingResult(
                "1", "mm", "ortools-1d", "constrained-mip-ortools-9.10",
                "NO_SOLUTION_FOUND", false, List.of(), fulfillment, 0L, 0L, 0L, 0, 0, 0
        );
        SlittingValidation.validateResult(problem, result);
        return result;
    }

    static List<SlittingResult.Pattern> renumberPatterns(List<SlittingResult.Pattern> ordered) {
        List<SlittingResult.Pattern> out = new ArrayList<>(ordered.size());
        for (int i = 0; i < ordered.size(); i++) {
            SlittingResult.Pattern pat = ordered.get(i);
            out.add(new SlittingResult.Pattern(
                    "PAT-" + (i + 1),
                    pat.rollWidthMm(),
                    pat.patternWidthMm(),
                    pat.lengthMm(),
                    pat.surfaceTreatment(),
                    pat.repetitions(),
                    pat.stations(),
                    pat.allocations(),
                    pat.motherWidthMm()
            ));
        }
        return out;
    }
}
