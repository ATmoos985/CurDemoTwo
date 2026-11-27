package com.example.cutdemotwo.business.exports;

import com.example.cutdemotwo.business.exports.CamSchemeGeometryAdapter.CamContext;
import com.example.cutdemotwo.business.exports.CamSchemeGeometryAdapter.PieceGeometry;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;

import java.util.*;

/**
 * 生产级 DXF 导出渲染器：
 * <ul>
 *   <li>{@code dxf_r12}：AutoCAD R12 (AC1009)，7 图层 {@code LINE} + {@code TEXT}；</li>
 *   <li>{@code dxf_lwpolyline}：AutoCAD 2000+ (AC1015)，7 图层闭合 {@code LWPOLYLINE}（组码 {@code 70=1}，外环逆时针、内孔顺时针）；</li>
 *   <li>{@code dxf_aama}：AAMA/ASTM D6673 服装工业交换格式，{@code BLOCKS} 块定义 + {@code ENTITIES} {@code INSERT} 引用（Layer 1/7/8/11）。</li>
 * </ul>
 */
final class DxfExportRenderer {
    private record LayerDef(String name, int color) {}

    private static final List<LayerDef> STANDARD_7_LAYERS = List.of(
            new LayerDef("0_FABRIC_BORDER", 7),
            new LayerDef("1_PIECES", 3),
            new LayerDef("1_PIECES_HOLES", 2),
            new LayerDef("2_REMNANTS", 4),
            new LayerDef("3_DEFECTS", 1),
            new LayerDef("4_CUT_LINES", 6),
            new LayerDef("5_RAPID_TRAVERSE", 5)
    );

    private static final List<LayerDef> AAMA_LAYERS = List.of(
            new LayerDef("1", 3),
            new LayerDef("7", 5),
            new LayerDef("8", 7),
            new LayerDef("11", 2)
    );

    String renderR12(CamContext ctx) {
        StringBuilder sb = new StringBuilder(16384);
        writeHeaderAndLayers(sb, "AC1009", STANDARD_7_LAYERS);
        sb.append("0\nSECTION\n2\nENTITIES\n");

        addRectLines(sb, "0_FABRIC_BORDER", 0, 0, ctx.widthMm(), ctx.bedLengthMm());
        addText(sb, "0_FABRIC_BORDER", 20, 20, 40,
                String.format(Locale.ROOT, "BED STATION: %.1fx%.1fmm", ctx.widthMm(), ctx.bedLengthMm()));

        for (PieceGeometry p : ctx.pieces()) {
            addClosedLoopLines(sb, "1_PIECES", p.outerWorld());
            for (List<Point> hole : p.holeWorlds()) {
                addClosedLoopLines(sb, "1_PIECES_HOLES", hole);
            }
            addText(sb, "1_PIECES", p.x() + 15, p.y() + p.l() / 2.0 - 10, 28, p.name());
            addText(sb, "1_PIECES", p.x() + 15, p.y() + p.l() / 2.0 + 26, 22,
                    String.format(Locale.ROOT, "%.1fx%.1fmm", p.w(), p.l()));
        }
        writeRemnantsAndDefects(sb, ctx, false);
        writeCutAndRapidLines(sb, ctx);

        sb.append("0\nENDSEC\n0\nEOF\n");
        return sb.toString();
    }

    String renderLwPolyline(CamContext ctx) {
        StringBuilder sb = new StringBuilder(16384);
        writeHeaderAndLayers(sb, "AC1015", STANDARD_7_LAYERS);
        sb.append("0\nSECTION\n2\nENTITIES\n");

        addClosedLwPolyline(sb, "0_FABRIC_BORDER", rectPoints(0, 0, ctx.widthMm(), ctx.bedLengthMm()));
        addText(sb, "0_FABRIC_BORDER", 20, 20, 40,
                String.format(Locale.ROOT, "BED STATION: %.1fx%.1fmm", ctx.widthMm(), ctx.bedLengthMm()));

        for (PieceGeometry p : ctx.pieces()) {
            List<Point> ccwOuter = CamSchemeGeometryAdapter.ensureOrientation(p.outerWorld(), true);
            addClosedLwPolyline(sb, "1_PIECES", ccwOuter);
            for (List<Point> hole : p.holeWorlds()) {
                List<Point> cwHole = CamSchemeGeometryAdapter.ensureOrientation(hole, false);
                addClosedLwPolyline(sb, "1_PIECES_HOLES", cwHole);
            }
            addText(sb, "1_PIECES", p.x() + 15, p.y() + p.l() / 2.0 - 10, 28, p.name());
            addText(sb, "1_PIECES", p.x() + 15, p.y() + p.l() / 2.0 + 26, 22,
                    String.format(Locale.ROOT, "%.1fx%.1fmm", p.w(), p.l()));
        }
        writeRemnantsAndDefects(sb, ctx, true);
        writeCutAndRapidLines(sb, ctx);

        sb.append("0\nENDSEC\n0\nEOF\n");
        return sb.toString();
    }

    String renderAama(CamContext ctx) {
        StringBuilder sb = new StringBuilder(16384);
        writeHeaderAndLayers(sb, "AC1009", AAMA_LAYERS);

        // 按 (demandId, rotationDegrees, w, l) 去重生成 AAMA BLOCK 定义
        Map<String, PieceGeometry> blocks = new LinkedHashMap<>();
        Map<Integer, String> placementBlockName = new HashMap<>();
        for (PieceGeometry p : ctx.pieces()) {
            String key = p.demandId() + "_R" + p.rotationDegrees() + "_"
                    + Math.round(p.w() * 10) + "x" + Math.round(p.l() * 10);
            String blockName = "PIECE_" + sanitizeBlockName(key);
            blocks.putIfAbsent(blockName, p);
            placementBlockName.put(p.id(), blockName);
        }

        sb.append("0\nSECTION\n2\nBLOCKS\n");
        for (var entry : blocks.entrySet()) {
            String blockName = entry.getKey();
            PieceGeometry sample = entry.getValue();
            Shape localShape = sample.effectiveShape();
            List<Point> localOuter = CamSchemeGeometryAdapter.ensureOrientation(
                    com.example.cutdemotwo.algorithm.geometry.PolygonGeometry.vertices(localShape), true);

            sb.append("0\nBLOCK\n8\n1\n2\n").append(blockName)
                    .append("\n70\n0\n10\n0.0\n20\n0.0\n30\n0.0\n3\n").append(blockName).append("\n1\n\n");
            // Layer 1: 裁片外轮廓
            addAamaPolyline(sb, "1", localOuter);
            // Layer 11: 裁片内孔
            for (List<Point> localHole : localShape.holes()) {
                addAamaPolyline(sb, "11", CamSchemeGeometryAdapter.ensureOrientation(localHole, false));
            }
            // Layer 7: 纱向/经向参考线
            double gx1 = Math.max(5.0, sample.w() * 0.15);
            double gx2 = Math.min(sample.w() - 5.0, sample.w() * 0.85);
            double gy = sample.l() * 0.5;
            if (gx2 > gx1) {
                addLine(sb, "7", gx1, gy, gx2, gy);
            }
            // Layer 8: 裁片名称与尺寸标注
            addText(sb, "8", Math.max(5.0, sample.w() * 0.1), Math.max(5.0, sample.l() * 0.4), 22,
                    sample.name() + " (" + Math.round(sample.w()) + "x" + Math.round(sample.l()) + ")");
            sb.append("0\nENDBLK\n8\n1\n");
        }
        sb.append("0\nENDSEC\n");

        sb.append("0\nSECTION\n2\nENTITIES\n");
        // 门幅/工位边界框放置 Layer 1
        addRectLines(sb, "1", 0, 0, ctx.widthMm(), ctx.bedLengthMm());
        addText(sb, "8", 20, 20, 32,
                String.format(Locale.ROOT, "AAMA MARKER: %s %.1fx%.1fmm",
                        CamSchemeGeometryAdapter.sanitizeDxfText(ctx.scheme().id()), ctx.widthMm(), ctx.bedLengthMm()));
        for (PieceGeometry p : ctx.pieces()) {
            String blockName = placementBlockName.get(p.id());
            sb.append("0\nINSERT\n8\n1\n2\n").append(blockName)
                    .append("\n10\n").append(fmt(p.x()))
                    .append("\n20\n").append(fmt(p.y()))
                    .append("\n30\n0.0\n41\n1.0\n42\n1.0\n43\n1.0\n50\n0.0\n");
        }
        sb.append("0\nENDSEC\n0\nEOF\n");
        return sb.toString();
    }

    private void writeHeaderAndLayers(StringBuilder sb, String acadVersion, List<LayerDef> layers) {
        sb.append("0\nSECTION\n2\nHEADER\n")
                .append("9\n$ACADVER\n1\n").append(acadVersion).append('\n')
                .append("9\n$INSUNITS\n70\n4\n")
                .append("0\nENDSEC\n")
                .append("0\nSECTION\n2\nTABLES\n")
                .append("0\nTABLE\n2\nLAYER\n70\n").append(layers.size()).append('\n');
        for (LayerDef l : layers) {
            sb.append("0\nLAYER\n2\n").append(l.name())
                    .append("\n70\n0\n62\n").append(l.color())
                    .append("\n6\nCONTINUOUS\n");
        }
        sb.append("0\nENDTAB\n0\nENDSEC\n");
    }

    private void writeRemnantsAndDefects(StringBuilder sb, CamContext ctx, boolean lwPolyline) {
        for (SchedulingScheme.LeftoverItem r : ctx.leftovers()) {
            List<Point> rect = rectPoints(r.x(), r.y(), r.x() + r.w(), r.y() + r.l());
            if (lwPolyline) addClosedLwPolyline(sb, "2_REMNANTS", rect);
            else addClosedLoopLines(sb, "2_REMNANTS", rect);
            addText(sb, "2_REMNANTS", r.x() + 15, r.y() + 35, 24, "REMNANT: " + r.id());
        }
        for (Defect d : ctx.windowDefects()) {
            List<Point> rect = rectPoints(d.getX(), d.getY(), d.getX() + d.getW(), d.getY() + d.getH());
            if (lwPolyline) addClosedLwPolyline(sb, "3_DEFECTS", rect);
            else addClosedLoopLines(sb, "3_DEFECTS", rect);
            if (d.getMargin() > 0) {
                double mx1 = Math.max(0, d.getX() - d.getMargin());
                double my1 = Math.max(0, d.getY() - d.getMargin());
                double mx2 = Math.min(ctx.widthMm(), d.getX() + d.getW() + d.getMargin());
                double my2 = Math.min(ctx.bedLengthMm(), d.getY() + d.getH() + d.getMargin());
                List<Point> marginRect = rectPoints(mx1, my1, mx2, my2);
                if (lwPolyline) addClosedLwPolyline(sb, "3_DEFECTS", marginRect);
                else addClosedLoopLines(sb, "3_DEFECTS", marginRect);
            }
            addText(sb, "3_DEFECTS", d.getX(), Math.max(10, d.getY() - 10), 20, "DEFECT #" + d.getId());
        }
    }

    private void writeCutAndRapidLines(StringBuilder sb, CamContext ctx) {
        double lastX = ctx.homeX();
        double lastY = ctx.homeY();
        for (CutStep c : ctx.cutSteps()) {
            double sx = c.getStartX() != null ? c.getStartX() : 0.0;
            double sy = c.getStartY() != null ? c.getStartY() : 0.0;
            double ex = c.getEndX() != null ? c.getEndX() : 0.0;
            double ey = c.getEndY() != null ? c.getEndY() : 0.0;
            if (Math.hypot(sx - lastX, sy - lastY) > 1e-4) {
                addLine(sb, "5_RAPID_TRAVERSE", lastX, lastY, sx, sy);
            }
            addLine(sb, "4_CUT_LINES", sx, sy, ex, ey);
            addText(sb, "4_CUT_LINES", sx + 5, sy + 5, 18, "CUT #" + c.getStep());
            lastX = ex;
            lastY = ey;
        }
    }

    private static List<Point> rectPoints(double x1, double y1, double x2, double y2) {
        return List.of(new Point(x1, y1), new Point(x2, y1), new Point(x2, y2), new Point(x1, y2));
    }

    private static void addRectLines(StringBuilder sb, String layer, double x1, double y1, double x2, double y2) {
        addClosedLoopLines(sb, layer, rectPoints(x1, y1, x2, y2));
    }

    private static void addClosedLoopLines(StringBuilder sb, String layer, List<Point> pts) {
        if (pts == null || pts.size() < 2) return;
        for (int i = 0; i < pts.size(); i++) {
            Point a = pts.get(i);
            Point b = pts.get((i + 1) % pts.size());
            addLine(sb, layer, a.x(), a.y(), b.x(), b.y());
        }
    }

    private static void addClosedLwPolyline(StringBuilder sb, String layer, List<Point> pts) {
        if (pts == null || pts.size() < 3) return;
        sb.append("0\nLWPOLYLINE\n8\n").append(layer)
                .append("\n90\n").append(pts.size())
                .append("\n70\n1\n");
        for (Point p : pts) {
            sb.append("10\n").append(fmt(p.x())).append("\n20\n").append(fmt(p.y())).append('\n');
        }
    }

    private static void addAamaPolyline(StringBuilder sb, String layer, List<Point> pts) {
        if (pts == null || pts.size() < 3) return;
        sb.append("0\nPOLYLINE\n8\n").append(layer).append("\n66\n1\n70\n1\n");
        for (Point p : pts) {
            sb.append("0\nVERTEX\n8\n").append(layer)
                    .append("\n10\n").append(fmt(p.x()))
                    .append("\n20\n").append(fmt(p.y()))
                    .append("\n30\n0.0\n");
        }
        sb.append("0\nSEQEND\n8\n").append(layer).append('\n');
    }

    private static void addLine(StringBuilder sb, String layer, double x1, double y1, double x2, double y2) {
        sb.append("0\nLINE\n8\n").append(layer)
                .append("\n10\n").append(fmt(x1)).append("\n20\n").append(fmt(y1)).append("\n30\n0.0")
                .append("\n11\n").append(fmt(x2)).append("\n21\n").append(fmt(y2)).append("\n31\n0.0\n");
    }

    private static void addText(StringBuilder sb, String layer, double x, double y, double height, String text) {
        sb.append("0\nTEXT\n8\n").append(layer)
                .append("\n10\n").append(fmt(x)).append("\n20\n").append(fmt(y)).append("\n30\n0.0")
                .append("\n40\n").append(String.format(Locale.ROOT, "%.1f", height))
                .append("\n1\n").append(CamSchemeGeometryAdapter.sanitizeDxfText(text)).append('\n');
    }

    private static String fmt(double val) {
        return String.format(Locale.ROOT, "%.3f", val);
    }

    private static String sanitizeBlockName(String raw) {
        String clean = raw == null ? "BLK" : raw.replaceAll("[^A-Za-z0-9_]", "_");
        return clean.length() > 48 ? clean.substring(0, 48) : clean;
    }
}
