package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.geometry.EngineGeometry;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.nesting.constraints.ConstraintPipeline;
import com.example.cutdemotwo.algorithm.nesting.constraints.CurtainConstraintPack;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import java.awt.geom.Area;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;

public final class PolygonResultValidator {
    // Boolean area tolerance only; it is not a user-configurable cutting allowance.
    private static final double AREA_EPS = EngineGeometry.AREA_EPS_MM2;
    private static final double COORD_EPS = EngineGeometry.COORDINATE_EPS_MM;

    private record ExpectedKey(int demandId, int rotationDegrees) {}
    private record CheckedPiece(Placement placement, Area worldArea, List<Point> localVerts,
                                double minX, double maxX, double minY, double maxY) {}

    public static String validate(NestingProblem input, EngineResult output) {
        ComputationCancellation.check();
        if (!output.getPieces().isEmpty() || !output.getRemnants().isEmpty() || !output.getCuts().isEmpty())
            return "轮廓排料不能混入矩形料头或直刀刀序";
        var materialShape = input.material().shape();
        boolean isRectMaterial = "RECTANGLE".equals(materialShape.type());
        double matW = materialShape.width();
        double matH = materialShape.height();
        Area material = null;

        ConstraintPipeline pipeline = CurtainConstraintPack.forProblem(input);
        var expandedExclusions = new ArrayList<ContourGeometrySupport.ExpandedExclusion>(
                input.material().exclusions().size());
        var expandedById = new HashMap<Integer, ContourGeometrySupport.ExpandedExclusion>(
                input.material().exclusions().size() * 2);
        for (var d : input.material().exclusions()) {
            ComputationCancellation.check();
            var exp = ContourGeometrySupport.expandExclusion(d);
            expandedExclusions.add(exp);
            expandedById.put(d.id(), exp);
        }

        var demandsById = new HashMap<Integer, NestingProblem.Part>();
        for (var part : input.parts()) {
            demandsById.put(part.id(), part);
        }
        var expectedShapeAreas = new HashMap<ExpectedKey, Area>();
        var occupied = new ArrayList<CheckedPiece>(output.getPlacements().size());
        var counts = new HashMap<Integer, Integer>();
        var ids = new HashSet<Integer>();

        for (var p : output.getPlacements()) {
            ComputationCancellation.check();
            var demand = demandsById.get(p.demandId());
            if (demand == null || !ids.add(p.id()) || counts.merge(demand.id(), 1, Integer::sum) > demand.quantity())
                return "异形结果的需求归属、标识或数量无效";
            if (!demand.contourAngles().contains(p.rotationDegrees())) return "异形结果违反旋转约束";
            if (!Double.isFinite(p.x()) || !Double.isFinite(p.y())) return "异形结果坐标无效";
            try { PolygonGeometry.validate(p.shape()); } catch (RuntimeException e) { return "异形结果轮廓无效"; }

            var expKey = new ExpectedKey(demand.id(), p.rotationDegrees());
            var expectedBase = expectedShapeAreas.computeIfAbsent(expKey,
                    k -> PolygonGeometry.region(PolygonGeometry.rotate(demand.shape(), k.rotationDegrees()), 0, 0));
            var expected = new Area(expectedBase);
            expected.exclusiveOr(PolygonGeometry.region(p.shape(), 0, 0));
            if (PolygonGeometry.area(expected) > AREA_EPS) return "异形结果改变了零件轮廓";

            double minX = p.x();
            double minY = p.y();
            double maxX = minX + p.shape().width();
            double maxY = minY + p.shape().height();
            var placed = PolygonGeometry.region(p.shape(), minX, minY);

            if (!isRectMaterial || minX < -1e-9 || minY < -1e-9 || maxX > matW + 1e-9 || maxY > matH + 1e-9) {
                if (material == null) {
                    material = PolygonGeometry.region(materialShape, 0, 0);
                }
                if (!ContourGeometrySupport.isWithinMaterial(placed, material, AREA_EPS)) {
                    return "异形结果超出材料实际轮廓";
                }
            }

            for (var prior : occupied) {
                if (ContourGeometrySupport.aabbOverlaps(minX, maxX, minY, maxY,
                        prior.minX, prior.maxX, prior.minY, prior.maxY, COORD_EPS)
                        && ContourGeometrySupport.overlapsArea(placed, prior.worldArea, AREA_EPS)) {
                    return "异形结果裁片重叠";
                }
            }
            if (pipeline.isNoop()) {
                for (var expanded : expandedExclusions) {
                    ComputationCancellation.check();
                    if (ContourGeometrySupport.aabbOverlaps(minX, maxX, minY, maxY,
                            expanded.minX(), expanded.maxX(), expanded.minY(), expanded.maxY(), COORD_EPS)
                            && ContourGeometrySupport.overlapsArea(placed, expanded.worldArea(), AREA_EPS)) {
                        return "异形结果进入禁入区域";
                    }
                }
            } else {
                for (var hardExc : pipeline.hardExclusionsFor(input, demand)) {
                    ComputationCancellation.check();
                    var expanded = expandedById.get(hardExc.id());
                    if (expanded != null && ContourGeometrySupport.aabbOverlaps(minX, maxX, minY, maxY,
                            expanded.minX(), expanded.maxX(), expanded.minY(), expanded.maxY(), COORD_EPS)
                            && ContourGeometrySupport.overlapsArea(placed, expanded.worldArea(), AREA_EPS)) {
                        return "异形结果进入禁入区域";
                    }
                }
            }
            occupied.add(new CheckedPiece(p, placed, PolygonGeometry.vertices(p.shape()), minX, maxX, minY, maxY));
        }

        double pieceGap = input.process().pieceGap();
        if (pieceGap > 0) {
            double gapMargin = pieceGap + COORD_EPS;
            for (int i = 0; i < occupied.size(); i++) {
                var a = occupied.get(i);
                for (int j = i + 1; j < occupied.size(); j++) {
                    ComputationCancellation.check();
                    var b = occupied.get(j);
                    if (!ContourGeometrySupport.aabbOverlaps(a.minX, a.maxX, a.minY, a.maxY,
                            b.minX, b.maxX, b.minY, b.maxY, gapMargin)) {
                        continue;
                    }
                    if (ContourGeometrySupport.violatesMinEdgeGap(
                            a.localVerts, a.placement.x(), a.placement.y(),
                            b.localVerts, b.placement.x(), b.placement.y(),
                            pieceGap, COORD_EPS)) {
                        return "轮廓裁片间距不足";
                    }
                }
            }
        }
        if (!pipeline.isNoop()) {
            String constraintError = pipeline.validateResult(input, output.getPlacements(), List.of());
            if (constraintError != null) return constraintError;
        }
        return null;
    }
}
