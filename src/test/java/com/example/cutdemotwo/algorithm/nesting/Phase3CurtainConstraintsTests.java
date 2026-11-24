package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.nesting.constraints.ConstraintPipeline;
import com.example.cutdemotwo.algorithm.nesting.constraints.CurtainConstraintPack;
import com.example.cutdemotwo.algorithm.nesting.constraints.PatternRepeatRule;
import com.example.cutdemotwo.business.cutting.FabricSolveAdapter;
import com.example.cutdemotwo.business.model.PieceDemand;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
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
import tools.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class Phase3CurtainConstraintsTests {
    private static final ObjectMapper JSON = new ObjectMapper();

    private static SolverFactory solverFactory() {
        return new SolverFactory(List.of(
                new DeepnestSolverEngine(),
                new JavaIrregularSolverEngine(),
                new JavaGuillotineSolverEngine(),
                new CrossCutSolverService()
        ), true);
    }

    private static Process contourProcess() {
        return new Process("CONTOUR", "SHEET", "left-top", "none", 0, 0, 0, 0, "MAXIMIZE_PIECE_AREA", 0.0);
    }

    private static Process guillotineProcess() {
        return new Process("GUILLOTINE", "SHEET", "left-top", "horizontal", 0, 100, 100, 0, "MAXIMIZE_PIECE_AREA", 0.0);
    }

    private static Process crosscutProcess() {
        return new Process("CROSSCUT", "SHEET", "left-top", "horizontal", 0, 100, 100, 0, "INPUT_ORDER", 0.0);
    }

    private static Shape trapezoid(double bottomW, double topW, double h) {
        double dx = (bottomW - topW) / 2.0;
        return new Shape("POLYGON", bottomW, h, List.of(
                new Point(0, 0), new Point(bottomW, 0),
                new Point(bottomW - dx, h), new Point(dx, h)
        ));
    }

    // ==================== R1：疵点分级避让 ====================

    @Test
    void r1_contourDeepnestAndJavaIrregular_auxiliaryPenetratesMildDefectButMainAvoids() {
        SolverFactory factory = solverFactory();
        // 轻微疵点铺满整个 500x300 区域的中段，使得 400x250 裁片无法避开
        Exclusion mildDefect = new Exclusion(1, 50, 50, Shape.rectangle(400, 200), 0, 1, null);
        Material mat = new Material("m-r1", Shape.rectangle(500, 300), List.of(mildDefect), false);

        for (String engine : List.of("deepnest", "javairregular")) {
            Part mainPart = new Part(1, "主帘身", Shape.rectangle(400, 250), 1, false, false,
                    new PartRule("MAIN", null, null, null));
            NestingResult mainRes = factory.solve(new NestingProblem("1", "mm", mat, List.of(mainPart), contourProcess(), engine, 5));
            assertEquals("NO_SOLUTION_FOUND", mainRes.status(), engine + " 主片必须硬避让轻微疵点");

            Part auxPart = new Part(2, "绑带辅片", Shape.rectangle(400, 250), 1, false, false,
                    new PartRule("AUXILIARY", null, null, null));
            NestingResult auxRes = factory.solve(new NestingProblem("1", "mm", mat, List.of(auxPart), contourProcess(), engine, 5));
            assertTrue(auxRes.feasible(), engine + " 辅片应允许覆盖轻微疵点：" + auxRes.message());
            assertEquals(1, auxRes.placements().size());
        }
    }

    @Test
    void r1_contour_severeDefectBlocksEveryoneAndSeverity2AllowsAuxiliaryOnlyWhenPolicyPermits() {
        SolverFactory factory = solverFactory();
        Exclusion severeDefect = new Exclusion(1, 50, 50, Shape.rectangle(400, 200), 0, 3, "ALLOW_AUXILIARY");
        Material severeMat = new Material("m-sev3", Shape.rectangle(500, 300), List.of(severeDefect), false);
        Part auxPart = new Part(2, "绑带辅片", Shape.rectangle(400, 250), 1, false, false,
                new PartRule("AUXILIARY", null, null, null));

        for (String engine : List.of("deepnest", "javairregular")) {
            NestingResult res = factory.solve(new NestingProblem("1", "mm", severeMat, List.of(auxPart), contourProcess(), engine, 5));
            assertEquals("NO_SOLUTION_FOUND", res.status(), engine + " 严重疵点(severity>=3)必须全员硬避让");
        }

        // severity == 2 + ALLOW_AUXILIARY -> 辅片放行，主片仍硬避让
        Exclusion sev2AllowAux = new Exclusion(1, 50, 50, Shape.rectangle(400, 200), 0, 2, "ALLOW_AUXILIARY");
        Material sev2Mat = new Material("m-sev2", Shape.rectangle(500, 300), List.of(sev2AllowAux), false);
        Part mainPart = new Part(1, "主帘身", Shape.rectangle(400, 250), 1, false, false,
                new PartRule("MAIN", null, null, null));

        NestingResult mainRes = factory.solve(new NestingProblem("1", "mm", sev2Mat, List.of(mainPart), contourProcess(), "javairregular", 5));
        assertEquals("NO_SOLUTION_FOUND", mainRes.status());

        NestingResult auxRes = factory.solve(new NestingProblem("1", "mm", sev2Mat, List.of(auxPart), contourProcess(), "javairregular", 5));
        assertTrue(auxRes.feasible());
    }

    @Test
    void r1_contour_auxiliaryPrefersAvoidingMildDefectViaSoftPenaltyWhenCleanSpaceExists() {
        SolverFactory factory = solverFactory();
        // 轻微疵点在左上角 (0, 0, 200x200)，但 1000x400 布面右侧和下方有充足无疵空间
        Exclusion mildAtOrigin = new Exclusion(1, 0, 0, Shape.rectangle(200, 200), 0, 1, "ALLOW_AUXILIARY");
        Material mat = new Material("m-soft", Shape.rectangle(1000, 400), List.of(mildAtOrigin), false);
        Part auxPart = new Part(1, "绑带辅片", Shape.rectangle(200, 150), 1, false, false,
                new PartRule("AUXILIARY", null, null, null));

        for (String engine : List.of("deepnest", "javairregular")) {
            NestingResult res = factory.solve(new NestingProblem("1", "mm", mat, List.of(auxPart), contourProcess(), engine, 5));
            assertTrue(res.feasible(), engine + " 应成功排入");
            var p = res.placements().get(0);
            boolean overlapsOriginDefect = p.x() < 200 - 0.001 && p.y() < 200 - 0.001;
            assertFalse(overlapsOriginDefect, engine + " 有充足好料时辅片应在软惩罚引导下优先避开轻微疵点，实际位置=(" + p.x() + "," + p.y() + ")");
        }
    }

    @Test
    void r1_rectangularGuillotineAndCrossCut_mildDefectAllowsAuxiliaryAndBlocksMain() {
        SolverFactory factory = solverFactory();
        Exclusion mildFullBand = new Exclusion(1, 0, 100, Shape.rectangle(1000, 200), 0, 1, "PENETRABLE");
        Material mat = new Material("m-rect-r1", Shape.rectangle(1000, 400), List.of(mildFullBand), false);

        Part mainPart = new Part(1, "主帘身", Shape.rectangle(1000, 350), 1, false, null,
                new PartRule("MAIN", null, null, null));
        Part auxPart = new Part(2, "辅片", Shape.rectangle(1000, 350), 1, false, null,
                new PartRule("AUXILIARY", null, null, null));

        // javaguillotine
        NestingResult gMain = factory.solve(new NestingProblem("1", "mm", mat, List.of(mainPart), guillotineProcess(), "javaguillotine", 5));
        assertEquals("NO_SOLUTION_FOUND", gMain.status());
        NestingResult gAux = factory.solve(new NestingProblem("1", "mm", mat, List.of(auxPart), guillotineProcess(), "javaguillotine", 5));
        assertTrue(gAux.feasible(), "javaguillotine 辅片应放行轻微疵点：" + gAux.message());
        assertEquals(1, gAux.placements().size());

        // crosscut
        NestingResult cMain = factory.solve(new NestingProblem("1", "mm", mat, List.of(mainPart), crosscutProcess(), "crosscut", 5));
        assertEquals("NO_SOLUTION_FOUND", cMain.status());
        NestingResult cAux = factory.solve(new NestingProblem("1", "mm", mat, List.of(auxPart), crosscutProcess(), "crosscut", 5));
        assertTrue(cAux.feasible(), "crosscut 辅片应放行轻微疵点：" + cAux.message());
        assertEquals(1, cAux.placements().size());
    }

    // ==================== R2：左右布边禁区 ====================

    @Test
    void r2_selvedgeClipsMainPartsAndRejectsOversizedPartsInStage1() {
        SolverFactory factory = solverFactory();
        FabricRule selvedge = new FabricRule(30.0, 20.0, false, null, null);
        Material mat = new Material("m-selvedge", Shape.rectangle(1000, 800), List.of(), false, selvedge);

        // 1. 合法主片（宽 900 <= 1000 - 30 - 20 = 950），在三个引擎下均落在 [30, 980] 内
        Part okPart = new Part(1, "主帘", Shape.rectangle(900, 300), 2, false);
        for (String engine : List.of("deepnest", "javairregular")) {
            NestingResult res = factory.solve(new NestingProblem("1", "mm", mat, List.of(okPart), contourProcess(), engine, 5));
            assertTrue(res.feasible(), engine + " 应成功排入：" + res.message());
            assertEquals(2, res.placements().size());
            for (var p : res.placements()) {
                assertTrue(p.x() >= 30.0 - 0.001, engine + " 不得侵占左布边，实际 x=" + p.x());
                assertTrue(p.x() + p.shape().width() <= 980.0 + 0.001, engine + " 不得侵占右布边");
            }
        }
        NestingResult gRes = factory.solve(new NestingProblem("1", "mm", mat, List.of(okPart), guillotineProcess(), "javaguillotine", 5));
        assertTrue(gRes.feasible(), "javaguillotine 应成功排入：" + gRes.message());
        assertEquals(2, gRes.placements().size());
        for (var p : gRes.placements()) {
            assertTrue(p.x() >= 30.0 - 0.001);
            assertTrue(p.x() + p.shape().width() <= 980.0 + 0.001);
        }

        // 2. 超幅宽预检拒绝：960 > 950（不可旋转）
        Part tooWide = new Part(2, "超宽主帘", Shape.rectangle(960, 300), 1, false);
        NestingResult rejected = factory.solve(new NestingProblem("1", "mm", mat, List.of(tooWide), contourProcess(), "javairregular", 5));
        assertEquals("INVALID_INPUT", rejected.status());
        assertTrue(rejected.message().contains("布边"), "应明确提示扣除布边后幅宽不足：" + rejected.message());
    }

    @Test
    void r2_selvedgeAllowsAuxiliaryWhenConfiguredAndValidatorCatchesViolations() {
        SolverFactory factory = solverFactory();
        FabricRule allowAuxSelvedge = new FabricRule(40.0, 40.0, true, null, null);
        Material mat = new Material("m-aux-selv", Shape.rectangle(1000, 500), List.of(), false, allowAuxSelvedge);
        // 辅片宽 980 > 920，但允许进布边 -> 阶段 1 放行并成功排入
        Part auxWide = new Part(1, "通幅包边条", Shape.rectangle(980, 100), 1, false, false,
                new PartRule("AUXILIARY", null, null, null));
        NestingResult res = factory.solve(new NestingProblem("1", "mm", mat, List.of(auxWide), contourProcess(), "javairregular", 5));
        assertTrue(res.feasible(), "允许辅片进布边时应成功排入：" + res.message());

        // 阶段 4 独立校验器应拦截主片落入布边的违规结果
        Part mainPart = new Part(1, "主帘", Shape.rectangle(500, 200), 1, false);
        NestingProblem prob = new NestingProblem("1", "mm", mat, List.of(mainPart), contourProcess(), "javairregular", 5);
        EngineResult bad = new EngineResult();
        bad.setSuccess(true);
        bad.setPlacements(List.of(new NestingResult.Placement(1, 1, "主帘", 10.0, 0.0, Shape.rectangle(500, 200), 0)));
        String err = PolygonResultValidator.validate(prob, bad);
        assertNotNull(err);
        assertTrue(err.contains("布边"), "独立终检应拦截布边违规：" + err);
    }

    // ==================== R3：按件独立经向与掉头控制 ====================

    @Test
    void r3_independentGrainAndHalfTurnPerPart() {
        SolverFactory factory = solverFactory();
        Material mat = new Material("m-r3", Shape.rectangle(1000, 900), List.of(), false);
        // 主片1：严格保经向（仅 0°）
        Part strictGrain = new Part(1, "倒顺毛主帘", trapezoid(400, 300, 350), 1, false, false,
                new PartRule("MAIN", null, null, null));
        // 主片2：保经向可 180° 掉头（0°/180°）
        Part halfTurnMain = new Part(2, "素色窗幔", trapezoid(400, 300, 350), 1, false, true,
                new PartRule("MAIN", null, null, null));
        // 辅片：全角度旋转（0°/90°/180°/270°），高 500 宽 100
        Part freeAux = new Part(3, "绑带", Shape.rectangle(100, 500), 2, true, null,
                new PartRule("AUXILIARY", null, null, null));

        for (String engine : List.of("deepnest", "javairregular")) {
            NestingResult res = factory.solve(new NestingProblem("1", "mm", mat,
                    List.of(strictGrain, halfTurnMain, freeAux), contourProcess(), engine, 5));
            assertTrue(res.feasible(), engine + " 应成功排入：" + res.message());
            assertEquals(4, res.placements().size());
            for (var p : res.placements()) {
                if (p.demandId() == 1) assertEquals(0, p.rotationDegrees());
                if (p.demandId() == 2) assertTrue(List.of(0, 180).contains(p.rotationDegrees()));
                if (p.demandId() == 3) assertTrue(List.of(0, 90, 180, 270).contains(p.rotationDegrees()));
            }
        }
    }

    // ==================== R4：经向花距循环对花 ====================

    @Test
    void r4_patternRepeatSnapsAndValidatesAcrossContourGuillotineAndCrossCut() {
        SolverFactory factory = solverFactory();
        FabricRule repeatRule = new FabricRule(null, null, null, 400.0, 50.0);
        Material mat = new Material("m-r4", Shape.rectangle(1000, 1500), List.of(), false, repeatRule);

        // 对花主片：anchorY=10, tol=1.0 -> 合法 Y 满足 (y + 10 - 50) mod 400 == 0，即 y = 40, 440, 840, 1240...
        Part matchedContour = new Part(1, "提花主帘", Shape.rectangle(450, 300), 2, false, false,
                new PartRule("MAIN", true, 10.0, 1.0));
        for (String engine : List.of("deepnest", "javairregular")) {
            NestingProblem prob = new NestingProblem("1", "mm", mat, List.of(matchedContour), contourProcess(), engine, 5);
            NestingResult res = factory.solve(prob);
            assertTrue(res.feasible(), engine + " 对花排料应成功：" + res.message());
            assertEquals(2, res.placements().size());
            for (var p : res.placements()) {
                double err = PatternRepeatRule.alignmentErrorMm(prob, matchedContour, p.y());
                assertTrue(err <= 1.001, engine + " 对花误差超限：" + err + " mm, y=" + p.y());
            }
        }

        // javaguillotine
        Part matchedRect = new Part(1, "提花主帘", Shape.rectangle(450, 300), 2, false, null,
                new PartRule("MAIN", true, 10.0, 1.0));
        NestingProblem gProb = new NestingProblem("1", "mm", mat, List.of(matchedRect), guillotineProcess(), "javaguillotine", 5);
        NestingResult gRes = factory.solve(gProb);
        assertTrue(gRes.feasible(), "javaguillotine 对花排料应成功：" + gRes.message());
        assertEquals(2, gRes.placements().size());
        for (var p : gRes.placements()) {
            assertTrue(PatternRepeatRule.alignmentErrorMm(gProb, matchedRect, p.y()) <= 1.001);
        }

        // crosscut
        Part matchedFullWidth = new Part(1, "整幅提花帘", Shape.rectangle(1000, 300), 2, false, null,
                new PartRule("MAIN", true, 10.0, 1.0));
        NestingProblem cProb = new NestingProblem("1", "mm", mat, List.of(matchedFullWidth), crosscutProcess(), "crosscut", 5);
        NestingResult cRes = factory.solve(cProb);
        assertTrue(cRes.feasible(), "crosscut 对花排料应成功：" + cRes.message());
        assertEquals(2, cRes.placements().size());
        assertEquals(40.0, cRes.placements().get(0).y(), 0.01);
        assertEquals(440.0, cRes.placements().get(1).y(), 0.01);

        // 阶段 4 独立校验器应拦截未对花的违规结果
        EngineResult badRect = new EngineResult();
        badRect.setSuccess(true);
        badRect.setPieces(List.of(new PlacedPiece(1, "提花主帘", 0, 100, 450, 300, false, 1)));
        badRect.setSuggestedFeedLength(400);
        String rectErr = RectangularResultValidator.validate(gProb, badRect);
        assertNotNull(rectErr);
        assertTrue(rectErr.contains("对花"), "矩形终检应拦截对花误差：" + rectErr);

        // 阶段 1 预检：启用对花但未声明 repeatYMm -> INVALID_INPUT
        Material noRepeatMat = new Material("m-no-rep", Shape.rectangle(1000, 1000), List.of(), false);
        NestingResult missingRepeat = factory.solve(new NestingProblem("1", "mm", noRepeatMat,
                List.of(matchedContour), contourProcess(), "javairregular", 5));
        assertEquals("INVALID_INPUT", missingRepeat.status());
    }

    // ==================== 向后兼容与适配器透传 ====================

    @Test
    void backwardCompatibility_legacyProblemUsesNoopAndProducesIdenticalJson() throws Exception {
        NestingProblem legacy = new NestingProblem(
                "1", "mm",
                new Material("roll-1", Shape.rectangle(1500, 3000),
                        List.of(new Exclusion(1, 200, 300, Shape.rectangle(50, 40), 20)), false),
                List.of(new Part(1, "P1", Shape.rectangle(500, 600), 2, false)),
                guillotineProcess(), "javaguillotine", 5
        );

        assertSame(ConstraintPipeline.NOOP, CurtainConstraintPack.forProblem(legacy),
                "旧请求必须命中零开销 ConstraintPipeline.NOOP 单例");

        String json = JSON.writeValueAsString(legacy);
        assertFalse(json.contains("fabricRule"), "旧请求 JSON 不得包含 fabricRule：" + json);
        assertFalse(json.contains("\"rule\""), "旧请求 JSON 不得包含 rule：" + json);
        assertFalse(json.contains("severity"), "旧请求 JSON 不得包含 severity：" + json);
        assertFalse(json.contains("avoidancePolicy"), "旧请求 JSON 不得包含 avoidancePolicy：" + json);
        assertFalse(json.contains("auxiliary"), "旧请求 JSON 不得序列化 isAuxiliary：" + json);
    }

    @Test
    void adapter_preservesNullForDefaultStrictDefectAndPassesThroughCustomMetadata() {
        SolveRequest req = new SolveRequest();
        req.setRollW(1500);
        req.setRollL(3000);
        req.setAllowLongitudinal(true);
        req.setDemands(List.of(new PieceDemand(1, "帘身", 600, 800, 1, false)));

        Defect defaultDefect = new Defect(1, 100, 100, 30, 30, 20);
        Defect customMildDefect = new Defect(2, 400, 400, 30, 30, 10,
                "SLUB", "粗节", 1, 1, "AI_VISION_SCANNER", "PENETRABLE", "轻微粗节");
        req.setDefects(List.of(defaultDefect, customMildDefect));

        NestingProblem problem = FabricSolveAdapter.toProblem(req);
        Exclusion e1 = problem.material().exclusions().get(0);
        Exclusion e2 = problem.material().exclusions().get(1);

        assertNull(e1.severity(), "默认严格疵点保持 severity=null 以确保旧 inputHash 不变");
        assertNull(e1.avoidancePolicy(), "默认严格疵点保持 avoidancePolicy=null 以确保旧 inputHash 不变");
        assertEquals(1, e2.severity());
        assertEquals("PENETRABLE", e2.avoidancePolicy());
    }

    @Test
    void p09_curtainConstraintsSkipAvailableNativeEnginesAndRouteToAutonomousEngines() {
        var nativeGuillotineCalls = new java.util.concurrent.atomic.AtomicInteger();
        ICutSolverEngine availableNativeRect = new ICutSolverEngine() {
            @Override public String getEngineType() { return "packingsolver"; }
            @Override public boolean isAvailable() { return true; }
            @Override public com.example.cutdemotwo.contracts.nesting.EngineCapabilities capabilities() {
                return new com.example.cutdemotwo.contracts.nesting.EngineCapabilities(
                        "packingsolver", "2", List.of("RECTANGLE"), List.of("GUILLOTINE"),
                        List.of("MAXIMIZE_PIECE_AREA"), 0.1, true);
            }
            @Override public EngineResult solve(NestingProblem p) {
                nativeGuillotineCalls.incrementAndGet();
                var res = new JavaGuillotineSolverEngine().solve(p);
                return res;
            }
        };
        var nativeIrregularCalls = new java.util.concurrent.atomic.AtomicInteger();
        ICutSolverEngine availableNativeContour = new ICutSolverEngine() {
            @Override public String getEngineType() { return "packingsolver-irregular"; }
            @Override public boolean isAvailable() { return true; }
            @Override public com.example.cutdemotwo.contracts.nesting.EngineCapabilities capabilities() {
                return new com.example.cutdemotwo.contracts.nesting.EngineCapabilities(
                        "packingsolver-irregular", "1", List.of("RECTANGLE", "POLYGON"), List.of("CONTOUR"),
                        List.of("MAXIMIZE_PIECE_AREA"), 0.1, true);
            }
            @Override public EngineResult solve(NestingProblem p) {
                nativeIrregularCalls.incrementAndGet();
                return new DeepnestSolverEngine().solve(p);
            }
        };
        SolverFactory factory = new SolverFactory(List.of(
                availableNativeRect, availableNativeContour,
                new JavaGuillotineSolverEngine(), new DeepnestSolverEngine()), true);

        FabricRule selvedge = new FabricRule(30.0, 20.0, false, null, null);
        Material curtainMat = new Material("m-p09", Shape.rectangle(1000, 800), List.of(), false, selvedge);
        Part part = new Part(1, "主帘", Shape.rectangle(900, 300), 2, false);

        // 1. GUILLOTINE + auto + 窗帘规则：自动跳过可用原生 packingsolver，路由至 javaguillotine
        NestingResult autoRect = factory.solve(new NestingProblem("1", "mm", curtainMat, List.of(part), guillotineProcess(), "auto", 5), false);
        assertTrue(autoRect.feasible(), autoRect.message());
        assertEquals("javaguillotine", autoRect.engine());
        assertNotNull(autoRect.fallbackReason());
        assertTrue(autoRect.fallbackReason().contains("窗帘"), autoRect.fallbackReason());
        assertEquals(0, nativeGuillotineCalls.get(), "带窗帘约束时不得调用原生 packingsolver");
        for (var p : autoRect.placements()) {
            assertTrue(p.x() >= 30.0 - 0.001 && p.x() + p.shape().width() <= 980.0 + 0.001);
        }

        // 2. GUILLOTINE + 显式 packingsolver + 窗帘规则（allowFallback=true）：跳过原生并路由至 javaguillotine
        NestingResult explicitRect = factory.solve(new NestingProblem("1", "mm", curtainMat, List.of(part), guillotineProcess(), "packingsolver", 5), true);
        assertTrue(explicitRect.feasible(), explicitRect.message());
        assertEquals("javaguillotine", explicitRect.engine());
        assertEquals("packingsolver", explicitRect.requestedEngine());
        assertNotNull(explicitRect.fallbackReason());
        assertEquals(0, nativeGuillotineCalls.get());

        // 3. GUILLOTINE + 显式 packingsolver + 窗帘规则（allowFallback=false）：明确拒绝 UNSUPPORTED，不误发给原生引擎
        NestingResult strictRect = factory.solve(new NestingProblem("1", "mm", curtainMat, List.of(part), guillotineProcess(), "packingsolver", 5), false);
        assertEquals("UNSUPPORTED", strictRect.status());
        assertEquals(0, nativeGuillotineCalls.get());

        // 4. CONTOUR + 显式 packingsolver-irregular + 窗帘规则（allowFallback=true）：跳过原生并路由至 deepnest
        NestingResult explicitContour = factory.solve(new NestingProblem("1", "mm", curtainMat, List.of(part), contourProcess(), "packingsolver-irregular", 5), true);
        assertTrue(explicitContour.feasible(), explicitContour.message());
        assertEquals("deepnest", explicitContour.engine());
        assertEquals("packingsolver-irregular", explicitContour.requestedEngine());
        assertNotNull(explicitContour.fallbackReason());
        assertEquals(0, nativeIrregularCalls.get());

        // 5. 无窗帘规则的常规直刀问题仍照常命中可用原生 packingsolver，向后兼容
        Material plainMat = new Material("m-plain", Shape.rectangle(1000, 800), List.of(), false);
        NestingResult plainRect = factory.solve(new NestingProblem("1", "mm", plainMat, List.of(part), guillotineProcess(), "auto", 5), true);
        assertTrue(plainRect.feasible());
        assertEquals("packingsolver", plainRect.engine());
        assertEquals(1, nativeGuillotineCalls.get());
    }
}
