package changyang.cut.apsmodule.generator.NewSolver.output;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import changyang.cut.apsmodule.generator.NewSolver.config.OrToolsNativeLoader;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverParameters;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverRuntimeProperties;
import changyang.cut.apsmodule.generator.NewSolver.output.LnsDiagnostics.DiagnosticRow;
import changyang.cut.apsmodule.generator.NewSolver.output.LnsDiagnostics.Diagnostics;
import changyang.cut.apsmodule.generator.NewSolver.output.LnsModelAndInstructionSupport.Column;
import changyang.cut.apsmodule.generator.NewSolver.output.LnsModelAndInstructionSupport.Neighborhood;
import changyang.cut.apsmodule.generator.NewSolver.output.LnsModelAndInstructionSupport.PatternKey;
import changyang.cut.apsmodule.generator.NewSolver.output.LnsModelAndInstructionSupport.RollRecord;
import changyang.cut.apsmodule.generator.NewSolver.output.LnsModelAndInstructionSupport.SolveAttempt;
import changyang.cut.apsmodule.service.CuttingInstruction;
import changyang.cut.apsmodule.service.SolverOrderItem;
import changyang.cut.apsmodule.solver.kernel.execution.BoundedSolverTaskExecutor;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * Experimental local neighbourhood search for sequence-group reduction.
 *
 * <p>Disabled by default. Enable with {@code -Dcutting.lns.enabled=true}.
 * The first version keeps cars and waste fixed inside a closed neighbourhood and
 * solves a small set-partitioning model over full-roll configuration columns.
 */
public class LocalNeighborhoodSequenceOptimizer {

    private static final Logger log = LoggerFactory.getLogger(LocalNeighborhoodSequenceOptimizer.class);

    private static final int DEFAULT_MAX_ITERATIONS = 40;
    private static final int DEFAULT_MAX_NEIGHBORHOODS = 50;
    private static final long DEFAULT_POST_TIME_BUDGET_MS = 0L;

    private final LnsNeighborhoodBuilder neighborhoodBuilder;
    private final LnsSubproblemSolver subproblemSolver;
    private final Consumer<List<CuttingInstruction>> arranger;

    public LocalNeighborhoodSequenceOptimizer(SolverParameters params) {
        this(params, instructions -> { });
    }

    public LocalNeighborhoodSequenceOptimizer(SolverParameters params,
            Consumer<List<CuttingInstruction>> arranger) {
        this.neighborhoodBuilder = new LnsNeighborhoodBuilder(params);
        this.subproblemSolver = new LnsSubproblemSolver();
        this.arranger = arranger != null ? arranger : instructions -> { };
    }

    public static boolean isEnabled() {
        return SolverRuntimeProperties.getBoolean("cutting.lns.enabled", false);
    }

    public static boolean isEnabledExplicitlyConfigured() {
        String value = SolverRuntimeProperties.get("cutting.lns.enabled");
        return value != null && !value.isBlank();
    }

    public static <T> T withPropertyOverrides(Map<String, String> overrides, Supplier<T> supplier) {
        return SolverRuntimeProperties.withOverrides(overrides, supplier);
    }

    public LnsResult improve(List<CuttingInstruction> originalInstructions,
            List<SolverOrderItem> groupItems) {
        if (originalInstructions == null || originalInstructions.isEmpty()
                || groupItems == null || groupItems.isEmpty()) {
            return LnsResult.notImproved(originalInstructions, "empty-input");
        }
        if (!OrToolsNativeLoader.ensureLoaded("LNS")) {
            return LnsResult.notImproved(originalInstructions, "ortools-unavailable");
        }

        List<CuttingInstruction> current =
                LnsModelAndInstructionSupport.cloneInstructions(originalInstructions);
        arranger.accept(current);
        SequenceGroupPostProcessor.GroupStats originalStats =
                SequenceGroupPostProcessor.computeGroupStats(current);
        int originalGroups = originalStats.groups();
        int originalCars = LnsModelAndInstructionSupport.totalCars(current);
        int originalWaste = LnsModelAndInstructionSupport.totalWaste(current);
        Map<String, Integer> originalDemand =
                LnsModelAndInstructionSupport.countAssignmentsByDemandKey(current);

        int maxIterations = SolverRuntimeProperties.getInt(
                "cutting.lns.maxIterations", DEFAULT_MAX_ITERATIONS);
        int maxNeighborhoods = SolverRuntimeProperties.getInt(
                "cutting.lns.maxNeighborhoods", DEFAULT_MAX_NEIGHBORHOODS);
        boolean allowPlateau = SolverRuntimeProperties.getBoolean("cutting.lns.allowPlateau", true);
        boolean escape = SolverRuntimeProperties.getBoolean("cutting.lns.escape", true);
        int worseningTolerance = SolverRuntimeProperties.getInt(
                "cutting.lns.worseningTolerance", 2);
        long budgetMs = SolverRuntimeProperties.getLong("cutting.lns.budgetMs", 0L);
        long deadlineMs = budgetMs > 0L ? System.currentTimeMillis() + budgetMs : Long.MAX_VALUE;
        int maxNoImprove = SolverRuntimeProperties.getInt("cutting.lns.maxNoImprove", 12);
        int noImproveStreak = 0;
        boolean improved = false;
        String lastReason = "no-improving-neighborhood";
        Diagnostics diagnostics = Diagnostics.create();

        List<CuttingInstruction> bestEver = LnsModelAndInstructionSupport.cloneInstructions(current);
        SequenceGroupPostProcessor.GroupStats bestEverStats = originalStats;
        Set<String> visited = new HashSet<>();
        visited.add(LnsModelAndInstructionSupport.solutionSignature(current));
        Map<String, SolveAttempt> solveCache = new HashMap<>();

        boolean parallel = SolverRuntimeProperties.getBoolean("cutting.lns.parallel", true);
        int requestedParallelism = SolverRuntimeProperties.getInt(
                "cutting.lns.parallelism", BoundedSolverTaskExecutor.globalParallelism());
        BoundedSolverTaskExecutor executor = (parallel
                && requestedParallelism > 1
                && BoundedSolverTaskExecutor.globalParallelism() > 1)
                ? BoundedSolverTaskExecutor.create("lns", requestedParallelism)
                : null;
        if (executor != null) {
            log.info("LNS executor: requestThreads={}, globalThreads={}",
                    executor.configuredParallelism(), BoundedSolverTaskExecutor.globalParallelism());
        }
        try {
            for (int iteration = 0; iteration < maxIterations; iteration++) {
                if (System.currentTimeMillis() >= deadlineMs) {
                    lastReason = "budget-reached";
                    break;
                }
                long iterStartMs = System.currentTimeMillis();
                SequenceGroupPostProcessor.GroupStats beforeStats =
                        SequenceGroupPostProcessor.computeGroupStats(current);
                int beforeGroups = beforeStats.groups();
                int beforeFragmentation = LnsModelAndInstructionSupport.fragmentationScore(current);
                List<RollRecord> rolls = LnsModelAndInstructionSupport.decompose(current);
                List<Neighborhood> neighborhoods =
                        neighborhoodBuilder.buildNeighborhoods(rolls, maxNeighborhoods);
                long buildNbDoneMs = System.currentTimeMillis();
                MoveCandidate bestImprovement = null;
                MoveCandidate bestPlateau = null;
                MoveCandidate bestWorsening = null;

                List<String> cacheKeys = new ArrayList<>(neighborhoods.size());
                SolveAttempt[] resolvedAttempts = new SolveAttempt[neighborhoods.size()];
                List<Integer> uncachedIndexes = new ArrayList<>();
                List<Neighborhood> uncachedNeighborhoods = new ArrayList<>();
                for (int ni = 0; ni < neighborhoods.size(); ni++) {
                    Neighborhood neighborhood = neighborhoods.get(ni);
                    String cacheKey = neighborhoodCacheKey(neighborhood);
                    cacheKeys.add(cacheKey);
                    SolveAttempt cached = solveCache.get(cacheKey);
                    if (cached != null) {
                        resolvedAttempts[ni] = cached;
                    } else {
                        uncachedIndexes.add(ni);
                        uncachedNeighborhoods.add(neighborhood);
                    }
                }

                if (executor != null && !uncachedNeighborhoods.isEmpty()) {
                    final long iterDeadlineMs = deadlineMs;
                    List<SolveAttempt> solvedMisses = executor.mapOrdered(
                            uncachedNeighborhoods,
                            n -> subproblemSolver.solveNeighborhood(n, iterDeadlineMs));
                    for (int i = 0; i < uncachedIndexes.size(); i++) {
                        int ni = uncachedIndexes.get(i);
                        SolveAttempt attempt = solvedMisses.get(i);
                        resolvedAttempts[ni] = attempt;
                        if (!"budget-reached".equals(attempt.reason())) {
                            solveCache.put(cacheKeys.get(ni), attempt);
                        }
                    }
                }
                long solveDoneMs = System.currentTimeMillis();
                long maxSingleNbMs = 0L;
                int maxSingleNbCols = 0;
                int noOpSkipped = 0;
                for (SolveAttempt a : resolvedAttempts) {
                    if (a != null && a.elapsedMs() > maxSingleNbMs) {
                        maxSingleNbMs = a.elapsedMs();
                        maxSingleNbCols = a.columns().size();
                    }
                }

                for (int ni = 0; ni < neighborhoods.size(); ni++) {
                    Neighborhood neighborhood = neighborhoods.get(ni);
                    SolveAttempt attempt = resolvedAttempts[ni];
                    if (attempt == null) {
                        if (System.currentTimeMillis() >= deadlineMs) {
                            lastReason = "budget-reached";
                            break;
                        }
                        attempt = subproblemSolver.solveNeighborhood(neighborhood, deadlineMs);
                        if (!"budget-reached".equals(attempt.reason())) {
                            solveCache.put(cacheKeys.get(ni), attempt);
                        }
                    }
                    lastReason = attempt.reason();
                    int beforeProxy = subproblemSolver.currentActiveColumns(neighborhood);
                    if (!attempt.feasible()) {
                        diagnostics.record(new DiagnosticRow(
                                iteration, ni, neighborhood.seedKeys(),
                                neighborhood.freeDemand().size(), neighborhood.patterns().size(),
                                neighborhood.cars(), attempt.columns().size(),
                                beforeProxy, 0,
                                beforeStats.groups(), beforeStats.oddCarGroups(),
                                beforeStats.smallCarGroups(), beforeFragmentation,
                                beforeStats.groups(), beforeStats.oddCarGroups(),
                                beforeStats.smallCarGroups(), beforeFragmentation,
                                false, false, false, false, false, attempt.status()));
                        continue;
                    }

                    if (!diagnostics.enabled && isNoOpAttempt(neighborhood, attempt)) {
                        noOpSkipped++;
                        continue;
                    }

                    List<CuttingInstruction> candidate =
                            LnsModelAndInstructionSupport.rebuildWithNeighborhoodSolution(
                                    rolls, neighborhood, attempt);
                    arranger.accept(candidate);
                    int candidateCars = LnsModelAndInstructionSupport.totalCars(candidate);
                    int candidateWaste = LnsModelAndInstructionSupport.totalWaste(candidate);
                    Map<String, Integer> candidateDemand =
                            LnsModelAndInstructionSupport.countAssignmentsByDemandKey(candidate);
                    SequenceGroupPostProcessor.GroupStats afterStats =
                            SequenceGroupPostProcessor.computeGroupStats(candidate);
                    int afterFragmentation = LnsModelAndInstructionSupport.fragmentationScore(candidate);

                    if (candidateCars == originalCars
                            && candidateWaste == originalWaste
                            && originalDemand.equals(candidateDemand)) {
                        boolean promisingRaw = afterStats.oneCarGroups() < beforeStats.oneCarGroups()
                                || afterStats.groups() <= beforeGroups
                                || afterFragmentation < beforeFragmentation;
                        long postTimeBudgetMs = SolverRuntimeProperties.getLong(
                                "cutting.lns.postTimeBudgetMs", DEFAULT_POST_TIME_BUDGET_MS);
                        if (promisingRaw && postTimeBudgetMs > 0L) {
                            SequenceGroupPostProcessor.optimize(candidate, postTimeBudgetMs, false);
                            afterStats = SequenceGroupPostProcessor.computeGroupStats(candidate);
                            afterFragmentation = LnsModelAndInstructionSupport.fragmentationScore(candidate);
                        }
                        boolean visitedSolution = visited.contains(
                                LnsModelAndInstructionSupport.solutionSignature(candidate));
                        boolean guardOk = groupGainRegressionAllowed(beforeStats, afterStats)
                                && groupGainRegressionAllowed(originalStats, afterStats);
                        diagnostics.record(new DiagnosticRow(
                                iteration, ni, neighborhood.seedKeys(),
                                neighborhood.freeDemand().size(), neighborhood.patterns().size(),
                                neighborhood.cars(), attempt.columns().size(),
                                beforeProxy, attempt.activeColumns(),
                                beforeStats.groups(), beforeStats.oddCarGroups(),
                                beforeStats.smallCarGroups(), beforeFragmentation,
                                afterStats.groups(), afterStats.oddCarGroups(),
                                afterStats.smallCarGroups(), afterFragmentation,
                                true, true, !visitedSolution, visitedSolution, guardOk, attempt.status()));
                        if (!visitedSolution && guardOk) {
                            MoveCandidate move = new MoveCandidate(candidate, neighborhood, attempt,
                                    afterStats, afterFragmentation);
                            if (afterStats.groups() < beforeGroups) {
                                bestImprovement = betterMove(bestImprovement, move);
                            } else if (afterStats.groups() == beforeGroups) {
                                if (allowPlateau && improvesPlateau(beforeStats, beforeFragmentation,
                                        afterStats, afterFragmentation)) {
                                    bestPlateau = betterMove(bestPlateau, move);
                                }
                            } else {
                                bestWorsening = betterMove(bestWorsening, move);
                            }
                        }
                    } else {
                        diagnostics.record(new DiagnosticRow(
                                iteration, ni, neighborhood.seedKeys(),
                                neighborhood.freeDemand().size(), neighborhood.patterns().size(),
                                neighborhood.cars(), attempt.columns().size(),
                                beforeProxy, attempt.activeColumns(),
                                beforeStats.groups(), beforeStats.oddCarGroups(),
                                beforeStats.smallCarGroups(), beforeFragmentation,
                                afterStats.groups(), afterStats.oddCarGroups(),
                                afterStats.smallCarGroups(), afterFragmentation,
                                true, false, false, false, false, attempt.status()));
                    }

                    log.debug("LNS rejected: groups {} -> {}, odd {}->{}, small {}->{}, frag {}->{}, cars {}->{}, waste {}->{}, demandOk={}, seeds={}, columns={}, status={}",
                            beforeGroups, afterStats.groups(),
                            beforeStats.oddCarGroups(), afterStats.oddCarGroups(),
                            beforeStats.smallCarGroups(), afterStats.smallCarGroups(),
                            beforeFragmentation, afterFragmentation,
                            originalCars, candidateCars, originalWaste, candidateWaste,
                            originalDemand.equals(candidateDemand),
                            neighborhood.seedKeys(), attempt.columns().size(), attempt.status());
                }

                log.debug("LNS iter {}: nbs={}, cacheHits={}, uncached={}, buildMs={}, solveMs={}, evalMs={}, maxNbMs={} (cols={}), noOpSkipped={}",
                        iteration, neighborhoods.size(),
                        neighborhoods.size() - uncachedNeighborhoods.size(),
                        uncachedNeighborhoods.size(),
                        buildNbDoneMs - iterStartMs, solveDoneMs - buildNbDoneMs,
                        System.currentTimeMillis() - solveDoneMs,
                        maxSingleNbMs, maxSingleNbCols, noOpSkipped);

                MoveCandidate accepted = bestImprovement != null ? bestImprovement : bestPlateau;
                boolean escapeStep = false;
                if (accepted == null) {
                    if (escape && bestWorsening != null
                            && bestWorsening.afterGroups() <= bestEverStats.groups() + worseningTolerance) {
                        accepted = bestWorsening;
                        escapeStep = true;
                    } else {
                        break;
                    }
                }

                log.info("LNS {}: groups {} -> {}, odd {}->{}, small {}->{}, frag {}->{}, waste={} cars={}, seeds={}, orders={}, patterns={}, columns={}, status={}, elapsed={}ms",
                        escapeStep ? "escape" : "accepted",
                        beforeGroups, accepted.afterGroups(),
                        beforeStats.oddCarGroups(), accepted.afterOddCarGroups(),
                        beforeStats.smallCarGroups(), accepted.afterSmallCarGroups(),
                        beforeFragmentation, accepted.afterFragmentation(),
                        LnsModelAndInstructionSupport.totalWaste(accepted.instructions()),
                        LnsModelAndInstructionSupport.totalCars(accepted.instructions()),
                        accepted.neighborhood().seedKeys(),
                        accepted.neighborhood().freeDemand().keySet(),
                        accepted.neighborhood().patterns().size(),
                        accepted.attempt().columns().size(),
                        accepted.attempt().status(),
                        accepted.attempt().elapsedMs());
                current = accepted.instructions();
                visited.add(LnsModelAndInstructionSupport.solutionSignature(current));
                if (betterStats(accepted.afterStats(), bestEverStats)) {
                    bestEver = LnsModelAndInstructionSupport.cloneInstructions(current);
                    bestEverStats = accepted.afterStats();
                    improved = true;
                    noImproveStreak = 0;
                } else if (++noImproveStreak >= maxNoImprove) {
                    lastReason = "no-improve-streak";
                    break;
                }
            }
        } finally {
            if (executor != null) {
                executor.close();
            }
        }

        diagnostics.logSummary(originalStats);
        if (improved && betterStats(bestEverStats, originalStats)) {
            return new LnsResult(true, bestEver, originalGroups, bestEverStats.groups(), "improved");
        }
        return LnsResult.notImproved(originalInstructions, lastReason);
    }

    private String neighborhoodCacheKey(Neighborhood neighborhood) {
        StringBuilder sb = new StringBuilder(256);
        sb.append(neighborhood.cars()).append('|').append(neighborhood.waste()).append("#D:");
        for (Map.Entry<String, Integer> entry : neighborhood.freeDemand().entrySet()) {
            sb.append(entry.getKey()).append('=').append(entry.getValue()).append(',');
        }
        sb.append("#P:");
        for (PatternKey pattern : neighborhood.patterns()) {
            sb.append(pattern.signature()).append(';');
        }
        sb.append("#R:");
        Map<String, Integer> requiredCounts = new LinkedHashMap<>();
        for (RollRecord roll : neighborhood.selectedRolls()) {
            String colSig = new Column(roll.pattern(), roll.config(), roll.demandCounts(), true).signature();
            requiredCounts.merge(colSig, 1, Integer::sum);
        }
        for (Map.Entry<String, Integer> entry : requiredCounts.entrySet()) {
            sb.append(entry.getKey()).append('x').append(entry.getValue()).append(';');
        }
        return sb.toString();
    }

    private boolean isNoOpAttempt(Neighborhood neighborhood, SolveAttempt attempt) {
        Map<String, Integer> beforeCounts = new HashMap<>();
        for (RollRecord roll : neighborhood.selectedRolls()) {
            String sig = new Column(roll.pattern(), roll.config(), roll.demandCounts(), true).signature();
            beforeCounts.merge(sig, 1, Integer::sum);
        }
        Map<String, Integer> afterCounts = new HashMap<>();
        for (Map.Entry<Integer, Integer> entry : attempt.counts().entrySet()) {
            int count = entry.getValue();
            if (count > 0) {
                afterCounts.merge(attempt.columns().get(entry.getKey()).signature(), count, Integer::sum);
            }
        }
        return beforeCounts.equals(afterCounts);
    }

    private MoveCandidate betterMove(MoveCandidate current, MoveCandidate candidate) {
        if (current == null) {
            return candidate;
        }
        if (candidate.afterGroups() != current.afterGroups()) {
            return candidate.afterGroups() < current.afterGroups() ? candidate : current;
        }
        if (balanceTiebreakEnabled()) {
            if (betterSecondaryStats(candidate.afterStats(), current.afterStats())) {
                return candidate;
            }
            if (betterSecondaryStats(current.afterStats(), candidate.afterStats())) {
                return current;
            }
        }
        if (candidate.afterFragmentation() != current.afterFragmentation()) {
            return candidate.afterFragmentation() < current.afterFragmentation() ? candidate : current;
        }
        if (!balanceTiebreakEnabled()) {
            if (betterSecondaryStats(candidate.afterStats(), current.afterStats())) {
                return candidate;
            }
            if (betterSecondaryStats(current.afterStats(), candidate.afterStats())) {
                return current;
            }
        }
        if (candidate.neighborhood().cars() != current.neighborhood().cars()) {
            return candidate.neighborhood().cars() > current.neighborhood().cars() ? candidate : current;
        }
        if (candidate.attempt().columns().size() != current.attempt().columns().size()) {
            return candidate.attempt().columns().size() > current.attempt().columns().size() ? candidate : current;
        }
        return current;
    }

    private boolean balanceTiebreakEnabled() {
        return SolverRuntimeProperties.getBoolean("cutting.lns.balanceTiebreak", false);
    }

    private boolean improvesPlateau(
            SequenceGroupPostProcessor.GroupStats beforeStats,
            int beforeFragmentation,
            SequenceGroupPostProcessor.GroupStats afterStats,
            int afterFragmentation) {
        if (afterStats.groups() != beforeStats.groups()) {
            return false;
        }
        if (afterStats.oddCarGroups() != beforeStats.oddCarGroups()) {
            return afterStats.oddCarGroups() < beforeStats.oddCarGroups();
        }
        if (afterStats.oneCarGroups() != beforeStats.oneCarGroups()) {
            return afterStats.oneCarGroups() < beforeStats.oneCarGroups();
        }
        if (afterStats.smallCarGroups() != beforeStats.smallCarGroups()) {
            return afterStats.smallCarGroups() < beforeStats.smallCarGroups();
        }
        return afterFragmentation < beforeFragmentation;
    }

    private boolean groupGainRegressionAllowed(
            SequenceGroupPostProcessor.GroupStats reference,
            SequenceGroupPostProcessor.GroupStats candidate) {
        if (candidate.groups() >= reference.groups()) {
            return true;
        }
        int maxOddRegression = SolverRuntimeProperties.getInt(
                "cutting.lns.maxOddRegressionOnGroupGain", 0);
        int maxSmallRegression = SolverRuntimeProperties.getInt(
                "cutting.lns.maxSmallRegressionOnGroupGain", Integer.MAX_VALUE);
        return candidate.oddCarGroups() <= (long) reference.oddCarGroups() + maxOddRegression
                && candidate.smallCarGroups() <= (long) reference.smallCarGroups() + maxSmallRegression;
    }

    private boolean betterStats(
            SequenceGroupPostProcessor.GroupStats candidate,
            SequenceGroupPostProcessor.GroupStats current) {
        if (candidate.groups() != current.groups()) {
            return candidate.groups() < current.groups();
        }
        return betterSecondaryStats(candidate, current);
    }

    private boolean betterSecondaryStats(
            SequenceGroupPostProcessor.GroupStats candidate,
            SequenceGroupPostProcessor.GroupStats current) {
        if (candidate.oddCarGroups() != current.oddCarGroups()) {
            return candidate.oddCarGroups() < current.oddCarGroups();
        }
        if (candidate.oneCarGroups() != current.oneCarGroups()) {
            return candidate.oneCarGroups() < current.oneCarGroups();
        }
        if (candidate.smallCarGroups() != current.smallCarGroups()) {
            return candidate.smallCarGroups() < current.smallCarGroups();
        }
        return false;
    }

    public record LnsResult(
            boolean improved,
            List<CuttingInstruction> instructions,
            int beforeGroups,
            int afterGroups,
            String reason) {

        static LnsResult notImproved(List<CuttingInstruction> instructions, String reason) {
            return new LnsResult(false, instructions, 0, 0, reason);
        }
    }

    private record MoveCandidate(
            List<CuttingInstruction> instructions,
            Neighborhood neighborhood,
            SolveAttempt attempt,
            SequenceGroupPostProcessor.GroupStats afterStats,
            int afterFragmentation) {

        int afterGroups() {
            return afterStats.groups();
        }

        int afterOddCarGroups() {
            return afterStats.oddCarGroups();
        }

        int afterSmallCarGroups() {
            return afterStats.smallCarGroups();
        }
    }
}
