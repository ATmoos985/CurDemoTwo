package changyang.cut.apsmodule.generator.NewSolver.output;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import changyang.cut.apsmodule.generator.NewSolver.config.OrToolsNativeLoader;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverParameters;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverRuntimeProperties;
import changyang.cut.apsmodule.generator.NewSolver.mip.AssignmentMIPSolver;
import changyang.cut.apsmodule.generator.NewSolver.mip.Phase2SequenceGroupSolver;
import changyang.cut.apsmodule.generator.NewSolver.model.PatternCandidate;
import changyang.cut.apsmodule.service.CuttingInstruction;
import changyang.cut.apsmodule.service.SolverOrderItem;
import changyang.cut.apsmodule.service.StationAssignment;
import changyang.cut.apsmodule.util.OrderAssignmentOptimizer;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;

/**
 * Converts the selected patterns into executable instructions.
 *
 * The quality path compares Stage 5 MIP and fallback assignment candidates.
 * The fast-preview entry deliberately performs one deterministic greedy
 * conversion without sequence-group optimization.
 */
public class InstructionConverter {

    private static final Logger log = LoggerFactory.getLogger(InstructionConverter.class);

    private final SolverParameters params;
    private final InstructionAssignmentBuilder assignmentBuilder;
    private final InstructionBlockRepacker blockRepacker;

    public InstructionConverter(SolverParameters params) {
        this.params = params;
        this.assignmentBuilder = new InstructionAssignmentBuilder(params);
        this.blockRepacker = new InstructionBlockRepacker();
    }

    public List<CuttingInstruction> convert(Map<PatternCandidate, Integer> solution,
            String groupKey,
            List<SolverOrderItem> groupItems,
            Map<Integer, Integer> demands) {
        return convertWithDetails(solution, groupKey, groupItems, demands).instructions();
    }

    public ConversionResult convertWithDetails(Map<PatternCandidate, Integer> solution,
            String groupKey,
            List<SolverOrderItem> groupItems,
            Map<Integer, Integer> demands) {
        ConversionResult base = convertWithoutSetPartition(
                solution, groupKey, groupItems, demands);
        boolean refineEnabled = SolverRuntimeProperties.isQualityMode()
                && SetPartitionRefiner.isEnabled();
        if (refineEnabled) {
            return refineWithSetPartition(base);
        }
        return base;
    }

    public ConversionResult convertFastPreview(Map<PatternCandidate, Integer> solution,
            String groupKey,
            List<SolverOrderItem> groupItems,
            Map<Integer, Integer> demands) {
        boolean optimizedAssignment = params.isUseOptimizedAssignment();
        List<CuttingInstruction> instructions = buildFastPreviewAssignments(
                solution, groupKey, groupItems, optimizedAssignment);
        String selectedName = "fast-greedy";
        if (!assignmentBuilder.isCompletePreview(instructions, groupItems, demands) && optimizedAssignment) {
            log.warn("Fast preview optimized assignment failed conservation for group {}; "
                    + "falling back to simple deterministic assignment", groupKey);
            instructions = buildFastPreviewAssignments(solution, groupKey, groupItems, false);
            selectedName = "fast-simple";
        }
        if (!assignmentBuilder.isCompletePreview(instructions, groupItems, demands)) {
            log.warn("Fast preview rejected because assignment conservation failed for group {}", groupKey);
            return new ConversionResult(new ArrayList<>(), "none", 0, List.of());
        }

        SolverRunColumnArchive.recordInstructions(instructions);
        SequenceGroupPostProcessor.GroupStats stats =
                SequenceGroupPostProcessor.computeGroupStats(instructions);
        return new ConversionResult(
                instructions,
                selectedName,
                stats.groups(),
                List.of(new SequenceCandidateRow(
                        selectedName, stats.groups(), instructions.size(), true)));
    }

    protected List<CuttingInstruction> buildFastPreviewAssignments(
            Map<PatternCandidate, Integer> solution,
            String groupKey,
            List<SolverOrderItem> groupItems,
            boolean optimizedAssignment) {
        return assignmentBuilder.buildFromGreedyAssignment(
                solution,
                groupKey,
                groupItems,
                OrderAssignmentOptimizer.GreedyStrategy.BATCH_FIRST,
                false,
                optimizedAssignment);
    }

    public ConversionResult convertWithoutSetPartition(Map<PatternCandidate, Integer> solution,
            String groupKey,
            List<SolverOrderItem> groupItems,
            Map<Integer, Integer> demands) {
        Map<PatternCandidate, List<AssignmentMIPSolver.AssignmentBlock>> mipAssignment = null;
        try {
            mipAssignment = solveAssignmentWithMip(solution, groupItems);
        } catch (Exception e) {
            log.warn("Stage5 assignment candidate failed, greedy candidate will still be evaluated", e);
        }

        List<ScoredInstructionPlan> candidates = new ArrayList<>();
        if (mipAssignment != null) {
            List<CuttingInstruction> mipInstructions = finalizeSequenceQuality(
                    assignmentBuilder.buildFromMIPAssignment(solution, groupKey, groupItems, mipAssignment));
            addCandidate(candidates, "stage5-mip", mipInstructions);
        }

        if (phase2Enabled()) {
            try {
                log.info("Evaluating Phase2 sequence-group candidate");
                Phase2SequenceGroupSolver.SolveResult phase2Result =
                        solveSequenceGroupsWithPhase2(solution, groupItems, mipAssignment);
                if (phase2Result != null && !phase2Result.solution().isEmpty()
                        && !phase2Result.assignments().isEmpty()) {
                    List<CuttingInstruction> phase2Instructions = finalizeSequenceQuality(
                            assignmentBuilder.buildFromMIPAssignment(
                                    phase2Result.solution(), groupKey, groupItems, phase2Result.assignments()));
                    addCandidate(candidates, "phase2-cg", phase2Instructions);
                } else {
                    log.info("Phase2 sequence-group candidate produced no usable plan");
                }
            } catch (Exception e) {
                log.warn("Phase2 sequence-group candidate failed, other candidates will still be evaluated", e);
            }
        } else {
            log.info("Phase2 sequence-group candidate disabled (cutting.phase2.enabled=false)");
        }

        if (candidates.isEmpty()) {
            log.info("No MIP candidate produced; falling back to greedy assignment");
            List<CuttingInstruction> greedyInstructions = finalizeSequenceQuality(
                    assignmentBuilder.buildFromGreedyAssignment(
                            solution, groupKey, groupItems,
                            OrderAssignmentOptimizer.GreedyStrategy.BATCH_FIRST,
                            true, params.isUseOptimizedAssignment()));
            addCandidate(candidates, "greedy", greedyInstructions);

            List<CuttingInstruction> reuseGreedyInstructions = finalizeSequenceQuality(
                    assignmentBuilder.buildFromGreedyAssignment(
                            solution, groupKey, groupItems,
                            OrderAssignmentOptimizer.GreedyStrategy.REUSE_FIRST,
                            true, params.isUseOptimizedAssignment()));
            addCandidate(candidates, "greedy-reuse", reuseGreedyInstructions);
        }

        if (candidates.isEmpty()) {
            return new ConversionResult(new ArrayList<>(), "none", 0, List.of());
        }

        ScoredInstructionPlan bestPlan = selectBestCandidate(candidates);
        List<CuttingInstruction> selectedInstructions = bestPlan.instructions();
        String selectedName = bestPlan.name();
        int selectedGroups = bestPlan.sequenceGroupCount();
        List<SequenceCandidateRow> candidateRows = new ArrayList<>(
                buildSequenceCandidateRows(candidates, selectedName));
        boolean demandPeakImproved = false;
        DemandPeakFastStage.StageResult demandPeakResult = null;

        if (DemandPeakFastStage.isEnabled()) {
            try {
                demandPeakResult =
                        new DemandPeakFastStage(params).improve(selectedInstructions, groupItems);
                if (demandPeakResult.improved()) {
                    selectedInstructions = demandPeakResult.instructions();
                    selectedName = selectedName + "+demand-peak";
                    selectedGroups = demandPeakResult.afterStats().groups();
                    demandPeakImproved = true;
                    candidateRows = new ArrayList<>(candidateRows.stream()
                            .map(row -> new SequenceCandidateRow(
                                    row.name(),
                                    row.sequenceGroupCount(),
                                    row.instructions(),
                                    false))
                            .toList());
                    candidateRows.add(new SequenceCandidateRow(
                            selectedName,
                            selectedGroups,
                            selectedInstructions.size(),
                            true));
                }
            } catch (RuntimeException e) {
                log.warn("Demand-peak fast stage failed; Stage5/LNS fallback remains active", e);
            }
        }

        boolean lnsActive = LocalNeighborhoodSequenceOptimizer.isEnabledExplicitlyConfigured()
                ? LocalNeighborhoodSequenceOptimizer.isEnabled()
                : SolverRuntimeProperties.isQualityMode();
        if (lnsActive) {
            LocalNeighborhoodSequenceOptimizer optimizer =
                    new LocalNeighborhoodSequenceOptimizer(params, this::arrangeForSequenceGroups);
            final List<CuttingInstruction> lnsInput = selectedInstructions;
            LocalNeighborhoodSequenceOptimizer.LnsResult lnsResult;
            if (demandPeakImproved && !SolverRuntimeProperties.isQualityMode()) {
                Map<String, String> shortenedLns = Map.of(
                        "cutting.lns.maxIterations", Integer.toString(
                                SolverRuntimeProperties.getInt(
                                        "cutting.demandPeak.lnsMaxIterations", 24)),
                        "cutting.lns.maxNoImprove", Integer.toString(
                                SolverRuntimeProperties.getInt(
                                        "cutting.demandPeak.lnsMaxNoImprove", 8)));
                lnsResult = LocalNeighborhoodSequenceOptimizer.withPropertyOverrides(
                        shortenedLns,
                        () -> runLnsVariants(optimizer, lnsInput, groupItems));
            } else {
                lnsResult = runLnsVariants(optimizer, lnsInput, groupItems);
            }
            SolverRunColumnArchive.recordInstructions(lnsResult.instructions());
            if (lnsResult.improved()) {
                selectedInstructions = lnsResult.instructions();
                selectedName = selectedName + "+lns";
                selectedGroups = lnsResult.afterGroups();
                candidateRows = new ArrayList<>(candidateRows.stream()
                        .map(row -> new SequenceCandidateRow(
                                row.name(),
                                row.sequenceGroupCount(),
                                row.instructions(),
                                false))
                        .toList());
                candidateRows.add(new SequenceCandidateRow(
                        selectedName,
                        selectedGroups,
                        selectedInstructions.size(),
                        true));
                log.info("LNS improved selected sequence plan: groups {} -> {}",
                        lnsResult.beforeGroups(), lnsResult.afterGroups());

                List<CuttingInstruction> repaired = oddRepairPass(selectedInstructions);
                if (repaired != null) {
                    selectedInstructions = repaired;
                    selectedName = selectedName + "+oddfix";
                    selectedGroups = SequenceGroupPostProcessor
                            .computeGroupStats(selectedInstructions).groups();
                }
            } else {
                log.info("LNS produced no accepted improvement: {}", lnsResult.reason());
            }
        }

        if (demandPeakImproved
                && !SolverRuntimeProperties.isQualityMode()
                && DemandPeakSmallPolisher.isEnabled()
                && demandPeakResult != null
                && demandPeakResult.initialSolution() != null
                && demandPeakResult.initialSolution().pool() != null) {
            try {
                DemandPeakSmallPolisher.PolishResult polished =
                        new DemandPeakSmallPolisher(params).polish(
                                selectedInstructions,
                                groupItems,
                                demandPeakResult.initialSolution().pool().columns());
                if (polished.improved()) {
                    selectedInstructions = polished.instructions();
                    selectedName = selectedName + "+small-polish";
                    selectedGroups = polished.afterStats().groups();
                    SolverRunColumnArchive.recordInstructions(selectedInstructions);
                    candidateRows = new ArrayList<>(candidateRows.stream()
                            .map(row -> new SequenceCandidateRow(
                                    row.name(),
                                    row.sequenceGroupCount(),
                                    row.instructions(),
                                    false))
                            .toList());
                    candidateRows.add(new SequenceCandidateRow(
                            selectedName,
                            selectedGroups,
                            selectedInstructions.size(),
                            true));
                }
            } catch (RuntimeException e) {
                log.warn("Demand-peak small polish failed; LNS result remains active", e);
            }
        }

        log.info("Sequence-group selection: winner={} groups={} candidates={}",
                selectedName, selectedGroups, summarizeCandidates(candidates));
        SolverRunColumnArchive.recordInstructions(selectedInstructions);
        return new ConversionResult(
                selectedInstructions,
                selectedName,
                selectedGroups,
                candidateRows);
    }

    public ConversionResult refineWithSetPartition(ConversionResult base) {
        Objects.requireNonNull(base, "base");
        if (base.instructions().isEmpty()) {
            return base;
        }
        List<CuttingInstruction> refined = setPartitionRefinePass(base.instructions());
        if (refined == null) {
            return base;
        }
        int selectedGroups = SequenceGroupPostProcessor.computeGroupStats(refined).groups();
        String selectedName = base.selectedName() + "+spr";
        List<SequenceCandidateRow> candidateRows = new ArrayList<>(base.candidateRows().stream()
                .map(row -> new SequenceCandidateRow(
                        row.name(),
                        row.sequenceGroupCount(),
                        row.instructions(),
                        false))
                .toList());
        candidateRows.add(new SequenceCandidateRow(
                selectedName,
                selectedGroups,
                refined.size(),
                true));
        SolverRunColumnArchive.recordInstructions(refined);
        log.info("Set-partition refine pass accepted: groups {} -> {}",
                base.selectedSequenceGroups(), selectedGroups);
        return new ConversionResult(refined, selectedName, selectedGroups, candidateRows);
    }

    private LocalNeighborhoodSequenceOptimizer.LnsResult runLnsVariants(
            LocalNeighborhoodSequenceOptimizer optimizer,
            List<CuttingInstruction> instructions,
            List<SolverOrderItem> groupItems) {
        if (!SolverRuntimeProperties.isQualityMode()) {
            return optimizer.improve(instructions, groupItems);
        }
        long totalBudgetMs = SolverRuntimeProperties.getLong("cutting.lns.budgetMs", 0L);
        long startMs = System.currentTimeMillis();
        SequenceGroupPostProcessor.GroupStats initialStats =
                SequenceGroupPostProcessor.computeGroupStats(instructions);

        Map<String, String> stage1Overrides = new HashMap<>();
        stage1Overrides.put("cutting.lns.enabled", "true");
        if (totalBudgetMs > 0L) {
            long stage1Budget = Math.max(2_000L, totalBudgetMs * 45 / 100);
            stage1Overrides.put("cutting.lns.budgetMs", Long.toString(stage1Budget));
        }

        long stage1StartMs = System.currentTimeMillis();
        LocalNeighborhoodSequenceOptimizer.LnsResult resultStage1 =
                LocalNeighborhoodSequenceOptimizer.withPropertyOverrides(stage1Overrides,
                        () -> optimizer.improve(instructions, groupItems));
        long stage1ElapsedMs = System.currentTimeMillis() - stage1StartMs;
        List<CuttingInstruction> bestInstructions = resultStage1.instructions();
        SolverRunColumnArchive.recordInstructions(bestInstructions);
        SequenceGroupPostProcessor.GroupStats statsStage1 =
                SequenceGroupPostProcessor.computeGroupStats(bestInstructions);

        long remainingMs = totalBudgetMs > 0L
                ? totalBudgetMs - (System.currentTimeMillis() - startMs)
                : Long.MAX_VALUE;
        if (totalBudgetMs > 0L && remainingMs < 3_000L) {
            log.info("LNS stage2 skipped (remainingBudgetMs={}, stage1Ms={}): stage1={}/{}/{}/{}",
                    remainingMs, stage1ElapsedMs,
                    statsStage1.groups(), statsStage1.oddCarGroups(),
                    statsStage1.oneCarGroups(), statsStage1.smallCarGroups());
            return resultStage1;
        }

        int baseNoImprove = SolverRuntimeProperties.getInt("cutting.lns.maxNoImprove", 6);
        Map<String, String> stage2Overrides = new HashMap<>();
        stage2Overrides.put("cutting.lns.enabled", "true");
        stage2Overrides.put("cutting.lns.maxFreeOrders", "12");
        stage2Overrides.put("cutting.lns.maxFreePatterns", "20");
        stage2Overrides.put("cutting.lns.maxFreeCars", "40");
        stage2Overrides.put("cutting.lns.maxNeighborhoods", "60");
        stage2Overrides.put("cutting.lns.maxNoImprove", Integer.toString(Math.min(baseNoImprove, 3)));
        if (totalBudgetMs > 0L) {
            stage2Overrides.put("cutting.lns.budgetMs", Long.toString(remainingMs));
        }

        final List<CuttingInstruction> stage2Input = bestInstructions;
        long stage2StartMs = System.currentTimeMillis();
        LocalNeighborhoodSequenceOptimizer.LnsResult resultStage2 =
                LocalNeighborhoodSequenceOptimizer.withPropertyOverrides(stage2Overrides,
                        () -> optimizer.improve(stage2Input, groupItems));
        long stage2ElapsedMs = System.currentTimeMillis() - stage2StartMs;
        SolverRunColumnArchive.recordInstructions(resultStage2.instructions());
        SequenceGroupPostProcessor.GroupStats statsStage2 =
                SequenceGroupPostProcessor.computeGroupStats(resultStage2.instructions());
        boolean stage2Wins = compareGroupStats(statsStage2, statsStage1) < 0;
        log.info("LNS progressive variants (stage1Ms={}, stage2Ms={}): stage1={}/{}/{}/{} stage2={}/{}/{}/{} -> winner={}",
                stage1ElapsedMs, stage2ElapsedMs,
                statsStage1.groups(), statsStage1.oddCarGroups(), statsStage1.oneCarGroups(),
                statsStage1.smallCarGroups(), statsStage2.groups(), statsStage2.oddCarGroups(),
                statsStage2.oneCarGroups(), statsStage2.smallCarGroups(),
                stage2Wins ? "stage2" : "stage1");

        List<CuttingInstruction> winnerInstructions = stage2Wins ? resultStage2.instructions() : bestInstructions;
        SequenceGroupPostProcessor.GroupStats winnerStats = stage2Wins ? statsStage2 : statsStage1;
        boolean overallImproved = compareGroupStats(winnerStats, initialStats) < 0;
        if (overallImproved) {
            return new LocalNeighborhoodSequenceOptimizer.LnsResult(
                    true, winnerInstructions, initialStats.groups(), winnerStats.groups(), "improved");
        }
        return LocalNeighborhoodSequenceOptimizer.LnsResult.notImproved(
                instructions, stage2Wins ? resultStage2.reason() : resultStage1.reason());
    }

    private List<CuttingInstruction> oddRepairPass(List<CuttingInstruction> instructions) {
        if (instructions == null || instructions.isEmpty()) {
            return null;
        }
        SequenceGroupPostProcessor.GroupStats before = SequenceGroupPostProcessor.computeGroupStats(instructions);
        int beforeCars = instructions.stream().mapToInt(CuttingInstruction::getUsageCount).sum();
        int beforeWaste = instructions.stream()
                .mapToInt(i -> i.getWaste() * i.getUsageCount()).sum();
        Map<String, Integer> beforeDemand =
                InstructionSequenceSupport.countAssignmentsByDemandKey(instructions);
        int oddFloor = oddCarFloor(instructions);

        List<CuttingInstruction> candidate = InstructionSequenceSupport.cloneInstructions(instructions);
        candidate = blockRepacker.optimizeInstructionFamilies(
                candidate, this::collectInstructionRepackHintRolls);
        InstructionSequenceSupport.compactInstructionRollOrder(candidate);
        InstructionSequenceSupport.reorderInstructionsForSequenceGroups(candidate);
        SolverRunColumnArchive.recordInstructions(candidate);

        SequenceGroupPostProcessor.GroupStats after = SequenceGroupPostProcessor.computeGroupStats(candidate);
        int afterCars = candidate.stream().mapToInt(CuttingInstruction::getUsageCount).sum();
        int afterWaste = candidate.stream()
                .mapToInt(i -> i.getWaste() * i.getUsageCount()).sum();
        boolean conserved = afterCars == beforeCars
                && afterWaste == beforeWaste
                && beforeDemand.equals(InstructionSequenceSupport.countAssignmentsByDemandKey(candidate));
        boolean lexBetter = compareGroupStats(after, before) < 0;
        log.info("Odd-repair pass: groups {}->{}, odd {}->{} (floor={}), one {}->{}, "
                        + "small {}->{}, conserved={}, accepted={}",
                before.groups(), after.groups(),
                before.oddCarGroups(), after.oddCarGroups(), oddFloor,
                before.oneCarGroups(), after.oneCarGroups(),
                before.smallCarGroups(), after.smallCarGroups(),
                conserved, conserved && lexBetter);
        return conserved && lexBetter ? candidate : null;
    }

    private List<CuttingInstruction> setPartitionRefinePass(List<CuttingInstruction> instructions) {
        if (instructions == null || instructions.isEmpty()) {
            return null;
        }
        SequenceGroupPostProcessor.GroupStats before = SequenceGroupPostProcessor.computeGroupStats(instructions);
        int beforeCars = instructions.stream().mapToInt(CuttingInstruction::getUsageCount).sum();
        int beforeWaste = instructions.stream()
                .mapToInt(i -> i.getWaste() * i.getUsageCount()).sum();
        Map<String, Integer> beforeDemand =
                InstructionSequenceSupport.countAssignmentsByDemandKey(instructions);

        List<CuttingInstruction> candidate = SetPartitionRefiner.refine(instructions, params);
        if (candidate == null) {
            log.info("Set-partition refine pass: not applicable (structure) — kept original");
            return null;
        }
        List<CuttingInstruction> repaired = oddRepairPass(candidate);
        if (repaired != null) {
            candidate = repaired;
        }
        InstructionSequenceSupport.compactInstructionRollOrder(candidate);
        InstructionSequenceSupport.reorderInstructionsForSequenceGroups(candidate);

        SequenceGroupPostProcessor.GroupStats after = SequenceGroupPostProcessor.computeGroupStats(candidate);
        int afterCars = candidate.stream().mapToInt(CuttingInstruction::getUsageCount).sum();
        int afterWaste = candidate.stream()
                .mapToInt(i -> i.getWaste() * i.getUsageCount()).sum();
        boolean conserved = afterCars == beforeCars
                && afterWaste == beforeWaste
                && beforeDemand.equals(InstructionSequenceSupport.countAssignmentsByDemandKey(candidate));
        boolean lexBetter = compareGroupStats(after, before) < 0;
        log.info("Set-partition refine pass: groups {}->{}, odd {}->{}, one {}->{}, "
                        + "small {}->{}, conserved={}, accepted={}",
                before.groups(), after.groups(),
                before.oddCarGroups(), after.oddCarGroups(),
                before.oneCarGroups(), after.oneCarGroups(),
                before.smallCarGroups(), after.smallCarGroups(),
                conserved, conserved && lexBetter);
        return conserved && lexBetter ? candidate : null;
    }

    private List<CuttingInstruction> finalizeSequenceQuality(List<CuttingInstruction> instructions) {
        blockRepacker.optimizeInstructionBlocks(instructions, this::collectInstructionRepackHintRolls);
        List<CuttingInstruction> result = blockRepacker.optimizeInstructionFamilies(
                instructions, this::collectInstructionRepackHintRolls);
        InstructionSequenceSupport.compactInstructionRollOrder(result);
        InstructionSequenceSupport.reorderInstructionsForSequenceGroups(result);
        return result;
    }

    private int oddCarFloor(List<CuttingInstruction> instructions) {
        Map<String, Integer> carsByFamily = new LinkedHashMap<>();
        for (CuttingInstruction instruction : instructions) {
            carsByFamily.merge(
                    InstructionSequenceSupport.instructionPatternSignature(instruction),
                    instruction.getUsageCount(),
                    Integer::sum);
        }
        return (int) carsByFamily.values().stream().filter(u -> u % 2 != 0).count();
    }

    private boolean phase2Enabled() {
        return SolverRuntimeProperties.getBoolean("cutting.phase2.enabled", false);
    }

    protected Map<PatternCandidate, List<AssignmentMIPSolver.AssignmentBlock>> solveAssignmentWithMip(
            Map<PatternCandidate, Integer> solution,
            List<SolverOrderItem> groupItems) {
        AssignmentMIPSolver assignmentSolver = new AssignmentMIPSolver(params);
        return assignmentSolver.solve(solution, groupItems);
    }

    protected Phase2SequenceGroupSolver.SolveResult solveSequenceGroupsWithPhase2(
            Map<PatternCandidate, Integer> solution,
            List<SolverOrderItem> groupItems) {
        return solveSequenceGroupsWithPhase2(solution, groupItems, null);
    }

    protected Phase2SequenceGroupSolver.SolveResult solveSequenceGroupsWithPhase2(
            Map<PatternCandidate, Integer> solution,
            List<SolverOrderItem> groupItems,
            Map<PatternCandidate, List<AssignmentMIPSolver.AssignmentBlock>> seedAssignments) {
        if (!OrToolsNativeLoader.ensureLoaded("instruction phase2")) {
            return null;
        }
        Phase2SequenceGroupSolver phase2Solver = new Phase2SequenceGroupSolver(params);
        return phase2Solver.solveWithSolution(solution, groupItems, seedAssignments);
    }

    protected void optimizeSequenceGroups(List<CuttingInstruction> instructions) {
        SequenceGroupPostProcessor.optimize(instructions);
    }

    protected List<List<StationAssignment>> collectInstructionRepackHintRolls(
            CuttingInstruction instruction,
            int currentBlockCount) {
        return InstructionBlockRepacker.defaultCollectHintRolls(instruction, currentBlockCount);
    }

    void arrangeForSequenceGroups(List<CuttingInstruction> instructions) {
        InstructionSequenceSupport.arrangeForSequenceGroups(instructions);
    }

    private void addCandidate(List<ScoredInstructionPlan> candidates, String name, List<CuttingInstruction> instructions) {
        if (instructions == null || instructions.isEmpty()) {
            return;
        }

        List<CuttingInstruction> candidate = InstructionSequenceSupport.cloneInstructions(instructions);
        Map<String, Integer> before = InstructionSequenceSupport.countAssignmentsByDemandKey(candidate);
        arrangeForSequenceGroups(candidate);
        Map<String, Integer> after = InstructionSequenceSupport.countAssignmentsByDemandKey(candidate);
        if (!before.equals(after)) {
            log.warn("Sequence-group candidate rejected for {} because width-message counts changed", name);
            return;
        }

        SolverRunColumnArchive.recordInstructions(candidate);
        SequenceGroupPostProcessor.GroupStats stats = SequenceGroupPostProcessor.computeGroupStats(candidate);
        candidates.add(new ScoredInstructionPlan(
                name, candidate, stats.groups(), stats.oddCarGroups(),
                stats.oneCarGroups(), stats.smallCarGroups()));
        log.info("Sequence-group candidate: {} groups={} oddCars={} oneCars={} "
                        + "smallCars={} instructions={}",
                name, stats.groups(), stats.oddCarGroups(), stats.oneCarGroups(),
                stats.smallCarGroups(), candidate.size());
    }

    private ScoredInstructionPlan selectBestCandidate(List<ScoredInstructionPlan> candidates) {
        candidates.sort(Comparator.comparingInt(ScoredInstructionPlan::sequenceGroupCount)
                .thenComparingInt(ScoredInstructionPlan::oddCarGroups)
                .thenComparingInt(ScoredInstructionPlan::oneCarGroups)
                .thenComparingInt(ScoredInstructionPlan::smallCarGroups)
                .thenComparingInt(candidate -> candidatePreference(candidate.name())));
        return candidates.get(0);
    }

    private static int compareGroupStats(SequenceGroupPostProcessor.GroupStats first,
            SequenceGroupPostProcessor.GroupStats second) {
        int groups = Integer.compare(first.groups(), second.groups());
        if (groups != 0) {
            return groups;
        }
        int odd = Integer.compare(first.oddCarGroups(), second.oddCarGroups());
        if (odd != 0) {
            return odd;
        }
        int one = Integer.compare(first.oneCarGroups(), second.oneCarGroups());
        return one != 0 ? one : Integer.compare(first.smallCarGroups(), second.smallCarGroups());
    }

    private String summarizeCandidates(List<ScoredInstructionPlan> candidates) {
        return candidates.stream()
                .sorted(Comparator.comparingInt(candidate -> candidatePreference(candidate.name())))
                .map(candidate -> candidate.name() + "=" + candidate.sequenceGroupCount())
                .collect(Collectors.joining(", "));
    }

    private List<SequenceCandidateRow> buildSequenceCandidateRows(
            List<ScoredInstructionPlan> candidates,
            String selectedName) {
        return candidates.stream()
                .sorted(Comparator.comparingInt((ScoredInstructionPlan candidate) -> candidatePreference(candidate.name()))
                        .thenComparingInt(ScoredInstructionPlan::sequenceGroupCount))
                .map(candidate -> new SequenceCandidateRow(
                        candidate.name(),
                        candidate.sequenceGroupCount(),
                        candidate.instructions().size(),
                        candidate.name().equals(selectedName)))
                .toList();
    }

    private int candidatePreference(String name) {
        return switch (name) {
            case "stage5-mip" -> 0;
            case "phase2-cg" -> 1;
            case "greedy" -> 2;
            case "greedy-reuse" -> 3;
            default -> Integer.MAX_VALUE;
        };
    }

    private record ScoredInstructionPlan(
            String name,
            List<CuttingInstruction> instructions,
            int sequenceGroupCount,
            int oddCarGroups,
            int oneCarGroups,
            int smallCarGroups) {
    }

    public record ConversionResult(
            List<CuttingInstruction> instructions,
            String selectedName,
            int selectedSequenceGroups,
            List<SequenceCandidateRow> candidateRows) {
    }

    public record SequenceCandidateRow(
            String name,
            int sequenceGroupCount,
            int instructions,
            boolean selected) {
    }
}
