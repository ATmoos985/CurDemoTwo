package com.example.cutdemotwo.algorithm.slitting;

import com.example.cutdemotwo.contracts.slitting.SlittingProblem;
import com.example.cutdemotwo.contracts.slitting.SlittingResult;
import com.example.cutdemotwo.contracts.slitting.SlittingValidation;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 一维分切物理机台硬约束、多宽母卷联合选料与换刀次数 TSP 排序专项测试。
 */
class SlittingPhysicalConstraintsAndKnifeOptimizerTests {

    private final LinearSlittingSolverEngine engine = new LinearSlittingSolverEngine();
    private final JsonMapper json = JsonMapper.builder().build();

    @AfterEach
    void tearDown() {
        engine.close();
    }

    private static SlittingResult.Pattern pattern(String id, int rollWidth, List<SlittingResult.Station> stations) {
        int pieceWidth = stations.stream().mapToInt(s -> s.widthMm() * s.countPerRepetition()).sum();
        return new SlittingResult.Pattern(
                id, rollWidth, pieceWidth, 3000L, "素色", 1,
                stations, List.of(new SlittingResult.Allocation("O1", 1))
        );
    }

    @Test
    void knifeOptimizerReducesKnifeChangesWithNearestNeighborAndTwoOpt() {
        // 交错排列两类刀位家族，测试最近邻 + 2-Opt 换刀最小化效果与确定性
        var p1 = pattern("P1", 1000, List.of(new SlittingResult.Station(200, 1), new SlittingResult.Station(300, 1), new SlittingResult.Station(500, 1)));
        var p2 = pattern("P2", 1000, List.of(new SlittingResult.Station(350, 2), new SlittingResult.Station(300, 1)));
        var p3 = pattern("P3", 1000, List.of(new SlittingResult.Station(200, 1), new SlittingResult.Station(300, 1), new SlittingResult.Station(250, 2)));
        var p4 = pattern("P4", 1000, List.of(new SlittingResult.Station(350, 2), new SlittingResult.Station(150, 2)));
        var p5 = pattern("P5", 1000, List.of(new SlittingResult.Station(200, 1), new SlittingResult.Station(300, 1), new SlittingResult.Station(500, 1)));
        var p6 = pattern("P6", 1000, List.of(new SlittingResult.Station(350, 2), new SlittingResult.Station(300, 1)));

        List<SlittingResult.Pattern> interleaved = List.of(p1, p2, p3, p4, p5, p6);
        var outcome1 = KnifeSetupSequenceOptimizer.optimize(interleaved, 10, 0);
        var outcome2 = KnifeSetupSequenceOptimizer.optimize(interleaved, 10, 0);

        assertEquals(6, outcome1.orderedPatterns().size());
        assertEquals(outcome1, outcome2, "换刀优化必须 100% 确定性可复现");
        assertTrue(outcome1.knifeChangesSaved() > 0,
                "交错序列经最近邻+2-Opt优化后必须显著减少换刀次数，original=" + outcome1.originalKnifeChanges()
                        + ", estimated=" + outcome1.estimatedKnifeChanges());
        assertEquals(outcome1.originalKnifeChanges() - outcome1.estimatedKnifeChanges(), outcome1.knifeChangesSaved());
        assertTrue(outcome1.estimatedKnifeChanges() < outcome1.originalKnifeChanges());
        // 确认不丢车、不重复
        assertEquals(Set.of("P1", "P2", "P3", "P4", "P5", "P6"),
                outcome1.orderedPatterns().stream().map(SlittingResult.Pattern::id).collect(java.util.stream.Collectors.toSet()));
    }

    @Test
    void maxKnivesConstraintIsEnforcedInValidationAndSolver() {
        // 母卷 1200mm 无切边，订单宽 200mm x 10 卷：无刀数上限可切 6 条/车，限制 maxKnives=3 后每车最多切 3 条
        var problem = new SlittingProblem(
                "1", "mm", 1200, 0, 0, 1200, 1200, 1, 5, "FAST",
                List.of(new SlittingProblem.Order("O1", 200, 3000L, 10, "素色")), 15,
                null, null, null, null, null, null, null, null, null, null,
                3, null, null, null, null, null
        );

        SlittingResult result = engine.solve(problem);
        assertEquals("FEASIBLE", result.status());
        assertNotNull(result.estimatedKnifeChanges());
        assertNotNull(result.knifeChangesSaved());
        assertTrue(result.fulfillment().stream().allMatch(f -> f.missing() == 0));
        for (var pat : result.patterns()) {
            int strips = pat.stations().stream().mapToInt(SlittingResult.Station::countPerRepetition).sum();
            assertTrue(strips <= 3, "每车切条总数必须 <= maxKnives(3)，实际=" + strips);
        }

        // 独立验真应拦截违反 maxKnives 的伪造结果（切 5 条 > 3）
        var badPattern = new SlittingResult.Pattern(
                "BAD-1", 1200, 1000, 3000L, "素色", 2,
                List.of(new SlittingResult.Station(200, 5)),
                List.of(new SlittingResult.Allocation("O1", 10))
        );
        var badResult = new SlittingResult(
                "1", "mm", "ortools-1d", "test", "FEASIBLE", false,
                List.of(badPattern), List.of(new SlittingResult.Fulfillment("O1", 10, 10, 0, 0)),
                1000L * 3000 * 2, 1200L * 3000 * 2, 1200L * 3000 * 2, 0
        );
        assertThrows(SlittingValidation.ValidationException.class,
                () -> SlittingValidation.validateResult(problem, badResult));
    }

    @Test
    void minBladeSpacingRejectsNarrowOrdersAndNarrowStations() {
        var narrowOrderProblem = new SlittingProblem(
                "1", "mm", 1200, 0, 0, 1200, 1200, 1, 0, "FAST",
                List.of(new SlittingProblem.Order("O1", 80, 3000L, 2, "素色")), 10,
                null, null, null, null, null, null, null, null, null, null,
                null, 100, null, null, null, null
        );
        var ex = assertThrows(SlittingValidation.ValidationException.class,
                () -> SlittingValidation.validateProblem(narrowOrderProblem));
        assertEquals("INVALID_INPUT", ex.getCode());

        var validProblem = new SlittingProblem(
                "1", "mm", 1200, 0, 0, 1200, 1200, 1, 0, "FAST",
                List.of(new SlittingProblem.Order("O1", 300, 3000L, 4, "素色")), 10,
                null, null, null, null, null, null, null, null, null, null,
                null, 100, null, null, null, null
        );
        var res = engine.solve(validProblem);
        assertEquals("FEASIBLE", res.status());
        assertEquals(4, res.fulfillment().get(0).produced());
    }

    @Test
    void forbiddenNarrowEdgeAvoidsDangerZoneAllowsZeroAndReturnsNoSolutionWhenImpossible() {
        // 1. 可避开危险细边：母卷 1000mm，订单 330mm x 6 卷，禁区 [1, 20]。
        // 切 3 条占 990mm -> 尾边 10mm 落入禁区被禁止；切 2 条占 660mm -> 尾边 340mm 合法！
        var avoidable = new SlittingProblem(
                "1", "mm", 1000, 0, 0, 1000, 1000, 1, 0, "FAST",
                List.of(new SlittingProblem.Order("O1", 330, 3000L, 6, "素色")), 15,
                null, null, null, null, null, null, null, null, null, null,
                null, null, 1, 20, 0, null
        );
        var avoidableRes = engine.solve(avoidable);
        assertEquals("FEASIBLE", avoidableRes.status());
        assertEquals(6, avoidableRes.fulfillment().get(0).produced());
        for (var pat : avoidableRes.patterns()) {
            int tail = pat.rollWidthMm() - pat.patternWidthMm();
            assertFalse(tail > 0 && tail >= 1 && tail <= 20, "剩余尾边严禁落入细边禁区，实际=" + tail);
        }

        // 2. 0 尾边视为无边丝合法：母卷 1000mm，订单 500mm x 4 卷，禁区 [1, 50] -> 2x500=1000 尾边 0 合法！
        var zeroEdge = new SlittingProblem(
                "1", "mm", 1000, 0, 0, 1000, 1000, 1, 0, "FAST",
                List.of(new SlittingProblem.Order("O1", 500, 3000L, 4, "素色")), 15,
                null, null, null, null, null, null, null, null, null, null,
                null, null, 1, 50, 0, null
        );
        var zeroEdgeRes = engine.solve(zeroEdge);
        assertEquals("FEASIBLE", zeroEdgeRes.status());
        assertEquals(4, zeroEdgeRes.fulfillment().get(0).produced());
        assertEquals(zeroEdgeRes.motherAreaMm2(), zeroEdgeRes.pieceAreaMm2());

        // 3. 物理无解时严禁吐出违规花型：母卷 1000mm，仅订单 990mm，禁区 [5, 20] -> 切 1 条尾边 10mm 违规
        var impossible = new SlittingProblem(
                "1", "mm", 1000, 0, 0, 1000, 1000, 1, 0, "FAST",
                List.of(new SlittingProblem.Order("O1", 990, 3000L, 1, "素色")), 15,
                null, null, null, null, null, null, null, null, null, null,
                null, null, 5, 20, 0, null
        );
        var impossibleRes = engine.solve(impossible);
        assertEquals("NO_SOLUTION_FOUND", impossibleRes.status());
        assertTrue(impossibleRes.patterns().isEmpty());

        // 4. 独立验真拦截落入细边禁区的伪造结果
        var badPat = new SlittingResult.Pattern(
                "BAD", 1000, 990, 3000L, "素色", 1,
                List.of(new SlittingResult.Station(990, 1)),
                List.of(new SlittingResult.Allocation("O1", 1))
        );
        var badRes = new SlittingResult(
                "1", "mm", "ortools-1d", "test", "FEASIBLE", false,
                List.of(badPat), List.of(new SlittingResult.Fulfillment("O1", 1, 1, 0, 0)),
                990L * 3000, 1000L * 3000, 1000L * 3000, 0
        );
        assertThrows(SlittingValidation.ValidationException.class,
                () -> SlittingValidation.validateResult(impossible, badRes));
    }

    @Test
    void kerfLossIsDeductedFromAvailableWidthAndVerified() {
        // 母卷 1000mm，订单 500mm x 4 卷，切缝 kerf=5mm：2 条需 500+500+5=1005 > 1000 不可行，只能 1 条/车
        var kerfProblem = new SlittingProblem(
                "1", "mm", 1000, 0, 0, 1000, 1000, 1, 0, "FAST",
                List.of(new SlittingProblem.Order("O1", 500, 3000L, 4, "素色")), 15,
                null, null, null, null, null, null, null, null, null, null,
                null, null, null, null, 5, null
        );
        var res = engine.solve(kerfProblem);
        assertEquals("FEASIBLE", res.status());
        assertEquals(4, res.fulfillment().get(0).produced());
        for (var pat : res.patterns()) {
            int strips = pat.stations().stream().mapToInt(SlittingResult.Station::countPerRepetition).sum();
            assertEquals(1, strips, "计入 5mm 切缝损耗后 1000mm 母卷每车最多切 1 条 500mm 成品");
        }

        // 伪造忽略切缝的 2 条方案必须被独立验真拒收
        var ignoringKerf = new SlittingResult.Pattern(
                "BAD", 1000, 1000, 3000L, "素色", 2,
                List.of(new SlittingResult.Station(500, 2)),
                List.of(new SlittingResult.Allocation("O1", 4))
        );
        var badRes = new SlittingResult(
                "1", "mm", "ortools-1d", "test", "FEASIBLE", false,
                List.of(ignoringKerf), List.of(new SlittingResult.Fulfillment("O1", 4, 4, 0, 0)),
                1000L * 3000 * 2, 1000L * 3000 * 2, 1000L * 3000 * 2, 0
        );
        assertThrows(SlittingValidation.ValidationException.class,
                () -> SlittingValidation.validateResult(kerfProblem, badRes));
    }

    @Test
    void candidateRollWidthsPoolOptimizesMotherWidthSelectionAndEnforcesAvailableRolls() {
        // 1. 多宽母卷联合选料：候选池 [1000, 1200, 1500]，O1=500x4 选 1000mm（2条零废料），O2=750x2 选 1500mm（2条零废料）
        var multiPool = new SlittingProblem(
                "1", "mm", 1200, 0, 0, 1200, 1200, 1, 0, "QUALITY",
                List.of(
                        new SlittingProblem.Order("O1", 500, 3000L, 4, "素色"),
                        new SlittingProblem.Order("O2", 750, 3000L, 2, "素色")
                ), 15,
                null, null, null, null, null, null, null, null, null, null,
                null, null, null, null, 0,
                List.of(
                        new SlittingProblem.CandidateRollWidth(1000, null),
                        new SlittingProblem.CandidateRollWidth(1200, null),
                        new SlittingProblem.CandidateRollWidth(1500, null)
                )
        );
        var res = engine.solve(multiPool);
        assertEquals("FEASIBLE", res.status());
        assertTrue(res.fulfillment().stream().allMatch(f -> f.missing() == 0 && f.overproduced() == 0));
        assertEquals(res.motherAreaMm2(), res.pieceAreaMm2(), "多宽池联合选料应选出零浪费的 1000mm + 1500mm 组合");

        // 2. 候选母卷库存上限：1000mm 仅剩 1 卷，1500mm 有 5 卷；需求 500mm x 5 卷 -> 1000mm 用 1 卷(2条) + 1500mm 用 1 卷(3条)
        var cappedPool = new SlittingProblem(
                "1", "mm", 1000, 0, 0, 1000, 1000, 1, 0, "FAST",
                List.of(new SlittingProblem.Order("O1", 500, 3000L, 5, "素色")), 15,
                null, null, null, null, null, null, null, null, null, null,
                null, null, null, null, 0,
                List.of(
                        new SlittingProblem.CandidateRollWidth(1000, 1),
                        new SlittingProblem.CandidateRollWidth(1500, 5)
                )
        );
        var cappedRes = engine.solve(cappedPool);
        assertEquals("FEASIBLE", cappedRes.status());
        assertEquals(5, cappedRes.fulfillment().get(0).produced());
        int used1000 = cappedRes.patterns().stream()
                .filter(pat -> pat.rollWidthMm() == 1000)
                .mapToInt(SlittingResult.Pattern::repetitions)
                .sum();
        int used1500 = cappedRes.patterns().stream()
                .filter(pat -> pat.rollWidthMm() == 1500)
                .mapToInt(SlittingResult.Pattern::repetitions)
                .sum();
        assertTrue(used1000 <= 1, "1000mm 母卷用量不得超过 availableRolls=1，实际=" + used1000);
        assertTrue(used1500 >= 1, "剩余需求应由 1500mm 母卷补足");
        assertEquals(cappedRes.motherAreaMm2(), cappedRes.pieceAreaMm2(), "1*1000 + 1*1500 = 2500mm 刚好零浪费切出 5 条 500mm");

        // 独立验真拦截超出 availableRolls 的伪造结果（1000mm 用了 3 卷 > 1）
        var overCapPat = new SlittingResult.Pattern(
                "OVER", 1000, 1000, 3000L, "素色", 3,
                List.of(new SlittingResult.Station(500, 2)),
                List.of(new SlittingResult.Allocation("O1", 6)),
                1000
        );
        var overCapRes = new SlittingResult(
                "1", "mm", "ortools-1d", "test", "FEASIBLE", false,
                List.of(overCapPat), List.of(new SlittingResult.Fulfillment("O1", 5, 6, 0, 1)),
                1000L * 3000 * 3, 1000L * 3000 * 3, 1000L * 3000 * 3, 1
        );
        assertThrows(SlittingValidation.ValidationException.class,
                () -> SlittingValidation.validateResult(cappedPool, overCapRes));
    }

    @Test
    void legacySerializationRemainsByteCompatibleAndNewFieldsRoundTripCleanly() {
        var legacy = new SlittingProblem("1", "mm", 1200, 10, 10, 1000, 1180, 10, 20, "FAST",
                List.of(new SlittingProblem.Order("O1", 500, 3000L, 2, "素色")), 5);
        String legacyJson = json.writeValueAsString(legacy);
        assertFalse(legacyJson.contains("maxKnives"));
        assertFalse(legacyJson.contains("minBladeSpacingMm"));
        assertFalse(legacyJson.contains("forbiddenNarrowEdgeMinMm"));
        assertFalse(legacyJson.contains("kerfMm"));
        assertFalse(legacyJson.contains("candidateRollWidths"));
        assertEquals(legacy, json.readValue(legacyJson, SlittingProblem.class));

        var extended = new SlittingProblem(
                "1", "mm", 1200, 10, 10, 1000, 1180, 10, 20, "QUALITY",
                legacy.orders(), 10,
                null, null, null, null, null, null, null, null, null, null,
                6, 150, 5, 25, 2,
                List.of(new SlittingProblem.CandidateRollWidth(1200, 4), new SlittingProblem.CandidateRollWidth(1500, null))
        );
        String extendedJson = json.writeValueAsString(extended);
        var decoded = json.readValue(extendedJson, SlittingProblem.class);
        assertEquals(extended, decoded);
        assertEquals(20, extended.withTimeLimitSeconds(20).timeLimitSeconds());
        assertEquals(6, extended.withTimeLimitSeconds(20).maxKnives());
        assertEquals(2, extended.withTimeLimitSeconds(20).candidateRollWidths().size());
    }

    @Test
    void combinedPhysicalConstraintsAndMultiWidthPoolSolveTogetherAndVerifyCleanly() {
        // 同时启用全部 5 项扩展约束：多宽池 + 切缝 4mm + 单车最多 3 刀 + 最小刀距 200mm + 细边禁区 [1, 25]
        var combined = new SlittingProblem(
                "1", "mm", 1200, 10, 10, 1180, 1180, 1, 2, "QUALITY",
                List.of(
                        new SlittingProblem.Order("A", 350, 4000L, 6, "涂层"),
                        new SlittingProblem.Order("B", 480, 4000L, 4, "涂层")
                ), 20,
                null, null, null, null, null, null, null, null, null, null,
                3, 200, 1, 25, 4,
                List.of(
                        new SlittingProblem.CandidateRollWidth(1000, 4),
                        new SlittingProblem.CandidateRollWidth(1200, 6)
                )
        );
        var res = engine.solve(combined);
        assertEquals("FEASIBLE", res.status());
        assertTrue(res.fulfillment().stream().allMatch(f -> f.missing() == 0));
        assertNotNull(res.estimatedKnifeChanges());
        assertNotNull(res.knifeChangesSaved());
        for (var pat : res.patterns()) {
            int strips = pat.stations().stream().mapToInt(SlittingResult.Station::countPerRepetition).sum();
            assertTrue(strips <= 3);
            int occ = pat.patternWidthMm() + Math.max(0, strips - 1) * 4;
            int tail = pat.rollWidthMm() - occ;
            assertTrue(occ <= pat.rollWidthMm());
            assertFalse(tail > 0 && tail <= 25);
        }
    }
}
