package com.example.cutdemotwo.algorithm.toolpath;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.contracts.geometry.CutStep;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * 共边切割去重算法、空程/切长重算及共享线段原语（无 Spring 注解，包级辅助类）。
 */
final class ToolpathCommonEdgeDeduplicator {
    static final double EPS = .000001;

    private ToolpathCommonEdgeDeduplicator() {}

    private record LineRecord(double x1, double y1, double x2, double y2, double ux, double uy) {}

    static List<CutStep> deduplicateCommonEdges(List<CutStep> cuts, double toleranceMm) {
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

    static double sumCutStepsLength(List<CutStep> steps) {
        double sum = 0.0;
        for (CutStep cs : steps) {
            CutSegment seg = new CutSegment(cs);
            sum += seg.length;
        }
        return sum;
    }

    static void recomputeStepAirDistances(List<CutStep> steps, double homeX, double homeY) {
        double curX = homeX, curY = homeY;
        for (CutStep cs : steps) {
            CutSegment seg = new CutSegment(cs);
            cs.setAirDistance(round1(Math.hypot(seg.p1x - curX, seg.p1y - curY)));
            curX = seg.p2x;
            curY = seg.p2y;
        }
    }

    static double round1(double value) {
        return Math.round(value * 10.0) / 10.0;
    }

    static double round2(double value) {
        return Math.round(value * 100.0) / 100.0;
    }

    static class CutSegment {
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
