package com.example.cutdemotwo.algorithm.toolpath;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.toolpath.ToolpathCommonEdgeDeduplicator.CutSegment;
import com.example.cutdemotwo.contracts.geometry.ContourToolpathPlan;
import com.example.cutdemotwo.contracts.geometry.ContourToolpathPlan.Options;
import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.geometry.ToolpathResult;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import org.springframework.stereotype.Service;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import static com.example.cutdemotwo.algorithm.toolpath.ToolpathCommonEdgeDeduplicator.EPS;
import static com.example.cutdemotwo.algorithm.toolpath.ToolpathCommonEdgeDeduplicator.round1;

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
        return ToolpathCommonEdgeDeduplicator.deduplicateCommonEdges(cuts, toleranceMm);
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
        return ContourToolpathPlanner.optimizeContourToolpath(placements, options);
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
}
