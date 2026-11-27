package changyang.cut.apsmodule.generator.NewSolver.output;

import com.google.ortools.linearsolver.MPConstraint;
import com.google.ortools.linearsolver.MPObjective;
import com.google.ortools.linearsolver.MPSolver;
import com.google.ortools.linearsolver.MPVariable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import changyang.cut.apsmodule.generator.NewSolver.config.OrToolsNativeLoader;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverRuntimeProperties;
import changyang.cut.apsmodule.generator.NewSolver.output.InstructionSequenceSupport.RollBlock;
import changyang.cut.apsmodule.service.CuttingInstruction;
import changyang.cut.apsmodule.service.StationAssignment;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.BiFunction;

/**
 * InstructionConverter 的 OR-Tools 指令块/花型族重打包（repack）MIP 引擎。
 */
final class InstructionBlockRepacker {

    private static final Logger log = LoggerFactory.getLogger(InstructionBlockRepacker.class);
    private static final int DEFAULT_MAX_WIDTH_MESSAGES_PER_REPACK = 4;
    private static final int DEFAULT_MAX_WIDTH_OPTIONS_PER_REPACK = 6;
    private static final int DEFAULT_MAX_FULL_CONFIGS_PER_REPACK = 96;
    private static final long DEFAULT_INSTRUCTION_REPACK_TIME_LIMIT_MS = 150L;
    private static final long DEFAULT_INSTRUCTION_REPACK_NODE_LIMIT = 400L;
    private static final long DEFAULT_INSTRUCTION_REPACK_SAFETY_TIME_LIMIT_MS = 2_000L;
    private static final int LARGE_REPACK_MIN_BLOCKS = 6;
    private static final int LARGE_REPACK_MIN_USAGE_COUNT = 40;
    private static final int LARGE_MAX_WIDTH_MESSAGES_PER_REPACK = 6;
    private static final int LARGE_MAX_WIDTH_OPTIONS_PER_REPACK = 10;
    private static final int LARGE_MAX_FULL_CONFIGS_PER_REPACK = 192;
    private static final long LARGE_INSTRUCTION_REPACK_TIME_LIMIT_MS = 450L;
    private static final long LARGE_INSTRUCTION_REPACK_NODE_LIMIT = 800L;
    private static final long LARGE_INSTRUCTION_REPACK_SAFETY_TIME_LIMIT_MS = 4_000L;
    private static final long INSTRUCTION_REPACK_HINT_TIME_LIMIT_MS = 60L;
    private static final int INSTRUCTION_REPACK_HINT_MIN_BLOCKS = 4;
    private static final int INSTRUCTION_REPACK_HINT_MIN_USAGE_COUNT = 8;
    private static final String SCIP_REPACK_DETERMINISTIC_PARAMS =
            "randomization/randomseedshift = 0\n"
          + "randomization/permutationseed = 0\n"
          + "randomization/lpseed = 0\n";

    private record MessageCount(String messageText, int count) {
    }

    private record WidthOption(
            List<String> messages,
            int support,
            int distinctMessageCount,
            int oddMultiplicityCount) {
    }

    private record RollConfig(
            String signature,
            LinkedHashMap<Integer, List<String>> messagesByWidth,
            Map<String, Integer> demandUsage,
            int support,
            int distinctMessageCount,
            int oddMultiplicityCount) {
    }

    private record RepackBlock(RollConfig config, int count) {
    }

    private record RepackPlan(
            List<RepackBlock> blocks,
            int blockCount,
            int oddBlockCount) {
    }

    private record RepackProfile(
            int maxWidthMessages,
            int maxWidthOptions,
            int maxFullConfigs,
            long timeLimitMs,
            long nodeLimit,
            long safetyTimeLimitMs) {
    }

    InstructionBlockRepacker() {
    }

    void optimizeInstructionBlocks(
            List<CuttingInstruction> instructions,
            BiFunction<CuttingInstruction, Integer, List<List<StationAssignment>>> hintCollector) {
        for (CuttingInstruction instruction : instructions) {
            optimizeInstructionBlocks(instruction, hintCollector);
        }
    }

    List<CuttingInstruction> optimizeInstructionFamilies(
            List<CuttingInstruction> instructions,
            BiFunction<CuttingInstruction, Integer, List<List<StationAssignment>>> hintCollector) {
        if (instructions == null || instructions.size() <= 1) {
            return instructions;
        }

        Map<String, List<CuttingInstruction>> families = new LinkedHashMap<>();
        for (CuttingInstruction instruction : instructions) {
            families.computeIfAbsent(
                    InstructionSequenceSupport.instructionFamilyKey(instruction),
                    key -> new ArrayList<>()).add(instruction);
        }

        List<CuttingInstruction> optimized = new ArrayList<>();
        for (List<CuttingInstruction> family : families.values()) {
            optimized.addAll(optimizeInstructionFamily(family, hintCollector));
        }
        return optimized;
    }

    private List<CuttingInstruction> optimizeInstructionFamily(
            List<CuttingInstruction> family,
            BiFunction<CuttingInstruction, Integer, List<List<StationAssignment>>> hintCollector) {
        if (family == null || family.isEmpty()) {
            return Collections.emptyList();
        }
        if (family.size() == 1) {
            return family;
        }

        CuttingInstruction template = family.get(0);
        int totalUsageCount = family.stream().mapToInt(CuttingInstruction::getUsageCount).sum();
        if (totalUsageCount <= 1) {
            return family;
        }

        List<List<StationAssignment>> currentRolls = new ArrayList<>();
        for (CuttingInstruction instruction : family) {
            currentRolls.addAll(InstructionSequenceSupport.simulateRolls(instruction));
        }
        if (currentRolls.size() <= 1) {
            return family;
        }

        List<RollBlock> currentBlocks = InstructionSequenceSupport.buildRollBlocks(currentRolls);
        int currentBlockCount = currentBlocks.size();
        int currentOddBlockCount = countOddBlocks(currentBlocks);
        int currentSmallBlockCount = countSmallBlocks(currentBlocks);
        if (currentBlockCount <= 1 && currentOddBlockCount == 0) {
            return family;
        }

        Map<String, Integer> exactCounts = InstructionSequenceSupport.countAssignmentsByDemandKey(family);
        RepackProfile repackProfile = determineRepackProfile(totalUsageCount, currentBlockCount);
        List<RollConfig> candidateConfigs = buildInstructionCandidateConfigs(
                template, currentRolls, exactCounts, repackProfile);
        candidateConfigs = addHintConfigs(
                template, currentBlockCount, exactCounts, candidateConfigs, hintCollector);
        if (candidateConfigs.size() <= 1 || !OrToolsNativeLoader.ensureLoaded("instruction repack")) {
            return family;
        }

        RepackPlan repackPlan = solveInstructionRepack(
                totalUsageCount,
                exactCounts,
                candidateConfigs,
                currentBlockCount,
                currentOddBlockCount,
                currentSmallBlockCount,
                repackProfile);
        if (repackPlan == null) {
            return family;
        }

        List<CuttingInstruction> rebuiltFamily = materializeFamilyInstructions(template, repackPlan.blocks());
        log.info("Instruction family repack @{}mm {}: blocks {} -> {}, oddBlocks {} -> {}, instructions {} -> {}",
                template.getRollWidth(),
                InstructionSequenceSupport.instructionPatternSignature(template),
                currentBlockCount,
                repackPlan.blockCount(),
                currentOddBlockCount,
                repackPlan.oddBlockCount(),
                family.size(),
                rebuiltFamily.size());
        return rebuiltFamily;
    }

    private void optimizeInstructionBlocks(
            CuttingInstruction instruction,
            BiFunction<CuttingInstruction, Integer, List<List<StationAssignment>>> hintCollector) {
        if (instruction == null
                || instruction.getUsageCount() <= 1
                || instruction.getSubRolls() == null
                || instruction.getSubRolls().isEmpty()
                || instruction.getStationAssignments() == null
                || instruction.getStationAssignments().isEmpty()) {
            return;
        }

        List<List<StationAssignment>> currentRolls = InstructionSequenceSupport.simulateRolls(instruction);
        if (currentRolls.size() <= 1) {
            return;
        }

        List<RollBlock> currentBlocks = InstructionSequenceSupport.buildRollBlocks(currentRolls);
        int currentBlockCount = currentBlocks.size();
        int currentOddBlockCount = countOddBlocks(currentBlocks);
        int currentSmallBlockCount = countSmallBlocks(currentBlocks);
        if (currentBlockCount <= 1 && currentOddBlockCount == 0) {
            return;
        }

        Map<String, Integer> exactCounts =
                InstructionSequenceSupport.countAssignmentsByDemandKey(List.of(instruction));
        RepackProfile repackProfile = determineRepackProfile(instruction.getUsageCount(), currentBlockCount);
        List<RollConfig> candidateConfigs = buildInstructionCandidateConfigs(
                instruction, currentRolls, exactCounts, repackProfile);
        candidateConfigs = addHintConfigs(
                instruction, currentBlockCount, exactCounts, candidateConfigs, hintCollector);
        if (candidateConfigs.size() <= 1 || !OrToolsNativeLoader.ensureLoaded("instruction repack")) {
            return;
        }

        RepackPlan repackPlan = solveInstructionRepack(
                instruction.getUsageCount(),
                exactCounts,
                candidateConfigs,
                currentBlockCount,
                currentOddBlockCount,
                currentSmallBlockCount,
                repackProfile);
        if (repackPlan == null) {
            return;
        }

        instruction.setStationAssignments(materializeRepackedAssignments(repackPlan.blocks()));
        log.info("Instruction repack @{}mm: blocks {} -> {}, oddBlocks {} -> {}",
                instruction.getRollWidth(),
                currentBlockCount,
                repackPlan.blockCount(),
                currentOddBlockCount,
                repackPlan.oddBlockCount());
    }

    static List<List<StationAssignment>> defaultCollectHintRolls(
            CuttingInstruction instruction,
            int currentBlockCount) {
        if (instruction == null
                || currentBlockCount < INSTRUCTION_REPACK_HINT_MIN_BLOCKS
                || instruction.getUsageCount() < INSTRUCTION_REPACK_HINT_MIN_USAGE_COUNT) {
            return Collections.emptyList();
        }

        CuttingInstruction hintedInstruction = InstructionSequenceSupport.cloneInstruction(instruction);
        int groupsBefore = SequenceGroupPostProcessor.countGroups(hintedInstruction);
        List<CuttingInstruction> hintInstructions = new ArrayList<>(1);
        hintInstructions.add(hintedInstruction);
        SequenceGroupPostProcessor.optimize(hintInstructions, INSTRUCTION_REPACK_HINT_TIME_LIMIT_MS, false);
        int groupsAfter = SequenceGroupPostProcessor.countGroups(hintedInstruction);
        List<List<StationAssignment>> currentRolls = InstructionSequenceSupport.simulateRolls(instruction);
        List<List<StationAssignment>> hintedRolls = InstructionSequenceSupport.simulateRolls(hintedInstruction);
        int hintedBlockCount = InstructionSequenceSupport.buildRollBlocks(hintedRolls).size();
        boolean shapeChanged = hintedBlockCount < currentBlockCount
                || InstructionSequenceSupport.countDistinctRollSignatures(hintedRolls)
                        > InstructionSequenceSupport.countDistinctRollSignatures(currentRolls);
        if (groupsAfter >= groupsBefore && !shapeChanged) {
            return Collections.emptyList();
        }

        return hintedRolls;
    }

    private List<RollConfig> addHintConfigs(
            CuttingInstruction instruction,
            int currentBlockCount,
            Map<String, Integer> exactCounts,
            List<RollConfig> candidateConfigs,
            BiFunction<CuttingInstruction, Integer, List<List<StationAssignment>>> hintCollector) {
        List<List<StationAssignment>> hintRolls = hintCollector.apply(instruction, currentBlockCount);
        if (hintRolls.isEmpty()) {
            return candidateConfigs;
        }

        LinkedHashMap<String, RollConfig> configsBySignature = new LinkedHashMap<>();
        for (RollConfig config : candidateConfigs) {
            configsBySignature.put(config.signature(), config);
        }

        int added = 0;
        for (List<StationAssignment> roll : hintRolls) {
            RollConfig config = createRollConfig(instruction.getSubRolls(), roll, exactCounts);
            if (config == null || configsBySignature.containsKey(config.signature())) {
                continue;
            }
            configsBySignature.put(config.signature(), config);
            added++;
        }

        if (added > 0) {
            log.info("Instruction repack hints @{}mm: +{} configs from low-group postprocess shape",
                    instruction.getRollWidth(), added);
        }

        return new ArrayList<>(configsBySignature.values());
    }

    private RepackPlan solveInstructionRepack(
            int usageCount,
            Map<String, Integer> exactCounts,
            List<RollConfig> candidateConfigs,
            int currentBlockCount,
            int currentOddBlockCount,
            int currentSmallBlockCount,
            RepackProfile repackProfile) {
        MPSolver solver = null;
        try {
            long nodeLimit = SolverRuntimeProperties.getLong(
                    "cutting.repack.scipNodeLimit", repackProfile.nodeLimit());
            solver = MPSolver.createSolver("SCIP");
            if (solver != null) {
                String scipParams = SCIP_REPACK_DETERMINISTIC_PARAMS;
                if (nodeLimit > 0L) {
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

            List<RollConfig> activeConfigs = candidateConfigs.stream()
                    .filter(config -> config.support() > 0)
                    .toList();
            if (activeConfigs.isEmpty()) {
                return null;
            }

            List<MPVariable> countVars = new ArrayList<>(activeConfigs.size());
            List<MPVariable> useVars = new ArrayList<>(activeConfigs.size());
            List<MPVariable> oddVars = new ArrayList<>(activeConfigs.size());
            List<MPVariable> halfVars = new ArrayList<>(activeConfigs.size());
            List<MPVariable> smallVars = new ArrayList<>(activeConfigs.size());

            int smallThreshold = SequenceGroupPostProcessor.SMALL_CAR_MAX_CARS + 1;

            for (int index = 0; index < activeConfigs.size(); index++) {
                RollConfig config = activeConfigs.get(index);
                int upperBound = Math.min(usageCount, config.support());
                MPVariable countVar = solver.makeIntVar(0, upperBound, "repack_count_" + index);
                MPVariable useVar = solver.makeBoolVar("repack_use_" + index);
                MPVariable oddVar = solver.makeBoolVar("repack_odd_" + index);
                MPVariable halfVar = solver.makeIntVar(0, upperBound, "repack_half_" + index);
                MPVariable smallVar = solver.makeBoolVar("repack_small_" + index);

                MPConstraint linkConstraint = solver.makeConstraint(-MPSolver.infinity(), 0, "repack_link_" + index);
                linkConstraint.setCoefficient(countVar, 1);
                linkConstraint.setCoefficient(useVar, -upperBound);

                MPConstraint parityConstraint = solver.makeConstraint(0, 0, "repack_parity_" + index);
                parityConstraint.setCoefficient(countVar, 1);
                parityConstraint.setCoefficient(halfVar, -2);
                parityConstraint.setCoefficient(oddVar, -1);

                MPConstraint smallConstraint = solver.makeConstraint(0, MPSolver.infinity(), "repack_small_c_" + index);
                smallConstraint.setCoefficient(smallVar, smallThreshold);
                smallConstraint.setCoefficient(countVar, 1);
                smallConstraint.setCoefficient(useVar, -smallThreshold);

                countVars.add(countVar);
                useVars.add(useVar);
                oddVars.add(oddVar);
                halfVars.add(halfVar);
                smallVars.add(smallVar);
            }

            MPConstraint rollCountConstraint = solver.makeConstraint(usageCount, usageCount, "repack_total_rolls");
            for (MPVariable countVar : countVars) {
                rollCountConstraint.setCoefficient(countVar, 1);
            }

            for (Map.Entry<String, Integer> exactEntry : exactCounts.entrySet()) {
                MPConstraint exactConstraint = solver.makeConstraint(
                        exactEntry.getValue(), exactEntry.getValue(), "repack_exact_" + exactEntry.getKey());
                for (int index = 0; index < activeConfigs.size(); index++) {
                    int coefficient = activeConfigs.get(index).demandUsage().getOrDefault(exactEntry.getKey(), 0);
                    if (coefficient > 0) {
                        exactConstraint.setCoefficient(countVars.get(index), coefficient);
                    }
                }
            }

            MPObjective objective = solver.objective();
            for (int index = 0; index < activeConfigs.size(); index++) {
                objective.setCoefficient(useVars.get(index), 10_000);
                objective.setCoefficient(oddVars.get(index), 100);
                objective.setCoefficient(smallVars.get(index), 10);
            }
            objective.setMinimization();

            long effectiveTimeLimitMs = nodeLimit > 0L
                    ? Math.max(repackProfile.timeLimitMs(), repackProfile.safetyTimeLimitMs())
                    : repackProfile.timeLimitMs();
            solver.setTimeLimit(effectiveTimeLimitMs);
            MPSolver.ResultStatus status = solver.solve();
            if (status != MPSolver.ResultStatus.OPTIMAL && status != MPSolver.ResultStatus.FEASIBLE) {
                return null;
            }

            List<RepackBlock> blocks = new ArrayList<>();
            for (int index = 0; index < activeConfigs.size(); index++) {
                int count = (int) Math.round(countVars.get(index).solutionValue());
                if (count > 0) {
                    blocks.add(new RepackBlock(activeConfigs.get(index), count));
                }
            }

            if (blocks.isEmpty()) {
                return null;
            }

            blocks.sort(Comparator
                    .comparingInt(RepackBlock::count).reversed()
                    .thenComparing(block -> block.config().signature()));

            int optimizedBlockCount = blocks.size();
            int optimizedOddBlockCount = (int) blocks.stream().filter(block -> block.count() % 2 != 0).count();
            int optimizedSmallBlockCount = (int) blocks.stream()
                    .filter(block -> block.count() > 0 && block.count() <= SequenceGroupPostProcessor.SMALL_CAR_MAX_CARS)
                    .count();
            if (optimizedBlockCount > currentBlockCount) {
                return null;
            }
            if (optimizedBlockCount == currentBlockCount) {
                if (optimizedOddBlockCount > currentOddBlockCount) {
                    return null;
                }
                if (optimizedOddBlockCount == currentOddBlockCount
                        && optimizedSmallBlockCount >= currentSmallBlockCount) {
                    return null;
                }
            }

            if (!exactCounts.equals(
                    InstructionSequenceSupport.countAssignmentsByDemandKey(
                            materializeRepackedInstructions(blocks)))) {
                return null;
            }

            return new RepackPlan(blocks, optimizedBlockCount, optimizedOddBlockCount);
        } finally {
            if (solver != null) {
                solver.delete();
            }
        }
    }

    private List<CuttingInstruction> materializeRepackedInstructions(List<RepackBlock> blocks) {
        CuttingInstruction instruction = new CuttingInstruction();
        instruction.setUsageCount(blocks.stream().mapToInt(RepackBlock::count).sum());
        List<StationAssignment> assignments = materializeRepackedAssignments(blocks);
        instruction.setStationAssignments(assignments);
        return List.of(instruction);
    }

    private List<CuttingInstruction> materializeFamilyInstructions(
            CuttingInstruction template,
            List<RepackBlock> blocks) {
        List<CuttingInstruction> rebuilt = new ArrayList<>();
        for (RepackBlock block : blocks) {
            CuttingInstruction instruction = InstructionSequenceSupport.cloneInstruction(template);
            instruction.setUsageCount(block.count());
            instruction.setStationAssignments(materializeRepackedAssignments(List.of(block)));
            rebuilt.add(instruction);
        }
        return rebuilt;
    }

    private List<StationAssignment> materializeRepackedAssignments(List<RepackBlock> blocks) {
        List<StationAssignment> assignments = new ArrayList<>();
        for (RepackBlock block : blocks) {
            for (int roll = 0; roll < block.count(); roll++) {
                for (Map.Entry<Integer, List<String>> entry : block.config().messagesByWidth().entrySet()) {
                    int width = entry.getKey();
                    for (String messageText : entry.getValue()) {
                        assignments.add(new StationAssignment(width, messageText));
                    }
                }
            }
        }
        return assignments;
    }

    private List<RollConfig> buildInstructionCandidateConfigs(
            CuttingInstruction instruction,
            List<List<StationAssignment>> currentRolls,
            Map<String, Integer> exactCounts,
            RepackProfile repackProfile) {
        LinkedHashMap<String, RollConfig> candidatesBySignature = new LinkedHashMap<>();

        for (List<StationAssignment> roll : currentRolls) {
            RollConfig config = createRollConfig(instruction.getSubRolls(), roll, exactCounts);
            if (config != null) {
                candidatesBySignature.putIfAbsent(config.signature(), config);
            }
        }

        Map<Integer, Map<String, Integer>> countsByWidth = buildWidthMessageCounts(currentRolls);
        List<Integer> widths = new ArrayList<>(instruction.getSubRolls().keySet());
        Collections.sort(widths);
        List<List<WidthOption>> optionsByWidth = new ArrayList<>(widths.size());
        for (int width : widths) {
            int slotsNeeded = instruction.getSubRolls().getOrDefault(width, 0);
            optionsByWidth.add(generateWidthOptions(
                    slotsNeeded,
                    countsByWidth.getOrDefault(width, Collections.emptyMap()),
                    repackProfile.maxWidthMessages(),
                    repackProfile.maxWidthOptions()));
        }

        List<RollConfig> generatedConfigs = new ArrayList<>();
        enumerateFullConfigs(
                widths,
                optionsByWidth,
                0,
                new LinkedHashMap<>(),
                exactCounts,
                generatedConfigs,
                repackProfile.maxFullConfigs());
        generatedConfigs.sort(Comparator
                .comparingInt(RollConfig::support).reversed()
                .thenComparingInt(RollConfig::oddMultiplicityCount)
                .thenComparingInt(RollConfig::distinctMessageCount)
                .thenComparing(RollConfig::signature));

        for (RollConfig config : generatedConfigs) {
            candidatesBySignature.putIfAbsent(config.signature(), config);
            if (candidatesBySignature.size() >= repackProfile.maxFullConfigs()) {
                break;
            }
        }

        return new ArrayList<>(candidatesBySignature.values());
    }

    private void enumerateFullConfigs(
            List<Integer> widths,
            List<List<WidthOption>> optionsByWidth,
            int index,
            LinkedHashMap<Integer, List<String>> currentConfig,
            Map<String, Integer> exactCounts,
            List<RollConfig> generatedConfigs,
            int maxFullConfigs) {
        if (generatedConfigs.size() >= maxFullConfigs * 2) {
            return;
        }

        if (index >= widths.size()) {
            RollConfig config = createRollConfig(currentConfig, exactCounts);
            if (config != null) {
                generatedConfigs.add(config);
            }
            return;
        }

        int width = widths.get(index);
        for (WidthOption option : optionsByWidth.get(index)) {
            currentConfig.put(width, option.messages());
            enumerateFullConfigs(widths, optionsByWidth, index + 1, currentConfig, exactCounts, generatedConfigs, maxFullConfigs);
            currentConfig.remove(width);
            if (generatedConfigs.size() >= maxFullConfigs * 2) {
                return;
            }
        }
    }

    private Map<Integer, Map<String, Integer>> buildWidthMessageCounts(List<List<StationAssignment>> rolls) {
        Map<Integer, Map<String, Integer>> countsByWidth = new LinkedHashMap<>();
        for (List<StationAssignment> roll : rolls) {
            for (StationAssignment assignment : roll) {
                countsByWidth
                        .computeIfAbsent(assignment.getWidth(), key -> new LinkedHashMap<>())
                        .merge(Objects.toString(assignment.getMessageText(), ""), 1, Integer::sum);
            }
        }
        return countsByWidth;
    }

    private List<WidthOption> generateWidthOptions(
            int slotsNeeded,
            Map<String, Integer> countsByMessage,
            int maxWidthMessages,
            int maxWidthOptions) {
        if (slotsNeeded <= 0 || countsByMessage.isEmpty()) {
            return Collections.emptyList();
        }

        List<MessageCount> messages = countsByMessage.entrySet().stream()
                .filter(entry -> entry.getValue() > 0)
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed()
                        .thenComparing(Map.Entry::getKey))
                .limit(maxWidthMessages)
                .map(entry -> new MessageCount(entry.getKey(), entry.getValue()))
                .toList();
        if (messages.isEmpty()) {
            return Collections.emptyList();
        }

        List<WidthOption> options = new ArrayList<>();
        int[] counts = new int[messages.size()];
        enumerateWidthOptions(messages, slotsNeeded, 0, slotsNeeded, counts, options);
        options.sort(Comparator
                .comparingInt(WidthOption::support).reversed()
                .thenComparingInt(WidthOption::oddMultiplicityCount)
                .thenComparingInt(WidthOption::distinctMessageCount)
                .thenComparing(option -> String.join(",", option.messages())));

        if (options.size() > maxWidthOptions) {
            return new ArrayList<>(options.subList(0, maxWidthOptions));
        }
        return options;
    }

    private void enumerateWidthOptions(
            List<MessageCount> messages,
            int slotsNeeded,
            int index,
            int remainingSlots,
            int[] counts,
            List<WidthOption> options) {
        if (index == messages.size() - 1) {
            counts[index] = remainingSlots;
            addWidthOption(messages, counts, options);
            counts[index] = 0;
            return;
        }

        for (int count = remainingSlots; count >= 0; count--) {
            counts[index] = count;
            enumerateWidthOptions(messages, slotsNeeded, index + 1, remainingSlots - count, counts, options);
        }
        counts[index] = 0;
    }

    private void addWidthOption(List<MessageCount> messages, int[] counts, List<WidthOption> options) {
        List<String> optionMessages = new ArrayList<>();
        int support = Integer.MAX_VALUE;
        int distinctMessageCount = 0;
        int oddMultiplicityCount = 0;

        for (int index = 0; index < counts.length; index++) {
            int count = counts[index];
            if (count <= 0) {
                continue;
            }

            MessageCount message = messages.get(index);
            support = Math.min(support, message.count() / count);
            distinctMessageCount++;
            if (count % 2 != 0) {
                oddMultiplicityCount++;
            }
            for (int slot = 0; slot < count; slot++) {
                optionMessages.add(message.messageText());
            }
        }

        if (optionMessages.isEmpty() || support <= 0) {
            return;
        }

        optionMessages.sort(String::compareTo);
        options.add(new WidthOption(optionMessages, support, distinctMessageCount, oddMultiplicityCount));
    }

    private RollConfig createRollConfig(
            Map<Integer, Integer> subRolls,
            List<StationAssignment> roll,
            Map<String, Integer> exactCounts) {
        LinkedHashMap<Integer, List<String>> messagesByWidth = new LinkedHashMap<>();
        Map<Integer, List<String>> rollMessagesByWidth = new HashMap<>();
        for (StationAssignment assignment : roll) {
            rollMessagesByWidth
                    .computeIfAbsent(assignment.getWidth(), key -> new ArrayList<>())
                    .add(Objects.toString(assignment.getMessageText(), ""));
        }

        for (Map.Entry<Integer, Integer> entry : subRolls.entrySet()) {
            int width = entry.getKey();
            List<String> messages = new ArrayList<>(rollMessagesByWidth.getOrDefault(width, Collections.emptyList()));
            if (messages.isEmpty()) {
                return null;
            }
            messages.sort(String::compareTo);
            messagesByWidth.put(width, messages);
        }

        return createRollConfig(messagesByWidth, exactCounts);
    }

    private RollConfig createRollConfig(
            Map<Integer, List<String>> messagesByWidth,
            Map<String, Integer> exactCounts) {
        LinkedHashMap<Integer, List<String>> normalized = new LinkedHashMap<>();
        List<Integer> widths = new ArrayList<>(messagesByWidth.keySet());
        Collections.sort(widths);

        Map<String, Integer> demandUsage = new LinkedHashMap<>();
        int oddMultiplicityCount = 0;
        int distinctMessageCount = 0;
        List<String> signatureParts = new ArrayList<>();

        for (int width : widths) {
            List<String> messages = new ArrayList<>(messagesByWidth.getOrDefault(width, Collections.emptyList()));
            if (messages.isEmpty()) {
                return null;
            }

            messages.sort(String::compareTo);
            normalized.put(width, messages);
            signatureParts.add(width + "=" + String.join(",", messages));

            Map<String, Integer> multiplicities = new LinkedHashMap<>();
            for (String messageText : messages) {
                String key = InstructionSequenceSupport.demandKey(width, messageText);
                multiplicities.merge(key, 1, Integer::sum);
            }
            distinctMessageCount += multiplicities.size();
            for (Map.Entry<String, Integer> entry : multiplicities.entrySet()) {
                demandUsage.put(entry.getKey(), entry.getValue());
                if (entry.getValue() % 2 != 0) {
                    oddMultiplicityCount++;
                }
            }
        }

        int support = Integer.MAX_VALUE;
        for (Map.Entry<String, Integer> entry : demandUsage.entrySet()) {
            int available = exactCounts.getOrDefault(entry.getKey(), 0);
            if (available < entry.getValue()) {
                return null;
            }
            support = Math.min(support, available / entry.getValue());
        }
        if (support <= 0) {
            return null;
        }

        return new RollConfig(
                String.join("|", signatureParts),
                normalized,
                demandUsage,
                support,
                distinctMessageCount,
                oddMultiplicityCount);
    }

    private int countOddBlocks(List<RollBlock> blocks) {
        return (int) blocks.stream().filter(block -> block.rolls().size() % 2 != 0).count();
    }

    private int countSmallBlocks(List<RollBlock> blocks) {
        return (int) blocks.stream()
                .filter(block -> !block.rolls().isEmpty()
                        && block.rolls().size() <= SequenceGroupPostProcessor.SMALL_CAR_MAX_CARS)
                .count();
    }

    private RepackProfile determineRepackProfile(int usageCount, int currentBlockCount) {
        if (usageCount >= LARGE_REPACK_MIN_USAGE_COUNT || currentBlockCount >= LARGE_REPACK_MIN_BLOCKS) {
            return new RepackProfile(
                    LARGE_MAX_WIDTH_MESSAGES_PER_REPACK,
                    LARGE_MAX_WIDTH_OPTIONS_PER_REPACK,
                    LARGE_MAX_FULL_CONFIGS_PER_REPACK,
                    LARGE_INSTRUCTION_REPACK_TIME_LIMIT_MS,
                    LARGE_INSTRUCTION_REPACK_NODE_LIMIT,
                    LARGE_INSTRUCTION_REPACK_SAFETY_TIME_LIMIT_MS);
        }
        return new RepackProfile(
                DEFAULT_MAX_WIDTH_MESSAGES_PER_REPACK,
                DEFAULT_MAX_WIDTH_OPTIONS_PER_REPACK,
                DEFAULT_MAX_FULL_CONFIGS_PER_REPACK,
                DEFAULT_INSTRUCTION_REPACK_TIME_LIMIT_MS,
                DEFAULT_INSTRUCTION_REPACK_NODE_LIMIT,
                DEFAULT_INSTRUCTION_REPACK_SAFETY_TIME_LIMIT_MS);
    }
}
