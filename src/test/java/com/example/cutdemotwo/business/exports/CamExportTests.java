package com.example.cutdemotwo.business.exports;

import com.example.cutdemotwo.algorithm.toolpath.ToolpathOptimizerService;
import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.persistence.FileInventoryStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.awt.geom.Line2D;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * M4-2 生产级 CAM 导出引擎单元测试（DXF R12 / LWPOLYLINE / AAMA、HPGL PLT、高级 CNC G-Code）。
 */
class CamExportTests {

    @TempDir
    Path tempDir;

    private static List<Point> circleRing(double cx, double cy, double r, int segments) {
        List<Point> pts = new ArrayList<>(segments);
        for (int i = 0; i < segments; i++) {
            double ang = (2.0 * Math.PI * i) / segments;
            pts.add(new Point(cx + r * Math.cos(ang), cy + r * Math.sin(ang)));
        }
        return pts;
    }

    private RemnantService createSeededService(String stateName) {
        RemnantService svc = new RemnantService(new FileInventoryStore(tempDir.resolve(stateName).toString()), false);
        MotherRollInfo roll = new MotherRollInfo("ROLL-CAM-01", "CAM-TC", 2000.0, 20000.0, 0, 0.0);
        roll.setInspectionStatus("PASSED");
        svc.saveOrUpdateMotherRoll(roll);
        Defect defect = new Defect(0, 120.0, 1500.0, 50.0, 40.0, 20.0, "HOLE", "破洞", 3, 3, "MANUAL", "MUST_AVOID", "Test flaw");
        svc.addDefectToRoll("ROLL-CAM-01", defect);

        // 构造含 24 顶点圆形小孔（半径 10mm <= 30mm）与矩形大孔的异形多边形裁片
        List<Point> outerVerts = List.of(
                new Point(0, 0), new Point(400, 0), new Point(400, 300),
                new Point(280, 300), new Point(0, 220)
        );
        List<Point> smallCircleHole = circleRing(80, 80, 10, 24);
        List<Point> largeRectHole = List.of(
                new Point(160, 60), new Point(260, 60), new Point(260, 160), new Point(160, 160)
        );
        Shape complexShape = new Shape("POLYGON", 400, 300, outerVerts, List.of(smallCircleHole, largeRectHole));
        Shape smallRect = Shape.rectangle(120, 80);

        SchedulingScheme contourScheme = new SchedulingScheme(
                "SCH-CAM-CONTOUR", "key-cam-contour", "异形带孔工单", "NESTING_2D",
                "SC-1", "STR-1", "轮廓优先", "TASK-1", "测试任务", "EXT-1",
                "STOCK_ROLL", "ROLL-CAM-01", null, "CAM-TC",
                2000.0, 3000.0, 1000.0, 1200.0, 10.0, 5.0, 72.5, 0.12,
                2, 2, 0, true, Map.of("1", 2), List.of("P-1"), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(
                                new SchedulingScheme.PlacementItem(1, 1, "BigPiece", 100, 100, 400, 300, 0, false, complexShape),
                                new SchedulingScheme.PlacementItem(2, 2, "SmallPiece", 600, 150, 120, 80, 90, false, smallRect)
                        ),
                        List.of(new SchedulingScheme.LeftoverItem("REM-L1", 800, 0, 1200, 3000, false)),
                        List.of()
                ),
                null, null, "2026-11-27 10:00:00", null, null, null, null
        );

        // 直刀切割方案（含共边测试线段）
        SchedulingScheme straightScheme = new SchedulingScheme(
                "SCH-CAM-CUTS", "key-cam-cuts", "直刀共边工单", "NESTING_2D",
                "SC-1", "STR-2", "直刀优化", "TASK-1", "测试任务", "EXT-2",
                "STOCK_ROLL", "ROLL-CAM-01", null, "CAM-TC",
                2000.0, 2000.0, 0.0, 1000.0, 0.0, 0.0, 80.0, 1.0,
                1, 1, 0, true, Map.of("1", 1), List.of("P-2"), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(new SchedulingScheme.PlacementItem(1, 1, "RectA", 0, 0, 500, 500, 0, false, Shape.rectangle(500, 500))),
                        List.of(),
                        List.of(
                                new SchedulingScheme.CutLineItem(1, "横切", 0, 500, 500, 500),
                                new SchedulingScheme.CutLineItem(2, "横切", 0, 500, 500, 500),
                                new SchedulingScheme.CutLineItem(3, "纵切", 500, 0, 500, 500)
                        )
                ),
                null, null, "2026-11-27 10:05:00", null, null, null, null
        );

        SchedulingScheme slittingScheme = new SchedulingScheme(
                "SCH-1D-01", "key-1d", "1D分切", "SLITTING_1D",
                "SC-1", "STR-1D", "1D", "TASK-1D", "分切任务", "EXT-1D",
                "VIRTUAL_ROLL", null, null, "CAM-TC",
                1600.0, 0.0, 0.0, 0.0, 0.0, 0.0, 95.0, 10.0,
                10, 10, 0, true, Map.of(), List.of(), null,
                SchedulingScheme.STATE_AWAITING_ROLL, null, null,
                new SchedulingScheme.Slitting1DPayload(10, 10, 100, 1600, 1, 0, 1000, 2, 0, 0, List.of(), List.of()),
                null, "2026-11-27 10:10:00", null, null, null, null
        );

        svc.inWrite("TEST_SEED", "SEED", "TEST", tx -> {
            tx.putScheme(contourScheme);
            tx.putScheme(straightScheme);
            tx.putScheme(slittingScheme);
            return null;
        });
        return svc;
    }

    @Test
    void exportsDxfR12LwPolylineAamaAndHpglWithHolesDefectsAndExactScaling() {
        RemnantService svc = createSeededService("cam-dxf-plt.json");
        CamExportService cam = new CamExportService(svc, new ToolpathOptimizerService());

        // 1. dxf_r12: AC1009, $INSUNITS=4, 7图层, 裁片外轮廓/内孔/余料/窗口疵点(global y=1500 - winStart=1000 => y=500)
        String r12 = new String(cam.exportCam("SCH-CAM-CONTOUR", "dxf_r12", CamExportOptions.defaults()).bytes(), StandardCharsets.UTF_8);
        assertTrue(r12.contains("AC1009"));
        assertTrue(r12.contains("$INSUNITS"));
        for (String layer : List.of("0_FABRIC_BORDER", "1_PIECES", "1_PIECES_HOLES", "2_REMNANTS", "3_DEFECTS", "4_CUT_LINES", "5_RAPID_TRAVERSE")) {
            assertTrue(r12.contains(layer), "缺少 R12 图层: " + layer);
        }
        assertTrue(r12.contains("1_PIECES_HOLES"));
        assertTrue(r12.contains("DEFECT #"));

        // 2. dxf_lwpolyline: AC1015, LWPOLYLINE, 闭合标志 70=1
        String lw = new String(cam.exportCam("SCH-CAM-CONTOUR", "dxf_lwpolyline", CamExportOptions.defaults()).bytes(), StandardCharsets.UTF_8);
        assertTrue(lw.contains("AC1015"));
        assertTrue(lw.contains("0\nLWPOLYLINE\n8\n1_PIECES\n"));
        assertTrue(lw.contains("0\nLWPOLYLINE\n8\n1_PIECES_HOLES\n"));
        assertTrue(lw.contains("\n70\n1\n"));

        // 3. dxf_aama: BLOCKS + INSERT + Layer 1/7/8/11
        String aama = new String(cam.exportCam("SCH-CAM-CONTOUR", "dxf_aama", CamExportOptions.defaults()).bytes(), StandardCharsets.UTF_8);
        assertTrue(aama.contains("0\nSECTION\n2\nBLOCKS\n"));
        assertTrue(aama.contains("0\nBLOCK\n"));
        assertTrue(aama.contains("0\nENDBLK\n"));
        assertTrue(aama.contains("0\nINSERT\n"));
        assertTrue(aama.contains("\n8\n11\n"));
        assertTrue(aama.contains("\n8\n7\n"));
        assertTrue(aama.contains("\n8\n8\n"));

        // 4. plt (HPGL): IN;PA;, SP1/SP2/SP3, PU0,0;SP0;, 1 mm = 40 units (width=2000 -> 80000, bed=3000 -> 120000)
        String plt = new String(cam.exportCam("SCH-CAM-CONTOUR", "plt", CamExportOptions.defaults()).bytes(), StandardCharsets.UTF_8);
        assertTrue(plt.startsWith("IN;PA;"));
        assertTrue(plt.contains("SP3;"));
        assertTrue(plt.contains("SP2;"));
        assertTrue(plt.contains("SP1;"));
        assertTrue(plt.contains("80000,120000"));
        assertTrue(plt.trim().endsWith("PU0,0;SP0;"));
    }

    @Test
    void exportsAdvancedCncGCodeWithArcFittingOvercutToolChangeAndCommonEdgeDedup() {
        RemnantService svc = createSeededService("cam-nc.json");
        CamExportService cam = new CamExportService(svc, new ToolpathOptimizerService());

        // 1. 异形方案：小件优先 + 先内孔后外轮廓 + 小圆孔 G02/G03 拟合 + 刀头切换 M06 T11/T12 + overcut
        CamExportOptions contourOpt = new CamExportOptions(2.5, 4.0, 0.0, false, "T11", "T12", "T13");
        String ncContour = new String(cam.exportCam("SCH-CAM-CONTOUR", "nc", contourOpt).bytes(), StandardCharsets.UTF_8);
        assertTrue(ncContour.contains("M06 T11"));
        assertTrue(ncContour.contains("M06 T12"));
        assertTrue(ncContour.contains("G02") || ncContour.contains("G03"), "24顶点圆孔应拟合输出 G02/G03 圆弧指令");
        assertTrue(ncContour.contains("Lead-In"));
        assertTrue(ncContour.contains("Overcut 2.50mm"));
        // 小件 SmallPiece 应优先于大件 BigPiece 出现
        int smallIdx = ncContour.indexOf("SmallPiece");
        int bigOuterIdx = ncContour.indexOf("BigPiece [OUTER CONTOUR]");
        assertTrue(smallIdx > 0 && bigOuterIdx > smallIdx, "小件应先于大件外轮廓切割");
        // 大件内孔先于大件外轮廓
        int bigHoleIdx = ncContour.indexOf("BigPiece [INNER HOLE");
        assertTrue(bigHoleIdx > 0 && bigHoleIdx < bigOuterIdx, "大件内孔应先于大件外轮廓切割");

        // 2. 直刀方案：共边去重后只有 2 条有效切段（3条中2条重合被去重）+ overcut 延长但夹在 [0..2000]
        CamExportOptions straightOpt = new CamExportOptions(3.0, 0.0, 0.0, true, "T01", "T02", "T03");
        String ncStraight = new String(cam.exportCam("SCH-CAM-CUTS", "nc", straightOpt).bytes(), StandardCharsets.UTF_8);
        long cutMoves = ncStraight.lines().filter(l -> l.startsWith("G01 ")).count();
        assertEquals(2, cutMoves, "2条完全重合横切线段去重后应只保留1条横切 + 1条纵切");
        assertTrue(ncStraight.contains("X503.000"), "纵向过切终点应延伸 3mm 至 503.000");

        // 3. 参数与维度拦截
        assertThrows(IllegalArgumentException.class, () -> new CamExportOptions(-0.1, 0, 0, false, null, null, null));
        assertThrows(IllegalArgumentException.class, () -> new CamExportOptions(0, 101, 0, false, null, null, null));
        assertThrows(IllegalArgumentException.class, () -> new CamExportOptions(0, 0, 0, false, "INVALID", null, null));
        assertThrows(IllegalArgumentException.class, () -> cam.exportCam("SCH-1D-01", "nc", CamExportOptions.defaults()));
        assertThrows(ExportNotFoundException.class, () -> cam.exportCam("SCH-MISSING", "nc", CamExportOptions.defaults()));
    }

    @Test
    void preventsSemiCircleMisfitKeepsHoleToolpathOnDedupAndKeepsOvercutCollinearAndBounded() {
        RemnantService svc = new RemnantService(new FileInventoryStore(tempDir.resolve("cam-regressions.json").toString()), false);
        svc.saveOrUpdateMotherRoll(new MotherRollInfo("ROLL-REG-01", "CAM-TC", 1000.0, 20000.0, 0, 0.0));

        // 1. 9 顶点半圆 D 形多边形（全部顶点距圆心 R=50mm 等距，第 9 点直接连回第 1 点形成 100mm 直弦边）
        List<Point> semiCirclePts = new ArrayList<>(9);
        for (int i = 0; i < 9; i++) {
            double ang = (Math.PI * i) / 8.0;
            semiCirclePts.add(new Point(50.0 + 50.0 * Math.cos(ang), 50.0 + 50.0 * Math.sin(ang)));
        }
        Shape semiCircleShape = new Shape("POLYGON", 100.0, 100.0, semiCirclePts, List.of());
        SchedulingScheme semiScheme = new SchedulingScheme(
                "SCH-SEMI-D", "k-semi-d", "半圆D形", "NESTING_2D",
                "SC-1", "STR-SEMI", "半圆", "TASK-R1", "测试", "EXT-R1",
                "STOCK_ROLL", "ROLL-REG-01", null, "CAM-TC",
                1000.0, 1000.0, 0.0, 500.0, 0.0, 0.0, 70.0, 1.0,
                1, 1, 0, true, Map.of("1", 1), List.of(), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(new SchedulingScheme.PlacementItem(1, 1, "SemiCircleArc", 100, 100, 100, 100, 0, false, semiCircleShape)),
                        List.of(), List.of()
                ),
                null, null, "2026-11-27 11:00:00", null, null, null, null
        );

        // 2. 共边两矩形 + 其中一件带 24 顶点圆孔（半径 10mm <= 小孔冲孔阈值），开启共边去重
        List<Point> smallCircleHole = circleRing(50, 50, 10, 24);
        Shape rectWithHole = new Shape("POLYGON", 200, 200,
                List.of(new Point(0, 0), new Point(200, 0), new Point(200, 200), new Point(0, 200)),
                List.of(smallCircleHole));
        Shape adjRect = Shape.rectangle(200, 200);
        SchedulingScheme dedupHoleScheme = new SchedulingScheme(
                "SCH-DEDUP-HOLE", "k-dedup-hole", "共边带圆孔", "NESTING_2D",
                "SC-1", "STR-DH", "共边带孔", "TASK-R2", "测试", "EXT-R2",
                "STOCK_ROLL", "ROLL-REG-01", null, "CAM-TC",
                1000.0, 1000.0, 0.0, 500.0, 0.0, 0.0, 80.0, 1.0,
                2, 2, 0, true, Map.of("1", 2), List.of(), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(
                                new SchedulingScheme.PlacementItem(1, 1, "RectHole", 100, 100, 200, 200, 0, false, rectWithHole),
                                new SchedulingScheme.PlacementItem(2, 2, "RectAdj", 300, 100, 200, 200, 0, false, adjRect)
                        ),
                        List.of(), List.of()
                ),
                null, null, "2026-11-27 11:05:00", null, null, null, null
        );

        // 3. 斜切过切（(10,5)->(990,995) 在 1000x1000 工位上启用 20mm 过切）
        SchedulingScheme diagScheme = new SchedulingScheme(
                "SCH-DIAG-OVERCUT", "k-diag", "斜线过切", "NESTING_2D",
                "SC-1", "STR-DIAG", "斜切", "TASK-R3", "测试", "EXT-R3",
                "STOCK_ROLL", "ROLL-REG-01", null, "CAM-TC",
                1000.0, 1000.0, 0.0, 1000.0, 0.0, 0.0, 80.0, 1.0,
                1, 1, 0, true, Map.of("1", 1), List.of(), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(new SchedulingScheme.PlacementItem(1, 1, "Box", 10, 5, 980, 990, 0, false, Shape.rectangle(980, 990))),
                        List.of(),
                        List.of(new SchedulingScheme.CutLineItem(1, "轮廓切", 10, 5, 990, 995))
                ),
                null, null, "2026-11-27 11:10:00", null, null, null, null
        );

        // 4. 超短边防穿件过切测试：5x5 mm SmallA @ (100,100) 与 NeighborB @ (107,100)，间隔 2mm
        SchedulingScheme smallEdgeScheme = new SchedulingScheme(
                "SCH-SMALL-OVERCUT", "k-small-ov", "短边防穿件", "NESTING_2D",
                "SC-1", "STR-SO", "短边", "TASK-R4", "测试", "EXT-R4",
                "STOCK_ROLL", "ROLL-REG-01", null, "CAM-TC",
                1000.0, 1000.0, 0.0, 500.0, 0.0, 0.0, 50.0, 1.0,
                2, 2, 0, true, Map.of("1", 2), List.of(), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(
                                new SchedulingScheme.PlacementItem(1, 1, "SmallA", 100, 100, 5, 5, 0, false, Shape.rectangle(5, 5)),
                                new SchedulingScheme.PlacementItem(2, 2, "NeighborB", 107, 100, 50, 50, 0, false, Shape.rectangle(50, 50))
                        ),
                        List.of(), List.of()
                ),
                null, null, "2026-11-27 11:15:00", null, null, null, null
        );

        svc.inWrite("SEED_REGRESSIONS", "SEED", "TEST", tx -> {
            tx.putScheme(semiScheme);
            tx.putScheme(dedupHoleScheme);
            tx.putScheme(diagScheme);
            tx.putScheme(smallEdgeScheme);
            return null;
        });

        CamExportService cam = new CamExportService(svc, new ToolpathOptimizerService());

        // 断言 1：半圆 D 形绝不输出 G02/G03
        String ncSemi = new String(cam.exportCam("SCH-SEMI-D", "nc", CamExportOptions.defaults()).bytes(), StandardCharsets.UTF_8);
        assertFalse(ncSemi.contains("G02"), "半圆 D 形件不应误拟合为整圆 G02");
        assertFalse(ncSemi.contains("G03"), "半圆 D 形件不应误拟合为整圆 G03");
        long semiG01Count = ncSemi.lines().filter(l -> l.startsWith("G01 ")).count();
        assertEquals(9, semiG01Count, "半圆 D 形 9 顶点应精确输出 9 条 G01（含直径直弦边）");

        // 断言 2：共边去重=true 保留小圆孔 M06 T02、G02/G03、Lead-In 与 Overcut，同时外轮廓共边被去重
        CamExportOptions dedupOpt = new CamExportOptions(5.0, 4.0, 0.0, true, "T01", "T02", "T03");
        String ncDedup = new String(cam.exportCam("SCH-DEDUP-HOLE", "nc", dedupOpt).bytes(), StandardCharsets.UTF_8);
        assertTrue(ncDedup.contains("M06 T02"), "开启共边去重时小圆孔仍须切换冲孔刀 T02");
        assertTrue(ncDedup.contains("M06 T01"), "开启共边去重时外轮廓仍须切换主切刀 T01");
        assertTrue(ncDedup.contains("G02") || ncDedup.contains("G03"), "开启共边去重时圆形内孔仍须输出 G02/G03");
        assertTrue(ncDedup.contains("Lead-In"), "开启共边去重时内孔引入线不得丢失");
        assertTrue(ncDedup.contains("Overcut"), "开启共边去重时应保留安全过切");
        String outerSection = ncDedup.substring(ncDedup.indexOf("M06 T01"));
        long pureOuterG01AfterDedup = outerSection.lines()
                .filter(l -> l.startsWith("G01 ") && !l.contains("(Lead-In)") && !l.contains("(Overcut"))
                .count();
        // 2 个矩形原 8 条外轮廓边，去重 1 条共边后纯轮廓 G01 应精确剩余 7 条，且保留安全引入线与过切
        assertEquals(7, pureOuterG01AfterDedup,
                "去重后纯外轮廓 G01 行数应精确为 7，实际=" + pureOuterG01AfterDedup);
        assertTrue(outerSection.contains("(Lead-In)"), "去重外轮廓链应保留废料区安全 Lead-In");

        // 断言 3：斜线过切射线截断严格共线且在工位矩形内
        CamExportOptions diagOpt = new CamExportOptions(20.0, 0.0, 0.0, false, "T01", "T02", "T03");
        String ncDiag = new String(cam.exportCam("SCH-DIAG-OVERCUT", "nc", diagOpt).bytes(), StandardCharsets.UTF_8);
        String g00Line = ncDiag.lines().filter(l -> l.startsWith("G00 ") && l.contains("Z10.000")).findFirst().orElseThrow();
        String g01Line = ncDiag.lines().filter(l -> l.startsWith("G01 ")).findFirst().orElseThrow();
        double sx = extractCoord(g00Line, 'X');
        double sy = extractCoord(g00Line, 'Y');
        double ex = extractCoord(g01Line, 'X');
        double ey = extractCoord(g01Line, 'Y');
        assertTrue(sx >= 0.0 && sx <= 1000.0 && sy >= 0.0 && sy <= 1000.0);
        assertTrue(ex >= 0.0 && ex <= 1000.0 && ey >= 0.0 && ey <= 1000.0);
        double lineLen = Math.hypot(990.0 - 10.0, 995.0 - 5.0);
        double startPerp = Math.abs((sx - 10.0) * (995.0 - 5.0) - (sy - 5.0) * (990.0 - 10.0)) / lineLen;
        double endPerp = Math.abs((ex - 10.0) * (995.0 - 5.0) - (ey - 5.0) * (990.0 - 10.0)) / lineLen;
        assertEquals(0.0, startPerp, 1e-2, "斜切过切起点必须严格共线");
        assertEquals(0.0, endPerp, 1e-2, "斜切过切终点必须严格共线");

        // 断言 4：5x5 mm 短边在 overcutMm=20 时过切限幅不超过首边长，绝不穿过 2mm 间隙切入 NeighborB(@107)
        CamExportOptions smallOpt = new CamExportOptions(20.0, 0.0, 0.0, false, "T01", "T02", "T03");
        String ncSmall = new String(cam.exportCam("SCH-SMALL-OVERCUT", "nc", smallOpt).bytes(), StandardCharsets.UTF_8);
        assertFalse(ncSmall.contains("X120.000"), "5mm 短边禁止冲过首边延伸到 X120");
        assertTrue(ncSmall.contains("Overcut 5.00mm"), "5mm 短边过切应受限幅至 5.00mm");
    }

    @Test
    void verifiesMixedContourDedupArcMicroJointLeadInOvercutAndPunchSynergy() {
        RemnantService svc = new RemnantService(new FileInventoryStore(tempDir.resolve("cam-mixed-synergy.json").toString()), false);
        svc.saveOrUpdateMotherRoll(new MotherRollInfo("ROLL-MIX-01", "CAM-TC", 1500.0, 20000.0, 0, 0.0));

        // 混合方案：共边双矩形（含小圆孔 R=10、大圆孔 R=35）+ 独立外圆 R=60
        List<Point> smallHole = circleRing(50, 50, 10, 24);
        List<Point> largeHole = circleRing(120, 120, 35, 24);
        Shape rectWithHoles = new Shape("POLYGON", 200, 200,
                List.of(new Point(0, 0), new Point(200, 0), new Point(200, 200), new Point(0, 200)),
                List.of(smallHole, largeHole));
        Shape rectAdj = Shape.rectangle(200, 200);
        Shape circleOuter = new Shape("POLYGON", 120, 120, circleRing(60, 60, 60, 24), List.of());

        SchedulingScheme mixedScheme = new SchedulingScheme(
                "SCH-MIXED-DEDUP", "k-mixed", "混合协同方案", "NESTING_2D",
                "SC-1", "STR-MIX", "混合", "TASK-M1", "测试", "EXT-M1",
                "STOCK_ROLL", "ROLL-MIX-01", null, "CAM-TC",
                1500.0, 1000.0, 0.0, 800.0, 0.0, 0.0, 75.0, 1.0,
                3, 3, 0, true, Map.of("1", 3), List.of(), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(
                                new SchedulingScheme.PlacementItem(1, 1, "RectWithHoles", 100, 100, 200, 200, 0, false, rectWithHoles),
                                new SchedulingScheme.PlacementItem(2, 2, "RectAdj", 300, 100, 200, 200, 0, false, rectAdj),
                                new SchedulingScheme.PlacementItem(3, 3, "CircleOuter", 700, 100, 120, 120, 0, false, circleOuter)
                        ),
                        List.of(), List.of()
                ),
                null, null, "2026-11-27 12:00:00", null, null, null, null
        );
        svc.inWrite("SEED_MIX", "SEED", "TEST", tx -> {
            tx.putScheme(mixedScheme);
            return null;
        });

        CamExportService cam = new CamExportService(svc, new ToolpathOptimizerService());

        // 模式 A：microJoint=2.0 + dedup=true + overcut=5.0 + leadIn=4.0 + punch=T02
        CamExportOptions modeA = new CamExportOptions(5.0, 4.0, 2.0, true, "T01", "T02", "T03");
        String ncA = new String(cam.exportCam("SCH-MIXED-DEDUP", "nc", modeA).bytes(), StandardCharsets.UTF_8);
        assertTrue(ncA.contains("M06 T02"), "模式 A：小圆孔须切换冲孔刀 T02");
        assertTrue(ncA.contains("M06 T01"), "模式 A：大孔与外轮廓须切换主切刀 T01");
        long arcCountA = ncA.lines().filter(l -> l.startsWith("G02 ") || l.startsWith("G03 ")).count();
        assertTrue(arcCountA >= 5, "模式 A：2个圆孔(整圆+过切) + 1个带微连接外圆应至少输出 5 条 G02/G03，实际=" + arcCountA);
        assertTrue(ncA.contains("Micro-Joint 2.00mm"), "模式 A：外圆应保留 2.00mm 微连接优弧注释");
        long overcutCountA = ncA.lines().filter(l -> l.contains("(Overcut")).count();
        assertEquals(2, overcutCountA, "模式 A：2 个废料内孔免微连接保留 Overcut，外轮廓因有微连接不输出 Overcut");

        String circleOuterBlockA = extractSection(ncA, "CircleOuter [OUTER CONTOUR]", "M05");
        assertTrue(circleOuterBlockA.contains("(Lead-In)"), "模式 A：CircleOuter 应保留 Lead-In");
        assertTrue(circleOuterBlockA.contains("G03 ") || circleOuterBlockA.contains("G02 "), "模式 A：CircleOuter 应走单条 G02/G03");
        assertEquals(0, circleOuterBlockA.lines().filter(l -> l.startsWith("G01 ") && !l.contains("(Lead-In)")).count(),
                "模式 A：CircleOuter 不得被打散为多段 G01");
        assertFalse(circleOuterBlockA.contains("(Overcut"), "模式 A：带微连接的外圆不得输出 Overcut");

        String dedupSectionA = ncA.substring(ncA.indexOf("Deduplicated Outer Contour Cut"));
        long pureDedupG01A = dedupSectionA.lines()
                .filter(l -> l.startsWith("G01 ") && !l.contains("(Lead-In)") && !l.contains("(Overcut"))
                .count();
        assertEquals(7, pureDedupG01A, "模式 A：共边矩形去重后纯外轮廓 G01 应精确为 7 条");
        assertTrue(dedupSectionA.contains("(Lead-In)"), "模式 A：去重外轮廓链应生成废料区安全 Lead-In");
        assertDedupLeadInPierceSafe(dedupSectionA, 100.0, 100.0, 500.0, 300.0);
        assertFalse(dedupSectionA.contains("(Overcut"), "模式 A：microJoint=2.0 时去重外轮廓链不得输出 Overcut");
        assertAllMoveCoordsWithinBounds(ncA, 1500.0, 1000.0);

        // 模式 B：microJoint=0.0 + dedup=true + overcut=5.0 + leadIn=4.0 + punch=T02
        CamExportOptions modeB = new CamExportOptions(5.0, 4.0, 0.0, true, "T01", "T02", "T03");
        String ncB = new String(cam.exportCam("SCH-MIXED-DEDUP", "nc", modeB).bytes(), StandardCharsets.UTF_8);
        long arcCountB = ncB.lines().filter(l -> l.startsWith("G02 ") || l.startsWith("G03 ")).count();
        assertEquals(6, arcCountB, "模式 B：2内孔 + 1外圆共 3 个整圆加 3 条圆弧过切应精确输出 6 条 G02/G03");
        long overcutArcsB = ncB.lines().filter(l -> (l.startsWith("G02 ") || l.startsWith("G03 ")) && l.contains("(Overcut 5.00mm)")).count();
        assertEquals(3, overcutArcsB, "模式 B：3 个整圆均应保留 5.00mm 圆弧过切");
        String dedupSectionB = ncB.substring(ncB.indexOf("Deduplicated Outer Contour Cut"));
        long pureDedupG01B = dedupSectionB.lines()
                .filter(l -> l.startsWith("G01 ") && !l.contains("(Lead-In)") && !l.contains("(Overcut"))
                .count();
        assertEquals(7, pureDedupG01B, "模式 B：共边矩形去重后纯外轮廓 G01 应精确为 7 条");
        assertTrue(dedupSectionB.contains("(Lead-In)"), "模式 B：去重外轮廓链应保留安全 Lead-In");
        assertDedupLeadInPierceSafe(dedupSectionB, 100.0, 100.0, 500.0, 300.0);
        assertTrue(dedupSectionB.contains("(Overcut"), "模式 B：microJoint=0.0 时去重外轮廓链应保留安全过切");
        assertAllMoveCoordsWithinBounds(ncB, 1500.0, 1000.0);
    }

    @Test
    void verifiesCircularMicroJointCcwCwPrecisionAndOpenChainOvercutCollisionAvoidance() {
        RemnantService svc = new RemnantService(new FileInventoryStore(tempDir.resolve("cam-arc-collision.json").toString()), false);
        svc.saveOrUpdateMotherRoll(new MotherRollInfo("ROLL-ARC-01", "CAM-TC", 1500.0, 20000.0, 0, 0.0));

        // 1. CCW 与 CW 两个纯圆外轮廓 (R=50, 24 顶点)
        List<Point> ccwPts = circleRing(50, 50, 50, 24);
        List<Point> cwPts = new ArrayList<>(ccwPts);
        Collections.reverse(cwPts);
        SchedulingScheme circlesScheme = new SchedulingScheme(
                "SCH-ARC-MJ", "k-arc-mj", "CCW与CW圆弧微连接", "NESTING_2D",
                "SC-1", "STR-ARC", "圆弧", "TASK-A1", "测试", "EXT-A1",
                "STOCK_ROLL", "ROLL-ARC-01", null, "CAM-TC",
                1500.0, 1000.0, 0.0, 600.0, 0.0, 0.0, 60.0, 1.0,
                2, 2, 0, true, Map.of("1", 2), List.of(), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(
                                new SchedulingScheme.PlacementItem(1, 1, "CcwCircle", 100, 100, 100, 100, 0, false, new Shape("POLYGON", 100, 100, ccwPts, List.of())),
                                new SchedulingScheme.PlacementItem(2, 2, "CwCircle", 400, 100, 100, 100, 0, false, new Shape("POLYGON", 100, 100, cwPts, List.of()))
                        ),
                        List.of(), List.of()
                ),
                null, null, "2026-11-27 12:10:00", null, null, null, null
        );

        // 2. 开放去重链防穿邻件：RectBottom(100,100,100x100) 与 RectTop(100,200,100x100) 上下共边产生向右开放链末端，NeighborB(202,150,80x100) 间距 2mm 阻挡前方
        SchedulingScheme collisionScheme = new SchedulingScheme(
                "SCH-OPEN-CHAIN-SAFE", "k-open-safe", "开放链过切防碰撞", "NESTING_2D",
                "SC-1", "STR-OPEN", "防碰撞", "TASK-O1", "测试", "EXT-O1",
                "STOCK_ROLL", "ROLL-ARC-01", null, "CAM-TC",
                1500.0, 1000.0, 0.0, 600.0, 0.0, 0.0, 60.0, 1.0,
                3, 3, 0, true, Map.of("1", 3), List.of(), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(
                                new SchedulingScheme.PlacementItem(1, 1, "RectBottom", 100, 100, 100, 100, 0, false, Shape.rectangle(100, 100)),
                                new SchedulingScheme.PlacementItem(2, 2, "RectTop", 100, 200, 100, 100, 0, false, Shape.rectangle(100, 100)),
                                new SchedulingScheme.PlacementItem(3, 3, "NeighborB", 202, 150, 80, 100, 0, false, Shape.rectangle(80, 100))
                        ),
                        List.of(), List.of()
                ),
                null, null, "2026-11-27 12:15:00", null, null, null, null
        );

        svc.inWrite("SEED_ARC_COL", "SEED", "TEST", tx -> {
            tx.putScheme(circlesScheme);
            tx.putScheme(collisionScheme);
            return null;
        });

        CamExportService cam = new CamExportService(svc, new ToolpathOptimizerService());

        // 验证 T3：CCW (G03) 与 CW (G02) 圆弧微连接起点/终点半径精度与缺口弦长
        String ncArc = new String(cam.exportCam("SCH-ARC-MJ", "nc", new CamExportOptions(0.0, 4.0, 2.0, true, "T01", "T02", "T03")).bytes(), StandardCharsets.UTF_8);
        assertTrue(ncArc.contains("G03 "), "CCW 圆应输出 G03");
        assertTrue(ncArc.contains("G02 "), "CW 圆应输出 G02");
        assertEquals(0, ncArc.lines().filter(l -> l.startsWith("G01 ") && !l.contains("(Lead-In)")).count(),
                "纯圆外轮廓带微连接不得退化为 G01 折线");

        verifyCircularMicroJointArc(extractSection(ncArc, "CcwCircle [OUTER CONTOUR]", "M05"), "G03", 50.0, 2.0);
        verifyCircularMicroJointArc(extractSection(ncArc, "CwCircle [OUTER CONTOUR]", "M05"), "G02", 50.0, 2.0);

        // 验证 T4：开放去重链 overcutMm=10.0 绝不穿透 2mm 间隙进入 NeighborB [202..282] x [150..250]
        String ncSafe = new String(cam.exportCam("SCH-OPEN-CHAIN-SAFE", "nc", new CamExportOptions(10.0, 4.0, 0.0, true, "T01", "T02", "T03")).bytes(), StandardCharsets.UTF_8);
        double curX = 0.0, curY = 0.0;
        for (String line : ncSafe.lines().toList()) {
            if (line.startsWith("G00 ")) {
                curX = extractCoord(line, 'X');
                curY = extractCoord(line, 'Y');
            } else if (line.startsWith("G01 ")) {
                double nx = extractCoord(line, 'X');
                double ny = extractCoord(line, 'Y');
                double mx = 0.5 * (curX + nx);
                double my = 0.5 * (curY + ny);
                assertFalse(nx > 202.01 && nx < 281.99 && ny > 150.01 && ny < 249.99,
                        "G01 终点不应侵入 NeighborB 严格内部: " + line);
                assertFalse(mx > 202.01 && mx < 281.99 && my > 150.01 && my < 249.99,
                        "G01 中点不应穿透 NeighborB 严格内部: " + line);
                if (curX <= 200.5 && ny >= 149.9 && ny <= 250.1) {
                    assertTrue(nx <= 201.85,
                            "来自左侧共边件的切线/过切不得跨越 2mm 间隙碰撞 NeighborB（需留 >=0.15mm 余隙）: " + line);
                }
                curX = nx;
                curY = ny;
            }
        }
    }

    @Test
    void preventsCircularOuterContourLeadInFromPiercingCompactNeighbor() {
        RemnantService svc = new RemnantService(new FileInventoryStore(tempDir.resolve("cam-circle-leadin.json").toString()), false);
        svc.saveOrUpdateMotherRoll(new MotherRollInfo("ROLL-CL-01", "CAM-TC", 1000.0, 1000.0, 0, 0.0));

        Shape circleShape = new Shape("POLYGON", 120, 120, circleRing(60, 60, 60, 24), List.of());
        SchedulingScheme compactCircleScheme = new SchedulingScheme(
                "SCH-CIRC-BLOCK", "k-circ-blk", "纯圆紧邻阻挡", "NESTING_2D",
                "SC-1", "STR-CB", "纯圆", "TASK-CB1", "测试", "EXT-CB1",
                "STOCK_ROLL", "ROLL-CL-01", null, "CAM-TC",
                1000.0, 1000.0, 0.0, 600.0, 0.0, 0.0, 60.0, 1.0,
                2, 2, 0, true, Map.of("1", 2), List.of(), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(
                                new SchedulingScheme.PlacementItem(1, 1, "CircleBox", 200, 200, 120, 120, 0, false, circleShape),
                                new SchedulingScheme.PlacementItem(2, 2, "CornerBlocker", 303.5, 303.5, 50, 50, 0, false, Shape.rectangle(50, 50))
                        ),
                        List.of(), List.of()
                ),
                null, null, "2026-11-27 13:00:00", null, null, null, null
        );
        SchedulingScheme tightCircleScheme = new SchedulingScheme(
                "SCH-CIRC-TIGHT", "k-circ-tight", "纯圆极窄阻挡", "NESTING_2D",
                "SC-1", "STR-CT", "纯圆极窄", "TASK-CB2", "测试", "EXT-CB2",
                "STOCK_ROLL", "ROLL-CL-01", null, "CAM-TC",
                1000.0, 1000.0, 0.0, 600.0, 0.0, 0.0, 60.0, 1.0,
                2, 2, 0, true, Map.of("1", 2), List.of(), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(
                                new SchedulingScheme.PlacementItem(1, 1, "CircleBox", 200, 200, 120, 120, 0, false, circleShape),
                                new SchedulingScheme.PlacementItem(2, 2, "TightBlocker", 302.55, 302.55, 50, 50, 0, false, Shape.rectangle(50, 50))
                        ),
                        List.of(), List.of()
                ),
                null, null, "2026-11-27 13:05:00", null, null, null, null
        );
        svc.inWrite("SEED_CIRC_BLK", "SEED", "TEST", tx -> {
            tx.putScheme(compactCircleScheme);
            tx.putScheme(tightCircleScheme);
            return null;
        });

        CamExportService cam = new CamExportService(svc, new ToolpathOptimizerService());
        for (boolean dedup : new boolean[]{true, false}) {
            String nc = new String(cam.exportCam("SCH-CIRC-BLOCK", "nc", new CamExportOptions(0.0, 4.0, 0.0, dedup, "T01", "T02", "T03")).bytes(), StandardCharsets.UTF_8);
            String circleBlock = extractSection(nc, "CircleBox [OUTER CONTOUR]", "M05");
            assertTrue(circleBlock.contains("(Lead-In)"), "1.52mm 间隙应保留缩短后的安全 Lead-In，dedup=" + dedup);
            assertAllLeadInsAvoidRect(circleBlock, 303.5, 303.5, 353.5, 353.5, 0.199);
            assertAllMoveCoordsWithinBounds(nc, 1000.0, 1000.0);

            String ncTight = new String(cam.exportCam("SCH-CIRC-TIGHT", "nc", new CamExportOptions(0.0, 4.0, 0.0, dedup, "T01", "T02", "T03")).bytes(), StandardCharsets.UTF_8);
            String tightBlock = extractSection(ncTight, "CircleBox [OUTER CONTOUR]", "M05");
            assertAllLeadInsAvoidRect(tightBlock, 302.55, 302.55, 352.55, 352.55, 0.199);
        }
    }

    @Test
    void preventsNonDedupRectangularOuterContourLeadInFromPiercingCompactNeighbor() {
        RemnantService svc = new RemnantService(new FileInventoryStore(tempDir.resolve("cam-rect-leadin.json").toString()), false);
        svc.saveOrUpdateMotherRoll(new MotherRollInfo("ROLL-RL-01", "CAM-TC", 1000.0, 1000.0, 0, 0.0));

        SchedulingScheme cornerScheme = new SchedulingScheme(
                "SCH-RECT-CORNER", "k-rect-c", "矩形角阻挡", "NESTING_2D",
                "SC-1", "STR-RC", "矩形角", "TASK-RC1", "测试", "EXT-RC1",
                "STOCK_ROLL", "ROLL-RL-01", null, "CAM-TC",
                1000.0, 1000.0, 0.0, 600.0, 0.0, 0.0, 60.0, 1.0,
                2, 2, 0, true, Map.of("1", 2), List.of(), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(
                                new SchedulingScheme.PlacementItem(1, 1, "MainRect", 200, 200, 100, 100, 0, false, Shape.rectangle(100, 100)),
                                new SchedulingScheme.PlacementItem(2, 2, "CornerBlocker", 148.5, 148.5, 50, 50, 0, false, Shape.rectangle(50, 50))
                        ),
                        List.of(), List.of()
                ),
                null, null, "2026-11-27 13:10:00", null, null, null, null
        );
        SchedulingScheme wallScheme = new SchedulingScheme(
                "SCH-RECT-WALL", "k-rect-w", "矩形垂直墙阻挡", "NESTING_2D",
                "SC-1", "STR-RW", "矩形墙", "TASK-RC2", "测试", "EXT-RC2",
                "STOCK_ROLL", "ROLL-RL-01", null, "CAM-TC",
                1000.0, 1000.0, 0.0, 600.0, 0.0, 0.0, 60.0, 1.0,
                2, 2, 0, true, Map.of("1", 2), List.of(), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(
                                new SchedulingScheme.PlacementItem(1, 1, "MainRect", 200, 200, 100, 100, 0, false, Shape.rectangle(100, 100)),
                                new SchedulingScheme.PlacementItem(2, 2, "WallBlocker", 148.5, 150, 50, 100, 0, false, Shape.rectangle(50, 100))
                        ),
                        List.of(), List.of()
                ),
                null, null, "2026-11-27 13:15:00", null, null, null, null
        );
        svc.inWrite("SEED_RECT_BLK", "SEED", "TEST", tx -> {
            tx.putScheme(cornerScheme);
            tx.putScheme(wallScheme);
            return null;
        });

        CamExportService cam = new CamExportService(svc, new ToolpathOptimizerService());
        String ncCorner = new String(cam.exportCam("SCH-RECT-CORNER", "nc", new CamExportOptions(0.0, 4.0, 0.0, false, "T01", "T02", "T03")).bytes(), StandardCharsets.UTF_8);
        String rectCornerBlock = extractSection(ncCorner, "MainRect [OUTER CONTOUR]", "M05");
        assertTrue(rectCornerBlock.contains("(Lead-In)"), "1.5mm 角间隙应保留缩短后的安全 Lead-In");
        assertAllLeadInsAvoidRect(rectCornerBlock, 148.5, 148.5, 198.5, 198.5, 0.199);

        String ncWall = new String(cam.exportCam("SCH-RECT-WALL", "nc", new CamExportOptions(0.0, 4.0, 0.0, false, "T01", "T02", "T03")).bytes(), StandardCharsets.UTF_8);
        String rectWallBlock = extractSection(ncWall, "MainRect [OUTER CONTOUR]", "M05");
        assertTrue(rectWallBlock.contains("(Lead-In)"), "1.5mm 垂直墙间隙应保留缩短后的安全 Lead-In");
        assertAllLeadInsAvoidRect(rectWallBlock, 148.5, 150.0, 198.5, 250.0, 0.199);
    }

    @Test
    void preventsNestedHoleLeadInFromPiercingChildPartInsideHole() {
        RemnantService svc = new RemnantService(new FileInventoryStore(tempDir.resolve("cam-hole-nested.json").toString()), false);
        svc.saveOrUpdateMotherRoll(new MotherRollInfo("ROLL-HN-01", "CAM-TC", 1000.0, 1000.0, 0, 0.0));

        List<Point> innerHole = List.of(new Point(50, 50), new Point(350, 50), new Point(350, 350), new Point(50, 350));
        Shape outerFrame = new Shape("POLYGON", 400, 400,
                List.of(new Point(0, 0), new Point(400, 0), new Point(400, 400), new Point(0, 400)),
                List.of(innerHole));

        SchedulingScheme holeNested15 = new SchedulingScheme(
                "SCH-HOLE-NEST-15", "k-hn-15", "孔中套料1.5mm间隙", "NESTING_2D",
                "SC-1", "STR-HN15", "孔套料", "TASK-HN1", "测试", "EXT-HN1",
                "STOCK_ROLL", "ROLL-HN-01", null, "CAM-TC",
                1000.0, 1000.0, 0.0, 600.0, 0.0, 0.0, 75.0, 1.0,
                2, 2, 0, true, Map.of("1", 2), List.of(), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(
                                new SchedulingScheme.PlacementItem(1, 1, "OuterFrame", 0, 0, 400, 400, 0, false, outerFrame),
                                new SchedulingScheme.PlacementItem(2, 2, "NestedChild", 51.5, 51.5, 297, 297, 0, false, Shape.rectangle(297, 297))
                        ),
                        List.of(), List.of()
                ),
                null, null, "2026-11-27 13:20:00", null, null, null, null
        );
        SchedulingScheme holeNestedTight = new SchedulingScheme(
                "SCH-HOLE-NEST-015", "k-hn-015", "孔中套料0.15mm极窄间隙", "NESTING_2D",
                "SC-1", "STR-HN015", "极窄孔套料", "TASK-HN2", "测试", "EXT-HN2",
                "STOCK_ROLL", "ROLL-HN-01", null, "CAM-TC",
                1000.0, 1000.0, 0.0, 600.0, 0.0, 0.0, 75.0, 1.0,
                2, 2, 0, true, Map.of("1", 2), List.of(), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(
                                new SchedulingScheme.PlacementItem(1, 1, "OuterFrame", 0, 0, 400, 400, 0, false, outerFrame),
                                new SchedulingScheme.PlacementItem(2, 2, "TightChild", 50.15, 50.15, 299.7, 299.7, 0, false, Shape.rectangle(299.7, 299.7))
                        ),
                        List.of(), List.of()
                ),
                null, null, "2026-11-27 13:25:00", null, null, null, null
        );
        svc.inWrite("SEED_HN", "SEED", "TEST", tx -> {
            tx.putScheme(holeNested15);
            tx.putScheme(holeNestedTight);
            return null;
        });

        CamExportService cam = new CamExportService(svc, new ToolpathOptimizerService());
        for (boolean dedup : new boolean[]{false, true}) {
            String nc15 = new String(cam.exportCam("SCH-HOLE-NEST-15", "nc", new CamExportOptions(0.0, 4.0, 0.0, dedup, "T01", "T02", "T03")).bytes(), StandardCharsets.UTF_8);
            String holeBlock15 = extractSection(nc15, "OuterFrame [INNER HOLE #1]", "M05");
            assertTrue(holeBlock15.contains("(Lead-In)"), "1.5mm 孔内间隙应保留缩短后的安全 Lead-In，dedup=" + dedup);
            assertAllLeadInsAvoidRect(holeBlock15, 51.5, 51.5, 348.5, 348.5, 0.199);
            assertAllLeadInsInsideRect(holeBlock15, 50.0, 50.0, 350.0, 350.0);

            String ncTight = new String(cam.exportCam("SCH-HOLE-NEST-015", "nc", new CamExportOptions(0.0, 4.0, 0.0, dedup, "T01", "T02", "T03")).bytes(), StandardCharsets.UTF_8);
            String holeBlockTight = extractSection(ncTight, "OuterFrame [INNER HOLE #1]", "M05");
            assertFalse(holeBlockTight.contains("(Lead-In)"), "0.15mm 极窄孔隙下内孔必须安全省略 Lead-In，绝不扎入孔内子件");
            assertAllLeadInsAvoidRect(holeBlockTight, 50.15, 50.15, 349.85, 349.85, 0.0);
        }
    }

    @Test
    void preventsDedupChainLeadInFromViolatingSlantClearanceAndGrazingHoleWall() {
        RemnantService svc = new RemnantService(new FileInventoryStore(tempDir.resolve("cam-dedup-slant-hole-wall.json").toString()), false);
        svc.saveOrUpdateMotherRoll(new MotherRollInfo("ROLL-DSH-01", "CAM-TC", 1000.0, 1000.0, 0, 0.0));

        // 1. SCH-SLANT-15 & SCH-SLANT-TIGHT：MainRect [200..300] 与 45° 斜边三角形 SlantTri（最小间距 1.500mm / 1.465mm）
        List<Point> slantTri15Pts = List.of(new Point(0, 0), new Point(102.1213, 0), new Point(0, 102.1213));
        Shape slantTri15 = new Shape("POLYGON", 102.1213, 102.1213, slantTri15Pts, List.of());
        List<Point> slantTri15World = List.of(new Point(147.8787, 147.8787), new Point(250.0, 147.8787), new Point(147.8787, 250.0));

        List<Point> slantTriTightPts = List.of(new Point(0, 0), new Point(102.072, 0), new Point(0, 102.072));
        Shape slantTriTight = new Shape("POLYGON", 102.072, 102.072, slantTriTightPts, List.of());
        List<Point> slantTriTightWorld = List.of(new Point(147.928, 147.928), new Point(250.0, 147.928), new Point(147.928, 250.0));

        List<Point> mainRectWorld = List.of(new Point(200, 200), new Point(300, 200), new Point(300, 300), new Point(200, 300));

        SchedulingScheme slant15Scheme = new SchedulingScheme(
                "SCH-SLANT-15", "k-slant-15", "斜边1.5mm间隙", "NESTING_2D",
                "SC-1", "STR-SL15", "斜边1.5", "TASK-SL1", "测试", "EXT-SL1",
                "STOCK_ROLL", "ROLL-DSH-01", null, "CAM-TC",
                1000.0, 1000.0, 0.0, 600.0, 0.0, 0.0, 60.0, 1.0,
                2, 2, 0, true, Map.of("1", 2), List.of(), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(
                                new SchedulingScheme.PlacementItem(1, 1, "MainRect", 200, 200, 100, 100, 0, false, Shape.rectangle(100, 100)),
                                new SchedulingScheme.PlacementItem(2, 2, "SlantTri", 147.8787, 147.8787, 102.1213, 102.1213, 0, false, slantTri15)
                        ),
                        List.of(), List.of()
                ),
                null, null, "2026-11-27 14:00:00", null, null, null, null
        );
        SchedulingScheme slantTightScheme = new SchedulingScheme(
                "SCH-SLANT-TIGHT", "k-slant-tight", "斜边1.465mm紧间隙", "NESTING_2D",
                "SC-1", "STR-SLT", "斜边紧", "TASK-SL2", "测试", "EXT-SL2",
                "STOCK_ROLL", "ROLL-DSH-01", null, "CAM-TC",
                1000.0, 1000.0, 0.0, 600.0, 0.0, 0.0, 60.0, 1.0,
                2, 2, 0, true, Map.of("1", 2), List.of(), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(
                                new SchedulingScheme.PlacementItem(1, 1, "MainRect", 200, 200, 100, 100, 0, false, Shape.rectangle(100, 100)),
                                new SchedulingScheme.PlacementItem(2, 2, "SlantTri", 147.928, 147.928, 102.072, 102.072, 0, false, slantTriTight)
                        ),
                        List.of(), List.of()
                ),
                null, null, "2026-11-27 14:05:00", null, null, null, null
        );

        // 2. SCH-HOLE-WALL-GRAZE：OuterFrame [0..400] 带孔 [50..350]、孔内 NestedChild [80..200]x[50.03..150] 与 BlockLeft/Top/Right 阻挡
        List<Point> holeRect = List.of(new Point(50, 50), new Point(350, 50), new Point(350, 350), new Point(50, 350));
        Shape outerFrame = new Shape("POLYGON", 400, 400,
                List.of(new Point(0, 0), new Point(400, 0), new Point(400, 400), new Point(0, 400)),
                List.of(holeRect));
        SchedulingScheme holeWallGrazeScheme = new SchedulingScheme(
                "SCH-HOLE-WALL-GRAZE", "k-hwg", "孔壁0.03mm贴边阻挡", "NESTING_2D",
                "SC-1", "STR-HWG", "贴孔壁", "TASK-HWG", "测试", "EXT-HWG",
                "STOCK_ROLL", "ROLL-DSH-01", null, "CAM-TC",
                1000.0, 1000.0, 0.0, 600.0, 0.0, 0.0, 80.0, 1.0,
                5, 5, 0, true, Map.of("1", 5), List.of(), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(
                                new SchedulingScheme.PlacementItem(1, 1, "OuterFrame", 0, 0, 400, 400, 0, false, outerFrame),
                                new SchedulingScheme.PlacementItem(2, 2, "NestedChild", 80, 50.03, 120, 99.97, 0, false, Shape.rectangle(120, 99.97)),
                                new SchedulingScheme.PlacementItem(3, 3, "BlockLeft", 50.15, 50.15, 29.7, 299.7, 0, false, Shape.rectangle(29.7, 299.7)),
                                new SchedulingScheme.PlacementItem(4, 4, "BlockTop", 80, 150.15, 120, 199.7, 0, false, Shape.rectangle(120, 199.7)),
                                new SchedulingScheme.PlacementItem(5, 5, "BlockRight", 200.15, 50.15, 149.7, 299.7, 0, false, Shape.rectangle(149.7, 299.7))
                        ),
                        List.of(), List.of()
                ),
                null, null, "2026-11-27 14:10:00", null, null, null, null
        );

        svc.inWrite("SEED_DEDUP_SLANT_HWG", "SEED", "TEST", tx -> {
            tx.putScheme(slant15Scheme);
            tx.putScheme(slantTightScheme);
            tx.putScheme(holeWallGrazeScheme);
            return null;
        });

        CamExportService cam = new CamExportService(svc, new ToolpathOptimizerService());
        for (boolean dedup : new boolean[]{true, false}) {
            String nc15 = new String(cam.exportCam("SCH-SLANT-15", "nc", new CamExportOptions(0.0, 4.0, 0.0, dedup, "T01", "T02", "T03")).bytes(), StandardCharsets.UTF_8);
            assertTrue(nc15.contains("(Lead-In)"), "SCH-SLANT-15 应保留安全缩短后的 Lead-In，dedup=" + dedup);
            assertAllLeadInsAvoidPolygon(nc15, slantTri15World, 0.199);
            assertAllLeadInsAvoidPolygon(nc15, mainRectWorld, 0.199);
            assertAllMoveCoordsWithinBounds(nc15, 1000.0, 1000.0);

            String ncTight = new String(cam.exportCam("SCH-SLANT-TIGHT", "nc", new CamExportOptions(0.0, 4.0, 0.0, dedup, "T01", "T02", "T03")).bytes(), StandardCharsets.UTF_8);
            assertTrue(ncTight.contains("(Lead-In)"), "SCH-SLANT-TIGHT 应保留安全缩短后的 Lead-In，dedup=" + dedup);
            assertAllLeadInsAvoidPolygon(ncTight, slantTriTightWorld, 0.199);
            assertAllLeadInsAvoidPolygon(ncTight, mainRectWorld, 0.199);
            assertAllMoveCoordsWithinBounds(ncTight, 1000.0, 1000.0);

            String ncGraze = new String(cam.exportCam("SCH-HOLE-WALL-GRAZE", "nc", new CamExportOptions(0.0, 4.0, 0.0, dedup, "T01", "T02", "T03")).bytes(), StandardCharsets.UTF_8);
            List<Point> nestedChildWorld = List.of(new Point(80, 50.03), new Point(200, 50.03), new Point(200, 150), new Point(80, 150));
            List<Point> blockLeftWorld = List.of(new Point(50.15, 50.15), new Point(79.85, 50.15), new Point(79.85, 349.85), new Point(50.15, 349.85));
            List<Point> blockTopWorld = List.of(new Point(80, 150.15), new Point(200, 150.15), new Point(200, 349.85), new Point(80, 349.85));
            List<Point> blockRightWorld = List.of(new Point(200.15, 50.15), new Point(349.85, 50.15), new Point(349.85, 349.85), new Point(200.15, 349.85));
            assertAllLeadInsAvoidPolygon(ncGraze, holeRect, 0.199);
            assertAllLeadInsAvoidPolygon(ncGraze, nestedChildWorld, 0.199);
            assertAllLeadInsAvoidPolygon(ncGraze, blockLeftWorld, 0.199);
            assertAllLeadInsAvoidPolygon(ncGraze, blockTopWorld, 0.199);
            assertAllLeadInsAvoidPolygon(ncGraze, blockRightWorld, 0.199);
            assertNoLeadInInsideInnerArea(ncGraze, 50.01, 50.01, 349.99, 349.99);
            assertAllMoveCoordsWithinBounds(ncGraze, 1000.0, 1000.0);
        }
    }

    @Test
    void preventsDedupChainAdjacentEdgeFalseExemptionOnSub02mmHoleWallAndExternalGraze() {
        RemnantService svc = new RemnantService(new FileInventoryStore(tempDir.resolve("cam-dedup-sub02mm-atk.json").toString()), false);
        svc.saveOrUpdateMotherRoll(new MotherRollInfo("ROLL-ATK-01", "CAM-TC", 1000.0, 1000.0, 0, 0.0));

        List<Point> holeRect = List.of(new Point(50, 50), new Point(350, 50), new Point(350, 350), new Point(50, 350));
        List<Point> outerRect = List.of(new Point(0, 0), new Point(400, 0), new Point(400, 400), new Point(0, 400));
        Shape outerFrame = new Shape("POLYGON", 400, 400, outerRect, List.of(holeRect));

        List<Point> wedgeLocal = List.of(new Point(0, 0), new Point(3, 100), new Point(120, 100), new Point(120, 0.2));
        Shape wedgeShape = new Shape("POLYGON", 120, 100, wedgeLocal, List.of());

        // 1. SCH-ATK-TILT-CW：孔内 0.015mm 贴孔底壁微倾嵌件
        List<Point> wedgeCwWorld = List.of(
                new Point(80, 50.015), new Point(83, 150.015), new Point(200, 150.015), new Point(200, 50.215));
        SchedulingScheme atkTiltCw = new SchedulingScheme(
                "SCH-ATK-TILT-CW", "k-atk-tilt-cw", "孔内0.015mm微倾嵌件", "NESTING_2D",
                "SC-1", "STR-ATC", "微倾嵌件", "TASK-ATC", "测试", "EXT-ATC",
                "STOCK_ROLL", "ROLL-ATK-01", null, "CAM-TC",
                1000.0, 1000.0, 0.0, 600.0, 0.0, 0.0, 80.0, 1.0,
                2, 2, 0, true, Map.of("1", 2), List.of(), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(
                                new SchedulingScheme.PlacementItem(1, 1, "OuterFrame", 0, 0, 400, 400, 0, false, outerFrame),
                                new SchedulingScheme.PlacementItem(2, 2, "WedgeCW", 80, 50.015, 120, 100, 0, false, wedgeShape)
                        ),
                        List.of(), List.of()
                ),
                null, null, "2026-11-27 14:20:00", null, null, null, null
        );

        // 2. SCH-ATK-EXT-GRAZE：纯外部无孔无共边紧邻擦边件 0.015mm
        List<Point> wedgeExtWorld = List.of(
                new Point(200, 200.015), new Point(203, 300.015), new Point(320, 300.015), new Point(320, 200.215));
        List<Point> neighborBelowWorld = List.of(
                new Point(100, 100), new Point(250, 100), new Point(250, 200), new Point(100, 200));
        SchedulingScheme atkExtGraze = new SchedulingScheme(
                "SCH-ATK-EXT-GRAZE", "k-atk-ext-graze", "外部0.015mm擦边件", "NESTING_2D",
                "SC-1", "STR-AEG", "外部擦边", "TASK-AEG", "测试", "EXT-AEG",
                "STOCK_ROLL", "ROLL-ATK-01", null, "CAM-TC",
                1000.0, 1000.0, 0.0, 600.0, 0.0, 0.0, 80.0, 1.0,
                2, 2, 0, true, Map.of("1", 2), List.of(), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(
                                new SchedulingScheme.PlacementItem(1, 1, "WedgeExt", 200, 200.015, 120, 100, 0, false, wedgeShape),
                                new SchedulingScheme.PlacementItem(2, 2, "NeighborBelow", 100, 100, 150, 100, 0, false, Shape.rectangle(150, 100))
                        ),
                        List.of(), List.of()
                ),
                null, null, "2026-11-27 14:22:00", null, null, null, null
        );

        // 3. SCH-ATK-ORTHO-HOLE：零旋转正交矩形贴孔底壁 0.015mm
        List<Point> orthoChildWorld = List.of(
                new Point(80, 50.015), new Point(200, 50.015), new Point(200, 150), new Point(80, 150));
        SchedulingScheme atkOrthoHole = new SchedulingScheme(
                "SCH-ATK-ORTHO-HOLE", "k-atk-ortho-hole", "零旋转正交矩形0.015mm贴孔壁", "NESTING_2D",
                "SC-1", "STR-AOH", "正交贴孔壁", "TASK-AOH", "测试", "EXT-AOH",
                "STOCK_ROLL", "ROLL-ATK-01", null, "CAM-TC",
                1000.0, 1000.0, 0.0, 600.0, 0.0, 0.0, 80.0, 1.0,
                2, 2, 0, true, Map.of("1", 2), List.of(), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(
                                new SchedulingScheme.PlacementItem(1, 1, "OuterFrame", 0, 0, 400, 400, 0, false, outerFrame),
                                new SchedulingScheme.PlacementItem(2, 2, "OrthoChild", 80, 50.015, 120, 99.985, 0, false, Shape.rectangle(120, 99.985))
                        ),
                        List.of(), List.of()
                ),
                null, null, "2026-11-27 14:25:00", null, null, null, null
        );

        svc.inWrite("SEED_DEDUP_SUB02_ATK", "SEED", "TEST", tx -> {
            tx.putScheme(atkTiltCw);
            tx.putScheme(atkExtGraze);
            tx.putScheme(atkOrthoHole);
            return null;
        });

        CamExportService cam = new CamExportService(svc, new ToolpathOptimizerService());
        for (boolean dedup : new boolean[]{true, false}) {
            CamExportOptions opt = new CamExportOptions(0.0, 4.0, 0.0, dedup, "T01", "T02", "T03");

            String ncTilt = new String(cam.exportCam("SCH-ATK-TILT-CW", "nc", opt).bytes(), StandardCharsets.UTF_8);
            assertTrue(ncTilt.contains("(Lead-In)"), "SCH-ATK-TILT-CW 应输出安全避让后的 Lead-In，dedup=" + dedup);
            assertAllLeadInsStrictClearance(ncTilt, List.of(
                    new TestPieceRings(outerRect, List.of(holeRect)),
                    new TestPieceRings(wedgeCwWorld, List.of())
            ), 0.199);
            assertAllMoveCoordsWithinBounds(ncTilt, 1000.0, 1000.0);

            String ncExt = new String(cam.exportCam("SCH-ATK-EXT-GRAZE", "nc", opt).bytes(), StandardCharsets.UTF_8);
            assertTrue(ncExt.contains("(Lead-In)"), "SCH-ATK-EXT-GRAZE 应输出安全避让后的 Lead-In，dedup=" + dedup);
            assertAllLeadInsStrictClearance(ncExt, List.of(
                    new TestPieceRings(wedgeExtWorld, List.of()),
                    new TestPieceRings(neighborBelowWorld, List.of())
            ), 0.199);
            assertAllMoveCoordsWithinBounds(ncExt, 1000.0, 1000.0);

            String ncOrtho = new String(cam.exportCam("SCH-ATK-ORTHO-HOLE", "nc", opt).bytes(), StandardCharsets.UTF_8);
            assertAllLeadInsStrictClearance(ncOrtho, List.of(
                    new TestPieceRings(outerRect, List.of(holeRect)),
                    new TestPieceRings(orthoChildWorld, List.of())
            ), 0.199);
            assertNoLeadInInsideInnerArea(ncOrtho, 50.01, 50.01, 349.99, 349.99);
            assertAllMoveCoordsWithinBounds(ncOrtho, 1000.0, 1000.0);
        }
    }

    @Test
    void preventsDedupChainLeadInFromIncludingMicroTiltedExternalNeighborInOwnOuterRings() {
        RemnantService svc = new RemnantService(new FileInventoryStore(tempDir.resolve("cam-dedup-i6-mirror2.json").toString()), false);
        svc.saveOrUpdateMotherRoll(new MotherRollInfo("ROLL-ATK-I6", "CAM-TC", 1000.0, 1000.0, 0, 0.0));

        List<Point> tiltMirrorLocal = List.of(
                new Point(0, 0), new Point(50, 0.006), new Point(50, 80), new Point(0, 80));
        Shape tiltMirrorShape = new Shape("POLYGON", 50, 80, tiltMirrorLocal, List.of());
        List<Point> tiltMirrorWorld = List.of(
                new Point(200, 200.003), new Point(250, 200.009), new Point(250, 280.003), new Point(200, 280.003));
        List<Point> neighborBelowWorld = List.of(
                new Point(180, 198), new Point(270, 198), new Point(270, 200), new Point(180, 200));

        SchedulingScheme scheme = new SchedulingScheme(
                "SCH-ATK-I6-MIRROR2", "k-atk-i6-mirror2", "微倾0.003~0.009mm外部非共边邻件防假豁免", "NESTING_2D",
                "SC-1", "STR-I6M2", "微倾外邻防豁免", "TASK-I6M2", "测试", "EXT-I6M2",
                "STOCK_ROLL", "ROLL-ATK-I6", null, "CAM-TC",
                1000.0, 1000.0, 0.0, 400.0, 0.0, 0.0, 80.0, 1.0,
                2, 2, 0, true, Map.of("1", 2), List.of(), null,
                SchedulingScheme.STATE_READY_TO_CUT, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(
                                new SchedulingScheme.PlacementItem(1, 1, "TiltMirror", 200, 200.003, 50, 80, 0, false, tiltMirrorShape),
                                new SchedulingScheme.PlacementItem(2, 2, "NeighborBelow", 180, 198, 90, 2, 0, false, Shape.rectangle(90, 2))
                        ),
                        List.of(), List.of()
                ),
                null, null, "2026-11-27 15:00:00", null, null, null, null
        );
        svc.inWrite("SEED_I6_MIRROR2", "SEED", "TEST", tx -> {
            tx.putScheme(scheme);
            return null;
        });

        CamExportService cam = new CamExportService(svc, new ToolpathOptimizerService());
        for (boolean dedup : new boolean[]{true, false}) {
            CamExportOptions opt = new CamExportOptions(0.0, 4.0, 0.0, dedup, "T01", "T02", "T03");
            String nc = new String(cam.exportCam("SCH-ATK-I6-MIRROR2", "nc", opt).bytes(), StandardCharsets.UTF_8);
            assertTrue(nc.contains("(Lead-In)"), "SCH-ATK-I6-MIRROR2 应保留安全引入线，dedup=" + dedup);
            assertAllLeadInsStrictClearance(nc, List.of(
                    new TestPieceRings(tiltMirrorWorld, List.of()),
                    new TestPieceRings(neighborBelowWorld, List.of())
            ), 0.199);
            assertAllMoveCoordsWithinBounds(nc, 1000.0, 1000.0);
        }
    }

    private record TestPieceRings(List<Point> outer, List<List<Point>> holes) {}

    private static void assertAllLeadInsStrictClearance(String nc, List<TestPieceRings> pieces, double minClearance) {
        double g00X = Double.NaN, g00Y = Double.NaN;
        for (String line : nc.lines().toList()) {
            if (line.startsWith("G00 ") && line.contains("Z10.000")) {
                g00X = extractCoord(line, 'X');
                g00Y = extractCoord(line, 'Y');
            } else if (line.startsWith("G01 ") && line.contains("(Lead-In)")) {
                double ex = extractCoord(line, 'X');
                double ey = extractCoord(line, 'Y');
                double mx = 0.5 * (g00X + ex), my = 0.5 * (g00Y + ey);
                double len = Math.hypot(g00X - ex, g00Y - ey);
                double ux = (g00X - ex) / Math.max(len, 1e-9), uy = (g00Y - ey) / Math.max(len, 1e-9);
                double csx = ex + ux * Math.min(0.2, len), csy = ey + uy * Math.min(0.2, len);
                double rsx = ex + ux * Math.min(0.05, 0.1 * len), rsy = ey + uy * Math.min(0.05, 0.1 * len);
                Point pierce = new Point(g00X, g00Y);
                Point mid = new Point(mx, my);
                for (TestPieceRings piece : pieces) {
                    assertFalse(isPointInsidePieceMaterial(pierce, piece),
                            "Lead-In 穿孔点进入实体材料内部: (" + g00X + "," + g00Y + ")");
                    assertFalse(isPointInsidePieceMaterial(mid, piece),
                            "Lead-In 中点进入实体材料内部: (" + mx + "," + my + ")");
                    List<List<Point>> allRings = new ArrayList<>(1 + piece.holes().size());
                    allRings.add(piece.outer());
                    allRings.addAll(piece.holes());
                    for (List<Point> ring : allRings) {
                        boolean entryOnOwnRing = false;
                        for (int i = 0, n = ring.size(); i < n; i++) {
                            Point a = ring.get(i), b = ring.get((i + 1) % n);
                            if (Line2D.ptSegDist(a.x(), a.y(), b.x(), b.y(), ex, ey) <= 0.002) {
                                entryOnOwnRing = true;
                                break;
                            }
                        }
                        if (entryOnOwnRing) continue;
                        for (int i = 0, n = ring.size(); i < n; i++) {
                            Point a = ring.get(i), b = ring.get((i + 1) % n);
                            assertFalse(Line2D.linesIntersect(rsx, rsy, g00X, g00Y, a.x(), a.y(), b.x(), b.y()),
                                    "Lead-In 线段穿越非自身环边: (" + g00X + "," + g00Y + ")->(" + ex + "," + ey + ")");
                            double segDist = Math.min(
                                    Math.min(Line2D.ptSegDist(a.x(), a.y(), b.x(), b.y(), csx, csy), Line2D.ptSegDist(a.x(), a.y(), b.x(), b.y(), g00X, g00Y)),
                                    Math.min(Line2D.ptSegDist(csx, csy, g00X, g00Y, a.x(), a.y()), Line2D.ptSegDist(csx, csy, g00X, g00Y, b.x(), b.y()))
                            );
                            assertTrue(segDist >= minClearance,
                                    "Lead-In 对非自身环(含0.015mm孔壁/邻件)余隙不足 " + minClearance + "mm: actual=" + segDist
                                            + " pierce=(" + g00X + "," + g00Y + ") entry=(" + ex + "," + ey + ")");
                        }
                    }
                }
            }
        }
    }

    private static boolean isPointInsidePieceMaterial(Point pt, TestPieceRings piece) {
        if (!com.example.cutdemotwo.algorithm.geometry.PolygonGeometry.pointStrictlyInsideRing(pt, piece.outer())) {
            return false;
        }
        for (List<Point> hole : piece.holes()) {
            if (com.example.cutdemotwo.algorithm.geometry.PolygonGeometry.pointStrictlyInsideRing(pt, hole)) {
                return false;
            }
        }
        return true;
    }

    private static void assertNoLeadInInsideInnerArea(String nc, double minX, double minY, double maxX, double maxY) {
        for (String line : nc.lines().toList()) {
            if (line.startsWith("G01 ") && line.contains("(Lead-In)")) {
                double ex = extractCoord(line, 'X');
                double ey = extractCoord(line, 'Y');
                assertFalse(ex > minX && ex < maxX && ey > minY && ey < maxY,
                        "极窄孔腔内不应生成任何 Lead-In，实际起切点: (" + ex + "," + ey + ")");
            }
        }
    }

    private static void assertAllLeadInsAvoidPolygon(String block, List<Point> ring, double minClearance) {
        double g00X = Double.NaN, g00Y = Double.NaN;
        for (String line : block.lines().toList()) {
            if (line.startsWith("G00 ") && line.contains("Z10.000")) {
                g00X = extractCoord(line, 'X');
                g00Y = extractCoord(line, 'Y');
            } else if (line.startsWith("G01 ") && line.contains("(Lead-In)")) {
                double ex = extractCoord(line, 'X');
                double ey = extractCoord(line, 'Y');
                double mx = 0.5 * (g00X + ex), my = 0.5 * (g00Y + ey);
                double len = Math.hypot(g00X - ex, g00Y - ey);
                boolean entryOnRing = false;
                for (int i = 0, n = ring.size(); i < n; i++) {
                    Point a = ring.get(i), b = ring.get((i + 1) % n);
                    if (Line2D.ptSegDist(a.x(), a.y(), b.x(), b.y(), ex, ey) <= 0.02) {
                        entryOnRing = true;
                        break;
                    }
                }
                if (entryOnRing) continue;
                assertFalse(com.example.cutdemotwo.algorithm.geometry.PolygonGeometry.pointStrictlyInsideRing(new Point(g00X, g00Y), ring),
                        "Lead-In 穿孔点进入多边形内部: (" + g00X + "," + g00Y + ")");
                assertFalse(com.example.cutdemotwo.algorithm.geometry.PolygonGeometry.pointStrictlyInsideRing(new Point(mx, my), ring),
                        "Lead-In 中点进入多边形内部: (" + mx + "," + my + ")");
                double ux = (g00X - ex) / Math.max(len, 1e-9), uy = (g00Y - ey) / Math.max(len, 1e-9);
                double csx = ex + ux * Math.min(0.2, len), csy = ey + uy * Math.min(0.2, len);
                double rsx = ex + ux * Math.min(0.05, 0.1 * len), rsy = ey + uy * Math.min(0.05, 0.1 * len);
                for (int i = 0, n = ring.size(); i < n; i++) {
                    Point a = ring.get(i), b = ring.get((i + 1) % n);
                    assertFalse(Line2D.linesIntersect(rsx, rsy, g00X, g00Y, a.x(), a.y(), b.x(), b.y()),
                            "Lead-In 线段穿越多边形边: (" + g00X + "," + g00Y + ")->(" + ex + "," + ey + ")");
                    double segDist = Math.min(
                            Math.min(Line2D.ptSegDist(a.x(), a.y(), b.x(), b.y(), csx, csy), Line2D.ptSegDist(a.x(), a.y(), b.x(), b.y(), g00X, g00Y)),
                            Math.min(Line2D.ptSegDist(csx, csy, g00X, g00Y, a.x(), a.y()), Line2D.ptSegDist(csx, csy, g00X, g00Y, b.x(), b.y()))
                    );
                    assertTrue(segDist >= minClearance,
                            "Lead-In 线段余隙不足 " + minClearance + "mm: actual=" + segDist
                                    + " pierce=(" + g00X + "," + g00Y + ") entry=(" + ex + "," + ey + ")");
                }
            }
        }
    }

    private static void assertAllLeadInsAvoidRect(String block, double minX, double minY, double maxX, double maxY, double minClearance) {
        double g00X = Double.NaN, g00Y = Double.NaN;
        for (String line : block.lines().toList()) {
            if (line.startsWith("G00 ") && line.contains("Z10.000")) {
                g00X = extractCoord(line, 'X');
                g00Y = extractCoord(line, 'Y');
                assertFalse(g00X > minX + 1e-4 && g00X < maxX - 1e-4 && g00Y > minY + 1e-4 && g00Y < maxY - 1e-4,
                        "G00 穿孔点侵入避让矩形内部: (" + g00X + "," + g00Y + ")");
            } else if (line.startsWith("G01 ") && line.contains("(Lead-In)")) {
                double ex = extractCoord(line, 'X');
                double ey = extractCoord(line, 'Y');
                double mx = 0.5 * (g00X + ex);
                double my = 0.5 * (g00Y + ey);
                assertFalse(mx > minX + 1e-4 && mx < maxX - 1e-4 && my > minY + 1e-4 && my < maxY - 1e-4,
                        "Lead-In 线段中点侵入避让矩形内部: (" + mx + "," + my + ")");
                double dx = Math.max(0.0, Math.max(minX - g00X, g00X - maxX));
                double dy = Math.max(0.0, Math.max(minY - g00Y, g00Y - maxY));
                double dist = Math.hypot(dx, dy);
                assertTrue(dist >= minClearance,
                        "Lead-In 穿孔点 (" + g00X + "," + g00Y + ") 距邻件/子件余隙不足 " + minClearance + "mm: actual=" + dist);
            }
        }
    }

    private static void assertAllLeadInsInsideRect(String block, double minX, double minY, double maxX, double maxY) {
        double g00X = Double.NaN, g00Y = Double.NaN;
        for (String line : block.lines().toList()) {
            if (line.startsWith("G00 ") && line.contains("Z10.000")) {
                g00X = extractCoord(line, 'X');
                g00Y = extractCoord(line, 'Y');
            } else if (line.startsWith("G01 ") && line.contains("(Lead-In)")) {
                assertTrue(g00X > minX + 1e-4 && g00X < maxX - 1e-4 && g00Y > minY + 1e-4 && g00Y < maxY - 1e-4,
                        "内孔 Lead-In 穿孔点越出孔内部: (" + g00X + "," + g00Y + ")");
            }
        }
    }

    private static String extractSection(String fullNc, String startMarker, String endMarker) {
        int s = fullNc.indexOf(startMarker);
        assertTrue(s >= 0, "缺少区段起点标记: " + startMarker);
        int e = fullNc.indexOf(endMarker, s);
        assertTrue(e > s, "缺少区段结束标记: " + endMarker);
        return fullNc.substring(s, e);
    }

    private static void verifyCircularMicroJointArc(String block, String expectedCmd, double expectedR, double jointMm) {
        String leadIn = block.lines().filter(l -> l.startsWith("G01 ") && l.contains("(Lead-In)")).findFirst().orElseThrow();
        double sx = extractCoord(leadIn, 'X');
        double sy = extractCoord(leadIn, 'Y');
        String arc = block.lines().filter(l -> l.startsWith(expectedCmd + " ")).findFirst().orElseThrow();
        double ex = extractCoord(arc, 'X');
        double ey = extractCoord(arc, 'Y');
        double iVal = extractCoord(arc, 'I');
        double jVal = extractCoord(arc, 'J');
        double cx = sx + iVal;
        double cy = sy + jVal;
        double rStart = Math.hypot(sx - cx, sy - cy);
        double rEnd = Math.hypot(ex - cx, ey - cy);
        assertEquals(expectedR, rStart, 0.01, "起点半径应精确匹配理论半径");
        assertEquals(rStart, rEnd, 0.002, "圆弧起终点半径差必须 < 0.002mm 防止 CNC 报警");
        double gapChord = Math.hypot(ex - sx, ey - sy);
        double expectedChord = 2.0 * rStart * Math.sin((jointMm / rStart) * 0.5);
        assertEquals(expectedChord, gapChord, 0.02, "圆弧微连接缺口弦长须精确匹配弧长公式");
    }

    private static void assertDedupLeadInPierceSafe(String dedupSection, double minX, double minY, double maxX, double maxY) {
        double lastG00X = Double.NaN, lastG00Y = Double.NaN;
        int leadIns = 0;
        for (String line : dedupSection.lines().toList()) {
            if (line.startsWith("G00 ") && line.contains("Z10.000")) {
                lastG00X = extractCoord(line, 'X');
                lastG00Y = extractCoord(line, 'Y');
            } else if (line.startsWith("G01 ") && line.contains("(Lead-In)")) {
                leadIns++;
                boolean outsideUnion = lastG00X < minX - 0.05 || lastG00X > maxX + 0.05
                        || lastG00Y < minY - 0.05 || lastG00Y > maxY + 0.05;
                assertTrue(outsideUnion, "去重外轮廓 Lead-In 穿孔点应位于废料区且距裁片边 >0.05mm: ("
                        + lastG00X + "," + lastG00Y + ")");
            }
        }
        assertTrue(leadIns >= 1, "应至少有 1 条带废料区安全穿孔点的 Lead-In");
    }

    private static void assertAllMoveCoordsWithinBounds(String nc, double maxW, double maxL) {
        for (String line : nc.lines().toList()) {
            if (line.startsWith("G00 ") || line.startsWith("G01 ") || line.startsWith("G02 ") || line.startsWith("G03 ")) {
                double x = extractCoord(line, 'X');
                double y = extractCoord(line, 'Y');
                assertTrue(x >= -1e-3 && x <= maxW + 1e-3 && y >= -1e-3 && y <= maxL + 1e-3,
                        "加工坐标越界: " + line);
            }
        }
    }

    private static double extractCoord(String line, char axis) {
        int idx = line.indexOf(axis);
        assertTrue(idx >= 0, "行中缺少坐标轴 " + axis + ": " + line);
        int end = line.indexOf(' ', idx + 1);
        String num = end > 0 ? line.substring(idx + 1, end) : line.substring(idx + 1);
        return Double.parseDouble(num);
    }
}
