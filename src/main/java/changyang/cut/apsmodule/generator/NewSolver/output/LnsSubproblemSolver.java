package changyang.cut.apsmodule.generator.NewSolver.output;

import com.google.ortools.linearsolver.MPConstraint;
import com.google.ortools.linearsolver.MPObjective;
import com.google.ortools.linearsolver.MPSolver;
import com.google.ortools.linearsolver.MPVariable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverRuntimeProperties;
import changyang.cut.apsmodule.generator.NewSolver.output.LnsModelAndInstructionSupport.Column;
import changyang.cut.apsmodule.generator.NewSolver.output.LnsModelAndInstructionSupport.DemandKey;
import changyang.cut.apsmodule.generator.NewSolver.output.LnsModelAndInstructionSupport.Neighborhood;
import changyang.cut.apsmodule.generator.NewSolver.output.LnsModelAndInstructionSupport.PatternKey;
import changyang.cut.apsmodule.generator.NewSolver.output.LnsModelAndInstructionSupport.RollRecord;
import changyang.cut.apsmodule.generator.NewSolver.output.LnsModelAndInstructionSupport.SolveAttempt;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * LocalNeighborhoodSequenceOptimizer 的列枚举与 SCIP/CBC 邻域子 MIP 求解器。
 */
final class LnsSubproblemSolver {

    private static final Logger log = LoggerFactory.getLogger(LnsSubproblemSolver.class);

    private static final int DEFAULT_MAX_COLUMNS = 3000;
    private static final long DEFAULT_TIME_LIMIT_MS = 120000L;
    private static final long DEFAULT_SCIP_NODE_LIMIT = 15000L;
    private static final int DEFAULT_COLUMN_ENUMERATION_GUARD = 50000;
    private static final String SCIP_DETERMINISTIC_PARAMS =
            "randomization/randomseedshift = 0\n"
          + "randomization/permutationseed = 0\n"
          + "randomization/lpseed = 0\n";

    private record SolveSolution(String status, Map<Integer, Integer> counts, int activeColumns) {
    }

    private record WidthOption(int width, List<String> messages, Map<String, Integer> demandCounts) {
    }

    LnsSubproblemSolver() {
    }

    int currentActiveColumns(Neighborhood neighborhood) {
        return (int) neighborhood.selectedRolls().stream()
                .map(roll -> new Column(roll.pattern(), roll.config(), roll.demandCounts(), true).signature())
                .distinct()
                .count();
    }

    SolveAttempt solveNeighborhood(Neighborhood neighborhood, long deadlineMs) {
        long start = System.currentTimeMillis();
        if (start >= deadlineMs) {
            return SolveAttempt.infeasible("budget-reached", List.of(), 0L);
        }
        if (currentActiveColumns(neighborhood) <= 1) {
            return SolveAttempt.infeasible("already-single-column", List.of(), 0L);
        }
        List<Column> columns = buildColumns(neighborhood);
        if (columns.isEmpty()) {
            return SolveAttempt.infeasible("no-columns", columns, 0L);
        }

        SolveSolution stage1 = solveColumns(neighborhood, columns, null, false, deadlineMs);
        if (stage1 == null || stage1.counts().isEmpty()) {
            return SolveAttempt.infeasible("stage1-infeasible", columns, System.currentTimeMillis() - start);
        }

        SolveSolution best = stage1;
        if (SolverRuntimeProperties.getBoolean("cutting.lns.secondary", false)
                && System.currentTimeMillis() < deadlineMs) {
            SolveSolution stage2 = solveColumns(neighborhood, columns, stage1.activeColumns(), true, deadlineMs);
            if (stage2 != null && !stage2.counts().isEmpty()) {
                best = stage2;
            }
        }
        return new SolveAttempt(true, best.status(), columns, best.counts(), System.currentTimeMillis() - start);
    }

    private SolveSolution solveColumns(Neighborhood neighborhood, List<Column> columns,
            Integer activeCap, boolean secondaryObjective, long deadlineMs) {
        MPSolver solver = null;
        try {
            long remainingMs = deadlineMs == Long.MAX_VALUE
                    ? Long.MAX_VALUE
                    : deadlineMs - System.currentTimeMillis();
            if (remainingMs <= 0L) {
                return null;
            }
            solver = MPSolver.createSolver("SCIP");
            if (solver != null) {
                String scipParams = SCIP_DETERMINISTIC_PARAMS;
                long nodeLimit = SolverRuntimeProperties.getLong("cutting.lns.scipNodeLimit", DEFAULT_SCIP_NODE_LIMIT);
                if (nodeLimit > 0) {
                    scipParams = scipParams + "limits/nodes = " + nodeLimit + "\n";
                }
                solver.setSolverSpecificParametersAsString(scipParams);
                try {
                    solver.setNumThreads(1);
                } catch (Exception ignored) {
                }
            } else {
                solver = MPSolver.createSolver("CBC");
            }
            if (solver == null) {
                return null;
            }

            int columnCount = columns.size();
            MPVariable[] nVars = new MPVariable[columnCount];
            MPVariable[] yVars = new MPVariable[columnCount];
            MPVariable[] oddVars = new MPVariable[columnCount];
            MPVariable[] largeVars = new MPVariable[columnCount];
            MPVariable[] halfVars = new MPVariable[columnCount];

            for (int i = 0; i < columnCount; i++) {
                nVars[i] = solver.makeIntVar(0, neighborhood.cars(), "n_" + i);
                yVars[i] = solver.makeBoolVar("y_" + i);

                MPConstraint upper = solver.makeConstraint(-MPSolver.infinity(), 0, "link_upper_" + i);
                upper.setCoefficient(nVars[i], 1);
                upper.setCoefficient(yVars[i], -neighborhood.cars());

                MPConstraint lower = solver.makeConstraint(0, MPSolver.infinity(), "link_lower_" + i);
                lower.setCoefficient(nVars[i], 1);
                lower.setCoefficient(yVars[i], -1);

                if (secondaryObjective) {
                    oddVars[i] = solver.makeBoolVar("odd_" + i);
                    largeVars[i] = solver.makeBoolVar("large_" + i);
                    halfVars[i] = solver.makeIntVar(0, neighborhood.cars(), "half_" + i);

                    MPConstraint parity = solver.makeConstraint(0, 0, "parity_" + i);
                    parity.setCoefficient(nVars[i], 1);
                    parity.setCoefficient(halfVars[i], -2);
                    parity.setCoefficient(oddVars[i], -1);

                    MPConstraint oddActive = solver.makeConstraint(-MPSolver.infinity(), 0, "odd_active_" + i);
                    oddActive.setCoefficient(oddVars[i], 1);
                    oddActive.setCoefficient(yVars[i], -1);

                    MPConstraint largeActive = solver.makeConstraint(-MPSolver.infinity(), 0, "large_active_" + i);
                    largeActive.setCoefficient(largeVars[i], 1);
                    largeActive.setCoefficient(yVars[i], -1);

                    MPConstraint largeLower = solver.makeConstraint(0, MPSolver.infinity(), "large_lower_" + i);
                    largeLower.setCoefficient(nVars[i], 1);
                    largeLower.setCoefficient(largeVars[i], -6);

                    MPConstraint largeUpper = solver.makeConstraint(-MPSolver.infinity(), 0, "large_upper_" + i);
                    largeUpper.setCoefficient(nVars[i], 1);
                    largeUpper.setCoefficient(yVars[i], -5);
                    largeUpper.setCoefficient(largeVars[i], -neighborhood.cars());
                }
            }

            for (Map.Entry<String, Integer> demand : neighborhood.freeDemand().entrySet()) {
                MPConstraint constraint = solver.makeConstraint(demand.getValue(), demand.getValue(),
                        "demand_" + Math.abs(demand.getKey().hashCode()));
                for (int i = 0; i < columnCount; i++) {
                    int contribution = columns.get(i).demandCounts().getOrDefault(demand.getKey(), 0);
                    if (contribution > 0) {
                        constraint.setCoefficient(nVars[i], contribution);
                    }
                }
            }

            MPConstraint cars = solver.makeConstraint(neighborhood.cars(), neighborhood.cars(), "cars");
            MPConstraint waste = solver.makeConstraint(neighborhood.waste(), neighborhood.waste(), "waste");
            MPConstraint active = activeCap == null
                    ? null
                    : solver.makeConstraint(0, activeCap, "active_cap");
            for (int i = 0; i < columnCount; i++) {
                cars.setCoefficient(nVars[i], 1);
                waste.setCoefficient(nVars[i], columns.get(i).pattern().waste());
                if (active != null) {
                    active.setCoefficient(yVars[i], 1);
                }
            }

            MPObjective objective = solver.objective();
            for (int i = 0; i < columnCount; i++) {
                if (secondaryObjective) {
                    int splitCost = columns.get(i).demandCounts().size();
                    objective.setCoefficient(yVars[i], 100.0 + splitCost);
                    objective.setCoefficient(largeVars[i], -100.0);
                    objective.setCoefficient(oddVars[i], 10.0);
                } else {
                    objective.setCoefficient(yVars[i], 1.0);
                }
            }
            objective.setMinimization();

            long configuredLimitMs = SolverRuntimeProperties.getLong("cutting.lns.timeLimitMs", DEFAULT_TIME_LIMIT_MS);
            long effectiveTimeLimitMs = deadlineMs == Long.MAX_VALUE
                    ? configuredLimitMs
                    : Math.min(configuredLimitMs, Math.max(200L, deadlineMs - System.currentTimeMillis()));
            solver.setTimeLimit(effectiveTimeLimitMs);
            MPSolver.ResultStatus status = solver.solve();
            if (status != MPSolver.ResultStatus.OPTIMAL && status != MPSolver.ResultStatus.FEASIBLE) {
                return null;
            }
            if (status == MPSolver.ResultStatus.FEASIBLE) {
                log.warn("LNS neighbourhood solve FEASIBLE not OPTIMAL (columns={}, secondary={}) — "
                        + "determinism risk; shrink neighbourhood/columns", columnCount, secondaryObjective);
            }

            Map<Integer, Integer> counts = new LinkedHashMap<>();
            int activeColumns = 0;
            for (int i = 0; i < columnCount; i++) {
                int count = (int) Math.round(nVars[i].solutionValue());
                if (count > 0) {
                    counts.put(i, count);
                    activeColumns++;
                }
            }
            return new SolveSolution(status.name(), counts, activeColumns);
        } catch (Exception e) {
            log.warn("LNS neighbourhood solve failed", e);
            return null;
        } finally {
            if (solver != null) {
                solver.delete();
            }
        }
    }

    private List<Column> buildColumns(Neighborhood neighborhood) {
        Map<String, Column> required = new LinkedHashMap<>();
        for (RollRecord roll : neighborhood.selectedRolls()) {
            Column column = new Column(roll.pattern(), roll.config(), roll.demandCounts(), true);
            required.putIfAbsent(column.signature(), column);
        }

        int perPatternCap = SolverRuntimeProperties.getInt("cutting.lns.maxColumnsPerPattern", 1000);
        List<Column> enumerated = new ArrayList<>();
        for (PatternKey pattern : neighborhood.patterns()) {
            List<Column> patternColumns = enumerateColumns(pattern, neighborhood.freeDemand());
            if (patternColumns.size() > perPatternCap) {
                patternColumns = patternColumns.stream()
                        .sorted(Comparator
                                .comparingInt((Column column) -> maxSupport(column, neighborhood.freeDemand())).reversed()
                                .thenComparing(Comparator.comparingInt((Column column) -> column.demandCounts().size()).reversed())
                                .thenComparing(Column::signature))
                        .limit(perPatternCap)
                        .toList();
            }
            enumerated.addAll(patternColumns);
            if (enumerated.size() > columnEnumerationGuard()) {
                break;
            }
        }
        enumerated.sort(Comparator
                .comparingInt((Column column) -> maxSupport(column, neighborhood.freeDemand())).reversed()
                .thenComparing(Comparator.comparingInt((Column column) -> column.demandCounts().size()).reversed())
                .thenComparing(Column::signature));

        List<Column> columns = new ArrayList<>(required.values());
        Set<String> seen = required.keySet().stream().collect(Collectors.toCollection(HashSet::new));
        int discarded = 0;
        int maxColumns = maxColumns();
        for (Column column : enumerated) {
            if (!seen.add(column.signature())) {
                continue;
            }
            if (columns.size() >= maxColumns) {
                discarded++;
                continue;
            }
            columns.add(column);
        }

        log.debug("LNS column pool: required={} enumerated={} kept={} discarded={}",
                required.size(), enumerated.size(), columns.size(), discarded);
        return columns;
    }

    private int maxColumns() {
        return SolverRuntimeProperties.getInt("cutting.lns.maxColumns", DEFAULT_MAX_COLUMNS);
    }

    private int columnEnumerationGuard() {
        return SolverRuntimeProperties.getInt(
                "cutting.lns.columnEnumerationGuard", DEFAULT_COLUMN_ENUMERATION_GUARD);
    }

    private List<Column> enumerateColumns(PatternKey pattern, Map<String, Integer> freeDemand) {
        Map<Integer, List<String>> messagesByWidth = new LinkedHashMap<>();
        for (String key : freeDemand.keySet()) {
            DemandKey demandKey = DemandKey.parse(key);
            messagesByWidth.computeIfAbsent(demandKey.width(), ignored -> new ArrayList<>())
                    .add(demandKey.message());
        }
        for (List<String> messages : messagesByWidth.values()) {
            messages.sort(Comparator
                    .comparingInt((String message) -> demandForMessage(messagesByWidth, freeDemand, message)).reversed()
                    .thenComparing(message -> message));
        }

        List<Map.Entry<Integer, Integer>> widths = new ArrayList<>(pattern.subRolls().entrySet());
        List<List<WidthOption>> optionsByWidth = new ArrayList<>();
        for (Map.Entry<Integer, Integer> width : widths) {
            List<String> messages = messagesByWidth.getOrDefault(width.getKey(), List.of());
            if (messages.isEmpty()) {
                return List.of();
            }
            List<WidthOption> options = new ArrayList<>();
            buildWidthOptions(width.getKey(), width.getValue(), messages, freeDemand, 0,
                    new ArrayList<>(), options);
            if (options.isEmpty()) {
                return List.of();
            }
            optionsByWidth.add(options);
        }

        List<Column> columns = new ArrayList<>();
        buildColumnsForPattern(pattern, widths, optionsByWidth, 0, new LinkedHashMap<>(), columns, freeDemand);
        return columns;
    }

    private int demandForMessage(Map<Integer, List<String>> messagesByWidth,
            Map<String, Integer> freeDemand,
            String message) {
        int total = 0;
        for (Integer width : messagesByWidth.keySet()) {
            total += freeDemand.getOrDefault(LnsModelAndInstructionSupport.demandKey(width, message), 0);
        }
        return total;
    }

    private void buildWidthOptions(int width, int slots, List<String> messages,
            Map<String, Integer> freeDemand, int start, List<String> current,
            List<WidthOption> result) {
        if (current.size() == slots) {
            Map<String, Integer> counts = new LinkedHashMap<>();
            for (String message : current) {
                counts.merge(LnsModelAndInstructionSupport.demandKey(width, message), 1, Integer::sum);
            }
            for (Map.Entry<String, Integer> entry : counts.entrySet()) {
                if (entry.getValue() > freeDemand.getOrDefault(entry.getKey(), 0)) {
                    return;
                }
            }
            result.add(new WidthOption(width, List.copyOf(current), counts));
            return;
        }
        for (int i = start; i < messages.size(); i++) {
            current.add(messages.get(i));
            buildWidthOptions(width, slots, messages, freeDemand, i, current, result);
            current.remove(current.size() - 1);
        }
    }

    private void buildColumnsForPattern(PatternKey pattern,
            List<Map.Entry<Integer, Integer>> widths,
            List<List<WidthOption>> optionsByWidth,
            int offset,
            Map<Integer, List<String>> config,
            List<Column> columns,
            Map<String, Integer> freeDemand) {
        if (columns.size() >= columnEnumerationGuard()) {
            return;
        }
        if (offset == widths.size()) {
            Map<String, Integer> counts = new LinkedHashMap<>();
            for (Map.Entry<Integer, List<String>> configEntry : config.entrySet()) {
                int width = configEntry.getKey();
                List<String> messages = configEntry.getValue();
                for (String message : messages) {
                    counts.merge(LnsModelAndInstructionSupport.demandKey(width, message), 1, Integer::sum);
                }
            }
            for (Map.Entry<String, Integer> entry : counts.entrySet()) {
                if (entry.getValue() > freeDemand.getOrDefault(entry.getKey(), 0)) {
                    return;
                }
            }
            columns.add(new Column(
                    pattern, LnsModelAndInstructionSupport.copyConfig(config), counts, false));
            return;
        }

        int width = widths.get(offset).getKey();
        for (WidthOption option : optionsByWidth.get(offset)) {
            config.put(width, option.messages());
            buildColumnsForPattern(pattern, widths, optionsByWidth, offset + 1, config, columns, freeDemand);
            config.remove(width);
            if (columns.size() >= columnEnumerationGuard()) {
                return;
            }
        }
    }

    private int maxSupport(Column column, Map<String, Integer> freeDemand) {
        int support = Integer.MAX_VALUE;
        for (Map.Entry<String, Integer> entry : column.demandCounts().entrySet()) {
            if (entry.getValue() > 0) {
                support = Math.min(support, freeDemand.getOrDefault(entry.getKey(), 0) / entry.getValue());
            }
        }
        return support == Integer.MAX_VALUE ? 0 : support;
    }
}
