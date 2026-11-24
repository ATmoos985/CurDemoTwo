package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Exclusion;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.FabricRule;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Material;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Part;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Process;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase 5 大批量二维异形“均衡互补分区求解 → 条带拼接 → 全局跨缝压紧”专项测试与基准对比。
 */
class Phase5PartitionNestingTests {

    private final DeepnestSolverEngine engine = new DeepnestSolverEngine();

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

    private static Shape scaleShape(Shape shape, double factor) {
        if ("RECTANGLE".equals(shape.type())) {
            return Shape.rectangle(Math.rint(shape.width() * factor * 10.0) / 10.0,
                    Math.rint(shape.height() * factor * 10.0) / 10.0);
        }
        double[] xy = new double[shape.vertices().size() * 2];
        for (int i = 0; i < shape.vertices().size(); i++) {
            Point p = shape.vertices().get(i);
            xy[i * 2] = Math.rint(p.x() * factor * 10.0) / 10.0;
            xy[i * 2 + 1] = Math.rint(p.y() * factor * 10.0) / 10.0;
        }
        return polygon(xy);
    }

    private static Shape lShape(double w, double h, double legW, double legH) {
        return polygon(0, 0, w, 0, w, legH, legW, legH, legW, h, 0, h);
    }

    private static Shape uShape(double w, double h, double wall, double notchDepth) {
        return polygon(
                0, 0,
                wall, 0,
                wall, notchDepth,
                w - wall, notchDepth,
                w - wall, 0,
                w, 0,
                w, h,
                0, h
        );
    }

    private static Shape trapezoid(double topInset, double bottomW, double h) {
        return polygon(topInset, 0, bottomW - topInset, 0, bottomW, h, 0, h);
    }

    private static Shape rightTriangle(double w, double h) {
        return polygon(0, 0, w, 0, 0, h);
    }

    private static Shape pentagonPocket(double w, double shoulderH, double tipH) {
        return polygon(0, 0, w, 0, w, shoulderH, w * 0.5, tipH, 0, shoulderH);
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

    private static Shape shirtCollar() {
        return polygon(0, 0, 340, 0, 320, 70, 20, 70);
    }

    private static Process contourProcess(double pieceGap, String startCorner) {
        return new Process("CONTOUR", "SHEET", startCorner, "none",
                0, 0, 0, 0, "MAXIMIZE_PIECE_AREA", pieceGap);
    }

    private static double stripLength(List<Placement> placements) {
        return placements.stream().mapToDouble(p -> p.y() + p.shape().height()).max().orElse(0.0);
    }

    private static double stripUtilizationPct(double matW, List<Placement> placements) {
        double len = stripLength(placements);
        if (len <= 1e-9) return 0.0;
        double area = placements.stream().mapToDouble(p -> p.shape().areaMm2()).sum();
        return (area / (matW * len)) * 100.0;
    }

    private static void assertZeroToleranceAndDemandConservation(NestingProblem problem, EngineResult res, boolean requireFull) {
        assertTrue(res.isSuccess(), "求解应成功：" + res.getMessage());
        assertFalse(res.getPlacements().isEmpty(), "应产出放置结果");
        String err = PolygonResultValidator.validate(problem, res);
        assertNull(err, "必须通过 PolygonResultValidator 零容忍校验，实际错误：" + err);

        Map<Integer, Integer> actualByDemand = new HashMap<>();
        for (Placement p : res.getPlacements()) {
            actualByDemand.merge(p.demandId(), 1, Integer::sum);
        }
        int expectedTotal = 0;
        for (Part part : problem.parts()) {
            expectedTotal += part.quantity();
            int placed = actualByDemand.getOrDefault(part.id(), 0);
            assertTrue(placed <= part.quantity(), "严禁超排需求 partId=" + part.id());
            if (requireFull) {
                assertEquals(part.quantity(), placed, "需满排守恒 partId=" + part.id());
            }
        }
        if (requireFull) {
            assertEquals(expectedTotal, res.getPlacements().size(), "总件数必须严格满排守恒");
        }
    }

    /** 60 件工业异形混合算例（L形 + U形 + 梯形 + 直角三角形，pieceGap = 4mm）。 */
    private static NestingProblem build60MixedIndustrialProblem(int timeLimitSeconds) {
        List<Part> parts = List.of(
                new Part(1, "L形支架", lShape(260, 260, 100, 100), 16, true),
                new Part(2, "U形框体", uShape(320, 240, 75, 145), 12, false, true),
                new Part(3, "等腰梯形板", trapezoid(45, 250, 170), 16, false, true),
                new Part(4, "直角三角补片", rightTriangle(200, 150), 16, true)
        );
        return new NestingProblem(
                "1", "mm",
                new Material("bench-60-mixed", Shape.rectangle(1500, 5000), List.of(), false),
                parts,
                contourProcess(4.0, "left-top"),
                "deepnest",
                timeLimitSeconds
        );
    }

    /** 100 件非整除多原型混合大批量算例（L/U/梯形/三角/五边形，pieceGap = 5mm）。 */
    private static NestingProblem build100MixedNonDivisibleProblem(int timeLimitSeconds) {
        List<Part> parts = List.of(
                new Part(1, "L形大件", lShape(270, 250, 105, 95), 18, true),
                new Part(2, "U形凹槽件", uShape(330, 240, 80, 145), 14, false, true),
                new Part(3, "梯形中件", trapezoid(40, 240, 165), 23, false, true),
                new Part(4, "直角三角件", rightTriangle(195, 145), 25, true),
                new Part(5, "五边形袋片", pentagonPocket(150, 125, 175), 20, false, true)
        );
        return new NestingProblem(
                "1", "mm",
                new Material("bench-100-mixed", Shape.rectangle(1600, 7000), List.of(), false),
                parts,
                contourProcess(5.0, "left-top"),
                "deepnest",
                timeLimitSeconds
        );
    }

    /** 144 件多尺码衬衫工业大单（M 码 8 套 + L 码 8 套 = 16 套 × 9 片 = 144 件，pieceGap = 4mm）。 */
    private static NestingProblem build144MultiSizeShirtProblem(int timeLimitSeconds) {
        Shape frontL = shirtFront();
        Shape backL = shirtBack();
        Shape sleeveL = shirtSleeve();
        Shape collarL = shirtCollar();
        Shape weltL = Shape.rectangle(55, 400);
        Shape pocketL = pentagonPocket(150, 140, 180);

        Shape frontM = scaleShape(frontL, 0.94);
        Shape backM = scaleShape(backL, 0.94);
        Shape sleeveM = scaleShape(sleeveL, 0.94);
        Shape collarM = scaleShape(collarL, 0.94);
        Shape weltM = scaleShape(weltL, 0.94);
        Shape pocketM = scaleShape(pocketL, 0.94);

        List<Part> parts = List.of(
                new Part(1, "L-前片", frontL, 8, false, true),
                new Part(2, "L-后片", backL, 8, false, true),
                new Part(3, "L-袖片", sleeveL, 16, false, true),
                new Part(4, "L-领片", collarL, 8, false, true),
                new Part(5, "L-贴边", weltL, 16, false, true),
                new Part(6, "L-袋布", pocketL, 16, false, true),
                new Part(7, "M-前片", frontM, 8, false, true),
                new Part(8, "M-后片", backM, 8, false, true),
                new Part(9, "M-袖片", sleeveM, 16, false, true),
                new Part(10, "M-领片", collarM, 8, false, true),
                new Part(11, "M-贴边", weltM, 16, false, true),
                new Part(12, "M-袋布", pocketM, 16, false, true)
        );
        return new NestingProblem(
                "1", "mm",
                new Material("bench-144-shirt", Shape.rectangle(1600, 18000), List.of(), false),
                parts,
                contourProcess(4.0, "left-top"),
                "deepnest",
                timeLimitSeconds
        );
    }

    @Test
    void balancedPartitionConservesAllDemandsAndMixesLargeMediumSmallProportionally() {
        assertEquals(2, ContourPartitionSolver.computeBucketCount(48));
        assertEquals(2, ContourPartitionSolver.computeBucketCount(60));
        assertEquals(3, ContourPartitionSolver.computeBucketCount(61));
        assertEquals(3, ContourPartitionSolver.computeBucketCount(90));
        assertEquals(4, ContourPartitionSolver.computeBucketCount(91));
        assertEquals(4, ContourPartitionSolver.computeBucketCount(100));
        assertEquals(4, ContourPartitionSolver.computeBucketCount(144));
        assertEquals(4, ContourPartitionSolver.computeBucketCount(200));

        // 检验非整除混合算例（100 件 -> K=4）和整除大单（144 件 -> K=4）的守恒与均衡互补性
        for (NestingProblem prob : List.of(
                build60MixedIndustrialProblem(5),
                build100MixedNonDivisibleProblem(5),
                build144MultiSizeShirtProblem(5))) {
            int total = prob.parts().stream().mapToInt(Part::quantity).sum();
            int k = ContourPartitionSolver.computeBucketCount(total);
            List<ContourPartitionSolver.Bucket> buckets = ContourPartitionSolver.buildBalancedBuckets(prob, k);
            assertEquals(k, buckets.size());

            int minBucketCount = buckets.stream().mapToInt(ContourPartitionSolver.Bucket::totalCount).min().orElseThrow();
            int maxBucketCount = buckets.stream().mapToInt(ContourPartitionSolver.Bucket::totalCount).max().orElseThrow();
            assertTrue(maxBucketCount - minBucketCount <= 1,
                    "各子区总件数极差应 <= 1，实际: " + minBucketCount + ".." + maxBucketCount);
            assertEquals(total, buckets.stream().mapToInt(ContourPartitionSolver.Bucket::totalCount).sum());

            for (Part orig : prob.parts()) {
                int sumAcross = 0;
                int minPerPart = Integer.MAX_VALUE;
                int maxPerPart = Integer.MIN_VALUE;
                for (ContourPartitionSolver.Bucket bucket : buckets) {
                    int q = bucket.parts().stream()
                            .filter(p -> p.id() == orig.id())
                            .mapToInt(Part::quantity)
                            .sum();
                    sumAcross += q;
                    minPerPart = Math.min(minPerPart, q);
                    maxPerPart = Math.max(maxPerPart, q);
                }
                assertEquals(orig.quantity(), sumAcross, "零件数量必须跨子区严格守恒: partId=" + orig.id());
                assertTrue(maxPerPart - minPerPart <= 1,
                        "每种零件必须按比例均摊到所有子区（避免大件小件分离），partId=" + orig.id()
                                + " 分布=" + minPerPart + ".." + maxPerPart);
            }
        }
    }

    @Test
    void eligibilityGuardKeepsSmallDefectivePolygonCurtainAndNonLeftTopUnchanged() {
        List<Part> parts50 = List.of(
                new Part(1, "L", lShape(200, 200, 80, 80), 25, true),
                new Part(2, "Tri", rightTriangle(180, 140), 25, true)
        );
        List<Part> parts47 = List.of(
                new Part(1, "L", lShape(200, 200, 80, 80), 24, true),
                new Part(2, "Tri", rightTriangle(180, 140), 23, true)
        );
        long budget = 5_000_000_000L;

        // 1. < 48 件不触发分区，且 solve 与 solveDirect 100% 逐位一致
        NestingProblem small47 = new NestingProblem(
                "1", "mm", new Material("small", Shape.rectangle(1500, 4000), List.of(), false),
                parts47, contourProcess(4.0, "left-top"), "deepnest", 2);
        assertFalse(ContourPartitionSolver.isEligible(small47, true, true, false, false, 47, 1e6, 6e6, budget));

        NestingProblem small12 = new NestingProblem(
                "1", "mm", new Material("small12", Shape.rectangle(1000, 1200), List.of(), false),
                List.of(new Part(1, "L", lShape(200, 200, 80, 80), 12, true)),
                contourProcess(3.0, "left-top"), "deepnest", 3);
        EngineResult viaSolve = engine.solve(small12);
        EngineResult viaDirect = engine.solveDirect(small12, false);
        assertZeroToleranceAndDemandConservation(small12, viaSolve, true);
        assertEquals(viaDirect.getPlacements().size(), viaSolve.getPlacements().size());
        for (int i = 0; i < viaDirect.getPlacements().size(); i++) {
            Placement a = viaDirect.getPlacements().get(i);
            Placement b = viaSolve.getPlacements().get(i);
            assertEquals(a.demandId(), b.demandId());
            assertEquals(a.rotationDegrees(), b.rotationDegrees());
            assertEquals(a.x(), b.x(), 1e-6);
            assertEquals(a.y(), b.y(), 1e-6);
        }

        // 2. 带疵点不触发（且 >=48 件带疵点实跑与 solveDirect 逐位一致，无残留分区诊断）
        NestingProblem withDefect = new NestingProblem(
                "1", "mm",
                new Material("def", Shape.rectangle(1500, 4000),
                        List.of(new Exclusion(1, 200, 200, Shape.rectangle(80, 80), 5.0)), false),
                parts50, contourProcess(4.0, "left-top"), "deepnest", 5);
        assertFalse(ContourPartitionSolver.isEligible(withDefect, true, true, false, false, 50, 1e6, 6e6, budget));
        EngineResult defectViaSolve = engine.solve(withDefect);
        assertNull(ContourPartitionSolver.lastDiagnostics(), "未触发分区时不得残留分区诊断数据");
        EngineResult defectViaDirect = engine.solveDirect(withDefect, false);
        assertZeroToleranceAndDemandConservation(withDefect, defectViaSolve, true);
        assertEquals(defectViaDirect.getPlacements().size(), defectViaSolve.getPlacements().size());
        for (int i = 0; i < defectViaDirect.getPlacements().size(); i++) {
            Placement a = defectViaDirect.getPlacements().get(i);
            Placement b = defectViaSolve.getPlacements().get(i);
            assertEquals(a.demandId(), b.demandId());
            assertEquals(a.rotationDegrees(), b.rotationDegrees());
            assertEquals(a.x(), b.x(), 1e-6);
            assertEquals(a.y(), b.y(), 1e-6);
        }

        // 3. 异形非矩形板材不触发
        NestingProblem polySheet = new NestingProblem(
                "1", "mm",
                new Material("poly", lShape(1500, 4000, 900, 2000), List.of(), false),
                parts50, contourProcess(4.0, "left-top"), "deepnest", 5);
        assertFalse(ContourPartitionSolver.isEligible(polySheet, false, true, false, false, 50, 1e6, 4e6, budget));

        // 4. 非 NOOP 窗帘约束不触发
        NestingProblem curtainProb = new NestingProblem(
                "1", "mm",
                new Material("curtain", Shape.rectangle(1500, 4000), List.of(), false,
                        new FabricRule(30.0, 30.0, false, null, null)),
                parts50, contourProcess(4.0, "left-top"), "deepnest", 5);
        assertFalse(ContourPartitionSolver.isEligible(curtainProb, true, false, false, false, 50, 1e6, 6e6, budget));

        // 5. 非 left-top 起角不触发
        for (String corner : List.of("right-top", "left-bottom", "right-bottom")) {
            NestingProblem nonLeftTop = new NestingProblem(
                    "1", "mm", new Material("c-" + corner, Shape.rectangle(1500, 4000), List.of(), false),
                    parts50, contourProcess(4.0, corner), "deepnest", 5);
            assertFalse(ContourPartitionSolver.isEligible(
                    nonLeftTop, true, true, corner.startsWith("right"), corner.endsWith("bottom"),
                    50, 1e6, 6e6, budget), "起角 " + corner + " 必须保持原路径不触发分区");
        }
    }

    @Test
    void benchmark60_100_144PiecesDirectVsPartitionedAndGlobalCompaction() {
        record BenchCase(String label, NestingProblem problem) {}
        List<BenchCase> cases = List.of(
                new BenchCase("60件 L/U/梯形/三角混合 (gap=4mm)", build60MixedIndustrialProblem(12)),
                new BenchCase("100件 非整除五类异形混合 (gap=5mm)", build100MixedNonDivisibleProblem(15)),
                new BenchCase("144件 M/L多尺码衬衫大单 (gap=4mm)", build144MultiSizeShirtProblem(18))
        );

        System.out.println("\n================ Phase 5 大批量异形排样：常规直跑 vs 分区并行+全局接缝压紧 ================");
        System.out.println("| 算例 | 直跑件数 | 分区件数 | 直跑版长(mm) | 分区版长(mm) | 直跑利用率 | 分区利用率 | 直跑耗时(ms) | 分区耗时(ms) | 加速比 |");
        System.out.println("| --- | :---: | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");

        for (BenchCase bc : cases) {
            NestingProblem problem = bc.problem();
            int expectedTotal = problem.parts().stream().mapToInt(Part::quantity).sum();

            // 1. 常规直跑（关闭分区）
            long tDirect0 = System.nanoTime();
            EngineResult directRes = engine.solveDirect(problem, false);
            long directMs = (System.nanoTime() - tDirect0) / 1_000_000L;
            assertZeroToleranceAndDemandConservation(problem, directRes, false);

            // 2. 分区并行 + 全局跨缝压紧
            long tPart0 = System.nanoTime();
            EngineResult partRes = engine.solve(problem);
            long partMs = (System.nanoTime() - tPart0) / 1_000_000L;
            assertZeroToleranceAndDemandConservation(problem, partRes, true);

            double directLen = stripLength(directRes.getPlacements());
            double partLen = stripLength(partRes.getPlacements());
            double directUtil = stripUtilizationPct(problem.width(), directRes.getPlacements());
            double partUtil = stripUtilizationPct(problem.width(), partRes.getPlacements());
            double speedup = partMs > 0 ? (double) directMs / partMs : 99.0;

            System.out.printf(Locale.ROOT,
                    "| %s | %d/%d | %d/%d | %.1f | %.1f | %.2f%% | %.2f%% | %d | %d | %.2fx |%n",
                    bc.label(),
                    directRes.getPlacements().size(), expectedTotal,
                    partRes.getPlacements().size(), expectedTotal,
                    directLen, partLen,
                    directUtil, partUtil,
                    directMs, partMs, speedup);
            ContourPartitionSolver.Diagnostics diag = ContourPartitionSolver.lastDiagnostics();
            if (diag != null) {
                System.out.printf(Locale.ROOT,
                        "  [diag] K=%d, uniq=%d, sub=%dms, axis1=%dms, gap=%dms, seamLns=%dms, axis2=%dms | stitch=%.1f -> axis1=%.1f(alt=%s) -> gap=%.1f -> seamLns=%.1f -> final=%.1f%n",
                        diag.bucketCount(), diag.uniquePrototypes(),
                        diag.subSolveMs(), diag.axis1Ms(), diag.gapCompactMs(), diag.seamLnsMs(), diag.axis2Ms(),
                        diag.stitchedFwdLen(), diag.afterAxis1Len(), diag.choseAlternating(),
                        diag.afterGapLen(), diag.afterSeamLnsLen(), diag.finalLen());
            }

            assertEquals(expectedTotal, partRes.getPlacements().size(), bc.label() + " 分区方案必须 100% 满排");
            assertTrue(partUtil >= 60.0, bc.label() + " 分区压紧后条带利用率应达到工业可用水平，实际=" + partUtil);
        }
        System.out.println("==========================================================================================\n");
    }

    @Test
    void partitionedSolvingIs100PercentDeterministicAcrossRepeatedRuns() {
        // 覆盖 60 件等原型、100 件非等原型多桶并行、144 件多尺码衬衫大单的跨次运行 100% 确定性
        for (NestingProblem prob : List.of(
                build60MixedIndustrialProblem(15),
                build100MixedNonDivisibleProblem(18),
                build144MultiSizeShirtProblem(18))) {
            EngineResult first = engine.solve(prob);
            EngineResult second = engine.solve(prob);

            assertZeroToleranceAndDemandConservation(prob, first, true);
            assertZeroToleranceAndDemandConservation(prob, second, true);

            assertEquals(first.getPlacements().size(), second.getPlacements().size());
            assertEquals(stripLength(first.getPlacements()), stripLength(second.getPlacements()), 1e-6,
                    "重复运行有效版长必须 100% 确定一致");
            for (int i = 0; i < first.getPlacements().size(); i++) {
                Placement a = first.getPlacements().get(i);
                Placement b = second.getPlacements().get(i);
                assertEquals(a.demandId(), b.demandId(), "索引 " + i + " demandId 不一致");
                assertEquals(a.rotationDegrees(), b.rotationDegrees(), "索引 " + i + " 角度不一致");
                assertEquals(a.x(), b.x(), 1e-6, "索引 " + i + " X 坐标不一致");
                assertEquals(a.y(), b.y(), 1e-6, "索引 " + i + " Y 坐标不一致");
            }
        }
    }

    @Test
    void partitionedSolvingRespondsPromptlyToCooperativeCancellation() throws Exception {
        NestingProblem heavy = build100MixedNonDivisibleProblem(15);

        // 1. 进入前已带中断标志：立刻抛出 CancellationException 且保留中断位
        Thread.currentThread().interrupt();
        try {
            assertThrows(CancellationException.class, () -> engine.solve(heavy));
            assertTrue(Thread.currentThread().isInterrupted(), "不得吞掉调用线程的中断标记");
        } finally {
            Thread.interrupted();
        }

        // 2. 分区并行求解过程中中断：及时中止所有工作线程并退出
        AtomicReference<Throwable> outcome = new AtomicReference<>();
        Thread worker = new Thread(() -> {
            try {
                engine.solve(heavy);
                outcome.set(new AssertionError("预期应抛出 CancellationException"));
            } catch (Throwable t) {
                outcome.set(t);
            }
        }, "phase5-partition-cancel-test");
        worker.setDaemon(true);
        worker.start();
        try {
            long waitDeadline = System.nanoTime() + 3_000_000_000L;
            boolean entered = false;
            while (worker.isAlive() && System.nanoTime() < waitDeadline) {
                entered = Arrays.stream(worker.getStackTrace())
                        .anyMatch(f -> f.getClassName().contains("ContourPartitionSolver")
                                || f.getClassName().contains("Deepnest")
                                || f.getClassName().contains("Compactor"));
                if (entered) break;
                Thread.sleep(2);
            }
            assertTrue(entered, "工作线程应进入分区/Deepnest 求解");
            worker.interrupt();
            worker.join(1500);
            assertFalse(worker.isAlive(), "收到取消中断后应在 1.5s 内释放线程");
            assertInstanceOf(CancellationException.class, outcome.get());
        } finally {
            worker.interrupt();
            worker.join(1000);
        }
    }

    @Test
    void fallsBackSafelyToDirectSolveWhenSheetHeightCannotFitAllPieces() {
        // 56 件 L 形总面积约 2.016e6 mm²，但板材 1000x2100 = 2.1e6 mm²（96% 满载几乎无法靠分区满排）
        // 验证分区超限时安全回退常规直跑，且出口依然 100% 合法通过零容忍校验
        List<Part> parts = List.of(new Part(1, "L-240", lShape(240, 240, 100, 100), 56, true));
        NestingProblem tightSheet = new NestingProblem(
                "1", "mm",
                new Material("tight-fallback", Shape.rectangle(1000, 2100), List.of(), false),
                parts,
                contourProcess(4.0, "left-top"),
                "deepnest",
                4
        );
        EngineResult res = engine.solve(tightSheet);
        assertZeroToleranceAndDemandConservation(tightSheet, res, false);
        assertTrue(res.getPlacements().size() > 0, "回退常规直跑后应返回合法可行局部排样");
    }
}
