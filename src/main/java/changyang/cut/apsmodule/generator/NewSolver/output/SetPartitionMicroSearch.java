package changyang.cut.apsmodule.generator.NewSolver.output;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverRuntimeProperties;
import changyang.cut.apsmodule.generator.NewSolver.mip.UnifiedSetPartitionSolver;
import changyang.cut.apsmodule.generator.NewSolver.mip.UnifiedSetPartitionSolver.Column;
import changyang.cut.apsmodule.generator.NewSolver.mip.UnifiedSetPartitionSolver.ColumnUse;
import changyang.cut.apsmodule.generator.NewSolver.mip.UnifiedSetPartitionSolver.Result;
import changyang.cut.apsmodule.solver.kernel.execution.BoundedSolverTaskExecutor;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;
import java.util.stream.Collectors;

/**
 * SetPartitionRefiner 的微邻域最陡下降搜索、残差形状生成与子问题求解缓存。
 */
final class SetPartitionMicroSearch {

    private static final Logger log = LoggerFactory.getLogger(SetPartitionMicroSearch.class);

    static final int PARITY_DONORS = 3;
    static final long PARITY_BUDGET_MS = 20_000;
    static final int MERGE_DONORS = 5;
    static final long MERGE_BUDGET_MS = 40_000;
    static final int MAX_ITERATIONS = 40;
    private static final double ODD_WEIGHT = 0.02;
    private static final int SMALL_MAX_CARS = SetPartitionColumnCodec.SMALL_MAX_CARS;
    private static final String MODE_GROUP_CAP = "GROUP_CAP";
    private static final String MODE_GROUPS = "GROUPS";
    private static final String MODE_ODD_AT_GROUP_CAP = "ODD_AT_GROUP_CAP";

    private static final int SHAPE_MAX_DISTINCT = 5;
    private static final int SHAPE_RAW_CAP = 6000;
    private static final int SHAPE_PER_BAND = 100;
    private static final int SHAPE_TOTAL_CAP = 400;
    private static final int MAX_MESSAGES_PER_WIDTH = 2;
    private static final int MAX_OPTIONS_PER_WIDTH = 20;
    private static final int CONFIGS_PER_SHAPE = 80;

    private SetPartitionMicroSearch() {
    }

    record SubproblemKey(String poolSignature,
                         String demandSignature,
                         int exactCars,
                         int wasteCap,
                         int totalWidth,
                         long timeLimitMs,
                         String warmStartSignature,
                         String solveMode,
                         int maxGroups) {
    }

    enum ProbeDecision {
        ACCEPT_GROUP_WITNESS,
        ODD_ONLY,
        FULL_LEXICAL
    }

    enum DonorVariant {
        DEFAULT,
        WIDTH_FIRST,
        REVERSE_TIES;

        static DonorVariant parse(String value) {
            if (value == null || value.isBlank()) {
                return DEFAULT;
            }
            try {
                return DonorVariant.valueOf(value.trim().toUpperCase());
            } catch (IllegalArgumentException ignored) {
                return DEFAULT;
            }
        }
    }

    static final class RefineStats {
        final AtomicInteger iterations = new AtomicInteger();
        final AtomicInteger targets = new AtomicInteger();
        final AtomicInteger subproblemRequests = new AtomicInteger();
        final AtomicInteger solverCalls = new AtomicInteger();
        final AtomicInteger cacheHits = new AtomicInteger();
        final AtomicInteger acceptedMoves = new AtomicInteger();
        final AtomicInteger budgetStops = new AtomicInteger();
        final AtomicInteger capProbes = new AtomicInteger();
        final AtomicInteger capProbeHits = new AtomicInteger();
        final AtomicInteger capProbeInfeasible = new AtomicInteger();
        final AtomicInteger capProbeInconclusive = new AtomicInteger();
        final AtomicInteger oddOnlyFallbacks = new AtomicInteger();

        int subproblemRequests() {
            return subproblemRequests.get();
        }

        int solverCalls() {
            return solverCalls.get();
        }

        int cacheHits() {
            return cacheHits.get();
        }
    }

    private record Move(ColumnUse target, List<ColumnUse> removed, Result sub,
                        boolean better, int removedOdd, int removedOne, int removedSmall) {
    }

    private static boolean cacheEnabled() {
        return SolverRuntimeProperties.getBoolean("cutting.spr.cache", true);
    }

    private static long groupCapProbeMs() {
        return Math.max(0L,
                SolverRuntimeProperties.getLong("cutting.spr.groupCapProbeMs", 2_000L));
    }

    private static int groupCapProbeMaxGlobalOdd() {
        return Math.max(0,
                SolverRuntimeProperties.getInt("cutting.spr.groupCapProbeMaxGlobalOdd", 3));
    }

    static List<ColumnUse> microIterate(List<ColumnUse> start,
            int donorCount, long budgetMs, int maxIterations, int totalWidth, long deadline,
            ConcurrentMap<SubproblemKey, Result> cache, RefineStats stats,
            BoundedSolverTaskExecutor executor, ConcurrentMap<String, Column> discoveredColumns,
            DonorVariant donorVariant) {
        List<ColumnUse> current = new ArrayList<>(start);
        for (int iter = 1; iter <= maxIterations; iter++) {
            if (System.currentTimeMillis() >= deadline) {
                stats.budgetStops.incrementAndGet();
                log.info("SPR budget cap reached at iter{}, stopping", iter);
                break;
            }
            stats.iterations.incrementAndGet();
            List<ColumnUse> targets = new ArrayList<>();
            for (ColumnUse use : current) {
                if (use.count() % 2 != 0) {
                    targets.add(use);
                }
            }
            for (ColumnUse use : current) {
                if (use.count() % 2 == 0 && use.count() <= SMALL_MAX_CARS) {
                    targets.add(use);
                }
            }
            if (targets.isEmpty()) {
                break;
            }
            stats.targets.addAndGet(targets.size());
            boolean probeEnabled = shouldProbeGroupCap(donorCount, current);
            final List<ColumnUse> snapshot = current;
            List<Move> moves;
            if (executor != null) {
                moves = executor.mapOrdered(targets,
                        target -> evaluateTarget(target, snapshot, donorCount, budgetMs,
                                totalWidth, cache, stats, discoveredColumns, probeEnabled,
                                donorVariant));
            } else {
                moves = new ArrayList<>(targets.size());
                for (ColumnUse t : targets) {
                    moves.add(evaluateTarget(t, snapshot, donorCount, budgetMs, totalWidth,
                            cache, stats, discoveredColumns, probeEnabled, donorVariant));
                }
            }
            Move best = null;
            int bestGroupsCut = 0;
            int bestOddCut = 0;
            int bestSmallCut = 0;
            for (Move move : moves) {
                if (move == null || !move.better()) {
                    continue;
                }
                int groupsCut = move.removed().size() - move.sub().groups();
                int oddCut = move.removedOdd() - move.sub().oddBlocks();
                int smallCut = move.removedSmall() - move.sub().smallBlocks();
                if (best == null || groupsCut > bestGroupsCut
                        || (groupsCut == bestGroupsCut && (oddCut > bestOddCut
                                || (oddCut == bestOddCut && smallCut > bestSmallCut)))) {
                    best = move;
                    bestGroupsCut = groupsCut;
                    bestOddCut = oddCut;
                    bestSmallCut = smallCut;
                }
            }
            if (best == null) {
                break;
            }
            List<ColumnUse> working = new ArrayList<>(current);
            for (ColumnUse r : best.removed()) {
                working.remove(r);
            }
            working.addAll(best.sub().uses());
            current = working;
            stats.acceptedMoves.incrementAndGet();
            log.info("SPR accept iter{}: {} blocks (odd {}, one {}, small {}) -> {} "
                            + "(odd {}, one {}, small {}) "
                            + "| target={}cars {}",
                    iter, best.removed().size(), best.removedOdd(), best.removedOne(),
                    best.removedSmall(), best.sub().groups(), best.sub().oddBlocks(),
                    best.sub().oneCarBlocks(), best.sub().smallBlocks(),
                    best.target().count(), best.target().column().signature());
        }
        return current;
    }

    private static Move evaluateTarget(ColumnUse target, List<ColumnUse> snapshot,
            int donorCount, long budgetMs, int totalWidth,
            ConcurrentMap<SubproblemKey, Result> cache, RefineStats stats,
            ConcurrentMap<String, Column> discoveredColumns, boolean probeEnabled,
            DonorVariant donorVariant) {
        int targetIdx = snapshot.indexOf(target);
        if (targetIdx < 0) {
            return null;
        }
        List<ColumnUse> others = new ArrayList<>(snapshot);
        others.remove(targetIdx);
        others = rankDonors(target, others, donorVariant);
        List<ColumnUse> removed = new ArrayList<>();
        removed.add(target);
        removed.addAll(others.subList(0, Math.min(donorCount, others.size())));
        Result sub = microRebuild(removed, budgetMs, totalWidth, cache, stats,
                discoveredColumns, probeEnabled);
        if (sub == null || sub.groups() == 0) {
            return null;
        }
        int removedOdd = 0;
        int removedOne = 0;
        int removedSmall = 0;
        for (ColumnUse r : removed) {
            if (r.count() % 2 != 0) {
                removedOdd++;
            }
            if (r.count() == 1) {
                removedOne++;
            }
            if (r.count() <= SMALL_MAX_CARS) {
                removedSmall++;
            }
        }
        boolean better = qualityBetter(sub.oneCarBlocks(), sub.groups(), sub.oddBlocks(),
                sub.smallBlocks(), removedOne, removed.size(), removedOdd, removedSmall);
        return new Move(target, removed, sub, better, removedOdd, removedOne, removedSmall);
    }

    static boolean qualityBetter(int candidateOne, int candidateGroups, int candidateOdd,
            int candidateSmall, int baselineOne, int baselineGroups, int baselineOdd,
            int baselineSmall) {
        if (candidateGroups != baselineGroups) {
            return candidateGroups < baselineGroups;
        }
        if (candidateOdd != baselineOdd) {
            return candidateOdd < baselineOdd;
        }
        if (candidateOne != baselineOne) {
            return candidateOne < baselineOne;
        }
        return candidateSmall < baselineSmall;
    }

    static boolean lexBetter(int candidateGroups, int candidateOdd, int candidateSmall,
            int baselineGroups, int baselineOdd, int baselineSmall) {
        return candidateGroups < baselineGroups
                || (candidateGroups == baselineGroups
                        && (candidateOdd < baselineOdd
                                || (candidateOdd == baselineOdd
                                        && candidateSmall < baselineSmall)));
    }

    static List<ColumnUse> rankDonors(ColumnUse target, List<ColumnUse> candidates,
            DonorVariant donorVariant) {
        Map<String, Integer> targetUse = target.column().demandUse();
        Comparator<ColumnUse> ranking = Comparator.comparingInt(candidate -> {
            int sharedKeys = 0;
            for (String key : candidate.column().demandUse().keySet()) {
                if (targetUse.containsKey(key)) {
                    sharedKeys++;
                }
            }
            int sharedWidths = 0;
            for (Integer width : candidate.column().pattern().keySet()) {
                if (target.column().pattern().containsKey(width)) {
                    sharedWidths++;
                }
            }
            int score = donorVariant == DonorVariant.WIDTH_FIRST
                    ? sharedWidths * 2 + sharedKeys
                    : sharedKeys * 2 + sharedWidths;
            return -score;
        });
        if (donorVariant == DonorVariant.WIDTH_FIRST) {
            ranking = ranking.thenComparing(use -> use.column().signature());
        } else if (donorVariant == DonorVariant.REVERSE_TIES) {
            ranking = ranking.thenComparing(
                    (ColumnUse use) -> use.column().signature(), Comparator.reverseOrder());
        }
        List<ColumnUse> ranked = new ArrayList<>(candidates);
        ranked.sort(ranking);
        return ranked;
    }

    /** 微邻域重建：残差需求 + 比例匹配注入列 + 拆除块兜底，单段求解（odd 已在目标）。 */
    static Result microRebuild(List<ColumnUse> removed, long budgetMs, int totalWidth,
            ConcurrentMap<SubproblemKey, Result> cache, RefineStats stats,
            ConcurrentMap<String, Column> discoveredColumns, boolean probeEnabled) {
        Map<String, Integer> residual = new LinkedHashMap<>();
        int removedCars = 0;
        int removedWaste = 0;
        int minPw = Integer.MAX_VALUE;
        int maxPw = 0;
        for (ColumnUse use : removed) {
            removedCars += use.count();
            removedWaste += use.count() * (totalWidth - use.column().patternWidth());
            minPw = Math.min(minPw, use.column().patternWidth());
            maxPw = Math.max(maxPw, use.column().patternWidth());
            for (Map.Entry<String, Integer> e : use.column().demandUse().entrySet()) {
                residual.merge(e.getKey(), use.count() * e.getValue(), Integer::sum);
            }
        }
        Map<Integer, Map<String, Integer>> residualByWidth = byWidth(residual);
        List<Map<Integer, Integer>> shapes = stratifiedShapes(
                new ArrayList<>(residualByWidth.keySet()), minPw, maxPw, residualByWidth);
        List<Column> subPool = new ArrayList<>();
        for (ColumnUse use : removed) {
            subPool.add(use.column());
            shapes.add(use.column().pattern());
        }
        subPool.addAll(UnifiedSetPartitionSolver.structuredColumns(shapes, residualByWidth,
                MAX_MESSAGES_PER_WIDTH, MAX_OPTIONS_PER_WIDTH, CONFIGS_PER_SHAPE));
        archiveColumns(discoveredColumns, subPool);
        List<ColumnUse> warmStart = new ArrayList<>(removed);
        int exactCars = removedCars;
        int wasteCap = removedWaste;
        int currentGroups = removed.size();
        UnifiedSetPartitionSolver solver = new UnifiedSetPartitionSolver();

        long probeBudgetMs = Math.min(groupCapProbeMs(), Math.max(0L, budgetMs - 1_000L));
        long fallbackBudgetMs = Math.max(1_000L, budgetMs - probeBudgetMs);
        if (probeEnabled && probeBudgetMs > 0 && currentGroups > 1) {
            stats.capProbes.incrementAndGet();
            int challengeGroups = currentGroups - 1;
            SubproblemKey probeKey = subproblemKey(subPool, residual, exactCars, wasteCap,
                    totalWidth, probeBudgetMs, warmStart, MODE_GROUP_CAP, challengeGroups);
            Result probe = solveCached(probeKey, cache, stats, () -> solver.checkGroupCap(
                    subPool, residual, exactCars, wasteCap, totalWidth,
                    challengeGroups, probeBudgetMs, warmStart).result());
            archiveResult(discoveredColumns, probe);
            ProbeDecision decision = probeDecision(probe, challengeGroups);
            if (decision == ProbeDecision.ACCEPT_GROUP_WITNESS) {
                stats.capProbeHits.incrementAndGet();
                return probe;
            }
            if (decision == ProbeDecision.ODD_ONLY) {
                stats.capProbeInfeasible.incrementAndGet();
                stats.oddOnlyFallbacks.incrementAndGet();
                SubproblemKey oddKey = subproblemKey(subPool, residual, exactCars, wasteCap,
                        totalWidth, fallbackBudgetMs, warmStart,
                        MODE_ODD_AT_GROUP_CAP, currentGroups);
                Result odd = solveCached(oddKey, cache, stats, () -> solver.solve(
                        subPool, residual, exactCars, wasteCap, totalWidth,
                        fallbackBudgetMs, ODD_WEIGHT, warmStart, currentGroups));
                archiveResult(discoveredColumns, odd);
                return odd;
            }
            stats.capProbeInconclusive.incrementAndGet();
        }

        SubproblemKey key = subproblemKey(subPool, residual, exactCars, wasteCap,
                totalWidth, fallbackBudgetMs, warmStart, MODE_GROUPS, -1);
        Result result = solveCached(key, cache, stats, () -> solver.solve(
                subPool, residual, exactCars, wasteCap, totalWidth,
                fallbackBudgetMs, ODD_WEIGHT, warmStart));
        archiveResult(discoveredColumns, result);
        return result;
    }

    static SubproblemKey subproblemKey(List<Column> pool,
            Map<String, Integer> demand,
            int exactCars,
            int wasteCap,
            int totalWidth,
            long timeLimitMs,
            List<ColumnUse> warmStart) {
        return subproblemKey(pool, demand, exactCars, wasteCap, totalWidth, timeLimitMs,
                warmStart, MODE_GROUPS, -1);
    }

    static SubproblemKey subproblemKey(List<Column> pool,
            Map<String, Integer> demand,
            int exactCars,
            int wasteCap,
            int totalWidth,
            long timeLimitMs,
            List<ColumnUse> warmStart,
            String solveMode,
            int maxGroups) {
        String poolSignature = pool.stream()
                .map(column -> column.patternWidth() + ":" + column.signature())
                .collect(Collectors.joining("\u001e"));
        String demandSignature = demand.entrySet().stream()
                .map(entry -> entry.getKey() + "=" + entry.getValue())
                .collect(Collectors.joining("\u001e"));
        String warmStartSignature = warmStart.stream()
                .map(use -> use.column().patternWidth() + ":" + use.column().signature()
                        + "#" + use.count())
                .collect(Collectors.joining("\u001e"));
        return new SubproblemKey(poolSignature, demandSignature, exactCars, wasteCap,
                totalWidth, timeLimitMs, warmStartSignature, solveMode, maxGroups);
    }

    static boolean isFeasible(Result result) {
        return result != null && result.groups() > 0
                && ("OPTIMAL".equals(result.status()) || "FEASIBLE".equals(result.status()));
    }

    static ProbeDecision probeDecision(Result result, int challengeGroups) {
        if (isFeasible(result) && result.groups() <= challengeGroups) {
            return ProbeDecision.ACCEPT_GROUP_WITNESS;
        }
        if (result != null && "INFEASIBLE".equals(result.status())) {
            return ProbeDecision.ODD_ONLY;
        }
        return ProbeDecision.FULL_LEXICAL;
    }

    static boolean shouldProbeGroupCap(int donorCount, List<ColumnUse> current) {
        if (groupCapProbeMs() <= 0) {
            return false;
        }
        if (donorCount <= PARITY_DONORS) {
            return true;
        }
        long oddBlocks = current.stream().filter(use -> use.count() % 2 != 0).count();
        return oddBlocks <= groupCapProbeMaxGlobalOdd();
    }

    static void archiveResult(ConcurrentMap<String, Column> archive, Result result) {
        if (result != null) {
            archiveColumns(archive, result.uses().stream().map(ColumnUse::column).toList());
        }
    }

    static void archiveColumns(ConcurrentMap<String, Column> archive, Iterable<Column> columns) {
        for (Column column : columns) {
            if (column != null) {
                archive.putIfAbsent(column.signature(), column);
            }
        }
    }

    static Result solveCached(SubproblemKey key,
            ConcurrentMap<SubproblemKey, Result> cache,
            RefineStats stats,
            Supplier<Result> solverCall) {
        stats.subproblemRequests.incrementAndGet();
        if (!cacheEnabled()) {
            stats.solverCalls.incrementAndGet();
            return solverCall.get();
        }
        AtomicReference<Result> solvedHere = new AtomicReference<>();
        Result cached = cache.compute(key, (ignored, existing) -> {
            if (existing != null) {
                return existing;
            }
            stats.solverCalls.incrementAndGet();
            Result result = solverCall.get();
            solvedHere.set(result);
            return cacheable(result) ? result : null;
        });
        if (solvedHere.get() != null) {
            return solvedHere.get();
        }
        if (cached != null) {
            stats.cacheHits.incrementAndGet();
        }
        return cached;
    }

    private static boolean cacheable(Result result) {
        return result != null
                && ("OPTIMAL".equals(result.status()) || "INFEASIBLE".equals(result.status()));
    }

    private static List<Map<Integer, Integer>> stratifiedShapes(List<Integer> widths,
            int minRw, int maxRw, Map<Integer, Map<String, Integer>> demandByWidth) {
        List<Map<Integer, Integer>> raw = new ArrayList<>();
        enumShapesRec(widths, 0, new LinkedHashMap<>(), 0, minRw, maxRw, raw);
        Map<Integer, List<Map<Integer, Integer>>> byBand = new TreeMap<>(Comparator.reverseOrder());
        for (Map<Integer, Integer> shape : raw) {
            int pw = shape.entrySet().stream().mapToInt(e -> e.getKey() * e.getValue()).sum();
            byBand.computeIfAbsent(pw / 10, k -> new ArrayList<>()).add(shape);
        }
        Comparator<Map<Integer, Integer>> ranking =
                Comparator.comparingLong((Map<Integer, Integer> s) -> -s.entrySet().stream()
                        .mapToLong(e -> (long) e.getValue() * demandByWidth
                                .getOrDefault(e.getKey(), Map.of()).values().stream()
                                .mapToInt(Integer::intValue).sum())
                        .sum());
        List<Map<Integer, Integer>> kept = new ArrayList<>();
        for (List<Map<Integer, Integer>> band : byBand.values()) {
            band.sort(ranking);
            for (int i = 0; i < Math.min(SHAPE_PER_BAND, band.size()) && kept.size() < SHAPE_TOTAL_CAP; i++) {
                kept.add(band.get(i));
            }
            if (kept.size() >= SHAPE_TOTAL_CAP) {
                break;
            }
        }
        return kept;
    }

    private static void enumShapesRec(List<Integer> widths, int idx, Map<Integer, Integer> current,
            int sum, int minRw, int maxRw, List<Map<Integer, Integer>> out) {
        if (out.size() >= SHAPE_RAW_CAP) {
            return;
        }
        if (idx == widths.size()) {
            if (sum >= minRw && sum <= maxRw && !current.isEmpty()) {
                out.add(new LinkedHashMap<>(current));
            }
            return;
        }
        int w = widths.get(idx);
        int maxCount = (maxRw - sum) / w;
        for (int count = 0; count <= maxCount && out.size() < SHAPE_RAW_CAP; count++) {
            if (count > 0) {
                if (!current.containsKey(w) && current.size() >= SHAPE_MAX_DISTINCT) {
                    break;
                }
                current.put(w, count);
            }
            enumShapesRec(widths, idx + 1, current, sum + count * w, minRw, maxRw, out);
        }
        current.remove(w);
    }

    private static Map<Integer, Map<String, Integer>> byWidth(Map<String, Integer> demand) {
        Map<Integer, Map<String, Integer>> byWidth = new TreeMap<>();
        for (Map.Entry<String, Integer> e : demand.entrySet()) {
            String[] parts = e.getKey().split("\\|", 2);
            byWidth.computeIfAbsent(Integer.parseInt(parts[0]), k -> new LinkedHashMap<>())
                    .put(parts[1], e.getValue());
        }
        return byWidth;
    }
}
