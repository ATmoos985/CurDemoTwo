package changyang.cut.apsmodule.generator.NewSolver.output;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverParameters;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverRuntimeProperties;
import changyang.cut.apsmodule.generator.NewSolver.mip.UnifiedSetPartitionSolver;
import changyang.cut.apsmodule.generator.NewSolver.mip.UnifiedSetPartitionSolver.Column;
import changyang.cut.apsmodule.generator.NewSolver.mip.UnifiedSetPartitionSolver.ColumnUse;
import changyang.cut.apsmodule.generator.NewSolver.mip.UnifiedSetPartitionSolver.Result;
import changyang.cut.apsmodule.generator.NewSolver.output.SetPartitionColumnCodec.UseMetrics;
import changyang.cut.apsmodule.generator.NewSolver.output.SetPartitionMicroSearch.DonorVariant;
import changyang.cut.apsmodule.generator.NewSolver.output.SetPartitionMicroSearch.RefineStats;
import changyang.cut.apsmodule.generator.NewSolver.output.SetPartitionMicroSearch.SubproblemKey;
import changyang.cut.apsmodule.service.CuttingInstruction;
import changyang.cut.apsmodule.solver.kernel.execution.BoundedSolverTaskExecutor;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.stream.Collectors;

/**
 * 质量模式精修段：set-partition 微邻域迭代（残差导向列注入）。
 */
public final class SetPartitionRefiner {

    private static final Logger log = LoggerFactory.getLogger(SetPartitionRefiner.class);
    private static final long DEFAULT_SPR_BUDGET_MS = 300_000;

    private SetPartitionRefiner() {
    }

    public record ColumnRefineResult(List<ColumnUse> uses,
                                     List<Column> discoveredColumns,
                                     long elapsedMs,
                                     int iterations,
                                     int targets,
                                     int solverCalls,
                                     int cacheHits,
                                     int acceptedMoves) {
    }

    public static boolean isEnabled() {
        return SolverRuntimeProperties.getBoolean("cutting.spr.enabled", true);
    }

    public static int skipGapThreshold() {
        return SolverRuntimeProperties.getInt("cutting.spr.skipGapThreshold", 8);
    }

    static long budgetMs() {
        return SolverRuntimeProperties.getLong("cutting.spr.budgetMs", DEFAULT_SPR_BUDGET_MS);
    }

    static boolean parallelEnabled() {
        return SolverRuntimeProperties.getBoolean("cutting.spr.parallel", true);
    }

    static int parallelism() {
        return SolverRuntimeProperties.getInt(
                "cutting.spr.parallelism", BoundedSolverTaskExecutor.globalParallelism());
    }

    static boolean cacheEnabled() {
        return SolverRuntimeProperties.getBoolean("cutting.spr.cache", true);
    }

    static long groupCapProbeMs() {
        return Math.max(0L,
                SolverRuntimeProperties.getLong("cutting.spr.groupCapProbeMs", 2_000L));
    }

    static int groupCapProbeMaxGlobalOdd() {
        return Math.max(0,
                SolverRuntimeProperties.getInt("cutting.spr.groupCapProbeMaxGlobalOdd", 3));
    }

    static boolean reverseTiePassEnabled() {
        return SolverRuntimeProperties.getBoolean("cutting.spr.reverseTiePass", true);
    }

    static int reverseTieMinGroups() {
        return Math.max(2,
                SolverRuntimeProperties.getInt("cutting.spr.reverseTieMinGroups", 60));
    }

    static int reverseTieMaxIterations() {
        return Math.max(1,
                SolverRuntimeProperties.getInt("cutting.spr.reverseTieMaxIterations", 1));
    }

    static boolean portfolioPassEnabled() {
        return SolverRuntimeProperties.getBoolean("cutting.spr.portfolioPass", false);
    }

    static long portfolioPolishMs() {
        return Math.max(1_000L,
                SolverRuntimeProperties.getLong("cutting.spr.portfolioPolishMs", 2_000L));
    }

    static long oneCarPolishMs() {
        return Math.max(1_000L,
                SolverRuntimeProperties.getLong("cutting.spr.oneCarPolishMs", 20_000L));
    }

    static int oneCarPolishMaxColumns() {
        return Math.max(1,
                SolverRuntimeProperties.getInt("cutting.spr.oneCarPolishMaxColumns", 1_200));
    }

    static int oneCarPolishColumnsPerDemandKey() {
        return Math.max(0,
                SolverRuntimeProperties.getInt("cutting.spr.oneCarPolishColumnsPerDemandKey", 4));
    }

    static int oneCarPolishTargetColumnsPerDemandKey() {
        return Math.max(0,
                SolverRuntimeProperties.getInt(
                        "cutting.spr.oneCarPolishTargetColumnsPerDemandKey", 64));
    }

    static boolean oneCarPolishLargePoolEnabled() {
        return SolverRuntimeProperties.getBoolean("cutting.spr.oneCarPolishLargePool", false);
    }

    public static List<CuttingInstruction> refine(List<CuttingInstruction> instructions,
            SolverParameters params) {
        if (instructions == null || instructions.isEmpty()) {
            return null;
        }
        int totalWidth = params.getTotalWidth();
        CuttingInstruction template = instructions.get(0);
        for (CuttingInstruction instruction : instructions) {
            if (instruction == null
                    || instruction.getLength() != template.getLength()
                    || instruction.getThickness() != template.getThickness()
                    || !Objects.equals(instruction.getSurfaceTreatment(), template.getSurfaceTreatment())) {
                log.info("SPR skip: mixed instruction attributes in group {}", template.getGroupKey());
                return null;
            }
        }
        List<ColumnUse> uses = extractColumnUses(instructions);
        if (uses == null) {
            log.info("SPR skip: station assignments not reconstructible in group {}", template.getGroupKey());
            return null;
        }
        if (uses.size() < 2) {
            log.info("SPR skip: only {} block(s) in group {}", uses.size(), template.getGroupKey());
            return null;
        }
        ConcurrentMap<String, Column> discoveredColumns = new ConcurrentHashMap<>();
        SetPartitionMicroSearch.archiveColumns(
                discoveredColumns, uses.stream().map(ColumnUse::column).toList());
        long startedAt = System.currentTimeMillis();
        long budget = budgetMs();
        long deadline = budget > 0 ? System.currentTimeMillis() + budget : Long.MAX_VALUE;
        ConcurrentMap<SubproblemKey, Result> cache = new ConcurrentHashMap<>();
        RefineStats stats = new RefineStats();
        BoundedSolverTaskExecutor executor = parallelEnabled()
                ? BoundedSolverTaskExecutor.create("spr", parallelism())
                : null;
        if (executor != null) {
            log.info("SPR executor: requestThreads={}, globalThreads={}",
                    executor.configuredParallelism(), BoundedSolverTaskExecutor.globalParallelism());
        }
        List<ColumnUse> improved;
        try {
            boolean portfolio = portfolioPassEnabled() && uses.size() >= reverseTieMinGroups();
            long searchDeadline = portfolio && deadline != Long.MAX_VALUE
                    ? Math.max(System.currentTimeMillis(), deadline - portfolioPolishMs())
                    : deadline;
            List<ColumnUse> parity = SetPartitionMicroSearch.microIterate(
                    uses, SetPartitionMicroSearch.PARITY_DONORS,
                    SetPartitionMicroSearch.PARITY_BUDGET_MS,
                    SetPartitionMicroSearch.MAX_ITERATIONS,
                    totalWidth, searchDeadline, cache, stats, executor, discoveredColumns,
                    DonorVariant.DEFAULT);
            improved = SetPartitionMicroSearch.microIterate(
                    parity, SetPartitionMicroSearch.MERGE_DONORS,
                    SetPartitionMicroSearch.MERGE_BUDGET_MS,
                    SetPartitionMicroSearch.MAX_ITERATIONS,
                    totalWidth, searchDeadline, cache, stats, executor, discoveredColumns,
                    DonorVariant.DEFAULT);
            if (portfolio) {
                log.info("SPR portfolio branch: baseGroups={} primaryGroups={} threshold={}",
                        parity.size(), improved.size(), reverseTieMinGroups());
                List<ColumnUse> alternate = SetPartitionMicroSearch.microIterate(
                        parity, SetPartitionMicroSearch.MERGE_DONORS,
                        SetPartitionMicroSearch.MERGE_BUDGET_MS,
                        SetPartitionMicroSearch.MAX_ITERATIONS,
                        totalWidth, searchDeadline, cache, stats, executor, discoveredColumns,
                        DonorVariant.REVERSE_TIES);
                improved = polishPortfolio(improved, alternate, totalWidth, deadline,
                        discoveredColumns);
            } else if (reverseTiePassEnabled() && improved.size() >= reverseTieMinGroups()) {
                log.info("SPR reverse-tie continuation: groups={} threshold={}",
                        improved.size(), reverseTieMinGroups());
                improved = SetPartitionMicroSearch.microIterate(
                        improved, SetPartitionMicroSearch.MERGE_DONORS,
                        SetPartitionMicroSearch.MERGE_BUDGET_MS,
                        reverseTieMaxIterations(), totalWidth, deadline, cache, stats, executor,
                        discoveredColumns, DonorVariant.REVERSE_TIES);
            }
            improved = polishOneCarBlocks(improved, totalWidth, deadline, discoveredColumns);
        } finally {
            if (executor != null) {
                executor.close();
            }
            SolverRunColumnArchive.recordColumns(discoveredColumns.values());
        }
        improved = SetPartitionColumnCodec.coalesceBySignature(improved);
        SetPartitionMicroSearch.archiveColumns(
                discoveredColumns, improved.stream().map(ColumnUse::column).toList());
        SolverRunColumnArchive.recordColumns(discoveredColumns.values());
        log.info("SPR summary: elapsedMs={}, iterations={}, targets={}, subproblemRequests={}, "
                        + "solverCalls={}, cacheHits={}, acceptedMoves={}, budgetStops={}, "
                        + "capProbes={}, capProbeHits={}, capProbeInfeasible={}, "
                        + "capProbeInconclusive={}, oddOnlyFallbacks={}, discoveredColumns={}, cachedResults={}",
                System.currentTimeMillis() - startedAt,
                stats.iterations.get(), stats.targets.get(), stats.subproblemRequests(),
                stats.solverCalls(), stats.cacheHits(), stats.acceptedMoves.get(),
                stats.budgetStops.get(), stats.capProbes.get(), stats.capProbeHits.get(),
                stats.capProbeInfeasible.get(), stats.capProbeInconclusive.get(),
                stats.oddOnlyFallbacks.get(), discoveredColumns.size(), cache.size());
        return toInstructions(improved, template, params);
    }

    private static List<ColumnUse> polishOneCarBlocks(List<ColumnUse> incumbent,
            int totalWidth, long deadline, ConcurrentMap<String, Column> discoveredColumns) {
        List<ColumnUse> current = SetPartitionColumnCodec.coalesceBySignature(incumbent);
        UseMetrics before = SetPartitionColumnCodec.metrics(current, totalWidth);
        if (before.one() == 0) {
            return current;
        }
        if (discoveredColumns.size() > oneCarPolishMaxColumns()
                && !oneCarPolishLargePoolEnabled()) {
            log.info("SPR one-car polish skipped: pool={} > cap={} (large-pool disabled)",
                    discoveredColumns.size(), oneCarPolishMaxColumns());
            return current;
        }
        Map<String, Integer> demand = SetPartitionColumnCodec.producedDemand(current);
        Set<String> oneCarDemandKeys = current.stream()
                .filter(use -> use.count() == 1)
                .flatMap(use -> use.column().demandUse().keySet().stream())
                .collect(Collectors.toCollection(TreeSet::new));
        List<Column> polishPool = selectPolishColumns(
                List.copyOf(discoveredColumns.values()),
                current.stream().map(ColumnUse::column).toList(), demand,
                oneCarDemandKeys, oneCarPolishMaxColumns(),
                oneCarPolishColumnsPerDemandKey(),
                oneCarPolishTargetColumnsPerDemandKey());
        long remainingMs = deadline == Long.MAX_VALUE
                ? oneCarPolishMs()
                : Math.max(0L, deadline - System.currentTimeMillis());
        long timeLimitMs = Math.min(oneCarPolishMs(), remainingMs);
        if (timeLimitMs < 1_000L) {
            log.info("SPR one-car polish skipped: remainingMs={}", remainingMs);
            return current;
        }

        Result polished = new UnifiedSetPartitionSolver().minimizeOneCarAtCaps(
                polishPool, demand,
                before.cars(), before.waste(), totalWidth, before.groups(), before.odd(),
                timeLimitMs, current);
        SetPartitionMicroSearch.archiveResult(discoveredColumns, polished);
        if (!SetPartitionMicroSearch.isFeasible(polished)) {
            log.info("SPR one-car polish: status={} pool={}/{} kept={}/{}/{} one={}",
                    polished == null ? "NONE" : polished.status(), polishPool.size(),
                    discoveredColumns.size(),
                    before.groups(), before.odd(), before.small(), before.one());
            return current;
        }
        List<ColumnUse> candidate = SetPartitionColumnCodec.coalesceBySignature(polished.uses());
        UseMetrics after = SetPartitionColumnCodec.metrics(candidate, totalWidth);
        boolean accepted = after.groups() <= before.groups()
                && after.odd() <= before.odd()
                && after.one() < before.one()
                && after.cars() == before.cars()
                && after.waste() <= before.waste()
                && SetPartitionColumnCodec.producedDemand(candidate)
                        .equals(SetPartitionColumnCodec.producedDemand(current));
        log.info("SPR one-car polish: pool={}/{} before={}/{}/{} one={} "
                        + "after={}/{}/{} one={} status={} elapsedMs={} accepted={}",
                polishPool.size(), discoveredColumns.size(),
                before.groups(), before.odd(), before.small(),
                before.one(), after.groups(), after.odd(), after.small(), after.one(),
                polished.status(), polished.elapsedMs(), accepted);
        return accepted ? candidate : current;
    }

    public static List<Column> selectPolishColumns(List<Column> pool, List<Column> incumbent,
            Map<String, Integer> demand, int maxColumns, int columnsPerDemandKey) {
        return selectPolishColumns(pool, incumbent, demand, Set.of(), maxColumns,
                columnsPerDemandKey, 0);
    }

    public static List<Column> selectPolishColumns(List<Column> pool, List<Column> incumbent,
            Map<String, Integer> demand, Set<String> targetDemandKeys, int maxColumns,
            int columnsPerDemandKey, int targetColumnsPerDemandKey) {
        Map<String, Column> unique = new LinkedHashMap<>();
        pool.stream().sorted(Comparator.comparing(Column::signature))
                .forEach(column -> unique.putIfAbsent(column.signature(), column));
        if (maxColumns <= 0 || unique.size() <= maxColumns) {
            return List.copyOf(unique.values());
        }

        Map<String, Column> selected = new LinkedHashMap<>();
        incumbent.stream().sorted(Comparator.comparing(Column::signature))
                .forEach(column -> selected.putIfAbsent(column.signature(), column));
        List<Column> ranked = new ArrayList<>(unique.values());
        ranked.sort(Comparator
                .<Column>comparingInt(column -> columnSupport(column, demand)).reversed()
                .thenComparing(Comparator.comparingInt(Column::patternWidth).reversed())
                .thenComparing(Column::signature));

        addColumnsPerDemandKey(selected, ranked, targetDemandKeys,
                maxColumns, targetColumnsPerDemandKey);
        int perKey = Math.max(0, columnsPerDemandKey);
        addColumnsPerDemandKey(selected, ranked, demand.keySet(), maxColumns, perKey);
        for (Column column : ranked) {
            if (selected.size() >= maxColumns) {
                break;
            }
            selected.putIfAbsent(column.signature(), column);
        }
        return List.copyOf(selected.values());
    }

    private static void addColumnsPerDemandKey(Map<String, Column> selected,
            List<Column> ranked, Collection<String> demandKeys, int maxColumns, int perKey) {
        if (perKey <= 0) {
            return;
        }
        for (String demandKey : demandKeys.stream().sorted().toList()) {
            int added = 0;
            for (Column column : ranked) {
                if (selected.size() >= maxColumns) {
                    break;
                }
                if (!selected.containsKey(column.signature())
                        && column.demandUse().containsKey(demandKey)) {
                    selected.put(column.signature(), column);
                    if (++added >= perKey) {
                        break;
                    }
                }
            }
        }
    }

    private static int columnSupport(Column column, Map<String, Integer> demand) {
        int support = Integer.MAX_VALUE;
        for (Map.Entry<String, Integer> use : column.demandUse().entrySet()) {
            support = Math.min(support,
                    demand.getOrDefault(use.getKey(), 0) / Math.max(1, use.getValue()));
        }
        return support == Integer.MAX_VALUE ? 0 : support;
    }

    public static List<ColumnUse> polishOneCarNeighborhoodForResearch(
            List<ColumnUse> start, int totalWidth, int donorCount, long timeLimitMs) {
        List<ColumnUse> current = SetPartitionColumnCodec.coalesceBySignature(start);
        ColumnUse target = current.stream().filter(use -> use.count() == 1).findFirst().orElse(null);
        if (target == null || donorCount < 1 || timeLimitMs < 1_000L) {
            return current;
        }
        List<ColumnUse> others = new ArrayList<>(current);
        others.remove(target);
        others = SetPartitionMicroSearch.rankDonors(target, others, DonorVariant.DEFAULT);
        List<ColumnUse> removed = new ArrayList<>();
        removed.add(target);
        removed.addAll(others.subList(0, Math.min(donorCount, others.size())));

        ConcurrentMap<SubproblemKey, Result> cache = new ConcurrentHashMap<>();
        ConcurrentMap<String, Column> discovered = new ConcurrentHashMap<>();
        RefineStats stats = new RefineStats();
        Result rebuilt = SetPartitionMicroSearch.microRebuild(removed, timeLimitMs, totalWidth,
                cache, stats, discovered, false);
        if (!SetPartitionMicroSearch.isFeasible(rebuilt)) {
            log.info("SPR one-car neighborhood: donors={} status={} kept",
                    donorCount, rebuilt == null ? "NONE" : rebuilt.status());
            return current;
        }
        UseMetrics before = SetPartitionColumnCodec.metrics(removed, totalWidth);
        UseMetrics after = SetPartitionColumnCodec.metrics(rebuilt.uses(), totalWidth);
        boolean accepted = after.groups() <= before.groups()
                && after.odd() <= before.odd()
                && after.one() < before.one()
                && after.cars() == before.cars()
                && after.waste() <= before.waste()
                && SetPartitionColumnCodec.producedDemand(rebuilt.uses())
                        .equals(SetPartitionColumnCodec.producedDemand(removed));
        log.info("SPR one-car neighborhood: donors={} before={}/{}/one{} after={}/{}/one{} "
                        + "status={} elapsedMs={} accepted={}",
                donorCount, before.groups(), before.odd(), before.one(),
                after.groups(), after.odd(), after.one(), rebuilt.status(),
                rebuilt.elapsedMs(), accepted);
        if (!accepted) {
            return current;
        }
        List<ColumnUse> result = new ArrayList<>(current);
        result.removeAll(removed);
        result.addAll(rebuilt.uses());
        return SetPartitionColumnCodec.coalesceBySignature(result);
    }

    private static List<ColumnUse> polishPortfolio(List<ColumnUse> primary,
            List<ColumnUse> alternate, int totalWidth, long deadline,
            ConcurrentMap<String, Column> discoveredColumns) {
        List<ColumnUse> first = SetPartitionColumnCodec.coalesceBySignature(primary);
        List<ColumnUse> second = SetPartitionColumnCodec.coalesceBySignature(alternate);
        UseMetrics firstMetrics = SetPartitionColumnCodec.metrics(first, totalWidth);
        UseMetrics secondMetrics = SetPartitionColumnCodec.metrics(second, totalWidth);
        List<ColumnUse> incumbent = SetPartitionColumnCodec.compareMetrics(firstMetrics, secondMetrics) <= 0
                ? first : second;
        UseMetrics incumbentMetrics = SetPartitionColumnCodec.metrics(incumbent, totalWidth);
        log.info("SPR portfolio candidates: primary={}/{}/{} alternate={}/{}/{}",
                firstMetrics.groups(), firstMetrics.odd(), firstMetrics.small(),
                secondMetrics.groups(), secondMetrics.odd(), secondMetrics.small());

        int maxGroups = Math.min(firstMetrics.groups(), secondMetrics.groups());
        int maxOdd = Math.min(firstMetrics.odd(), secondMetrics.odd());
        int maxOne = Math.min(firstMetrics.one(), secondMetrics.one());
        int maxSmall = Math.min(firstMetrics.small(), secondMetrics.small());
        if (incumbentMetrics.groups() <= maxGroups
                && incumbentMetrics.odd() <= maxOdd
                && incumbentMetrics.one() <= maxOne
                && incumbentMetrics.small() <= maxSmall) {
            return incumbent;
        }
        if (firstMetrics.cars() != secondMetrics.cars()
                || firstMetrics.waste() != secondMetrics.waste()
                || !SetPartitionColumnCodec.producedDemand(first)
                        .equals(SetPartitionColumnCodec.producedDemand(second))) {
            log.warn("SPR portfolio skipped: candidate conservation mismatch");
            return incumbent;
        }

        long remainingMs = deadline == Long.MAX_VALUE
                ? portfolioPolishMs()
                : Math.max(0L, deadline - System.currentTimeMillis());
        long timeLimitMs = Math.min(portfolioPolishMs(), remainingMs);
        if (timeLimitMs < 1_000L) {
            log.info("SPR portfolio polish skipped: remainingMs={}", remainingMs);
            return incumbent;
        }
        Map<String, Column> poolBySignature = new LinkedHashMap<>();
        first.stream().map(ColumnUse::column)
                .forEach(column -> poolBySignature.putIfAbsent(column.signature(), column));
        second.stream().map(ColumnUse::column)
                .forEach(column -> poolBySignature.putIfAbsent(column.signature(), column));
        UnifiedSetPartitionSolver.MetricCapResult polished =
                new UnifiedSetPartitionSolver().checkMetricCaps(
                        List.copyOf(poolBySignature.values()),
                        SetPartitionColumnCodec.producedDemand(first),
                        firstMetrics.cars(), firstMetrics.waste(), totalWidth,
                        maxGroups, maxOdd, maxOne, maxSmall, timeLimitMs, incumbent);
        SetPartitionMicroSearch.archiveResult(discoveredColumns, polished.result());
        if (!polished.feasible() || polished.result() == null) {
            log.info("SPR portfolio polish: pool={} caps={}/{}/{} status={} proven={}",
                    poolBySignature.size(), maxGroups, maxOdd, maxSmall,
                    polished.result() == null ? "NONE" : polished.result().status(),
                    polished.proven());
            return incumbent;
        }
        List<ColumnUse> candidate = SetPartitionColumnCodec.coalesceBySignature(polished.result().uses());
        UseMetrics candidateMetrics = SetPartitionColumnCodec.metrics(candidate, totalWidth);
        boolean accepted = SetPartitionColumnCodec.compareMetrics(candidateMetrics, incumbentMetrics) < 0;
        log.info("SPR portfolio polish: pool={} caps={}/{}/{} result={}/{}/{} "
                        + "status={} elapsedMs={} accepted={}",
                poolBySignature.size(), maxGroups, maxOdd, maxSmall,
                candidateMetrics.groups(), candidateMetrics.odd(), candidateMetrics.small(),
                polished.result().status(), polished.result().elapsedMs(), accepted);
        return accepted ? candidate : incumbent;
    }

    public static ColumnRefineResult refineColumnUses(List<ColumnUse> start,
            int totalWidth, int donorCount, long subproblemBudgetMs,
            long totalBudgetMs, int maxIterations) {
        return refineColumnUses(start, totalWidth, donorCount, subproblemBudgetMs,
                totalBudgetMs, maxIterations, "DEFAULT");
    }

    public static ColumnRefineResult refineColumnUses(List<ColumnUse> start,
            int totalWidth, int donorCount, long subproblemBudgetMs,
            long totalBudgetMs, int maxIterations, String donorVariantName) {
        if (start == null || start.size() < 2) {
            throw new IllegalArgumentException("At least two executable column uses are required");
        }
        if (totalWidth <= 0 || donorCount < 1 || subproblemBudgetMs < 1
                || maxIterations < 1) {
            throw new IllegalArgumentException("Invalid column refinement parameters");
        }
        long startedAt = System.currentTimeMillis();
        long deadline = totalBudgetMs > 0
                ? startedAt + totalBudgetMs
                : Long.MAX_VALUE;
        ConcurrentMap<SubproblemKey, Result> cache = new ConcurrentHashMap<>();
        ConcurrentMap<String, Column> discoveredColumns = new ConcurrentHashMap<>();
        SetPartitionMicroSearch.archiveColumns(
                discoveredColumns, start.stream().map(ColumnUse::column).toList());
        RefineStats stats = new RefineStats();
        BoundedSolverTaskExecutor executor = parallelEnabled()
                ? BoundedSolverTaskExecutor.create("spr-research", parallelism())
                : null;
        DonorVariant donorVariant = DonorVariant.parse(donorVariantName);
        List<ColumnUse> improved;
        try {
            improved = SetPartitionMicroSearch.microIterate(
                    start, donorCount, subproblemBudgetMs, maxIterations,
                    totalWidth, deadline, cache, stats, executor, discoveredColumns,
                    donorVariant);
        } finally {
            if (executor != null) {
                executor.close();
            }
        }
        improved = SetPartitionColumnCodec.coalesceBySignature(improved);
        SetPartitionMicroSearch.archiveColumns(
                discoveredColumns, improved.stream().map(ColumnUse::column).toList());
        List<Column> columns = discoveredColumns.values().stream()
                .sorted(Comparator.comparing(Column::signature))
                .toList();
        SolverRunColumnArchive.recordColumns(columns);
        long elapsedMs = System.currentTimeMillis() - startedAt;
        log.info("SPR research summary: donorCount={}, donorVariant={}, elapsedMs={}, iterations={}, targets={}, "
                        + "solverCalls={}, cacheHits={}, acceptedMoves={}, discoveredColumns={}",
                donorCount, donorVariant, elapsedMs, stats.iterations.get(), stats.targets.get(),
                stats.solverCalls(), stats.cacheHits(), stats.acceptedMoves.get(), columns.size());
        return new ColumnRefineResult(List.copyOf(improved), List.copyOf(columns), elapsedMs,
                stats.iterations.get(), stats.targets.get(), stats.solverCalls(),
                stats.cacheHits(), stats.acceptedMoves.get());
    }

    static List<ColumnUse> extractColumnUses(List<CuttingInstruction> instructions) {
        return SetPartitionColumnCodec.extractColumnUses(instructions);
    }

    static List<CuttingInstruction> toInstructions(List<ColumnUse> uses,
            CuttingInstruction template, SolverParameters params) {
        return SetPartitionColumnCodec.toInstructions(uses, template, params);
    }
}
