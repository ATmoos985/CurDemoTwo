package changyang.cut.apsmodule.generator.NewSolver.mip;

import com.google.ortools.linearsolver.MPConstraint;
import com.google.ortools.linearsolver.MPObjective;
import com.google.ortools.linearsolver.MPSolver;
import com.google.ortools.linearsolver.MPVariable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverParameters;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverRuntimeProperties;
import changyang.cut.apsmodule.generator.NewSolver.model.PatternCandidate;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * LegacyOrderPatternSelectionSolver 的 Stage 4 花型数/奇偶/对齐精炼 MIP 求解器与预算策略。
 */
final class LegacyPatternStage4Mip {

    private static final Logger log = LoggerFactory.getLogger(LegacyPatternStage4Mip.class);
    private static final long DEFAULT_QUALITY_PRIMARY_STAGE4_NODE_LIMIT = 3000L;
    private static final long DEFAULT_QUALITY_STAGE4_NODE_LIMIT = 10L;
    private static final long DEFAULT_STAGE4_WALL_CAP_MS = 20_000L;
    private static final long DEFAULT_STAGE4_SAFETY_TIME_LIMIT_MS = 120_000L;
    private static final double LEGACY_SEQ_GROUP_ALPHA = 1.0;
    private static final double LEGACY_SEQ_GROUP_BETA = 0.0;

    private LegacyPatternStage4Mip() {
    }

    /**
     * Stage4 奇偶 tie-break 权重。默认 0（关闭）。实验开关：-Dcutting.aLayerParityPenalty=0.02。
     */
    static double parityPenalty() {
        return SolverRuntimeProperties.getDouble("cutting.aLayerParityPenalty", 0.0);
    }

    static long longProperty(String key, long defaultValue) {
        return SolverRuntimeProperties.getLong(key, defaultValue);
    }

    static long stage4NodeLimit() {
        long defaultValue = SolverRuntimeProperties.isQualityMode()
                ? DEFAULT_QUALITY_STAGE4_NODE_LIMIT
                : 0L;
        return longProperty("cutting.aLayerStage4NodeLimit", defaultValue);
    }

    static long stage4WallLimitMs(long remainingTimeMs) {
        return stage4WallLimitMs(remainingTimeMs, stage4NodeLimit());
    }

    static long stage4WallLimitMs(long remainingTimeMs, long effectiveNodeLimit) {
        long configuredCap = effectiveNodeLimit > 0
                ? longProperty("cutting.aLayerStage4SafetyTimeLimitMs",
                        DEFAULT_STAGE4_SAFETY_TIME_LIMIT_MS)
                : longProperty("cutting.aLayerStage4CapMs", DEFAULT_STAGE4_WALL_CAP_MS);
        return Math.min(remainingTimeMs, configuredCap);
    }

    static long effectiveStage4NodeLimit(double parityPenalty, double alignmentLambda) {
        if (parityPenalty > 0.0 || alignmentLambda > 0.0) {
            return stage4NodeLimit();
        }
        long defaultValue = SolverRuntimeProperties.isQualityMode()
                ? DEFAULT_QUALITY_PRIMARY_STAGE4_NODE_LIMIT
                : 0L;
        return longProperty("cutting.aLayerPrimaryStage4NodeLimit", defaultValue);
    }

    static Map<PatternCandidate, Integer> solveMIPStage4(
            SolverParameters params,
            PatternAlignmentScorer alignmentScorer,
            List<PatternCandidate> patterns,
            Map<Integer, Integer> demands,
            Set<Integer> allowOverSet,
            int maxTotalOver,
            int maxTotalRolls,
            int maxTotalWaste,
            long timeLimitMs) {
        return solveMIPStage4(params, alignmentScorer, patterns, demands, allowOverSet,
                maxTotalOver, maxTotalRolls, maxTotalWaste, timeLimitMs, Collections.emptyMap());
    }

    static Map<PatternCandidate, Integer> solveMIPStage4(
            SolverParameters params,
            PatternAlignmentScorer alignmentScorer,
            List<PatternCandidate> patterns,
            Map<Integer, Integer> demands,
            Set<Integer> allowOverSet,
            int maxTotalOver,
            int maxTotalRolls,
            int maxTotalWaste,
            long timeLimitMs,
            Map<PatternCandidate, Integer> warmStart) {
        MPSolver solver = null;
        try {
            solver = LegacyPatternMipSupport.createMIPSolver(params);
            if (solver == null) {
                return null;
            }

            int totalDemand = demands.values().stream().mapToInt(Integer::intValue).sum();
            int bigM = totalDemand + params.getTotalOverCap();

            List<MPVariable> xVars = new ArrayList<>();
            List<MPVariable> yVars = new ArrayList<>();
            List<MPVariable> sVars = new ArrayList<>();
            for (int i = 0; i < patterns.size(); i++) {
                xVars.add(solver.makeIntVar(0, totalDemand + params.getTotalOverCap(), "x_" + i));
                yVars.add(solver.makeBoolVar("y_" + i));
                sVars.add(solver.makeNumVar(0, LegacyPatternMipSupport.MIN_USAGE_THRESHOLD, "s_" + i));
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

            int wasteSlack = Math.max(200, (int) (maxTotalWaste * 0.05));
            MPConstraint wasteCap = solver.makeConstraint(0, maxTotalWaste + wasteSlack, "wasteCap");
            for (int i = 0; i < patterns.size(); i++) {
                wasteCap.setCoefficient(xVars.get(i), patterns.get(i).getRealWaste(params.getTotalWidth()));
            }

            for (int i = 0; i < patterns.size(); i++) {
                MPConstraint link = solver.makeConstraint(-MPSolver.infinity(), 0, "link_" + i);
                link.setCoefficient(xVars.get(i), 1);
                link.setCoefficient(yVars.get(i), -bigM);
            }

            for (int i = 0; i < patterns.size(); i++) {
                MPConstraint minUse = solver.makeConstraint(0, MPSolver.infinity(), "minuse_" + i);
                minUse.setCoefficient(sVars.get(i), 1.0);
                minUse.setCoefficient(xVars.get(i), 1.0);
                minUse.setCoefficient(yVars.get(i), -LegacyPatternMipSupport.MIN_USAGE_THRESHOLD);
            }

            double parityPenalty = parityPenalty();
            List<MPVariable> hVars = new ArrayList<>();
            List<MPVariable> oVars = new ArrayList<>();
            if (parityPenalty > 0.0) {
                for (int i = 0; i < patterns.size(); i++) {
                    MPVariable hVar = solver.makeIntVar(0, totalDemand + params.getTotalOverCap(), "h_" + i);
                    MPVariable oVar = solver.makeBoolVar("o_" + i);
                    MPConstraint parity = solver.makeConstraint(0, 0, "parity_" + i);
                    parity.setCoefficient(xVars.get(i), 1);
                    parity.setCoefficient(hVar, -2);
                    parity.setCoefficient(oVar, -1);
                    hVars.add(hVar);
                    oVars.add(oVar);
                }
            }

            int maxWidthCount = patterns.stream()
                    .mapToInt(PatternCandidate::getWidthCount)
                    .max()
                    .orElse(1);

            MPObjective objective = solver.objective();
            double alignmentLambda = params.getALayerAlignmentLambda();
            double alignmentCostSum = 0.0;
            double alignmentCostMax = 0.0;
            for (int i = 0; i < patterns.size(); i++) {
                double alignmentCost = alignmentLambda > 0.0
                        ? alignmentScorer.cost(patterns.get(i))
                        : 0.0;
                alignmentCostSum += alignmentCost;
                alignmentCostMax = Math.max(alignmentCostMax, alignmentCost);
                objective.setCoefficient(yVars.get(i),
                        LEGACY_SEQ_GROUP_ALPHA + alignmentLambda * alignmentCost);
                double groupCost = (double) patterns.get(i).getWidthCount() / maxWidthCount;
                objective.setCoefficient(xVars.get(i), LEGACY_SEQ_GROUP_BETA * groupCost);
                objective.setCoefficient(sVars.get(i), LegacyPatternMipSupport.SMALL_USAGE_PENALTY);
            }
            for (MPVariable oVar : oVars) {
                objective.setCoefficient(oVar, parityPenalty);
            }
            objective.setMinimization();
            if (alignmentLambda > 0.0 && !patterns.isEmpty()) {
                log.info("Legacy Stage4 alignment: lambda={}, avgCost={}, maxCost={}",
                        alignmentLambda,
                        alignmentCostSum / patterns.size(),
                        alignmentCostMax);
            }

            long nodeLimit = effectiveStage4NodeLimit(parityPenalty, alignmentLambda);
            if (nodeLimit > 0 && solver.solverVersion().toUpperCase().contains("SCIP")) {
                solver.setSolverSpecificParametersAsString(
                        LegacyPatternMipSupport.scipParams(params) + "limits/nodes = " + nodeLimit + "\n");
            }
            long stage4TimeLimit = stage4WallLimitMs(timeLimitMs, nodeLimit);
            applyStage4WarmStart(
                    solver, patterns, demands, warmStart,
                    xVars, yVars, sVars, hVars, oVars, overVars);
            solver.setTimeLimit(stage4TimeLimit);

            long stage4StartedAt = System.currentTimeMillis();
            MPSolver.ResultStatus status = solver.solve();
            long stage4ElapsedMs = System.currentTimeMillis() - stage4StartedAt;
            long stage4Nodes = LegacyPatternMipSupport.safeNodes(solver);
            log.info("Legacy Stage4 solve: status={}, elapsedMs={}, nodes={}/{}, wallLimitMs={}",
                    status, stage4ElapsedMs, stage4Nodes, nodeLimit, stage4TimeLimit);
            if (status != MPSolver.ResultStatus.OPTIMAL && status != MPSolver.ResultStatus.FEASIBLE) {
                log.warn("Legacy-order Stage4 returned {}", status);
                return null;
            }

            Map<PatternCandidate, Integer> solution = LegacyPatternMipSupport.extractSolution(patterns, xVars);
            if (parityPenalty > 0.0) {
                long oddUsageFamilies = solution.values().stream().filter(u -> u % 2 != 0).count();
                log.info("Legacy Stage4 parity: penalty={}, oddUsageFamilies={} (odd 序号组下界), status={}",
                        parityPenalty, oddUsageFamilies, status);
            }
            return solution;
        } catch (Exception e) {
            log.error("Legacy-order Stage4 failed", e);
            return null;
        } finally {
            if (solver != null) {
                solver.delete();
            }
        }
    }

    private static void applyStage4WarmStart(
            MPSolver solver,
            List<PatternCandidate> patterns,
            Map<Integer, Integer> demands,
            Map<PatternCandidate, Integer> warmStart,
            List<MPVariable> xVars,
            List<MPVariable> yVars,
            List<MPVariable> sVars,
            List<MPVariable> hVars,
            List<MPVariable> oVars,
            Map<Integer, MPVariable> overVars) {
        if (warmStart == null || warmStart.isEmpty()) {
            return;
        }
        List<MPVariable> hintVars = new ArrayList<>();
        List<Double> hintValues = new ArrayList<>();
        for (int i = 0; i < patterns.size(); i++) {
            int usage = warmStart.getOrDefault(patterns.get(i), 0);
            hintVars.add(xVars.get(i));
            hintValues.add((double) usage);
            hintVars.add(yVars.get(i));
            hintValues.add(usage > 0 ? 1.0 : 0.0);
            hintVars.add(sVars.get(i));
            hintValues.add(usage > 0
                    ? (double) Math.max(0, LegacyPatternMipSupport.MIN_USAGE_THRESHOLD - usage)
                    : 0.0);
            if (!oVars.isEmpty()) {
                hintVars.add(hVars.get(i));
                hintValues.add((double) (usage / 2));
                hintVars.add(oVars.get(i));
                hintValues.add((double) (usage & 1));
            }
        }
        Map<Integer, Integer> production = LegacyPatternMipSupport.calculateProduction(warmStart);
        for (Map.Entry<Integer, MPVariable> entry : overVars.entrySet()) {
            int over = Math.max(0,
                    production.getOrDefault(entry.getKey(), 0)
                            - demands.getOrDefault(entry.getKey(), 0));
            hintVars.add(entry.getValue());
            hintValues.add((double) over);
        }
        double[] values = hintValues.stream().mapToDouble(Double::doubleValue).toArray();
        solver.setHint(hintVars.toArray(MPVariable[]::new), values);
        log.info("Legacy Stage4 warm start applied: baselinePatterns={}, hintedVars={}",
                warmStart.size(), hintVars.size());
    }
}
