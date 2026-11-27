package changyang.cut.apsmodule.generator.NewSolver.output;

import changyang.cut.apsmodule.generator.NewSolver.config.SolverParameters;
import changyang.cut.apsmodule.generator.NewSolver.mip.AssignmentMIPSolver;
import changyang.cut.apsmodule.generator.NewSolver.model.PatternCandidate;
import changyang.cut.apsmodule.service.CuttingInstruction;
import changyang.cut.apsmodule.service.SolverOrderItem;
import changyang.cut.apsmodule.service.StationAssignment;
import changyang.cut.apsmodule.util.OrderAssignmentOptimizer;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * InstructionConverter 的 MIP/Greedy 指令构建、预览守恒校验与需求再平衡辅助类。
 */
final class InstructionAssignmentBuilder {

    private final SolverParameters params;

    InstructionAssignmentBuilder(SolverParameters params) {
        this.params = params;
    }

    List<CuttingInstruction> buildFromMIPAssignment(
            Map<PatternCandidate, Integer> solution,
            String groupKey,
            List<SolverOrderItem> groupItems,
            Map<PatternCandidate, List<AssignmentMIPSolver.AssignmentBlock>> mipAssignment) {
        List<CuttingInstruction> instructions = new ArrayList<>();

        for (Map.Entry<PatternCandidate, Integer> entry : solution.entrySet()) {
            PatternCandidate pattern = entry.getKey();
            int usageCount = entry.getValue();

            CuttingInstruction instruction = new CuttingInstruction();
            instruction.setGroupKey(groupKey);
            instruction.setRollWidth(pattern.getRollWidth());
            instruction.setSubRolls(new LinkedHashMap<>(pattern.getPattern()));
            instruction.setUsageCount(usageCount);
            instruction.setPatternWidth(pattern.getPatternWidth());
            instruction.setWaste(params.getTotalWidth() - pattern.getPatternWidth());

            if (!groupItems.isEmpty()) {
                SolverOrderItem sample = groupItems.get(0);
                instruction.setLength(sample.getLength());
                instruction.setSurfaceTreatment(sample.getSurfaceTreatment());
                instruction.setThickness(sample.getThickness());
            }

            List<StationAssignment> assignments = new ArrayList<>();
            List<AssignmentMIPSolver.AssignmentBlock> blocks = mipAssignment.get(pattern);

            if (blocks != null) {
                for (AssignmentMIPSolver.AssignmentBlock block : blocks) {
                    Map<Integer, List<String>> stationConfig = block.getStationConfig();
                    Map<Integer, String> fallbackConfig = block.getConfig();
                    for (int roll = 0; roll < block.getCount(); roll++) {
                        for (Map.Entry<Integer, Integer> subRoll : pattern.getPattern().entrySet()) {
                            int width = subRoll.getKey();
                            int stationCount = subRoll.getValue();
                            for (int station = 0; station < stationCount; station++) {
                                String messageText = messageAtStation(
                                        stationConfig.get(width),
                                        station,
                                        fallbackConfig.getOrDefault(width, "UNKNOWN"));
                                assignments.add(new StationAssignment(width, messageText));
                            }
                        }
                    }
                }
            }

            instruction.setStationAssignments(assignments);
            instructions.add(instruction);
        }

        rebalanceAssignments(instructions, groupItems);
        return instructions;
    }

    private String messageAtStation(List<String> messages, int station, String fallback) {
        if (messages == null || messages.isEmpty()) {
            return fallback;
        }
        if (station < messages.size()) {
            return messages.get(station);
        }
        return messages.get(messages.size() - 1);
    }

    List<CuttingInstruction> buildFromGreedyAssignment(
            Map<PatternCandidate, Integer> solution,
            String groupKey,
            List<SolverOrderItem> groupItems,
            OrderAssignmentOptimizer.GreedyStrategy strategy,
            boolean rebalance,
            boolean optimizedAssignment) {
        List<CuttingInstruction> instructions = new ArrayList<>();
        Map<Integer, List<SolverOrderItem>> widthToItems = groupItems.stream()
                .collect(Collectors.groupingBy(
                        SolverOrderItem::getWidth,
                        LinkedHashMap::new,
                        Collectors.toList()));

        Map<String, Integer> remainingDemands = new HashMap<>();
        for (SolverOrderItem item : groupItems) {
            remainingDemands.merge(
                    InstructionSequenceSupport.demandKey(item.getWidth(), item.getMessageText()),
                    item.getDemand(),
                    Integer::sum);
        }

        List<Map.Entry<PatternCandidate, Integer>> orderedSolution = solution.entrySet().stream()
                .filter(entry -> entry.getValue() != null && entry.getValue() > 0)
                .sorted(Comparator
                        .comparingInt((Map.Entry<PatternCandidate, Integer> entry) ->
                                entry.getKey().getRollWidth())
                        .thenComparing(entry -> entry.getKey().signature()))
                .toList();
        for (Map.Entry<PatternCandidate, Integer> entry : orderedSolution) {
            PatternCandidate pattern = entry.getKey();
            int usageCount = entry.getValue();

            CuttingInstruction instruction = new CuttingInstruction();
            instruction.setGroupKey(groupKey);
            instruction.setRollWidth(pattern.getRollWidth());
            instruction.setSubRolls(new LinkedHashMap<>(pattern.getPattern()));
            instruction.setUsageCount(usageCount);
            instruction.setPatternWidth(pattern.getPatternWidth());
            instruction.setWaste(params.getTotalWidth() - pattern.getPatternWidth());

            if (!groupItems.isEmpty()) {
                SolverOrderItem sample = groupItems.get(0);
                instruction.setLength(sample.getLength());
                instruction.setSurfaceTreatment(sample.getSurfaceTreatment());
                instruction.setThickness(sample.getThickness());
            }

            List<StationAssignment> assignments;
            if (optimizedAssignment) {
                assignments = OrderAssignmentOptimizer.buildTupleBlockAssignments(
                        pattern.getPattern(), usageCount, groupItems, remainingDemands, strategy);
            } else {
                assignments = new ArrayList<>();
                for (Map.Entry<Integer, Integer> subRoll : pattern.getPattern().entrySet()) {
                    int width = subRoll.getKey();
                    int stationCount = subRoll.getValue();
                    int totalNeeded = stationCount * usageCount;
                    List<SolverOrderItem> items = widthToItems.getOrDefault(width, Collections.emptyList());

                    int remaining = totalNeeded;
                    for (SolverOrderItem item : items) {
                        if (remaining <= 0) {
                            break;
                        }
                        String key = InstructionSequenceSupport.demandKey(width, item.getMessageText());
                        int itemRemaining = remainingDemands.getOrDefault(key, 0);
                        if (itemRemaining <= 0) {
                            continue;
                        }
                        int allocated = Math.min(remaining, itemRemaining);
                        for (int i = 0; i < allocated; i++) {
                            assignments.add(new StationAssignment(width, item.getMessageText()));
                        }
                        remaining -= allocated;
                        remainingDemands.put(key, itemRemaining - allocated);
                    }

                    if (remaining > 0 && !items.isEmpty()) {
                        SolverOrderItem fallback = items.get(0);
                        for (int i = 0; i < remaining; i++) {
                            assignments.add(new StationAssignment(width, fallback.getMessageText()));
                        }
                    }
                }
            }

            instruction.setStationAssignments(assignments);
            instructions.add(instruction);
        }

        if (rebalance) {
            rebalanceAssignments(instructions, groupItems);
        }
        return instructions;
    }

    boolean isCompletePreview(List<CuttingInstruction> instructions,
            List<SolverOrderItem> groupItems,
            Map<Integer, Integer> demands) {
        if (instructions == null || instructions.isEmpty()) {
            return false;
        }

        Map<String, Integer> assigned =
                InstructionSequenceSupport.countAssignmentsByDemandKey(instructions);
        Map<String, Integer> demanded = new HashMap<>();
        for (SolverOrderItem item : groupItems) {
            demanded.merge(
                    InstructionSequenceSupport.demandKey(item.getWidth(), item.getMessageText()),
                    item.getDemand(),
                    Integer::sum);
        }
        for (Map.Entry<String, Integer> demand : demanded.entrySet()) {
            if (assigned.getOrDefault(demand.getKey(), 0) < demand.getValue()) {
                return false;
            }
        }

        Map<Integer, Integer> producedByWidth = new HashMap<>();
        for (CuttingInstruction instruction : instructions) {
            if (instruction.getSubRolls() == null || instruction.getStationAssignments() == null) {
                return false;
            }
            int stationsPerRoll = instruction.getSubRolls().values().stream()
                    .mapToInt(Integer::intValue)
                    .sum();
            if (instruction.getStationAssignments().size()
                    != stationsPerRoll * instruction.getUsageCount()) {
                return false;
            }
            Map<Integer, Long> assignedByWidth = instruction.getStationAssignments().stream()
                    .collect(Collectors.groupingBy(
                            StationAssignment::getWidth,
                            Collectors.counting()));
            for (Map.Entry<Integer, Integer> cut : instruction.getSubRolls().entrySet()) {
                long expected = (long) cut.getValue() * instruction.getUsageCount();
                if (assignedByWidth.getOrDefault(cut.getKey(), 0L) != expected) {
                    return false;
                }
                producedByWidth.merge(cut.getKey(), (int) expected, Integer::sum);
            }
        }
        for (Map.Entry<Integer, Integer> demand : demands.entrySet()) {
            if (producedByWidth.getOrDefault(demand.getKey(), 0) < demand.getValue()) {
                return false;
            }
        }
        return true;
    }

    void rebalanceAssignments(List<CuttingInstruction> instructions, List<SolverOrderItem> groupItems) {
        Map<String, Integer> demandByKey = new HashMap<>();
        for (SolverOrderItem item : groupItems) {
            demandByKey.merge(
                    InstructionSequenceSupport.demandKey(item.getWidth(), item.getMessageText()),
                    item.getDemand(),
                    Integer::sum);
        }

        Map<String, Integer> allocatedByKey = new HashMap<>();
        for (CuttingInstruction instruction : instructions) {
            if (instruction.getStationAssignments() == null) {
                continue;
            }
            for (StationAssignment assignment : instruction.getStationAssignments()) {
                allocatedByKey.merge(
                        InstructionSequenceSupport.demandKey(assignment.getWidth(), assignment.getMessageText()),
                        1,
                        Integer::sum);
            }
        }

        Map<Integer, List<String>> messagesByWidth = new HashMap<>();
        for (SolverOrderItem item : groupItems) {
            messagesByWidth.computeIfAbsent(item.getWidth(), key -> new ArrayList<>()).add(item.getMessageText());
        }
        for (List<String> messages : messagesByWidth.values()) {
            List<String> unique = new ArrayList<>(new LinkedHashSet<>(messages));
            messages.clear();
            messages.addAll(unique);
        }

        Map<String, Integer> overByKey = new HashMap<>();
        Map<String, Integer> underByKey = new HashMap<>();
        for (String key : demandByKey.keySet()) {
            int demand = demandByKey.get(key);
            int allocated = allocatedByKey.getOrDefault(key, 0);
            int diff = allocated - demand;
            if (diff > 0) {
                overByKey.put(key, diff);
            } else if (diff < 0) {
                underByKey.put(key, -diff);
            }
        }

        if (overByKey.isEmpty() || underByKey.isEmpty()) {
            return;
        }

        for (Map.Entry<Integer, List<String>> entry : messagesByWidth.entrySet()) {
            int width = entry.getKey();
            List<String> messages = entry.getValue();

            List<String> overMessages = new ArrayList<>();
            List<String> underMessages = new ArrayList<>();
            for (String message : messages) {
                String key = InstructionSequenceSupport.demandKey(width, message);
                if (overByKey.containsKey(key)) {
                    overMessages.add(message);
                }
                if (underByKey.containsKey(key)) {
                    underMessages.add(message);
                }
            }

            if (overMessages.isEmpty() || underMessages.isEmpty()) {
                continue;
            }

            for (String overMessage : overMessages) {
                String overKey = InstructionSequenceSupport.demandKey(width, overMessage);
                int overAmount = overByKey.getOrDefault(overKey, 0);
                if (overAmount <= 0) {
                    continue;
                }
                for (String underMessage : underMessages) {
                    String underKey = InstructionSequenceSupport.demandKey(width, underMessage);
                    int underAmount = underByKey.getOrDefault(underKey, 0);
                    if (underAmount <= 0) {
                        continue;
                    }
                    int transfer = Math.min(overAmount, underAmount);
                    if (transfer <= 0) {
                        continue;
                    }
                    int transferred = transferAssignments(instructions, width, overMessage, underMessage, transfer);
                    overAmount -= transferred;
                    underAmount -= transferred;
                    overByKey.put(overKey, overAmount);
                    underByKey.put(underKey, underAmount);
                    if (overAmount <= 0) {
                        break;
                    }
                }
            }
        }
    }

    private int transferAssignments(List<CuttingInstruction> instructions, int width,
            String fromMessage, String toMessage, int count) {
        int transferred = 0;
        for (int instructionIndex = instructions.size() - 1; instructionIndex >= 0; instructionIndex--) {
            CuttingInstruction instruction = instructions.get(instructionIndex);
            if (instruction.getStationAssignments() == null) {
                continue;
            }
            List<StationAssignment> assignments = instruction.getStationAssignments();
            for (int i = assignments.size() - 1; i >= 0 && transferred < count; i--) {
                StationAssignment assignment = assignments.get(i);
                if (assignment.getWidth() == width && fromMessage.equals(assignment.getMessageText())) {
                    assignments.set(i, new StationAssignment(width, toMessage));
                    transferred++;
                }
            }
            if (transferred >= count) {
                break;
            }
        }
        return transferred;
    }
}
