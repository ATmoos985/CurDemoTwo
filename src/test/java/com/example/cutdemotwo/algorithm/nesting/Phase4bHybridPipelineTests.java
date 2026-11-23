package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.nesting.constraints.PatternRepeatRule;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Exclusion;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.FabricRule;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Material;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Part;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.PartRule;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Process;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase 4B 三阶段混合求解管线（构造+GA → LNS大邻域精修 → 联动压紧+独立终检）专项验证。
 */
class Phase4bHybridPipelineTests {

    private final DeepnestSolverEngine engine = new DeepnestSolverEngine();
    private final SolverFactory factory = new SolverFactory(List.of(engine), true);

    private static Shape polygon(double... xy) {
        List<Point> raw = new ArrayList<>(xy.length / 2);
        double minX = Double.POSITIVE_INFINITY, minY = Double.POSITIVE_INFINITY;
        double maxX = Double.NEGATIVE_INFINITY, maxY = Double.NEGATIVE_INFINITY;
        for (int i = 0; i < xy.length; i += 2) {
            double x = xy[i], y = xy[i + 1];
            raw.add(new Point(x, y));
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
        final double ox = minX, oy = minY;
        List<Point> shifted = raw.stream().map(p -> new Point(p.x() - ox, p.y() - oy)).toList();
        return new Shape("POLYGON", maxX - minX, maxY - minY, shifted);
    }

    private static Shape lShape(double w, double h, double legW, double legH) {
        return polygon(0, 0, w, 0, w, legH, legW, legH, legW, h, 0, h);
    }

    private static Shape valanceShape() {
        // 典型窗幔波浪轮廓（带凹槽）
        return polygon(
                0, 0, 420, 0, 420, 180,
                340, 220, 260, 165, 210, 230, 160, 165, 80, 220,
                0, 180
        );
    }

    private static Shape shirtFront() {
        return polygon(0, 640, 20, 380, 0, 220, 45, 205, 70, 170, 85, 120, 90, 55, 180, 0,
                195, 35, 220, 65, 250, 75, 280, 65, 305, 35, 320, 0, 410, 55, 415, 120, 430, 170,
                455, 205, 500, 220, 480, 380, 500, 640);
    }

    private static Shape shirtBack() {
        return polygon(0, 650, 20, 380, 0, 220, 45, 205, 70, 170, 85, 120, 90, 55, 180, 0,
                210, 20, 250, 28, 290, 20, 320, 0, 410, 55, 415, 120, 430, 170, 455, 205, 500, 220,
                480, 380, 500, 650);
    }

    private static Shape shirtSleeve() {
        return polygon(0, 150, 25, 100, 65, 55, 110, 18, 160, 0, 210, 18, 255, 55, 295, 100,
                320, 150, 280, 500, 40, 500);
    }

    private static Process contourProcess(double pieceGap) {
        return new Process("CONTOUR", "SHEET", "left-top", "none",
                0, 0, 0, 0, "MAXIMIZE_PIECE_AREA", pieceGap);
    }

    private static double stripLength(List<Placement> placements) {
        return placements.stream().mapToDouble(p -> p.y() + p.shape().height()).max().orElse(0.0);
    }

    private static void assertZeroToleranceValid(NestingProblem problem, EngineResult res) {
        assertTrue(res.isSuccess(), "求解应成功：" + res.getMessage());
        assertFalse(res.getPlacements().isEmpty(), "应有放置结果");
        String error = PolygonResultValidator.validate(problem, res);
        assertNull(error, "出口必须通过 PolygonResultValidator 零容忍校验，实际错误：" + error);
    }

    @Test
    void hybridPipelineValidOnConcavePolygonsWithPieceGapAndDefects() {
        List<Exclusion> defects = List.of(
                new Exclusion(1, 220, 160, Shape.rectangle(90, 80), 10.0),
                new Exclusion(2, 680, 420, Shape.rectangle(100, 90), 5.0)
        );
        List<Part> parts = List.of(
                new Part(1, "L形异形片", lShape(260, 260, 100, 100), 6, true),
                new Part(2, "窗幔片", valanceShape(), 4, false, true),
                new Part(3, "三角片", polygon(0, 0, 220, 0, 0, 180), 4, true)
        );
        NestingProblem problem = new NestingProblem(
                "1", "mm",
                new Material("concave-defect-gap", Shape.rectangle(1200, 1600), defects, false),
                parts,
                contourProcess(6.0),
                "deepnest",
                3
        );

        EngineResult res = engine.solve(problem);
        assertZeroToleranceValid(problem, res);
        assertEquals(14, res.getPlacements().size(), "14 件带间距与疵点的异形裁片应全部合法排入");
    }

    @Test
    void hybridPipelineHonorsPhase3CurtainConstraintsDuringLnsAndPolish() {
        // 组合 R1(分级疵点) + R2(左右布边禁入 40mm) + R3(经向锁定 0°) + R4(对花循环步长 300mm)
        Exclusion mildDefect = new Exclusion(1, 80, 100, Shape.rectangle(120, 100), 0, 1, "ALLOW_AUXILIARY");
        FabricRule fabricRule = new FabricRule(40.0, 40.0, false, 300.0, 0.0);
        Material mat = new Material("curtain-p3", Shape.rectangle(1200, 1800), List.of(mildDefect), false, fabricRule);
        List<Part> parts = List.of(
                new Part(1, "主帘窗幔", valanceShape(), 4, false, false,
                        new PartRule("MAIN", true, 0.0, 1.0)),
                new Part(2, "辅片绑带", Shape.rectangle(260, 120), 4, false, false,
                        new PartRule("AUXILIARY", false, null, null))
        );
        NestingProblem problem = new NestingProblem("1", "mm", mat, parts, contourProcess(4.0), "deepnest", 3);

        EngineResult res = engine.solve(problem);
        assertZeroToleranceValid(problem, res);
        assertEquals(8, res.getPlacements().size(), "全部 8 件窗帘主/辅片应合法排入");

        for (Placement p : res.getPlacements()) {
            assertTrue(p.x() >= 40.0 - 1e-3 && p.x() + p.shape().width() <= 1160.0 + 1e-3,
                    "所有裁片必须避开左右布边禁入区: " + p);
            if (p.demandId() == 1) {
                assertEquals(0, p.rotationDegrees(), "主片经向必须锁定 0°");
                Part mainPart = parts.get(0);
                assertTrue(PatternRepeatRule.isAligned(problem, mainPart, p.y()),
                        "主片必须满足 300mm 对花循环步长对齐: y=" + p.y());
            }
        }
    }

    @Test
    void hybridPipelineIsDeterministicAcrossRepeatedRuns() {
        List<Part> parts = List.of(
                new Part(1, "L-240", lShape(240, 240, 95, 95), 5, true),
                new Part(2, "窗幔", valanceShape(), 3, false, true),
                new Part(3, "衣袖", shirtSleeve(), 2, false, true)
        );
        NestingProblem problem = new NestingProblem(
                "1", "mm",
                new Material("det-mat", Shape.rectangle(1200, 1600), List.of(), false),
                parts,
                contourProcess(3.0),
                "deepnest",
                5
        );

        EngineResult first = engine.solve(problem);
        EngineResult second = engine.solve(problem);

        assertZeroToleranceValid(problem, first);
        assertZeroToleranceValid(problem, second);
        assertEquals(first.getPlacements().size(), second.getPlacements().size());
        assertEquals(stripLength(first.getPlacements()), stripLength(second.getPlacements()), 1e-6,
                "同输入重复求解的版长必须完全确定");
        for (int i = 0; i < first.getPlacements().size(); i++) {
            Placement a = first.getPlacements().get(i);
            Placement b = second.getPlacements().get(i);
            assertEquals(a.demandId(), b.demandId());
            assertEquals(a.rotationDegrees(), b.rotationDegrees());
            assertEquals(a.x(), b.x(), 1e-6);
            assertEquals(a.y(), b.y(), 1e-6);
        }
    }

    @Test
    void hybridPipelineRespectsCancellationAndTimeBudget() throws Exception {
        // 1. 短预算（1 秒）复杂多件算例不应显著超时
        List<Part> mediumParts = List.of(
                new Part(1, "前片", shirtFront(), 2, false, true),
                new Part(2, "后片", shirtBack(), 2, false, true),
                new Part(3, "袖片", shirtSleeve(), 4, false, true),
                new Part(4, "窗幔", valanceShape(), 4, false, true)
        );
        NestingProblem tightBudget = new NestingProblem(
                "1", "mm",
                new Material("budget-1s", Shape.rectangle(1500, 3000), List.of(), false),
                mediumParts,
                contourProcess(2.0),
                "deepnest",
                1
        );
        long t0 = System.nanoTime();
        EngineResult budgetRes = engine.solve(tightBudget);
        long elapsedMs = (System.nanoTime() - t0) / 1_000_000L;
        assertZeroToleranceValid(tightBudget, budgetRes);
        assertTrue(elapsedMs < 2500L, "1s 预算算例应在受控时间内完成，实际耗时: " + elapsedMs + "ms");

        // 2. 协作取消：运行中中断必须及时抛出 CancellationException 且不吞掉中断标记
        NestingProblem heavy = new NestingProblem(
                "1", "mm",
                new Material("cancel-heavy", Shape.rectangle(3000, 4000), List.of(), false),
                List.of(
                        new Part(1, "L形", lShape(240, 240, 90, 90), 30, true),
                        new Part(2, "窗幔", valanceShape(), 20, false, true)
                ),
                contourProcess(2.0),
                "deepnest",
                10
        );
        AtomicReference<Throwable> outcome = new AtomicReference<>();
        Thread worker = new Thread(() -> {
            try {
                engine.solve(heavy);
                outcome.set(new AssertionError("预期应抛出 CancellationException"));
            } catch (Throwable t) {
                outcome.set(t);
            }
        }, "phase4b-cancel-test");
        worker.setDaemon(true);
        worker.start();
        try {
            long waitDeadline = System.nanoTime() + 3_000_000_000L;
            boolean entered = false;
            while (worker.isAlive() && System.nanoTime() < waitDeadline) {
                entered = Arrays.stream(worker.getStackTrace())
                        .anyMatch(f -> f.getClassName().contains("Deepnest") || f.getClassName().contains("Compactor"));
                if (entered) break;
                Thread.sleep(2);
            }
            assertTrue(entered, "工作线程应进入 Deepnest/Compactor 计算");
            worker.interrupt();
            worker.join(1500);
            assertFalse(worker.isAlive(), "收到中断后应及时退出");
            assertInstanceOf(CancellationException.class, outcome.get());
        } finally {
            worker.interrupt();
            worker.join(1000);
        }
    }

    @Test
    void sixRepresentativeBenchmarkMetricsReport() {
        Shape collar = polygon(0, 0, 340, 0, 320, 70, 20, 70);
        Shape welt = Shape.rectangle(55, 400);
        Shape pocket = polygon(0, 0, 150, 0, 150, 140, 75, 180, 0, 140);
        List<Part> shirtHalfTurn = List.of(
                new Part(1, "M-前片", shirtFront(), 1, false, true),
                new Part(2, "M-后片", shirtBack(), 1, false, true),
                new Part(3, "M-袖片", shirtSleeve(), 2, false, true),
                new Part(4, "M-领片", collar, 1, false, true),
                new Part(5, "M-贴边", welt, 2, false, true),
                new Part(6, "M-袋布", pocket, 2, false, true),
                new Part(7, "L-前片", shirtFront(), 1, false, true),
                new Part(8, "L-后片", shirtBack(), 1, false, true),
                new Part(9, "L-袖片", shirtSleeve(), 2, false, true),
                new Part(10, "L-领片", collar, 1, false, true),
                new Part(11, "L-贴边", welt, 2, false, true),
                new Part(12, "L-袋布", pocket, 2, false, true)
        );
        List<Part> shirtFixed = shirtHalfTurn.stream()
                .map(p -> new Part(p.id(), p.name(), p.shape(), p.quantity(), false, false))
                .toList();

        Shape goredPanel = polygon(70, 0, 200, 0, 270, 650, 0, 650);
        Shape waistband = Shape.rectangle(390, 75);
        Shape pantsFront = polygon(70, 0, 350, 15, 380, 150, 390, 250, 420, 320, 340, 360,
                305, 600, 270, 1050, 70, 1050, 45, 650, 0, 310, 25, 120);
        Shape pantsBack = polygon(100, 0, 390, 20, 420, 170, 430, 270, 480, 340, 370, 390,
                330, 650, 290, 1080, 70, 1080, 45, 650, 0, 320, 30, 140);
        Shape pantsPocket = polygon(0, 0, 170, 0, 185, 130, 160, 195, 110, 230, 45, 215, 10, 160);

        record Bench(String name, NestingProblem problem) {}
        List<Bench> benches = List.of(
                new Bench("B1: L-Shape 4-Rot (8 pcs)",
                        new NestingProblem("1", "mm",
                                new Material("b1", Shape.rectangle(1000, 1200), List.of(), false),
                                List.of(new Part(1, "L-300", lShape(300, 300, 120, 120), 8, true)),
                                contourProcess(0.0), "deepnest", 3)),
                new Bench("B2: Right-Tri 180-Deg (12 pcs)",
                        new NestingProblem("1", "mm",
                                new Material("b2", Shape.rectangle(900, 1000), List.of(), false),
                                List.of(new Part(1, "Tri", polygon(0, 0, 300, 0, 0, 200), 12, false, true)),
                                contourProcess(0.0), "deepnest", 3)),
                new Bench("B3: Valance + L Mix (12 pcs, 4mm gap)",
                        new NestingProblem("1", "mm",
                                new Material("b3", Shape.rectangle(1200, 1600), List.of(), false),
                                List.of(
                                        new Part(1, "窗幔", valanceShape(), 6, false, true),
                                        new Part(2, "L-240", lShape(240, 240, 95, 95), 6, true)
                                ),
                                contourProcess(4.0), "deepnest", 3)),
                new Bench("B4: Shirt M+L Kit (0-Deg, 5mm Gap, 18 pcs)",
                        new NestingProblem("1", "mm",
                                new Material("b4", Shape.rectangle(1500, 2500), List.of(), false),
                                shirtFixed, contourProcess(5.0), "deepnest", 4)),
                new Bench("B5: Shirt M+L Kit (180-Deg, 0mm Gap, 18 pcs)",
                        new NestingProblem("1", "mm",
                                new Material("b5", Shape.rectangle(1500, 2500), List.of(), false),
                                shirtHalfTurn, contourProcess(0.0), "deepnest", 4)),
                new Bench("B6: Skirt + Jeans Mix (180-Deg, 14 pcs)",
                        new NestingProblem("1", "mm",
                                new Material("b6", Shape.rectangle(1500, 2200), List.of(), false),
                                List.of(
                                        new Part(1, "梯形裙片", goredPanel, 6, false, true),
                                        new Part(2, "半腰头", waistband, 2, false, true),
                                        new Part(3, "前裤片", pantsFront, 2, false, true),
                                        new Part(4, "后裤片", pantsBack, 2, false, true),
                                        new Part(5, "裤袋", pantsPocket, 2, false, true)
                                ),
                                contourProcess(0.0), "deepnest", 4))
        );

        StringBuilder report = new StringBuilder("\n=== Phase 4B Hybrid Pipeline 6-Case Benchmark ===\n");
        report.append(String.format("%-44s | %-7s | %-9s | %-9s | %-8s%n",
                "Case", "Placed", "Strip(mm)", "StripUtil", "Time(ms)"));
        report.append("-".repeat(90)).append("\n");

        for (Bench b : benches) {
            NestingResult res = factory.solve(b.problem(), false);
            assertEquals("FEASIBLE", res.status(), b.name() + " 应可行：" + res.message());
            int req = b.problem().parts().stream().mapToInt(Part::quantity).sum();
            assertEquals(req, res.placements().size(), b.name() + " 应全部排入");

            double len = stripLength(res.placements());
            double util = (res.metrics().pieceAreaMm2() / Math.max(1.0, b.problem().width() * len)) * 100.0;
            report.append(String.format("%-44s | %3d/%-3d | %9.1f | %8.2f%% | %6dms%n",
                    b.name(), res.placements().size(), req, len, util, res.elapsedMs()));
        }
        System.out.println(report);
    }
}
