package com.example.cutdemotwo.algorithm.toolpath;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.contracts.geometry.ContourToolpathPlan;
import com.example.cutdemotwo.contracts.geometry.ContourToolpathPlan.ContourLoop;
import com.example.cutdemotwo.contracts.geometry.ContourToolpathPlan.Options;
import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;

import static com.example.cutdemotwo.algorithm.toolpath.ToolpathCommonEdgeDeduplicator.EPS;
import static com.example.cutdemotwo.algorithm.toolpath.ToolpathCommonEdgeDeduplicator.round1;
import static com.example.cutdemotwo.algorithm.toolpath.ToolpathCommonEdgeDeduplicator.round2;

/**
 * 闭合异形轮廓 CAM 刀路规划器（无 Spring 注解，包级辅助类）。
 */
final class ContourToolpathPlanner {

    private ContourToolpathPlanner() {}

    static ContourToolpathPlan optimizeContourToolpath(List<Placement> placements, Options options) {
        ComputationCancellation.check();
        Options opt = options == null ? Options.defaults(0.0, 0.0) : options;
        if (!Double.isFinite(opt.homeX()) || !Double.isFinite(opt.homeY())) {
            throw new IllegalArgumentException("起刀原点坐标无效");
        }
        if (!Double.isFinite(opt.leadInMm()) || opt.leadInMm() < 0.0 || opt.leadInMm() > 100.0) {
            throw new IllegalArgumentException("引入线长度 leadInMm 应为 0–100 mm");
        }
        if (!Double.isFinite(opt.microJointWidthMm()) || opt.microJointWidthMm() < 0.0 || opt.microJointWidthMm() > 50.0) {
            throw new IllegalArgumentException("微连接宽度 microJointWidthMm 应为 0–50 mm");
        }
        if (placements == null || placements.isEmpty()) {
            return new ContourToolpathPlan(opt.homeX(), opt.homeY(), 0, 0, 0, 0, 0, 0, 0, List.of(), List.of());
        }

        // 1. 提取每件裁片的世界坐标外环与全部内孔环
        List<PartContourNode> nodes = new ArrayList<>(placements.size());
        for (int i = 0; i < placements.size(); i++) {
            ComputationCancellation.check();
            Placement pl = placements.get(i);
            Shape shape = pl.shape();
            List<Point> outerWorld = translateRing(PolygonGeometry.vertices(shape), pl.x(), pl.y());
            List<List<Point>> holeWorlds = new ArrayList<>(shape.holes().size());
            for (List<Point> hole : shape.holes()) {
                holeWorlds.add(translateRing(hole, pl.x(), pl.y()));
            }
            double area = PolygonGeometry.area(shape);
            double[] centroid = ringCentroid(outerWorld);
            nodes.add(new PartContourNode(i, pl, outerWorld, holeWorlds, area, centroid[0], centroid[1]));
        }

        // 2. 检测孔内嵌套父子拓扑依赖（若 B 位于 A 的内孔中，则 B 深度严格小于 A，必须先切 B 再切 A）
        int m = nodes.size();
        boolean[][] mustPrecede = new boolean[m][m]; // mustPrecede[child][parent] = true
        for (int a = 0; a < m; a++) {
            PartContourNode parent = nodes.get(a);
            if (parent.holeWorlds.isEmpty()) continue;
            for (int b = 0; b < m; b++) {
                if (a == b) continue;
                PartContourNode child = nodes.get(b);
                if (child.outerWorld.isEmpty()) continue;
                Point probe = new Point(child.cx, child.cy);
                Point sampleVert = child.outerWorld.get(0);
                for (List<Point> hole : parent.holeWorlds) {
                    if (PolygonGeometry.pointStrictlyInsideRing(probe, hole)
                            || PolygonGeometry.pointStrictlyInsideRing(sampleVert, hole)) {
                        mustPrecede[b][a] = true;
                        break;
                    }
                }
            }
        }
        int[] nestingLevel = new int[m];
        for (int pass = 0; pass < m; pass++) {
            boolean updated = false;
            for (int child = 0; child < m; child++) {
                for (int parent = 0; parent < m; parent++) {
                    if (mustPrecede[child][parent] && nestingLevel[parent] <= nestingLevel[child]) {
                        nestingLevel[parent] = nestingLevel[child] + 1;
                        updated = true;
                    }
                }
            }
            if (!updated) break;
        }

        // 3. 计算未优化原始顺序的基线空程（按输入顺序，先内孔后外轮廓，0 号顶点起切）
        double originalAir = computeBaselineContourAir(nodes, opt.homeX(), opt.homeY());

        // 4. 按防飞料优先级分层（nestingLevel 为主，开启 smallPartsFirst 时再按面积升序分桶）
        List<List<PartContourNode>> priorityTiers = buildPriorityTiers(nodes, nestingLevel, opt.smallPartsFirst());

        // 5. 逐层执行最近邻 + 2-Opt 轮廓排序，层内所有件严格遵循“先内孔后外轮廓”与最近下刀点择优
        List<ContourLoop> loops = new ArrayList<>();
        List<CutStep> rawSteps = new ArrayList<>();
        double curX = opt.homeX();
        double curY = opt.homeY();
        double totalAir = 0.0;
        double totalCutLen = 0.0;
        int loopSeq = 1;

        for (List<PartContourNode> tier : priorityTiers) {
            ComputationCancellation.check();
            List<PartContourNode> orderedTier = orderTierByNearestAnd2Opt(tier, curX, curY);

            for (PartContourNode node : orderedTier) {
                ComputationCancellation.check();
                // 5a. 先切全部内孔（多内孔按最近邻排序）
                List<Integer> remainingHoles = new ArrayList<>(node.holeWorlds.size());
                for (int hi = 0; hi < node.holeWorlds.size(); hi++) {
                    remainingHoles.add(hi);
                }
                while (!remainingHoles.isEmpty()) {
                    int bestPosInList = 0;
                    int bestHoleIdx = remainingHoles.get(0);
                    int bestVertIdx = 0;
                    double bestDist = Double.MAX_VALUE;
                    for (int ri = 0; ri < remainingHoles.size(); ri++) {
                        int hi = remainingHoles.get(ri);
                        List<Point> hole = node.holeWorlds.get(hi);
                        int vi = nearestVertexIndex(hole, curX, curY);
                        double d = Math.hypot(hole.get(vi).x() - curX, hole.get(vi).y() - curY);
                        if (d < bestDist) {
                            bestDist = d;
                            bestPosInList = ri;
                            bestHoleIdx = hi;
                            bestVertIdx = vi;
                        }
                    }
                    remainingHoles.remove(bestPosInList);
                    List<Point> holeRing = node.holeWorlds.get(bestHoleIdx);
                    LoopEmit emitted = emitContourLoop(
                            loopSeq++, node.placement, true, bestHoleIdx, holeRing, bestVertIdx,
                            curX, curY, opt.leadInMm(), opt.microJointWidthMm(), rawSteps
                    );
                    loops.add(emitted.loop);
                    totalAir += emitted.airDist;
                    totalCutLen += emitted.cutLen;
                    curX = emitted.endX;
                    curY = emitted.endY;
                }

                // 5b. 后切外轮廓
                int outerEntryIdx = nearestVertexIndex(node.outerWorld, curX, curY);
                LoopEmit emittedOuter = emitContourLoop(
                        loopSeq++, node.placement, false, -1, node.outerWorld, outerEntryIdx,
                        curX, curY, opt.leadInMm(), opt.microJointWidthMm(), rawSteps
                );
                loops.add(emittedOuter.loop);
                totalAir += emittedOuter.airDist;
                totalCutLen += emittedOuter.cutLen;
                curX = emittedOuter.endX;
                curY = emittedOuter.endY;
            }
        }

        // 6. 可选共边切割去重与统计
        List<CutStep> finalSteps = rawSteps;
        double dedupSavedLen = 0.0;
        if (opt.deduplicateCommonEdges() && !rawSteps.isEmpty()) {
            double beforeCutLen = ToolpathCommonEdgeDeduplicator.sumCutStepsLength(rawSteps);
            finalSteps = ToolpathCommonEdgeDeduplicator.deduplicateCommonEdges(rawSteps, opt.commonEdgeToleranceMm());
            double afterCutLen = ToolpathCommonEdgeDeduplicator.sumCutStepsLength(finalSteps);
            dedupSavedLen = Math.max(0.0, beforeCutLen - afterCutLen);
            totalCutLen = afterCutLen;
            ToolpathCommonEdgeDeduplicator.recomputeStepAirDistances(finalSteps, opt.homeX(), opt.homeY());
        }

        double savedAir = Math.max(0.0, originalAir - totalAir);
        double savingRatio = originalAir > 0.0 ? Math.round((savedAir / originalAir) * 1000.0) / 10.0 : 0.0;

        return new ContourToolpathPlan(
                opt.homeX(),
                opt.homeY(),
                round1(originalAir),
                round1(totalAir),
                round1(savedAir),
                savingRatio,
                round1(totalCutLen),
                round1(dedupSavedLen),
                round1(totalCutLen + totalAir),
                loops,
                finalSteps
        );
    }

    private static final class PartContourNode {
        final int index;
        final Placement placement;
        final List<Point> outerWorld;
        final List<List<Point>> holeWorlds;
        final double areaMm2;
        final double cx;
        final double cy;

        PartContourNode(int index, Placement placement, List<Point> outerWorld,
                        List<List<Point>> holeWorlds, double areaMm2, double cx, double cy) {
            this.index = index;
            this.placement = placement;
            this.outerWorld = outerWorld;
            this.holeWorlds = holeWorlds;
            this.areaMm2 = areaMm2;
            this.cx = cx;
            this.cy = cy;
        }
    }

    private record LoopEmit(ContourLoop loop, double airDist, double cutLen, double endX, double endY) {}

    private static List<Point> translateRing(List<Point> localVerts, double dx, double dy) {
        List<Point> out = new ArrayList<>(localVerts.size());
        for (Point p : localVerts) {
            out.add(new Point(p.x() + dx, p.y() + dy));
        }
        return out;
    }

    private static double[] ringCentroid(List<Point> ring) {
        if (ring.isEmpty()) return new double[]{0.0, 0.0};
        double sx = 0.0, sy = 0.0;
        for (Point p : ring) {
            sx += p.x();
            sy += p.y();
        }
        return new double[]{sx / ring.size(), sy / ring.size()};
    }

    private static double computeBaselineContourAir(List<PartContourNode> nodes, double homeX, double homeY) {
        double curX = homeX, curY = homeY;
        double air = 0.0;
        for (PartContourNode node : nodes) {
            for (List<Point> hole : node.holeWorlds) {
                if (hole.isEmpty()) continue;
                Point start = hole.get(0);
                air += Math.hypot(start.x() - curX, start.y() - curY);
                curX = start.x();
                curY = start.y();
            }
            if (!node.outerWorld.isEmpty()) {
                Point start = node.outerWorld.get(0);
                air += Math.hypot(start.x() - curX, start.y() - curY);
                curX = start.x();
                curY = start.y();
            }
        }
        return air;
    }

    private static List<List<PartContourNode>> buildPriorityTiers(List<PartContourNode> nodes,
                                                                  int[] nestingLevel,
                                                                  boolean smallPartsFirst) {
        Map<Integer, List<PartContourNode>> byNesting = new TreeMap<>();
        for (PartContourNode node : nodes) {
            byNesting.computeIfAbsent(nestingLevel[node.index], k -> new ArrayList<>()).add(node);
        }

        List<List<PartContourNode>> tiers = new ArrayList<>();
        for (List<PartContourNode> group : byNesting.values()) {
            if (!smallPartsFirst || group.size() <= 1) {
                tiers.add(group);
                continue;
            }
            // 小件优先防飞料分层：按面积升序扫描，当面积跨度显著跃升（>= 1.8x）时切分优先层
            List<PartContourNode> sorted = new ArrayList<>(group);
            sorted.sort(Comparator.comparingDouble((PartContourNode n) -> n.areaMm2)
                    .thenComparingInt(n -> n.placement.id()));
            List<PartContourNode> currentTier = new ArrayList<>();
            double tierAnchorArea = sorted.get(0).areaMm2;
            for (PartContourNode n : sorted) {
                if (!currentTier.isEmpty() && n.areaMm2 >= Math.max(tierAnchorArea * 1.8, tierAnchorArea + 5000.0)) {
                    tiers.add(currentTier);
                    currentTier = new ArrayList<>();
                    tierAnchorArea = n.areaMm2;
                }
                currentTier.add(n);
            }
            if (!currentTier.isEmpty()) {
                tiers.add(currentTier);
            }
        }
        return tiers;
    }

    private static List<PartContourNode> orderTierByNearestAnd2Opt(List<PartContourNode> tier,
                                                                   double startX, double startY) {
        if (tier.size() <= 1) return tier;
        List<PartContourNode> pool = new ArrayList<>(tier);
        List<PartContourNode> tour = new ArrayList<>(tier.size());
        double curX = startX, curY = startY;
        while (!pool.isEmpty()) {
            int bestIdx = 0;
            double bestDist = Double.MAX_VALUE;
            for (int i = 0; i < pool.size(); i++) {
                PartContourNode cand = pool.get(i);
                double d = Math.hypot(cand.cx - curX, cand.cy - curY);
                if (d < bestDist) {
                    bestDist = d;
                    bestIdx = i;
                }
            }
            PartContourNode chosen = pool.remove(bestIdx);
            tour.add(chosen);
            curX = chosen.cx;
            curY = chosen.cy;
        }
        // 层内质心 2-Opt 区间翻转压缩空程
        int m = tour.size();
        boolean improved = true;
        int pass = 0;
        while (improved && pass++ < 60 && m >= 3) {
            improved = false;
            for (int i = 0; i < m - 1; i++) {
                double prevX = i == 0 ? startX : tour.get(i - 1).cx;
                double prevY = i == 0 ? startY : tour.get(i - 1).cy;
                PartContourNode ni = tour.get(i);
                for (int j = i + 1; j < m; j++) {
                    PartContourNode nj = tour.get(j);
                    double curCost = Math.hypot(ni.cx - prevX, ni.cy - prevY)
                            + (j + 1 < m ? Math.hypot(tour.get(j + 1).cx - nj.cx, tour.get(j + 1).cy - nj.cy) : 0.0);
                    double newCost = Math.hypot(nj.cx - prevX, nj.cy - prevY)
                            + (j + 1 < m ? Math.hypot(tour.get(j + 1).cx - ni.cx, tour.get(j + 1).cy - ni.cy) : 0.0);
                    if (newCost + 1e-4 < curCost) {
                        Collections.reverse(tour.subList(i, j + 1));
                        ni = tour.get(i);
                        improved = true;
                    }
                }
            }
        }
        return tour;
    }

    private static int nearestVertexIndex(List<Point> ring, double curX, double curY) {
        int bestIdx = 0;
        double bestDistSq = Double.MAX_VALUE;
        for (int i = 0; i < ring.size(); i++) {
            Point p = ring.get(i);
            double dx = p.x() - curX;
            double dy = p.y() - curY;
            double dSq = dx * dx + dy * dy;
            if (dSq < bestDistSq) {
                bestDistSq = dSq;
                bestIdx = i;
            }
        }
        return bestIdx;
    }

    private static LoopEmit emitContourLoop(int sequence,
                                            Placement placement,
                                            boolean hole,
                                            int holeIndex,
                                            List<Point> rawRing,
                                            int entryIdx,
                                            double curX,
                                            double curY,
                                            double requestedLeadIn,
                                            double requestedMicroJoint,
                                            List<CutStep> outSteps) {
        int n = rawRing.size();
        // 按选定下刀点旋转重排闭合顶点列
        List<Point> ordered = new ArrayList<>(n);
        for (int k = 0; k < n; k++) {
            ordered.add(rawRing.get((entryIdx + k) % n));
        }

        Point entry = ordered.get(0);
        double pierceX = entry.x();
        double pierceY = entry.y();
        double actualLeadIn = 0.0;

        if (requestedLeadIn > 1e-6 && n >= 3) {
            Point leadStart = computeSafeLeadInStart(ordered, hole, requestedLeadIn);
            if (leadStart != null) {
                pierceX = leadStart.x();
                pierceY = leadStart.y();
                actualLeadIn = Math.hypot(entry.x() - pierceX, entry.y() - pierceY);
            }
        }

        double airDist = Math.hypot(pierceX - curX, pierceY - curY);
        double cutLen = 0.0;
        double lastX = pierceX;
        double lastY = pierceY;
        String loopLabel = hole
                ? (placement.name() + " 内孔#" + (holeIndex + 1))
                : (placement.name() + " 外轮廓");

        // 1. 若存在引入线，先输出废料侧引入线段 pierce -> entry
        if (actualLeadIn > 1e-6) {
            CutStep leadStep = contourStep(outSteps.size() + 1, pierceX, pierceY, entry.x(), entry.y(),
                    airDist, sequence, loopLabel + " 引入线");
            outSteps.add(leadStep);
            cutLen += actualLeadIn;
            lastX = entry.x();
            lastY = entry.y();
        }

        // 2. 沿闭合轮廓逐边输出切割线段，末段按需留出微连接防止小件切断后飞料
        double actualJoint = 0.0;
        for (int i = 0; i < n; i++) {
            Point a = ordered.get(i);
            Point b = ordered.get((i + 1) % n);
            double edgeLen = Math.hypot(b.x() - a.x(), b.y() - a.y());
            if (edgeLen <= EPS) continue;

            double ex = b.x();
            double ey = b.y();
            String desc = loopLabel;
            if (i == n - 1 && requestedMicroJoint > 1e-6) {
                actualJoint = Math.min(requestedMicroJoint, edgeLen * 0.45);
                double ratio = (edgeLen - actualJoint) / edgeLen;
                ex = a.x() + (b.x() - a.x()) * ratio;
                ey = a.y() + (b.y() - a.y()) * ratio;
                desc = loopLabel + String.format(Locale.ROOT, "（留微连接 %.1fmm）", actualJoint);
            }
            double segLen = Math.hypot(ex - a.x(), ey - a.y());
            if (segLen <= EPS) continue;
            double stepAir = (i == 0 && actualLeadIn <= 1e-6) ? airDist : 0.0;
            outSteps.add(contourStep(outSteps.size() + 1, a.x(), a.y(), ex, ey, stepAir, sequence, desc));
            cutLen += segLen;
            lastX = ex;
            lastY = ey;
        }

        double areaMm2 = Math.abs(PolygonGeometry.signedArea(ordered));
        ContourLoop loop = new ContourLoop(
                sequence,
                placement.id(),
                placement.name(),
                hole,
                holeIndex,
                round1(areaMm2),
                round2(pierceX),
                round2(pierceY),
                round2(entry.x()),
                round2(entry.y()),
                round2(actualLeadIn),
                round2(actualJoint),
                ordered,
                round1(airDist),
                round1(cutLen)
        );
        return new LoopEmit(loop, airDist, cutLen, lastX, lastY);
    }

    /**
     * 在下刀点 {@code ordered.get(0)} 处计算废料侧安全引入线起点：
     * 外轮廓指向环外，内孔指向孔内空洞（自动探测校验点内外归属，确保绝不刺入工件实体）。
     */
    private static Point computeSafeLeadInStart(List<Point> ordered, boolean hole, double leadInMm) {
        int n = ordered.size();
        Point prev = ordered.get(n - 1);
        Point curr = ordered.get(0);
        Point next = ordered.get(1);

        double v1x = prev.x() - curr.x(), v1y = prev.y() - curr.y();
        double l1 = Math.hypot(v1x, v1y);
        double v2x = next.x() - curr.x(), v2y = next.y() - curr.y();
        double l2 = Math.hypot(v2x, v2y);
        if (l1 <= EPS || l2 <= EPS) return null;
        v1x /= l1; v1y /= l1;
        v2x /= l2; v2y /= l2;

        // 角平分线与法线候选方向
        double bx = v1x + v2x;
        double by = v1y + v2y;
        double bl = Math.hypot(bx, by);
        double nx, ny;
        if (bl > 1e-5) {
            nx = bx / bl;
            ny = by / bl;
        } else {
            nx = -v2y;
            ny = v2x;
        }

        // 用微小探针判断 (nx, ny) 是否指向环内：内孔要求指向环内，外轮廓要求指向环外
        double probeStep = Math.min(0.25, Math.min(l1, l2) * 0.1);
        boolean plusInside = PolygonGeometry.pointStrictlyInsideRing(
                new Point(curr.x() + nx * probeStep, curr.y() + ny * probeStep), ordered);
        if (hole != plusInside) {
            nx = -nx;
            ny = -ny;
        }

        double effLead = leadInMm;
        if (hole) {
            // 对内孔按步缩减，确保穿孔点严格落在孔空洞内部，不刺穿对壁
            for (int attempt = 0; attempt < 5; attempt++) {
                Point cand = new Point(curr.x() + nx * effLead, curr.y() + ny * effLead);
                if (PolygonGeometry.pointStrictlyInsideRing(cand, ordered)) {
                    return cand;
                }
                effLead *= 0.5;
            }
            return null;
        }
        return new Point(curr.x() + nx * effLead, curr.y() + ny * effLead);
    }

    private static CutStep contourStep(int stepIdx, double x1, double y1, double x2, double y2,
                                       double airDist, int stage, String desc) {
        CutStep cs = new CutStep();
        cs.setStep(stepIdx);
        cs.setType("轮廓切");
        cs.setPos(0.0);
        cs.setStart(0.0);
        cs.setEnd(Math.hypot(x2 - x1, y2 - y1));
        cs.setStartX(x1);
        cs.setStartY(y1);
        cs.setEndX(x2);
        cs.setEndY(y2);
        cs.setAirDistance(round1(airDist));
        cs.setStage(stage);
        cs.setDesc(desc);
        return cs;
    }
}
