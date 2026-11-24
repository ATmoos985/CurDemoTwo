package com.example.cutdemotwo.algorithm.toolpath;

import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.contracts.geometry.ContourToolpathPlan;
import com.example.cutdemotwo.contracts.geometry.ContourToolpathPlan.ContourLoop;
import com.example.cutdemotwo.contracts.geometry.ContourToolpathPlan.Options;
import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.geometry.ToolpathResult;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 第三波专项验收测试（三）：工业级 CAM 刀路优化器
 * <ul>
 *   <li>真正区间翻转 2-Opt（解开交叉绕远空程，并严格维持阶段依赖）；</li>
 *   <li>共边切割去重 deduplicateCommonEdges（水平/垂直/斜边/部分重叠去重且保留非共边）；</li>
 *   <li>闭合异形轮廓 CAM 刀路优化 optimizeContourToolpath（小件优先防飞料、嵌套先子后母、
 *       先内孔后外轮廓、废料侧安全引入线、末段微连接、可选共边去重）。</li>
 * </ul>
 */
class Wave3CamToolpathTests {

    private final ToolpathOptimizerService optimizer = new ToolpathOptimizerService();

    private static CutStep segment(int step, double x1, double y1, double x2, double y2, Integer stage, String desc) {
        String type = Math.abs(y1 - y2) <= 1e-6 ? "横切" : (Math.abs(x1 - x2) <= 1e-6 ? "纵切" : "轮廓切");
        CutStep c = new CutStep(step, type,
                "横切".equals(type) ? y1 : x1,
                "横切".equals(type) ? Math.min(x1, x2) : Math.min(y1, y2),
                "横切".equals(type) ? Math.max(x1, x2) : Math.max(y1, y2),
                desc);
        c.setStartX(x1);
        c.setStartY(y1);
        c.setEndX(x2);
        c.setEndY(y2);
        c.setStage(stage);
        return c;
    }

    private static double totalCutLength(List<CutStep> steps) {
        double sum = 0.0;
        for (CutStep c : steps) {
            sum += Math.hypot(c.getEndX() - c.getStartX(), c.getEndY() - c.getStartY());
        }
        return sum;
    }

    private static List<Point> rectRing(double x, double y, double w, double h) {
        return List.of(
                new Point(x, y),
                new Point(x + w, y),
                new Point(x + w, y + h),
                new Point(x, y + h)
        );
    }

    @Test
    void trueIntervalReversal2OptUntanglesCrossingAndRespectsPrecedence() {
        // 1. 无阶段约束：经典来回交叉折返的 8 条切线段
        List<CutStep> crossingCuts = List.of(
                segment(1, 0, 100, 50, 100, null, "s1"),
                segment(2, 900, 900, 950, 900, null, "s2"),
                segment(3, 100, 100, 150, 100, null, "s3"),
                segment(4, 800, 900, 850, 900, null, "s4"),
                segment(5, 200, 100, 250, 100, null, "s5"),
                segment(6, 700, 900, 750, 900, null, "s6"),
                segment(7, 300, 100, 350, 100, null, "s7"),
                segment(8, 600, 900, 650, 900, null, "s8")
        );

        ToolpathResult freeRes = optimizer.optimizeToolpath(crossingCuts, 0, 0, false);
        assertEquals(8, freeRes.getOptimizedCuts().size());
        assertTrue(freeRes.getOptimizedAirDistance() < freeRes.getOriginalAirDistance() * 0.4,
                String.format("真正区间翻转 2-Opt 应大幅解开交叉空程：orig=%.1f, opt=%.1f",
                        freeRes.getOriginalAirDistance(), freeRes.getOptimizedAirDistance()));
        assertTrue(freeRes.getSavingRatio() > 60.0, "空程节省率应 > 60%，实际：" + freeRes.getSavingRatio());

        // 2. 带阶段约束：3 个阶段，每阶段内均有远距离交叉；优化后空程大幅下降且绝不跨阶段倒置
        List<CutStep> stagedCuts = List.of(
                segment(1, 0, 100, 1000, 100, 1, "st1-a"),
                segment(2, 0, 900, 1000, 900, 1, "st1-b"),
                segment(3, 0, 200, 1000, 200, 1, "st1-c"),
                segment(4, 0, 800, 1000, 800, 1, "st1-d"),
                segment(5, 100, 0, 100, 100, 2, "st2-a"),
                segment(6, 900, 0, 900, 100, 2, "st2-b"),
                segment(7, 200, 0, 200, 100, 2, "st2-c"),
                segment(8, 800, 0, 800, 100, 2, "st2-d"),
                segment(9, 100, 200, 100, 800, 3, "st3-a"),
                segment(10, 900, 200, 900, 800, 3, "st3-b"),
                segment(11, 200, 200, 200, 800, 3, "st3-c")
        );
        ToolpathResult stagedRes = optimizer.optimizeToolpath(stagedCuts, 0, 0, true);
        assertEquals(stagedCuts.size(), stagedRes.getOptimizedCuts().size());
        assertTrue(stagedRes.getOptimizedAirDistance() < stagedRes.getOriginalAirDistance(),
                "阶段约束 2-Opt 必须有效压降空程");
        int prevStage = Integer.MIN_VALUE;
        for (CutStep cut : stagedRes.getOptimizedCuts()) {
            assertNotNull(cut.getStage());
            assertTrue(cut.getStage() >= prevStage, "阶段约束优化绝不允许跨阶段倒置");
            prevStage = cut.getStage();
        }
    }

    @Test
    void deduplicateCommonEdgesRemovesHorizontalVerticalAndDiagonalOverlaps() {
        List<CutStep> raw = List.of(
                // 水平完全共边（反向）：保留 100mm，去除 100mm
                segment(1, 0, 100, 100, 100, 1, "h1"),
                segment(2, 100, 100, 0, 100, 1, "h1-rev"),
                // 垂直部分重叠：[0, 200] 与 [100, 300] 重叠 100mm，去重后保留 200 + 100 = 300mm
                segment(3, 200, 0, 200, 200, 1, "v1"),
                segment(4, 200, 100, 200, 300, 1, "v2-overlap"),
                // 45° 斜边完全反向重合：保留 100*sqrt(2)
                segment(5, 300, 300, 400, 400, 1, "d1"),
                segment(6, 400, 400, 300, 300, 1, "d1-rev"),
                // 间距 5mm 的平行非共边：必须完整保留 100mm
                segment(7, 0, 105, 100, 105, 1, "h-parallel-not-common")
        );

        List<CutStep> deduped = optimizer.deduplicateCommonEdges(raw, 0.05);
        double expectedLen = 100.0 + 300.0 + Math.hypot(100.0, 100.0) + 100.0;
        double actualLen = totalCutLength(deduped);
        assertEquals(expectedLen, actualLen, 1e-3,
                "共边去重后总切长应精确扣除水平/垂直/斜边重叠段，并完整保留非共边");
        assertEquals(5, deduped.size(), "去重后应剩余 5 条非重叠切线段（含部分重叠裁减后的剩余段）");
    }

    @Test
    void optimizeContourToolpathOrdersHolesFirstNestedFirstSmallFirstWithLeadInMicroJointAndCommonEdge() {
        // 1. 带 2 个内孔的大母件（500×400，面积 = 200000 - 200*160 - 150*160 = 144000 mm²）
        List<Point> hole1 = rectRing(40, 40, 200, 160);
        List<Point> hole2 = rectRing(290, 40, 150, 160);
        Shape parentFrame = new Shape("POLYGON", 500, 400, rectRing(0, 0, 500, 400), List.of(hole1, hole2));

        // 2. 嵌套在母件 hole1 内部的独立子件（100×80，位置 (80, 70)）
        Shape nestedChildShape = Shape.rectangle(100, 80);

        // 3. 右侧两件紧贴共边的小件（各 100×100，在 x=650 共用一条 100mm 竖边）
        Shape smallSquare = Shape.rectangle(100, 100);

        // 4. 独立的大矩形件（300×250，面积 75000 mm²）
        Shape mediumBig = Shape.rectangle(300, 250);

        // 故意打乱输入顺序（大母件在前、大件在中间、小件和嵌套子件在最后）
        List<Placement> placements = List.of(
                new Placement(10, 1, "大母件", 0, 0, parentFrame, 0),
                new Placement(20, 2, "独立大件", 550, 250, mediumBig, 0),
                new Placement(30, 3, "共边小件A", 550, 0, smallSquare, 0),
                new Placement(40, 3, "共边小件B", 650, 0, smallSquare, 0),
                new Placement(50, 4, "孔内子件", 80, 70, nestedChildShape, 0)
        );

        Options options = new Options(0.0, 0.0, 4.0, 2.0, true, true, 0.05);
        ContourToolpathPlan plan = optimizer.optimizeContourToolpath(placements, options);

        // 5 件外轮廓 + 2 个内孔 = 7 个闭合轮廓环
        assertEquals(7, plan.loops().size(), "应输出 7 个闭合轮廓环（5 外轮廓 + 2 内孔）");
        assertTrue(plan.optimizedAirDistanceMm() <= plan.originalAirDistanceMm() + 1e-6,
                "优化后空程不得高于原始顺序基线");
        assertTrue(plan.deduplicatedEdgeLengthMm() >= 90.0,
                "共边小件A与B的 100mm 重合边应被共边去重识别，实际去重长度：" + plan.deduplicatedEdgeLengthMm());

        Map<Integer, Integer> outerSeqByPlacement = new HashMap<>();
        List<ContourLoop> parentHoleLoops = new ArrayList<>();
        ContourLoop parentOuterLoop = null;
        for (ContourLoop loop : plan.loops()) {
            if (!loop.hole()) {
                outerSeqByPlacement.put(loop.placementId(), loop.sequence());
                if (loop.placementId() == 10) {
                    parentOuterLoop = loop;
                }
            } else if (loop.placementId() == 10) {
                parentHoleLoops.add(loop);
            }
        }

        assertNotNull(parentOuterLoop);
        assertEquals(2, parentHoleLoops.size());

        // 规则 1：同一零件必须先切内孔再切外轮廓
        for (ContourLoop holeLoop : parentHoleLoops) {
            assertTrue(holeLoop.sequence() < parentOuterLoop.sequence(),
                    "母件内孔必须严格先于母件外轮廓切割");
        }

        // 规则 2：嵌套在母件内孔中的子件必须先于母件外轮廓切割
        assertTrue(outerSeqByPlacement.get(50) < outerSeqByPlacement.get(10),
                "孔内嵌套子件必须先于母件外轮廓切割");

        // 规则 3：开启小件优先防飞料后，独立小件（面积 10000）优先于独立大件（面积 75000）
        assertTrue(outerSeqByPlacement.get(30) < outerSeqByPlacement.get(20),
                "小件A 应优先于独立大件切割");
        assertTrue(outerSeqByPlacement.get(40) < outerSeqByPlacement.get(20),
                "小件B 应优先于独立大件切割");

        // 规则 4：引入线必须位于废料侧（内孔穿孔在孔内，外轮廓穿孔在环外）
        List<Point> parentOuterWorld = rectRing(0, 0, 500, 400);
        Point parentPierce = new Point(parentOuterLoop.pierceX(), parentOuterLoop.pierceY());
        assertFalse(PolygonGeometry.pointStrictlyInsideRing(parentPierce, parentOuterWorld),
                "外轮廓引入线穿孔点必须位于母件外部废料侧：" + parentPierce);
        assertEquals(4.0, Math.hypot(parentOuterLoop.entryX() - parentOuterLoop.pierceX(),
                parentOuterLoop.entryY() - parentOuterLoop.pierceY()), 0.25, "外轮廓引入线长度应约等于 4mm");

        for (ContourLoop holeLoop : parentHoleLoops) {
            List<Point> holeWorld = holeLoop.holeIndex() == 0 ? hole1 : hole2;
            Point holePierce = new Point(holeLoop.pierceX(), holeLoop.pierceY());
            assertTrue(PolygonGeometry.pointStrictlyInsideRing(holePierce, holeWorld),
                    "内孔引入线穿孔点必须位于内孔内部废料侧：" + holePierce);
            assertEquals(4.0, Math.hypot(holeLoop.entryX() - holeLoop.pierceX(),
                    holeLoop.entryY() - holeLoop.pierceY()), 0.25, "内孔引入线长度应约等于 4mm");
        }

        // 规则 5：微连接使单环实际切割周长比完整周长略微扣减 microJointWidthMm（2.0mm）
        // 独立大件 300×250 完整周长 = 1100mm，加引入线 4mm 减微连接 2mm => 约 1102mm（或不含引入线的环切长约 1098mm）
        ContourLoop bigLoop = plan.loops().stream()
                .filter(l -> l.placementId() == 20 && !l.hole())
                .findFirst()
                .orElseThrow();
        assertEquals(2.0, bigLoop.microJointWidthMm(), 1e-6);
        assertTrue(bigLoop.cutLengthMm() <= 1104.5 && bigLoop.cutLengthMm() >= 1096.0,
                "独立大件轮廓切长应体现 2mm 微连接扣减（±引入线），实际：" + bigLoop.cutLengthMm());
        assertFalse(plan.cutSteps().isEmpty(), "应同时导出扁平化的 CutStep 列表供机床/画布消费");
        assertTrue(plan.totalCutLengthMm() > 0 && plan.totalDistanceMm() >= plan.totalCutLengthMm());
    }
}
