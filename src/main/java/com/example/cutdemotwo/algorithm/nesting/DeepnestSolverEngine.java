package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.EvaluationResult;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.OrientedPart;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.PlacedInstance;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.ProblemContext;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.SearchOptions;
import com.example.cutdemotwo.contracts.nesting.EngineCapabilities;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Part;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.Callable;

import static com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.LNS_MIN_PIECES;
import static com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.isStrictlyBetter;
import static com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.placementsExtentY;
import static com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.reachedTheoreticalBound;
import static com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.toPlacements;

/**
 * Pure-Java 2D Irregular / Contour Nesting Engine migrated from {@code D:\GitHub\Deepnest}.
 *
 * <p>Combines Deepnest's three signature algorithmic layers:
 * <ol>
 *   <li><b>Exact Minkowski No-Fit Polygon (NFP) &amp; Inner-Fit Polygon (IFP)</b>
 *       ({@link DeepnestNfpGeometry}): convex polygon decomposition + rotating-calipers Minkowski sum
 *       + hole-aware segment convolution, with full NFP pair memoization and incremental {@code clipCache}
 *       boolean union;</li>
 *   <li><b>Genetic Algorithm Metaheuristic</b> ({@link DeepnestGeneticAlgorithm}): evolves part insertion
 *       permutations and discrete allowed orientations ({@code 0°/90°/180°/270°} or {@code 0°/180°}) via
 *       single-point order crossover, swap/rotation mutation, rank-weighted selection, and elitism;</li>
 *   <li><b>Gravity Bounding Compression &amp; Collinear Common-Line Merging</b>: evaluates NFP boundary
 *       vertices and crease-line intersections with collinear shared-edge rewards ({@code mergedLength}),
 *       backed by strict geometric verification matching {@link PolygonResultValidator}.</li>
 * </ol>
 */
@Service
public class DeepnestSolverEngine implements ICutSolverEngine, StripSearchCapable {
    private static final int DEFAULT_POPULATION_SIZE = 10;
    private static final int DEFAULT_MUTATION_RATE = 15;

    @Override
    public String getEngineType() {
        return "deepnest";
    }

    @Override
    public boolean isAvailable() {
        return true;
    }

    @Override
    public EngineCapabilities capabilities() {
        return new EngineCapabilities(
                getEngineType(),
                "1",
                List.of("RECTANGLE", "POLYGON"),
                List.of("CONTOUR"),
                List.of("MAXIMIZE_PIECE_AREA"),
                0.1,
                true
        );
    }

    @Override
    public EngineResult solve(NestingProblem problem) {
        return runDeepnest(problem, SearchOptions.standard(false, true));
    }

    /** Direct fixed-width open-strip minimization entry for {@code MarkerOptimization} STRIP_SEARCH. */
    @Override
    public EngineResult solveStripCandidate(NestingProblem problem) {
        return runDeepnest(problem, SearchOptions.standard(true, true));
    }

    /** 包级直跑入口（显式关闭大批量分区，供分区基准对比测试与独立验证使用）。 */
    EngineResult solveDirect(NestingProblem problem, boolean stripMode) {
        return runDeepnest(problem, SearchOptions.standard(stripMode, false));
    }

    /** 包级子区求解入口，供 {@link ContourPartitionSolver} 复用 NFP/GA/LNS/压紧核心。 */
    EngineResult solveSubproblem(NestingProblem subProblem,
                                 boolean stripMode,
                                 boolean allowParallel,
                                 long deadlineNanos,
                                 int popSizeCap,
                                 int maxGenerations,
                                 int maxStagnantComplete,
                                 int maxLnsRounds,
                                 int maxLnsStagnant) {
        return runDeepnest(subProblem, new SearchOptions(
                stripMode, false, allowParallel, deadlineNanos,
                popSizeCap, maxGenerations, maxStagnantComplete, maxLnsRounds, maxLnsStagnant
        ));
    }

    /**
     * 包级局部跨缝与末端精确 NFP 微调（供 {@link ContourPartitionSolver} 拼接压紧后打通子区接缝、压缩锯齿尾端）。
     * 采用确定性轮次与局部 Y 视窗裁剪，仅保留严格缩短版长且零容忍校验通过的改进解。
     */
    List<Placement> refineSeamAndTail(NestingProblem problem,
                                      List<Placement> incumbent,
                                      List<Double> seamYs,
                                      int maxRounds,
                                      long deadlineNanos) {
        return DeepnestLnsRefiner.refineSeamAndTail(problem, incumbent, seamYs, maxRounds, deadlineNanos);
    }

    private EngineResult runDeepnest(NestingProblem problem, SearchOptions options) {
        ComputationCancellation.check();
        if (options.deadlineNanos() <= 0L) {
            ContourPartitionSolver.clearDiagnostics();
        }
        boolean stripMode = options.stripMode();
        long startNanos = System.nanoTime();
        long budgetNanos = Math.max(1L, problem.timeLimitSeconds()) * 1_000_000_000L;

        ProblemContext ctx = new ProblemContext(problem, stripMode);
        if (ctx.items.isEmpty()) {
            EngineResult empty = new EngineResult();
            empty.setSuccess(true);
            empty.setPlacements(List.of());
            return empty;
        }

        int n = ctx.items.size();
        // 三阶段预算划分：留出出口安全裕量，确保阶段1(构造+GA)、阶段2(LNS大邻域精修)、阶段3(联动压紧+终检)严格不超时
        long effectiveBudget;
        long stage3Deadline;
        if (options.deadlineNanos() > 0L) {
            effectiveBudget = Math.max(150_000_000L, options.deadlineNanos() - startNanos);
            stage3Deadline = startNanos + effectiveBudget;
        } else {
            long exitMarginNanos = Math.min(600_000_000L, Math.max(200_000_000L, budgetNanos / 6));
            effectiveBudget = Math.max(200_000_000L, budgetNanos - exitMarginNanos);
            stage3Deadline = startNanos + effectiveBudget;
        }

        // 大批量均衡互补分区路径（仅 >=48 件、矩形无疵点、窗帘 NOOP、left-top 且剩余预算充足时触发；不满足或校验未过则无缝回退常规直跑）
        if (options.allowPartition() && ContourPartitionSolver.isEligible(
                problem, ctx.isRectMat, ctx.pipeline.isNoop(), ctx.preferRight, ctx.preferBottom,
                n, ctx.totalRequestedArea, ctx.sheetArea, stage3Deadline - System.nanoTime())) {
            EngineResult partitioned = ContourPartitionSolver.solve(this, problem, n, stripMode, stage3Deadline);
            if (partitioned != null) {
                return partitioned;
            }
            // 分区未满排或拼接压紧超限时，用剩余预算安全回退至常规单床直跑
            startNanos = System.nanoTime();
            effectiveBudget = Math.max(200_000_000L, stage3Deadline - startNanos);
            stage3Deadline = startNanos + effectiveBudget;
        }

        long stage3Reserve = n >= 2
                ? (options.deadlineNanos() > 0L
                    ? Math.min(250_000_000L, Math.max(60_000_000L, effectiveBudget / 6))
                    : Math.min(450_000_000L, Math.max(120_000_000L, effectiveBudget / 5)))
                : 0L;
        long stage2Deadline = stage3Deadline - stage3Reserve;
        long stage1Budget = n >= LNS_MIN_PIECES
                ? Math.max(150_000_000L, (long) ((stage2Deadline - startNanos) * 0.65))
                : Math.max(150_000_000L, stage2Deadline - startNanos);
        long stage1Deadline = startNanos + stage1Budget;

        int defaultPopSize = n == 1 ? 1 : (n <= 4 ? 6 : Math.max(DEFAULT_POPULATION_SIZE, 12));
        int popSize = options.popSizeCap() > 0 ? Math.min(defaultPopSize, options.popSizeCap()) : defaultPopSize;
        long seed = computeDeterministicSeed(problem);
        DeepnestGeneticAlgorithm ga = new DeepnestGeneticAlgorithm(ctx.items, popSize, DEFAULT_MUTATION_RATE, seed);

        double theoreticalMinY = Math.max(
                ctx.items.stream().mapToDouble(ep -> ep.byAngle.values().stream()
                        .mapToDouble(OrientedPart::height).min().orElse(0.0)).max().orElse(0.0),
                ctx.totalRequestedArea / Math.max(1.0, ctx.matW)
        );

        // ==================== 阶段 1：构造 + 并行 GA 初解 ====================
        EvaluationResult bestEval = null;
        int stagnantGenerations = 0;
        int maxStagnantComplete = options.maxStagnantComplete() > 0
                ? options.maxStagnantComplete()
                : (stripMode ? 6 : 4);
        int maxGenerations = options.maxGenerations() > 0 ? options.maxGenerations() : 120;

        int generation = 0;
        outerSearch:
        while (true) {
            ComputationCancellation.check();
            boolean improvedInGen = false;

            List<DeepnestGeneticAlgorithm.Individual> pop = ga.population();
            List<DeepnestGeneticAlgorithm.Individual> pending = new ArrayList<>(pop.size());
            for (DeepnestGeneticAlgorithm.Individual ind : pop) {
                if (!ind.evaluated) {
                    pending.add(ind);
                }
            }

            int batchSize = options.allowParallel() ? NestingParallelExecutor.MAX_PARALLELISM : 1;
            for (int start = 0; start < pending.size(); start += batchSize) {
                ComputationCancellation.check();
                if (bestEval != null && System.nanoTime() >= stage1Deadline) {
                    break outerSearch;
                }
                int end = Math.min(pending.size(), start + batchSize);
                final boolean hasIncumbent = bestEval != null;
                List<EvaluationResult> batchResults;
                if (batchSize <= 1 || end - start == 1) {
                    batchResults = List.of(DeepnestPlacementEvaluator.evaluateIndividual(
                            ctx, pending.get(start), stage1Deadline, hasIncumbent));
                } else {
                    List<Callable<EvaluationResult>> tasks = new ArrayList<>(end - start);
                    for (int i = start; i < end; i++) {
                        final DeepnestGeneticAlgorithm.Individual ind = pending.get(i);
                        tasks.add(() -> DeepnestPlacementEvaluator.evaluateIndividual(
                                ctx, ind, stage1Deadline, hasIncumbent));
                    }
                    batchResults = NestingParallelExecutor.runDeterministic(tasks);
                }
                for (int i = 0; i < batchResults.size(); i++) {
                    DeepnestGeneticAlgorithm.Individual ind = pending.get(start + i);
                    EvaluationResult eval = batchResults.get(i);
                    ind.fitness = eval.fitness();
                    ind.evaluated = true;

                    if (isStrictlyBetter(eval, bestEval)) {
                        bestEval = eval;
                        improvedInGen = true;
                    }

                    // Stop immediately if 100% of pieces are placed and theoretical lower bound is achieved
                    if (reachedTheoreticalBound(bestEval, n, theoreticalMinY)) {
                        break outerSearch;
                    }
                }
            }

            if (n <= 1 || System.nanoTime() >= stage1Deadline) {
                break;
            }

            boolean allEvaluated = pop.stream().allMatch(i -> i.evaluated);
            if (!allEvaluated) break;

            if (improvedInGen) {
                stagnantGenerations = 0;
                ga.nextGeneration();
            } else {
                stagnantGenerations++;
                if (bestEval != null && bestEval.placed().size() == n && stagnantGenerations >= maxStagnantComplete) {
                    break;
                }
                if (bestEval != null && bestEval.placed().size() < n && stagnantGenerations % 3 == 0) {
                    // Kit is still incomplete and time budget remains: inject diversified permutations & placement modes
                    ga.diversifyPopulation();
                } else {
                    ga.nextGeneration();
                }
            }

            generation++;
            if (generation >= maxGenerations) break;
        }

        EngineResult out = new EngineResult();
        if (bestEval == null || bestEval.placed().isEmpty()) {
            out.setSuccess(false);
            out.setFailureStatus("NO_SOLUTION_FOUND");
            out.setMessage("未找到可行排样方案");
            return out;
        }

        // ==================== 阶段 2：LNS 大邻域精修（Ruin-and-Recreate） ====================
        if (n >= LNS_MIN_PIECES
                && !reachedTheoreticalBound(bestEval, n, theoreticalMinY)
                && System.nanoTime() < stage2Deadline) {
            bestEval = DeepnestLnsRefiner.runLnsRefinement(ctx, bestEval, theoreticalMinY, seed, stage2Deadline,
                    options.maxLnsRounds(), options.maxLnsStagnant());
        }

        // ==================== 阶段 3：微滑 + 联动压紧 + 独立终检 ====================
        ComputationCancellation.check();
        List<Placement> incumbentPlacements = toPlacements(bestEval.placed());
        List<Placement> finalPlacements = incumbentPlacements;

        if (bestEval.placed().size() >= 2
                && !reachedTheoreticalBound(bestEval, n, theoreticalMinY)
                && System.nanoTime() < stage3Deadline) {
            if (options.deadlineNanos() > 0L) {
                // 分区子区内部仅执行确定性快速收尾（完整微滑 + 轴向同步压紧），避免子区级重插超时截断破坏确定性；
                // 跨缝空隙重插留给全局三明治压紧阶段统一执行。
                List<PlacedInstance> polished = DeepnestPlacementEvaluator.polishPlacements(
                        ctx, bestEval.placed(), stage3Deadline);
                finalPlacements = toPlacements(polished);
                if (!ctx.preferBottom
                        && (ctx.pipeline.isNoop() || ctx.pureSelvedgeForCompact)
                        && !ctx.hasAnyHoles
                        && finalPlacements.size() <= MarkerCompactor.MAX_COMPACT_PIECES
                        && AxisMarkerCompactor.supports(problem)
                        && System.nanoTime() < stage3Deadline) {
                    List<Placement> axisCompacted = AxisMarkerCompactor.compact(problem, finalPlacements, stage3Deadline);
                    if (axisCompacted != finalPlacements && axisCompacted.size() == finalPlacements.size()
                            && placementsExtentY(axisCompacted) < placementsExtentY(finalPlacements) - 1e-6) {
                        finalPlacements = axisCompacted;
                    }
                }
            } else {
                // The reserve is a minimum. Reuse time left by GA/LNS to finish the contact search.
                long now = System.nanoTime();
                long polishDeadline = now + Math.min(stage3Reserve / 4, (stage3Deadline - now) / 4);
                List<PlacedInstance> polished = DeepnestPlacementEvaluator.polishPlacements(
                        ctx, bestEval.placed(), polishDeadline);
                if (System.nanoTime() < polishDeadline) {
                    finalPlacements = toPlacements(polished);
                }

                if (!ctx.preferBottom
                        && (ctx.pipeline.isNoop() || ctx.pureSelvedgeForCompact)
                        && !ctx.hasAnyHoles
                        && finalPlacements.size() <= MarkerCompactor.MAX_COMPACT_PIECES
                        && System.nanoTime() < stage3Deadline) {
                    finalPlacements = runLinkedCompaction(problem, finalPlacements, stage3Deadline, stage3Reserve);
                }
            }
        }

        ComputationCancellation.check();
        out.setSuccess(true);
        out.setPlacements(finalPlacements);
        if (PolygonResultValidator.validate(problem, out) != null) {
            out.setPlacements(incumbentPlacements);
        }
        return out;
    }

    /**
     * 阶段 3 联动压紧：先尝试空隙重插压紧（MarkerCompactor），再串联轴向同步压紧（AxisMarkerCompactor）。
     * 两者内部均支持 pieceGap > 0、带疵点与 200 件上限，并在带不兼容窗帘约束时安全跳过且内置零容忍兜底。
     */
    private static List<Placement> runLinkedCompaction(NestingProblem problem,
                                                       List<Placement> incumbent,
                                                       long deadlineNanos, long stage3Reserve) {
        ComputationCancellation.check();
        List<Placement> current = incumbent;
        double currentExtentY = placementsExtentY(current);

        if (MarkerCompactor.supportsGapSearch(problem)) {
            long now = System.nanoTime();
            long remaining = deadlineNanos - now;
            if (remaining > 5_000_000L) {
                long gapDeadline = deadlineNanos - Math.min(remaining, stage3Reserve) * 2 / 5;
                List<Placement> gapCompacted = MarkerCompactor.compact(problem, current, gapDeadline);
                // A deadline can interrupt a single piece's contact scan. Keep the preceding
                // layout unless this refinement finished, even when its partial result is shorter.
                if (System.nanoTime() < gapDeadline && gapCompacted != current && gapCompacted.size() == current.size()) {
                    double newExtentY = placementsExtentY(gapCompacted);
                    if (newExtentY < currentExtentY - 1e-6) {
                        current = gapCompacted;
                        currentExtentY = newExtentY;
                    }
                }
            }
        }
        ComputationCancellation.check();
        if (System.nanoTime() < deadlineNanos && AxisMarkerCompactor.supports(problem)) {
            List<Placement> axisCompacted = AxisMarkerCompactor.compact(problem, current, deadlineNanos);
            if (System.nanoTime() < deadlineNanos && axisCompacted != current && axisCompacted.size() == current.size()) {
                double newExtentY = placementsExtentY(axisCompacted);
                if (newExtentY < currentExtentY - 1e-6) {
                    current = axisCompacted;
                }
            }
        }

        return current;
    }

    private static long computeDeterministicSeed(NestingProblem p) {
        long h = 0x9E3779B97F4A7C15L;
        h = h * 31 + Double.hashCode(p.width());
        h = h * 31 + Double.hashCode(p.height());
        h = h * 31 + Double.hashCode(p.process().pieceGap());
        for (Part part : p.parts()) {
            h = h * 31 + Objects.hash(part.id(), part.quantity(), part.allowRotation(), part.allowHalfTurn());
            h = h * 31 + Double.hashCode(part.shape().width());
            h = h * 31 + Double.hashCode(part.shape().height());
        }
        return h;
    }
}
