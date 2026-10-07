package com.example.cutdemotwo.service.toolpath;

import com.example.cutdemotwo.model.CutStep;
import com.example.cutdemotwo.model.ToolpathResult;
import org.springframework.stereotype.Service;

import java.util.*;

/**
 * 工业级 CAD/CAM 刀路优化引擎 (Toolpath Optimization Service)
 * 目标：从指定停刀位出发，通过最近邻、方向翻转与相邻交换减少空走距离，
 * 最小化空刀快移 (Rapid Traverse / Air Cut) 距离，提升下刀效率。
 */
@Service
public class ToolpathOptimizerService {

    private static final double EPS = .000001;

    public List<CutStep> optimizeAndChain(List<CutStep> rawCuts, double homeX, double homeY, boolean respectPrecedence) {
        ToolpathResult res = optimizeToolpath(rawCuts, homeX, homeY, respectPrecedence);
        return res.getOptimizedCuts() != null ? res.getOptimizedCuts() : Collections.emptyList();
    }

    public ToolpathResult optimizeToolpath(List<CutStep> rawCuts, double homeX, double homeY, boolean respectPrecedence) {
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
            totalCutLen += seg.length;
        }
        result.setCutDistance(Math.round(totalCutLen * 10.0) / 10.0);

        double originalAir = calculateTourAirDistance(segments, homeX, homeY);
        result.setOriginalAirDistance(Math.round(originalAir * 10.0) / 10.0);

        // 2. 启发式双向最近邻求解 (Directional Nearest Neighbor)
        List<CutSegment> optimized;
        if (respectPrecedence) {
            optimized = solveStageConstrainedTSP(segments, homeX, homeY);
        } else {
            optimized = solveUnconstrainedSegmentTSP(segments, homeX, homeY);
        }

        // 3. 同阶段相邻交换与端点翻转。
        optimized = run2OptRefinement(optimized, homeX, homeY, respectPrecedence);

        // 4. 构建优化后的切刀序列与台账统计
        double optimizedAir = calculateTourAirDistance(optimized, homeX, homeY);
        if (ordered(original) && originalAir <= optimizedAir + EPS) {
            optimized = original;
            optimizedAir = originalAir;
        }
        result.setOptimizedAirDistance(Math.round(optimizedAir * 10.0) / 10.0);
        double saved = Math.max(0, originalAir - optimizedAir);
        result.setSavedAirDistance(Math.round(saved * 10.0) / 10.0);
        result.setSavingRatio(originalAir > 0 ? Math.round((saved / originalAir) * 1000.0) / 10.0 : 0.0);
        result.setTotalDistance(Math.round((totalCutLen + optimizedAir) * 10.0) / 10.0);

        result.setOptimizedCuts(chain(optimized, homeX, homeY));
        return result;
    }

    private List<CutStep> chain(List<CutSegment> optimized, double homeX, double homeY) {
        List<CutStep> finalCuts = new ArrayList<>();
        double curX = homeX;
        double curY = homeY;
        for (int i = 0; i < optimized.size(); i++) {
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
            cs.setStartX(Math.round(seg.startX * 10.0) / 10.0);
            cs.setStartY(Math.round(seg.startY * 10.0) / 10.0);
            cs.setEndX(Math.round(seg.endX * 10.0) / 10.0);
            cs.setEndY(Math.round(seg.endY * 10.0) / 10.0);
            cs.setAirDistance(Math.round(airDist * 10.0) / 10.0);
            cs.setStage(seg.original.getStage());
            finalCuts.add(cs);

            curX = seg.endX;
            curY = seg.endY;
        }

        return finalCuts;
    }

    /** Only reorder/reverse saved segments; never trust client stage, geometry or distance metadata. */
    public List<CutStep> validateReorderedCuts(List<CutStep> saved, List<CutStep> proposed,
                                              double homeX, double homeY, boolean respectPrecedence) {
        if (saved == null || proposed == null || proposed.size() != saved.size())
            throw new IllegalArgumentException("刀路调整不能增加或删除切割线");
        Map<String, Deque<CutSegment>> available = new HashMap<>();
        for (CutSegment s : segments(saved, respectPrecedence))
            available.computeIfAbsent(s.key(), k -> new ArrayDeque<>()).add(s);
        List<CutSegment> tour = new ArrayList<>();
        for (CutStep cut : proposed) {
            CutSegment candidate = new CutSegment(cut);
            Deque<CutSegment> matches = available.get(candidate.key());
            if (matches == null || matches.isEmpty()) throw new IllegalArgumentException("刀路调整改变了原切割线");
            CutSegment source = matches.removeFirst();
            boolean forward = Math.hypot(candidate.p1x-source.p1x, candidate.p1y-source.p1y) < EPS
                    && Math.hypot(candidate.p2x-source.p2x, candidate.p2y-source.p2y) < EPS;
            boolean reverse = Math.hypot(candidate.p1x-source.p2x, candidate.p1y-source.p2y) < EPS
                    && Math.hypot(candidate.p2x-source.p1x, candidate.p2y-source.p1y) < EPS;
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
        for (int i = 1; i < cuts.size(); i++) if (cuts.get(i-1).stage > cuts.get(i).stage) return false;
        return true;
    }

    private List<CutSegment> solveStageConstrainedTSP(List<CutSegment> segments, double homeX, double homeY) {
        // 按阶段分组 (保持断刀阶段依赖，在阶段内部进行最近邻与双向接刀)
        Map<Integer, List<CutSegment>> stageMap = new TreeMap<>();
        for (CutSegment seg : segments) {
            stageMap.computeIfAbsent(seg.stage, k -> new ArrayList<>()).add(seg);
        }

        List<CutSegment> tour = new ArrayList<>();
        double curX = homeX;
        double curY = homeY;

        for (Map.Entry<Integer, List<CutSegment>> entry : stageMap.entrySet()) {
            List<CutSegment> pool = new ArrayList<>(entry.getValue());
            while (!pool.isEmpty()) {
                int bestIdx = -1;
                boolean bestReverse = false;
                double bestDist = Double.MAX_VALUE;

                for (int i = 0; i < pool.size(); i++) {
                    CutSegment s = pool.get(i);
                    // 试正向 (p1 -> p2)
                    double d1 = Math.hypot(s.p1x - curX, s.p1y - curY);
                    if (d1 < bestDist) {
                        bestDist = d1;
                        bestIdx = i;
                        bestReverse = false;
                    }
                    // 试逆向 (p2 -> p1)
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
            int bestIdx = -1;
            boolean bestReverse = false;
            double bestDist = Double.MAX_VALUE;

            for (int i = 0; i < pool.size(); i++) {
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

    private List<CutSegment> run2OptRefinement(List<CutSegment> tour, double homeX, double homeY, boolean respectPrecedence) {
        boolean improved = true;
        int maxPasses = 100;
        int pass = 0;

        while (improved && pass++ < maxPasses) {
            improved = false;

            // 1. 尝试翻转单个线段的下刀方向 (Flip orientation)
            for (int i = 0; i < tour.size(); i++) {
                double prevX = (i == 0) ? homeX : tour.get(i - 1).endX;
                double prevY = (i == 0) ? homeY : tour.get(i - 1).endY;
                double nextX = (i == tour.size() - 1) ? tour.get(i).endX : tour.get(i + 1).startX;
                double nextY = (i == tour.size() - 1) ? tour.get(i).endY : tour.get(i + 1).startY;

                CutSegment s = tour.get(i);
                double curAir = Math.hypot(s.startX - prevX, s.startY - prevY) +
                        (i < tour.size() - 1 ? Math.hypot(nextX - s.endX, nextY - s.endY) : 0);

                // 翻转后的空程
                double flippedAir = Math.hypot(s.endX - prevX, s.endY - prevY) +
                        (i < tour.size() - 1 ? Math.hypot(nextX - s.startX, nextY - s.startY) : 0);

                if (flippedAir + 1e-4 < curAir) {
                    s.setDirection(!s.isReversed);
                    improved = true;
                }
            }

            // 2. 尝试相邻段交换 (Adjacent Swap)
            for (int i = 0; i < tour.size() - 1; i++) {
                CutSegment s1 = tour.get(i);
                CutSegment s2 = tour.get(i + 1);

                if (respectPrecedence && s1.stage != s2.stage) {
                    continue; // 阶段不一致禁止跨阶段倒置
                }

                double prevX = (i == 0) ? homeX : tour.get(i - 1).endX;
                double prevY = (i == 0) ? homeY : tour.get(i - 1).endY;
                double nextX = (i + 1 == tour.size() - 1) ? s2.endX : tour.get(i + 2).startX;
                double nextY = (i + 1 == tour.size() - 1) ? s2.endY : tour.get(i + 2).startY;

                double curDist = Math.hypot(s1.startX - prevX, s1.startY - prevY) +
                        Math.hypot(s2.startX - s1.endX, s2.startY - s1.endY) +
                        (i + 2 < tour.size() ? Math.hypot(nextX - s2.endX, nextY - s2.endY) : 0);

                // 尝试交换为 s2 -> s1
                double swappedDist = Math.hypot(s2.startX - prevX, s2.startY - prevY) +
                        Math.hypot(s1.startX - s2.endX, s1.startY - s2.endY) +
                        (i + 2 < tour.size() ? Math.hypot(nextX - s1.endX, nextY - s1.endY) : 0);

                if (swappedDist + 1e-4 < curDist) {
                    tour.set(i, s2);
                    tour.set(i + 1, s1);
                    improved = true;
                }
            }
        }
        return tour;
    }

    private double calculateTourAirDistance(List<CutSegment> tour, double homeX, double homeY) {
        double air = 0.0;
        double curX = homeX;
        double curY = homeY;
        for (CutSegment s : tour) {
            air += Math.hypot(s.startX - curX, s.startY - curY);
            curX = s.endX;
            curY = s.endY;
        }
        return air;
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
            if (cs == null || !("横切".equals(cs.getType()) || "纵切".equals(cs.getType())))
                throw new IllegalArgumentException("刀路包含无效切割类型");
            if (cs.getStage() != null && cs.getStage() <= 0) throw new IllegalArgumentException("切割阶段必须为正数");
            this.original = cs;
            int coordinates = (cs.getStartX() == null ? 0 : 1) + (cs.getStartY() == null ? 0 : 1)
                    + (cs.getEndX() == null ? 0 : 1) + (cs.getEndY() == null ? 0 : 1);
            if (coordinates != 0 && coordinates != 4) throw new IllegalArgumentException("刀路端点坐标不完整");
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
            if (Math.abs((horizontal ? p1y : p1x)-cs.getPos()) > EPS
                    || Math.abs((horizontal ? p2y : p2x)-cs.getPos()) > EPS
                    || Math.abs(Math.min(horizontal ? p1x : p1y, horizontal ? p2x : p2y)-Math.min(cs.getStart(),cs.getEnd())) > EPS
                    || Math.abs(Math.max(horizontal ? p1x : p1y, horizontal ? p2x : p2y)-Math.max(cs.getStart(),cs.getEnd())) > EPS)
                throw new IllegalArgumentException("刀路端点与切割线不一致");
            this.length = Math.hypot(p2x - p1x, p2y - p1y);
            this.startX = p1x;
            this.startY = p1y;
            this.endX = p2x;
            this.endY = p2y;

        }

        String key() {
            return original.getType() + ":" + Math.round(original.getPos()*10) + ":"
                    + Math.round(Math.min(original.getStart(),original.getEnd())*10) + ":"
                    + Math.round(Math.max(original.getStart(),original.getEnd())*10);
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
