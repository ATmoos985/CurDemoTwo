package changyang.cut.apsmodule.generator.NewSolver.output;

import changyang.cut.apsmodule.service.CuttingInstruction;
import changyang.cut.apsmodule.service.StationAssignment;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Queue;
import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Collectors;

/**
 * LocalNeighborhoodSequenceOptimizer 的共享领域记录与指令分解/重建工具。
 */
final class LnsModelAndInstructionSupport {

    record Neighborhood(
            List<String> seedKeys,
            Set<Integer> selectedRollIndexes,
            Map<String, Integer> freeDemand,
            List<PatternKey> patterns,
            List<RollRecord> selectedRolls,
            int cars,
            int waste) {
    }

    record SolveAttempt(
            boolean feasible,
            String status,
            List<Column> columns,
            Map<Integer, Integer> counts,
            long elapsedMs) {

        static SolveAttempt infeasible(String reason, List<Column> columns, long elapsedMs) {
            return new SolveAttempt(false, reason, columns, Map.of(), elapsedMs);
        }

        String reason() {
            return status;
        }

        int activeColumns() {
            return counts.size();
        }
    }

    record RollRecord(
            int index,
            PatternKey pattern,
            List<StationAssignment> assignments,
            Map<Integer, List<String>> config,
            Map<String, Integer> demandCounts,
            String configSignature) {
    }

    record Column(
            PatternKey pattern,
            Map<Integer, List<String>> config,
            Map<String, Integer> demandCounts,
            boolean required) {

        String signature() {
            return pattern.signature() + "@@" + config.entrySet().stream()
                    .map(entry -> entry.getKey() + "=" + String.join("/", entry.getValue()))
                    .collect(Collectors.joining("|"));
        }
    }

    record PatternKey(
            String groupKey,
            int rollWidth,
            int length,
            String surfaceTreatment,
            int thickness,
            Map<Integer, Integer> subRolls,
            int patternWidth,
            int waste) {

        static PatternKey from(CuttingInstruction instruction) {
            return new PatternKey(
                    instruction.getGroupKey(),
                    instruction.getRollWidth(),
                    instruction.getLength(),
                    instruction.getSurfaceTreatment(),
                    instruction.getThickness(),
                    new LinkedHashMap<>(instruction.getSubRolls()),
                    instruction.getPatternWidth(),
                    instruction.getWaste());
        }

        String signature() {
            return rollWidth + "|" + subRolls.entrySet().stream()
                    .map(entry -> entry.getKey() + "x" + entry.getValue())
                    .collect(Collectors.joining(","));
        }
    }

    record DemandKey(int width, String message) {

        static DemandKey parse(String key) {
            String[] parts = key.split("\\|", 2);
            return new DemandKey(Integer.parseInt(parts[0]), parts.length > 1 ? parts[1] : "");
        }
    }

    private LnsModelAndInstructionSupport() {
    }

    static String solutionSignature(List<CuttingInstruction> instructions) {
        List<String> rollSignatures = new ArrayList<>();
        for (RollRecord roll : decompose(instructions)) {
            rollSignatures.add(roll.configSignature());
        }
        rollSignatures.sort(Comparator.naturalOrder());
        return String.join(";", rollSignatures);
    }

    static int fragmentationScore(List<CuttingInstruction> instructions) {
        Map<String, Set<String>> configsByDemand = new HashMap<>();
        for (RollRecord roll : decompose(instructions)) {
            for (String demand : roll.demandCounts().keySet()) {
                configsByDemand.computeIfAbsent(demand, ignored -> new HashSet<>())
                        .add(roll.configSignature());
            }
        }
        int score = 0;
        for (Set<String> configs : configsByDemand.values()) {
            score += Math.max(0, configs.size() - 1);
        }
        return score;
    }

    static List<CuttingInstruction> rebuildWithNeighborhoodSolution(
            List<RollRecord> rolls,
            Neighborhood neighborhood,
            SolveAttempt attempt) {
        Set<Integer> selected = neighborhood.selectedRollIndexes();
        int insertAt = selected.stream().mapToInt(Integer::intValue).min().orElse(0);
        List<CuttingInstruction> result = new ArrayList<>();
        List<RollRecord> run = new ArrayList<>();
        PatternKey runPattern = null;
        boolean inserted = false;

        for (RollRecord roll : rolls) {
            if (roll.index() == insertAt && !inserted) {
                flushRun(result, run, runPattern);
                run = new ArrayList<>();
                runPattern = null;
                result.addAll(buildInstructionsFromColumns(attempt));
                inserted = true;
            }
            if (selected.contains(roll.index())) {
                continue;
            }
            if (runPattern == null || !runPattern.equals(roll.pattern())) {
                flushRun(result, run, runPattern);
                run = new ArrayList<>();
                runPattern = roll.pattern();
            }
            run.add(roll);
        }
        flushRun(result, run, runPattern);
        if (!inserted) {
            result.addAll(buildInstructionsFromColumns(attempt));
        }
        return result;
    }

    static List<CuttingInstruction> buildInstructionsFromColumns(SolveAttempt attempt) {
        List<CuttingInstruction> result = new ArrayList<>();
        for (Map.Entry<Integer, Integer> entry : attempt.counts().entrySet()) {
            Column column = attempt.columns().get(entry.getKey());
            CuttingInstruction instruction = createInstruction(column.pattern(), entry.getValue());
            List<StationAssignment> assignments = new ArrayList<>();
            for (int i = 0; i < entry.getValue(); i++) {
                for (Map.Entry<Integer, Integer> subRoll : column.pattern().subRolls().entrySet()) {
                    List<String> messages = column.config().getOrDefault(subRoll.getKey(), List.of());
                    for (String message : messages) {
                        assignments.add(new StationAssignment(subRoll.getKey(), message));
                    }
                }
            }
            instruction.setStationAssignments(assignments);
            result.add(instruction);
        }
        result.sort(Comparator.comparing(LnsModelAndInstructionSupport::instructionRollSignature)
                .thenComparing(CuttingInstruction::getUsageCount, Comparator.reverseOrder()));
        return result;
    }

    static String instructionRollSignature(CuttingInstruction instruction) {
        List<List<StationAssignment>> rolls = simulateRolls(instruction);
        if (rolls.isEmpty()) {
            return "";
        }
        return rollContentSignature(rolls.get(0));
    }

    static void flushRun(List<CuttingInstruction> result, List<RollRecord> run, PatternKey pattern) {
        if (run == null || run.isEmpty() || pattern == null) {
            return;
        }
        CuttingInstruction instruction = createInstruction(pattern, run.size());
        List<StationAssignment> assignments = new ArrayList<>();
        for (RollRecord roll : run) {
            for (StationAssignment assignment : roll.assignments()) {
                assignments.add(new StationAssignment(assignment.getWidth(), assignment.getMessageText()));
            }
        }
        instruction.setStationAssignments(assignments);
        result.add(instruction);
    }

    static CuttingInstruction createInstruction(PatternKey pattern, int usageCount) {
        CuttingInstruction instruction = new CuttingInstruction();
        instruction.setGroupKey(pattern.groupKey());
        instruction.setRollWidth(pattern.rollWidth());
        instruction.setLength(pattern.length());
        instruction.setSurfaceTreatment(pattern.surfaceTreatment());
        instruction.setThickness(pattern.thickness());
        instruction.setSubRolls(new LinkedHashMap<>(pattern.subRolls()));
        instruction.setUsageCount(usageCount);
        instruction.setPatternWidth(pattern.patternWidth());
        instruction.setWaste(pattern.waste());
        return instruction;
    }

    static List<RollRecord> decompose(List<CuttingInstruction> instructions) {
        List<RollRecord> rolls = new ArrayList<>();
        int index = 0;
        for (CuttingInstruction instruction : instructions) {
            PatternKey pattern = PatternKey.from(instruction);
            for (List<StationAssignment> roll : simulateRolls(instruction)) {
                Map<Integer, List<String>> config = configFromRoll(pattern, roll);
                Map<String, Integer> demandCounts = demandCounts(roll);
                rolls.add(new RollRecord(index++, pattern, roll, config, demandCounts,
                        rollContentSignature(roll)));
            }
        }
        return rolls;
    }

    static List<List<StationAssignment>> simulateRolls(CuttingInstruction instruction) {
        List<List<StationAssignment>> rolls = new ArrayList<>();
        Map<Integer, Queue<StationAssignment>> buckets = new LinkedHashMap<>();
        for (StationAssignment assignment : instruction.getStationAssignments()) {
            buckets.computeIfAbsent(assignment.getWidth(), ignored -> new ArrayDeque<>())
                    .add(assignment);
        }

        for (int i = 0; i < instruction.getUsageCount(); i++) {
            List<StationAssignment> roll = new ArrayList<>();
            for (Map.Entry<Integer, Integer> subRoll : instruction.getSubRolls().entrySet()) {
                Queue<StationAssignment> bucket = buckets.get(subRoll.getKey());
                for (int slot = 0; slot < subRoll.getValue(); slot++) {
                    if (bucket != null && !bucket.isEmpty()) {
                        StationAssignment assignment = bucket.poll();
                        roll.add(new StationAssignment(assignment.getWidth(), assignment.getMessageText()));
                    }
                }
            }
            if (!roll.isEmpty()) {
                rolls.add(roll);
            }
        }
        return rolls;
    }

    static Map<Integer, List<String>> configFromRoll(PatternKey pattern, List<StationAssignment> roll) {
        Map<Integer, List<String>> config = new LinkedHashMap<>();
        for (Integer width : pattern.subRolls().keySet()) {
            config.put(width, new ArrayList<>());
        }
        for (StationAssignment assignment : roll) {
            config.computeIfAbsent(assignment.getWidth(), ignored -> new ArrayList<>())
                    .add(Objects.toString(assignment.getMessageText(), ""));
        }
        for (List<String> messages : config.values()) {
            messages.sort(Comparator.naturalOrder());
        }
        return config;
    }

    static Map<String, Integer> demandCounts(List<StationAssignment> roll) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (StationAssignment assignment : roll) {
            counts.merge(demandKey(assignment.getWidth(), assignment.getMessageText()), 1, Integer::sum);
        }
        return counts;
    }

    static Map<String, Integer> countAssignmentsByDemandKey(List<CuttingInstruction> instructions) {
        Map<String, Integer> counts = new TreeMap<>();
        for (CuttingInstruction instruction : instructions) {
            for (StationAssignment assignment : instruction.getStationAssignments()) {
                counts.merge(demandKey(assignment.getWidth(), assignment.getMessageText()), 1, Integer::sum);
            }
        }
        return counts;
    }

    static int totalCars(List<CuttingInstruction> instructions) {
        return instructions.stream().mapToInt(CuttingInstruction::getUsageCount).sum();
    }

    static int totalWaste(List<CuttingInstruction> instructions) {
        return instructions.stream()
                .mapToInt(instruction -> instruction.getWaste() * instruction.getUsageCount())
                .sum();
    }

    static List<CuttingInstruction> cloneInstructions(List<CuttingInstruction> source) {
        List<CuttingInstruction> clones = new ArrayList<>();
        for (CuttingInstruction instruction : source) {
            CuttingInstruction clone = createInstruction(PatternKey.from(instruction), instruction.getUsageCount());
            List<StationAssignment> assignments = new ArrayList<>();
            for (StationAssignment assignment : instruction.getStationAssignments()) {
                assignments.add(new StationAssignment(assignment.getWidth(), assignment.getMessageText()));
            }
            clone.setStationAssignments(assignments);
            clones.add(clone);
        }
        return clones;
    }

    static String rollContentSignature(List<StationAssignment> roll) {
        return roll.stream()
                .map(assignment -> demandKey(assignment.getWidth(), assignment.getMessageText()))
                .sorted()
                .collect(Collectors.joining(","));
    }

    static Map<Integer, List<String>> copyConfig(Map<Integer, List<String>> config) {
        Map<Integer, List<String>> copy = new LinkedHashMap<>();
        for (Map.Entry<Integer, List<String>> entry : config.entrySet()) {
            copy.put(entry.getKey(), List.copyOf(entry.getValue()));
        }
        return copy;
    }

    static String demandKey(int width, String messageText) {
        return width + "|" + Objects.toString(messageText, "");
    }
}
