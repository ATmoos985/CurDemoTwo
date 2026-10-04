package com.example.cutdemotwo.service.solver;

import com.example.cutdemotwo.model.nesting.NestingProblem;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Engine-independent checks before a candidate may be exposed or saved as a plan. */
final class RectangularResultValidator {
    private static final double EPS = .001;
    static String validate(NestingProblem input, EngineResult output) {
        Map<Integer, NestingProblem.Part> demands = new HashMap<>();
        input.parts().forEach(p -> demands.put(p.id(), p));
        Map<Integer, Integer> counts = new HashMap<>();
        Set<Integer> ids = new HashSet<>();
        List<double[]> occupied = new ArrayList<>();
        for (var p : output.getPieces()) {
            var demand = demands.get(p.getDemandId());
            if (demand == null || !ids.add(p.getId())) return "求解结果的裁片标识或需求归属无效";
            if (counts.merge(demand.id(), 1, Integer::sum) > demand.quantity()) return "求解结果超过需求数量";
            double w = p.isRotated() ? demand.shape().height() : demand.shape().width();
            double h = p.isRotated() ? demand.shape().width() : demand.shape().height();
            if ((p.isRotated() && !demand.allowRotation()) || Math.abs(p.getW() - w) > EPS || Math.abs(p.getL() - h) > EPS)
                return "求解结果改变了裁片尺寸或违反旋转约束";
            double[] rect = {p.getX(), p.getY(), p.getW(), p.getL()};
            if (!inside(rect, input) || occupied.stream().anyMatch(r -> overlap(r, rect))) return "求解结果裁片越界或重叠";
            for (var d : input.material().exclusions()) {
                double[] excluded = {d.x() - d.clearance(), d.y() - d.clearance(),
                        d.shape().width() + d.clearance() * 2, d.shape().height() + d.clearance() * 2};
                if (overlap(rect, excluded)) return "求解结果进入禁入区域";
            }
            occupied.add(rect);
        }
        Set<String> leftovers = new HashSet<>();
        for (var r : output.getRemnants()) {
            double[] rect = {r.getX(), r.getY(), r.getW(), r.getL()};
            if (r.getId() == null || r.getId().isBlank() || !leftovers.add(r.getId()) || !inside(rect, input) || occupied.stream().anyMatch(p -> overlap(p, rect)))
                return "求解结果余料越界、重叠或标识重复";
            occupied.add(rect);
        }
        if (!Double.isFinite(output.getSuggestedFeedLength()) || output.getSuggestedFeedLength() < 0
                || output.getSuggestedFeedLength() > input.height() + EPS) return "求解结果的进给长度无效";
        for (var c : output.getCuts()) {
            boolean horizontal = "横切".equals(c.getType());
            if (!horizontal && !"纵切".equals(c.getType())) return "求解结果包含未知刀路类型";
            double x1 = c.getStartX() == null ? (horizontal ? c.getStart() : c.getPos()) : c.getStartX();
            double y1 = c.getStartY() == null ? (horizontal ? c.getPos() : c.getStart()) : c.getStartY();
            double x2 = c.getEndX() == null ? (horizontal ? c.getEnd() : c.getPos()) : c.getEndX();
            double y2 = c.getEndY() == null ? (horizontal ? c.getPos() : c.getEnd()) : c.getEndY();
            if (!pointInside(x1, y1, input) || !pointInside(x2, y2, input)
                    || (horizontal ? Math.abs(y1-y2) > EPS : Math.abs(x1-x2) > EPS)) return "求解结果刀路越界或方向无效";
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
}
