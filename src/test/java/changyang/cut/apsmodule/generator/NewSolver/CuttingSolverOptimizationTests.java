package changyang.cut.apsmodule.generator.NewSolver;

import changyang.cut.apsmodule.generator.NewSolver.config.SolverRuntimeProperties;
import changyang.cut.apsmodule.generator.NewSolver.mip.MultiStageMIPSolver;
import changyang.cut.apsmodule.generator.NewSolver.mip.PatternAlignmentContext;
import changyang.cut.apsmodule.generator.NewSolver.model.PatternCandidate;
import changyang.cut.apsmodule.generator.NewSolver.model.SolverResult;
import changyang.cut.apsmodule.service.CuttingInstruction;
import changyang.cut.apsmodule.service.SolverConfig;
import changyang.cut.apsmodule.service.SolverOrderItem;
import changyang.cut.apsmodule.solver.kernel.execution.DirectSolverTaskExecutor;
import changyang.cut.apsmodule.solver.kernel.execution.SolverTaskExecutor;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class CuttingSolverOptimizationTests {

    @Test
    void pruneDominatedCandidatesFiltersHigherOverAndHigherRollsWhilePreservingOrder() {
        PatternCandidate p1 = new PatternCandidate(Map.of(1000, 4), 4400);
        MultiStageMIPSolver.SolveCandidate c0 = new MultiStageMIPSolver.SolveCandidate(
                "high-over", new SolverResult(Map.of(p1, 10), 10, 4000, 2, 0L), true);
        MultiStageMIPSolver.SolveCandidate c1 = new MultiStageMIPSolver.SolveCandidate(
                "more-rolls", new SolverResult(Map.of(p1, 12), 12, 4800, 0, 0L), true);
        MultiStageMIPSolver.SolveCandidate c2 = new MultiStageMIPSolver.SolveCandidate(
                "opt-first", new SolverResult(Map.of(p1, 10), 10, 4000, 0, 0L), true);
        MultiStageMIPSolver.SolveCandidate c3 = new MultiStageMIPSolver.SolveCandidate(
                "fewer-rolls-but-over", new SolverResult(Map.of(p1, 9), 9, 3600, 1, 0L), true);
        MultiStageMIPSolver.SolveCandidate c4 = new MultiStageMIPSolver.SolveCandidate(
                "opt-second", new SolverResult(Map.of(p1, 10), 10, 4200, 0, 0L), true);

        List<MultiStageMIPSolver.SolveCandidate> kept = CuttingSolver.pruneDominatedCandidates(
                List.of(c0, c1, c2, c3, c4));

        assertEquals(2, kept.size());
        assertEquals("opt-first", kept.get(0).name());
        assertEquals("opt-second", kept.get(1).name());
    }

    @Test
    void controlledLnsOverridesUseStaticTierBudgetForDeterminismAndSkipWhenBudgetExhausted() {
        Map<String, String> exhausted = CuttingSolver.buildControlledLnsOverrides(2_500L, 60_000L);
        assertEquals("false", exhausted.get("cutting.lns.enabled"));

        Map<String, String> fastHost = CuttingSolver.buildControlledLnsOverrides(48_000L, 57_000L);
        Map<String, String> slowerHost = CuttingSolver.buildControlledLnsOverrides(22_000L, 57_000L);
        assertEquals("true", fastHost.get("cutting.lns.enabled"));
        assertEquals("true", slowerHost.get("cutting.lns.enabled"));
        assertEquals("48000", fastHost.get("cutting.lns.budgetMs"));
        assertEquals("22000", slowerHost.get("cutting.lns.budgetMs"));
        assertEquals(fastHost.get("cutting.lns.scipNodeLimit"), slowerHost.get("cutting.lns.scipNodeLimit"));
        assertEquals(fastHost.get("cutting.lns.maxIterations"), slowerHost.get("cutting.lns.maxIterations"));
        assertEquals(fastHost.get("cutting.lns.maxNoImprove"), slowerHost.get("cutting.lns.maxNoImprove"));
    }

    @Test
    void canReuseBaselineStage3RequiresIdenticalDemandKeyOrderAndOptimalBaseline() {
        PatternCandidate p1 = new PatternCandidate(Map.of(860, 2, 990, 2), 4400);
        List<PatternCandidate> patterns = List.of(p1);
        Set<Integer> allowOver = Set.of(860);
        PatternAlignmentContext ctx = PatternAlignmentContext.empty();

        Map<Integer, Integer> orderAsc = new LinkedHashMap<>();
        orderAsc.put(860, 20);
        orderAsc.put(990, 30);

        Map<Integer, Integer> orderDesc = new LinkedHashMap<>();
        orderDesc.put(990, 30);
        orderDesc.put(860, 20);

        CuttingSolver.ALayerTask baselineTask = new CuttingSolver.ALayerTask(
                "fast-baseline-", patterns, orderAsc, allowOver, 1, 0.0, 0.0, ctx, true);
        CuttingSolver.ALayerTask sameOrderTask = new CuttingSolver.ALayerTask(
                "o0-s1-a0-p0p1-", patterns, orderAsc, allowOver, 1, 0.0, 0.1, ctx, false);
        CuttingSolver.ALayerTask diffOrderTask = new CuttingSolver.ALayerTask(
                "o1-s1-a0-p0-", patterns, orderDesc, allowOver, 1, 0.0, 0.0, ctx, false);

        MultiStageMIPSolver.SolveCandidate optimalBaseline = new MultiStageMIPSolver.SolveCandidate(
                "fast-baseline-legacy-order", new SolverResult(Map.of(p1, 10), 10, 0, 0, 0L), true);
        MultiStageMIPSolver.SolveCandidate nonOptimalBaseline = new MultiStageMIPSolver.SolveCandidate(
                "fast-baseline-legacy-order", new SolverResult(Map.of(p1, 10), 10, 0, 0, 0L), false);

        assertTrue(CuttingSolver.canReuseBaselineStage3(sameOrderTask, baselineTask, optimalBaseline),
                "需求键序一致且基线 Stage3 最优时应复用 Stage3");
        assertFalse(CuttingSolver.canReuseBaselineStage3(diffOrderTask, baselineTask, optimalBaseline),
                "需求键序不同（多起始扫描 o1/o2/o3）禁止误判同源复用");
        assertFalse(CuttingSolver.canReuseBaselineStage3(sameOrderTask, baselineTask, nonOptimalBaseline),
                "基线 Stage3 未证明 OPTIMAL 时不应复用");
    }

    @Test
    void createTaskExecutorReturnsDirectWhenRequestedThreadsIsOneToAvoidNestedSlotDeadlock() {
        CuttingSolver solver = new CuttingSolver();
        SolverTaskExecutor executor = SolverRuntimeProperties.withOverrides(
                Map.of(
                        "cutting.parallel.candidates.enabled", "true",
                        "cutting.parallel.candidates.threads", "1"),
                () -> solver.createTaskExecutor(
                        "candidate",
                        "cutting.parallel.candidates.enabled",
                        "cutting.parallel.candidates.threads",
                        3));
        try (executor) {
            assertInstanceOf(DirectSolverTaskExecutor.class, executor,
                    "单线程并发请求应直接返回 DirectSolverTaskExecutor，避免占住唯一 GLOBAL_SLOTS 引发嵌套自锁");
            List<Integer> mapped = executor.mapOrdered(List.of(1, 2, 3), x -> x * 10);
            assertEquals(List.of(10, 20, 30), mapped);
        }
    }

    @Test
    void qualityModePreservesFastBaselineMonotonicityAndDeterminismInProcess() {
        List<SolverOrderItem> items = List.of(
                item("O1", 860, 20),
                item("O2", 970, 24),
                item("O3", 1000, 18),
                item("O4", 1150, 22),
                item("O5", 1270, 16),
                item("O6", 1480, 14)
        );
        SolverConfig config = new SolverConfig(4200, 4400, 10, 4600);
        config.setMode("variable");
        config.setUseNewSolver(true);
        config.setTotalOverCap(0);
        config.setTimeoutMs(25_000L);
        config.setNewSolverStage4TimeLimit(12_000L);

        List<CuttingInstruction> fast = SolverRuntimeProperties.withOverrides(
                Map.of(
                        "cutting.fast.preview", "true",
                        "cutting.quality", "false",
                        "cutting.fast.budgetMs", "20000"),
                () -> new CuttingSolver().solve(items, config));

        Map<String, String> qualityProps = Map.of(
                "cutting.fast.preview", "false",
                "cutting.quality", "true",
                "cutting.fast.budgetMs", "20000",
                "cutting.quality.budgetMs", "55000",
                "cutting.aLayerParityPenalties", "0,0.1",
                "cutting.lns.enabled", "true",
                "cutting.parallel.aLayer.enabled", "true",
                "cutting.parallel.candidates.enabled", "true",
                "cutting.parallel.aLayer.threads", "2",
                "cutting.parallel.candidates.threads", "2");

        List<CuttingInstruction> quality1 = SolverRuntimeProperties.withOverrides(
                qualityProps, () -> new CuttingSolver().solve(items, config));
        List<CuttingInstruction> quality2 = SolverRuntimeProperties.withOverrides(
                qualityProps, () -> new CuttingSolver().solve(items, config));

        int fastRolls = fast.stream().mapToInt(CuttingInstruction::getUsageCount).sum();
        int qualityRolls = quality1.stream().mapToInt(CuttingInstruction::getUsageCount).sum();
        assertTrue(fastRolls > 0);
        assertTrue(qualityRolls <= fastRolls,
                "QUALITY 车数不应劣于 FAST: quality=" + qualityRolls + ", fast=" + fastRolls);
        assertEquals(qualityRolls, quality2.stream().mapToInt(CuttingInstruction::getUsageCount).sum());
        assertEquals(quality1.size(), quality2.size());
    }

    private static SolverOrderItem item(String id, int width, int demand) {
        SolverOrderItem item = new SolverOrderItem();
        item.setMessageText(id);
        item.setWidth(width);
        item.setDemand(demand);
        item.setLength(1350);
        item.setSurfaceTreatment("不电晕/不涂布");
        item.setGroupKey("1350m+不电晕/不涂布");
        return item;
    }
}
