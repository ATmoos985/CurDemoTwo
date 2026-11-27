package changyang.cut.apsmodule.generator.NewSolver.mip;

import com.google.ortools.linearsolver.MPConstraint;
import com.google.ortools.linearsolver.MPObjective;
import com.google.ortools.linearsolver.MPSolver;
import com.google.ortools.linearsolver.MPVariable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverParameters;
import changyang.cut.apsmodule.generator.NewSolver.mip.LegacyPatternMipSupport.Stage1Result;
import changyang.cut.apsmodule.generator.NewSolver.mip.LegacyPatternMipSupport.StageSolution;
import changyang.cut.apsmodule.generator.NewSolver.model.PatternCandidate;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * LegacyOrderPatternSelectionSolver 的 Stage 1~3 MIP 建模与求解。
 */
final class LegacyPatternStage1To3Mip {

    private static final Logger log = LoggerFactory.getLogger(LegacyPatternStage1To3Mip.class);

    private LegacyPatternStage1To3Mip() {
    }

    static Stage1Result solveMIPStage1(
            SolverParameters params,
            List<PatternCandidate> patterns,
            Map<Integer, Integer> demands,
            Set<Integer> allowOverSet,
            long timeLimitMs) {
        MPSolver solver = null;
        try {
            solver = LegacyPatternMipSupport.createMIPSolver(params);
            if (solver == null) {
                return null;
            }

            int totalDemand = demands.values().stream().mapToInt(Integer::intValue).sum();
            List<Integer> widthList = new ArrayList<>(demands.keySet());

            List<MPVariable> xVars = new ArrayList<>();
            for (int i = 0; i < patterns.size(); i++) {
                xVars.add(solver.makeIntVar(0, totalDemand + params.getTotalOverCap(), "x_" + i));
            }

            Map<Integer, MPVariable> overVars = new LinkedHashMap<>();
            Map<Integer, MPVariable> underVars = new LinkedHashMap<>();
            for (int width : widthList) {
                double overUpperBound = allowOverSet.contains(width) ? params.getTotalOverCap() : 0;
                overVars.put(width, solver.makeIntVar(0, overUpperBound, "over_" + width));
                underVars.put(width, solver.makeIntVar(0, totalDemand, "under_" + width));
            }

            for (Map.Entry<Integer, Integer> demandEntry : demands.entrySet()) {
                int width = demandEntry.getKey();
                int demand = demandEntry.getValue();
                MPConstraint constraint = solver.makeConstraint(demand, demand, "demand_" + width);

                for (int i = 0; i < patterns.size(); i++) {
                    int count = patterns.get(i).getPattern().getOrDefault(width, 0);
                    if (count > 0) {
                        constraint.setCoefficient(xVars.get(i), count);
                    }
                }
                constraint.setCoefficient(underVars.get(width), 1);
                constraint.setCoefficient(overVars.get(width), -1);
            }

            MPConstraint overCap = solver.makeConstraint(0, params.getTotalOverCap(), "overCap");
            for (MPVariable overVar : overVars.values()) {
                overCap.setCoefficient(overVar, 1);
            }

            MPObjective objective = solver.objective();
            for (MPVariable underVar : underVars.values()) {
                objective.setCoefficient(underVar, params.getUnderPenalty());
            }
            for (MPVariable overVar : overVars.values()) {
                objective.setCoefficient(overVar, 1);
            }
            objective.setMinimization();

            solver.setTimeLimit(Math.max(1000, timeLimitMs));
            MPSolver.ResultStatus status = solver.solve();
            if (status != MPSolver.ResultStatus.OPTIMAL && status != MPSolver.ResultStatus.FEASIBLE) {
                log.warn("Legacy-order Stage1 returned {}", status);
                return null;
            }

            int totalUnder = 0;
            int totalOver = 0;
            for (int i = 0; i < widthList.size(); i++) {
                int width = widthList.get(i);
                totalUnder += (int) Math.round(underVars.get(width).solutionValue());
                totalOver += (int) Math.round(overVars.get(width).solutionValue());
            }
            return new Stage1Result(
                    LegacyPatternMipSupport.extractSolution(patterns, xVars),
                    totalUnder,
                    totalOver,
                    status == MPSolver.ResultStatus.OPTIMAL);
        } catch (Exception e) {
            log.error("Legacy-order Stage1 failed", e);
            return null;
        } finally {
            if (solver != null) {
                solver.delete();
            }
        }
    }

    static StageSolution solveMIPStage2(
            SolverParameters params,
            List<PatternCandidate> patterns,
            Map<Integer, Integer> demands,
            Set<Integer> allowOverSet,
            int maxTotalUnder,
            int maxTotalOver,
            Map<PatternCandidate, Integer> incumbent,
            long timeLimitMs) {
        MPSolver solver = null;
        try {
            solver = LegacyPatternMipSupport.createMIPSolver(params);
            if (solver == null) {
                return null;
            }

            int totalDemand = demands.values().stream().mapToInt(Integer::intValue).sum();

            List<MPVariable> xVars = new ArrayList<>();
            for (int i = 0; i < patterns.size(); i++) {
                xVars.add(solver.makeIntVar(0, totalDemand + params.getTotalOverCap(), "x_" + i));
            }

            Map<Integer, MPVariable> overVars = new LinkedHashMap<>();
            Map<Integer, MPVariable> underVars = new LinkedHashMap<>();
            for (int width : demands.keySet()) {
                double overUpperBound = allowOverSet.contains(width) ? params.getTotalOverCap() : 0;
                overVars.put(width, solver.makeIntVar(0, overUpperBound, "over_" + width));
                underVars.put(width, solver.makeIntVar(0, totalDemand, "under_" + width));
            }

            for (Map.Entry<Integer, Integer> demandEntry : demands.entrySet()) {
                int width = demandEntry.getKey();
                int demand = demandEntry.getValue();
                MPConstraint constraint = solver.makeConstraint(demand, demand, "demand_" + width);

                for (int i = 0; i < patterns.size(); i++) {
                    int count = patterns.get(i).getPattern().getOrDefault(width, 0);
                    if (count > 0) {
                        constraint.setCoefficient(xVars.get(i), count);
                    }
                }
                constraint.setCoefficient(underVars.get(width), 1);
                constraint.setCoefficient(overVars.get(width), -1);
            }

            MPConstraint overCap = solver.makeConstraint(0, maxTotalOver, "overCap");
            for (MPVariable overVar : overVars.values()) {
                overCap.setCoefficient(overVar, 1);
            }

            MPConstraint underCap = solver.makeConstraint(0, maxTotalUnder, "underCap");
            for (MPVariable underVar : underVars.values()) {
                underCap.setCoefficient(underVar, 1);
            }

            MPObjective objective = solver.objective();
            for (MPVariable underVar : underVars.values()) {
                objective.setCoefficient(underVar, params.getUnderPenalty());
            }
            for (MPVariable xVar : xVars) {
                objective.setCoefficient(xVar, 1);
            }
            objective.setMinimization();

            if (incumbent != null && !incumbent.isEmpty()) {
                MPVariable[] hintVars = xVars.toArray(new MPVariable[0]);
                double[] hintValues = new double[hintVars.length];
                for (int i = 0; i < patterns.size(); i++) {
                    hintValues[i] = incumbent.getOrDefault(patterns.get(i), 0);
                }
                solver.setHint(hintVars, hintValues);
            }

            solver.setTimeLimit(Math.max(1000, timeLimitMs));
            long startedAt = System.currentTimeMillis();
            MPSolver.ResultStatus status = solver.solve();
            log.info("Legacy Stage2 solve: status={}, elapsedMs={}, nodes={}, wallLimitMs={}",
                    status, System.currentTimeMillis() - startedAt,
                    LegacyPatternMipSupport.safeNodes(solver), timeLimitMs);
            if (status != MPSolver.ResultStatus.OPTIMAL && status != MPSolver.ResultStatus.FEASIBLE) {
                log.warn("Legacy-order Stage2 returned {}", status);
                return null;
            }

            return new StageSolution(
                    LegacyPatternMipSupport.extractSolution(patterns, xVars),
                    status == MPSolver.ResultStatus.OPTIMAL);
        } catch (Exception e) {
            log.error("Legacy-order Stage2 failed", e);
            return null;
        } finally {
            if (solver != null) {
                solver.delete();
            }
        }
    }

    static StageSolution solveMIPStage3(
            SolverParameters params,
            List<PatternCandidate> patterns,
            Map<Integer, Integer> demands,
            Set<Integer> allowOverSet,
            int maxTotalOver,
            int maxTotalRolls,
            long timeLimitMs) {
        MPSolver solver = null;
        try {
            solver = LegacyPatternMipSupport.createMIPSolver(params);
            if (solver == null) {
                return null;
            }

            int totalDemand = demands.values().stream().mapToInt(Integer::intValue).sum();

            List<MPVariable> xVars = new ArrayList<>();
            for (int i = 0; i < patterns.size(); i++) {
                xVars.add(solver.makeIntVar(0, totalDemand + params.getTotalOverCap(), "x_" + i));
            }

            Map<Integer, MPVariable> overVars = new LinkedHashMap<>();
            for (int width : demands.keySet()) {
                double overUpperBound = allowOverSet.contains(width) ? params.getTotalOverCap() : 0;
                overVars.put(width, solver.makeIntVar(0, overUpperBound, "over_" + width));
            }

            for (Map.Entry<Integer, Integer> demandEntry : demands.entrySet()) {
                int width = demandEntry.getKey();
                int demand = demandEntry.getValue();
                MPConstraint constraint = solver.makeConstraint(demand, demand, "demand_" + width);

                for (int i = 0; i < patterns.size(); i++) {
                    int count = patterns.get(i).getPattern().getOrDefault(width, 0);
                    if (count > 0) {
                        constraint.setCoefficient(xVars.get(i), count);
                    }
                }
                constraint.setCoefficient(overVars.get(width), -1);
            }

            MPConstraint overCap = solver.makeConstraint(0, maxTotalOver, "overCap");
            for (MPVariable overVar : overVars.values()) {
                overCap.setCoefficient(overVar, 1);
            }

            MPConstraint rollsCap = solver.makeConstraint(0, maxTotalRolls, "rollsCap");
            for (MPVariable xVar : xVars) {
                rollsCap.setCoefficient(xVar, 1);
            }

            MPObjective objective = solver.objective();
            for (int i = 0; i < patterns.size(); i++) {
                objective.setCoefficient(xVars.get(i), patterns.get(i).getRealWaste(params.getTotalWidth()));
            }
            objective.setMinimization();

            solver.setTimeLimit(Math.max(1000, timeLimitMs));
            long startedAt = System.currentTimeMillis();
            MPSolver.ResultStatus status = solver.solve();
            log.info("Legacy Stage3 solve: status={}, elapsedMs={}, nodes={}, wallLimitMs={}",
                    status, System.currentTimeMillis() - startedAt,
                    LegacyPatternMipSupport.safeNodes(solver), timeLimitMs);
            if (status != MPSolver.ResultStatus.OPTIMAL && status != MPSolver.ResultStatus.FEASIBLE) {
                log.warn("Legacy-order Stage3 returned {}", status);
                return null;
            }

            return new StageSolution(
                    LegacyPatternMipSupport.extractSolution(patterns, xVars),
                    status == MPSolver.ResultStatus.OPTIMAL);
        } catch (Exception e) {
            log.error("Legacy-order Stage3 failed", e);
            return null;
        } finally {
            if (solver != null) {
                solver.delete();
            }
        }
    }
}
