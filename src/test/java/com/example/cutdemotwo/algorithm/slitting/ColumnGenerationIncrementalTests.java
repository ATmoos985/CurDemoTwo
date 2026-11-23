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
}
