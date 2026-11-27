package changyang.cut.apsmodule.generator.NewSolver;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverParameters;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverRuntimeProperties;
import changyang.cut.apsmodule.generator.NewSolver.mip.MultiStageMIPSolver;
import changyang.cut.apsmodule.generator.NewSolver.model.PatternCandidate;
import changyang.cut.apsmodule.generator.NewSolver.model.SolverResult;
import changyang.cut.apsmodule.generator.NewSolver.output.InstructionConverter;
import changyang.cut.apsmodule.generator.NewSolver.output.SequenceGroupPostProcessor;
import changyang.cut.apsmodule.generator.NewSolver.output.SetPartitionRefiner;
import changyang.cut.apsmodule.generator.NewSolver.output.SolverRunColumnArchive;
import changyang.cut.apsmodule.generator.NewSolver.report.SolveReportWriter;
import changyang.cut.apsmodule.service.CuttingInstruction;
import changyang.cut.apsmodule.service.SolverOrderItem;
import changyang.cut.apsmodule.solver.kernel.DeterministicPlanSelector;
import changyang.cut.apsmodule.solver.kernel.PlanQuality;
import changyang.cut.apsmodule.solver.kernel.execution.BoundedSolverTaskExecutor;
import changyang.cut.apsmodule.solver.kernel.execution.DirectSolverTaskExecutor;
import changyang.cut.apsmodule.solver.kernel.execution.SolverTaskExecutor;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * CuttingSolver 的 B 层候选支配剪枝、并行评估、SPR 短名单精修与方案择优器。
 */
final class BLayerCandidateEvaluator {

    private static final Logger log = LoggerFactory.getLogger(BLayerCandidateEvaluator.class);
    private static final DeterministicPlanSelector PLAN_SELECTOR = new DeterministicPlanSelector();

    record CandidateTask(
            int order,
            MultiStageMIPSolver.SolveCandidate candidate) {
    }

    record IndexedCandidateTask(
            int position,
            CandidateTask task) {
    }

    record CandidateEvaluation(
            int order,
            MultiStageMIPSolver.SolveCandidate candidate,
            InstructionConverter.ConversionResult conversion) {
    }

    record GroupSolvePlan(
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

    BLayerCandidateEvaluator() {
    }

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

    GroupSolvePlan selectBestGroupPlan(
            List<CandidateEvaluation> candidateEvaluations,
            Map<Integer, Integer> demands,
            SolverParameters params,
            List<SolveReportWriter.CandidateRow> reportRows,
            List<SolveReportWriter.SequenceCandidateRow> sequenceReportRows) {
        GroupSolvePlan bestPlan = null;
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
        return bestPlan;
    }

    List<CandidateEvaluation> evaluateCandidates(
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

        if (!SolverRuntimeProperties.isQualityMode()
                || !SetPartitionRefiner.isEnabled()
                || baseEvaluations.isEmpty()) {
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
            logParallelStage(SolverRuntimeProperties.getBoolean("cutting.fast.preview", false)
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
        boolean fastPreview = SolverRuntimeProperties.getBoolean("cutting.fast.preview", false);
        boolean quality = SolverRuntimeProperties.isQualityMode();
        try {
            InstructionConverter converter = new InstructionConverter(params);
            InstructionConverter.ConversionResult fastBaseline = null;
            if (fastPreview || quality) {
                fastBaseline = converter.convertFastPreview(
                        task.candidate().result().getSolution(),
                        groupKey,
                        groupItems,
                        demands);
                if (fastPreview) {
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
                if (quality && groupDeadlineMs != Long.MAX_VALUE) {
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
            if (quality && fastBaseline != null && !fastBaseline.instructions().isEmpty()) {
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

    void logParallelStage(String stage, SolverTaskExecutor executor, int taskCount) {
        log.info("{} execution: tasks={}, parallelism={}",
                stage, taskCount, executor.parallelism(taskCount));
    }

    static Map<String, String> buildControlledLnsOverrides(long remainingBudgetMs) {
        return buildControlledLnsOverrides(remainingBudgetMs, remainingBudgetMs);
    }

    static Map<String, String> buildControlledLnsOverrides(long remainingBudgetMs, long tierBudgetMs) {
        Map<String, String> overrides = new HashMap<>();
        String explicitEnabled = SolverRuntimeProperties.get("cutting.lns.enabled");
        if (explicitEnabled != null && !explicitEnabled.isBlank()
                && !Boolean.parseBoolean(explicitEnabled.trim())) {
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
}
