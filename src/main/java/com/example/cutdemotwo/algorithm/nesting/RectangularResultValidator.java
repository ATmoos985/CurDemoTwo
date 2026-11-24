package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.geometry.EngineGeometry;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.nesting.constraints.ConstraintPipeline;
import com.example.cutdemotwo.algorithm.nesting.constraints.CurtainConstraintPack;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Engine-independent checks before a candidate may be exposed or saved as a plan. */
final class RectangularResultValidator {
    private static final double EPS = EngineGeometry.COORDINATE_EPS_MM;
    static String validate(NestingProblem input, EngineResult output) {
        ComputationCancellation.check();
        ConstraintPipeline pipeline = CurtainConstraintPack.forProblem(input);
        Map<Integer, NestingProblem.Part> demands = new HashMap<>();
        input.parts().forEach(p -> demands.put(p.id(), p));
        Map<Integer, Integer> counts = new HashMap<>();
        Set<Integer> ids = new HashSet<>();
        List<double[]> pieceRects = new ArrayList<>();
        List<double[]> occupied = new ArrayList<>();
        double minSeparation = Math.max(Math.max(0.0, input.process().pieceGap()), Math.max(0.0, input.process().kerf()));
        for (var p : output.getPieces()) {
            ComputationCancellation.check();
            var demand = demands.get(p.getDemandId());
            if (demand == null || !ids.add(p.getId())) return "求解结果的裁片标识或需求归属无效";
            if (counts.merge(demand.id(), 1, Integer::sum) > demand.quantity()) return "求解结果超过需求数量";
            double w = p.isRotated() ? demand.shape().height() : demand.shape().width();
            double h = p.isRotated() ? demand.shape().width() : demand.shape().height();
            if ((p.isRotated() && !demand.allowRotation()) || Math.abs(p.getW() - w) > EPS || Math.abs(p.getL() - h) > EPS)
                return "求解结果改变了裁片尺寸或违反旋转约束";
            double[] rect = {p.getX(), p.getY(), p.getW(), p.getL()};
            if (!inside(rect, input) || occupied.stream().anyMatch(r -> overlap(r, rect))) return "求解结果裁片越界或重叠";
            if (minSeparation > EPS && pieceRects.stream().anyMatch(r -> violatesSpacing(r, rect, minSeparation))) {
                return "求解结果未满足裁片间距或刀缝约束";
            }
            var hardExclusions = pipeline.isNoop() ? input.material().exclusions() : pipeline.hardExclusionsFor(input, demand);
            for (var d : hardExclusions) {
                ComputationCancellation.check();
                double[] excluded = {d.x() - d.clearance(), d.y() - d.clearance(),
                        d.shape().width() + d.clearance() * 2, d.shape().height() + d.clearance() * 2};
                if (overlap(rect, excluded)) return "求解结果进入禁入区域";
            }
            pieceRects.add(rect);
            occupied.add(rect);
        }
        Set<String> leftovers = new HashSet<>();
        for (var r : output.getRemnants()) {
            ComputationCancellation.check();
            double[] rect = {r.getX(), r.getY(), r.getW(), r.getL()};
            if (r.getId() == null || r.getId().isBlank() || !leftovers.add(r.getId()) || !inside(rect, input) || occupied.stream().anyMatch(p -> overlap(p, rect)))
                return "求解结果余料越界、重叠或标识重复";
            occupied.add(rect);
        }
        if (!Double.isFinite(output.getSuggestedFeedLength()) || output.getSuggestedFeedLength() < 0
                || output.getSuggestedFeedLength() > input.height() + EPS) return "求解结果的进给长度无效";
        double halfKerf = Math.max(0.0, input.process().kerf()) * 0.5;
        Integer maxStages = input.process().maxStages();
        int allowedMaxStage = maxStages == null ? Integer.MAX_VALUE
                : (maxStages + (input.process().trimStart() > EPS ? 1 : 0));
        for (var c : output.getCuts()) {
            ComputationCancellation.check();
            boolean horizontal = "横切".equals(c.getType());
            if (!horizontal && !"纵切".equals(c.getType())) return "求解结果包含未知刀路类型";
            double x1 = c.getStartX() == null ? (horizontal ? c.getStart() : c.getPos()) : c.getStartX();
            double y1 = c.getStartY() == null ? (horizontal ? c.getPos() : c.getStart()) : c.getStartY();
            double x2 = c.getEndX() == null ? (horizontal ? c.getEnd() : c.getPos()) : c.getEndX();
            double y2 = c.getEndY() == null ? (horizontal ? c.getPos() : c.getEnd()) : c.getEndY();
            if (!pointInside(x1, y1, input) || !pointInside(x2, y2, input)
                    || (horizontal ? Math.abs(y1-y2) > EPS : Math.abs(x1-x2) > EPS)) return "求解结果刀路越界或方向无效";
            if (c.getStage() != null && c.getStage() > allowedMaxStage) {
                return "求解结果超出直刀最大通切阶数限制";
            }
            if (penetratesAnyPiece(horizontal, x1, y1, x2, y2, halfKerf, pieceRects)) {
                return "求解结果直刀刀路劈穿裁片内部";
            }
        }
        if (!pipeline.isNoop()) {
            var placements = output.getPieces().stream().map(p -> new NestingResult.Placement(
                    p.getId(), p.getDemandId(), p.getName(), p.getX(), p.getY(),
                    NestingProblem.Shape.rectangle(p.getW(), p.getL()), p.isRotated() ? 90 : 0)).toList();
            var remnantList = output.getRemnants().stream().map(r -> new NestingResult.Leftover(
                    r.getId(), r.getX(), r.getY(),
                    NestingProblem.Shape.rectangle(r.getW(), r.getL()), r.isHasDefect())).toList();
            String constraintError = pipeline.validateResult(input, placements, remnantList);
            if (constraintError != null) return constraintError;
        }
        return null;
    }
    private static boolean pointInside(double x, double y, NestingProblem p) {
        return Double.isFinite(x) && Double.isFinite(y) && x >= -EPS && y >= -EPS && x <= p.width() + EPS && y <= p.height() + EPS;
    }
    private static boolean inside(double[] r, NestingProblem p) {
        for (double n : r) if (!Double.isFinite(n)) return false;
        return r[0] >= -EPS && r[1] >= -EPS && r[2] > 0 && r[3] > 0
                && r[0] + r[2] <= p.width() + EPS && r[1] + r[3] <= p.height() + EPS;
    }
    private static boolean overlap(double[] a, double[] b) {
        return a[0] + a[2] > b[0] + EPS && b[0] + b[2] > a[0] + EPS
                && a[1] + a[3] > b[1] + EPS && b[1] + b[3] > a[1] + EPS;
    }
    private static boolean violatesSpacing(double[] a, double[] b, double minSep) {
        return a[0] + a[2] + minSep > b[0] + EPS && b[0] + b[2] + minSep > a[0] + EPS
                && a[1] + a[3] + minSep > b[1] + EPS && b[1] + b[3] + minSep > a[1] + EPS;
    }
    private static boolean penetratesAnyPiece(boolean horizontal, double x1, double y1, double x2, double y2,
                                              double halfKerf, List<double[]> pieceRects) {
        if (horizontal) {
            double y = (y1 + y2) * 0.5;
            double minX = Math.min(x1, x2);
            double maxX = Math.max(x1, x2);
            for (double[] p : pieceRects) {
                boolean yInside = (y + halfKerf > p[1] + EPS) && (y - halfKerf < p[1] + p[3] - EPS);
                boolean xOverlap = (maxX > p[0] + EPS) && (minX < p[0] + p[2] - EPS);
                if (yInside && xOverlap) {
                    return true;
                }
            }
        } else {
            double x = (x1 + x2) * 0.5;
            double minY = Math.min(y1, y2);
            double maxY = Math.max(y1, y2);
            for (double[] p : pieceRects) {
                boolean xInside = (x + halfKerf > p[0] + EPS) && (x - halfKerf < p[0] + p[2] - EPS);
                boolean yOverlap = (maxY > p[1] + EPS) && (minY < p[1] + p[3] - EPS);
                if (xInside && yOverlap) {
                    return true;
                }
            }
        }
        return false;
    }
}
