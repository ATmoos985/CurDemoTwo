package changyang.cut.apsmodule.generator.NewSolver.output;

import changyang.cut.apsmodule.service.CuttingInstruction;
import changyang.cut.apsmodule.service.StationAssignment;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Queue;
import java.util.stream.Collectors;

/**
 * InstructionConverter 的无状态指令/卷模拟、块规整、排序与克隆底层支持。
 */
final class InstructionSequenceSupport {

    record RollBlock(String signature, List<List<StationAssignment>> rolls) {
    }

    record InstructionSortKey(
            String primaryRollSignature,
            String rollProfile,
            int primaryRollCount,
            int rollBlockCount,
            int rollWidth,
            String patternSignature) implements Comparable<InstructionSortKey> {

        @Override
        public int compareTo(InstructionSortKey other) {
            int cmp = primaryRollSignature.compareTo(other.primaryRollSignature);
            if (cmp != 0) {
                return cmp;
            }
            cmp = rollProfile.compareTo(other.rollProfile);
            if (cmp != 0) {
                return cmp;
            }
            cmp = Integer.compare(other.primaryRollCount, primaryRollCount);
            if (cmp != 0) {
                return cmp;
            }
            cmp = Integer.compare(rollBlockCount, other.rollBlockCount);
            if (cmp != 0) {
                return cmp;
            }
            cmp = Integer.compare(rollWidth, other.rollWidth);
            if (cmp != 0) {
                return cmp;
            }
            return patternSignature.compareTo(other.patternSignature);
        }
    }

    private InstructionSequenceSupport() {
    }

    static String demandKey(int width, String messageText) {
        return width + "|" + Objects.toString(messageText, "");
    }

    static Map<String, Integer> countAssignmentsByDemandKey(List<CuttingInstruction> instructions) {
        Map<String, Integer> counts = new HashMap<>();
        for (CuttingInstruction instruction : instructions) {
            if (instruction.getStationAssignments() == null) {
                continue;
            }
            for (StationAssignment assignment : instruction.getStationAssignments()) {
                counts.merge(demandKey(assignment.getWidth(), assignment.getMessageText()), 1, Integer::sum);
            }
        }
        return counts;
    }

    static List<StationAssignment> cloneAssignments(List<StationAssignment> assignments) {
        if (assignments == null) {
            return null;
        }
        List<StationAssignment> copy = new ArrayList<>(assignments.size());
        for (StationAssignment assignment : assignments) {
            copy.add(new StationAssignment(assignment.getWidth(), assignment.getMessageText()));
        }
        return copy;
    }

    static List<CuttingInstruction> cloneInstructions(List<CuttingInstruction> instructions) {
        List<CuttingInstruction> copy = new ArrayList<>(instructions.size());
        for (CuttingInstruction instruction : instructions) {
            copy.add(cloneInstruction(instruction));
        }
        return copy;
    }

    static CuttingInstruction cloneInstruction(CuttingInstruction instruction) {
        CuttingInstruction cloned = new CuttingInstruction();
        cloned.setGroupKey(instruction.getGroupKey());
        cloned.setRollWidth(instruction.getRollWidth());
        cloned.setLength(instruction.getLength());
        cloned.setSurfaceTreatment(instruction.getSurfaceTreatment());
        cloned.setThickness(instruction.getThickness());
        cloned.setSubRolls(new LinkedHashMap<>(instruction.getSubRolls()));
        cloned.setUsageCount(instruction.getUsageCount());
        cloned.setPatternWidth(instruction.getPatternWidth());
        cloned.setWaste(instruction.getWaste());
        cloned.setStationAssignments(cloneAssignments(instruction.getStationAssignments()));
        return cloned;
    }

    static void compactInstructionRollOrder(List<CuttingInstruction> instructions) {
        for (CuttingInstruction instruction : instructions) {
            compactInstructionRollOrder(instruction);
        }
    }

    static void compactInstructionRollOrder(CuttingInstruction instruction) {
        if (instruction == null || instruction.getStationAssignments() == null
                || instruction.getStationAssignments().isEmpty()) {
            return;
        }
        if (instruction.getSubRolls() == null || instruction.getSubRolls().isEmpty()
                || instruction.getUsageCount() <= 1) {
            return;
        }

        List<List<StationAssignment>> rolls = simulateRolls(instruction);
        if (rolls.size() <= 1) {
            return;
        }

        List<RollBlock> blocks = buildRollBlocks(rolls);
        List<StationAssignment> compacted = new ArrayList<>(instruction.getStationAssignments().size());
        for (RollBlock block : blocks) {
            for (List<StationAssignment> roll : block.rolls()) {
                compacted.addAll(roll);
            }
        }
        instruction.setStationAssignments(compacted);
    }

    static void arrangeForSequenceGroups(List<CuttingInstruction> instructions) {
        compactInstructionRollOrder(instructions);
        reorderInstructionsForSequenceGroups(instructions);
    }

    static void reorderInstructionsForSequenceGroups(List<CuttingInstruction> instructions) {
        if (instructions == null || instructions.size() <= 1) {
            return;
        }
        Map<CuttingInstruction, InstructionSortKey> sortKeys = new IdentityHashMap<>(instructions.size() * 2);
        for (CuttingInstruction instruction : instructions) {
            List<RollBlock> blocks = buildRollBlocks(simulateRolls(instruction));
            String primarySig = blocks.isEmpty() ? "" : blocks.get(0).signature();
            int primaryCount = blocks.isEmpty() ? 0 : blocks.get(0).rolls().size();
            StringBuilder profile = new StringBuilder();
            for (int i = 0; i < blocks.size(); i++) {
                if (i > 0) {
                    profile.append("||");
                }
                RollBlock block = blocks.get(i);
                profile.append(block.signature()).append('#').append(block.rolls().size());
            }
            sortKeys.put(instruction, new InstructionSortKey(
                    primarySig,
                    profile.toString(),
                    primaryCount,
                    blocks.size(),
                    instruction.getRollWidth(),
                    instructionPatternSignature(instruction)));
        }
        instructions.sort((left, right) -> sortKeys.get(left).compareTo(sortKeys.get(right)));
    }

    static List<List<StationAssignment>> simulateRolls(CuttingInstruction instruction) {
        List<List<StationAssignment>> rolls = new ArrayList<>();
        Map<Integer, Queue<StationAssignment>> buckets = new LinkedHashMap<>();
        for (StationAssignment assignment : instruction.getStationAssignments()) {
            buckets.computeIfAbsent(assignment.getWidth(), key -> new LinkedList<>()).add(assignment);
        }

        for (int i = 0; i < instruction.getUsageCount(); i++) {
            List<StationAssignment> rollAssignments = new ArrayList<>();
            for (Map.Entry<Integer, Integer> entry : instruction.getSubRolls().entrySet()) {
                int width = entry.getKey();
                int count = entry.getValue();
                Queue<StationAssignment> bucket = buckets.get(width);
                for (int j = 0; j < count; j++) {
                    if (bucket != null && !bucket.isEmpty()) {
                        rollAssignments.add(bucket.poll());
                    }
                }
            }
            if (!rollAssignments.isEmpty()) {
                rolls.add(rollAssignments);
            }
        }
        return rolls;
    }

    static String rollSignature(List<StationAssignment> roll) {
        return roll.stream()
                .map(assignment -> assignment.getWidth() + "|" + Objects.toString(assignment.getMessageText(), ""))
                .sorted()
                .collect(Collectors.joining(","));
    }

    static List<RollBlock> buildRollBlocks(List<List<StationAssignment>> rolls) {
        Map<String, List<List<StationAssignment>>> rollsBySignature = new LinkedHashMap<>();
        for (List<StationAssignment> roll : rolls) {
            rollsBySignature.computeIfAbsent(rollSignature(roll), key -> new ArrayList<>()).add(roll);
        }

        return rollsBySignature.entrySet().stream()
                .map(entry -> new RollBlock(entry.getKey(), entry.getValue()))
                .sorted(Comparator
                        .comparingInt((RollBlock block) -> block.rolls().size()).reversed()
                        .thenComparing(RollBlock::signature))
                .toList();
    }

    static int countDistinctRollSignatures(List<List<StationAssignment>> rolls) {
        return (int) rolls.stream()
                .map(InstructionSequenceSupport::rollSignature)
                .distinct()
                .count();
    }

    static String instructionPatternSignature(CuttingInstruction instruction) {
        if (instruction.getSubRolls() == null || instruction.getSubRolls().isEmpty()) {
            return "";
        }
        return instruction.getSubRolls().entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .map(entry -> entry.getKey() + "x" + entry.getValue())
                .collect(Collectors.joining(","));
    }

    static String instructionFamilyKey(CuttingInstruction instruction) {
        return Objects.toString(instruction.getGroupKey(), "") + "||"
                + instruction.getRollWidth() + "||"
                + instruction.getLength() + "||"
                + Objects.toString(instruction.getSurfaceTreatment(), "") + "||"
                + instruction.getThickness() + "||"
                + instructionPatternSignature(instruction);
    }
}
