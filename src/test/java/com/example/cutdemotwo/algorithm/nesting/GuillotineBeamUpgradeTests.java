package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.toolpath.ToolpathOptimizerService;
import com.example.cutdemotwo.business.cutting.FabricSolveAdapter;
import com.example.cutdemotwo.business.model.PieceDemand;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.business.model.SolveResponse;
import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Exclusion;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.FabricRule;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Material;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Part;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.PartRule;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Process;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Locale;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 自主二维直刀矩形引擎（JavaGuillotineSolverEngine）升级前后基准与质量验证测试。
 */
class GuillotineBeamUpgradeTests {

    private static SolverFactory factory() {
        return new SolverFactory(List.of(new JavaGuillotineSolverEngine(), new CrossCutSolverService()), true);
    }

    private static Process guillotineProcess(String feedType, String origin, String firstStage, double trimStart) {
        return new Process("GUILLOTINE", feedType, origin, firstStage, trimStart, 150, 150, 0, "MAXIMIZE_PIECE_AREA", 0.0);
    }

    private record BenchmarkCase(String name, NestingProblem problem, int totalDemand) {}

    private static List<BenchmarkCase> benchmarkCases() {
        // 1. 常规混排（2800 x 3600，多规格允许旋转）
        NestingProblem mixed = new NestingProblem(
                "1", "mm",
                new Material("bench-mixed", Shape.rectangle(2800, 3600), List.of(), false),
                List.of(
                        new Part(1, "大帘A", Shape.rectangle(1100, 950), 3, true),
                        new Part(2, "中帘B", Shape.rectangle(850, 720), 4, true),
                        new Part(3, "中帘C", Shape.rectangle(680, 560), 5, true),
                        new Part(4, "小片D", Shape.rectangle(460, 380), 6, true),
                        new Part(5, "窄条E", Shape.rectangle(320, 920), 4, true)
                ),
                guillotineProcess("CONTINUOUS", "left-top", "horizontal", 0),
                "javaguillotine",
                2
        );

        // 2. 大件 + 小件套裁（幅宽 2000 x 2600，经典首刀易锁死算例）
        NestingProblem bigSmall = new NestingProblem(
                "1", "mm",
                new Material("bench-big-small", Shape.rectangle(2000, 2600), List.of(), false),
                List.of(
                        new Part(1, "特大主片", Shape.rectangle(1250, 900), 2, true),
                        new Part(2, "次大副片", Shape.rectangle(750, 880), 2, true),
                        new Part(3, "长条片", Shape.rectangle(1150, 420), 2, true),
                        new Part(4, "方片", Shape.rectangle(580, 580), 3, true),
                        new Part(5, "补空小片", Shape.rectangle(420, 310), 6, true)
                ),
                guillotineProcess("SHEET", "left-top", "horizontal", 0),
                "javaguillotine",
                2
        );

        // 3. 紧约束互补套裁（1600 x 2200，测试长边/高/宽启发与切分策略互补）
        NestingProblem tightNest = new NestingProblem(
                "1", "mm",
                new Material("bench-tight", Shape.rectangle(1600, 2200), List.of(), false),
                List.of(
                        new Part(1, "规格1", Shape.rectangle(920, 640), 2, true),
                        new Part(2, "规格2", Shape.rectangle(680, 640), 2, true),
                        new Part(3, "规格3", Shape.rectangle(820, 510), 3, true),
                        new Part(4, "规格4", Shape.rectangle(540, 480), 3, true),
                        new Part(5, "规格5", Shape.rectangle(390, 360), 4, true),
                        new Part(6, "规格6", Shape.rectangle(260, 510), 3, true)
                ),
                guillotineProcess("SHEET", "left-top", "horizontal", 0),
                "javaguillotine",
                2
        );

        // 4. 带疵点矩形（2200 x 3000，含 3 处带安全裕量疵点）
        NestingProblem withDefects = new NestingProblem(
                "1", "mm",
                new Material("bench-defects", Shape.rectangle(2200, 3000), List.of(
                        new Exclusion(1, 450, 350, Shape.rectangle(140, 120), 20),
                        new Exclusion(2, 1380, 1050, Shape.rectangle(180, 140), 20),
                        new Exclusion(3, 820, 1980, Shape.rectangle(160, 150), 15)
                ), false),
                List.of(
                        new Part(1, "主片A", Shape.rectangle(820, 680), 3, true),
                        new Part(2, "中片B", Shape.rectangle(640, 520), 4, true),
                        new Part(3, "长条C", Shape.rectangle(960, 340), 3, true),
                        new Part(4, "小片D", Shape.rectangle(420, 360), 6, true)
                ),
                guillotineProcess("CONTINUOUS", "left-top", "horizontal", 30),
                "javaguillotine",
                2
        );

        // 5. 窗帘多规格矩形（含左右布边、对花循环、主/辅片与轻微疵点）
        FabricRule curtainRule = new FabricRule(30.0, 30.0, true, 400.0, 40.0);
        NestingProblem curtain = new NestingProblem(
                "1", "mm",
                new Material("bench-curtain", Shape.rectangle(2800, 3200), List.of(
                        new Exclusion(1, 200, 620, Shape.rectangle(180, 120), 10, 1, "ALLOW_AUXILIARY"),
                        new Exclusion(2, 1850, 1420, Shape.rectangle(150, 140), 15, 3, "MUST_AVOID")
                ), false, curtainRule),
                List.of(
                        new Part(1, "提花主帘", Shape.rectangle(1200, 740), 3, false, null, new PartRule("MAIN", true, 0.0, 1.0)),
                        new Part(2, "素色主帘", Shape.rectangle(950, 680), 3, false, null, new PartRule("MAIN", false, null, null)),
                        new Part(3, "绑带辅片", Shape.rectangle(480, 260), 6, true, null, new PartRule("AUXILIARY", false, null, null)),
                        new Part(4, "包边辅条", Shape.rectangle(760, 220), 4, true, null, new PartRule("AUXILIARY", false, null, null))
                ),
                guillotineProcess("CONTINUOUS", "left-top", "horizontal", 0),
                "javaguillotine",
                2
        );

        return List.of(
                new BenchmarkCase("常规混排", mixed, totalQty(mixed)),
                new BenchmarkCase("大件小件套裁", bigSmall, totalQty(bigSmall)),
                new BenchmarkCase("紧约束互补套裁", tightNest, totalQty(tightNest)),
                new BenchmarkCase("带疵点矩形", withDefects, totalQty(withDefects)),
                new BenchmarkCase("窗帘多规格约束", curtain, totalQty(curtain))
        );
    }

    private static int totalQty(NestingProblem problem) {
        return problem.parts().stream().mapToInt(Part::quantity).sum();
    }

    @Test
    void benchmarkSuiteProducesValidHighQualityLayouts() {
        SolverFactory factory = factory();
        ToolpathOptimizerService optimizer = new ToolpathOptimizerService();
        System.out.println("=== GUILLOTINE_BENCHMARK_START ===");
        System.out.println("CASE | PLACED/TOTAL | UTIL_BOARD% | UTIL_USED% | USED_LEN_MM | CUTS | ELAPSED_MS");

        double totalUtilBoard = 0.0;
        int totalPlaced = 0;

        for (BenchmarkCase bc : benchmarkCases()) {
            long t0 = System.nanoTime();
            NestingResult res = factory.solve(bc.problem());
            long elapsedMs = (System.nanoTime() - t0) / 1_000_000L;

            assertTrue(res.feasible(), bc.name() + " 必须求解成功且通过独立校验：" + res.message());
            assertFalse(res.placements().isEmpty(), bc.name() + " 至少应排入 1 件");

            double boardArea = bc.problem().width() * bc.problem().height();
            double pieceArea = res.metrics().pieceAreaMm2();
            double usedLen = res.metrics().suggestedFeedLengthMm();
            double usedArea = bc.problem().width() * Math.max(1.0, usedLen);
            double utilBoardPct = (pieceArea / boardArea) * 100.0;
            double utilUsedPct = (pieceArea / usedArea) * 100.0;

            totalUtilBoard += utilBoardPct;
            totalPlaced += res.placements().size();

            // 校验直刀刀路满足严格父子阶段前置约束
            List<CutStep> cutSteps = res.cuts().stream().map(c -> {
                boolean horiz = "HORIZONTAL".equalsIgnoreCase(c.kind()) || "横切".equals(c.kind());
                String type = horiz ? "横切" : "纵切";
                double pos = horiz ? c.startY() : c.startX();
                double start = horiz ? Math.min(c.startX(), c.endX()) : Math.min(c.startY(), c.endY());
                double end = horiz ? Math.max(c.startX(), c.endX()) : Math.max(c.startY(), c.endY());
                CutStep step = new CutStep(c.sequence(), type, pos, start, end, c.description());
                step.setStage(c.stage());
                step.setStartX(c.startX());
                step.setStartY(c.startY());
                step.setEndX(c.endX());
                step.setEndY(c.endY());
                return step;
            }).toList();
            assertDoesNotThrow(() -> optimizer.validateReorderedCuts(
                    cutSteps, cutSteps, bc.problem().width(), bc.problem().height(), true),
                    bc.name() + " 直刀切序必须满足严格阶段先后约束");
            assertNoCutPenetratesAnyPiece(bc.name(), res);
            assertFirstStageOrientationMatches(bc.name(), bc.problem(), res);

            System.out.printf(Locale.ROOT, "%s | %d/%d | %.2f%% | %.2f%% | %.1f | %d | %d%n",
                    bc.name(), res.placements().size(), bc.totalDemand(),
                    utilBoardPct, utilUsedPct, usedLen, res.cuts().size(), elapsedMs);
        }

        // 6. 带 pieceGap > 0 基准算例
        SolveRequest gapReq = new SolveRequest();
        gapReq.setRollW(2000);
        gapReq.setRollL(2600);
        gapReq.setTotalRollL(10000);
        gapReq.setCutOrigin("left-top");
        gapReq.setFirstStageOrientation("horizontal");
        gapReq.setSolver("javaguillotine");
        gapReq.setPieceGap(8.0);
        gapReq.setTimeLimitSeconds(2);
        gapReq.setDemands(List.of(
                new PieceDemand(1, "大件G1", 950, 780, 3, true),
                new PieceDemand(2, "中件G2", 620, 540, 4, true),
                new PieceDemand(3, "小件G3", 450, 380, 5, true)
        ));
        long gt0 = System.nanoTime();
        SolveResponse gapRes = FabricSolveAdapter.solve(factory, gapReq);
        long gapMs = (System.nanoTime() - gt0) / 1_000_000L;
        assertTrue(gapRes.isSuccess(), "带间距排样必须成功：" + gapRes.getMessage());
        assertFalse(gapRes.getPieces().isEmpty());
        // 核验所有裁片间距 >= 8.0mm
        List<PlacedPiece> gp = gapRes.getPieces();
        for (int i = 0; i < gp.size(); i++) {
            PlacedPiece a = gp.get(i);
            for (int j = i + 1; j < gp.size(); j++) {
                PlacedPiece b = gp.get(j);
                double g = 8.0 - 0.001;
                assertTrue(a.getX() + a.getW() + g <= b.getX() || b.getX() + b.getW() + g <= a.getX()
                        || a.getY() + a.getL() + g <= b.getY() || b.getY() + b.getL() + g <= a.getY(),
                        "pieceGap 间距约束被破坏");
            }
        }
        double gapBoardArea = (gapReq.getRollW() * gapReq.getRollL()) / 1_000_000.0;
        double gapUtilPct = (gapRes.getPieceArea() / gapBoardArea) * 100.0;
        System.out.printf(Locale.ROOT, "带pieceGap(8mm) | %d/%d | %.2f%% | %.2f%% | %.1f | %d | %d%n",
                gp.size(), 12, gapUtilPct,
                (gapRes.getPieceArea() / ((gapReq.getRollW() * Math.max(1.0, gapRes.getDeductLen())) / 1_000_000.0)) * 100.0,
                gapRes.getDeductLen(), gapRes.getCuts().size(), gapMs);
        System.out.println("=== GUILLOTINE_BENCHMARK_END ===");

        assertTrue(totalPlaced > 0 && totalUtilBoard > 0);
    }

    @Test
    void verticalFirstStageAndAllFourOriginsPassStrictValidation() {
        SolverFactory factory = factory();
        List<Part> parts = List.of(
                new Part(1, "纵切大件", Shape.rectangle(700, 1100), 2, true),
                new Part(2, "纵切中件", Shape.rectangle(550, 750), 3, true),
                new Part(3, "纵切小件", Shape.rectangle(400, 420), 4, true)
        );
        for (String firstStage : List.of("horizontal", "vertical")) {
            for (String origin : List.of("left-top", "right-top", "left-bottom", "right-bottom")) {
                NestingProblem prob = new NestingProblem(
                        "1", "mm",
                        new Material("m-" + firstStage + "-" + origin, Shape.rectangle(2000, 2600),
                                List.of(new Exclusion(1, 800, 900, Shape.rectangle(150, 150), 15)), false),
                        parts,
                        guillotineProcess("SHEET", origin, firstStage, 20.0),
                        "javaguillotine",
                        1
                );
                NestingResult res = factory.solve(prob);
                assertTrue(res.feasible(), firstStage + "/" + origin + " 求解失败: " + res.message());
                assertTrue(res.placements().size() >= 6, firstStage + "/" + origin + " 排入件数过低: " + res.placements().size());
                assertNoCutPenetratesAnyPiece(firstStage + "/" + origin, res);
                assertFirstStageOrientationMatches(firstStage + "/" + origin, prob, res);
            }
        }
    }

    @Test
    void deterministicRepeatabilityAcrossRuns() {
        SolverFactory factory = factory();
        BenchmarkCase bc = benchmarkCases().get(2); // 紧约束互补套裁
        NestingResult r1 = factory.solve(bc.problem());
        NestingResult r2 = factory.solve(bc.problem());
        assertTrue(r1.feasible() && r2.feasible());
        assertEquals(r1.placements().size(), r2.placements().size());
        assertEquals(r1.metrics().pieceAreaMm2(), r2.metrics().pieceAreaMm2(), 1e-6);
        assertEquals(r1.metrics().suggestedFeedLengthMm(), r2.metrics().suggestedFeedLengthMm(), 1e-6);
        assertEquals(r1.cuts().size(), r2.cuts().size());
    }

    @Test
    void respectsTimeBudgetAndCancellationOnLargerInstance() {
        SolverFactory factory = factory();
        NestingProblem large = new NestingProblem(
                "1", "mm",
                new Material("bench-large", Shape.rectangle(2800, 6000), List.of(), false),
                List.of(
                        new Part(1, "大件1", Shape.rectangle(920, 740), 8, true),
                        new Part(2, "中件2", Shape.rectangle(680, 560), 12, true),
                        new Part(3, "长条3", Shape.rectangle(860, 320), 12, true),
                        new Part(4, "小件4", Shape.rectangle(410, 350), 18, true)
                ),
                guillotineProcess("CONTINUOUS", "left-top", "horizontal", 0),
                "javaguillotine",
                1
        );
        long t0 = System.nanoTime();
        NestingResult res = factory.solve(large);
        long elapsedMs = (System.nanoTime() - t0) / 1_000_000L;
        assertTrue(res.feasible(), "大算例必须求解成功: " + res.message());
        assertNoCutPenetratesAnyPiece("large", res);
        assertTrue(elapsedMs < 2500L, "1 秒时间预算下不应严重超时，实际耗时=" + elapsedMs + "ms");

        // 中断信号应立即返回 CANCELLED 且保留线程中断状态
        Thread.currentThread().interrupt();
        try {
            NestingResult cancelled = factory.solve(large);
            assertEquals("CANCELLED", cancelled.status());
            assertTrue(Thread.currentThread().isInterrupted());
        } finally {
            Thread.interrupted();
        }
    }

    private static void assertNoCutPenetratesAnyPiece(String label, NestingResult res) {
        double eps = 1e-3;
        for (var cut : res.cuts()) {
            boolean horiz = "HORIZONTAL".equalsIgnoreCase(cut.kind()) || "横切".equals(cut.kind());
            if (horiz) {
                double y = cut.startY();
                double x1 = Math.min(cut.startX(), cut.endX());
                double x2 = Math.max(cut.startX(), cut.endX());
                for (var p : res.placements()) {
                    boolean yInside = y > p.y() + eps && y < p.y() + p.shape().height() - eps;
                    boolean xOverlap = x2 > p.x() + eps && x1 < p.x() + p.shape().width() - eps;
                    assertFalse(yInside && xOverlap,
                            label + " 横切刀穿透裁片内部: cutY=" + y + " [" + x1 + "," + x2 + "] vs piece " + p.id());
                }
            } else {
                double x = cut.startX();
                double y1 = Math.min(cut.startY(), cut.endY());
                double y2 = Math.max(cut.startY(), cut.endY());
                for (var p : res.placements()) {
                    boolean xInside = x > p.x() + eps && x < p.x() + p.shape().width() - eps;
                    boolean yOverlap = y2 > p.y() + eps && y1 < p.y() + p.shape().height() - eps;
                    assertFalse(xInside && yOverlap,
                            label + " 纵切刀穿透裁片内部: cutX=" + x + " [" + y1 + "," + y2 + "] vs piece " + p.id());
                }
            }
        }
    }

    private static void assertFirstStageOrientationMatches(String label, NestingProblem problem, NestingResult res) {
        boolean expectHorizontal = !"vertical".equalsIgnoreCase(problem.process().firstStageOrientation());
        int firstWorkingStage = problem.process().trimStart() > 0 ? 2 : 1;
        List<NestingResult.Cut> firstStageCuts = res.cuts().stream()
                .filter(c -> c.stage() != null && c.stage() == firstWorkingStage)
                .toList();
        assertFalse(firstStageCuts.isEmpty(), label + " 应存在第 1 阶段首刀（stage=" + firstWorkingStage + "）");
        for (NestingResult.Cut cut : firstStageCuts) {
            boolean isHoriz = "HORIZONTAL".equalsIgnoreCase(cut.kind()) || "横切".equals(cut.kind());
            assertEquals(expectHorizontal, isHoriz,
                    label + " 非修齐首刀方向必须严格匹配 firstStageOrientation="
                            + problem.process().firstStageOrientation() + "，实际=" + cut.kind());
        }
    }
}
