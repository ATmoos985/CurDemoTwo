package changyang.cut.apsmodule.generator.NewSolver;

import com.google.ortools.Loader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import changyang.cut.apsmodule.generator.NewSolver.colgen.ColumnGenerationSolver;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverParameters;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverRuntimeProperties;
import changyang.cut.apsmodule.generator.NewSolver.mip.MultiStageMIPSolver;
import changyang.cut.apsmodule.generator.NewSolver.mip.PatternAlignmentContext;
import changyang.cut.apsmodule.generator.NewSolver.model.PatternCandidate;
import changyang.cut.apsmodule.generator.NewSolver.model.SolverResult;
import changyang.cut.apsmodule.generator.NewSolver.output.InstructionConverter;
import changyang.cut.apsmodule.generator.NewSolver.output.SequenceGroupPostProcessor;
import changyang.cut.apsmodule.generator.NewSolver.output.SetPartitionRefiner;
import changyang.cut.apsmodule.generator.NewSolver.output.SolverRunColumnArchive;
import changyang.cut.apsmodule.generator.NewSolver.pattern.CompletePatternEnumerator;
import changyang.cut.apsmodule.generator.NewSolver.pattern.PatternGenerator;
import changyang.cut.apsmodule.generator.NewSolver.report.SolveReportWriter;
import changyang.cut.apsmodule.service.CuttingInstruction;
import changyang.cut.apsmodule.service.SolverConfig;
import changyang.cut.apsmodule.service.SolverOrderItem;
import changyang.cut.apsmodule.solver.CuttingSolverAlgorithm;
import changyang.cut.apsmodule.solver.kernel.DeterministicPlanSelector;
import changyang.cut.apsmodule.solver.kernel.PlanQuality;
import changyang.cut.apsmodule.solver.kernel.execution.BoundedSolverTaskExecutor;
import changyang.cut.apsmodule.solver.kernel.execution.DirectSolverTaskExecutor;
import changyang.cut.apsmodule.solver.kernel.execution.SolverTaskExecutor;

import java.util.*;
import java.util.stream.Collectors;

/**
 * NewSolver unified entry.
 */
@Component
public class CuttingSolver implements CuttingSolverAlgorithm {

    private static final Logger log = LoggerFactory.getLogger(CuttingSolver.class);
    private static final DeterministicPlanSelector PLAN_SELECTOR = new DeterministicPlanSelector();
    private static boolean orToolsLoaded = false;

    /**
     * A-layer SCIP seed(s) for the pattern-selection MIP, swept across demand orders.
     * Consolidated to seed 1 only: it lands the selection on low-pattern (42-44) 花型集
     * that the B-layer assembles to 74-76, while the default seed 0 caps at 79. Seed 7
     * was dropped — it produces 46-pattern sets that Stage5 frequently can't solve in
     * time (NOT_SOLVED → greedy fallback), i.e. wasted runtime for no reliable gain.
     * Fewer candidates = roughly half the solve time at the same result level.
     */
    private static final int[] A_LAYER_SEEDS = {1};

    // Baseline defaults only; each solve call uses a per-request copy.
    private final SolverParameters baseParams;

    public CuttingSolver() {
        this(SolverParameters.createDefault());
    }

    public CuttingSolver(SolverParameters params) {
        this.baseParams = (params == null ? SolverParameters.createDefault() : params.copy());
        this.baseParams.sanitize();
        loadOrTools();
    }

    private synchronized void loadOrTools() {
        if (!orToolsLoaded) {
            try {
                Loader.loadNativeLibraries();
                orToolsLoaded = true;
                log.info("OR-Tools loaded.");
            } catch (Exception e) {
                log.error("OR-Tools load failed", e);
            }
        }
    }

    @Override
    public boolean supports(SolverConfig config) {
        return config.isUseNewSolver();
    }

    @Override
    public List<CuttingInstruction> solve(List<SolverOrderItem> items, SolverConfig config) {
        log.info("\n========== NewSolver START ==========");
        long startTime = System.currentTimeMillis();

        // Per-request parameter snapshot to avoid cross-request contamination.
        SolverParameters params = baseParams.copy();
        params.mergeFrom(config);
        log.debug("Params: {}", params);

        // Per-request solver components to keep state isolated.
        PatternGenerator patternGenerator = new PatternGenerator(params);
        ColumnGenerationSolver colGenSolver = new ColumnGenerationSolver(params);
        Map<String, List<SolverOrderItem>> groups = items.stream()
                .collect(Collectors.groupingBy(
                        SolverOrderItem::getGroupKey,
                        TreeMap::new,
                        Collectors.toList()));
        long fastDeadlineMs = fastPreviewMode()
                ? startTime + fastBudgetMs()
                : Long.MAX_VALUE;
        long qualityBudget = qualityBudgetMs();
        long qualityDeadlineMs = qualityMode() && qualityBudget > 0L
                ? startTime + qualityBudget
                : Long.MAX_VALUE;

        log.info("Group count: {}", groups.size());

        List<CuttingInstruction> allInstructions = new ArrayList<>();

        try (SolveReportWriter report = SolveReportWriter.create()) {
            if (!"disabled".equals(report.getFilePath())) {
                log.info("Solve report: {}", report.getFilePath());
            }

            int totalGroups = groups.size();
            int groupIndex = 0;
            for (Map.Entry<String, List<SolverOrderItem>> group : groups.entrySet()) {
                String groupKey = group.getKey();
                List<SolverOrderItem> groupItems = group.getValue();
                long groupStart = System.currentTimeMillis();
                int groupsRemaining = Math.max(1, totalGroups - groupIndex++);
                long groupDeadlineMs = fastPreviewMode()
                        ? allocateALayerDeadline(fastDeadlineMs, groupsRemaining)
                        : allocateGroupDeadline(qualityDeadlineMs, groupsRemaining);
                long aLayerDeadlineMs = fastPreviewMode()
                        ? groupDeadlineMs
                        : allocateQualityALayerDeadline(groupDeadlineMs);

                log.info("--- Processing group: {} ({} items) ---", groupKey, groupItems.size());

                // Width-ascending TreeMap (NOT HashMap): a deterministic demand order
                // is what makes the whole solve reproducible. HashMap bucket order
                // created degenerate ties that SCIP's RNG broke differently each solve,
                // which was the root cause of the run-to-run sequence-group swing.
                Map<Integer, Integer> demands = new java.util.TreeMap<>();
                for (SolverOrderItem item : groupItems) {
                    demands.merge(item.getWidth(), item.getDemand(), Integer::sum);
                }

                Set<Integer> allowOverSet = buildAllowOverSet(demands, params);
                PatternAlignmentContext alignmentContext = PatternAlignmentContext.from(groupItems);
                report.beginGroup(groupKey, groupItems, demands, allowOverSet, totalGroups);
                log.debug("Allow-over widths: {}", allowOverSet);

                long colGenStart = System.currentTimeMillis();
                List<PatternCandidate> patterns = patternGenerator.generate(demands);
                patterns = colGenSolver.solve(patterns, demands, allowOverSet);
                List<PatternCandidate> qualityPatterns = buildQualityPatternPool(
                        patterns, demands, params);
                long colGenElapsedMs = System.currentTimeMillis() - colGenStart;

                // Multi-start over deterministic demand orders. Each order makes the
                // selection MIP build variables in a different order -> a different
                // deterministic pattern set. Pooling candidates across orders widens the
                // search so the best assignment is more reliably low (a single order
                // caps at 81; the demand-descending order reaches a set that hits 79).
                List<MultiStageMIPSolver.SolveCandidate> solveCandidates = new ArrayList<>();
                java.util.Set<String> seenCandidateSigs = new java.util.HashSet<>();
                List<ALayerTask> aLayerTasks = new ArrayList<>();
                List<Map<Integer, Integer>> demandOrders = buildDemandOrders(demands);
                double[] alignmentLambdas = aLayerAlignmentLambdas();
                int nestedWidthCap = nestedWidthCandidateCap(params);
                if (!fastPreviewMode()) {
                    for (int orderIdx = 0; orderIdx < demandOrders.size(); orderIdx++) {
                        Map<Integer, Integer> orderedDemands = demandOrders.get(orderIdx);
                        // Every order: cheap primary (legacy) only, swept over a small set of
                        // A-layer SCIP seeds. The seed deterministically steers the selection
                        // MIP onto a different 花型集 among tie-degenerate optima — the multi-start
                        // dimension that finds lower-group sets. The expensive diverse generation
                        // was removed: across every measured run its candidates never won (always
                        // 85-103, beaten by a legacy primary), so it was ~half the runtime for no
                        // gain. Distinct 花型集 are deduped by signature so the B-layer assignment
                        // runs once per genuinely different set, not once per (order, seed).
                        List<ALayerTask> orderTasks = new ArrayList<>();
                        double[] parityPenalties = aLayerParityPenalties();
                        for (int seed : A_LAYER_SEEDS) {
                            for (double alignmentLambda : alignmentLambdas) {
                                for (double parityPenalty : parityPenalties) {
                                    // parity 经系统属性注入（LegacyOrderPatternSelectionSolver
                                    // 的 parityPenalty() 读取），调用后立即还原
                                    // Scoped runtime override; do not leak A-layer experiment flags
                                    // through JVM-wide system properties.
                                    orderTasks.add(new ALayerTask(
                                            "o" + orderIdx + "-s" + seed + "-a"
                                                    + formatLambda(alignmentLambda)
                                                    + "-p" + formatLambda(parityPenalty) + "-",
                                            patterns,
                                            orderedDemands,
                                            allowOverSet,
                                            seed,
                                            alignmentLambda,
                                            parityPenalty,
                                            alignmentContext,
                                            false));
                                }
                            }
                        }
                        aLayerTasks.addAll(orderTasks);
                    }
                    if (nestedWidthCap >= params.getMinRollWidth()) {
                        List<PatternCandidate> nestedPatterns = patterns.stream()
                                .filter(pattern -> pattern.getRollWidth() <= nestedWidthCap)
                                .toList();
                        if (!nestedPatterns.isEmpty()) {
                            double[] parityPenalties = aLayerParityPenalties();
                            double nestedParity = parityPenalties[parityPenalties.length - 1];
                            aLayerTasks.add(new ALayerTask(
                                    "nested-w" + nestedWidthCap + "-p"
                                            + formatLambda(nestedParity) + "-",
                                    nestedPatterns,
                                    demandOrders.get(0),
                                    allowOverSet,
                                    A_LAYER_SEEDS[0],
                                    0.0,
                                    nestedParity,
                                    alignmentContext,
                                    false));
                        }
                    }
                }

                List<MultiStageMIPSolver.SolveCandidate> rawCandidates = new ArrayList<>();
                ALayerTask baselineTask = null;
                MultiStageMIPSolver.SolveCandidate baseline = null;
                long baselineStart = System.currentTimeMillis();
                if (fastPreviewMode() || qualityMode()) {
                    baselineTask = new ALayerTask(
                            "fast-baseline-", patterns, demandOrders.get(0), allowOverSet,
                            A_LAYER_SEEDS[0], 0.0, 0.0, alignmentContext, true);
                    baseline = solveALayerTask(baselineTask, params, aLayerDeadlineMs);
                    if (baseline != null) {
                        rawCandidates.add(baseline);
                        log.info("FAST baseline established before quality search: {}", baseline.name());
                    } else {
                        log.warn("FAST baseline could not be established; quality candidates continue");
                    }
                }
                long baselineElapsedMs = System.currentTimeMillis() - baselineStart;

                long aLayerTasksStart = System.currentTimeMillis();
                if (!aLayerTasks.isEmpty()) {
                    try (SolverTaskExecutor executor = createTaskExecutor(
                            "a-layer", "cutting.parallel.aLayer.enabled",
                            "cutting.parallel.aLayer.threads", aLayerTasks.size())) {
                        logParallelStage("A-layer quality search", executor, aLayerTasks.size());
                        final ALayerTask establishedBaselineTask = baselineTask;
                        final MultiStageMIPSolver.SolveCandidate establishedBaseline = baseline;
                        final boolean hasBaseline = establishedBaseline != null;
                        rawCandidates.addAll(executor.mapOrdered(aLayerTasks,
                                        task -> {
                                            if (hasBaseline && aLayerDeadlineMs != Long.MAX_VALUE
                                                    && System.currentTimeMillis() >= aLayerDeadlineMs) {
                                                log.info("Skipping A-layer task {} because A-layer budget is exhausted",
                                                        task.namePrefix());
                                                return null;
                                            }
                                            if (hasBaseline && canReuseBaselineStage3(
                                                    task, establishedBaselineTask, establishedBaseline)) {
                                                return solveALayerStage4FromBaseline(
                                                        task, establishedBaseline, params, aLayerDeadlineMs);
                                            }
                                            return solveALayerTask(task, params, aLayerDeadlineMs);
                                        }).stream()
                                .filter(Objects::nonNull)
                                .toList());
                    }
                }
                long aLayerTasksElapsedMs = System.currentTimeMillis() - aLayerTasksStart;
                if (completePatternQualityEnabled() && baseline != null) {
                    MultiStageMIPSolver.SolveCandidate completeRefinement =
                            solveCompletePatternRefinement(
                                    qualityPatterns,
                                    demands,
                                    allowOverSet,
                                    baseline,
                                    params,
                                    alignmentContext);
                    if (completeRefinement != null) {
                        rawCandidates.add(completeRefinement);
                    } else {
                        log.warn("Complete-pattern Stage4 refinement unavailable; keeping baseline candidates");
                    }
                }
                for (MultiStageMIPSolver.SolveCandidate candidate : rawCandidates) {
                    String sig = solutionSignature(candidate.result().getSolution());
                    if (seenCandidateSigs.add(sig)) {
                        solveCandidates.add(candidate);
                    }
                }
                if (solveCandidates.isEmpty()) {
                    log.warn("Solve failed for group: {}", groupKey);
                    report.writeGroupFailure(
                            groupKey,
                            "pattern selection returned no candidates",
                            System.currentTimeMillis() - groupStart);
                    continue;
                }

                // FAST uses one deterministic greedy conversion. QUALITY keeps that
                // conversion as the baseline before evaluating Stage5/LNS/SPR.
                long bLayerStart = System.currentTimeMillis();
                long staticGroupBudgetMs = qualityMode() && qualityBudget > 0L
                        ? Math.max(1_000L, qualityBudget / Math.max(1, totalGroups))
                        : Long.MAX_VALUE;
                GroupSolvePlan bestPlan = null;
                List<SolveReportWriter.CandidateRow> reportRows = new ArrayList<>();
                List<SolveReportWriter.SequenceCandidateRow> sequenceReportRows = new ArrayList<>();
                List<CandidateEvaluation> candidateEvaluations = evaluateCandidates(
                        solveCandidates, groupKey, groupItems, demands, params,
                        groupDeadlineMs, staticGroupBudgetMs);
                long bLayerElapsedMs = System.currentTimeMillis() - bLayerStart;
                log.info("Group {} stage timings: colGen={}ms, aLayerBaseline={}ms, aLayerTasks={}ms, bLayer={}ms, distinctCandidates={}",
                        groupKey, colGenElapsedMs, baselineElapsedMs, aLayerTasksElapsedMs,
                        bLayerElapsedMs, solveCandidates.size());
                for (CandidateEvaluation evaluation : candidateEvaluations) {
                    int candidateIndex = evaluation.order();
                    MultiStageMIPSolver.SolveCandidate solveCandidate = evaluation.candidate();
                    SolverResult result = solveCandidate.result();
                    printSolutionSummary(result, demands);

                    InstructionConverter.ConversionResult conversion = evaluation.conversion();
                    List<CuttingInstruction> instructions = conversion.instructions();
                    SequenceGroupPostProcessor.GroupStats stats =
                            SequenceGroupPostProcessor.computeGroupStats(instructions);
                    int sequenceGroups = stats.groups();

                    for (InstructionConverter.SequenceCandidateRow row : conversion.candidateRows()) {
                        sequenceReportRows.add(new SolveReportWriter.SequenceCandidateRow(
                                solveCandidate.name(),
                                row.name(),
                                row.sequenceGroupCount(),
                                row.instructions(),
                                row.selected()));
                    }

                    log.info("Pattern candidate {}: patterns={}, waste={}mm, over={}, groups={}, "
                                    + "oddCars={}, oneCars={}, smallCars={}, assignmentWinner={}",
                            solveCandidate.name(),
                            result.getPatternCount(),
                            result.getTotalWaste(),
                            result.getTotalOverProduction(),
                            sequenceGroups,
                            stats.oddCarGroups(),
                            stats.oneCarGroups(),
                            stats.smallCarGroups(),
                            conversion.selectedName());

                    reportRows.add(new SolveReportWriter.CandidateRow(
                            solveCandidate.name(),
                            result,
                            sequenceGroups,
                            params.getTotalWidth()));

                    GroupSolvePlan plan = new GroupSolvePlan(
                            solveCandidate.name(),
                            result,
                            instructions,
                            sequenceGroups,
                            stats.oddCarGroups(),
                            stats.oneCarGroups(),
                            stats.smallCarGroups(),
                            conversion.selectedName(),
                            candidateIndex);
                    if (bestPlan == null || PLAN_SELECTOR.isBetter(
                            toPlanQuality(plan), toPlanQuality(bestPlan))) {
                        bestPlan = plan;
                    }
                }

                if (bestPlan == null) {
                    log.warn("No usable instruction plan produced for group: {}", groupKey);
                    report.writeGroupFailure(
                            groupKey,
                            "instruction conversion produced no usable plan",
                            System.currentTimeMillis() - groupStart);
                    continue;
                }

                log.info("Selected pattern candidate for group {}: {} / {} (groups={}, patterns={}, waste={}mm)",
                        groupKey,
                        bestPlan.name(),
                        bestPlan.sequenceCandidateName(),
                        bestPlan.sequenceGroupCount(),
                        bestPlan.result().getPatternCount(),
                        bestPlan.result().getTotalWaste());

                report.writeGroupResult(
                        reportRows,
                        sequenceReportRows,
                        bestPlan.name(),
                        bestPlan.result().getSolution(),
                        bestPlan.sequenceGroupCount(),
                        params.getTotalWidth(),
                        System.currentTimeMillis() - groupStart,
                        demands);

                allInstructions.addAll(bestPlan.instructions());
                log.debug("Generated instructions: {}", bestPlan.instructions().size());
            }

            report.writeSummary(allInstructions.size());
        }

        long totalTime = System.currentTimeMillis() - startTime;
        log.info("\n========== NewSolver DONE ==========");
        log.info("Elapsed: {}ms", totalTime);
        log.info("Total instructions: {}", allInstructions.size());

        return allInstructions;
    }

    static boolean canReuseBaselineStage3(
            ALayerTask task,
            ALayerTask baselineTask,
            MultiStageMIPSolver.SolveCandidate baseline) {
        if (task == null || baselineTask == null || baseline == null
                || task.fastBaselineCandidate() || !baseline.stage3Optimal()) {
            return false;
        }
        return task.seed() == baselineTask.seed()
                && task.patterns().equals(baselineTask.patterns())
                && task.demands().equals(baselineTask.demands())
                && new ArrayList<>(task.demands().keySet())
                        .equals(new ArrayList<>(baselineTask.demands().keySet()))
                && task.allowOverWidths().equals(baselineTask.allowOverWidths());
    }

    private MultiStageMIPSolver.SolveCandidate solveALayerStage4FromBaseline(
            ALayerTask task,
            MultiStageMIPSolver.SolveCandidate baseline,
            SolverParameters params,
            long deadlineMs) {
        try {
            SolverParameters taskParams = params.copy();
            if (deadlineMs != Long.MAX_VALUE) {
                long remainingMs = Math.max(500L, deadlineMs - System.currentTimeMillis());
                taskParams.setTimeoutMs(Math.min(taskParams.getTimeoutMs(), remainingMs));
            }
            Map<String, String> taskOverrides = new HashMap<>();
            taskOverrides.put("cutting.aLayerParityPenalty",
                    Double.toString(task.parityPenalty()));
            MultiStageMIPSolver.SolveCandidate refined = SolverRuntimeProperties.withOverrides(
                    taskOverrides,
                    () -> new MultiStageMIPSolver(taskParams).refineStage4FromStage3Baseline(
                            new ArrayList<>(task.patterns()),
                            task.demands(),
                            task.allowOverWidths(),
                            baseline.result().getSolution(),
                            task.seed(),
                            task.alignmentLambda(),
                            task.alignmentContext()));
            return refined == null
                    ? null
                    : new MultiStageMIPSolver.SolveCandidate(
                            task.namePrefix() + refined.name(), refined.result());
        } catch (RuntimeException e) {
            log.warn("A-layer Stage4-from-baseline task {} failed; remaining candidates continue",
                    task.namePrefix(), e);
            return null;
        }
    }

    private MultiStageMIPSolver.SolveCandidate solveALayerTask(
            ALayerTask task, SolverParameters params, long deadlineMs) {
        try {
            SolverParameters taskParams = params.copy();
            if (deadlineMs != Long.MAX_VALUE) {
                long remainingMs = Math.max(500L, deadlineMs - System.currentTimeMillis());
                taskParams.setTimeoutMs(Math.min(taskParams.getTimeoutMs(), remainingMs));
            }
            if (task.fastBaselineCandidate()) {
                taskParams.setTimeoutMs(Math.min(taskParams.getTimeoutMs(), fastBudgetMs()));
            }
            Map<String, String> taskOverrides = new HashMap<>();
            taskOverrides.put("cutting.aLayerParityPenalty",
                    Double.toString(task.parityPenalty()));
            if (task.fastBaselineCandidate()) {
                taskOverrides.put("cutting.fast.preview", "true");
            }
            MultiStageMIPSolver.SolveCandidate primary = SolverRuntimeProperties.withOverrides(
                    taskOverrides,
                    () -> new MultiStageMIPSolver(taskParams).solvePrimaryOnly(
                            new ArrayList<>(task.patterns()),
                            task.demands(),
                            task.allowOverWidths(),
                            task.seed(),
                            task.alignmentLambda(),
                            task.alignmentContext()));
            return primary == null
                    ? null
                    : new MultiStageMIPSolver.SolveCandidate(
                            task.namePrefix() + primary.name(),
                            primary.result(),
                            primary.stage3Optimal());
        } catch (RuntimeException e) {
            log.warn("A-layer task {} failed; remaining candidates continue",
                    task.namePrefix(), e);
            return null;
        }
    }

    private MultiStageMIPSolver.SolveCandidate solveCompletePatternRefinement(
            List<PatternCandidate> patterns,
            Map<Integer, Integer> demands,
            Set<Integer> allowOverSet,
            MultiStageMIPSolver.SolveCandidate baseline,
            SolverParameters params,
            PatternAlignmentContext alignmentContext) {
        try {
            SolverParameters taskParams = params.copy();
            double[] parityPenalties = aLayerParityPenalties();
            double parityPenalty = parityPenalties[parityPenalties.length - 1];
            return SolverRuntimeProperties.withOverrides(
                    Map.of("cutting.aLayerParityPenalty", Double.toString(parityPenalty)),
                    () -> new MultiStageMIPSolver(taskParams).refinePrimaryWithPatterns(
                            new ArrayList<>(patterns),
                            demands,
                            allowOverSet,
                            baseline.result().getSolution(),
                            A_LAYER_SEEDS[0],
                            0.0,
                            alignmentContext));
        } catch (RuntimeException e) {
            log.warn("Complete-pattern Stage4 refinement failed; keeping baseline candidates", e);
            return null;
        }
    }

    /**
     * 按 {@link DeterministicPlanSelector} 字典序前两级 (totalOverProduction, totalRolls)
     * 对进入 B 层前的 A 层候选做严格主导预剪枝：任何超产更高或同超产下车数更多的候选
     * 0% 可能胜出，直接过滤不再送入昂贵的 Stage5 MIP 与 LNS。
     */
    static List<MultiStageMIPSolver.SolveCandidate> pruneDominatedCandidates(
            List<MultiStageMIPSolver.SolveCandidate> candidates) {
        if (candidates == null || candidates.size() <= 1) {
            return candidates == null ? List.of() : List.copyOf(candidates);
        }
        int minOver = Integer.MAX_VALUE;
        int minRolls = Integer.MAX_VALUE;
        for (MultiStageMIPSolver.SolveCandidate candidate : candidates) {
            SolverResult res = candidate.result();
            int over = res.getTotalOverProduction();
            int rolls = res.getTotalRolls();
            if (over < minOver || (over == minOver && rolls < minRolls)) {
                minOver = over;
                minRolls = rolls;
            }
        }
        final int targetOver = minOver;
        final int targetRolls = minRolls;
        List<MultiStageMIPSolver.SolveCandidate> kept = new ArrayList<>(candidates.size());
        for (MultiStageMIPSolver.SolveCandidate candidate : candidates) {
            SolverResult res = candidate.result();
            if (res.getTotalOverProduction() == targetOver && res.getTotalRolls() == targetRolls) {
                kept.add(candidate);
            }
        }
        return kept;
    }

    private List<CandidateEvaluation> evaluateCandidates(
            List<MultiStageMIPSolver.SolveCandidate> solveCandidates,
            String groupKey,
            List<SolverOrderItem> groupItems,
            Map<Integer, Integer> demands,
            SolverParameters params,
            long groupDeadlineMs,
            long staticGroupBudgetMs) {
        List<MultiStageMIPSolver.SolveCandidate> dominantCandidates =
                pruneDominatedCandidates(solveCandidates);
        Set<MultiStageMIPSolver.SolveCandidate> dominantSet =
                Collections.newSetFromMap(new IdentityHashMap<>());
        dominantSet.addAll(dominantCandidates);
        if (dominantCandidates.size() < solveCandidates.size()) {
            SolverResult bestRes = dominantCandidates.get(0).result();
            log.info("B-layer dominance pruning: kept {}/{} candidates (minOver={}, minRolls={})",
                    dominantCandidates.size(), solveCandidates.size(),
                    bestRes.getTotalOverProduction(), bestRes.getTotalRolls());
        }

        List<CandidateTask> primaryTasks = new ArrayList<>(dominantCandidates.size());
        List<CandidateTask> fallbackTasks = new ArrayList<>();
        for (int i = 0; i < solveCandidates.size(); i++) {
            MultiStageMIPSolver.SolveCandidate candidate = solveCandidates.get(i);
            if (dominantSet.contains(candidate)) {
                primaryTasks.add(new CandidateTask(i, candidate));
            } else {
                fallbackTasks.add(new CandidateTask(i, candidate));
            }
        }

        List<CandidateEvaluation> baseEvaluations = runBaseEvaluations(
                primaryTasks, groupKey, groupItems, demands, params, groupDeadlineMs, staticGroupBudgetMs);
        if (baseEvaluations.isEmpty() && !fallbackTasks.isEmpty()) {
            log.warn("All dominant B-layer candidates produced empty conversions; falling back to {} pruned candidates",
                    fallbackTasks.size());
            baseEvaluations = runBaseEvaluations(
                    fallbackTasks, groupKey, groupItems, demands, params, groupDeadlineMs, staticGroupBudgetMs);
        }

        if (!qualityMode() || !SetPartitionRefiner.isEnabled() || baseEvaluations.isEmpty()) {
            return baseEvaluations;
        }
        int bestBaseGroups = baseEvaluations.stream()
                .mapToInt(evaluation -> evaluation.conversion().selectedSequenceGroups())
                .min()
                .orElse(Integer.MAX_VALUE);
        int gap = SetPartitionRefiner.skipGapThreshold();
        List<CandidateEvaluation> shortlistedEvaluations = baseEvaluations.stream()
                .filter(evaluation -> isSprShortlisted(
                        evaluation.conversion().selectedSequenceGroups(), bestBaseGroups, gap))
                .toList();
        try (SolverTaskExecutor executor = createTaskExecutor(
                "spr-candidate", "cutting.parallel.sprCandidates.enabled",
                "cutting.parallel.sprCandidates.threads", shortlistedEvaluations.size())) {
            boolean outerParallel = executor.parallelism(shortlistedEvaluations.size()) > 1;
            log.info("SPR shortlist: {}/{} candidates (bestGroups={}, gap={})",
                    shortlistedEvaluations.size(), baseEvaluations.size(), bestBaseGroups, gap);
            logParallelStage("SPR candidates", executor, shortlistedEvaluations.size());
            List<CandidateEvaluation> refined = executor.mapOrdered(
                    shortlistedEvaluations,
                    evaluation -> refineCandidate(evaluation, params, outerParallel));
            Map<Integer, CandidateEvaluation> refinedByOrder = refined.stream()
                    .collect(Collectors.toMap(CandidateEvaluation::order, evaluation -> evaluation));
            return baseEvaluations.stream()
                    .map(evaluation -> refinedByOrder.getOrDefault(
                            evaluation.order(), evaluation))
                    .toList();
        }
    }

    private List<CandidateEvaluation> runBaseEvaluations(
            List<CandidateTask> tasks,
            String groupKey,
            List<SolverOrderItem> groupItems,
            Map<Integer, Integer> demands,
            SolverParameters params,
            long groupDeadlineMs,
            long staticGroupBudgetMs) {
        if (tasks.isEmpty()) {
            return List.of();
        }
        try (SolverTaskExecutor executor = createTaskExecutor(
                "candidate", "cutting.parallel.candidates.enabled",
                "cutting.parallel.candidates.threads", tasks.size())) {
            int activeParallelism = executor.parallelism(tasks.size());
            boolean outerParallel = activeParallelism > 1;
            logParallelStage(fastPreviewMode()
                    ? "FAST preview candidates"
                    : "Stage5+LNS candidates", executor, tasks.size());
            int totalCandidates = Math.max(1, tasks.size());
            List<IndexedCandidateTask> indexedTasks = new ArrayList<>(tasks.size());
            for (int idx = 0; idx < tasks.size(); idx++) {
                indexedTasks.add(new IndexedCandidateTask(idx, tasks.get(idx)));
            }
            return executor.mapOrdered(indexedTasks,
                            indexed -> evaluateBaseCandidate(
                                    indexed.task(), indexed.position(), groupKey, groupItems, demands, params,
                                    outerParallel, activeParallelism, groupDeadlineMs, staticGroupBudgetMs,
                                    totalCandidates))
                    .stream()
                    .filter(Objects::nonNull)
                    .toList();
        }
    }

    private CandidateEvaluation evaluateBaseCandidate(
            CandidateTask task,
            int positionInBatch,
            String groupKey,
            List<SolverOrderItem> groupItems,
            Map<Integer, Integer> demands,
            SolverParameters params,
            boolean outerParallel,
            int activeParallelism,
            long groupDeadlineMs,
            long staticGroupBudgetMs,
            int totalCandidates) {
        try {
            InstructionConverter converter = new InstructionConverter(params);
            InstructionConverter.ConversionResult fastBaseline = null;
            if (fastPreviewMode() || qualityMode()) {
                fastBaseline = converter.convertFastPreview(
                        task.candidate().result().getSolution(),
                        groupKey,
                        groupItems,
                        demands);
                if (fastPreviewMode()) {
                    return fastBaseline.instructions().isEmpty()
                            ? null
                            : new CandidateEvaluation(task.order(), task.candidate(), fastBaseline);
                }
            }

            InstructionConverter.ConversionResult conversion;
            try {
                Map<String, String> overrides = new HashMap<>();
                if (outerParallel) {
                    overrides.put("cutting.lns.parallel", "false");
                    overrides.put("cutting.spr.parallel", "false");
                }
                if (qualityMode() && groupDeadlineMs != Long.MAX_VALUE) {
                    long remainingMs = groupDeadlineMs - System.currentTimeMillis() - 1_000L;
                    int divisor;
                    if (outerParallel) {
                        divisor = Math.max(1, (totalCandidates + activeParallelism - 1) / activeParallelism);
                    } else {
                        divisor = Math.max(1, totalCandidates - positionInBatch);
                    }
                    long perCandidateBudgetMs = remainingMs > 0L ? remainingMs / divisor : 0L;
                    overrides.putAll(buildControlledLnsOverrides(perCandidateBudgetMs, staticGroupBudgetMs));
                }
                if (!overrides.isEmpty()) {
                    conversion = SolverRuntimeProperties.withOverrides(
                            overrides,
                            () -> converter.convertWithoutSetPartition(
                                    task.candidate().result().getSolution(),
                                    groupKey,
                                    groupItems,
                                    demands));
                } else {
                    conversion = converter.convertWithoutSetPartition(
                            task.candidate().result().getSolution(),
                            groupKey,
                            groupItems,
                            demands);
                }
            } catch (RuntimeException qualityFailure) {
                if (fastBaseline != null && !fastBaseline.instructions().isEmpty()) {
                    log.warn("Quality conversion failed for {}; fast baseline remains active",
                            task.candidate().name(), qualityFailure);
                    return new CandidateEvaluation(
                            task.order(), task.candidate(), fastBaseline);
                }
                throw qualityFailure;
            }
            if (qualityMode() && fastBaseline != null && !fastBaseline.instructions().isEmpty()) {
                conversion = selectQualityOrFastBaseline(
                        task.candidate().result(), conversion, fastBaseline, task.order());
            }
            if (conversion.instructions().isEmpty()) {
                return null;
            }
            return new CandidateEvaluation(task.order(), task.candidate(), conversion);
        } catch (RuntimeException e) {
            log.warn("Candidate {} conversion failed; remaining candidates continue",
                    task.candidate().name(), e);
            return null;
        }
    }

    private CandidateEvaluation refineCandidate(
            CandidateEvaluation evaluation,
            SolverParameters params,
            boolean outerParallel) {
        try {
            InstructionConverter converter = new InstructionConverter(params);
            InstructionConverter.ConversionResult refined = outerParallel
                    ? SolverRuntimeProperties.withOverrides(
                            Map.of("cutting.spr.parallel", "false"),
                            () -> converter.refineWithSetPartition(evaluation.conversion()))
                    : converter.refineWithSetPartition(evaluation.conversion());
            InstructionConverter.ConversionResult selected = selectQualityOrFastBaseline(
                    evaluation.candidate().result(), refined,
                    evaluation.conversion(), evaluation.order());
            return new CandidateEvaluation(
                    evaluation.order(), evaluation.candidate(), selected);
        } catch (RuntimeException e) {
            log.warn("SPR candidate {} failed; base result remains active",
                    evaluation.candidate().name(), e);
            return evaluation;
        }
    }

    static boolean isSprShortlisted(int groups, int bestGroups, int gap) {
        return groups - bestGroups <= Math.max(0, gap);
    }

    SolverTaskExecutor createTaskExecutor(
            String scope,
            String enabledProperty,
            String threadsProperty,
            int taskCount) {
        boolean enabled = SolverRuntimeProperties.getBoolean(enabledProperty, true);
        if (!enabled || taskCount <= 1 || SolverRunColumnArchive.isCaptureActive()) {
            return new DirectSolverTaskExecutor();
        }
        int requestedThreads = SolverRuntimeProperties.getInt(
                threadsProperty, BoundedSolverTaskExecutor.globalParallelism());
        if (requestedThreads <= 1 || BoundedSolverTaskExecutor.globalParallelism() <= 1) {
            return new DirectSolverTaskExecutor();
        }
        return BoundedSolverTaskExecutor.create(scope, requestedThreads);
    }

    private void logParallelStage(String stage, SolverTaskExecutor executor, int taskCount) {
        log.info("{} execution: tasks={}, parallelism={}",
                stage, taskCount, executor.parallelism(taskCount));
    }

    private Set<Integer> buildAllowOverSet(Map<Integer, Integer> demands, SolverParameters params) {
        List<Map.Entry<Integer, Integer>> sorted = demands.entrySet().stream()
                .sorted((a, b) -> Integer.compare(b.getValue(), a.getValue()))
                .collect(Collectors.toList());

        Set<Integer> allowOverSet = new HashSet<>();
        for (int i = 0; i < Math.min(params.getTopK(), sorted.size()); i++) {
            allowOverSet.add(sorted.get(i).getKey());
        }
        allowOverSet.addAll(params.getForceAllowOverWidths());
        return allowOverSet;
    }

    /**
     * Deterministic demand orderings for multi-start. Each ordering only changes the
     * MIP variable-creation order, yielding a different (but reproducible) pattern set.
     */
    private List<Map<Integer, Integer>> buildDemandOrders(Map<Integer, Integer> demands) {
        List<Map.Entry<Integer, Integer>> entries = new ArrayList<>(demands.entrySet());
        List<Map<Integer, Integer>> orders = new ArrayList<>();
        // order 0: width-ascending. On the real four-line case this single order is
        // the winner (o0 reached 47, beating o1/o2/o3 at 50/52/52). Production runs
        // this ONE path: the other three cost ~13 min of B-layer LNS for a strictly
        // worse result, which is unusable in production.
        orders.add(toOrderedMap(entries, Comparator.comparingInt(Map.Entry::getKey)));
        if (candidateOrderCount() <= 1) {
            return orders;
        }
        // The remaining orders are an offline multi-start dimension only; restore the
        // full 4-candidate sweep with -Dcutting.candidateOrders=4.
        orders.add(toOrderedMap(entries, Comparator
                .comparingInt((Map.Entry<Integer, Integer> e) -> e.getValue()).reversed()
                .thenComparingInt(Map.Entry::getKey)));
        orders.add(toOrderedMap(entries, Comparator
                .comparingInt((Map.Entry<Integer, Integer> e) -> e.getKey()).reversed()));
        orders.add(toOrderedMap(entries, Comparator
                .comparingInt((Map.Entry<Integer, Integer> e) -> e.getValue())
                .thenComparingInt(Map.Entry::getKey)));
        int wanted = Math.min(candidateOrderCount(), orders.size());
        return new ArrayList<>(orders.subList(0, wanted));
    }

    /** Number of demand-order candidates to run. Default 1 (single fast path). */
    private int candidateOrderCount() {
        String raw = SolverRuntimeProperties.get("cutting.candidateOrders");
        if (raw != null && !raw.isBlank()) {
            try {
                return Math.max(1, Integer.parseInt(raw.trim()));
            } catch (NumberFormatException ignored) {
                // fall through to default
            }
        }
        return 1;
    }

    /**
     * 质量模式总开关（-Dcutting.quality=true 或 API lnsQuality）。展开为：
     * A层 parity 扫描 {0, 0.1} + B层双 LNS 变体（默认邻域 vs 扩大邻域）评优。
     * 依据（笔记13终局）：parity0.1 在 sixian 上给出 46大组 但在 t9est188 上 72→94
     * ——数据集脆弱，绝不能单独当默认；唯一稳健编排是多候选全评估后由
     * isBetterPlan（车数→组→odd→1车→small）拣优，结构上永不劣于单路径。
     */
    public static boolean qualityMode() {
        return SolverRuntimeProperties.getBoolean("cutting.quality", false);
    }

    static boolean completePatternQualityEnabled() {
        return qualityMode() && SolverRuntimeProperties.getBoolean(
                "cutting.completePatterns.enabled", false);
    }

    static int completePatternMaxDistinctWidths() {
        return Math.max(1, SolverRuntimeProperties.getInt(
                "cutting.completePatterns.maxDistinctWidths", 5));
    }

    private List<PatternCandidate> buildQualityPatternPool(
            List<PatternCandidate> baselinePatterns,
            Map<Integer, Integer> demands,
            SolverParameters params) {
        if (!completePatternQualityEnabled()) {
            return baselinePatterns;
        }

        long startedAt = System.currentTimeMillis();
        List<PatternCandidate> completePatterns = new CompletePatternEnumerator(
                params, completePatternMaxDistinctWidths()).generate(demands);
        Map<String, PatternCandidate> merged = new TreeMap<>();
        for (PatternCandidate pattern : baselinePatterns) {
            merged.putIfAbsent(pattern.signature(), pattern);
        }
        for (PatternCandidate pattern : completePatterns) {
            merged.putIfAbsent(pattern.signature(), pattern);
        }
        List<PatternCandidate> qualityPatterns = new ArrayList<>(merged.values());
        log.info("Complete-pattern quality pool enabled: baseline={}, complete={}, merged={}, elapsedMs={}",
                baselinePatterns.size(),
                completePatterns.size(),
                qualityPatterns.size(),
                System.currentTimeMillis() - startedAt);
        return qualityPatterns;
    }

    public static boolean fastPreviewMode() {
        return SolverRuntimeProperties.getBoolean("cutting.fast.preview", false);
    }

    private static long fastBudgetMs() {
        return Math.max(1_000L, SolverRuntimeProperties.getLong(
                "cutting.fast.budgetMs", 10_000L));
    }

    private static long qualityBudgetMs() {
        return SolverRuntimeProperties.getLong("cutting.quality.budgetMs", 0L);
    }

    private long allocateALayerDeadline(long requestDeadlineMs, int groupsRemaining) {
        if (requestDeadlineMs == Long.MAX_VALUE) {
            return Long.MAX_VALUE;
        }
        long now = System.currentTimeMillis();
        long remainingMs = Math.max(1_000L, requestDeadlineMs - now);
        return now + Math.max(1_000L, remainingMs / Math.max(1, groupsRemaining));
    }

    private long allocateGroupDeadline(long qualityDeadlineMs, int groupsRemaining) {
        if (qualityDeadlineMs == Long.MAX_VALUE) {
            return Long.MAX_VALUE;
        }
        long now = System.currentTimeMillis();
        long remainingMs = Math.max(1_000L, qualityDeadlineMs - now);
        return now + Math.max(1_000L, remainingMs / Math.max(1, groupsRemaining));
    }

    private long allocateQualityALayerDeadline(long groupDeadlineMs) {
        if (groupDeadlineMs == Long.MAX_VALUE) {
            return Long.MAX_VALUE;
        }
        long now = System.currentTimeMillis();
        long remainingMs = Math.max(1_000L, groupDeadlineMs - now);
        return now + Math.max(2_000L, remainingMs * 55 / 100);
    }

    /**
     * 按剩余时间预算为精修模式动态构造确定性受控 LNS 参数（节点上限、迭代数、早停步数、墙钟安全帽）。
     * 若调用方显式禁用了 LNS，则不重新开启；若剩余预算不足 3s，则自动跳过 LNS 保底零超时。
     */
    static Map<String, String> buildControlledLnsOverrides(long remainingBudgetMs) {
        return buildControlledLnsOverrides(remainingBudgetMs, remainingBudgetMs);
    }

    /**
     * 档位参数（节点上限/最大迭代/无改进早停）由静态总预算 {@code tierBudgetMs} 决定，
     * 避免前序阶段墙钟快慢或单/多核并发差异引起参数漂移；{@code remainingBudgetMs} 仅作为墙钟安全帽。
     */
    static Map<String, String> buildControlledLnsOverrides(long remainingBudgetMs, long tierBudgetMs) {
        Map<String, String> overrides = new HashMap<>();
        String explicitEnabled = SolverRuntimeProperties.get("cutting.lns.enabled");
        if (explicitEnabled != null && !explicitEnabled.isBlank() && !Boolean.parseBoolean(explicitEnabled.trim())) {
            return overrides;
        }
        if (remainingBudgetMs < 3_000L) {
            overrides.put("cutting.lns.enabled", "false");
            return overrides;
        }
        overrides.put("cutting.lns.enabled", "true");
        overrides.put("cutting.lns.budgetMs", Long.toString(remainingBudgetMs));

        long effectiveTierBudgetMs = tierBudgetMs != Long.MAX_VALUE ? tierBudgetMs : remainingBudgetMs;
        long nodeLimit;
        int maxIterations;
        int maxNoImprove;
        if (effectiveTierBudgetMs >= 35_000L) {
            nodeLimit = 5_000L;
            maxIterations = 24;
            maxNoImprove = 5;
        } else if (effectiveTierBudgetMs >= 15_000L) {
            nodeLimit = 3_000L;
            maxIterations = 16;
            maxNoImprove = 4;
        } else {
            nodeLimit = 1_500L;
            maxIterations = 10;
            maxNoImprove = 3;
        }
        if (SolverRuntimeProperties.get("cutting.lns.scipNodeLimit") == null) {
            overrides.put("cutting.lns.scipNodeLimit", Long.toString(nodeLimit));
        }
        if (SolverRuntimeProperties.get("cutting.lns.maxIterations") == null) {
            overrides.put("cutting.lns.maxIterations", Integer.toString(maxIterations));
        }
        if (SolverRuntimeProperties.get("cutting.lns.maxNoImprove") == null) {
            overrides.put("cutting.lns.maxNoImprove", Integer.toString(maxNoImprove));
        }
        return overrides;
    }

    static int nestedWidthCandidateCap(SolverParameters params) {
        String configuredSteps = SolverRuntimeProperties.get("cutting.nestedWidthCandidateSteps");
        int stepSize = Math.max(1, params.getStepSize());
        int defaultSteps = qualityMode()
                && Math.floorMod(params.getMaxRollWidth(), 100) == stepSize
                ? 1
                : 0;
        int steps = configuredSteps == null || configuredSteps.isBlank()
                ? defaultSteps
                : Math.max(0, SolverRuntimeProperties.getInt(
                        "cutting.nestedWidthCandidateSteps", defaultSteps));
        return steps == 0
                ? -1
                : params.getMaxRollWidth() - steps * stepSize;
    }

    /**
     * A-layer parity 惩罚扫描列表。默认 {0}（不生效）；质量模式默认 {0, 0.1}；
     * -Dcutting.aLayerParityPenalties=0,0.1,0.2 显式覆盖。
     */
    static double[] aLayerParityPenalties() {
        String raw = SolverRuntimeProperties.get("cutting.aLayerParityPenalties");
        if (raw == null || raw.isBlank()) {
            return qualityMode() ? new double[] {0.0, 0.1} : new double[] {0.0};
        }
        LinkedHashSet<Double> values = new LinkedHashSet<>();
        for (String part : raw.split(",")) {
            String trimmed = part.trim();
            if (trimmed.isEmpty()) {
                continue;
            }
            try {
                double value = Double.parseDouble(trimmed);
                if (!Double.isNaN(value) && value >= 0.0) {
                    values.add(value);
                }
            } catch (NumberFormatException ignored) {
                // Skip bad tokens and keep the rest of the sweep usable.
            }
        }
        if (values.isEmpty()) {
            values.add(0.0);
        }
        double[] result = new double[values.size()];
        int i = 0;
        for (double value : values) {
            result[i++] = value;
        }
        return result;
    }

    /** A-layer alignment lambda sweep. Include 0.0 as the no-alignment baseline. */
    private double[] aLayerAlignmentLambdas() {
        String raw = SolverRuntimeProperties.get("cutting.aLayerAlignmentLambdas", "0");
        LinkedHashSet<Double> values = new LinkedHashSet<>();
        for (String part : raw.split(",")) {
            String trimmed = part.trim();
            if (trimmed.isEmpty()) {
                continue;
            }
            try {
                double value = Double.parseDouble(trimmed);
                if (!Double.isNaN(value) && value >= 0.0) {
                    values.add(value);
                }
            } catch (NumberFormatException ignored) {
                // Skip bad tokens and keep the rest of the sweep usable.
            }
        }
        if (values.isEmpty()) {
            values.add(0.0);
        }
        double[] result = new double[values.size()];
        int i = 0;
        for (double value : values) {
            result[i++] = value;
        }
        return result;
    }

    private String formatLambda(double value) {
        if (Math.rint(value) == value) {
            return Long.toString(Math.round(value));
        }
        return Double.toString(value).replace('.', 'p');
    }

    private Map<Integer, Integer> toOrderedMap(List<Map.Entry<Integer, Integer>> entries,
            Comparator<Map.Entry<Integer, Integer>> comparator) {
        Map<Integer, Integer> ordered = new LinkedHashMap<>();
        entries.stream().sorted(comparator).forEach(e -> ordered.put(e.getKey(), e.getValue()));
        return ordered;
    }

    private String solutionSignature(Map<PatternCandidate, Integer> solution) {
        return solution.entrySet().stream()
                .map(e -> e.getKey().signature() + "x" + e.getValue())
                .sorted()
                .collect(Collectors.joining("|"));
    }

    private void printSolutionSummary(SolverResult result, Map<Integer, Integer> demands) {
        log.info("Solution summary:");
        log.info("  Total rolls: {}", result.getTotalRolls());
        log.info("  Pattern count: {}", result.getPatternCount());
        log.info("  Total waste: {}mm", result.getTotalWaste());
        log.info("  Total over: {}", result.getTotalOverProduction());

        Map<Integer, Integer> production = new HashMap<>();
        for (Map.Entry<PatternCandidate, Integer> e : result.getSolution().entrySet()) {
            for (Map.Entry<Integer, Integer> pe : e.getKey().getPattern().entrySet()) {
                production.merge(pe.getKey(), pe.getValue() * e.getValue(), Integer::sum);
            }
        }

        for (int w : demands.keySet().stream().sorted().collect(Collectors.toList())) {
            int demand = demands.get(w);
            int prod = production.getOrDefault(w, 0);
            String status = prod == demand ? "[exact]"
                    : (prod > demand ? "[over+" + (prod - demand) + "]" : "[under" + (prod - demand) + "]");
            log.info("    {}mm: demand={} produced={} {}", w, demand, prod, status);
        }
    }

    public SolverParameters getParameters() {
        return baseParams.copy();
    }

    private boolean isBetterPlan(GroupSolvePlan candidate, GroupSolvePlan currentBest) {
        return PLAN_SELECTOR.isBetter(
                toPlanQuality(candidate), toPlanQuality(currentBest));
    }

    private PlanQuality toPlanQuality(GroupSolvePlan plan) {
        return new PlanQuality(
                plan.result().getTotalOverProduction(),
                plan.result().getTotalRolls(),
                plan.sequenceGroupCount(),
                plan.oddCarGroups(),
                plan.oneCarGroups(),
                plan.smallCarGroups(),
                plan.result().getPatternCount(),
                plan.result().getTotalWaste(),
                plan.order());
    }

    private InstructionConverter.ConversionResult selectQualityOrFastBaseline(
            SolverResult result,
            InstructionConverter.ConversionResult quality,
            InstructionConverter.ConversionResult fast,
            int order) {
        if (quality == null || quality.instructions().isEmpty()) {
            return fast;
        }
        PlanQuality qualityScore = conversionQuality(result, quality, order * 2);
        PlanQuality fastScore = conversionQuality(result, fast, order * 2 + 1);
        boolean qualityWins = PLAN_SELECTOR.isBetter(qualityScore, fastScore);
        log.info("Quality baseline selection: fast={}/{}/{}/{} quality={}/{}/{}/{} -> {}",
                fastScore.sequenceGroups(), fastScore.oddCarGroups(),
                fastScore.oneCarGroups(), fastScore.smallCarGroups(),
                qualityScore.sequenceGroups(), qualityScore.oddCarGroups(),
                qualityScore.oneCarGroups(), qualityScore.smallCarGroups(),
                qualityWins ? quality.selectedName() : fast.selectedName());
        return qualityWins ? quality : fast;
    }

    private PlanQuality conversionQuality(
            SolverResult result,
            InstructionConverter.ConversionResult conversion,
            int sourceOrder) {
        SequenceGroupPostProcessor.GroupStats stats =
                SequenceGroupPostProcessor.computeGroupStats(conversion.instructions());
        return new PlanQuality(
                result.getTotalOverProduction(),
                result.getTotalRolls(),
                stats.groups(),
                stats.oddCarGroups(),
                stats.oneCarGroups(),
                stats.smallCarGroups(),
                result.getPatternCount(),
                result.getTotalWaste(),
                sourceOrder);
    }

    record ALayerTask(
            String namePrefix,
            List<PatternCandidate> patterns,
            Map<Integer, Integer> demands,
            Set<Integer> allowOverWidths,
            int seed,
            double alignmentLambda,
            double parityPenalty,
            PatternAlignmentContext alignmentContext,
            boolean fastBaselineCandidate) {

        ALayerTask {
            patterns = List.copyOf(patterns);
            demands = Collections.unmodifiableMap(new LinkedHashMap<>(demands));
            allowOverWidths = Set.copyOf(allowOverWidths);
        }
    }

    private record CandidateTask(
            int order,
            MultiStageMIPSolver.SolveCandidate candidate) {
    }

    private record IndexedCandidateTask(
            int position,
            CandidateTask task) {
    }

    private record CandidateEvaluation(
            int order,
            MultiStageMIPSolver.SolveCandidate candidate,
            InstructionConverter.ConversionResult conversion) {
    }

    private record GroupSolvePlan(
            String name,
            SolverResult result,
            List<CuttingInstruction> instructions,
            int sequenceGroupCount,
            int oddCarGroups,
            int oneCarGroups,
            int smallCarGroups,
            String sequenceCandidateName,
            int order) {
    }

}
