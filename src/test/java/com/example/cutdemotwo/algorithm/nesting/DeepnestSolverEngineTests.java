package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.business.cutting.FabricSolveAdapter;
import com.example.cutdemotwo.business.model.PieceDemand;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Exclusion;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Material;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Part;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.*;

class DeepnestSolverEngineTests {
    private DeepnestSolverEngine deepnestEngine;
    private JavaIrregularSolverEngine javaHeuristicEngine;
    private IrregularPackingSolverService nativeIrregularEngine;
    private SolverFactory solverFactory;

    @BeforeEach
    void setUp() {
        deepnestEngine = new DeepnestSolverEngine();
        javaHeuristicEngine = new JavaIrregularSolverEngine();
        nativeIrregularEngine = new IrregularPackingSolverService();
        org.springframework.test.util.ReflectionTestUtils.setField(
                nativeIrregularEngine,
                "solverPath",
                Path.of("data/solver/packingsolver_irregular.exe").toString()
        );
        solverFactory = new SolverFactory(List.of(deepnestEngine, javaHeuristicEngine, nativeIrregularEngine));
    }

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

    private static Shape uFrameShape() {
        // 400 x 300 U-frame with a 240 x 200 concave pocket opening at the top: [80..320] x [0..200]
        return polygon(
                0, 0,
                80, 0,
                80, 200,
                320, 200,
                320, 0,
                400, 0,
                400, 300,
                0, 300
        );
    }

    private static NestingProblem contourProblem(Shape material, List<Part> parts, List<Exclusion> exclusions,
                                                 double pieceGap, String engine, int timeLimitSeconds) {
        return new NestingProblem(
                "1",
                "mm",
                new Material("bench-mat", material, exclusions, false),
                parts,
                new NestingProblem.Process("CONTOUR", "SHEET", "left-top", "none", 0, 0, 0, 0, "MAXIMIZE_PIECE_AREA", pieceGap),
                engine,
                timeLimitSeconds
        );
    }

    @Test
    void convexDecompositionPreservesExactAreaForConcaveGarmentAndUShapes() {
        Shape shirtFront = polygon(
                0, 640, 20, 380, 0, 220, 45, 205, 70, 170, 85, 120, 90, 55, 180, 0,
                195, 35, 220, 65, 250, 75, 280, 65, 305, 35, 320, 0, 410, 55, 415, 120,
                430, 170, 455, 205, 500, 220, 480, 380, 500, 640
        );
        for (Shape s : List.of(lShape(200, 200, 80, 80), uFrameShape(), shirtFront)) {
            PolygonGeometry.validate(s);
            List<List<Point>> pieces = DeepnestNfpGeometry.decomposeConvex(s);
            assertFalse(pieces.isEmpty());
            double sumArea = 0.0;
            for (List<Point> piece : pieces) {
                assertTrue(DeepnestNfpGeometry.isConvexPositive(piece), "Every decomposed piece must be convex");
                sumArea += PolygonGeometry.signedArea(piece);
            }
            assertEquals(PolygonGeometry.area(s), sumArea, 1e-4, "Convex decomposition must preserve exact polygon area");
        }
    }

    @Test
    void exactZeroSlackHalfTurnTrianglesInterlockIntoSingleRectangle() {
        Shape tri = polygon(0, 0, 200, 0, 0, 100);
        Part part = new Part(1, "right-tri", tri, 2, false, true);
        NestingProblem p = contourProblem(Shape.rectangle(200, 100), List.of(part), List.of(), 0.0, "deepnest", 2);

        NestingResult res = solverFactory.solve(p);
        assertEquals("FEASIBLE", res.status(), res.message());
        assertEquals("deepnest", res.engine());
        assertEquals(2, res.placements().size());
        assertEquals(Set.of(0, 180), res.placements().stream()
                .map(NestingResult.Placement::rotationDegrees).collect(Collectors.toSet()));
        assertEquals(20000.0, res.metrics().pieceAreaMm2(), 1e-3);
    }

    @Test
    void concaveMaterialDefectAndPieceGapAreStrictlyHonored() {
        Shape concaveSheet = polygon(0, 0, 800, 0, 800, 400, 450, 400, 450, 800, 0, 800);
        List<Exclusion> defects = List.of(new Exclusion(1, 180, 140, Shape.rectangle(90, 90), 15.0));
        List<Part> parts = List.of(
                new Part(1, "L", lShape(220, 220, 90, 90), 4, true),
                new Part(2, "T", polygon(0, 0, 180, 0, 0, 180), 3, true)
        );
        NestingProblem p = contourProblem(concaveSheet, parts, defects, 8.0, "deepnest", 3);

        NestingResult res = solverFactory.solve(p);
        assertEquals("FEASIBLE", res.status(), res.message());
        assertEquals("deepnest", res.engine());
        assertEquals(7, res.placements().size(), "All 7 irregular pieces should fit inside concave sheet avoiding defect");

        EngineResult check = new EngineResult();
        check.setSuccess(true);
        check.setPlacements(res.placements());
        assertNull(PolygonResultValidator.validate(p, check));
    }

    @Test
    void uFramePocketNestsSmallInsertInsideConcaveCavity() {
        // Sheet is 800 wide x 300 tall: two 400x300 U-frames fill the entire 800x300 bounding box!
        // The ONLY way to also fit two 180x150 inserts on this 800x300 sheet is inside the U-frames' 240x200 pockets!
        Shape sheet = Shape.rectangle(800, 300);
        List<Part> parts = List.of(
                new Part(1, "U-Frame", uFrameShape(), 2, false),
                new Part(2, "Pocket-Insert", Shape.rectangle(180, 150), 2, false)
        );
        NestingProblem pDeepnest = contourProblem(sheet, parts, List.of(), 0.0, "deepnest", 3);
        NestingResult resDeepnest = solverFactory.solve(pDeepnest);

        assertEquals("FEASIBLE", resDeepnest.status(), resDeepnest.message());
        assertEquals(4, resDeepnest.placements().size(),
                "Deepnest NFP must nest both inserts directly inside the U-frame concave pockets");
    }

    @Test
    void contourWorkflowHonorsExplicitDeepnestSolverSelection() {
        SolveRequest req = new SolveRequest();
        req.setRollW(600);
        req.setRollL(600);
        req.setTotalRollL(6000);
        req.setSolver("deepnest");
        req.setTimeLimitSeconds(2);
        Shape l = lShape(200, 200, 100, 100);
        PieceDemand d = new PieceDemand(1, "L-片", 200, 200, 4, true);
        d.setShape(l);
        req.setDemands(List.of(d));

        var response = FabricSolveAdapter.solve(solverFactory, req);
        assertTrue(response.isSuccess(), response.getMessage());
        assertEquals("deepnest", response.getEngine());
        assertEquals(4, response.getPieces().size());
    }

    @Test
    void stripSearchIsSupportedAndValidatedForDeepnestEngine() {
        NestingProblem p = contourProblem(
                Shape.rectangle(1000, 1200),
                List.of(new Part(1, "L-300", lShape(300, 300, 120, 120), 8, true)),
                List.of(), 0.0, "deepnest", 2
        );
        var stripFn = solverFactory.stripSearch(p, false);
        assertTrue(stripFn.isPresent(), "SolverFactory.stripSearch must support deepnest engine");
        NestingResult res = stripFn.get().apply(p);
        assertEquals("FEASIBLE", res.status());
        assertEquals("deepnest", res.engine());
        assertEquals(8, res.placements().size());
        double maxY = res.placements().stream().mapToDouble(pl -> pl.y() + pl.shape().height()).max().orElseThrow();
        assertTrue(maxY <= 600.1, "Expected strip length <= 600 mm, got " + maxY);
    }

    @Test
    void cooperativeCancellationStopsPromptlyWithoutConsumingInterruptFlag() throws Exception {
        NestingProblem simple = contourProblem(
                Shape.rectangle(800, 800),
                List.of(new Part(1, "L", lShape(200, 200, 80, 80), 2, true)),
                List.of(), 0.0, "deepnest", 2
        );
        Thread.currentThread().interrupt();
        try {
            assertThrows(CancellationException.class, () -> deepnestEngine.solve(simple));
            assertTrue(Thread.currentThread().isInterrupted());
        } finally {
            Thread.interrupted();
        }

        NestingProblem heavy = contourProblem(
                Shape.rectangle(5000, 5000),
                List.of(new Part(1, "L", lShape(200, 200, 80, 80), 80, true)),
                List.of(), 2.0, "deepnest", 10
        );
        AtomicReference<Throwable> outcome = new AtomicReference<>();
        Thread worker = new Thread(() -> {
            try {
                deepnestEngine.solve(heavy);
                outcome.set(new AssertionError("Expected CancellationException"));
            } catch (Throwable t) {
                outcome.set(t);
            }
        }, "deepnest-cancel-test");
        worker.setDaemon(true);
        worker.start();
        try {
            long waitDeadline = System.nanoTime() + 3_000_000_000L;
            boolean insideDeepnest = false;
            while (worker.isAlive() && System.nanoTime() < waitDeadline) {
                insideDeepnest = Arrays.stream(worker.getStackTrace())
                        .anyMatch(f -> f.getClassName().contains("Deepnest"));
                if (insideDeepnest) break;
                Thread.sleep(2);
            }
            assertTrue(insideDeepnest, "Worker must enter Deepnest computation");
            worker.interrupt();
            worker.join(1500);
            assertFalse(worker.isAlive(), "Worker must terminate promptly upon interrupt");
            assertInstanceOf(CancellationException.class, outcome.get());
        } finally {
            worker.interrupt();
            worker.join(1000);
        }
    }

    private record BenchmarkCase(String name, NestingProblem baseProblem) {}
    private record RunMetrics(String engine, int requestedCount, int placedCount,
                              double stripLengthMm, double stripUtilPct, double sheetUtilPct, long elapsedMs) {}

    @Test
    void benchmarkAndCompareDeepnestAgainstJavaHeuristicAndNativePackingSolver() {
        // Build 7 representative 2D irregular cutting benchmark problems
        Shape front = polygon(0, 640, 20, 380, 0, 220, 45, 205, 70, 170, 85, 120, 90, 55, 180, 0,
                195, 35, 220, 65, 250, 75, 280, 65, 305, 35, 320, 0, 410, 55, 415, 120, 430, 170,
                455, 205, 500, 220, 480, 380, 500, 640);
        Shape back = polygon(0, 650, 20, 380, 0, 220, 45, 205, 70, 170, 85, 120, 90, 55, 180, 0,
                210, 20, 250, 28, 290, 20, 320, 0, 410, 55, 415, 120, 430, 170, 455, 205, 500, 220,
                480, 380, 500, 650);
        Shape sleeve = polygon(0, 150, 25, 100, 65, 55, 110, 18, 160, 0, 210, 18, 255, 55, 295, 100,
                320, 150, 280, 500, 40, 500);
        Shape collar = polygon(0, 0, 340, 0, 320, 70, 20, 70);
        Shape welt = Shape.rectangle(55, 400);
        Shape pocket = polygon(0, 0, 150, 0, 150, 140, 75, 180, 0, 140);

        List<Part> shirtFixed = List.of(
                new Part(1, "M-前片", front, 1, false),
                new Part(2, "M-后片", back, 1, false),
                new Part(3, "M-袖片", sleeve, 2, false),
                new Part(4, "M-领片", collar, 1, false),
                new Part(5, "M-贴边", welt, 2, false),
                new Part(6, "M-袋布", pocket, 2, false),
                new Part(7, "L-前片", front, 1, false),
                new Part(8, "L-后片", back, 1, false),
                new Part(9, "L-袖片", sleeve, 2, false),
                new Part(10, "L-领片", collar, 1, false),
                new Part(11, "L-贴边", welt, 2, false),
                new Part(12, "L-袋布", pocket, 2, false)
        );
        List<Part> shirtHalfTurn = shirtFixed.stream()
                .map(p -> new Part(p.id(), p.name(), p.shape(), p.quantity(), false, true))
                .toList();

        Shape goredPanel = polygon(70, 0, 200, 0, 270, 650, 0, 650);
        Shape waistband = Shape.rectangle(390, 75);

        Shape pantsFront = polygon(70, 0, 350, 15, 380, 150, 390, 250, 420, 320, 340, 360,
                305, 600, 270, 1050, 70, 1050, 45, 650, 0, 310, 25, 120);
        Shape pantsBack = polygon(100, 0, 390, 20, 420, 170, 430, 270, 480, 340, 370, 390,
                330, 650, 290, 1080, 70, 1080, 45, 650, 0, 320, 30, 140);
        Shape pantsPocket = polygon(0, 0, 170, 0, 185, 130, 160, 195, 110, 230, 45, 215, 10, 160);

        List<BenchmarkCase> cases = List.of(
                new BenchmarkCase("Case1: L-Shape 4-Rot Interlock (8 pcs)",
                        contourProblem(Shape.rectangle(1000, 1200),
                                List.of(new Part(1, "L-300", lShape(300, 300, 120, 120), 8, true)),
                                List.of(), 0.0, "deepnest", 3)),
                new BenchmarkCase("Case2: Right-Tri 180-Deg Hypotenuse (12 pcs)",
                        contourProblem(Shape.rectangle(900, 1000),
                                List.of(new Part(1, "Tri-300x200", polygon(0, 0, 300, 0, 0, 200), 12, false, true)),
                                List.of(), 0.0, "deepnest", 3)),
                new BenchmarkCase("Case3: U-Frame Pocket Insert (4U + 4Core)",
                        contourProblem(Shape.rectangle(800, 700),
                                List.of(
                                        new Part(1, "U框", uFrameShape(), 4, false),
                                        new Part(2, "内芯", Shape.rectangle(180, 150), 4, false)
                                ),
                                List.of(), 0.0, "deepnest", 3)),
                new BenchmarkCase("Case4: Concave L-Sheet + Defect (14 pcs)",
                        contourProblem(polygon(0, 0, 1600, 0, 1600, 900, 1000, 900, 1000, 1600, 0, 1600),
                                List.of(
                                        new Part(1, "L形裁片", lShape(500, 500, 200, 200), 8, true),
                                        new Part(2, "三角裁片", polygon(0, 0, 400, 0, 0, 400), 6, true)
                                ),
                                List.of(new Exclusion(1, 300, 300, Shape.rectangle(120, 120), 0)),
                                0.0, "deepnest", 4)),
                new BenchmarkCase("Case5: Shirt M+L Kit (0-Deg, 5mm Gap, 18 pcs)",
                        contourProblem(Shape.rectangle(1500, 2500), shirtFixed, List.of(), 5.0, "deepnest", 4)),
                new BenchmarkCase("Case6: Shirt M+L Kit (180-Deg, 0mm Gap, 18 pcs)",
                        contourProblem(Shape.rectangle(1500, 2500), shirtHalfTurn, List.of(), 0.0, "deepnest", 4)),
                new BenchmarkCase("Case7: Gored Skirt + Jeans Mix (180-Deg, 14 pcs)",
                        contourProblem(Shape.rectangle(1500, 2200),
                                List.of(
                                        new Part(1, "梯形裙片", goredPanel, 6, false, true),
                                        new Part(2, "半腰头", waistband, 2, false, true),
                                        new Part(3, "前裤片", pantsFront, 2, false, true),
                                        new Part(4, "后裤片", pantsBack, 2, false, true),
                                        new Part(5, "裤袋", pantsPocket, 2, false, true)
                                ),
                                List.of(), 0.0, "deepnest", 4))
        );

        List<String> enginesToCompare = new ArrayList<>(List.of("javairregular", "deepnest"));
        if (nativeIrregularEngine.isAvailable()) {
            enginesToCompare.add("packingsolver-irregular");
            enginesToCompare.add("packingsolver-strip");
        }

        StringBuilder report = new StringBuilder("\n=== 2D Irregular Nesting Benchmark Report ===\n");
        report.append(String.format("%-48s | %-24s | %-7s | %-9s | %-9s | %-9s | %-7s%n",
                "Case", "Engine", "Placed", "Strip(mm)", "StripUtil", "SheetUtil", "Time(ms)"));
        report.append("-".repeat(128)).append("\n");

        int deepnestWinsOrTiesVsJava = 0;

        for (BenchmarkCase bc : cases) {
            RunMetrics javaMetrics = null;
            RunMetrics deepnestMetrics = null;

            for (String eng : enginesToCompare) {
                boolean isNativeStrip = "packingsolver-strip".equals(eng);
                if (isNativeStrip && !"RECTANGLE".equals(bc.baseProblem.material().shape().type())) {
                    continue;
                }
                String actualEngineId = isNativeStrip ? "packingsolver-irregular" : eng;
                NestingProblem p = new NestingProblem(
                        bc.baseProblem.schemaVersion(),
                        bc.baseProblem.unit(),
                        bc.baseProblem.material(),
                        bc.baseProblem.parts(),
                        bc.baseProblem.process(),
                        actualEngineId,
                        bc.baseProblem.timeLimitSeconds()
                );
                NestingResult res = isNativeStrip
                        ? solverFactory.stripSearch(p, false).orElseThrow().apply(p)
                        : solverFactory.solve(p, false);
                assertEquals("FEASIBLE", res.status(), bc.name + " [" + eng + "] failed: " + res.message());

                int reqCount = p.parts().stream().mapToInt(Part::quantity).sum();
                int placedCount = res.placements().size();
                double maxY = res.placements().stream()
                        .mapToDouble(pl -> pl.y() + pl.shape().height()).max().orElse(0.0);
                double pieceArea = res.metrics().pieceAreaMm2();
                double sheetArea = res.metrics().processingAreaMm2();
                double stripArea = "RECTANGLE".equals(p.material().shape().type())
                        ? Math.max(1.0, p.width() * maxY)
                        : sheetArea;
                double stripUtil = (pieceArea / stripArea) * 100.0;
                double sheetUtil = (pieceArea / sheetArea) * 100.0;

                RunMetrics rm = new RunMetrics(eng, reqCount, placedCount, maxY, stripUtil, sheetUtil, res.elapsedMs());
                if ("javairregular".equals(eng)) javaMetrics = rm;
                if ("deepnest".equals(eng)) deepnestMetrics = rm;

                report.append(String.format("%-48s | %-24s | %3d/%-3d | %9.1f | %8.2f%% | %8.2f%% | %6dms%n",
                        bc.name, eng, placedCount, reqCount, maxY, stripUtil, sheetUtil, res.elapsedMs()));
            }
            report.append("-".repeat(128)).append("\n");

            assertNotNull(deepnestMetrics);
            assertNotNull(javaMetrics);
            // Deepnest must place at least as many pieces as JavaIrregular on concave/interlocking cases
            assertTrue(deepnestMetrics.placedCount() >= javaMetrics.placedCount(),
                    "Deepnest placed fewer pieces on " + bc.name);
            if (deepnestMetrics.placedCount() > javaMetrics.placedCount()
                    || deepnestMetrics.stripLengthMm() <= javaMetrics.stripLengthMm() + 1.0) {
                deepnestWinsOrTiesVsJava++;
            }
        }

        System.out.println(report);
        assertTrue(deepnestWinsOrTiesVsJava >= 6,
                "Deepnest NFP+GA should outperform or match AABB skyline heuristic across benchmark suite, got "
                        + deepnestWinsOrTiesVsJava + "/" + cases.size());
    }
}
