package com.example.cutdemotwo.business.exports;

import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.business.cutting.DefectWindowSupport;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult;

import java.util.ArrayList;
import java.util.List;

/**
 * 方案 CAM 几何上下文适配器：
 * 从 {@link SchedulingScheme} 与可选 {@link MotherRollInfo} 中提取工位局部坐标下的
 * 裁片外轮廓、内孔轮廓、余料、窗口避疵框与直刀切割步，供 DXF/HPGL/G-Code 渲染器统一复用。
 */
final class CamSchemeGeometryAdapter {
    private CamSchemeGeometryAdapter() {}

    record PieceGeometry(
            int id,
            int demandId,
            String name,
            double x,
            double y,
            double w,
            double l,
            int rotationDegrees,
            Shape effectiveShape,
            List<Point> outerWorld,
            List<List<Point>> holeWorlds
    ) {}

    record CamContext(
            SchedulingScheme scheme,
            double widthMm,
            double bedLengthMm,
            double windowStartY,
            double homeX,
            double homeY,
            List<PieceGeometry> pieces,
            List<SchedulingScheme.LeftoverItem> leftovers,
            List<Defect> windowDefects,
            List<CutStep> cutSteps,
            List<NestingResult.Placement> placements
    ) {}

    static CamContext extract(SchedulingScheme scheme, MotherRollInfo roll) {
        if (scheme == null) {
            throw new ExportNotFoundException("排程方案不存在");
        }
        if ("SLITTING_1D".equalsIgnoreCase(scheme.dimension()) || scheme.layout2D() == null) {
            throw new IllegalArgumentException("仅 2D 排程方案支持导出 DXF / PLT / NC 裁切程序，1D 方案请使用 /slitting 接口");
        }
        double width = scheme.widthMm() > 0 ? scheme.widthMm() : 2000.0;
        double bedLen = scheme.canvasLengthMm() > 0 ? scheme.canvasLengthMm()
                : (scheme.occupiedLengthMm() > 0 ? scheme.occupiedLengthMm() : 5000.0);
        double winStartY = Math.max(0.0, scheme.windowStartY());
        // 默认以工位左下角 (0, 0) 作为局部机台原点，与 NC/PLT/DXF 工位局部坐标保持一致
        double homeX = 0.0;
        double homeY = 0.0;

        SchedulingScheme.Layout2DPayload layout = scheme.layout2D();
        List<PieceGeometry> pieces = new ArrayList<>(layout.placements().size());
        List<NestingResult.Placement> placements = new ArrayList<>(layout.placements().size());
        for (SchedulingScheme.PlacementItem item : layout.placements()) {
            Shape shape = effectiveShape(item);
            List<Point> outerWorld = translateRing(PolygonGeometry.vertices(shape), item.x(), item.y());
            List<List<Point>> holeWorlds = new ArrayList<>(shape.holes().size());
            for (List<Point> hole : shape.holes()) {
                List<Point> translated = translateRing(hole, item.x(), item.y());
                if (translated.size() >= 3) {
                    holeWorlds.add(translated);
                }
            }
            String label = (item.name() == null || item.name().isBlank()) ? ("Piece#" + item.id()) : item.name().trim();
            pieces.add(new PieceGeometry(
                    item.id(), item.demandId(), label,
                    item.x(), item.y(), shape.width(), shape.height(),
                    item.rotationDegrees(), shape, outerWorld, List.copyOf(holeWorlds)
            ));
            placements.add(new NestingResult.Placement(
                    item.id(), item.demandId(), label, item.x(), item.y(), shape, item.rotationDegrees()
            ));
        }

        List<Defect> windowDefects = roll == null
                ? List.of()
                : DefectWindowSupport.sliceForWindow(roll.getDefects(), winStartY, bedLen, width);

        List<CutStep> cutSteps = new ArrayList<>(layout.cuts().size());
        for (SchedulingScheme.CutLineItem c : layout.cuts()) {
            CutStep step = new CutStep();
            step.setStep(c.sequence());
            step.setStartX(c.startX());
            step.setStartY(c.startY());
            step.setEndX(c.endX());
            step.setEndY(c.endY());
            if ("横切".equals(c.kind()) && Math.abs(c.startY() - c.endY()) <= 1e-4) {
                step.setType("横切");
                step.setPos(c.startY());
                step.setStart(Math.min(c.startX(), c.endX()));
                step.setEnd(Math.max(c.startX(), c.endX()));
            } else if ("纵切".equals(c.kind()) && Math.abs(c.startX() - c.endX()) <= 1e-4) {
                step.setType("纵切");
                step.setPos(c.startX());
                step.setStart(Math.min(c.startY(), c.endY()));
                step.setEnd(Math.max(c.startY(), c.endY()));
            } else {
                step.setType("轮廓切");
            }
            step.setDesc("STEP #" + c.sequence());
            cutSteps.add(step);
        }

        return new CamContext(
                scheme, width, bedLen, winStartY, homeX, homeY,
                List.copyOf(pieces), layout.leftovers(), windowDefects,
                List.copyOf(cutSteps), List.copyOf(placements)
        );
    }

    static Shape effectiveShape(SchedulingScheme.PlacementItem item) {
        if (item.shape() != null && item.shape().width() > 0 && item.shape().height() > 0) {
            return item.shape();
        }
        double w = item.w() > 0 ? item.w() : 100.0;
        double l = item.l() > 0 ? item.l() : 100.0;
        return Shape.rectangle(w, l);
    }

    static List<Point> translateRing(List<Point> ring, double ox, double oy) {
        if (ring == null || ring.isEmpty()) {
            return List.of();
        }
        List<Point> out = new ArrayList<>(ring.size());
        for (Point p : ring) {
            if (p != null && Double.isFinite(p.x()) && Double.isFinite(p.y())) {
                out.add(new Point(ox + p.x(), oy + p.y()));
            }
        }
        return out;
    }

    static List<Point> ensureOrientation(List<Point> ring, boolean counterClockwise) {
        if (ring == null || ring.size() < 3) {
            return ring == null ? List.of() : ring;
        }
        double area = PolygonGeometry.signedArea(ring);
        boolean isCcw = area > 0;
        if (isCcw == counterClockwise) {
            return ring;
        }
        List<Point> reversed = new ArrayList<>(ring.size());
        for (int i = ring.size() - 1; i >= 0; i--) {
            reversed.add(ring.get(i));
        }
        return reversed;
    }

    static String sanitizeDxfText(String raw) {
        if (raw == null) return "";
        return raw.replace('\r', ' ').replace('\n', ' ').trim();
    }
}
