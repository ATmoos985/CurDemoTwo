package changyang.cut.apsmodule.generator.NewSolver.mip;

import com.google.ortools.linearsolver.MPConstraint;
import com.google.ortools.linearsolver.MPObjective;
import com.google.ortools.linearsolver.MPSolver;
import com.google.ortools.linearsolver.MPVariable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

import changyang.cut.apsmodule.generator.NewSolver.mip.UnifiedSetPartitionSolver.Column;
import changyang.cut.apsmodule.generator.NewSolver.mip.UnifiedSetPartitionSolver.ColumnUse;
import changyang.cut.apsmodule.generator.NewSolver.mip.UnifiedSetPartitionSolver.LexicographicResult;
import changyang.cut.apsmodule.generator.NewSolver.mip.UnifiedSetPartitionSolver.Result;

/**
 * UnifiedSetPartitionSolver 的 SCIP/CBC MIP 求解引擎与看门狗基础设施。
 */
final class UnifiedSetPartitionMipEngine {

    private static final Logger log = LoggerFactory.getLogger(UnifiedSetPartitionMipEngine.class);

    private static final ScheduledThreadPoolExecutor SOLVER_WATCHDOG = createSolverWatchdog();

    private static final String SCIP_DETERMINISTIC_PARAMS =
            "randomization/randomseedshift = 0\n"
          + "randomization/permutationseed = 0\n"
          + "randomization/lpseed = 0\n";

    /** 奇数车列的次级罚。须保证 Σ罚 < 1（一个组的代价），严格从属于组数目标。 */
    private static final double DEFAULT_ODD_WEIGHT = 0.02;

    enum ObjectivePhase {
        FEASIBILITY,
        GROUPS_WITH_ODD_TIEBREAK,
        GROUPS,
        ODD,
        SMALL,
        ONE
    }

    private UnifiedSetPartitionMipEngine() {
    }

    static LexicographicResult solveLexicographic(List<Column> pool,
            Map<String, Integer> demand,
            int exactCars,
            int wasteCap,
            int totalWidth,
            long timeLimitMsPerPhase,
            List<ColumnUse> warmStart) {
        Result groups = solvePhase(pool, demand, exactCars, wasteCap, totalWidth,
                timeLimitMsPerPhase, 0.0, warmStart, null, null, null, null,
                ObjectivePhase.GROUPS, true);
        if (!isOptimal(groups)) {
            return partialLexicographicResult(groups, List.of());
        }

        Result odd = solvePhase(pool, demand, exactCars, wasteCap, totalWidth,
                timeLimitMsPerPhase, 0.0, groups.uses(), groups.groups(), null, null, null,
                ObjectivePhase.ODD, true);
        if (!isOptimal(odd)) {
            return partialLexicographicResult(odd, List.of(groups));
        }

        Result one = solvePhase(pool, demand, exactCars, wasteCap, totalWidth,
                timeLimitMsPerPhase, 0.0, odd.uses(), groups.groups(), odd.oddBlocks(), null, null,
                ObjectivePhase.ONE, true);
        if (!isOptimal(one)) {
            return partialLexicographicResult(one, List.of(groups, odd));
        }

        Result small = solvePhase(pool, demand, exactCars, wasteCap, totalWidth,
                timeLimitMsPerPhase, 0.0, one.uses(), groups.groups(), odd.oddBlocks(),
                one.oneCarBlocks(), null,
                ObjectivePhase.SMALL, true);
        if (!isOptimal(small)) {
            return partialLexicographicResult(small, List.of(groups, odd, one));
        }
        return new LexicographicResult(small, List.of(groups, odd, one, small), true);
    }

    static Result solvePhase(List<Column> pool,
            Map<String, Integer> demand,
            int exactCars,
            int wasteCap,
            int totalWidth,
            long timeLimitMs,
            double oddWeight,
            List<ColumnUse> warmStart,
            Integer maxGroups,
            Integer maxOdd,
            Integer maxOne,
            Integer maxSmall,
            ObjectivePhase objectivePhase,
            boolean stableColumnOrder) {
        return solvePhase(pool, demand, exactCars, wasteCap, totalWidth, timeLimitMs,
                oddWeight, warmStart, maxGroups, maxOdd, maxOne, maxSmall,
                objectivePhase, stableColumnOrder, null);
    }

    static Result solvePhase(List<Column> pool,
            Map<String, Integer> demand,
            int exactCars,
            int wasteCap,
            int totalWidth,
            long timeLimitMs,
            double oddWeight,
            List<ColumnUse> warmStart,
            Integer maxGroups,
            Integer maxOdd,
            Integer maxOne,
            Integer maxSmall,
            ObjectivePhase objectivePhase,
            boolean stableColumnOrder,
            Long nodeLimit) {
        if (oddWeight < 0) {
            oddWeight = DEFAULT_ODD_WEIGHT;
        }
        // 去重 + 支持度过滤（列的每个 (w,m) 消耗不得超过需求）
        List<Column> columns;
        if (stableColumnOrder) {
            ExecutableColumnPool.Normalized normalized = ExecutableColumnPool.normalize(
                    pool, demand, wasteCap, totalWidth);
            columns = new ArrayList<>(normalized.columns());
            ExecutableColumnPool.Stats stats = normalized.stats();
            log.info("UnifiedSP normalized pool: retained={} input={} duplicates={} "
                            + "unsupported={} invalidWidth={} overWasteCap={}",
                    stats.retainedColumns(), stats.inputColumns(), stats.duplicateColumns(),
                    stats.unsupportedColumns(), stats.invalidWidthColumns(),
                    stats.overWasteCapColumns());
        } else {
            Map<String, Column> bySig = new LinkedHashMap<>();
            for (Column column : pool) {
                if (UnifiedSetPartitionSolver.supportOf(column, demand) >= 1) {
                    bySig.putIfAbsent(column.signature(), column);
                }
            }
            columns = new ArrayList<>(bySig.values());
        }
        log.info("UnifiedSP: pool={} (deduped from {}), demandKeys={}, cars={}, wasteCap={}",
                columns.size(), pool.size(), demand.size(), exactCars, wasteCap);

        MPSolver solver = MPSolver.createSolver("SCIP");
        if (solver == null) {
            solver = MPSolver.createSolver("CBC");
        }
        if (solver == null) {
            return null;
        }
        String solverParameters = SCIP_DETERMINISTIC_PARAMS;
        if (nodeLimit != null) {
            solverParameters += "limits/nodes = " + nodeLimit + "\n";
        }
        solver.setSolverSpecificParametersAsString(solverParameters);
        try { solver.setNumThreads(1); } catch (Exception ignored) { }

        int n = columns.size();
        MPVariable[] c = new MPVariable[n];
        MPVariable[] y = new MPVariable[n];
        boolean needsOdd = maxOdd != null
                || objectivePhase == ObjectivePhase.ODD
                || objectivePhase == ObjectivePhase.SMALL
                || objectivePhase == ObjectivePhase.GROUPS_WITH_ODD_TIEBREAK;
        boolean forbidsOne = maxOne != null && maxOne == 0
                && objectivePhase != ObjectivePhase.ONE;
        boolean needsOne = (maxOne != null && !forbidsOne)
                || objectivePhase == ObjectivePhase.ONE;
        boolean needsSmall = maxSmall != null || objectivePhase == ObjectivePhase.SMALL;
        MPVariable[] o = needsOdd ? new MPVariable[n] : null;
        MPVariable[] h = needsOdd ? new MPVariable[n] : null;
        MPVariable[] one = needsOne ? new MPVariable[n] : null;
        MPVariable[] s = needsSmall ? new MPVariable[n] : null;
        for (int j = 0; j < n; j++) {
            int support = Math.min(exactCars, UnifiedSetPartitionSolver.supportOf(columns.get(j), demand));
            c[j] = solver.makeIntVar(0, support, "c_" + j);
            y[j] = solver.makeBoolVar("y_" + j);
            // c <= support*y ; c >= y
            MPConstraint upper = solver.makeConstraint(-MPSolver.infinity(), 0, "ub_" + j);
            upper.setCoefficient(c[j], 1);
            upper.setCoefficient(y[j], -support);
            MPConstraint lower = solver.makeConstraint(0, MPSolver.infinity(), "lb_" + j);
            lower.setCoefficient(c[j], 1);
            lower.setCoefficient(y[j], forbidsOne ? -2 : -1);
            if (needsOdd) {
                o[j] = solver.makeBoolVar("o_" + j);
                h[j] = solver.makeIntVar(0, support, "h_" + j);
                MPConstraint parity = solver.makeConstraint(0, 0, "par_" + j);
                parity.setCoefficient(c[j], 1);
                parity.setCoefficient(h[j], -2);
                parity.setCoefficient(o[j], -1);
            }
            if (needsOne) {
                one[j] = solver.makeBoolVar("one_" + j);
                MPConstraint oneEnabled = solver.makeConstraint(
                        -MPSolver.infinity(), 0, "one_enabled_" + j);
                oneEnabled.setCoefficient(one[j], 1);
                oneEnabled.setCoefficient(y[j], -1);
                MPConstraint nonOneMinimum = solver.makeConstraint(
                        0, MPSolver.infinity(), "non_one_min_" + j);
                nonOneMinimum.setCoefficient(c[j], 1);
                nonOneMinimum.setCoefficient(y[j], -2);
                nonOneMinimum.setCoefficient(one[j], 1);
                MPConstraint oneMaximum = solver.makeConstraint(
                        -MPSolver.infinity(), support, "one_max_" + j);
                oneMaximum.setCoefficient(c[j], 1);
                oneMaximum.setCoefficient(one[j], support - 1);
            }
            if (needsSmall) {
                s[j] = solver.makeBoolVar("s_" + j);
                // s=1 iff the enabled column is used by 1..5 cars.
                MPConstraint smallEnabled = solver.makeConstraint(
                        -MPSolver.infinity(), 0, "small_enabled_" + j);
                smallEnabled.setCoefficient(s[j], 1);
                smallEnabled.setCoefficient(y[j], -1);
                MPConstraint nonSmallMinimum = solver.makeConstraint(
                        0, MPSolver.infinity(), "non_small_min_" + j);
                nonSmallMinimum.setCoefficient(c[j], 1);
                nonSmallMinimum.setCoefficient(y[j], -6);
                nonSmallMinimum.setCoefficient(s[j], 6);
            }
        }

        if (warmStart != null && !warmStart.isEmpty()) {
            Map<String, Integer> hintCounts = new LinkedHashMap<>();
            for (ColumnUse use : warmStart) {
                hintCounts.merge(use.column().signature(), use.count(), Integer::sum);
            }
            int variablesPerColumn = 2 + (needsOdd ? 2 : 0)
                    + (needsOne ? 1 : 0) + (needsSmall ? 1 : 0);
            List<MPVariable> hintVars = new ArrayList<>(n * variablesPerColumn);
            List<Double> hintValues = new ArrayList<>(n * variablesPerColumn);
            int matched = 0;
            for (int j = 0; j < n; j++) {
                int count = hintCounts.getOrDefault(columns.get(j).signature(), 0);
                if (count > 0) {
                    matched++;
                }
                hintVars.add(c[j]);
                hintValues.add((double) count);
                hintVars.add(y[j]);
                hintValues.add(count > 0 ? 1.0 : 0.0);
                if (needsOdd) {
                    hintVars.add(o[j]);
                    hintValues.add(count % 2 != 0 ? 1.0 : 0.0);
                    hintVars.add(h[j]);
                    hintValues.add((double) (count / 2));
                }
                if (needsOne) {
                    hintVars.add(one[j]);
                    hintValues.add(count == 1 ? 1.0 : 0.0);
                }
                if (needsSmall) {
                    hintVars.add(s[j]);
                    hintValues.add(count > 0 && count <= 5 ? 1.0 : 0.0);
                }
            }
            double[] values = new double[hintValues.size()];
            for (int i = 0; i < values.length; i++) {
                values[i] = hintValues.get(i);
            }
            solver.setHint(hintVars.toArray(new MPVariable[0]), values);
            log.info("UnifiedSP warm start: {} hint columns matched into pool", matched);
        }

        // 需求精确覆盖
        Map<String, MPConstraint> demandConstraints = new LinkedHashMap<>();
        for (Map.Entry<String, Integer> e : demand.entrySet()) {
            demandConstraints.put(e.getKey(),
                    solver.makeConstraint(e.getValue(), e.getValue(), "d_" + e.getKey()));
        }
        for (int j = 0; j < n; j++) {
            for (Map.Entry<String, Integer> use : columns.get(j).demandUse().entrySet()) {
                MPConstraint constraint = demandConstraints.get(use.getKey());
                if (constraint == null) {
                    // 列消耗了不存在的需求键——支持度过滤应已排除
                    return null;
                }
                constraint.setCoefficient(c[j], use.getValue());
            }
        }

        MPConstraint carsConstraint = solver.makeConstraint(exactCars, exactCars, "cars");
        for (int j = 0; j < n; j++) {
            carsConstraint.setCoefficient(c[j], 1);
        }
        MPConstraint wasteConstraint = solver.makeConstraint(0, wasteCap, "waste");
        for (int j = 0; j < n; j++) {
            wasteConstraint.setCoefficient(c[j], totalWidth - columns.get(j).patternWidth());
        }

        MPObjective objective = solver.objective();
        if (maxGroups != null) {
            MPConstraint groupsCap = solver.makeConstraint(0, maxGroups, "groupsCap");
            for (int j = 0; j < n; j++) {
                groupsCap.setCoefficient(y[j], 1);
            }
        }
        if (maxOdd != null) {
            MPConstraint oddCap = solver.makeConstraint(0, maxOdd, "oddCap");
            for (int j = 0; j < n; j++) {
                oddCap.setCoefficient(o[j], 1);
            }
        }
        if (maxOne != null && one != null) {
            MPConstraint oneCap = solver.makeConstraint(0, maxOne, "oneCap");
            for (int j = 0; j < n; j++) {
                oneCap.setCoefficient(one[j], 1);
            }
        }
        if (maxSmall != null) {
            MPConstraint smallCap = solver.makeConstraint(0, maxSmall, "smallCap");
            for (int j = 0; j < n; j++) {
                smallCap.setCoefficient(s[j], 1);
            }
        }
        for (int j = 0; j < n; j++) {
            switch (objectivePhase) {
            case FEASIBILITY -> {
                // Zero objective: ask only for a witness or an infeasibility proof.
            }
            case GROUPS_WITH_ODD_TIEBREAK -> {
                objective.setCoefficient(y[j], 1.0);
                objective.setCoefficient(o[j], oddWeight);
            }
            case GROUPS -> objective.setCoefficient(y[j], 1.0);
            case ODD -> objective.setCoefficient(o[j], 1.0);
            case ONE -> objective.setCoefficient(one[j], 1.0);
            case SMALL -> objective.setCoefficient(s[j], 1.0);
            }
        }
        objective.setMinimization();

        long effectiveTimeLimitMs = Math.max(1000, timeLimitMs);
        long startedAt = System.currentTimeMillis();
        MPSolver.ResultStatus status = solveWithDeadline(solver, effectiveTimeLimitMs);
        long elapsedMs = System.currentTimeMillis() - startedAt;
        long nodes = safeNodes(solver);
        boolean hasSolution = status == MPSolver.ResultStatus.OPTIMAL
                || status == MPSolver.ResultStatus.FEASIBLE;
        double objectiveValue = hasSolution ? safeObjectiveValue(objective) : Double.NaN;
        double bestBound = hasSolution ? safeBestBound(objective) : Double.NaN;
        if (!hasSolution) {
            log.warn("UnifiedSP returned {}", status);
            return new Result(List.of(), 0, 0, 0, 0, 0, 0, status.toString(),
                    objectiveValue, bestBound, nodes, elapsedMs);
        }

        List<ColumnUse> uses = new ArrayList<>();
        int cars = 0;
        int waste = 0;
        int odd = 0;
        int oneCar = 0;
        int small = 0;
        for (int j = 0; j < n; j++) {
            int count = (int) Math.round(c[j].solutionValue());
            if (count <= 0) {
                continue;
            }
            uses.add(new ColumnUse(columns.get(j), count));
            cars += count;
            waste += count * (totalWidth - columns.get(j).patternWidth());
            if (count % 2 != 0) {
                odd++;
            }
            if (count == 1) {
                oneCar++;
            }
            if (count <= 5) {
                small++;
            }
        }
        uses.sort(Comparator.comparingInt((ColumnUse u) -> u.count()).reversed());
        Result result = new Result(uses, uses.size(), odd, oneCar, small, cars, waste,
                status.toString(), objectiveValue, bestBound, nodes, elapsedMs);
        log.info("UnifiedSP solved: {} groups={} odd={} one={} small={} cars={} waste={} "
                        + "objective={} bound={} gap={} nodes={} elapsedMs={} sig#={}",
                status, uses.size(), odd, oneCar, small, cars, waste,
                objectiveValue, bestBound, result.relativeGap(), nodes, elapsedMs,
                result.signature().hashCode());
        return result;
    }

    private static MPSolver.ResultStatus solveWithDeadline(MPSolver solver, long timeLimitMs) {
        solver.setTimeLimit(timeLimitMs);
        ScheduledFuture<?> interrupt = SOLVER_WATCHDOG.schedule(() -> {
            boolean supported = solver.interruptSolve();
            log.warn("UnifiedSP deadline reached: requested interrupt after {}ms, supported={}",
                    timeLimitMs, supported);
        }, timeLimitMs, TimeUnit.MILLISECONDS);
        try {
            return solver.solve();
        } finally {
            interrupt.cancel(false);
        }
    }

    private static ScheduledThreadPoolExecutor createSolverWatchdog() {
        ScheduledThreadPoolExecutor executor = new ScheduledThreadPoolExecutor(1, runnable -> {
            Thread thread = new Thread(runnable, "unified-sp-watchdog");
            thread.setDaemon(true);
            return thread;
        });
        executor.setRemoveOnCancelPolicy(true);
        return executor;
    }

    private static boolean isOptimal(Result result) {
        return result != null && MPSolver.ResultStatus.OPTIMAL.toString().equals(result.status());
    }

    private static LexicographicResult partialLexicographicResult(
            Result latest, List<Result> completed) {
        List<Result> phases = new ArrayList<>(completed);
        if (latest != null) {
            phases.add(latest);
        }
        return new LexicographicResult(latest, List.copyOf(phases), false);
    }

    private static double safeObjectiveValue(MPObjective objective) {
        try {
            return objective.value();
        } catch (Throwable ignored) {
            return Double.NaN;
        }
    }

    private static double safeBestBound(MPObjective objective) {
        try {
            return objective.bestBound();
        } catch (Throwable ignored) {
            return Double.NaN;
        }
    }

    private static long safeNodes(MPSolver solver) {
        try {
            return solver.nodes();
        } catch (Throwable ignored) {
            return -1L;
        }
    }
}
