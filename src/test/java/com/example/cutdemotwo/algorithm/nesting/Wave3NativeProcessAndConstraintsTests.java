package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.algorithm.nesting.constraints.CurtainConstraintPack;
import com.example.cutdemotwo.algorithm.nesting.constraints.GrainGroupRule;
import com.example.cutdemotwo.algorithm.nesting.constraints.PatternRepeatRule;
import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.FabricRule;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Material;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Part;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.PartRule;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Process;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 第三波专项验收测试（一）：
 * <ul>
 *   <li>旧 JSON 契约与构造器 100% 向后兼容；</li>
 *   <li>直刀原生刀缝 kerf、矩形原生 pieceGap、最大通切阶数 maxStages 与垂直首刀版长压缩；</li>
 *   <li>RectangularResultValidator 直刀防劈穿裁片与刀缝侵蚀拦截；</li>
 *   <li>PatternRepeatRule 旋转锚点变换（含 180° -> h - anchorY）与双轴 (repeatX, repeatY) 对格吸附；</li>
 *   <li>GrainGroupRule 同组一致倒顺毛全链路求解与校验拦截。</li>
 * </ul>
 */
class Wave3NativeProcessAndConstraintsTests {

    private static final ObjectMapper MAPPER = new ObjectMapper();

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

    private static Process guillotineProcess(String feedMode, String firstStage, double trimStart,
                                               double kerf, double pieceGap, Integer maxStages) {
        return new Process("GUILLOTINE", feedMode, "left-top", firstStage,
                trimStart, 100.0, 100.0, kerf, "MAXIMIZE_PIECE_AREA", pieceGap, maxStages);
    }

    private static Process contourProcess(double kerf, double pieceGap) {
        return new Process("CONTOUR", "SHEET", "left-top", "none",
                0.0, 0.0, 0.0, kerf, "MAXIMIZE_PIECE_AREA", pieceGap, null);
    }

    @Test
    void legacyJsonContractExcludesNewOptionalFieldsWhenUnset() {
        NestingProblem legacy = new NestingProblem(
                "1", "mm",
                new Material("mat-legacy", Shape.rectangle(1200, 2400), List.of(), false,
                        new FabricRule(20.0, 20.0, false, 300.0, 10.0)),
                List.of(new Part(1, "常规件", Shape.rectangle(300, 200), 2, true, null,
                        new PartRule("PRIMARY", true, 15.0, 1.0))),
                new Process("GUILLOTINE", "SHEET", "left-top", "horizontal",
                        0.0, 100.0, 100.0, 0.0, "MAXIMIZE_PIECE_AREA", 0.0),
                "javaguillotine", 5);

        String json = MAPPER.writeValueAsString(legacy);
        assertFalse(json.contains("\"holes\""), "未配置内孔时旧 JSON 不得出现 holes 字段：" + json);
        assertFalse(json.contains("\"repeatXMm\""), "未配置纬向花距时旧 JSON 不得出现 repeatXMm：" + json);
        assertFalse(json.contains("\"phaseXMm\""), "未配置纬向相位时旧 JSON 不得出现 phaseXMm：" + json);
        assertFalse(json.contains("\"patternAnchorXMm\""), "未配置纬向锚点时旧 JSON 不得出现 patternAnchorXMm：" + json);
        assertFalse(json.contains("\"grainGroupId\""), "未配置倒顺毛分组时旧 JSON 不得出现 grainGroupId：" + json);
        assertFalse(json.contains("\"maxStages\""), "未配置最大通切阶数时旧 JSON 不得出现 maxStages：" + json);

        NestingProblem roundTrip = MAPPER.readValue(json, NestingProblem.class);
        assertEquals(legacy.material().shape().width(), roundTrip.material().shape().width(), 1e-6);
        assertTrue(roundTrip.material().shape().holes().isEmpty());
        assertNull(roundTrip.process().maxStages());

        // 带新扩展字段的往返序列化无损
        NestingProblem extended = new NestingProblem(
                "1", "mm",
                new Material("mat-ext", Shape.rectangle(1200, 2400), List.of(), false,
                        new FabricRule(20.0, 20.0, false, 300.0, 10.0, 150.0, 5.0)),
                List.of(new Part(1, "扩展件", Shape.rectangle(300, 200), 2, false, null,
                        new PartRule("PRIMARY", true, 15.0, 1.0, List.of(0), 25.0, "GRP-A"))),
                guillotineProcess("SHEET", "horizontal", 0.0, 3.5, 6.0, 3),
                "javaguillotine", 5);
        String extJson = MAPPER.writeValueAsString(extended);
        NestingProblem extRead = MAPPER.readValue(extJson, NestingProblem.class);
        assertEquals(150.0, extRead.material().fabricRule().repeatXMm());
        assertEquals(5.0, extRead.material().fabricRule().phaseXMm());
        assertEquals(25.0, extRead.parts().get(0).rule().patternAnchorXMm());
        assertEquals("GRP-A", extRead.parts().get(0).rule().grainGroupId());
        assertEquals(3, extRead.process().maxStages());
        assertEquals(3.5, extRead.process().kerf());
        assertEquals(6.0, extRead.process().pieceGap());
    }

    @Test
    void guillotineNativeKerfAndPieceGapEnforceSpacingAndPassValidator() {
        JavaGuillotineSolverEngine engine = new JavaGuillotineSolverEngine();
        List<Part> parts = List.of(
                new Part(1, "板A", Shape.rectangle(380, 260), 4, true),
                new Part(2, "板B", Shape.rectangle(290, 210), 4, true),
                new Part(3, "板C", Shape.rectangle(220, 180), 4, true)
        );

        // 场景 A：纯原生刀缝 kerf=4.0mm（pieceGap=0）
        NestingProblem kerfOnly = new NestingProblem(
                "1", "mm",
                new Material("sheet-kerf", Shape.rectangle(1220, 2440), List.of(), false),
                parts,
                guillotineProcess("SHEET", "horizontal", 0.0, 4.0, 0.0, null),
                "javaguillotine", 5);
        EngineResult kerfRes = engine.solve(kerfOnly);
        assertTrue(kerfRes.isSuccess(), "直刀原生 kerf=4mm 应求解成功：" + kerfRes.getMessage());
        assertEquals(12, kerfRes.getPieces().size(), "应全部满排 12 件");
        assertNull(RectangularResultValidator.validate(kerfOnly, kerfRes), "直刀原生 kerf 结果必须通过独立验真");
        assertPairwiseSeparation(kerfRes.getPieces(), 4.0);

        // 场景 B：原生 kerf=3.0mm 与矩形原生 pieceGap=8.0mm 并存（净间距必须 >= 8.0mm）
        NestingProblem kerfAndGap = new NestingProblem(
                "1", "mm",
                new Material("sheet-gap", Shape.rectangle(1220, 2440), List.of(), true),
                parts,
                guillotineProcess("CONTINUOUS", "horizontal", 15.0, 3.0, 8.0, null),
                "javaguillotine", 5);
        EngineResult gapRes = engine.solve(kerfAndGap);
        assertTrue(gapRes.isSuccess(), "直刀原生 kerf+pieceGap 应求解成功：" + gapRes.getMessage());
        assertEquals(12, gapRes.getPieces().size(), "应全部满排 12 件");
        assertNull(RectangularResultValidator.validate(kerfAndGap, gapRes), "直刀原生 pieceGap 结果必须通过独立验真");
        assertPairwiseSeparation(gapRes.getPieces(), 8.0);
    }

    @Test
    void guillotineMaxStagesCapsCutStagesAndValidatorRejectsOverflow() {
        JavaGuillotineSolverEngine engine = new JavaGuillotineSolverEngine();
        List<Part> parts = List.of(
                new Part(1, "长条A", Shape.rectangle(450, 300), 3, true),
                new Part(2, "小块B", Shape.rectangle(220, 140), 6, true),
                new Part(3, "中块C", Shape.rectangle(300, 180), 4, true)
        );
        NestingProblem stage2Problem = new NestingProblem(
                "1", "mm",
                new Material("sheet-s2", Shape.rectangle(1200, 2400), List.of(), false),
                parts,
                guillotineProcess("SHEET", "horizontal", 0.0, 2.0, 0.0, 2),
                "javaguillotine", 5);
        EngineResult res2 = engine.solve(stage2Problem);
        assertTrue(res2.isSuccess(), "maxStages=2 应求解成功：" + res2.getMessage());
        assertNull(RectangularResultValidator.validate(stage2Problem, res2));
        for (CutStep cut : res2.getCuts()) {
            assertNotNull(cut.getStage(), "直刀刀路应标记阶段号");
            assertTrue(cut.getStage() <= 2, "maxStages=2 时所有切刀阶段不得超过 2，实际：" + cut.getStage());
        }

        // 构造超阶违规结果验证独立校验器拦截
        EngineResult overflow = new EngineResult();
        overflow.setSuccess(true);
        overflow.setPieces(List.of(new PlacedPiece(1, "长条A", 0, 0, 450, 300, false, 1)));
        overflow.setSuggestedFeedLength(300);
        CutStep badStageCut = new CutStep(1, "横切", 300, 0, 1200, "越阶切刀");
        badStageCut.setStage(4);
        overflow.setCuts(List.of(badStageCut));

        String err = RectangularResultValidator.validate(stage2Problem, overflow);
        assertNotNull(err, "超过 maxStages 的刀线必须被独立校验器拦截");
        assertTrue(err.contains("最大通切阶数") || err.contains("阶段"), "错误信息应指明阶数超限：" + err);
    }

    @Test
    void guillotineVerticalFirstStageBinaryCompactionIsValidAndPiercingFree() {
        JavaGuillotineSolverEngine engine = new JavaGuillotineSolverEngine();
        NestingProblem verticalProb = new NestingProblem(
                "1", "mm",
                new Material("roll-vert", Shape.rectangle(1500, 5000), List.of(), true),
                List.of(
                        new Part(1, "主幅", Shape.rectangle(420, 680), 4, true),
                        new Part(2, "侧幅", Shape.rectangle(310, 520), 4, true),
                        new Part(3, "配条", Shape.rectangle(240, 380), 4, true)
                ),
                guillotineProcess("CONTINUOUS", "vertical", 0.0, 2.0, 4.0, null),
                "javaguillotine", 5);

        EngineResult res = engine.solve(verticalProb);
        assertTrue(res.isSuccess(), "垂直首刀应求解成功：" + res.getMessage());
        assertEquals(12, res.getPieces().size(), "垂直首刀应满排全部 12 件");
        assertNull(RectangularResultValidator.validate(verticalProb, res), "垂直首刀压缩结果必须通过防劈穿与全量验真");
        assertTrue(res.getSuggestedFeedLength() > 0 && res.getSuggestedFeedLength() < 4500.0,
                "垂直首刀二分版长压缩应显著小于母卷总长 5000mm，实际：" + res.getSuggestedFeedLength());
        assertPairwiseSeparation(res.getPieces(), 4.0);

        List<CutStep> stage1Cuts = res.getCuts().stream()
                .filter(c -> c.getStage() != null && c.getStage() == 1)
                .toList();
        assertFalse(stage1Cuts.isEmpty(), "应存在第 1 阶切刀");
        assertTrue(stage1Cuts.stream().allMatch(c -> "纵切".equals(c.getType())),
                "vertical 首刀模式下第 1 阶切刀必须全部为纵切");
    }

    @Test
    void rectangularValidatorRejectsGuillotineCutPiercingPiece() {
        NestingProblem prob = new NestingProblem(
                "1", "mm",
                new Material("sheet", Shape.rectangle(1000, 1000), List.of(), false),
                List.of(new Part(1, "矩形片", Shape.rectangle(400, 300), 1, false)),
                guillotineProcess("SHEET", "horizontal", 0.0, 0.0, 0.0, null),
                "javaguillotine", 5);

        // 1. 横切直接劈穿裁片内部 (y=250 穿过 y∈[100, 400])
        EngineResult horizontalPierce = new EngineResult();
        horizontalPierce.setSuccess(true);
        horizontalPierce.setPieces(List.of(new PlacedPiece(1, "矩形片", 100, 100, 400, 300, false, 1)));
        horizontalPierce.setSuggestedFeedLength(400);
        CutStep badH = new CutStep(1, "横切", 250, 0, 1000, "违规横穿刀线");
        badH.setStage(1);
        horizontalPierce.setCuts(List.of(badH));
        String hErr = RectangularResultValidator.validate(prob, horizontalPierce);
        assertNotNull(hErr, "横切劈穿裁片内部必须被拦截");
        assertTrue(hErr.contains("劈穿"), "应明确报出劈穿裁片：" + hErr);

        // 2. 纵切直接劈穿裁片内部 (x=300 穿过 x∈[100, 500])
        EngineResult verticalPierce = new EngineResult();
        verticalPierce.setSuccess(true);
        verticalPierce.setPieces(List.of(new PlacedPiece(1, "矩形片", 100, 100, 400, 300, false, 1)));
        verticalPierce.setSuggestedFeedLength(400);
        CutStep badV = new CutStep(1, "纵切", 300, 0, 500, "违规纵穿刀线");
        badV.setStage(1);
        verticalPierce.setCuts(List.of(badV));
        String vErr = RectangularResultValidator.validate(prob, verticalPierce);
        assertNotNull(vErr, "纵切劈穿裁片内部必须被拦截");
        assertTrue(vErr.contains("劈穿"), "应明确报出劈穿裁片：" + vErr);

        // 3. kerf=4mm 时，刀线中心恰好贴在裁片边 x=500 上，半刀缝 2mm 会侵蚀裁片内部
        NestingProblem kerfProb = new NestingProblem(
                "1", "mm",
                new Material("sheet-kerf", Shape.rectangle(1000, 1000), List.of(), false),
                List.of(new Part(1, "矩形片", Shape.rectangle(400, 300), 1, false)),
                guillotineProcess("SHEET", "horizontal", 0.0, 4.0, 0.0, null),
                "javaguillotine", 5);
        EngineResult kerfErode = new EngineResult();
        kerfErode.setSuccess(true);
        kerfErode.setPieces(List.of(new PlacedPiece(1, "矩形片", 100, 100, 400, 300, false, 1)));
        kerfErode.setSuggestedFeedLength(400);
        CutStep erodeCut = new CutStep(1, "纵切", 500, 0, 500, "未偏移半刀缝导致侵蚀");
        erodeCut.setStage(1);
        kerfErode.setCuts(List.of(erodeCut));
        String kErr = RectangularResultValidator.validate(kerfProb, kerfErode);
        assertNotNull(kErr, "kerf>0 时未偏移半刀缝的贴边刀线侵蚀裁片必须被拦截");
        assertTrue(kErr.contains("劈穿"), "应明确报出刀缝侵蚀/劈穿：" + kErr);
    }

    @Test
    void patternRepeatTransformedAnchorAndBiaxialSnappingWorkEndToEnd() {
        // 1. 刚体旋转锚点精确验证：宽 400 × 高 300，锚点 (30, 50)
        Part rectPart = new Part(1, "格纹布片", Shape.rectangle(400, 300), 1, true, true,
                new PartRule("PRIMARY", true, 50.0, 1.0, List.of(0, 90, 180, 270), 30.0, null));

        double[] a0 = PatternRepeatRule.transformedAnchor(rectPart, 0);
        assertEquals(30.0, a0[0], 1e-6);
        assertEquals(50.0, a0[1], 1e-6);

        double[] a90 = PatternRepeatRule.transformedAnchor(rectPart, 90);
        assertEquals(250.0, a90[0], 1e-6, "90° 旋转锚点 X 应为 h - anchorY = 250");
        assertEquals(30.0, a90[1], 1e-6, "90° 旋转锚点 Y 应为 anchorX = 30");

        double[] a180 = PatternRepeatRule.transformedAnchor(rectPart, 180);
        assertEquals(370.0, a180[0], 1e-6, "180° 旋转锚点 X 应为 w - anchorX = 370");
        assertEquals(250.0, a180[1], 1e-6, "180° 旋转锚点 Y 应为 h - anchorY = 250");

        double[] a270 = PatternRepeatRule.transformedAnchor(rectPart, 270);
        assertEquals(50.0, a270[0], 1e-6, "270° 旋转锚点 X 应为 anchorY = 50");
        assertEquals(370.0, a270[1], 1e-6, "270° 旋转锚点 Y 应为 w - anchorX = 370");

        // 2. 双轴 (repeatX=120, phaseX=10; repeatY=200, phaseY=20) 双向最近吸附与端到端求解
        Part biaxialPart = new Part(1, "双轴对格L件", lShape(260, 220, 120, 100), 4, false, true,
                new PartRule("PRIMARY", true, 40.0, 1.0, List.of(0, 180), 25.0, null));
        NestingProblem contourPlaid = new NestingProblem(
                "1", "mm",
                new Material("plaid-mat", Shape.rectangle(1200, 2400), List.of(), false,
                        new FabricRule(0.0, 0.0, false, 200.0, 20.0, 120.0, 10.0)),
                List.of(biaxialPart),
                contourProcess(0.0, 4.0),
                "deepnest", 5);

        PatternRepeatRule rule = new PatternRepeatRule();
        double snappedX = rule.snapXNearest(contourPlaid, biaxialPart, 180, 190.0, 0.0, 800.0);
        double snappedY = rule.snapYNearest(contourPlaid, biaxialPart, 180, 260.0, 0.0, 1800.0);
        assertTrue(PatternRepeatRule.isAlignedX(contourPlaid, biaxialPart, 180, snappedX), "双向最近吸附 X 后必须对格");
        assertTrue(PatternRepeatRule.isAlignedY(contourPlaid, biaxialPart, 180, snappedY), "双向最近吸附 Y 后必须对格");

        DeepnestSolverEngine deepnest = new DeepnestSolverEngine();
        EngineResult contourRes = deepnest.solve(contourPlaid);
        assertTrue(contourRes.isSuccess(), "双轴对格 Deepnest 求解应成功：" + contourRes.getMessage());
        assertEquals(4, contourRes.getPlacements().size());
        assertNull(PolygonResultValidator.validate(contourPlaid, contourRes), "双轴对格结果必须通过独立终检");
        for (Placement p : contourRes.getPlacements()) {
            assertTrue(PatternRepeatRule.isAligned(contourPlaid, biaxialPart, p.rotationDegrees(), p.x(), p.y()),
                    "每件已排裁片旋转后双轴锚点均须对齐花格：" + p);
        }

        // 3. 直刀双轴对格求解验真
        Part rectPlaidPart = new Part(1, "双轴对格矩形", Shape.rectangle(260, 220), 4, false, false,
                new PartRule("PRIMARY", true, 40.0, 1.0, List.of(0), 25.0, null));
        NestingProblem guillotinePlaid = new NestingProblem(
                "1", "mm",
                new Material("plaid-rect", Shape.rectangle(1200, 2400), List.of(), false,
                        new FabricRule(0.0, 0.0, false, 200.0, 20.0, 120.0, 10.0)),
                List.of(rectPlaidPart),
                guillotineProcess("SHEET", "horizontal", 0.0, 0.0, 0.0, null),
                "javaguillotine", 5);
        EngineResult gRes = new JavaGuillotineSolverEngine().solve(guillotinePlaid);
        assertTrue(gRes.isSuccess(), "直刀双轴对格求解应成功：" + gRes.getMessage());
        assertEquals(4, gRes.getPieces().size());
        assertNull(RectangularResultValidator.validate(guillotinePlaid, gRes));
        for (PlacedPiece p : gRes.getPieces()) {
            int deg = p.isRotated() ? 90 : 0;
            assertTrue(PatternRepeatRule.isAligned(guillotinePlaid, rectPlaidPart, deg, p.getX(), p.getY()),
                    "直刀双轴对格件必须同时对齐 X 与 Y 花距");
        }
    }

    @Test
    void grainGroupEnforcesConsistentNapDirectionAcrossEnginesAndValidators() {
        // 1. 阶段 1 预检：同组内无共同允许的 0°/180° 经向角应直接拒绝
        NestingProblem conflictingGroup = new NestingProblem(
                "1", "mm",
                new Material("mat", Shape.rectangle(1200, 2000), List.of(), false),
                List.of(
                        new Part(1, "仅0度", lShape(200, 180, 90, 80), 1, false, false,
                                new PartRule("PRIMARY", false, null, null, List.of(0), null, "CONFLICT")),
                        new Part(2, "仅180度", lShape(200, 180, 90, 80), 1, false, true,
                                new PartRule("PRIMARY", false, null, null, List.of(180), null, "CONFLICT"))
                ),
                contourProcess(0.0, 0.0),
                "deepnest", 5);
        assertThrows(IllegalArgumentException.class,
                () -> CurtainConstraintPack.forProblem(conflictingGroup).checkProblem(conflictingGroup),
                "同组无共识经向角必须在阶段 1 被拦截");

        // 2. 异形双引擎（Deepnest & JavaIrregular）端到端同组一致倒顺毛验真
        List<Part> groupParts = List.of(
                new Part(1, "左片", lShape(260, 200, 110, 90), 3, true, true,
                        new PartRule("PRIMARY", false, null, null, List.of(0, 90, 180, 270), null, "SET-1")),
                new Part(2, "右片", lShape(240, 190, 100, 85), 3, true, true,
                        new PartRule("PRIMARY", false, null, null, List.of(0, 90, 180, 270), null, "SET-1")),
                new Part(3, "次卧组", lShape(220, 170, 95, 80), 2, false, true,
                        new PartRule("PRIMARY", false, null, null, List.of(0, 180), null, "SET-2"))
        );
        NestingProblem contourGroupProb = new NestingProblem(
                "1", "mm",
                new Material("nap-mat", Shape.rectangle(1200, 2400), List.of(), false),
                groupParts,
                contourProcess(0.0, 4.0),
                "deepnest", 5);

        EngineResult deepRes = new DeepnestSolverEngine().solve(contourGroupProb);
        assertTrue(deepRes.isSuccess(), "Deepnest 同组倒顺毛求解应成功：" + deepRes.getMessage());
        assertEquals(8, deepRes.getPlacements().size());
        assertNull(PolygonResultValidator.validate(contourGroupProb, deepRes));
        assertGrainGroupsConsistent(contourGroupProb, deepRes.getPlacements());

        EngineResult irregRes = new JavaIrregularSolverEngine().solve(contourGroupProb);
        assertTrue(irregRes.isSuccess(), "JavaIrregular 同组倒顺毛求解应成功：" + irregRes.getMessage());
        assertEquals(8, irregRes.getPlacements().size());
        assertNull(PolygonResultValidator.validate(contourGroupProb, irregRes));
        assertGrainGroupsConsistent(contourGroupProb, irregRes.getPlacements());

        // 3. 阶段 4 拦截：手工构造同组 0° 与 180° 混向违规结果，PolygonResultValidator 必须拦截
        EngineResult mixedDir = new EngineResult();
        mixedDir.setSuccess(true);
        Shape s0 = groupParts.get(0).shape();
        Shape s180 = PolygonGeometry.rotate(groupParts.get(1).shape(), 180);
        mixedDir.setPlacements(List.of(
                new Placement(1, 1, "左片", 0, 0, s0, 0),
                new Placement(2, 2, "右片", 400, 0, s180, 180)
        ));
        mixedDir.setSuggestedFeedLength(220);
        String mixedErr = PolygonResultValidator.validate(contourGroupProb, mixedDir);
        assertNotNull(mixedErr, "同组 0° 与 180° 混向必须被 PolygonResultValidator 拦截");
        assertTrue(mixedErr.contains("方向不一致") || mixedErr.contains("grainGroupId"), "错误信息应说明同组混向：" + mixedErr);

        // 4. 直刀模式带 grainGroupId：自动锁定 0° 不旋转，并验证 RectangularResultValidator 拦截旋转 90°
        NestingProblem rectGroupProb = new NestingProblem(
                "1", "mm",
                new Material("nap-rect", Shape.rectangle(1200, 2400), List.of(), false),
                List.of(
                        new Part(1, "门板A", Shape.rectangle(350, 500), 2, true, null,
                                new PartRule("PRIMARY", false, null, null, null, null, "DOOR-1")),
                        new Part(2, "门板B", Shape.rectangle(300, 450), 2, true, null,
                                new PartRule("PRIMARY", false, null, null, null, null, "DOOR-1"))
                ),
                guillotineProcess("SHEET", "horizontal", 0.0, 0.0, 0.0, null),
                "javaguillotine", 5);
        EngineResult rectGroupRes = new JavaGuillotineSolverEngine().solve(rectGroupProb);
        assertTrue(rectGroupRes.isSuccess());
        assertEquals(4, rectGroupRes.getPieces().size());
        assertTrue(rectGroupRes.getPieces().stream().noneMatch(PlacedPiece::isRotated),
                "直刀同组倒顺毛件不得 90° 旋转成纬向");
        assertNull(RectangularResultValidator.validate(rectGroupProb, rectGroupRes));

        EngineResult badRectRotated = new EngineResult();
        badRectRotated.setSuccess(true);
        badRectRotated.setPieces(List.of(new PlacedPiece(1, "门板A", 0, 0, 500, 350, true, 1)));
        badRectRotated.setSuggestedFeedLength(350);
        String badRectErr = RectangularResultValidator.validate(rectGroupProb, badRectRotated);
        assertNotNull(badRectErr, "直刀同组倒顺毛件旋转 90° 必须被 RectangularResultValidator 拦截");
    }

    private static void assertPairwiseSeparation(List<PlacedPiece> pieces, double minGap) {
        for (int i = 0; i < pieces.size(); i++) {
            PlacedPiece a = pieces.get(i);
            for (int j = i + 1; j < pieces.size(); j++) {
                PlacedPiece b = pieces.get(j);
                double gapX = Math.max(a.getX() - (b.getX() + b.getW()), b.getX() - (a.getX() + a.getW()));
                double gapY = Math.max(a.getY() - (b.getY() + b.getL()), b.getY() - (a.getY() + a.getL()));
                double sep = Math.max(gapX, gapY);
                assertTrue(sep >= minGap - 1e-3,
                        String.format("裁片 #%d 与 #%d 净间距 %.4f 小于最小要求 %.4f", a.getId(), b.getId(), sep, minGap));
            }
        }
    }

    private static void assertGrainGroupsConsistent(NestingProblem problem, List<Placement> placements) {
        Map<Integer, Part> byId = new HashMap<>();
        problem.parts().forEach(p -> byId.put(p.id(), p));
        Map<String, Set<Integer>> groupAngles = new HashMap<>();
        for (Placement p : placements) {
            String gid = GrainGroupRule.normalizedGroupId(byId.get(p.demandId()));
            if (gid == null) continue;
            int deg = Math.floorMod(p.rotationDegrees(), 360);
            assertTrue(deg == 0 || deg == 180, "同组倒顺毛仅允许 0° 或 180°，实际：" + deg);
            groupAngles.computeIfAbsent(gid, k -> new HashSet<>()).add(deg);
        }
        for (Map.Entry<String, Set<Integer>> e : groupAngles.entrySet()) {
            assertEquals(1, e.getValue().size(), "同组 " + e.getKey() + " 内所有裁片方向必须完全一致：" + e.getValue());
        }
    }
}
