package com.example.cutdemotwo.algorithm.slitting;

import changyang.cut.apsmodule.generator.NewSolver.colgen.ColumnGenerationSolver;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverParameters;
import changyang.cut.apsmodule.generator.NewSolver.model.PatternCandidate;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

import static org.junit.jupiter.api.Assertions.*;

class ColumnGenerationIncrementalTests {

    @Test
    void incrementalMasterLpAddsNewColumnsAndConverges() {
        com.google.ortools.Loader.loadNativeLibraries();
        SolverParameters params = SolverParameters.createDefault();
        params.setTotalWidth(4600);
        params.setMinRollWidth(4200);
        params.setMaxRollWidth(4400);
        params.setStepSize(10);
        params.setTotalOverCap(10);
        params.setMaxDistinctWidths(4);
        params.setMaxIterations(50);
        params.setMaxPatterns(200);

        Map<Integer, Integer> demands = new TreeMap<>();
        demands.put(860, 20);
        demands.put(990, 18);
        demands.put(1150, 16);
        demands.put(1270, 12);

        // 仅提供极少的初始单宽模式，迫使列生成通过增量加列热启动生成多宽混合新列。
        List<PatternCandidate> seedPatterns = List.of(
                new PatternCandidate(Map.of(860, 5), 4300),
                new PatternCandidate(Map.of(1150, 3), 4200)
        );

        ColumnGenerationSolver solver = new ColumnGenerationSolver(params);
        List<PatternCandidate> result = solver.solve(seedPatterns, demands, Set.of(860, 990));

        assertTrue(result.size() > seedPatterns.size(), "增量列生成应追加负检验数的新列");
        // 验证每个需求宽度均被至少一个候选模式覆盖
        for (int width : demands.keySet()) {
            assertTrue(result.stream().anyMatch(p -> p.getPattern().getOrDefault(width, 0) > 0),
                    "宽度 " + width + " 应被列生成后的模式池覆盖");
        }
        // 验证所有新生成模式均满足宽度区间约束
        for (PatternCandidate pc : result) {
            assertTrue(pc.getPatternWidth() <= pc.getRollWidth());
            assertTrue(pc.getRollWidth() >= 4200 && pc.getRollWidth() <= 4400);
        }
    }

    @Test
    @org.junit.jupiter.api.Timeout(10)
    void singlePassGcdCompressedDpHandlesLargeRollWidthsWithoutOomAndRespectsDeadline() {
        com.google.ortools.Loader.loadNativeLibraries();
        assertEquals(100, ColumnGenerationSolver.computeWidthScale(List.of(500, 600, 1200)));
        assertEquals(10, ColumnGenerationSolver.computeWidthScale(List.of(860, 990, 1150, 1270)));
        assertEquals(3, ColumnGenerationSolver.computeWidthScale(List.of(501, 600)));
        assertEquals(1, ColumnGenerationSolver.computeWidthScale(List.of(503, 600)));
        assertEquals(1015, ColumnGenerationSolver.alignRollWidth(1012, 1005, 1185, 10));
        assertEquals(4210, ColumnGenerationSolver.alignRollWidth(4205, 4200, 4400, 10));

        // 1. 合法大宽幅输入（maxRollWidth=100000, step=10, 50种宽幅互质+非互质混合），在有界内存与时限内稳定完成不 OOM
        SolverParameters largeParams = SolverParameters.createDefault();
        largeParams.setTotalWidth(100_000);
        largeParams.setMinRollWidth(90_000);
        largeParams.setMaxRollWidth(100_000);
        largeParams.setStepSize(10);
        largeParams.setTotalOverCap(20);
        largeParams.setMaxDistinctWidths(6);
        largeParams.setMaxIterations(30);
        largeParams.setMaxPatterns(200);
        largeParams.setTimeoutMs(3_000L);

        Map<Integer, Integer> demands = new TreeMap<>();
        for (int i = 0; i < 40; i++) {
            demands.put(2001 + i * 137, 10);
        }
        List<PatternCandidate> seeds = List.of(new PatternCandidate(Map.of(2001, 45), 90_050));

        long start = System.nanoTime();
        List<PatternCandidate> result = new ColumnGenerationSolver(largeParams).solve(seeds, demands, Set.of());
        long elapsedMs = java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);

        assertFalse(result.isEmpty());
        assertTrue(elapsedMs < 8_000L, "大宽幅列生成应受 deadline 与单次 DP 保护，实际耗时=" + elapsedMs + "ms");
        for (PatternCandidate pc : result) {
            assertTrue(pc.getPatternWidth() >= 90_000 && pc.getPatternWidth() <= pc.getRollWidth(),
                    "生成模式宽幅非法: " + pc);
            assertTrue(pc.getRollWidth() >= 90_000 && pc.getRollWidth() <= 100_000,
                    "生成卷宽越界: " + pc);
            assertEquals(0, (pc.getRollWidth() - 90_000) % 10, "生成卷宽必须对齐步长: " + pc);
        }
    }
}
