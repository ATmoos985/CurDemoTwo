package com.example.cutdemotwo.algorithm.toolpath;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.contracts.geometry.ContourToolpathPlan;
import com.example.cutdemotwo.contracts.geometry.ContourToolpathPlan.ContourLoop;
import com.example.cutdemotwo.contracts.geometry.ContourToolpathPlan.Options;
import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.geometry.ToolpathResult;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import org.springframework.stereotype.Service;

import java.util.*;

/**
 * 工业级 CAD/CAM 刀路优化引擎 (Toolpath Optimization Service)：
 * <ol>
 *   <li>直刀/线段刀路：阶段约束双向最近邻 + 真正区间翻转 2-Opt + Or-opt 单段重插，最小化空刀快移距离；</li>
 *   <li>共边切割去重（{@link #deduplicateCommonEdges}）：识别任意角度重合或部分重叠切线段，杜绝激光/振动刀重切烧边；</li>
 *   <li>闭合异形轮廓 CAM 刀路优化（{@link #optimizeContourToolpath}）：小件优先防飞料 + 嵌套拓扑依赖 + 先内孔后外轮廓 +
 *       最近下刀点择优 + 可选安全引入线与防飞料微连接。</li>
 * </ol>
 */
@Service
public class ToolpathOptimizerService implements com.example.cutdemotwo.algorithm.api.ToolpathOptimizer {

    private static final double EPS = .000001;

    @Override
    public List<CutStep> optimizeAndChain(List<CutStep> rawCuts, double homeX, double homeY, boolean respectPrecedence) {
        ToolpathResult res = optimizeToolpath(rawCuts, homeX, homeY, respectPrecedence);
        return res.getOptimizedCuts() != null ? res.getOptimizedCuts() : Collections.emptyList();
    }

    @Override
    public ToolpathResult optimizeToolpath(List<CutStep> rawCuts, double homeX, double homeY, boolean respectPrecedence) {
        ComputationCancellation.check();
        if (!Double.isFinite(homeX) || !Double.isFinite(homeY)) throw new IllegalArgumentException("起刀坐标无效");
        ToolpathResult result = new ToolpathResult();
        result.setStartX(homeX);
        result.setStartY(homeY);

        if (rawCuts == null || rawCuts.isEmpty()) {
            result.setOptimizedCuts(Collections.emptyList());
            return result;
        }

        // 1. 构建段结构与计算原始基线空程
        List<CutSegment> segments = segments(rawCuts, respectPrecedence);
        List<CutSegment> original = segments(rawCuts, respectPrecedence);
        double totalCutLen = 0.0;
        for (CutSegment seg : segments) {
            ComputationCancellation.check();
            totalCutLen += seg.length;
        }
        result.setCutDistance(round1(totalCutLen));

        double originalAir = calculateTourAirDistance(segments, homeX, homeY);
        result.setOriginalAirDistance(round1(originalAir));

        // 2. 启发式双向最近邻求解 (Directional Nearest Neighbor)
        List<CutSegment> optimized = respectPrecedence
                ? solveStageConstrainedTSP(segments, homeX, homeY)
                : solveUnconstrainedSegmentTSP(segments, homeX, homeY);

        // 3. 真正区间翻转 2-Opt + 端点翻转 + Or-opt 重插精修
        optimized = run2OptRefinement(optimized, homeX, homeY, respectPrecedence);

        // 4. 若原始序列本身合法且更短则保留基线（保证单调不退化）
        double optimizedAir = calculateTourAirDistance(optimized, homeX, homeY);
        if (ordered(original) && originalAir <= optimizedAir + EPS) {
            optimized = original;
            optimizedAir = originalAir;
        }
        result.setOptimizedAirDistance(round1(optimizedAir));
        double saved = Math.max(0, originalAir - optimizedAir);
        result.setSavedAirDistance(round1(saved));
        result.setSavingRatio(originalAir > 0 ? Math.round((saved / originalAir) * 1000.0) / 10.0 : 0.0);
        result.setTotalDistance(round1(totalCutLen + optimizedAir));

        result.setOptimizedCuts(chain(optimized, homeX, homeY));
        return result;
    }

    /**
     * 共边切割去重：对输入切线段序列按先后顺序执行精确几何共线投影与重叠区间扣除，
     * 支持水平、垂直及任意角度异形斜边，彻底避免相邻共边重切烧边。
     */
    @Override
    public List<CutStep> deduplicateCommonEdges(List<CutStep> cuts, double toleranceMm) {
        ComputationCancellation.check();
        if (cuts == null || cuts.isEmpty()) {
            return List.of();
        }
        if (!Double.isFinite(toleranceMm) || toleranceMm < 0.0 || toleranceMm > 10.0) {
            throw new IllegalArgumentException("共边去重容差应为 0–10 mm 有效数值");
        }
        double tol = Math.max(1e-4, toleranceMm);
        double minResidualLen = Math.max(tol, 1e-3);

        List<LineRecord> keptLines = new ArrayList<>(cuts.size());
        List<CutStep> deduped = new ArrayList<>(cuts.size());

        for (CutStep raw : cuts) {
            ComputationCancellation.check();
            CutSegment seg = new CutSegment(raw);
            if (seg.length <= minResidualLen) {
                continue;
            }
            // 归一化单位方向向量（固定到半平面：ux > 0 或 ux≈0 且 uy > 0），便于精确识别共线同向/反向边
            double ux = (seg.p2x - seg.p1x) / seg.length;
            double uy = (seg.p2y - seg.p1y) / seg.length;
            if (ux < -1e-7 || (Math.abs(ux) <= 1e-7 && uy < 0.0)) {
                ux = -ux;
                uy = -uy;
            }
            double tStartRaw = seg.p1x * ux + seg.p1y * uy;
            double tEndRaw = seg.p2x * ux + seg.p2y * uy;
            double tMin = Math.min(tStartRaw, tEndRaw);
            double tMax = Math.max(tStartRaw, tEndRaw);
            boolean forwardAlongU = tEndRaw >= tStartRaw;

            List<double[]> covered = new ArrayList<>();
            for (LineRecord prev : keptLines) {
                // 1) 方向平行判定（叉积接近 0）
                double cross = Math.abs(ux * prev.uy - uy * prev.ux);
                if (cross > 1e-4) continue;
                // 2) 两端点到当前直线的垂直距离均在容差内
                double d1 = Math.abs(-(prev.x1 - seg.p1x) * uy + (prev.y1 - seg.p1y) * ux);
                if (d1 > tol) continue;
                double d2 = Math.abs(-(prev.x2 - seg.p1x) * uy + (prev.y2 - seg.p1y) * ux);
                if (d2 > tol) continue;

                double p1 = prev.x1 * ux + prev.y1 * uy;
                double p2 = prev.x2 * ux + prev.y2 * uy;
                double cMin = Math.min(p1, p2);
                double cMax = Math.max(p1, p2);
                if (cMax > tMin + EPS && cMin < tMax - EPS) {
                    covered.add(new double[]{Math.max(tMin, cMin), Math.min(tMax, cMax)});
                }
            }

            if (covered.isEmpty()) {
                CutStep copy = cloneStep(raw, deduped.size() + 1, seg.p1x, seg.p1y, seg.p2x, seg.p2y);
                deduped.add(copy);
                keptLines.add(new LineRecord(seg.p1x, seg.p1y, seg.p2x, seg.p2y, ux, uy));
                continue;
            }

            List<double[]> residuals = subtractIntervals(tMin, tMax, covered, minResidualLen);
            if (!forwardAlongU) {
                Collections.reverse(residuals);
            }
            for (double[] span : residuals) {
                double ta = forwardAlongU ? span[0] : span[1];
                double tb = forwardAlongU ? span[1] : span[0];
                double x1 = seg.p1x + (ta - tStartRaw) * ux;
                double y1 = seg.p1y + (ta - tStartRaw) * uy;
                double x2 = seg.p1x + (tb - tStartRaw) * ux;
                double y2 = seg.p1y + (tb - tStartRaw) * uy;
                CutStep trimmed = cloneStep(raw, deduped.size() + 1, x1, y1, x2, y2);
                deduped.add(trimmed);
                keptLines.add(new LineRecord(x1, y1, x2, y2, ux, uy));
            }
        }
        return deduped;
    }

    /**
     * 闭合异形轮廓 CAM 刀路优化器：
     * <ul>
     *   <li>严格遵守<b>先内孔后外轮廓</b>与<b>内孔嵌套子件先于外母件</b>的物理防飞料拓扑顺序；</li>
     *   <li>开启 {@code smallPartsFirst} 时按面积梯度分层，确保小件优先切割防止母板失稳飞料；</li>
     *   <li>同层内结合最近邻 + 2-Opt 压缩轮廓间空走刀，并为每个闭合环择优最近下刀点；</li>
     *   <li>支持可选废料侧引入线 {@code leadInMm}、末段防飞料微连接 {@code microJointWidthMm} 及可选共边去重。</li>
     * </ul>
     */
    @Override
    public ContourToolpathPlan optimizeContourToolpath(List<Placement> placements, Options options) {
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
            double beforeCutLen = sumCutStepsLength(rawSteps);
            finalSteps = deduplicateCommonEdges(rawSteps, opt.commonEdgeToleranceMm());
            double afterCutLen = sumCutStepsLength(finalSteps);
            dedupSavedLen = Math.max(0.0, beforeCutLen - afterCutLen);
            totalCutLen = afterCutLen;
            recomputeStepAirDistances(finalSteps, opt.homeX(), opt.homeY());
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

    private List<CutStep> chain(List<CutSegment> optimized, double homeX, double homeY) {
        List<CutStep> finalCuts = new ArrayList<>();
        double curX = homeX;
        double curY = homeY;
        for (int i = 0; i < optimized.size(); i++) {
            ComputationCancellation.check();
            CutSegment seg = optimized.get(i);
            double airDist = Math.hypot(seg.startX - curX, seg.startY - curY);

            CutStep cs = new CutStep(
                    i + 1,
                    seg.original.getType(),
                    seg.original.getPos(),
                    seg.original.getStart(),
                    seg.original.getEnd(),
                    seg.original.getDesc()
            );
            cs.setStartX(seg.startX);
            cs.setStartY(seg.startY);
            cs.setEndX(seg.endX);
            cs.setEndY(seg.endY);
            cs.setAirDistance(round1(airDist));
            cs.setStage(seg.original.getStage());
            finalCuts.add(cs);

            curX = seg.endX;
            curY = seg.endY;
        }

        return finalCuts;
    }

    /** Only reorder/reverse saved segments; never trust client stage, geometry or distance metadata. */
    @Override
    public List<CutStep> validateReorderedCuts(List<CutStep> saved, List<CutStep> proposed,
                                              double homeX, double homeY, boolean respectPrecedence) {
        if (saved == null || proposed == null || proposed.size() != saved.size())
            throw new IllegalArgumentException("刀路调整不能增加或删除切割线");
        Map<String, Deque<CutSegment>> available = new HashMap<>();
        for (CutSegment s : segments(saved, respectPrecedence))
            available.computeIfAbsent(s.key(), k -> new ArrayDeque<>()).add(s);
        List<CutSegment> tour = new ArrayList<>();
        for (CutStep cut : proposed) {
            ComputationCancellation.check();
            CutSegment candidate = new CutSegment(cut);
            Deque<CutSegment> matches = available.get(candidate.key());
            if (matches == null || matches.isEmpty()) throw new IllegalArgumentException("刀路调整改变了原切割线");
            CutSegment source = matches.removeFirst();
            boolean forward = Math.hypot(candidate.p1x - source.p1x, candidate.p1y - source.p1y) < EPS
                    && Math.hypot(candidate.p2x - source.p2x, candidate.p2y - source.p2y) < EPS;
            boolean reverse = Math.hypot(candidate.p1x - source.p2x, candidate.p1y - source.p2y) < EPS
                    && Math.hypot(candidate.p2x - source.p1x, candidate.p2y - source.p1y) < EPS;
            if (!forward && !reverse) throw new IllegalArgumentException("刀路调整改变了原切割线端点");
            source.setDirection(reverse);
            tour.add(source);
        }
        if (!ordered(tour)) throw new IllegalArgumentException("刀路调整违反原方案的切割先后顺序");
        return chain(tour, homeX, homeY);
    }

    private List<CutSegment> segments(List<CutStep> cuts, boolean respectPrecedence) {
        List<CutSegment> result = new ArrayList<>();
        for (CutStep c : cuts) result.add(new CutSegment(c));
        boolean explicitStages = result.stream().allMatch(s -> s.original.getStage() != null);
        for (int i = 0; i < result.size(); i++)
            result.get(i).stage = !respectPrecedence ? 1 : explicitStages ? result.get(i).original.getStage() : i + 1;
        return result;
    }

    private boolean ordered(List<CutSegment> cuts) {
        for (int i = 1; i < cuts.size(); i++) if (cuts.get(i - 1).stage > cuts.get(i).stage) return false;
        return true;
    }

    private List<CutSegment> solveStageConstrainedTSP(List<CutSegment> segments, double homeX, double homeY) {
        Map<Integer, List<CutSegment>> stageMap = new TreeMap<>();
        for (CutSegment seg : segments) {
            ComputationCancellation.check();
            stageMap.computeIfAbsent(seg.stage, k -> new ArrayList<>()).add(seg);
        }

        List<CutSegment> tour = new ArrayList<>();
        double curX = homeX;
        double curY = homeY;

        for (Map.Entry<Integer, List<CutSegment>> entry : stageMap.entrySet()) {
            ComputationCancellation.check();
            List<CutSegment> pool = new ArrayList<>(entry.getValue());
            while (!pool.isEmpty()) {
                ComputationCancellation.check();
                int bestIdx = -1;
                boolean bestReverse = false;
                double bestDist = Double.MAX_VALUE;

                for (int i = 0; i < pool.size(); i++) {
                    ComputationCancellation.check();
                    CutSegment s = pool.get(i);
                    double d1 = Math.hypot(s.p1x - curX, s.p1y - curY);
                    if (d1 < bestDist) {
                        bestDist = d1;
                        bestIdx = i;
                        bestReverse = false;
                    }
                    double d2 = Math.hypot(s.p2x - curX, s.p2y - curY);
                    if (d2 < bestDist) {
                        bestDist = d2;
                        bestIdx = i;
                        bestReverse = true;
                    }
                }

                CutSegment chosen = pool.remove(bestIdx);
                chosen.setDirection(bestReverse);
                tour.add(chosen);
                curX = chosen.endX;
                curY = chosen.endY;
            }
        }
        return tour;
    }

    private List<CutSegment> solveUnconstrainedSegmentTSP(List<CutSegment> segments, double homeX, double homeY) {
        List<CutSegment> pool = new ArrayList<>(segments);
        List<CutSegment> tour = new ArrayList<>();
        double curX = homeX;
        double curY = homeY;

        while (!pool.isEmpty()) {
            ComputationCancellation.check();
            int bestIdx = -1;
            boolean bestReverse = false;
            double bestDist = Double.MAX_VALUE;

            for (int i = 0; i < pool.size(); i++) {
                ComputationCancellation.check();
                CutSegment s = pool.get(i);
                double d1 = Math.hypot(s.p1x - curX, s.p1y - curY);
                if (d1 < bestDist) {
                    bestDist = d1;
                    bestIdx = i;
                    bestReverse = false;
                }
                double d2 = Math.hypot(s.p2x - curX, s.p2y - curY);
                if (d2 < bestDist) {
                    bestDist = d2;
                    bestIdx = i;
                    bestReverse = true;
                }
            }

            CutSegment chosen = pool.remove(bestIdx);
            chosen.setDirection(bestReverse);
            tour.add(chosen);
            curX = chosen.endX;
            curY = chosen.endY;
        }
        return tour;
    }

    /**
     * 工业级有向线段局部精修：
     * <ol>
     *   <li>单段方向最优翻转（Flip Orientation）；</li>
     *   <li><b>真正区间翻转 2-Opt</b>：对同阶段子区间 {@code [i..j]} 整体逆序并翻转区间内每段方向，
     *       利用欧氏对称性在 $O(1)$ 精确评估两端连接边增量，真正消除交叉空程回路；</li>
     *   <li>同阶段 <b>Or-opt 单段重插</b>（双向择优），进一步压降空走刀总距离。</li>
     * </ol>
     */
    private List<CutSegment> run2OptRefinement(List<CutSegment> tour, double homeX, double homeY, boolean respectPrecedence) {
        int n = tour.size();
        if (n <= 1) return tour;

        boolean improved = true;
        int maxPasses = n <= 200 ? 120 : 40;
        int pass = 0;

        while (improved && pass++ < maxPasses) {
            ComputationCancellation.check();
            improved = false;

            // 1. 单段方向翻转 (Flip orientation)
            for (int i = 0; i < n; i++) {
                ComputationCancellation.check();
                double prevX = (i == 0) ? homeX : tour.get(i - 1).endX;
                double prevY = (i == 0) ? homeY : tour.get(i - 1).endY;
                CutSegment s = tour.get(i);

                double curAir = Math.hypot(s.startX - prevX, s.startY - prevY)
                        + (i < n - 1 ? Math.hypot(tour.get(i + 1).startX - s.endX, tour.get(i + 1).startY - s.endY) : 0.0);
                double flippedAir = Math.hypot(s.endX - prevX, s.endY - prevY)
                        + (i < n - 1 ? Math.hypot(tour.get(i + 1).startX - s.startX, tour.get(i + 1).startY - s.startY) : 0.0);

                if (flippedAir + 1e-4 < curAir) {
                    s.setDirection(!s.isReversed);
                    improved = true;
                }
            }

            // 2. 真正区间翻转 2-Opt（对同阶段区间 [i..j] 逆序并反转区间内全部线段方向）
            // 由于区间内任意相邻段空程 dist(s_k.end, s_{k+1}.start) == dist(rev(s_{k+1}).end, rev(s_k).start) 完全守恒，
            // 仅需 O(1) 对比区间入口与出口两条空程边！
            int maxWindow = n <= 350 ? n : 80;
            for (int i = 0; i < n - 1; i++) {
                ComputationCancellation.check();
                int stageI = tour.get(i).stage;
                double prevX = (i == 0) ? homeX : tour.get(i - 1).endX;
                double prevY = (i == 0) ? homeY : tour.get(i - 1).endY;
                CutSegment si = tour.get(i);

                int jMax = Math.min(n - 1, i + maxWindow);
                for (int j = i + 1; j <= jMax; j++) {
                    CutSegment sj = tour.get(j);
                    if (respectPrecedence && sj.stage != stageI) {
                        break; // tour 按 stage 升序排列，一旦越界后续全部不同阶段
                    }

                    double curBoundaryAir = Math.hypot(si.startX - prevX, si.startY - prevY)
                            + (j + 1 < n ? Math.hypot(tour.get(j + 1).startX - sj.endX, tour.get(j + 1).startY - sj.endY) : 0.0);

                    // 区间 [i..j] 反转后：首段为 rev(sj)（新起点为 sj.end），末段为 rev(si)（新终点为 si.start）
                    double newBoundaryAir = Math.hypot(sj.endX - prevX, sj.endY - prevY)
                            + (j + 1 < n ? Math.hypot(tour.get(j + 1).startX - si.startX, tour.get(j + 1).startY - si.startY) : 0.0);

                    if (newBoundaryAir + 1e-4 < curBoundaryAir) {
                        reverseSubTour(tour, i, j);
                        si = tour.get(i);
                        improved = true;
                    }
                }
            }

            // 3. 同阶段 Or-opt 单段重插（规模受控时启用，打破 2-Opt 局部极小）
            if (n <= 200) {
                for (int i = 0; i < n; i++) {
                    ComputationCancellation.check();
                    CutSegment seg = tour.get(i);
                    int segStage = seg.stage;

                    double prevX = (i == 0) ? homeX : tour.get(i - 1).endX;
                    double prevY = (i == 0) ? homeY : tour.get(i - 1).endY;
                    double removeSaving = Math.hypot(seg.startX - prevX, seg.startY - prevY)
                            + (i + 1 < n ? Math.hypot(tour.get(i + 1).startX - seg.endX, tour.get(i + 1).startY - seg.endY) : 0.0)
                            - (i + 1 < n ? Math.hypot(tour.get(i + 1).startX - prevX, tour.get(i + 1).startY - prevY) : 0.0);

                    int bestPos = -1;
                    boolean bestRev = seg.isReversed;
                    double bestDelta = -1e-4;

                    // 找到同阶段的起止范围 [stageStart, stageEnd]
                    int stageStart = i;
                    while (stageStart > 0 && (!respectPrecedence || tour.get(stageStart - 1).stage == segStage)) {
                        stageStart--;
                    }
                    int stageEnd = i;
                    while (stageEnd + 1 < n && (!respectPrecedence || tour.get(stageEnd + 1).stage == segStage)) {
                        stageEnd++;
                    }

                    for (int pos = stageStart; pos <= stageEnd; pos++) {
                        if (pos == i) continue;
                        // 若移出 i 后插入到目标索引 pos，求插入处前驱与后继（用原下标映射，零列表拷贝）
                        double beforeX, beforeY;
                        CutSegment afterSeg;
                        if (pos < i) {
                            beforeX = (pos == 0) ? homeX : tour.get(pos - 1).endX;
                            beforeY = (pos == 0) ? homeY : tour.get(pos - 1).endY;
                            afterSeg = tour.get(pos);
                        } else {
                            beforeX = tour.get(pos).endX;
                            beforeY = tour.get(pos).endY;
                            afterSeg = (pos + 1 < n) ? tour.get(pos + 1) : null;
                        }
                        double brokenEdge = afterSeg != null ? Math.hypot(afterSeg.startX - beforeX, afterSeg.startY - beforeY) : 0.0;

                        // 试正向 (p1 -> p2) 与逆向 (p2 -> p1)
                        double addFwd = Math.hypot(seg.p1x - beforeX, seg.p1y - beforeY)
                                + (afterSeg != null ? Math.hypot(afterSeg.startX - seg.p2x, afterSeg.startY - seg.p2y) : 0.0)
                                - brokenEdge;
                        double deltaFwd = addFwd - removeSaving;
                        if (deltaFwd < bestDelta) {
                            bestDelta = deltaFwd;
                            bestPos = pos;
                            bestRev = false;
                        }

                        double addRev = Math.hypot(seg.p2x - beforeX, seg.p2y - beforeY)
                                + (afterSeg != null ? Math.hypot(afterSeg.startX - seg.p1x, afterSeg.startY - seg.p1y) : 0.0)
                                - brokenEdge;
                        double deltaRev = addRev - removeSaving;
                        if (deltaRev < bestDelta) {
                            bestDelta = deltaRev;
                            bestPos = pos;
                            bestRev = true;
                        }
                    }

                    if (bestPos >= 0) {
                        CutSegment moved = tour.remove(i);
                        moved.setDirection(bestRev);
                        tour.add(bestPos, moved);
                        improved = true;
                    }
                }
            }
        }
        return tour;
    }

    private static void reverseSubTour(List<CutSegment> tour, int i, int j) {
        int left = i;
        int right = j;
        while (left < right) {
            CutSegment a = tour.get(left);
            CutSegment b = tour.get(right);
            a.setDirection(!a.isReversed);
            b.setDirection(!b.isReversed);
            tour.set(left, b);
            tour.set(right, a);
            left++;
            right--;
        }
        if (left == right) {
            CutSegment mid = tour.get(left);
            mid.setDirection(!mid.isReversed);
        }
    }

    private double calculateTourAirDistance(List<CutSegment> tour, double homeX, double homeY) {
        double air = 0.0;
        double curX = homeX;
        double curY = homeY;
        for (CutSegment s : tour) {
            ComputationCancellation.check();
            air += Math.hypot(s.startX - curX, s.startY - curY);
            curX = s.endX;
            curY = s.endY;
        }
        return air;
    }

    // ==================== 闭合轮廓刀路优化辅助方法 ====================

    private record LineRecord(double x1, double y1, double x2, double y2, double ux, double uy) {}

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

    private static CutStep cloneStep(CutStep template, int stepIdx, double x1, double y1, double x2, double y2) {
        CutStep cs = new CutStep();
        cs.setStep(stepIdx);
        cs.setType(template.getType());
        cs.setDesc(template.getDesc());
        cs.setStage(template.getStage());
        cs.setStartX(x1);
        cs.setStartY(y1);
        cs.setEndX(x2);
        cs.setEndY(y2);
        if ("横切".equals(template.getType())) {
            cs.setPos((y1 + y2) * 0.5);
            cs.setStart(Math.min(x1, x2));
            cs.setEnd(Math.max(x1, x2));
        } else if ("纵切".equals(template.getType())) {
            cs.setPos((x1 + x2) * 0.5);
            cs.setStart(Math.min(y1, y2));
            cs.setEnd(Math.max(y1, y2));
        } else {
            cs.setPos(0.0);
            cs.setStart(0.0);
            cs.setEnd(Math.hypot(x2 - x1, y2 - y1));
        }
        cs.setAirDistance(template.getAirDistance());
        return cs;
    }

    private static List<double[]> subtractIntervals(double start, double end, List<double[]> covered, double minLen) {
        List<double[]> sorted = new ArrayList<>(covered);
        sorted.sort(Comparator.comparingDouble(a -> a[0]));
        List<double[]> merged = new ArrayList<>(sorted.size());
        double[] cur = new double[]{sorted.get(0)[0], sorted.get(0)[1]};
        for (int i = 1; i < sorted.size(); i++) {
            double[] next = sorted.get(i);
            if (next[0] <= cur[1] + EPS) {
                cur[1] = Math.max(cur[1], next[1]);
            } else {
                merged.add(cur);
                cur = new double[]{next[0], next[1]};
            }
        }
        merged.add(cur);

        List<double[]> residuals = new ArrayList<>();
        double cursor = start;
        for (double[] cov : merged) {
            if (cov[1] <= cursor + EPS) continue;
            if (cov[0] >= end - EPS) break;
            if (cov[0] - cursor > minLen) {
                residuals.add(new double[]{cursor, Math.min(end, cov[0])});
            }
            cursor = Math.max(cursor, cov[1]);
            if (cursor >= end - EPS) break;
        }
        if (end - cursor > minLen) {
            residuals.add(new double[]{cursor, end});
        }
        return residuals;
    }

    private static double sumCutStepsLength(List<CutStep> steps) {
        double sum = 0.0;
        for (CutStep cs : steps) {
            CutSegment seg = new CutSegment(cs);
            sum += seg.length;
        }
        return sum;
    }

    private static void recomputeStepAirDistances(List<CutStep> steps, double homeX, double homeY) {
        double curX = homeX, curY = homeY;
        for (CutStep cs : steps) {
            CutSegment seg = new CutSegment(cs);
            cs.setAirDistance(round1(Math.hypot(seg.p1x - curX, seg.p1y - curY)));
            curX = seg.p2x;
            curY = seg.p2y;
        }
    }

    private static double round1(double value) {
        return Math.round(value * 10.0) / 10.0;
    }

    private static double round2(double value) {
        return Math.round(value * 100.0) / 100.0;
    }

    private static class CutSegment {
        CutStep original;
        int stage = 1;
        double p1x, p1y;
        double p2x, p2y;
        double startX, startY;
        double endX, endY;
        double length;
        boolean isReversed = false;

        CutSegment(CutStep cs) {
            if (cs == null || !("横切".equals(cs.getType()) || "纵切".equals(cs.getType()) || "轮廓切".equals(cs.getType())))
                throw new IllegalArgumentException("刀路包含无效切割类型");
            if (cs.getStage() != null && cs.getStage() <= 0) throw new IllegalArgumentException("切割阶段必须为正数");
            this.original = cs;
            int coordinates = (cs.getStartX() == null ? 0 : 1) + (cs.getStartY() == null ? 0 : 1)
                    + (cs.getEndX() == null ? 0 : 1) + (cs.getEndY() == null ? 0 : 1);
            if (("轮廓切".equals(cs.getType()) && coordinates != 4) || (coordinates != 0 && coordinates != 4))
                throw new IllegalArgumentException("刀路端点坐标不完整");
            if (cs.getStartX() != null && cs.getEndX() != null && cs.getStartY() != null && cs.getEndY() != null) {
                p1x = cs.getStartX();
                p1y = cs.getStartY();
                p2x = cs.getEndX();
                p2y = cs.getEndY();
            } else if ("横切".equals(cs.getType())) {
                p1x = cs.getStart();
                p1y = cs.getPos();
                p2x = cs.getEnd();
                p2y = cs.getPos();
            } else {
                p1x = cs.getPos();
                p1y = cs.getStart();
                p2x = cs.getPos();
                p2y = cs.getEnd();
            }
            for (double value : new double[]{cs.getPos(), cs.getStart(), cs.getEnd(), p1x, p1y, p2x, p2y})
                if (!Double.isFinite(value)) throw new IllegalArgumentException("刀路坐标必须为有限数值");
            boolean horizontal = "横切".equals(cs.getType());
            if (!"轮廓切".equals(cs.getType()) && (Math.abs((horizontal ? p1y : p1x) - cs.getPos()) > EPS
                    || Math.abs((horizontal ? p2y : p2x) - cs.getPos()) > EPS
                    || Math.abs(Math.min(horizontal ? p1x : p1y, horizontal ? p2x : p2y) - Math.min(cs.getStart(), cs.getEnd())) > EPS
                    || Math.abs(Math.max(horizontal ? p1x : p1y, horizontal ? p2x : p2y) - Math.max(cs.getStart(), cs.getEnd())) > EPS))
                throw new IllegalArgumentException("刀路端点与切割线不一致");
            this.length = Math.hypot(p2x - p1x, p2y - p1y);
            this.startX = p1x;
            this.startY = p1y;
            this.endX = p2x;
            this.endY = p2y;
        }

        String key() {
            return original.getType() + ":" + Math.round(original.getPos() * 10) + ":"
                    + Math.round(Math.min(original.getStart(), original.getEnd()) * 10) + ":"
                    + Math.round(Math.max(original.getStart(), original.getEnd()) * 10);
        }

        void setDirection(boolean reverse) {
            this.isReversed = reverse;
            if (reverse) {
                this.startX = p2x;
                this.startY = p2y;
                this.endX = p1x;
                this.endY = p1y;
            } else {
                this.startX = p1x;
                this.startY = p1y;
                this.endX = p2x;
                this.endY = p2y;
            }
        }
    }
}
