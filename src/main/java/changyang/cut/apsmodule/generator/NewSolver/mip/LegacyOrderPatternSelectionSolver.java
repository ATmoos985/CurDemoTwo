package changyang.cut.apsmodule.generator.NewSolver.mip;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverParameters;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverRuntimeProperties;
import changyang.cut.apsmodule.generator.NewSolver.mip.LegacyPatternMipSupport.Stage1Result;
import changyang.cut.apsmodule.generator.NewSolver.mip.LegacyPatternMipSupport.StageSolution;
import changyang.cut.apsmodule.generator.NewSolver.model.PatternCandidate;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

class LegacyOrderPatternSelectionSolver {

    private static final Logger log = LoggerFactory.getLogger(LegacyOrderPatternSelectionSolver.class);
    private static final int MAX_REPAIR_ATTEMPTS = 3;
    private static final int DEFAULT_STAGE4_PARITY_POOL_CAP = 240;

    private final SolverParameters params;
    private final PatternAlignmentScorer alignmentScorer;

    LegacyOrderPatternSelectionSolver(SolverParameters params) {
        this(params, PatternAlignmentContext.empty());
    }

    LegacyOrderPatternSelectionSolver(SolverParameters params, PatternAlignmentContext alignmentContext) {
        this.params = params;
        this.alignmentScorer = new PatternAlignmentScorer(alignmentContext);
    }

    static long stage4NodeLimit() {
        return LegacyPatternStage4Mip.stage4NodeLimit();
    }

    static long stage4WallLimitMs(long remainingTimeMs) {
        return LegacyPatternStage4Mip.stage4WallLimitMs(remainingTimeMs);
    }

    static long effectiveStage4NodeLimit(double parityPenalty, double alignmentLambda) {
        return LegacyPatternStage4Mip.effectiveStage4NodeLimit(parityPenalty, alignmentLambda);
    }

    List<Result> solveCandidates(List<PatternCandidate> patterns,
            Map<Integer, Integer> demands,
            Set<Integer> allowOverSet) {
        return solveCandidates(patterns, demands, allowOverSet,
                System.currentTimeMillis() + params.getTimeoutMs());
    }

    List<Result> solveCandidates(List<PatternCandidate> patterns,
            Map<Integer, Integer> demands,
            Set<Integer> allowOverSet,
            long deadlineMs) {
        Set<String> seen = patterns.stream()
                .map(PatternCandidate::signature)
                .collect(Collectors.toCollection(HashSet::new));
        Set<Integer> baseAllowOverSet = LegacyPatternMipSupport.mergeForcedAllowOverWidths(allowOverSet, params);
        Set<Integer> expandedAllowOverSet = LegacyPatternMipSupport.mergeForcedAllowOverWidths(
                expandAllowOverSet(demands, params.getTopK() + 2), params);
        Set<Integer> relaxedAllowOverSet = LegacyPatternMipSupport.mergeForcedAllowOverWidths(
                new HashSet<>(demands.keySet()), params);
        Set<Integer> workingAllowOverSet = LegacyPatternMipSupport.mergeForcedAllowOverWidths(allowOverSet, params);

        for (int attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
            log.info("--- Legacy-order pattern selection attempt {}/{} ---",
                    attempt + 1, MAX_REPAIR_ATTEMPTS + 1);

            StageSolution solved = solveFinalMIP(
                    patterns,
                    demands,
                    workingAllowOverSet,
                    deadlineMs);

            if (solved != null && LegacyPatternMipSupport.isFeasible(solved.solution(), demands)) {
                boolean reusableStage3 = attempt == 0 && solved.optimal();
                return List.of(new Result("legacy-order", new LinkedHashMap<>(solved.solution()), reusableStage3));
            }

            if (attempt >= MAX_REPAIR_ATTEMPTS) {
                break;
            }

            int repaired = repairPatterns(patterns, seen, demands, workingAllowOverSet);
            log.info("Legacy-order repair added {} patterns", repaired);
            boolean movedToNextAllowOverTier = false;
            if (params.getTotalOverCap() > 0
                    && workingAllowOverSet.equals(baseAllowOverSet)
                    && !expandedAllowOverSet.equals(baseAllowOverSet)) {
                workingAllowOverSet = expandedAllowOverSet;
                movedToNextAllowOverTier = true;
                log.info("Legacy-order expanded allowOverSet to {}", workingAllowOverSet.size());
            } else if (params.getTotalOverCap() > 0
                    && workingAllowOverSet.equals(expandedAllowOverSet)
                    && !relaxedAllowOverSet.equals(expandedAllowOverSet)) {
                workingAllowOverSet = relaxedAllowOverSet;
                movedToNextAllowOverTier = true;
                log.warn("Legacy-order entering emergency relaxed-over fallback on all demand widths");
            }
            if (repaired == 0 && !movedToNextAllowOverTier) {
                break;
            }
        }

        return Collections.emptyList();
    }

    Map<PatternCandidate, Integer> refineStage4FromBaseline(
            List<PatternCandidate> patterns,
            Map<Integer, Integer> demands,
            Set<Integer> allowOverSet,
            Map<PatternCandidate, Integer> baseline,
            long deadlineMs) {
        if (!LegacyPatternMipSupport.isFeasible(baseline, demands)) {
            log.warn("Complete-pool Stage4 skipped: baseline is not demand-feasible");
            return null;
        }

        int maxTotalOver = LegacyPatternMipSupport.calculateTotalOver(baseline, demands);
        int maxTotalRolls = baseline.values().stream().mapToInt(Integer::intValue).sum();
        int maxTotalWaste = LegacyPatternMipSupport.calculateTotalWaste(baseline, params.getTotalWidth());
        long remainingMs = Math.max(2_000L, deadlineMs - System.currentTimeMillis());
        log.info("Complete-pool Stage4 baseline constraints: patterns={}, maxOver={}, "
                        + "maxRolls={}, maxWaste={}mm, remainingMs={}",
                patterns.size(), maxTotalOver, maxTotalRolls, maxTotalWaste, remainingMs);

        Map<PatternCandidate, Integer> refined = LegacyPatternStage4Mip.solveMIPStage4(
                params,
                alignmentScorer,
                patterns,
                demands,
                LegacyPatternMipSupport.mergeForcedAllowOverWidths(allowOverSet, params),
                maxTotalOver,
                maxTotalRolls,
                maxTotalWaste,
                remainingMs,
                baseline);
        if (!LegacyPatternMipSupport.isFeasible(refined, demands)) {
            log.warn("Complete-pool Stage4 returned no demand-feasible refinement");
            return null;
        }
        return refined;
    }

    /**
     * 复用同源 Stage3 基线直接进入 Stage4（跳过完全重复的 Stage1/2/3 主求解），
     * 严格约束 over/rolls/waste 不劣于基线，baseline 本身由上层保底，保证零劣化。
     */
    Map<PatternCandidate, Integer> refineStage4FromStage3Baseline(
            List<PatternCandidate> fullPatterns,
            Map<Integer, Integer> demands,
            Set<Integer> allowOverSet,
            Map<PatternCandidate, Integer> stage3Baseline,
            long deadlineMs) {
        if (!LegacyPatternMipSupport.isFeasible(stage3Baseline, demands)) {
            log.warn("Stage3-baseline Stage4 skipped: baseline is not demand-feasible");
            return null;
        }

        int maxTotalOver = LegacyPatternMipSupport.calculateTotalOver(stage3Baseline, demands);
        int maxTotalRolls = stage3Baseline.values().stream().mapToInt(Integer::intValue).sum();
        int maxTotalWaste = LegacyPatternMipSupport.calculateTotalWaste(stage3Baseline, params.getTotalWidth());
        int wasteSlack = Math.max(200, (int) (maxTotalWaste * 0.05));
        log.info("Legacy Stage4 (reused Stage3) constraints: maxRolls={}, maxWaste={}, wasteSlack={}, wasteCap={}",
                maxTotalRolls, maxTotalWaste, wasteSlack, maxTotalWaste + wasteSlack);

        long remainingMs = Math.max(2_000L, deadlineMs - System.currentTimeMillis());
        boolean stage4NeedsFullPool = params.getALayerAlignmentLambda() > 0.0
                || LegacyPatternStage4Mip.parityPenalty() > 0.0;
        List<PatternCandidate> stage4PatternPool;
        if (stage4NeedsFullPool) {
            stage4PatternPool = selectStage4ExpandedPool(fullPatterns, stage3Baseline);
            log.info("Legacy Stage4 (reused Stage3) uses expanded pattern pool: {}/{} patterns",
                    stage4PatternPool.size(), fullPatterns.size());
        } else {
            stage4PatternPool = new ArrayList<>(stage3Baseline.keySet());
        }

        Map<PatternCandidate, Integer> stage4Solution = LegacyPatternStage4Mip.solveMIPStage4(
                params,
                alignmentScorer,
                stage4PatternPool,
                demands,
                LegacyPatternMipSupport.mergeForcedAllowOverWidths(allowOverSet, params),
                maxTotalOver,
                maxTotalRolls,
                maxTotalWaste,
                remainingMs,
                Collections.emptyMap());
        if (!LegacyPatternMipSupport.isFeasible(stage4Solution, demands)) {
            log.info("Legacy Stage4 (reused Stage3) returned no improvement, keeping baseline");
            return null;
        }
        int stage4Rolls = stage4Solution.values().stream().mapToInt(Integer::intValue).sum();
        int stage4Patterns = stage4Solution.size();
        int stage4Waste = LegacyPatternMipSupport.calculateTotalWaste(stage4Solution, params.getTotalWidth());
        log.info("Legacy Stage4 (reused Stage3) completed: rolls={}, patterns={}, waste={}mm, sig#={}",
                stage4Rolls, stage4Patterns, stage4Waste,
                LegacyPatternMipSupport.solutionSignatureHash(stage4Solution));
        return stage4Solution;
    }

    private List<PatternCandidate> selectStage4ExpandedPool(
            List<PatternCandidate> fullPatterns,
            Map<PatternCandidate, Integer> stage3Baseline) {
        int cap = Math.max(stage3Baseline.size(),
                SolverRuntimeProperties.getInt("cutting.aLayerStage4ParityPoolCap", DEFAULT_STAGE4_PARITY_POOL_CAP));
        Map<String, PatternCandidate> merged = new LinkedHashMap<>();
        if (fullPatterns.size() <= cap) {
            for (PatternCandidate pattern : fullPatterns) {
                merged.putIfAbsent(pattern.signature(), pattern);
            }
            for (PatternCandidate pattern : stage3Baseline.keySet()) {
                merged.putIfAbsent(pattern.signature(), pattern);
            }
            return new ArrayList<>(merged.values());
        }
        for (PatternCandidate pattern : stage3Baseline.keySet()) {
            merged.putIfAbsent(pattern.signature(), pattern);
        }
        int totalWidth = params.getTotalWidth();
        List<PatternCandidate> rankedExtras = fullPatterns.stream()
                .filter(pattern -> !merged.containsKey(pattern.signature()))
                .sorted(java.util.Comparator
                        .comparingInt((PatternCandidate p) -> p.getRealWaste(totalWidth))
                        .thenComparing(PatternCandidate::signature))
                .toList();
        for (PatternCandidate candidate : rankedExtras) {
            if (merged.size() >= cap) {
                break;
            }
            merged.putIfAbsent(candidate.signature(), candidate);
        }
        return new ArrayList<>(merged.values());
    }

    private StageSolution solveFinalMIP(List<PatternCandidate> patterns,
            Map<Integer, Integer> demands,
            Set<Integer> allowOverSet,
            long deadlineMs) {
        boolean fastPreview = SolverRuntimeProperties.getBoolean("cutting.fast.preview", false);
        long now = System.currentTimeMillis();
        long remaining = Math.max(fastPreview ? 500 : 5000, deadlineMs - now);
        long stage1Time = fastPreview
                ? Math.max(500, remaining * 40 / 100)
                : Math.max(5000, remaining / 6);
        Stage1Result stage1Result = LegacyPatternStage1To3Mip.solveMIPStage1(
                params, patterns, demands, allowOverSet, stage1Time);
        if (stage1Result == null) {
            return new StageSolution(Collections.emptyMap(), false);
        }

        int optimalUnder = stage1Result.totalUnder();
        int optimalOver = stage1Result.totalOver();
        Map<PatternCandidate, Integer> completeBaseline = LegacyPatternMipSupport.isFeasible(
                stage1Result.solution(), demands)
                ? stage1Result.solution()
                : Collections.emptyMap();
        log.info("Legacy Stage1 completed: under={}, over={}, completeBaseline={}, rolls={}",
                optimalUnder, optimalOver, !completeBaseline.isEmpty(),
                stage1Result.solution().values().stream().mapToInt(Integer::intValue).sum());
        remaining = Math.max(fastPreview ? 750 : 5000, deadlineMs - System.currentTimeMillis());
        long stage2Time = fastPreview
                ? Math.max(750, remaining * 45 / 100)
                : Math.max(5000, remaining * 55 / 100);
        StageSolution stage2Result = LegacyPatternStage1To3Mip.solveMIPStage2(
                params, patterns, demands, allowOverSet, optimalUnder, optimalOver,
                stage1Result.solution(), stage2Time);
        Map<PatternCandidate, Integer> stage2Solution = stage2Result == null ? null : stage2Result.solution();
        if (!LegacyPatternMipSupport.isFeasible(stage2Solution, demands)) {
            if (!completeBaseline.isEmpty()) {
                log.warn("Legacy Stage2 did not preserve complete demand coverage; using Stage1 baseline");
                return new StageSolution(completeBaseline, false);
            }
            return new StageSolution(Collections.emptyMap(), false);
        }

        int totalRolls = stage2Solution.values().stream().mapToInt(Integer::intValue).sum();
        int stage2Patterns = stage2Solution.size();
        int stage2Waste = LegacyPatternMipSupport.calculateTotalWaste(stage2Solution, params.getTotalWidth());
        log.info("Legacy Stage2 completed: rolls={}, patterns={}, waste={}mm, sig#={}",
                totalRolls, stage2Patterns, stage2Waste,
                LegacyPatternMipSupport.solutionSignatureHash(stage2Solution));

        if (fastPreview && System.currentTimeMillis() >= deadlineMs) {
            log.info("Fast preview A-layer budget reached after Stage2; using roll-optimal solution");
            return new StageSolution(stage2Solution, false);
        }

        remaining = Math.max(fastPreview ? 500 : 3000, deadlineMs - System.currentTimeMillis());
        long stage3Time = fastPreview
                ? Math.max(500, remaining)
                : Math.max(3000, remaining * 60 / 100);
        StageSolution stage3Result = LegacyPatternStage1To3Mip.solveMIPStage3(
                params, patterns, demands, allowOverSet, optimalOver, totalRolls, stage3Time);
        Map<PatternCandidate, Integer> stage3Solution = stage3Result == null ? null : stage3Result.solution();
        boolean stage3Optimal = stage1Result.optimal()
                && stage2Result.optimal()
                && stage3Result != null
                && stage3Result.optimal();
        if (stage3Solution == null || stage3Solution.isEmpty()) {
            log.info("Legacy Stage3 failed, using Stage2 solution");
            stage3Solution = stage2Solution;
            stage3Optimal = false;
        }

        int totalWaste = LegacyPatternMipSupport.calculateTotalWaste(stage3Solution, params.getTotalWidth());
        int stage3Rolls = stage3Solution.values().stream().mapToInt(Integer::intValue).sum();
        int stage3Patterns = stage3Solution.size();
        log.info("Legacy Stage3 completed: rolls={}, patterns={}, waste={}mm, sig#={}",
                stage3Rolls, stage3Patterns, totalWaste,
                LegacyPatternMipSupport.solutionSignatureHash(stage3Solution));

        if (fastPreview) {
            log.info("Fast preview skips A-layer Stage4 pattern-count refinement");
            return new StageSolution(stage3Solution, stage3Optimal);
        }

        int wasteSlack = Math.max(200, (int) (totalWaste * 0.05));
        log.info("Legacy Stage4 constraints: maxRolls={}, maxWaste={}, wasteSlack={}, wasteCap={}",
                stage3Rolls, totalWaste, wasteSlack, totalWaste + wasteSlack);

        remaining = Math.max(2000, deadlineMs - System.currentTimeMillis());
        long stage4Time = remaining;
        boolean stage4NeedsFullPool = params.getALayerAlignmentLambda() > 0.0
                || LegacyPatternStage4Mip.parityPenalty() > 0.0;
        List<PatternCandidate> stage4PatternPool = stage4NeedsFullPool
                ? selectStage4ExpandedPool(patterns, stage3Solution)
                : new ArrayList<>(stage3Solution.keySet());
        if (stage4NeedsFullPool) {
            log.info("Legacy Stage4 uses expanded pattern pool: {}/{} patterns",
                    stage4PatternPool.size(), patterns.size());
        }
        Map<PatternCandidate, Integer> stage4Solution = LegacyPatternStage4Mip.solveMIPStage4(
                params, alignmentScorer, stage4PatternPool, demands, allowOverSet,
                optimalOver, stage3Rolls, totalWaste, stage4Time);
        if (stage4Solution == null || stage4Solution.isEmpty()) {
            log.info("Legacy Stage4 failed, using Stage3 solution");
            return new StageSolution(stage3Solution, stage3Optimal);
        }
        int stage4Rolls = stage4Solution.values().stream().mapToInt(Integer::intValue).sum();
        int stage4Patterns = stage4Solution.size();
        int stage4Waste = LegacyPatternMipSupport.calculateTotalWaste(stage4Solution, params.getTotalWidth());
        log.info("Legacy Stage4 completed: rolls={}, patterns={}, waste={}mm, sig#={}",
                stage4Rolls, stage4Patterns, stage4Waste,
                LegacyPatternMipSupport.solutionSignatureHash(stage4Solution));
        return new StageSolution(stage4Solution, stage3Optimal);
    }

    private Set<Integer> expandAllowOverSet(Map<Integer, Integer> demands, int newTopK) {
        List<Map.Entry<Integer, Integer>> sorted = demands.entrySet().stream()
                .sorted((a, b) -> Integer.compare(b.getValue(), a.getValue()))
                .toList();

        Set<Integer> expandedSet = new HashSet<>();
        for (int i = 0; i < Math.min(newTopK, sorted.size()); i++) {
            expandedSet.add(sorted.get(i).getKey());
        }
        return expandedSet;
    }

    Map<PatternCandidate, Integer> solveMIPStage4(List<PatternCandidate> patterns,
            Map<Integer, Integer> demands,
            Set<Integer> allowOverSet,
            int maxTotalOver,
            int maxTotalRolls,
            int maxTotalWaste,
            long timeLimitMs) {
        return LegacyPatternStage4Mip.solveMIPStage4(
                params, alignmentScorer, patterns, demands, allowOverSet,
                maxTotalOver, maxTotalRolls, maxTotalWaste, timeLimitMs);
    }

    private int repairPatterns(List<PatternCandidate> patterns,
            Set<String> seen,
            Map<Integer, Integer> demands,
            Set<Integer> allowOverSet) {
        int repaired = 0;
        List<Integer> widths = new ArrayList<>(demands.keySet());
        widths.sort((a, b) -> Integer.compare(demands.get(b), demands.get(a)));

        for (int width : demands.keySet()) {
            List<Integer> coefficients = new ArrayList<>();
            for (PatternCandidate pattern : patterns) {
                int count = pattern.getPattern().getOrDefault(width, 0);
                if (count > 0) {
                    coefficients.add(count);
                }
            }

            boolean needsRepair = coefficients.isEmpty();
            if (!needsRepair) {
                int divisor = coefficients.get(0);
                for (int coefficient : coefficients) {
                    divisor = LegacyPatternMipSupport.gcd(divisor, coefficient);
                }
                int capForWidth = allowOverSet.contains(width) ? params.getTotalOverCap() : 0;
                boolean reachable = false;
                for (int extra = 0; extra <= capForWidth; extra++) {
                    if ((demands.get(width) + extra) % divisor == 0) {
                        reachable = true;
                        break;
                    }
                }
                needsRepair = !reachable;
            }

            if (!needsRepair) {
                continue;
            }

            boolean found = false;
            for (int fillWidth : widths) {
                if (fillWidth == width || found) {
                    continue;
                }
                for (int fillCount = 1; fillCount <= 5; fillCount++) {
                    int totalWidth = width + fillWidth * fillCount;
                    if (totalWidth < params.getMinRollWidth()) {
                        continue;
                    }
                    if (totalWidth > params.getMaxRollWidth()) {
                        break;
                    }

                    int rollWidth = LegacyPatternMipSupport.ceilToStep(totalWidth, params.getStepSize());
                    rollWidth = Math.max(rollWidth, params.getMinRollWidth());
                    rollWidth = Math.min(rollWidth, params.getMaxRollWidth());
                    if (totalWidth > rollWidth) {
                        continue;
                    }

                    Map<Integer, Integer> candidatePattern = new LinkedHashMap<>();
                    candidatePattern.put(width, 1);
                    candidatePattern.put(fillWidth, fillCount);
                    PatternCandidate candidate = new PatternCandidate(candidatePattern, rollWidth);
                    if (seen.add(candidate.signature())) {
                        patterns.add(candidate);
                        repaired++;
                        found = true;
                        break;
                    }
                }
            }
        }

        return repaired;
    }

    record Result(
            String name,
            Map<PatternCandidate, Integer> solution,
            boolean stage3Optimal) {
    }
}
