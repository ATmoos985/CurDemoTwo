package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.geometry.NestingValidation;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.FabricRule;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Material;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Part;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Process;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 第三波专项验收测试（二）：
 * <ul>
 *   <li>Shape.holes 拓扑合法性校验（内环顶点数、非自交、严格内含、孔间不交不互含、矩形直刀拒收）；</li>
 *   <li>孔洞内套料（Hole Nesting）：pieceGap=0 与 pieceGap>0 下将小件合法嵌套进母件内孔，以及独立校验器拦截孔壁间距不足；</li>
 *   <li>U/C 形深凹轮廓 JTS 负 Buffer 微缩修复（无自交、合法凹料头排料）；</li>
 *   <li>纯布边禁区放宽进入分区求解与阶段 3 联动压紧。</li>
 * </ul>
 */
class Wave3HoleNestingAndConcaveShrinkTests {

    private static List<Point> rectRing(double x, double y, double w, double h) {
        return List.of(
                new Point(x, y),
                new Point(x + w, y),
                new Point(x + w, y + h),
                new Point(x, y + h)
        );
    }

    private static Shape frameWithHole(double outerW, double outerH, double hx, double hy, double hw, double hh) {
        return new Shape("POLYGON", outerW, outerH,
                rectRing(0, 0, outerW, outerH),
                List.of(rectRing(hx, hy, hw, hh)));
    }

    private static Shape deepUShape(double w, double h, double wallThickness, double bottomThickness) {
        return new Shape("POLYGON", w, h, List.of(
                new Point(0, 0),
                new Point(wallThickness, 0),
                new Point(wallThickness, h - bottomThickness),
                new Point(w - wallThickness, h - bottomThickness),
                new Point(w - wallThickness, 0),
                new Point(w, 0),
                new Point(w, h),
                new Point(0, h)
        ));
    }

    private static Shape deepCShape(double w, double h, double wall) {
        return new Shape("POLYGON", w, h, List.of(
                new Point(0, 0),
                new Point(w, 0),
                new Point(w, wall),
                new Point(wall, wall),
                new Point(wall, h - wall),
                new Point(w, h - wall),
                new Point(w, h),
                new Point(0, h)
        ));
    }

    private static Shape lShape(double w, double h, double cw, double ch) {
        return new Shape("POLYGON", w, h, List.of(
                new Point(0, 0),
                new Point(w, 0),
                new Point(w, ch),
                new Point(cw, ch),
                new Point(cw, h),
                new Point(0, h)
        ));
    }

    private static Process contourProcess(double pieceGap) {
        return new Process("CONTOUR", "SHEET", "left-top", "none",
                0.0, 0.0, 0.0, 0.0, "MAXIMIZE_PIECE_AREA", pieceGap, null);
    }

    @Test
    void shapeHolesValidationRejectsInvalidAndAcceptsValidHoles() {
        // 合法双孔多边形
        Shape validTwoHoles = new Shape("POLYGON", 500, 400,
                rectRing(0, 0, 500, 400),
                List.of(rectRing(40, 40, 160, 300), rectRing(260, 40, 180, 300)));
        assertDoesNotThrow(() -> PolygonGeometry.validate(validTwoHoles));
        double expectedArea = 500.0 * 400.0 - 160.0 * 300.0 - 180.0 * 300.0;
        assertEquals(expectedArea, validTwoHoles.areaMm2(), 1e-4, "带孔形状面积应准确扣除全部内孔面积");

        // 1. 内孔顶点数 < 3
        Shape tooFew = new Shape("POLYGON", 400, 400,
                rectRing(0, 0, 400, 400),
                List.of(List.of(new Point(50, 50), new Point(150, 50))));
        assertThrows(IllegalArgumentException.class, () -> PolygonGeometry.validate(tooFew));

        // 2. 自交内孔（蝴蝶形）
        Shape selfIntersectingHole = new Shape("POLYGON", 400, 400,
                rectRing(0, 0, 400, 400),
                List.of(List.of(
                        new Point(50, 50), new Point(200, 200),
                        new Point(200, 50), new Point(50, 200)
                )));
        assertThrows(IllegalArgumentException.class, () -> PolygonGeometry.validate(selfIntersectingHole));

        // 3. 越出外环的孔
        Shape outsideHole = new Shape("POLYGON", 400, 400,
                rectRing(0, 0, 400, 400),
                List.of(rectRing(250, 50, 220, 150)));
        assertThrows(IllegalArgumentException.class, () -> PolygonGeometry.validate(outsideHole));

        // 4. 贴着外环边界（非严格位于外环内部）的孔
        Shape touchingOuter = new Shape("POLYGON", 400, 400,
                rectRing(0, 0, 400, 400),
                List.of(rectRing(0, 50, 150, 150)));
        assertThrows(IllegalArgumentException.class, () -> PolygonGeometry.validate(touchingOuter));

        // 5. 两孔相交
        Shape intersectingHoles = new Shape("POLYGON", 500, 400,
                rectRing(0, 0, 500, 400),
                List.of(rectRing(50, 50, 200, 200), rectRing(180, 100, 200, 200)));
        assertThrows(IllegalArgumentException.class, () -> PolygonGeometry.validate(intersectingHoles));

        // 6. 一孔嵌套包含另一孔
        Shape nestedHoles = new Shape("POLYGON", 500, 400,
                rectRing(0, 0, 500, 400),
                List.of(rectRing(40, 40, 360, 320), rectRing(100, 100, 100, 100)));
        assertThrows(IllegalArgumentException.class, () -> PolygonGeometry.validate(nestedHoles));

        // 7. 矩形直刀模式拒绝带孔形状
        NestingProblem guillotineWithHole = new NestingProblem(
                "1", "mm",
                new Material("sheet", Shape.rectangle(1000, 1000), List.of(), false),
                List.of(new Part(1, "框件", validTwoHoles, 1, false)),
                new Process("GUILLOTINE", "SHEET", "left-top", "horizontal",
                        0.0, 100.0, 100.0, 0.0, "MAXIMIZE_PIECE_AREA", 0.0, null),
                "javaguillotine", 5);
        assertThrows(IllegalArgumentException.class, () -> NestingValidation.validate(guillotineWithHole));
    }

    @Test
    void holeNestingPlacesInnerPartsInsideParentHoleWithZeroAndPositivePieceGap() {
        DeepnestSolverEngine engine = new DeepnestSolverEngine();

        // 紧凑母板 600 × 520，外框母件 560 × 480（内孔 [80, 80] ~ [480, 400]，宽 400 × 高 320）
        // 母件外侧空隙最多 40mm，160 × 120 小件根本无法放在母件外部，只能嵌套进内孔！
        Shape parentFrame = frameWithHole(560, 480, 80, 80, 400, 320);
        Shape smallPart = Shape.rectangle(160, 120);

        // 场景 A：pieceGap = 0，2 件小件必须嵌套进母件内孔
        NestingProblem zeroGapProb = new NestingProblem(
                "1", "mm",
                new Material("tight-sheet", Shape.rectangle(600, 520), List.of(), false),
                List.of(
                        new Part(1, "带孔框件", parentFrame, 1, false),
                        new Part(2, "内套小件", smallPart, 2, true)
                ),
                contourProcess(0.0),
                "deepnest", 5);
        EngineResult zeroRes = engine.solve(zeroGapProb);
        assertTrue(zeroRes.isSuccess(), "孔洞内套料（gap=0）应求解成功：" + zeroRes.getMessage());
        assertEquals(3, zeroRes.getPlacements().size(), "母件与 2 件内套小件必须全部满排");
        assertNull(PolygonResultValidator.validate(zeroGapProb, zeroRes), "孔洞内套料（gap=0）必须通过带孔几何终检");
        assertChildrenInsideParentHole(zeroRes.getPlacements(), 80, 80, 480, 400, 0.0);

        // 场景 B：pieceGap = 10.0mm，验证小件在孔内同样严守孔壁与件间 10mm 间距
        NestingProblem posGapProb = new NestingProblem(
                "1", "mm",
                new Material("tight-sheet-gap", Shape.rectangle(600, 520), List.of(), false),
                List.of(
                        new Part(1, "带孔框件", parentFrame, 1, false),
                        new Part(2, "内套小件", smallPart, 2, true)
                ),
                contourProcess(10.0),
                "deepnest", 5);
        EngineResult gapRes = engine.solve(posGapProb);
        assertTrue(gapRes.isSuccess(), "孔洞内套料（gap=10mm）应求解成功：" + gapRes.getMessage());
        assertEquals(3, gapRes.getPlacements().size(), "gap=10mm 时仍应成功满排 3 件");
        assertNull(PolygonResultValidator.validate(posGapProb, gapRes), "孔洞内套料（gap=10mm）必须通过带孔间距终检");
        assertChildrenInsideParentHole(gapRes.getPlacements(), 80, 80, 480, 400, 10.0);

        // 场景 C：独立校验器必须拦截“孔内小件距孔壁 < pieceGap”的违规结果
        EngineResult tooCloseToHoleWall = new EngineResult();
        tooCloseToHoleWall.setSuccess(true);
        tooCloseToHoleWall.setPlacements(List.of(
                new Placement(1, 1, "带孔框件", 0, 0, parentFrame, 0),
                // 内孔左壁在 x=80，将小件放在 x=84（仅距孔壁 4mm < pieceGap=10mm）
                new Placement(2, 2, "内套小件", 84, 100, smallPart, 0)
        ));
        tooCloseToHoleWall.setSuggestedFeedLength(480);
        String wallErr = PolygonResultValidator.validate(posGapProb, tooCloseToHoleWall);
        assertNotNull(wallErr, "孔内小件距孔壁不足 pieceGap 必须被 PolygonResultValidator 拦截");
        assertTrue(wallErr.contains("间距"), "报错应指明间距违规：" + wallErr);
    }

    @Test
    void concaveUAndCShapeMicroShrinkViaJtsNegativeBufferStaysSimpleAndValid() {
        Shape uShape = deepUShape(600, 500, 40, 40);
        Shape cShape = deepCShape(600, 500, 40);

        Shape shrunkU = DeepnestNfpGeometry.shrinkShapeMicro(uShape, 0.5);
        assertDoesNotThrow(() -> PolygonGeometry.validate(shrunkU), "深凹 U 形负 Buffer 微缩后不得自交");
        double uOrigArea = PolygonGeometry.area(uShape);
        double uShrunkArea = PolygonGeometry.area(shrunkU);
        assertTrue(uShrunkArea < uOrigArea && uShrunkArea > uOrigArea * 0.90,
                String.format("U 形微缩面积应温和缩小：orig=%.2f, shrunk=%.2f", uOrigArea, uShrunkArea));

        Shape shrunkC = DeepnestNfpGeometry.shrinkShapeMicro(cShape, 0.5);
        assertDoesNotThrow(() -> PolygonGeometry.validate(shrunkC), "深凹 C 形负 Buffer 微缩后不得自交");
        double cOrigArea = PolygonGeometry.area(cShape);
        double cShrunkArea = PolygonGeometry.area(shrunkC);
        assertTrue(cShrunkArea < cOrigArea && cShrunkArea > cOrigArea * 0.90,
                String.format("C 形微缩面积应温和缩小：orig=%.2f, shrunk=%.2f", cOrigArea, cShrunkArea));

        // 深凹 U 形料头作为母板进行异形排料
        Shape uSheet = deepUShape(800, 600, 220, 220);
        NestingProblem uSheetProb = new NestingProblem(
                "1", "mm",
                new Material("u-remnant", uSheet, List.of(), false),
                List.of(new Part(1, "贴合块", Shape.rectangle(160, 160), 4, true)),
                contourProcess(4.0),
                "deepnest", 5);
        EngineResult res = new DeepnestSolverEngine().solve(uSheetProb);
        assertTrue(res.isSuccess(), "U 形凹料头排料应成功：" + res.getMessage());
        assertEquals(4, res.getPlacements().size(), "U 形凹料头应能完整排入 4 件");
        assertNull(PolygonResultValidator.validate(uSheetProb, res), "U 形凹料头排料必须通过零容忍终检");
    }

    @Test
    void pureSelvedgeRelaxationEnablesPartitionAndStage3Compaction() {
        DeepnestSolverEngine engine = new DeepnestSolverEngine();

        // 1. 大批量（54 件）+ 纯布边 35mm：应触发分区求解并严守布边
        List<Part> batch54 = List.of(
                new Part(1, "异形甲", lShape(240, 180, 100, 80), 27, false, true),
                new Part(2, "异形乙", lShape(200, 150, 85, 70), 27, false, true)
        );
        NestingProblem selvedge54 = new NestingProblem(
                "1", "mm",
                new Material("roll-selv-54", Shape.rectangle(1500, 4500), List.of(), false,
                        new FabricRule(35.0, 35.0, false, null, null)),
                batch54,
                contourProcess(4.0),
                "deepnest", 8);

        EngineResult res54 = engine.solve(selvedge54);
        assertTrue(res54.isSuccess(), "纯布边大批量分区求解应成功：" + res54.getMessage());
        assertNotNull(ContourPartitionSolver.lastDiagnostics(), "纯布边 54 件必须触发分区求解诊断");
        assertEquals(54, res54.getPlacements().size(), "纯布边 54 件必须 100% 满排");
        assertNull(PolygonResultValidator.validate(selvedge54, res54), "纯布边大批量结果必须通过终检");
        for (Placement p : res54.getPlacements()) {
            assertTrue(p.x() >= 35.0 - 1e-4, "不得越入左布边：" + p.x());
            assertTrue(p.x() + p.shape().width() <= 1500.0 - 35.0 + 1e-4, "不得越入右布边：" + (p.x() + p.shape().width()));
        }

        // 2. 中小批量（16 件）+ 纯布边 40mm：MarkerCompactor 与 AxisMarkerCompactor 放宽支持纯布边且不退化
        NestingProblem selvedge16 = new NestingProblem(
                "1", "mm",
                new Material("roll-selv-16", Shape.rectangle(1200, 3000), List.of(), false,
                        new FabricRule(40.0, 40.0, false, null, null)),
                List.of(new Part(1, "L件", lShape(240, 180, 100, 80), 16, false, true)),
                contourProcess(4.0),
                "deepnest", 5);
        EngineResult base16 = engine.solve(selvedge16);
        assertTrue(base16.isSuccess());
        assertEquals(16, base16.getPlacements().size());
        assertNull(PolygonResultValidator.validate(selvedge16, base16));

        List<Placement> axisCompacted = AxisMarkerCompactor.compact(
                selvedge16, base16.getPlacements(), System.nanoTime() + 1_000_000_000L);
        assertEquals(16, axisCompacted.size());
        for (Placement p : axisCompacted) {
            assertTrue(p.x() >= 40.0 - 1e-4 && p.x() + p.shape().width() <= 1200.0 - 40.0 + 1e-4,
                    "AxisMarkerCompactor 纯布边压紧后必须严守布边");
        }
        EngineResult axisCheck = new EngineResult();
        axisCheck.setSuccess(true);
        axisCheck.setPlacements(axisCompacted);
        axisCheck.setSuggestedFeedLength(axisCompacted.stream().mapToDouble(p -> p.y() + p.shape().height()).max().orElse(0));
        assertNull(PolygonResultValidator.validate(selvedge16, axisCheck), "AxisMarkerCompactor 纯布边输出必须通过终检");

        List<Placement> lnsCompacted = MarkerCompactor.compact(
                selvedge16, axisCompacted, System.nanoTime() + 1_000_000_000L);
        assertEquals(16, lnsCompacted.size());
        EngineResult lnsCheck = new EngineResult();
        lnsCheck.setSuccess(true);
        lnsCheck.setPlacements(lnsCompacted);
        lnsCheck.setSuggestedFeedLength(lnsCompacted.stream().mapToDouble(p -> p.y() + p.shape().height()).max().orElse(0));
        assertNull(PolygonResultValidator.validate(selvedge16, lnsCheck), "MarkerCompactor 纯布边输出必须通过终检");
    }

    private static void assertChildrenInsideParentHole(List<Placement> placements,
                                                       double holeLocalX1, double holeLocalY1,
                                                       double holeLocalX2, double holeLocalY2,
                                                       double minGap) {
        Placement parent = placements.stream()
                .filter(p -> p.demandId() == 1)
                .findFirst()
                .orElseThrow();
        double hx1 = parent.x() + holeLocalX1;
        double hy1 = parent.y() + holeLocalY1;
        double hx2 = parent.x() + holeLocalX2;
        double hy2 = parent.y() + holeLocalY2;

        List<Placement> children = placements.stream().filter(p -> p.demandId() == 2).toList();
        assertEquals(2, children.size());
        for (Placement child : children) {
            assertTrue(child.x() >= hx1 + minGap - 0.05, "孔内子件左壁间距不足：" + child);
            assertTrue(child.y() >= hy1 + minGap - 0.05, "孔内子件上壁间距不足：" + child);
            assertTrue(child.x() + child.shape().width() <= hx2 - minGap + 0.05, "孔内子件右壁间距不足：" + child);
            assertTrue(child.y() + child.shape().height() <= hy2 - minGap + 0.05, "孔内子件下壁间距不足：" + child);
        }
    }
}
