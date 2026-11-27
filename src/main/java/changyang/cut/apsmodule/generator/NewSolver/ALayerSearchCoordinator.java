package changyang.cut.apsmodule.generator.NewSolver;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import changyang.cut.apsmodule.generator.NewSolver.CuttingSolver.ALayerTask;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverParameters;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverRuntimeProperties;
import changyang.cut.apsmodule.generator.NewSolver.mip.MultiStageMIPSolver;
import changyang.cut.apsmodule.generator.NewSolver.mip.PatternAlignmentContext;
import changyang.cut.apsmodule.generator.NewSolver.model.PatternCandidate;
import changyang.cut.apsmodule.generator.NewSolver.pattern.CompletePatternEnumerator;
import changyang.cut.apsmodule.solver.kernel.execution.SolverTaskExecutor;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Collectors;

/**
 * CuttingSolver 的 A 层多起始花型筛选任务构造与并行协调器。
 */
final class ALayerSearchCoordinator {

    private static final Logger log = LoggerFactory.getLogger(ALayerSearchCoordinator.class);
    static final int[] A_LAYER_SEEDS = {1};

    private final BLayerCandidateEvaluator bLayerEvaluator;

    ALayerSearchCoordinator(BLayerCandidateEvaluator bLayerEvaluator) {
        this.bLayerEvaluator = bLayerEvaluator;
    }

    List<MultiStageMIPSolver.SolveCandidate> searchCandidates(
            List<PatternCandidate> patterns,
            List<PatternCandidate> qualityPatterns,
            Map<Integer, Integer> demands,
            Set<Integer> allowOverSet,
            PatternAlignmentContext alignmentContext,
            SolverParameters params,
            long aLayerDeadlineMs,
            long fastBudgetMs,
            boolean fastPreview,
            boolean quality,
            long[] baselineElapsedOut,
            long[] aLayerTasksElapsedOut) {
        List<Map<Integer, Integer>> demandOrders = buildDemandOrders(demands);
        List<ALayerTask> aLayerTasks = buildALayerTasks(
                patterns, demandOrders, allowOverSet, alignmentContext, params, fastPreview);

        List<MultiStageMIPSolver.SolveCandidate> rawCandidates = new ArrayList<>();
        ALayerTask baselineTask = null;
        MultiStageMIPSolver.SolveCandidate baseline = null;
        long baselineStart = System.currentTimeMillis();
        if (fastPreview || quality) {
            baselineTask = new ALayerTask(
                    "fast-baseline-", patterns, demandOrders.get(0), allowOverSet,
                    A_LAYER_SEEDS[0], 0.0, 0.0, alignmentContext, true);
            baseline = solveALayerTask(baselineTask, params, aLayerDeadlineMs, fastBudgetMs);
            if (baseline != null) {
                rawCandidates.add(baseline);
                log.info("FAST baseline established before quality search: {}", baseline.name());
            } else {
                log.warn("FAST baseline could not be established; quality candidates continue");
            }
        }
        baselineElapsedOut[0] = System.currentTimeMillis() - baselineStart;

        long aLayerTasksStart = System.currentTimeMillis();
        if (!aLayerTasks.isEmpty()) {
            try (SolverTaskExecutor executor = bLayerEvaluator.createTaskExecutor(
                    "a-layer", "cutting.parallel.aLayer.enabled",
                    "cutting.parallel.aLayer.threads", aLayerTasks.size())) {
                bLayerEvaluator.logParallelStage("A-layer quality search", executor, aLayerTasks.size());
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
                                    return solveALayerTask(task, params, aLayerDeadlineMs, fastBudgetMs);
                                }).stream()
                        .filter(Objects::nonNull)
                        .toList());
            }
        }
        aLayerTasksElapsedOut[0] = System.currentTimeMillis() - aLayerTasksStart;
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

        List<MultiStageMIPSolver.SolveCandidate> solveCandidates = new ArrayList<>();
        Set<String> seenCandidateSigs = new HashSet<>();
        for (MultiStageMIPSolver.SolveCandidate candidate : rawCandidates) {
            String sig = solutionSignature(candidate.result().getSolution());
            if (seenCandidateSigs.add(sig)) {
                solveCandidates.add(candidate);
            }
        }
        return solveCandidates;
    }

    private List<ALayerTask> buildALayerTasks(
            List<PatternCandidate> patterns,
            List<Map<Integer, Integer>> demandOrders,
            Set<Integer> allowOverSet,
            PatternAlignmentContext alignmentContext,
            SolverParameters params,
            boolean fastPreview) {
        List<ALayerTask> aLayerTasks = new ArrayList<>();
        if (fastPreview) {
            return aLayerTasks;
        }
        double[] alignmentLambdas = aLayerAlignmentLambdas();
        int nestedWidthCap = nestedWidthCandidateCap(params);
        for (int orderIdx = 0; orderIdx < demandOrders.size(); orderIdx++) {
            Map<Integer, Integer> orderedDemands = demandOrders.get(orderIdx);
            List<ALayerTask> orderTasks = new ArrayList<>();
            double[] parityPenalties = aLayerParityPenalties();
            for (int seed : A_LAYER_SEEDS) {
                for (double alignmentLambda : alignmentLambdas) {
                    for (double parityPenalty : parityPenalties) {
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
        return aLayerTasks;
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
            ALayerTask task, SolverParameters params, long deadlineMs, long fastBudgetMs) {
        try {
            SolverParameters taskParams = params.copy();
            if (deadlineMs != Long.MAX_VALUE) {
                long remainingMs = Math.max(500L, deadlineMs - System.currentTimeMillis());
                taskParams.setTimeoutMs(Math.min(taskParams.getTimeoutMs(), remainingMs));
            }
            if (task.fastBaselineCandidate()) {
                taskParams.setTimeoutMs(Math.min(taskParams.getTimeoutMs(), fastBudgetMs));
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

    Set<Integer> buildAllowOverSet(Map<Integer, Integer> demands, SolverParameters params) {
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

    private List<Map<Integer, Integer>> buildDemandOrders(Map<Integer, Integer> demands) {
        List<Map.Entry<Integer, Integer>> entries = new ArrayList<>(demands.entrySet());
        List<Map<Integer, Integer>> orders = new ArrayList<>();
        orders.add(toOrderedMap(entries, Comparator.comparingInt(Map.Entry::getKey)));
        if (candidateOrderCount() <= 1) {
            return orders;
        }
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

    private int candidateOrderCount() {
        String raw = SolverRuntimeProperties.get("cutting.candidateOrders");
        if (raw != null && !raw.isBlank()) {
            try {
                return Math.max(1, Integer.parseInt(raw.trim()));
            } catch (NumberFormatException ignored) {
            }
        }
        return 1;
    }

    static boolean completePatternQualityEnabled() {
        return SolverRuntimeProperties.isQualityMode()
                && SolverRuntimeProperties.getBoolean("cutting.completePatterns.enabled", false);
    }

    static int completePatternMaxDistinctWidths() {
        return Math.max(1, SolverRuntimeProperties.getInt(
                "cutting.completePatterns.maxDistinctWidths", 5));
    }

    List<PatternCandidate> buildQualityPatternPool(
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

    static int nestedWidthCandidateCap(SolverParameters params) {
        String configuredSteps = SolverRuntimeProperties.get("cutting.nestedWidthCandidateSteps");
        int stepSize = Math.max(1, params.getStepSize());
        int defaultSteps = SolverRuntimeProperties.isQualityMode()
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

    static double[] aLayerParityPenalties() {
        String raw = SolverRuntimeProperties.get("cutting.aLayerParityPenalties");
        if (raw == null || raw.isBlank()) {
            return SolverRuntimeProperties.isQualityMode()
                    ? new double[] {0.0, 0.1}
                    : new double[] {0.0};
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
}
