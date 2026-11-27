package changyang.cut.apsmodule.generator.NewSolver;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import changyang.cut.apsmodule.generator.NewSolver.BLayerCandidateEvaluator.CandidateEvaluation;
import changyang.cut.apsmodule.generator.NewSolver.BLayerCandidateEvaluator.GroupSolvePlan;
import changyang.cut.apsmodule.generator.NewSolver.colgen.ColumnGenerationSolver;
import changyang.cut.apsmodule.generator.NewSolver.config.OrToolsNativeLoader;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverParameters;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverRuntimeProperties;
import changyang.cut.apsmodule.generator.NewSolver.mip.MultiStageMIPSolver;
import changyang.cut.apsmodule.generator.NewSolver.mip.PatternAlignmentContext;
import changyang.cut.apsmodule.generator.NewSolver.model.PatternCandidate;
import changyang.cut.apsmodule.generator.NewSolver.pattern.PatternGenerator;
import changyang.cut.apsmodule.generator.NewSolver.report.SolveReportWriter;
import changyang.cut.apsmodule.service.CuttingInstruction;
import changyang.cut.apsmodule.service.SolverConfig;
import changyang.cut.apsmodule.service.SolverOrderItem;
import changyang.cut.apsmodule.solver.CuttingSolverAlgorithm;
import changyang.cut.apsmodule.solver.kernel.execution.SolverTaskExecutor;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Collectors;

/**
 * NewSolver unified entry.
 */
@Component("cuttingSolver")
public class CuttingSolver implements CuttingSolverAlgorithm {

    private static final Logger log = LoggerFactory.getLogger(CuttingSolver.class);

    // Baseline defaults only; each solve call uses a per-request copy.
    private final SolverParameters baseParams;
    private final BLayerCandidateEvaluator bLayerEvaluator = new BLayerCandidateEvaluator();
    private final ALayerSearchCoordinator aLayerCoordinator =
            new ALayerSearchCoordinator(bLayerEvaluator);

    public CuttingSolver() {
        this(SolverParameters.createDefault());
    }

    public CuttingSolver(SolverParameters params) {
        this.baseParams = (params == null ? SolverParameters.createDefault() : params.copy());
        this.baseParams.sanitize();
        OrToolsNativeLoader.ensureLoaded();
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

        PatternGenerator patternGenerator = new PatternGenerator(params);
        ColumnGenerationSolver colGenSolver = new ColumnGenerationSolver(params);
        Map<String, List<SolverOrderItem>> groups = items.stream()
                .collect(Collectors.groupingBy(
                        SolverOrderItem::getGroupKey,
                        TreeMap::new,
                        Collectors.toList()));
        long fastBudget = fastBudgetMs();
        long fastDeadlineMs = fastPreviewMode()
                ? startTime + fastBudget
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

                Map<Integer, Integer> demands = new TreeMap<>();
                for (SolverOrderItem item : groupItems) {
                    demands.merge(item.getWidth(), item.getDemand(), Integer::sum);
                }

                Set<Integer> allowOverSet = aLayerCoordinator.buildAllowOverSet(demands, params);
                PatternAlignmentContext alignmentContext = PatternAlignmentContext.from(groupItems);
                report.beginGroup(groupKey, groupItems, demands, allowOverSet, totalGroups);
                log.debug("Allow-over widths: {}", allowOverSet);

                long colGenStart = System.currentTimeMillis();
                List<PatternCandidate> patterns = patternGenerator.generate(demands);
                patterns = colGenSolver.solve(patterns, demands, allowOverSet);
                List<PatternCandidate> qualityPatterns = aLayerCoordinator.buildQualityPatternPool(
                        patterns, demands, params);
                long colGenElapsedMs = System.currentTimeMillis() - colGenStart;

                long[] baselineElapsed = new long[1];
                long[] aLayerTasksElapsed = new long[1];
                List<MultiStageMIPSolver.SolveCandidate> solveCandidates =
                        aLayerCoordinator.searchCandidates(
                                patterns, qualityPatterns, demands, allowOverSet, alignmentContext,
                                params, aLayerDeadlineMs, fastBudget,
                                fastPreviewMode(), qualityMode(),
                                baselineElapsed, aLayerTasksElapsed);
                if (solveCandidates.isEmpty()) {
                    log.warn("Solve failed for group: {}", groupKey);
                    report.writeGroupFailure(
                            groupKey,
                            "pattern selection returned no candidates",
                            System.currentTimeMillis() - groupStart);
                    continue;
                }

                long bLayerStart = System.currentTimeMillis();
                long staticGroupBudgetMs = qualityMode() && qualityBudget > 0L
                        ? Math.max(1_000L, qualityBudget / Math.max(1, totalGroups))
                        : Long.MAX_VALUE;
                List<SolveReportWriter.CandidateRow> reportRows = new ArrayList<>();
                List<SolveReportWriter.SequenceCandidateRow> sequenceReportRows = new ArrayList<>();
                List<CandidateEvaluation> candidateEvaluations = bLayerEvaluator.evaluateCandidates(
                        solveCandidates, groupKey, groupItems, demands, params,
                        groupDeadlineMs, staticGroupBudgetMs);
                long bLayerElapsedMs = System.currentTimeMillis() - bLayerStart;
                log.info("Group {} stage timings: colGen={}ms, aLayerBaseline={}ms, aLayerTasks={}ms, bLayer={}ms, distinctCandidates={}",
                        groupKey, colGenElapsedMs, baselineElapsed[0], aLayerTasksElapsed[0],
                        bLayerElapsedMs, solveCandidates.size());

                GroupSolvePlan bestPlan = bLayerEvaluator.selectBestGroupPlan(
                        candidateEvaluations, demands, params, reportRows, sequenceReportRows);

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
        return ALayerSearchCoordinator.canReuseBaselineStage3(task, baselineTask, baseline);
    }

    static List<MultiStageMIPSolver.SolveCandidate> pruneDominatedCandidates(
            List<MultiStageMIPSolver.SolveCandidate> candidates) {
        return BLayerCandidateEvaluator.pruneDominatedCandidates(candidates);
    }

    static boolean isSprShortlisted(int groups, int bestGroups, int gap) {
        return BLayerCandidateEvaluator.isSprShortlisted(groups, bestGroups, gap);
    }

    SolverTaskExecutor createTaskExecutor(
            String scope,
            String enabledProperty,
            String threadsProperty,
            int taskCount) {
        return bLayerEvaluator.createTaskExecutor(scope, enabledProperty, threadsProperty, taskCount);
    }

    public static boolean qualityMode() {
        return SolverRuntimeProperties.isQualityMode();
    }

    static boolean completePatternQualityEnabled() {
        return ALayerSearchCoordinator.completePatternQualityEnabled();
    }

    static int completePatternMaxDistinctWidths() {
        return ALayerSearchCoordinator.completePatternMaxDistinctWidths();
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

    static Map<String, String> buildControlledLnsOverrides(long remainingBudgetMs) {
        return BLayerCandidateEvaluator.buildControlledLnsOverrides(remainingBudgetMs);
    }

    static Map<String, String> buildControlledLnsOverrides(long remainingBudgetMs, long tierBudgetMs) {
        return BLayerCandidateEvaluator.buildControlledLnsOverrides(remainingBudgetMs, tierBudgetMs);
    }

    static int nestedWidthCandidateCap(SolverParameters params) {
        return ALayerSearchCoordinator.nestedWidthCandidateCap(params);
    }

    static double[] aLayerParityPenalties() {
        return ALayerSearchCoordinator.aLayerParityPenalties();
    }

    public SolverParameters getParameters() {
        return baseParams.copy();
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
}
