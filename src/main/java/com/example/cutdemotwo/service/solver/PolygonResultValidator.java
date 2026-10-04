package com.example.cutdemotwo.service.solver;

import com.example.cutdemotwo.model.nesting.NestingProblem;
import java.awt.geom.Area;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Set;

final class PolygonResultValidator {
    // Boolean area tolerance only; it is not a user-configurable cutting allowance.
    private static final double AREA_EPS = .001;
    static String validate(NestingProblem input, EngineResult output) {
        if (!output.getPieces().isEmpty() || !output.getRemnants().isEmpty() || !output.getCuts().isEmpty())
            return "轮廓排料不能混入矩形料头或直刀刀序";
        var material = PolygonGeometry.region(input.material().shape(), 0, 0);
        var occupied = new ArrayList<Area>();
        var counts = new HashMap<Integer, Integer>(); var ids = new HashSet<Integer>();
        for (var p : output.getPlacements()) {
            var demand = input.parts().stream().filter(d -> d.id() == p.demandId()).findFirst().orElse(null);
            if (demand == null || !ids.add(p.id()) || counts.merge(demand.id(), 1, Integer::sum) > demand.quantity()) return "异形结果的需求归属、标识或数量无效";
            if (!Set.of(0, 90, 180, 270).contains(p.rotationDegrees()) || (!demand.allowRotation() && p.rotationDegrees() != 0)) return "异形结果违反旋转约束";
            if (!Double.isFinite(p.x()) || !Double.isFinite(p.y())) return "异形结果坐标无效";
            try { PolygonGeometry.validate(p.shape()); } catch (RuntimeException e) { return "异形结果轮廓无效"; }
            var expected = PolygonGeometry.region(PolygonGeometry.rotate(demand.shape(), p.rotationDegrees()), 0, 0);
            expected.exclusiveOr(PolygonGeometry.region(p.shape(), 0, 0));
            if (PolygonGeometry.area(expected) > AREA_EPS) return "异形结果改变了零件轮廓";
            var placed = PolygonGeometry.region(p.shape(), p.x(), p.y());
            var outside = new Area(placed); outside.subtract(material);
            if (PolygonGeometry.area(outside) > AREA_EPS) return "异形结果超出材料实际轮廓";
            for (Area prior : occupied) { var overlap = new Area(placed); overlap.intersect(prior); if (PolygonGeometry.area(overlap) > AREA_EPS) return "异形结果裁片重叠"; }
            for (var d : input.material().exclusions()) {
                var shape = d.clearance() == 0 ? d.shape() : NestingProblem.Shape.rectangle(d.shape().width() + d.clearance()*2, d.shape().height() + d.clearance()*2);
                var overlap = new Area(placed); overlap.intersect(PolygonGeometry.region(shape, d.x() - d.clearance(), d.y() - d.clearance()));
                if (PolygonGeometry.area(overlap) > AREA_EPS) return "异形结果进入禁入区域";
            }
            occupied.add(placed);
        }
        return null;
    }
}
