package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Exclusion;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Material;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Part;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import org.junit.jupiter.api.Test;

import java.awt.geom.Area;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase 2 二维异形提速提质专项验真测试：
 * <ol>
 *   <li>Outer NFP 中心反演对称性几何等价与缓存命中；</li>
 *   <li>跨求解会话（含 STRIP_SEARCH 试算）有界 LRU Outer NFP 缓存复用；</li>
 *   <li>压紧器（MarkerCompactor &amp; AxisMarkerCompactor）支持 {@code pieceGap > 0}（含斜边欧氏间距）；</li>
 *   <li>AxisMarkerCompactor 支持带疵点（固定障碍节点）压紧且零侵入；</li>
 *   <li>有界并行求解的确定性与协作取消传播。</li>
 * </ol>
 */
class Phase2IrregularOptimizationTests {

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

    private static Shape denseRect(double w, double h) {
        // 50 vertices (> 48) so MarkerCompactor delegates to AxisMarkerCompactor
        List<Point> pts = new ArrayList<>(50);
        for (int i = 0; i <= 24; i++) pts.add(new Point(w * i / 24.0, 0.0));
        for (int i = 24; i >= 0; i--) pts.add(new Point(w * i / 24.0, h));
        return new Shape("POLYGON", w, h, pts);
    }

    private static NestingProblem contourProblem(double matW, double matH, List<Part> parts,
                                                 List<Exclusion> exclusions, double pieceGap,
                                                 String engine, int timeLimitSeconds) {
        return new NestingProblem(
                "1", "mm",
                new Material("phase2-mat", Shape.rectangle(matW, matH), exclusions, false),
                parts,
                new NestingProblem.Process("CONTOUR", "SHEET", "left-top", "none",
                        0, 0, 0, 0, "MAXIMIZE_PIECE_AREA", pieceGap),
                engine, timeLimitSeconds
        );
    }

    private static double markerLength(List<Placement> placements) {
        return placements.stream().mapToDouble(p -> p.y() + p.shape().height()).max().orElse(0.0);
    }

    @Test
    void outerNfpSymmetryInversionIsGeometricallyEquivalentAndHitsCache() {
        Shape lShape = polygon(0, 0, 220, 0, 220, 90, 90, 90, 90, 220, 0, 220);
        Shape trapezoid = polygon(20, 0, 180, 0, 200, 120, 0, 120);
        Shape uShape = polygon(0, 0, 60, 0, 60, 140, 200, 140, 200, 0, 260, 0, 260, 220, 0, 220);
        Shape wedge = polygon(0, 0, 140, 30, 40, 110);

        List<Shape[]> pairs = List.of(
                new Shape[]{lShape, trapezoid},
                new Shape[]{uShape, wedge}
        );

        for (double gap : new double[]{0.0, 8.0}) {
            for (Shape[] pair : pairs) {
                Shape a = pair[0];
                Shape b = pair[1];
                List<List<Point>> convA = DeepnestNfpGeometry.decomposeConvex(a);
                List<List<Point>> convB = DeepnestNfpGeometry.decomposeConvex(b);

                Area directBA = DeepnestNfpGeometry.computeOuterNfp(b, convB, a, convA, gap);
                Area directAB = DeepnestNfpGeometry.computeOuterNfp(a, convA, b, convB, gap);
                Area invertedAB = DeepnestNfpGeometry.invertArea(directAB);

                Area diff = new Area(directBA);
                diff.exclusiveOr(invertedAB);
                double diffArea = PolygonGeometry.area(diff);
                assertTrue(diffArea < 1e-3,
                        "OuterNFP(B, A) 与 invert(OuterNFP(A, B)) 在 gap=" + gap + " 下应几何等价，差异面积=" + diffArea);
            }
        }

        // 验证 LRU 缓存通过对称反演命中，不再重复计算 (B, A)
        DeepnestNfpGeometry.clearOuterNfpCache();
        List<List<Point>> convL = DeepnestNfpGeometry.decomposeConvex(lShape);
        List<List<Point>> convT = DeepnestNfpGeometry.decomposeConvex(trapezoid);
        var sigL = DeepnestNfpGeometry.ShapeSignature.of(lShape);
        var sigT = DeepnestNfpGeometry.ShapeSignature.of(trapezoid);

        // 先查字典序较小方向，再查反方向
        Shape first = sigL.compareTo(sigT) <= 0 ? lShape : trapezoid;
        List<List<Point>> convFirst = first == lShape ? convL : convT;
        var sigFirst = first == lShape ? sigL : sigT;
        Shape second = first == lShape ? trapezoid : lShape;
        List<List<Point>> convSecond = second == lShape ? convL : convT;
        var sigSecond = second == lShape ? sigL : sigT;

        DeepnestNfpGeometry.getOrComputeOuterNfp(first, convFirst, sigFirst, second, convSecond, sigSecond, 5.0);
        long missesAfterFirst = DeepnestNfpGeometry.outerNfpCacheMisses();
        assertEquals(1L, missesAfterFirst);

        Area reversed = DeepnestNfpGeometry.getOrComputeOuterNfp(
                second, convSecond, sigSecond, first, convFirst, sigFirst, 5.0);
        assertFalse(reversed.isEmpty());
        assertEquals(1L, DeepnestNfpGeometry.outerNfpCacheMisses(), "反向查询必须命中对称缓存，不得重算");
        assertEquals(1L, DeepnestNfpGeometry.outerNfpSymmetryHits(), "反向查询应记录对称反演命中");
    }

    @Test
    void crossSessionLruOuterNfpCacheReusesAcrossStripSearchRuns() {
        DeepnestNfpGeometry.clearOuterNfpCache();
        Shape lShape = polygon(0, 0, 260, 0, 260, 100, 100, 100, 100, 260, 0, 260);
        Shape tri = polygon(0, 0, 200, 0, 0, 150);
        List<Part> parts = List.of(
                new Part(1, "L", lShape, 3, true),
                new Part(2, "T", tri, 3, true)
        );

        DeepnestSolverEngine engine = new DeepnestSolverEngine();
        NestingProblem run1 = contourProblem(900, 1200, parts, List.of(), 4.0, "deepnest", 2);
        EngineResult res1 = engine.solveStripCandidate(run1);
        assertTrue(res1.isSuccess());
        assertNull(PolygonResultValidator.validate(run1, res1));

        long missesAfterRun1 = DeepnestNfpGeometry.outerNfpCacheMisses();
        long hitsBeforeRun2 = DeepnestNfpGeometry.outerNfpCacheHits();
        assertTrue(missesAfterRun1 > 0, "首次求解应填充 Outer NFP 缓存");

        // 第二次不同板长的 STRIP_SEARCH 试算应跨会话命中缓存
        NestingProblem run2 = contourProblem(900, 1000, parts, List.of(), 4.0, "deepnest", 2);
        EngineResult res2 = engine.solveStripCandidate(run2);
        assertTrue(res2.isSuccess());
        assertNull(PolygonResultValidator.validate(run2, res2));

        assertEquals(missesAfterRun1, DeepnestNfpGeometry.outerNfpCacheMisses(),
                "相同裁片集合的第二次试算不应再产生新的 Outer NFP 缓存未命中");
        assertTrue(DeepnestNfpGeometry.outerNfpCacheHits() > hitsBeforeRun2,
                "第二次试算应产生跨会话缓存命中");
        assertTrue(DeepnestNfpGeometry.outerNfpCacheSize() <= DeepnestNfpGeometry.MAX_OUTER_NFP_CACHE_SIZE);
    }

    @Test
    void markerCompactorSupportsPieceGapWithSlopingEdgesAndPassesValidator() {
        // 斜边直角三角形，180° 互锁后在 pieceGap = 10mm 下必须保持欧氏法向间距 >= 10mm
        Shape tri = polygon(0, 0, 100, 0, 0, 100);
        Part part = new Part(1, "tri", tri, 2, false, true);
        NestingProblem problem = contourProblem(160, 300, List.of(part), List.of(), 10.0, "deepnest", 3);

        List<Placement> looseSeed = List.of(
                new Placement(1, 1, "tri", 0, 0, tri, 0),
                new Placement(2, 1, "tri", 0, 150, tri, 0)
        );
        assertTrue(MarkerCompactor.supports(problem, looseSeed));
        assertTrue(MarkerCompactor.supportsGapSearch(problem));

        List<Placement> compacted = MarkerCompactor.compact(problem, looseSeed, System.nanoTime() + 2_000_000_000L);
        assertTrue(markerLength(compacted) < markerLength(looseSeed) - 10.0,
                "带 pieceGap=10mm 压紧后长度应显著缩短，原长=" + markerLength(looseSeed) + ", 压紧后=" + markerLength(compacted));

        EngineResult check = new EngineResult();
        check.setSuccess(true);
        check.setPlacements(compacted);
        assertNull(PolygonResultValidator.validate(problem, check),
                "带 pieceGap=10mm 斜边压紧结果必须严格通过 PolygonResultValidator");
    }

    @Test
    void axisMarkerCompactorSupportsPieceGapAndDefectsAsLockedObstacles() {
        Shape dense = denseRect(40, 20);
        // 放置一个带 5mm 安全边距的疵点：位于 x=[0..40], y=[30..50]，外扩后占据 [-5..45] x [25..55]
        Exclusion defect = new Exclusion(1, 0, 30, Shape.rectangle(40, 20), 5.0);
        Part part = new Part(1, "dense-panel", dense, 3, false);
        NestingProblem problem = contourProblem(120, 200, List.of(part), List.of(defect), 6.0, "deepnest", 3);

        // 顶点数 50 > 48，强制进入 AxisMarkerCompactor 路径
        assertFalse(MarkerCompactor.supportsGapSearch(problem));
        assertTrue(AxisMarkerCompactor.supports(problem));

        // 裁片1 在疵点上方 [0,0]..[40,20]；裁片2 在疵点下方留空 [0,90]..[40,110]；裁片3 在右侧无疵点列 [60,80]..[100,100]
        List<Placement> seed = List.of(
                new Placement(1, 1, "dense-panel", 0, 0, dense, 0),
                new Placement(2, 1, "dense-panel", 0, 90, dense, 0),
                new Placement(3, 1, "dense-panel", 60, 80, dense, 0)
        );
        EngineResult seedCheck = new EngineResult();
        seedCheck.setSuccess(true);
        seedCheck.setPlacements(seed);
        assertNull(PolygonResultValidator.validate(problem, seedCheck), "初始种子方案应合法");

        List<Placement> compacted = MarkerCompactor.compact(problem, seed, System.nanoTime() + 2_000_000_000L);
        assertTrue(markerLength(compacted) < markerLength(seed) - 20.0,
                "带疵点+pieceGap 场景下 AxisMarkerCompactor 应显著缩短总长，原长="
                        + markerLength(seed) + ", 压紧后=" + markerLength(compacted));

        // 裁片3 所在列无疵点，应能压紧到 y=0 附近
        Placement piece3 = compacted.stream().filter(p -> p.id() == 3).findFirst().orElseThrow();
        assertTrue(piece3.y() <= 1e-4, "右侧无疵点列的裁片3 应压紧至 y=0，实际 y=" + piece3.y());

        EngineResult check = new EngineResult();
        check.setSuccess(true);
        check.setPlacements(compacted);
        assertNull(PolygonResultValidator.validate(problem, check),
                "带疵点+pieceGap 的 AxisMarkerCompactor 结果必须严格通过 PolygonResultValidator");

        // 全幅宽疵点（无法水平绕开）应严格将下方裁片挡在疵点外扩下沿 y = 55 处
        Exclusion fullWidthDefect = new Exclusion(1, 0, 30, Shape.rectangle(120, 20), 5.0);
        NestingProblem blockedProblem = contourProblem(
                120, 200, List.of(new Part(1, "dense-panel", dense, 2, false)),
                List.of(fullWidthDefect), 6.0, "deepnest", 3);
        List<Placement> blockedSeed = List.of(
                new Placement(1, 1, "dense-panel", 0, 0, dense, 0),
                new Placement(2, 1, "dense-panel", 0, 100, dense, 0)
        );
        List<Placement> blockedCompacted = MarkerCompactor.compact(
                blockedProblem, blockedSeed, System.nanoTime() + 2_000_000_000L);
        Placement blockedPiece2 = blockedCompacted.stream().filter(p -> p.id() == 2).findFirst().orElseThrow();
        assertEquals(55.0, blockedPiece2.y(), 1e-3, "全幅宽疵点应严格将裁片2 挡在安全外扩下沿 y=55");
        EngineResult blockedCheck = new EngineResult();
        blockedCheck.setSuccess(true);
        blockedCheck.setPlacements(blockedCompacted);
        assertNull(PolygonResultValidator.validate(blockedProblem, blockedCheck));
    }

    @Test
    void parallelEvaluationIsDeterministicAcrossRepeatedRuns() {
        Shape lShape = polygon(0, 0, 220, 0, 220, 90, 90, 90, 90, 220, 0, 220);
        Shape tri = polygon(0, 0, 180, 0, 0, 140);
        List<Part> parts = List.of(
                new Part(1, "L", lShape, 3, true),
                new Part(2, "T", tri, 3, false, true)
        );

        // 1. Deepnest 并行个体评估确定性
        DeepnestSolverEngine deepnest = new DeepnestSolverEngine();
        NestingProblem dp = contourProblem(900, 900, parts, List.of(), 5.0, "deepnest", 5);
        EngineResult d1 = deepnest.solve(dp);
        EngineResult d2 = deepnest.solve(dp);
        assertTrue(d1.isSuccess() && d2.isSuccess());
        assertNull(PolygonResultValidator.validate(dp, d1));
        assertEquals(d1.getPlacements().size(), d2.getPlacements().size());
        for (int i = 0; i < d1.getPlacements().size(); i++) {
            Placement p1 = d1.getPlacements().get(i);
            Placement p2 = d2.getPlacements().get(i);
            assertEquals(p1.demandId(), p2.demandId());
            assertEquals(p1.rotationDegrees(), p2.rotationDegrees());
            assertEquals(p1.x(), p2.x(), 1e-6);
            assertEquals(p1.y(), p2.y(), 1e-6);
        }

        // 2. JavaIrregular 4 趟并行策略确定性
        JavaIrregularSolverEngine javaIrregular = new JavaIrregularSolverEngine();
        NestingProblem jp = contourProblem(900, 900, parts, List.of(), 5.0, "javairregular", 5);
        EngineResult j1 = javaIrregular.solve(jp);
        EngineResult j2 = javaIrregular.solve(jp);
        assertTrue(j1.isSuccess() && j2.isSuccess());
        assertNull(PolygonResultValidator.validate(jp, j1));
        assertEquals(j1.getPlacements().size(), j2.getPlacements().size());
        for (int i = 0; i < j1.getPlacements().size(); i++) {
            Placement p1 = j1.getPlacements().get(i);
            Placement p2 = j2.getPlacements().get(i);
            assertEquals(p1.demandId(), p2.demandId());
            assertEquals(p1.rotationDegrees(), p2.rotationDegrees());
            assertEquals(p1.x(), p2.x(), 1e-6);
            assertEquals(p1.y(), p2.y(), 1e-6);
        }
    }

    @Test
    void parallelEvaluationPropagatesCooperativeCancellation() throws Exception {
        NestingProblem heavy = contourProblem(
                4000, 4000,
                List.of(new Part(1, "L", polygon(0, 0, 200, 0, 200, 80, 80, 80, 80, 200, 0, 200), 60, true)),
                List.of(), 3.0, "deepnest", 10
        );
        AtomicReference<Throwable> outcome = new AtomicReference<>();
        AtomicReference<Boolean> interruptPreserved = new AtomicReference<>(false);
        Thread worker = new Thread(() -> {
            try {
                new DeepnestSolverEngine().solve(heavy);
                outcome.set(new AssertionError("Expected CancellationException"));
            } catch (Throwable t) {
                outcome.set(t);
                interruptPreserved.set(Thread.currentThread().isInterrupted());
            }
        }, "phase2-parallel-cancel-test");
        worker.setDaemon(true);
        worker.start();
        try {
            Thread.sleep(40);
            worker.interrupt();
            worker.join(2000);
            assertFalse(worker.isAlive(), "并行求解应在收到中断后迅速终止");
            assertInstanceOf(CancellationException.class, outcome.get());
            assertTrue(interruptPreserved.get(), "取消传播不得吞掉调用线程中断标志");
        } finally {
            worker.interrupt();
            worker.join(1000);
        }
    }
}
