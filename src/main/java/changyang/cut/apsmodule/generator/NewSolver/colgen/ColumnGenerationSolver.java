package changyang.cut.apsmodule.generator.NewSolver.colgen;

import com.google.ortools.linearsolver.MPConstraint;
import com.google.ortools.linearsolver.MPObjective;
import com.google.ortools.linearsolver.MPSolver;
import com.google.ortools.linearsolver.MPVariable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverParameters;
import changyang.cut.apsmodule.generator.NewSolver.model.PatternCandidate;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

/**
 * Column-generation LP stage aligned with the legacy variable-width solver.
 */
public class ColumnGenerationSolver {

    private static final Logger log = LoggerFactory.getLogger(ColumnGenerationSolver.class);

    private static final double EPSILON = 1e-6;
    private static final double OVER_PENALTY_BASE = 0.1;
    private static final double EPS_WASTE = 0.001;
    private static final int NO_IMPROVEMENT_LIMIT = 10;
    private static final int PRICING_CANDIDATE_LIMIT = 12;
    private static final int SOFT_LIMIT_BUFFER = 200;
    /** 精确 DP 回溯表最大状态格数（short[] 下约 16MB 内存上限），防止大宽幅/互质输入触发 OOM。 */
    private static final long MAX_EXACT_DP_STATES = 8_000_000L;
    private static final long DEFAULT_TIMEOUT_MS = 120_000L;

    private final SolverParameters params;

    public ColumnGenerationSolver(SolverParameters params) {
        this.params = params;
    }

    public List<PatternCandidate> solve(List<PatternCandidate> initialPatterns,
            Map<Integer, Integer> demands,
            Set<Integer> allowOverSet) {
        log.info("\n--- Stage A: 列生成LP ---");
        long startTime = System.currentTimeMillis();
        long timeoutMs = params.getTimeoutMs() > 0 ? params.getTimeoutMs() : DEFAULT_TIMEOUT_MS;
        long deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);

        List<PatternCandidate> patterns = new ArrayList<>(initialPatterns);
        Set<String> seen = new HashSet<>();
        for (PatternCandidate pc : patterns) {
            seen.add(pc.signature());
        }
        log.info("初始模式数 {}", patterns.size());

        int iterationCount = 0;
        int noImprovementCount = 0;
        int maxIterations = params.getMaxIterations();
        int configuredMaxPatterns = params.getMaxPatterns();
        int initialPatternCount = patterns.size();
        int softLimit = determineSoftPatternLimit(initialPatternCount, configuredMaxPatterns);

        if (initialPatternCount > configuredMaxPatterns) {
            log.info("Initial pool {} exceeds configured maxPatterns={}, using soft limit {}",
                    initialPatternCount, configuredMaxPatterns, softLimit);
        }

        try (IncrementalMasterLP masterLP = IncrementalMasterLP.create(demands, allowOverSet, params)) {
            if (masterLP == null) {
                log.info("  主问题LP求解器(GLOP)不可用");
            } else {
                for (PatternCandidate initial : patterns) {
                    masterLP.addPattern(initial);
                }

                while (iterationCount < maxIterations && patterns.size() < softLimit) {
                    long remainingNanos = deadlineNanos - System.nanoTime();
                    if (Thread.currentThread().isInterrupted() || remainingNanos <= 0L) {
                        log.info("  列生成达到时限或收到中断，提前停止于第 {} 轮，当前模式数 {}",
                                iterationCount, patterns.size());
                        break;
                    }
                    iterationCount++;

                    long lpLimitMs = Math.max(50L, TimeUnit.NANOSECONDS.toMillis(remainingNanos));
                    MasterLPResult masterResult = masterLP.solve(lpLimitMs);
                    if (!masterResult.feasible) {
                        log.info("  主问题LP不可行或求解超时");
                        break;
                    }

                    if (Thread.currentThread().isInterrupted() || System.nanoTime() >= deadlineNanos) {
                        log.info("  列生成定价前达到时限，停止于第 {} 轮", iterationCount);
                        break;
                    }

                    List<PatternCandidate> newPatterns = solvePricingSubproblem(
                            masterResult.dualPrices, demands.keySet(), demands, allowOverSet, deadlineNanos);

                    int added = 0;
                    for (PatternCandidate np : newPatterns) {
                        if (seen.add(np.signature())) {
                            patterns.add(np);
                            masterLP.addPattern(np);
                            added++;
                            if (iterationCount <= 5 || iterationCount % 20 == 0) {
                                double rc = calculateReducedCost(np, masterResult.dualPrices);
                                log.info("  Iteration {}: add {} rc={}",
                                        iterationCount, np, String.format("%.4f", rc));
                            }
                        }
                    }

                    if (added > 0) {
                        noImprovementCount = 0;
                        if (patterns.size() >= softLimit) {
                            log.info("  Reached working pattern limit {}, stop", softLimit);
                            break;
                        }
                    } else {
                        // 主问题LP未增加任何新列，对偶价与确定性定价结果均已收敛，无需重复求解。
                        noImprovementCount++;
                        log.info("  Iteration {}: no new columns added, LP converged, stop", iterationCount);
                        break;
                    }
                }
            }
        }

        log.info("列生成完成 {} 次迭代 {} 个模式", iterationCount, patterns.size());
        log.info("列生成耗时: {}ms", System.currentTimeMillis() - startTime);
        log.info("Column generation summary: iterations={}, addedColumns={}, softLimit={}",
                iterationCount, patterns.size() - initialPatternCount, softLimit);

        debugCoverageAndGcd(patterns, demands, allowOverSet);
        int repaired = repairPatterns(patterns, seen, demands, allowOverSet);
        if (repaired > 0) {
            log.info("修复了 {} 个模式，模式池总数: {}", repaired, patterns.size());
        }

        return patterns;
    }

    static int determineSoftPatternLimit(int initialPatternCount, int configuredMaxPatterns) {
        int buffer = Math.max(100, Math.min(SOFT_LIMIT_BUFFER, configuredMaxPatterns / 4));
        return Math.max(configuredMaxPatterns, initialPatternCount + buffer);
    }

    /**
     * 复用同一个 GLOP MPSolver 实例的增量列生成主问题：
     * 仅构建一次基础约束与欠/超产变量，每轮定价只追加新列变量及约束/目标系数，
     * 借助 GLOP 单纯形热启动避免每轮从零重建 LP。
     */
    private static final class IncrementalMasterLP implements AutoCloseable {
        private final MPSolver solver;
        private final MPObjective objective;
        private final Map<Integer, MPConstraint> demandConstraints;
        private final int xUpperBound;
        private final int totalWidth;
        private int columnCount;

        private IncrementalMasterLP(MPSolver solver,
                MPObjective objective,
                Map<Integer, MPConstraint> demandConstraints,
                int xUpperBound,
                int totalWidth) {
            this.solver = solver;
            this.objective = objective;
            this.demandConstraints = demandConstraints;
            this.xUpperBound = xUpperBound;
            this.totalWidth = totalWidth;
        }

        static IncrementalMasterLP create(Map<Integer, Integer> demands,
                Set<Integer> allowOverSet,
                SolverParameters params) {
            MPSolver solver = MPSolver.createSolver("GLOP");
            if (solver == null) {
                return null;
            }
            try {
                int totalDemand = demands.values().stream().mapToInt(Integer::intValue).sum();
                int maxDemand = demands.values().stream().mapToInt(Integer::intValue).max().orElse(1);
                int totalOverCap = params.getTotalOverCap();

                Map<Integer, MPVariable> underVars = new HashMap<>();
                for (int width : demands.keySet()) {
                    underVars.put(width, solver.makeNumVar(0, totalDemand, "under_" + width));
                }

                Map<Integer, MPVariable> overVars = new HashMap<>();
                for (int width : demands.keySet()) {
                    double overUpperBound = allowOverSet.contains(width) ? totalOverCap : 0;
                    overVars.put(width, solver.makeNumVar(0, overUpperBound, "over_" + width));
                }

                Map<Integer, MPConstraint> demandConstraints = new HashMap<>();
                for (Map.Entry<Integer, Integer> demandEntry : demands.entrySet()) {
                    int width = demandEntry.getKey();
                    int demand = demandEntry.getValue();
                    MPConstraint constraint = solver.makeConstraint(demand, demand, "demand_" + width);
                    constraint.setCoefficient(underVars.get(width), 1);
                    constraint.setCoefficient(overVars.get(width), -1);
                    demandConstraints.put(width, constraint);
                }

                MPConstraint overCapConstraint = solver.makeConstraint(0, totalOverCap, "overCap");
                for (MPVariable overVar : overVars.values()) {
                    overCapConstraint.setCoefficient(overVar, 1);
                }

                MPObjective objective = solver.objective();
                for (MPVariable underVar : underVars.values()) {
                    objective.setCoefficient(underVar, params.getUnderPenalty());
                }
                for (Map.Entry<Integer, Integer> demandEntry : demands.entrySet()) {
                    int width = demandEntry.getKey();
                    int demand = demandEntry.getValue();
                    double ratio = (double) maxDemand / Math.max(demand, 1);
                    double penalty = OVER_PENALTY_BASE * ratio * ratio;
                    if (!allowOverSet.contains(width)) {
                        penalty *= 100;
                    }
                    objective.setCoefficient(overVars.get(width), penalty);
                }
                objective.setMinimization();

                return new IncrementalMasterLP(
                        solver, objective, demandConstraints, totalDemand + totalOverCap, params.getTotalWidth());
            } catch (Exception e) {
                log.error("Failed to initialize incremental column-generation LP", e);
                solver.delete();
                return null;
            }
        }

        void addPattern(PatternCandidate candidate) {
            MPVariable x = solver.makeNumVar(0, xUpperBound, "x_" + (columnCount++));
            for (Map.Entry<Integer, Integer> cut : candidate.getPattern().entrySet()) {
                MPConstraint constraint = demandConstraints.get(cut.getKey());
                if (constraint != null) {
                    constraint.setCoefficient(x, cut.getValue());
                }
            }
            objective.setCoefficient(x, candidate.getCost(totalWidth));
        }

        MasterLPResult solve(long timeLimitMs) {
            try {
                solver.setTimeLimit(Math.max(50L, timeLimitMs));
                MPSolver.ResultStatus status = solver.solve();
                if (status != MPSolver.ResultStatus.OPTIMAL && status != MPSolver.ResultStatus.FEASIBLE) {
                    return new MasterLPResult(0, new HashMap<>(), false);
                }
                Map<Integer, Double> dualPrices = new HashMap<>(demandConstraints.size() * 2);
                for (Map.Entry<Integer, MPConstraint> entry : demandConstraints.entrySet()) {
                    dualPrices.put(entry.getKey(), entry.getValue().dualValue());
                }
                return new MasterLPResult(objective.value(), dualPrices, true);
            } catch (Exception e) {
                log.error("Column-generation LP solve failed", e);
                return new MasterLPResult(0, new HashMap<>(), false);
            }
        }

        @Override
        public void close() {
            solver.delete();
        }
    }

    private record PricingState(int scaledWidth, int distinct, int rollWidth, double reducedCost) {}

    /**
     * 对 maxRollWidth 仅执行单次 DP（通过所有有效订单宽度与步长的 GCD 压缩 capacity 维度），
     * 并从同一末层直接扫描 t ∈ [minRollWidth, maxRollWidth] 按合法卷宽分桶择优，彻底消除逐卷宽重复 DP 与大宽幅 OOM。
     */
    private List<PatternCandidate> solvePricingSubproblem(Map<Integer, Double> dualPrices,
            Set<Integer> allWidths,
            Map<Integer, Integer> demands,
            Set<Integer> allowOverSet,
            long deadlineNanos) {
        int minRollWidth = params.getMinRollWidth();
        int maxRollWidth = params.getMaxRollWidth();
        int stepSize = Math.max(1, params.getStepSize());
        if (allWidths == null || allWidths.isEmpty() || maxRollWidth <= 0 || minRollWidth > maxRollWidth) {
            return List.of();
        }

        List<Integer> widths = new ArrayList<>();
        for (Integer w : allWidths) {
            if (w != null && w > 0 && w <= maxRollWidth) {
                widths.add(w);
            }
        }
        if (widths.isEmpty()) {
            return List.of();
        }
        Collections.sort(widths);

        int scale = computeWidthScale(widths);
        int scaledCapacity = maxRollWidth / scale;
        int scaledMinWidth = (minRollWidth + scale - 1) / scale;
        if (scaledMinWidth > scaledCapacity || scaledCapacity <= 0) {
            return List.of();
        }

        int maxDistinctWidths = Math.max(1, Math.min(params.getMaxDistinctWidths(), widths.size()));
        long layerStates = (long) (scaledCapacity + 1) * (maxDistinctWidths + 1);
        long totalStates = layerStates * widths.size();
        if (layerStates > MAX_EXACT_DP_STATES / 2) {
            log.warn("列生成定价单层状态数过大 (scaledCapacity={}, maxDistinct={}, scale={})，改用有界贪心定价防止 OOM",
                    scaledCapacity, maxDistinctWidths, scale);
            return solveBoundedGreedyPricing(widths, dualPrices, demands, allowOverSet,
                    minRollWidth, maxRollWidth, stepSize, maxDistinctWidths, deadlineNanos);
        }
        if (totalStates > MAX_EXACT_DP_STATES) {
            int maxWidthCount = Math.max(1, (int) (MAX_EXACT_DP_STATES / layerStates));
            widths = selectTopWidthsForBoundedDp(widths, dualPrices, maxWidthCount);
            maxDistinctWidths = Math.max(1, Math.min(params.getMaxDistinctWidths(), widths.size()));
            log.warn("列生成定价状态空间超限 (scale={}, scaledCapacity={})，裁剪候选宽度至 {} 种以守卫内存上限",
                    scale, scaledCapacity, widths.size());
        }

        return solveSinglePassCompressedDp(widths, scale, scaledMinWidth, scaledCapacity,
                minRollWidth, maxRollWidth, stepSize, maxDistinctWidths,
                dualPrices, demands, allowOverSet, deadlineNanos);
    }

    private List<PatternCandidate> solveSinglePassCompressedDp(
            List<Integer> widths,
            int scale,
            int scaledMinWidth,
            int scaledCapacity,
            int minRollWidth,
            int maxRollWidth,
            int stepSize,
            int maxDistinctWidths,
            Map<Integer, Double> dualPrices,
            Map<Integer, Integer> demands,
            Set<Integer> allowOverSet,
            long deadlineNanos) {
        int widthCount = widths.size();
        int strideD = maxDistinctWidths + 1;
        int layerSize = (scaledCapacity + 1) * strideD;

        int[] scaledWidths = new int[widthCount];
        double[] itemValues = new double[widthCount];
        int[] maxCopiesByWidth = new int[widthCount];
        int maxCopyOverall = 0;
        for (int i = 0; i < widthCount; i++) {
            int width = widths.get(i);
            scaledWidths[i] = width / scale;
            itemValues[i] = Math.max(0.0, dualPrices.getOrDefault(width, 0.0));
            int allowedProduction = demands.getOrDefault(width, 0)
                    + (allowOverSet.contains(width) ? params.getTotalOverCap() : 0);
            int maxCopies = Math.min(scaledCapacity / scaledWidths[i], Math.max(0, allowedProduction));
            maxCopiesByWidth[i] = maxCopies;
            if (maxCopies > maxCopyOverall) {
                maxCopyOverall = maxCopies;
            }
        }

        double[] previous = new double[layerSize];
        double[] next = new double[layerSize];
        Arrays.fill(previous, Double.NEGATIVE_INFINITY);
        previous[0] = 0.0;

        boolean useShort = maxCopyOverall <= Short.MAX_VALUE;
        short[] chosenShort = useShort ? new short[widthCount * layerSize] : null;
        int[] chosenInt = useShort ? null : new int[widthCount * layerSize];

        for (int wi = 0; wi < widthCount; wi++) {
            if (Thread.currentThread().isInterrupted() || System.nanoTime() >= deadlineNanos) {
                return List.of();
            }
            System.arraycopy(previous, 0, next, 0, layerSize);
            int scaledW = scaledWidths[wi];
            int maxCopies = maxCopiesByWidth[wi];
            double itemValue = itemValues[wi];
            if (maxCopies > 0) {
                int layerBase = wi * layerSize;
                int maxStartWidth = scaledCapacity - scaledW;
                for (int used = 0; used <= maxStartWidth; used++) {
                    int rowOffset = used * strideD;
                    int copyLimit = Math.min(maxCopies, (scaledCapacity - used) / scaledW);
                    for (int distinct = 0; distinct < maxDistinctWidths; distinct++) {
                        double baseValue = previous[rowOffset + distinct];
                        if (baseValue == Double.NEGATIVE_INFINITY) {
                            continue;
                        }
                        int nextDistinct = distinct + 1;
                        for (int count = 1; count <= copyLimit; count++) {
                            int nextState = (used + scaledW * count) * strideD + nextDistinct;
                            double newValue = baseValue + itemValue * count;
                            if (newValue > next[nextState] + EPSILON) {
                                next[nextState] = newValue;
                                if (useShort) {
                                    chosenShort[layerBase + nextState] = (short) count;
                                } else {
                                    chosenInt[layerBase + nextState] = count;
                                }
                            }
                        }
                    }
                }
            }
            double[] swap = previous;
            previous = next;
            next = swap;
        }

        // 从同一末层直接扫描 t ∈ [minRollWidth, maxRollWidth]，按目标卷宽桶保留最优负检验数状态。
        Map<Integer, PricingState> bestByRollWidth = new HashMap<>();
        int totalWidth = params.getTotalWidth();
        for (int scaledT = scaledMinWidth; scaledT <= scaledCapacity; scaledT++) {
            int actualT = scaledT * scale;
            int rollWidth = alignRollWidth(actualT, minRollWidth, maxRollWidth, stepSize);
            if (rollWidth < actualT || rollWidth > maxRollWidth || (rollWidth - minRollWidth) % stepSize != 0) {
                continue;
            }
            double patternCost = 1.0 + EPS_WASTE * (totalWidth - actualT);
            int rowOffset = scaledT * strideD;
            for (int distinct = 1; distinct <= maxDistinctWidths; distinct++) {
                double value = previous[rowOffset + distinct];
                if (value <= EPSILON) {
                    continue;
                }
                double rc = patternCost - value;
                if (rc >= -EPSILON) {
                    continue;
                }
                PricingState incumbent = bestByRollWidth.get(rollWidth);
                if (incumbent == null
                        || rc < incumbent.reducedCost() - EPSILON
                        || (Math.abs(rc - incumbent.reducedCost()) <= EPSILON && scaledT > incumbent.scaledWidth())) {
                    bestByRollWidth.put(rollWidth, new PricingState(scaledT, distinct, rollWidth, rc));
                }
            }
        }

        if (bestByRollWidth.isEmpty()) {
            return List.of();
        }

        List<PricingState> ranked = new ArrayList<>(bestByRollWidth.values());
        ranked.sort(Comparator.comparingDouble(PricingState::reducedCost)
                .thenComparing(Comparator.comparingInt(PricingState::scaledWidth).reversed())
                .thenComparingInt(PricingState::rollWidth)
                .thenComparingInt(PricingState::distinct));

        List<PatternCandidate> results = new ArrayList<>(Math.min(PRICING_CANDIDATE_LIMIT, ranked.size()));
        Set<String> emittedSignatures = new HashSet<>();
        for (PricingState state : ranked) {
            if (results.size() >= PRICING_CANDIDATE_LIMIT) {
                break;
            }
            PatternCandidate candidate = reconstructPattern(
                    widths, scaledWidths, state, strideD, layerSize, chosenShort, chosenInt, minRollWidth, maxRollWidth);
            if (candidate != null && emittedSignatures.add(candidate.signature())) {
                if (calculateReducedCost(candidate, dualPrices) < -EPSILON) {
                    results.add(candidate);
                }
            }
        }
        return results;
    }

    private PatternCandidate reconstructPattern(
            List<Integer> widths,
            int[] scaledWidths,
            PricingState state,
            int strideD,
            int layerSize,
            short[] chosenShort,
            int[] chosenInt,
            int minRollWidth,
            int maxRollWidth) {
        Map<Integer, Integer> pattern = new LinkedHashMap<>();
        int remainingScaled = state.scaledWidth();
        int remainingDistinct = state.distinct();
        for (int wi = widths.size() - 1; wi >= 0 && remainingDistinct > 0; wi--) {
            int offset = wi * layerSize + remainingScaled * strideD + remainingDistinct;
            int count = chosenShort != null ? chosenShort[offset] : chosenInt[offset];
            if (count <= 0) {
                continue;
            }
            pattern.put(widths.get(wi), count);
            remainingScaled -= scaledWidths[wi] * count;
            remainingDistinct--;
        }
        if (pattern.isEmpty() || remainingScaled != 0 || remainingDistinct != 0) {
            return null;
        }
        int patternWidth = 0;
        for (Map.Entry<Integer, Integer> entry : pattern.entrySet()) {
            patternWidth += entry.getKey() * entry.getValue();
        }
        if (patternWidth < minRollWidth || patternWidth > state.rollWidth() || state.rollWidth() > maxRollWidth) {
            return null;
        }
        return new PatternCandidate(pattern, state.rollWidth());
    }

    private List<Integer> selectTopWidthsForBoundedDp(List<Integer> widths, Map<Integer, Double> dualPrices, int limit) {
        if (widths.size() <= limit) {
            return widths;
        }
        List<Integer> byDensity = new ArrayList<>(widths);
        byDensity.sort((a, b) -> {
            double da = Math.max(0.0, dualPrices.getOrDefault(a, 0.0)) / a;
            double db = Math.max(0.0, dualPrices.getOrDefault(b, 0.0)) / b;
            int cmp = Double.compare(db, da);
            return cmp != 0 ? cmp : Integer.compare(a, b);
        });
        List<Integer> byDual = new ArrayList<>(widths);
        byDual.sort((a, b) -> {
            int cmp = Double.compare(
                    Math.max(0.0, dualPrices.getOrDefault(b, 0.0)),
                    Math.max(0.0, dualPrices.getOrDefault(a, 0.0)));
            return cmp != 0 ? cmp : Integer.compare(a, b);
        });
        Set<Integer> picked = new HashSet<>(limit * 2);
        int half = Math.max(1, limit / 2);
        for (int i = 0; i < byDensity.size() && picked.size() < half; i++) {
            picked.add(byDensity.get(i));
        }
        for (int i = 0; i < byDual.size() && picked.size() < limit - 2; i++) {
            picked.add(byDual.get(i));
        }
        for (int w : widths) {
            if (picked.size() >= limit) break;
            picked.add(w);
        }
        List<Integer> sorted = new ArrayList<>(picked);
        Collections.sort(sorted);
        return sorted;
    }

    private List<PatternCandidate> solveBoundedGreedyPricing(
            List<Integer> widths,
            Map<Integer, Double> dualPrices,
            Map<Integer, Integer> demands,
            Set<Integer> allowOverSet,
            int minRollWidth,
            int maxRollWidth,
            int stepSize,
            int maxDistinctWidths,
            long deadlineNanos) {
        List<Integer> ordered = new ArrayList<>(widths);
        ordered.sort((a, b) -> {
            double da = Math.max(0.0, dualPrices.getOrDefault(a, 0.0)) / a;
            double db = Math.max(0.0, dualPrices.getOrDefault(b, 0.0)) / b;
            int cmp = Double.compare(db, da);
            return cmp != 0 ? cmp : Integer.compare(b, a);
        });

        List<PatternCandidate> candidates = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        int seedLimit = Math.min(ordered.size(), 64);
        for (int start = 0; start < seedLimit; start++) {
            if (Thread.currentThread().isInterrupted() || System.nanoTime() >= deadlineNanos) {
                break;
            }
            Map<Integer, Integer> pattern = new LinkedHashMap<>();
            int remaining = maxRollWidth;
            for (int offset = 0; offset < ordered.size() && pattern.size() < maxDistinctWidths; offset++) {
                int width = ordered.get((start + offset) % ordered.size());
                if (width > remaining) continue;
                int allowed = demands.getOrDefault(width, 0)
                        + (allowOverSet.contains(width) ? params.getTotalOverCap() : 0);
                int copies = Math.min(remaining / width, Math.max(0, allowed));
                if (copies <= 0) continue;
                pattern.put(width, copies);
                remaining -= width * copies;
            }
            int usedWidth = maxRollWidth - remaining;
            if (usedWidth < minRollWidth) continue;
            int rollWidth = alignRollWidth(usedWidth, minRollWidth, maxRollWidth, stepSize);
            if (rollWidth < usedWidth || rollWidth > maxRollWidth || (rollWidth - minRollWidth) % stepSize != 0) {
                continue;
            }
            PatternCandidate candidate = new PatternCandidate(pattern, rollWidth);
            if (calculateReducedCost(candidate, dualPrices) < -EPSILON && seen.add(candidate.signature())) {
                candidates.add(candidate);
            }
        }
        candidates.sort(Comparator.comparingDouble((PatternCandidate c) -> calculateReducedCost(c, dualPrices))
                .thenComparing(PatternCandidate::signature));
        if (candidates.size() > PRICING_CANDIDATE_LIMIT) {
            return new ArrayList<>(candidates.subList(0, PRICING_CANDIDATE_LIMIT));
        }
        return candidates;
    }

    public static int computeWidthScale(List<Integer> widths) {
        int scale = 0;
        for (int width : widths) {
            if (width > 0) {
                scale = scale == 0 ? width : gcdStatic(scale, width);
                if (scale == 1) {
                    return 1;
                }
            }
        }
        return Math.max(1, scale);
    }

    public static int alignRollWidth(int patternWidth, int minRollWidth, int maxRollWidth, int stepSize) {
        if (patternWidth <= minRollWidth) {
            return minRollWidth;
        }
        int step = Math.max(1, stepSize);
        int offset = patternWidth - minRollWidth;
        int steps = (offset + step - 1) / step;
        int aligned = minRollWidth + steps * step;
        return Math.min(aligned, maxRollWidth);
    }

    private static int gcdStatic(int a, int b) {
        while (b != 0) {
            int next = b;
            b = a % b;
            a = next;
        }
        return a;
    }

    private double calculateReducedCost(PatternCandidate candidate, Map<Integer, Double> dualPrices) {
        double value = 0;
        for (Map.Entry<Integer, Integer> entry : candidate.getPattern().entrySet()) {
            double dual = Math.max(0, dualPrices.getOrDefault(entry.getKey(), 0.0));
            value += dual * entry.getValue();
        }
        return candidate.getCost(params.getTotalWidth()) - value;
    }

    private int ceilToStep(int value, int step) {
        return ((value + step - 1) / step) * step;
    }

    private void debugCoverageAndGcd(List<PatternCandidate> patterns,
            Map<Integer, Integer> demands,
            Set<Integer> allowOverSet) {
        log.info("\n--- GCD 诊断 ---");
        int totalOverCap = params.getTotalOverCap();

        for (int width : demands.keySet()) {
            List<Integer> coefficients = new ArrayList<>();
            for (PatternCandidate candidate : patterns) {
                int coefficient = candidate.getPattern().getOrDefault(width, 0);
                if (coefficient > 0) {
                    coefficients.add(coefficient);
                }
            }

            if (coefficients.isEmpty()) {
                log.info("  Width {}mm is not covered by any pattern", width);
                continue;
            }

            int divisor = coefficients.get(0);
            for (int coefficient : coefficients) {
                divisor = gcd(divisor, coefficient);
            }

            int demand = demands.get(width);
            int capForWidth = allowOverSet.contains(width) ? totalOverCap : 0;

            boolean reachable = false;
            for (int extra = 0; extra <= capForWidth; extra++) {
                if ((demand + extra) % divisor == 0) {
                    reachable = true;
                    break;
                }
            }

            if (!reachable) {
                log.info("  Width {}mm has GCD block: gcd={}, demand={}, cap={}",
                        width, divisor, demand, capForWidth);
            }
        }
    }

    private int repairPatterns(List<PatternCandidate> patterns,
            Set<String> seen,
            Map<Integer, Integer> demands,
            Set<Integer> allowOverSet) {
        int repaired = 0;
        List<Integer> widths = new ArrayList<>(demands.keySet());
        widths.sort((a, b) -> Integer.compare(demands.get(b), demands.get(a)));

        int minRollWidth = params.getMinRollWidth();
        int maxRollWidth = params.getMaxRollWidth();
        int stepSize = params.getStepSize();
        int totalOverCap = params.getTotalOverCap();

        for (int width : demands.keySet()) {
            List<Integer> coefficients = new ArrayList<>();
            for (PatternCandidate candidate : patterns) {
                int coefficient = candidate.getPattern().getOrDefault(width, 0);
                if (coefficient > 0) {
                    coefficients.add(coefficient);
                }
            }

            boolean needsRepair = false;
            if (coefficients.isEmpty()) {
                log.info("  Repair uncovered width {}mm", width);
                needsRepair = true;
            } else {
                int divisor = coefficients.get(0);
                for (int coefficient : coefficients) {
                    divisor = gcd(divisor, coefficient);
                }

                int capForWidth = allowOverSet.contains(width) ? totalOverCap : 0;
                boolean reachable = false;
                for (int extra = 0; extra <= capForWidth; extra++) {
                    if ((demands.get(width) + extra) % divisor == 0) {
                        reachable = true;
                        break;
                    }
                }

                if (!reachable) {
                    log.info("  Repair GCD-blocked width {}mm (gcd={}, demand={})",
                            width, divisor, demands.get(width));
                    needsRepair = true;
                }
            }

            if (!needsRepair) {
                continue;
            }

            boolean found = false;
            for (int fillWidth : widths) {
                if (found || fillWidth == width) {
                    continue;
                }

                for (int fillCount = 1; fillCount <= 5; fillCount++) {
                    int totalWidth = width + fillWidth * fillCount;
                    if (totalWidth < minRollWidth) {
                        continue;
                    }
                    if (totalWidth > maxRollWidth) {
                        break;
                    }

                    int rollWidth = ceilToStep(totalWidth, stepSize);
                    rollWidth = Math.max(rollWidth, minRollWidth);
                    rollWidth = Math.min(rollWidth, maxRollWidth);

                    if (totalWidth > rollWidth) {
                        continue;
                    }

                    Map<Integer, Integer> pattern = new HashMap<>();
                    pattern.put(width, 1);
                    pattern.put(fillWidth, fillCount);

                    PatternCandidate candidate = new PatternCandidate(pattern, rollWidth);
                    if (seen.add(candidate.signature())) {
                        patterns.add(candidate);
                        repaired++;
                        found = true;
                        log.info("    Generated repair pattern: {} @{}mm", pattern, rollWidth);
                        break;
                    }
                }
            }
        }

        return repaired;
    }

    private int gcd(int a, int b) {
        while (b != 0) {
            int next = b;
            b = a % b;
            a = next;
        }
        return a;
    }

    private static class MasterLPResult {
        final double objectiveValue;
        final Map<Integer, Double> dualPrices;
        final boolean feasible;

        MasterLPResult(double objectiveValue, Map<Integer, Double> dualPrices, boolean feasible) {
            this.objectiveValue = objectiveValue;
            this.dualPrices = dualPrices;
            this.feasible = feasible;
        }
    }
}
