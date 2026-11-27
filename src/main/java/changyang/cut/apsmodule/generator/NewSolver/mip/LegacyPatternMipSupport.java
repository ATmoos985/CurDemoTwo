package changyang.cut.apsmodule.generator.NewSolver.mip;

import com.google.ortools.linearsolver.MPSolver;
import com.google.ortools.linearsolver.MPVariable;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverParameters;
import changyang.cut.apsmodule.generator.NewSolver.model.PatternCandidate;

import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * LegacyOrderPatternSelectionSolver 的共享 MIP 基础设施、度量化工具与阶段结果记录。
 */
final class LegacyPatternMipSupport {

    static final int MIN_USAGE_THRESHOLD = 4;
    static final double SMALL_USAGE_PENALTY = 0.02;

    /**
     * 固定 SCIP 随机化种子，保证相同输入 → 相同解。
     */
    static final String SCIP_DETERMINISTIC_PARAMS =
            "randomization/randomseedshift = 0\n"
          + "randomization/permutationseed = 0\n"
          + "randomization/lpseed = 0\n";

    record Stage1Result(
            Map<PatternCandidate, Integer> solution,
            int totalUnder,
            int totalOver,
            boolean optimal) {

        Stage1Result {
            solution = Collections.unmodifiableMap(new LinkedHashMap<>(solution));
        }
    }

    record StageSolution(
            Map<PatternCandidate, Integer> solution,
            boolean optimal) {
    }

    private LegacyPatternMipSupport() {
    }

    static String scipParams(SolverParameters params) {
        int s = params.getALayerScipSeed();
        if (s == 0) {
            return SCIP_DETERMINISTIC_PARAMS;
        }
        return "randomization/randomseedshift = " + s + "\n"
             + "randomization/permutationseed = " + s + "\n"
             + "randomization/lpseed = " + s + "\n";
    }

    static MPSolver createMIPSolver(SolverParameters params) {
        MPSolver solver = MPSolver.createSolver("SCIP");
        if (solver != null) {
            // 仅 SCIP 接受该参数串；CBC 回退路径不应用。
            solver.setSolverSpecificParametersAsString(scipParams(params));
            // 单线程：多线程 MIP 是非确定性的经典来源（线程竞争与种子无关）。
            try { solver.setNumThreads(1); } catch (Exception ignored) {}
            return solver;
        }
        return MPSolver.createSolver("CBC");
    }

    static Map<PatternCandidate, Integer> extractSolution(
            List<PatternCandidate> patterns, List<MPVariable> xVars) {
        Map<PatternCandidate, Integer> solution = new LinkedHashMap<>();
        for (int i = 0; i < patterns.size(); i++) {
            int usage = (int) Math.round(xVars.get(i).solutionValue());
            if (usage > 0) {
                solution.put(patterns.get(i), usage);
            }
        }
        return solution;
    }

    static long safeNodes(MPSolver solver) {
        try {
            return solver.nodes();
        } catch (Throwable ignored) {
            return -1L;
        }
    }

    static boolean isFeasible(Map<PatternCandidate, Integer> solution, Map<Integer, Integer> demands) {
        if (solution == null || solution.isEmpty()) {
            return false;
        }
        Map<Integer, Integer> production = calculateProduction(solution);
        for (Map.Entry<Integer, Integer> demandEntry : demands.entrySet()) {
            if (production.getOrDefault(demandEntry.getKey(), 0) < demandEntry.getValue()) {
                return false;
            }
        }
        return true;
    }

    static int calculateTotalWaste(Map<PatternCandidate, Integer> solution, int totalWidth) {
        return solution.entrySet().stream()
                .mapToInt(entry -> entry.getKey().getRealWaste(totalWidth) * entry.getValue())
                .sum();
    }

    static int calculateTotalOver(Map<PatternCandidate, Integer> solution,
            Map<Integer, Integer> demands) {
        Map<Integer, Integer> production = calculateProduction(solution);
        return demands.entrySet().stream()
                .mapToInt(entry -> Math.max(
                        0, production.getOrDefault(entry.getKey(), 0) - entry.getValue()))
                .sum();
    }

    static Map<Integer, Integer> calculateProduction(Map<PatternCandidate, Integer> solution) {
        Map<Integer, Integer> produced = new LinkedHashMap<>();
        for (Map.Entry<PatternCandidate, Integer> entry : solution.entrySet()) {
            for (Map.Entry<Integer, Integer> cut : entry.getKey().getPattern().entrySet()) {
                produced.merge(cut.getKey(), cut.getValue() * entry.getValue(), Integer::sum);
            }
        }
        return produced;
    }

    static int solutionSignatureHash(Map<PatternCandidate, Integer> solution) {
        return solution.entrySet().stream()
                .map(entry -> entry.getKey().signature() + "x" + entry.getValue())
                .sorted()
                .collect(Collectors.joining("|"))
                .hashCode();
    }

    static Set<Integer> mergeForcedAllowOverWidths(Set<Integer> allowOverSet, SolverParameters params) {
        Set<Integer> merged = new HashSet<>(allowOverSet);
        merged.addAll(params.getForceAllowOverWidths());
        return merged;
    }

    static int gcd(int a, int b) {
        while (b != 0) {
            int temp = b;
            b = a % b;
            a = temp;
        }
        return a;
    }

    static int ceilToStep(int value, int step) {
        return ((value + step - 1) / step) * step;
    }
}
