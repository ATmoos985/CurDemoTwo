package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.geometry.NestingValidation;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Exclusion;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Material;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Part;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.PartRule;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import tools.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.locationtech.jts.geom.Geometry;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase 4C 专项测试：
 * <ol>
 *   <li>JTS 高精度 Outer NFP / 对称反演 / Inner NFP / 精确偏移（BufferOp）几何正确性与并发线程安全；</li>
 *   <li>任意离散角度集（{@code PartRule.allowedAnglesDeg}，如 15°/30°/45°）的输入校验、旋转归一化、
 *       {@code deepnest} 与 {@code javairregular} 求解质量及零容忍终检；</li>
 *   <li>旧请求 JSON 序列化与 {@code contourAngles()} 100% 向后兼容。</li>
 * </ol>
 */
class Phase4cJtsAndArbitraryAnglesTests {

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

    private static NestingProblem contourProblem(Shape material, List<Part> parts, List<Exclusion> exclusions,
                                                 double pieceGap, String engine, int timeLimitSeconds) {
        return new NestingProblem(
                "1", "mm",
                new Material("phase4c-mat", material, exclusions, false),
                parts,
                new NestingProblem.Process("CONTOUR", "SHEET", "left-top", "none",
                        0, 0, 0, 0, "MAXIMIZE_PIECE_AREA", pieceGap),
                engine, timeLimitSeconds
        );
    }

    @Test
    void jtsOuterNfpSymmetryInnerNfpAndBufferPrecisionAreAccurate() {
        Shape lShape = polygon(0, 0, 220, 0, 220, 90, 90, 90, 90, 220, 0, 220);
        Shape trap = polygon(20, 0, 180, 0, 200, 120, 0, 120);
        List<List<Point>> convL = DeepnestNfpGeometry.decomposeConvex(lShape);
        List<List<Point>> convT = DeepnestNfpGeometry.decomposeConvex(trap);

        for (double gap : new double[]{0.0, 6.0}) {
            Geometry nfpLT = DeepnestNfpGeometry.computeOuterNfpGeom(lShape, convL, trap, convT, gap);
            Geometry nfpTL = DeepnestNfpGeometry.computeOuterNfpGeom(trap, convT, lShape, convL, gap);
            Geometry invLT = DeepnestNfpGeometry.invertGeometry(nfpLT);

            assertFalse(nfpLT.isEmpty());
            assertTrue(nfpLT.isValid(), "JTS Outer NFP 必须拓扑合法");
            assertTrue(nfpTL.isValid(), "JTS 反向 Outer NFP 必须拓扑合法");
            double symDiffArea = nfpTL.symDifference(invLT).getArea();
            assertTrue(symDiffArea < 1e-3,
                    "JTS OuterNFP(B, A) 与 invert(OuterNFP(A, B)) 在 gap=" + gap + " 下应对称等价，差面积=" + symDiffArea);
        }

        // 验证 JTS BufferOp 精确外扩消除旧版 16 边形 1.0196x 过膨胀，同时严格满足最小欧氏距离
        Shape sq = Shape.rectangle(100, 100);
        double r = 10.0;
        Geometry buffered = DeepnestNfpGeometry.bufferPrecise(
                DeepnestNfpGeometry.toJtsPolygon(sq, 0, 0), r, 0.0);
        assertTrue(buffered.isValid());
        // 理论圆角矩形面积 = 100*100 + 4*100*10 + pi*10^2 ≈ 14314.159
        double exactArea = 100.0 * 100.0 + 4.0 * 100.0 * r + Math.PI * r * r;
        double actualArea = buffered.getArea();
        // 32 段外接近似面积应略高于精确圆面积（保证不欠扩），且超额比例 < 0.6%
        assertTrue(actualArea >= exactArea - 1e-2, "外扩面积不应小于精确圆角面积: " + actualArea);
        assertTrue(actualArea <= exactArea * 1.006, "JTS BufferOp 过膨胀应控制在 0.6% 以内，实际=" + actualArea);

        // 验证凹板材 + 禁入区的 Inner NFP 拓扑合法且精确剔除禁入区
        Shape concaveSheet = polygon(0, 0, 500, 0, 500, 250, 260, 250, 260, 500, 0, 500);
        Exclusion exc = new Exclusion(1, 100, 100, Shape.rectangle(60, 60), 10.0);
        Shape smallRect = Shape.rectangle(80, 60);
        Geometry ifp = DeepnestNfpGeometry.computeInnerNfpGeom(
                concaveSheet, List.of(exc), smallRect, DeepnestNfpGeometry.decomposeConvex(smallRect));
        assertFalse(ifp.isEmpty());
        assertTrue(ifp.isValid(), "JTS Inner NFP 必须拓扑合法");
        assertFalse(DeepnestNfpGeometry.extractRings(ifp).isEmpty());
    }

    @Test
    void jtsOuterNfpCacheIsThreadSafeUnderConcurrentSymmetricAccess() throws Exception {
        DeepnestNfpGeometry.clearOuterNfpCache();
        List<Shape> shapes = List.of(
                polygon(0, 0, 200, 0, 200, 80, 80, 80, 80, 200, 0, 200),
                polygon(0, 0, 180, 0, 140, 110, 20, 110),
                PolygonGeometry.rotate(polygon(0, 0, 160, 0, 0, 160), 45),
                PolygonGeometry.rotate(Shape.rectangle(140, 70), 30)
        );
        List<List<List<Point>>> convexList = shapes.stream().map(DeepnestNfpGeometry::decomposeConvex).toList();
        List<DeepnestNfpGeometry.ShapeSignature> sigs = shapes.stream().map(DeepnestNfpGeometry.ShapeSignature::of).toList();

        ExecutorService pool = Executors.newFixedThreadPool(8);
        try {
            List<Callable<Double>> tasks = new ArrayList<>();
            for (int t = 0; t < 16; t++) {
                final int threadIdx = t;
                tasks.add(() -> {
                    double totalArea = 0.0;
                    for (int i = 0; i < shapes.size(); i++) {
                        for (int j = 0; j < shapes.size(); j++) {
                            int a = (threadIdx % 2 == 0) ? i : j;
                            int b = (threadIdx % 2 == 0) ? j : i;
                            Geometry nfp = DeepnestNfpGeometry.getOrComputeOuterNfpGeom(
                                    shapes.get(a), convexList.get(a), sigs.get(a),
                                    shapes.get(b), convexList.get(b), sigs.get(b),
                                    4.0
                            );
                            assertFalse(nfp.isEmpty());
                            assertTrue(nfp.isValid());
                            totalArea += nfp.getArea();
                        }
                    }
                    return totalArea;
                });
            }
            List<Future<Double>> futures = pool.invokeAll(tasks);
            double ref = futures.get(0).get();
            for (Future<Double> f : futures) {
                assertEquals(ref, f.get(), 1e-3, "并发线程计算得到的 Outer NFP 总面积必须完全一致");
            }
            assertTrue(DeepnestNfpGeometry.outerNfpCacheSize() <= DeepnestNfpGeometry.MAX_OUTER_NFP_CACHE_SIZE);
            assertTrue(DeepnestNfpGeometry.outerNfpCacheHits() > 0);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void arbitraryRotationPreservesAreaNormalizesBoundsAndValidatesRules() {
        Shape rect = Shape.rectangle(160, 80);
        Shape tri = polygon(0, 0, 140, 0, 0, 140);

        for (int deg : new int[]{0, 15, 30, 45, 90, 135, 180, 225, 270, 315}) {
            Shape rotRect = PolygonGeometry.rotate(rect, deg);
            PolygonGeometry.validate(rotRect);
            assertEquals(PolygonGeometry.area(rect), PolygonGeometry.area(rotRect), 1e-4,
                    "矩形旋转 " + deg + "° 后面积必须精确守恒");
            if (deg % 90 == 0) {
                assertEquals("RECTANGLE", rotRect.type());
            } else {
                assertEquals("POLYGON", rotRect.type());
            }

            Shape rotTri = PolygonGeometry.rotate(tri, deg);
            PolygonGeometry.validate(rotTri);
            assertEquals(PolygonGeometry.area(tri), PolygonGeometry.area(rotTri), 1e-4,
                    "三角形旋转 " + deg + "° 后面积必须精确守恒");
        }

        // 验证 PartRule.allowedAnglesDeg 合法性拦截
        NestingProblem invalidNeg = contourProblem(
                Shape.rectangle(500, 500),
                List.of(new Part(1, "p", tri, 1, false, null, new PartRule(null, null, null, null, List.of(0, -15)))),
                List.of(), 0.0, "deepnest", 2);
        assertThrows(NestingValidation.Rejected.class, () -> NestingValidation.validate(invalidNeg));

        NestingProblem invalidHigh = contourProblem(
                Shape.rectangle(500, 500),
                List.of(new Part(1, "p", tri, 1, false, null, new PartRule(null, null, null, null, List.of(0, 360)))),
                List.of(), 0.0, "deepnest", 2);
        assertThrows(NestingValidation.Rejected.class, () -> NestingValidation.validate(invalidHigh));

        NestingProblem invalidEmpty = contourProblem(
                Shape.rectangle(500, 500),
                List.of(new Part(1, "p", tri, 1, false, null, new PartRule(null, null, null, null, List.of()))),
                List.of(), 0.0, "deepnest", 2);
        assertThrows(NestingValidation.Rejected.class, () -> NestingValidation.validate(invalidEmpty));

        NestingProblem invalidNullElem = contourProblem(
                Shape.rectangle(500, 500),
                List.of(new Part(1, "p", tri, 1, false, null, new PartRule(null, null, null, null, Arrays.asList(0, null)))),
                List.of(), 0.0, "deepnest", 2);
        assertThrows(NestingValidation.Rejected.class, () -> NestingValidation.validate(invalidNullElem));

        NestingProblem invalidGuillotine = new NestingProblem(
                "1", "mm",
                new Material("m", Shape.rectangle(500, 500), List.of(), false),
                List.of(new Part(1, "p", Shape.rectangle(100, 100), 1, false, null,
                        new PartRule(null, null, null, null, List.of(0, 45)))),
                new NestingProblem.Process("GUILLOTINE", "SHEET", "left-top", "horizontal",
                        0, 0, 0, 0, "MAXIMIZE_PIECE_AREA", 0.0),
                "javaguillotine", 2);
        assertThrows(NestingValidation.Rejected.class, () -> NestingValidation.validate(invalidGuillotine));
    }

    @Test
    void arbitraryAngles45And15And30SolveAndPassZeroToleranceValidatorInBothEngines() {
        // 1. 等腰直角三角形在 45°/225° 旋转下斜边变为水平，高度从 141.4 变为 100，刚好两件对拼进 290x150 狭窄板材！
        // 在仅允许 0/90/180/270 时，141.4x141.4 的外接框（直角边=141.4）无法横着摆两件进宽 290、高 110 的板材，
        // 而旋转 45° 后底边=200、高=100，45° 与 225° 斜边互锁可完美装入！
        Shape isoRightTri = polygon(0, 0, 140, 0, 0, 140);
        PartRule angles45 = new PartRule(null, null, null, null, List.of(45, 225));
        Part triPart = new Part(1, "iso-tri-45", isoRightTri, 2, false, null, angles45);
        assertEquals(List.of(45, 225), triPart.contourAngles());

        // 旋转 45° 后宽度 ≈ 197.99, 高度 ≈ 98.995：
        // 1a) 在 310 x 110 超窄板材上（两件并排外接框宽 396 > 310），deepnest 必须依靠精确 JTS NFP 实现 45°/225° 斜边互锁装入 2/2 件
        Shape ultraNarrowSheet = Shape.rectangle(310, 110);
        // 1b) 在 420 x 110 窄板材上（0°/90°/180°/270° 高度均为 140 > 110，绝对放不下），deepnest 与 javairregular 均须利用 45°/225° 装入 2/2 件
        Shape narrowSheet = Shape.rectangle(420, 110);

        DeepnestSolverEngine deepnest = new DeepnestSolverEngine();
        JavaIrregularSolverEngine javaIrreg = new JavaIrregularSolverEngine();
        SolverFactory factory = new SolverFactory(List.of(deepnest, javaIrreg));

        NestingProblem p45Interlock = contourProblem(ultraNarrowSheet, List.of(triPart), List.of(), 0.0, "deepnest", 3);
        NestingResult resInterlock = factory.solve(p45Interlock);
        assertEquals("FEASIBLE", resInterlock.status(), "deepnest 应完成 45°/225° 斜边互锁: " + resInterlock.message());
        assertEquals(2, resInterlock.placements().size(), "deepnest 应通过 45°/225° 斜边互锁放入全部 2 件三角形");
        assertEquals(Set.of(45, 225), resInterlock.placements().stream()
                .map(NestingResult.Placement::rotationDegrees).collect(Collectors.toSet()));
        EngineResult interlockCheck = new EngineResult();
        interlockCheck.setSuccess(true);
        interlockCheck.setPlacements(resInterlock.placements());
        assertNull(PolygonResultValidator.validate(p45Interlock, interlockCheck));

        for (String engine : List.of("deepnest", "javairregular")) {
            NestingProblem p45 = contourProblem(narrowSheet, List.of(triPart), List.of(), 0.0, engine, 3);
            NestingResult res = factory.solve(p45);
            assertEquals("FEASIBLE", res.status(), engine + " 应成功求解 45°/225° 场景: " + res.message());
            assertEquals(2, res.placements().size(), engine + " 应放入全部 2 件 45°/225° 三角形");
            Set<Integer> usedAngles = res.placements().stream()
                    .map(NestingResult.Placement::rotationDegrees)
                    .collect(Collectors.toSet());
            assertTrue(Set.of(45, 225).containsAll(usedAngles), engine + " 使用的角度必须在允许集合内: " + usedAngles);

            EngineResult check = new EngineResult();
            check.setSuccess(true);
            check.setPlacements(res.placements());
            assertNull(PolygonResultValidator.validate(p45, check),
                    engine + " 的 45° 排样结果必须零容忍通过 PolygonResultValidator");
        }

        // 2. 15°/30° 离散角度集 + 菱形/梯形 + pieceGap > 0 综合验真
        Shape diamond = polygon(60, 0, 120, 45, 60, 90, 0, 45);
        Shape trap = polygon(25, 0, 155, 0, 180, 90, 0, 90);
        List<Part> mixedParts = List.of(
                new Part(1, "diamond-15", diamond, 3, false, null,
                        new PartRule(null, null, null, null, List.of(0, 15, 30, 45))),
                new Part(2, "trap-30", trap, 2, false, null,
                        new PartRule(null, null, null, null, List.of(0, 30, 180, 210)))
        );
        for (String engine : List.of("deepnest", "javairregular")) {
            NestingProblem pMixed = contourProblem(Shape.rectangle(520, 420), mixedParts, List.of(), 4.0, engine, 3);
            NestingResult res = factory.solve(pMixed);
            assertEquals("FEASIBLE", res.status(), engine + " 应成功求解 15°/30° 混合场景: " + res.message());
            assertEquals(5, res.placements().size(), engine + " 应放入全部 5 件裁片");

            EngineResult check = new EngineResult();
            check.setSuccess(true);
            check.setPlacements(res.placements());
            assertNull(PolygonResultValidator.validate(pMixed, check),
                    engine + " 的 15°/30° + pieceGap 排样结果必须零容忍通过校验");
        }
    }

    @Test
    void legacyProblemJsonSerializationRemains100PercentBackwardCompatible() throws Exception {
        ObjectMapper mapper = new ObjectMapper();

        Part legacyPartNoRule = new Part(1, "L", polygon(0, 0, 100, 0, 100, 40, 40, 40, 40, 100, 0, 100), 2, true);
        Part legacyPart4ArgRule = new Part(2, "Main", Shape.rectangle(100, 80), 1, false, true,
                new PartRule("MAIN", true, 10.0, 1.0));

        assertEquals(List.of(0, 90, 180, 270), legacyPartNoRule.contourAngles());
        assertEquals(List.of(0, 180), legacyPart4ArgRule.contourAngles());

        NestingProblem legacyProblem = contourProblem(
                Shape.rectangle(600, 600),
                List.of(legacyPartNoRule, legacyPart4ArgRule),
                List.of(), 0.0, "deepnest", 2
        );

        String json = mapper.writeValueAsString(legacyProblem);
        assertFalse(json.contains("allowedAnglesDeg"),
                "未设置 allowedAnglesDeg 时，序列化 JSON 不得包含该字段以保证 inputHash 100% 兼容: " + json);

        NestingProblem roundTrip = mapper.readValue(json, NestingProblem.class);
        assertEquals(legacyProblem, roundTrip);
        assertNull(roundTrip.parts().get(1).rule().allowedAnglesDeg());
        assertEquals(List.of(0, 180), roundTrip.parts().get(1).contourAngles());
    }

    @Test
    void fastSlowDualTrackBooleanOpsAndEnvelopePruningAreExact() {
        Geometry r1 = DeepnestNfpGeometry.rectGeometry(0, 0, 100, 100);
        Geometry r2Disjoint = DeepnestNfpGeometry.rectGeometry(300, 0, 100, 100);
        Geometry r3Overlap = DeepnestNfpGeometry.rectGeometry(50, 0, 100, 100);

        // 1. 外接框严格不相交：O(1) 直拼 MultiPolygon，拓扑合法且面积精确等于两者之和
        Geometry disjointUnion = DeepnestNfpGeometry.unionTwoGeometries(r1, r2Disjoint);
        assertTrue(disjointUnion.isValid(), "不相交直拼结果必须拓扑合法");
        assertEquals(20000.0, disjointUnion.getArea(), 1e-6);

        // 2. 外接框相交：快轨 OverlayNG 并集面积精确
        Geometry overlapUnion = DeepnestNfpGeometry.unionTwoGeometries(r1, r3Overlap);
        assertTrue(overlapUnion.isValid(), "相交并集结果必须拓扑合法");
        assertEquals(15000.0, overlapUnion.getArea(), 1e-6);

        // 3. MultiPolygon 子分量预筛差集：仅 r1 与 target 相交，r2Disjoint 被跳过，结果精确等于 50x100
        Geometry target = DeepnestNfpGeometry.rectGeometry(50, 0, 100, 100);
        Geometry diff = DeepnestNfpGeometry.differenceGeometry(target, disjointUnion);
        assertTrue(diff.isValid(), "MultiPolygon 预筛差集结果必须拓扑合法");
        assertEquals(5000.0, diff.getArea(), 1e-6);

        // 4. 零分配平移外接框相交预判
        assertTrue(DeepnestNfpGeometry.translatedEnvelopeIntersects(r1, 80, 0, target.getEnvelopeInternal()));
        assertFalse(DeepnestNfpGeometry.translatedEnvelopeIntersects(r1, 200, 0, target.getEnvelopeInternal()));
    }
}
