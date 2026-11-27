package com.example.cutdemotwo.business.exports;

import com.example.cutdemotwo.business.exports.CamSchemeGeometryAdapter.CamContext;
import com.example.cutdemotwo.business.exports.CamSchemeGeometryAdapter.PieceGeometry;
import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;

import java.util.List;

/**
 * 工业 HPGL (.plt) 振动刀/绘图仪导出渲染器：
 * <ul>
 *   <li>标准 {@code IN;PA;} 绝对毫米换算：{@code 1 mm = 40 plotter units}；</li>
 *   <li>{@code SP1} 主裁切/直刀、{@code SP2} 小圆孔/冲孔定位、{@code SP3} 边界与避疵标注；</li>
 *   <li>严格以 {@code PU0,0;SP0;} 归零收尾。</li>
 * </ul>
 */
final class HpglExportRenderer {
    static final double UNITS_PER_MM = 40.0;
    private static final double SMALL_HOLE_THRESHOLD_MM = 30.0;

    String render(CamContext ctx) {
        StringBuilder sb = new StringBuilder(8192);
        sb.append("IN;PA;\n");

        // SP3: 工位边界框与窗口避疵安全框
        sb.append("SP3;\n");
        appendRect(sb, 0, 0, ctx.widthMm(), ctx.bedLengthMm());
        for (Defect d : ctx.windowDefects()) {
            appendRect(sb, d.getX(), d.getY(), d.getX() + d.getW(), d.getY() + d.getH());
        }

        if (!ctx.cutSteps().isEmpty()) {
            // 直刀方案：SP1 按序走刀
            sb.append("SP1;\n");
            for (CutStep c : ctx.cutSteps()) {
                double sx = c.getStartX() != null ? c.getStartX() : 0.0;
                double sy = c.getStartY() != null ? c.getStartY() : 0.0;
                double ex = c.getEndX() != null ? c.getEndX() : 0.0;
                double ey = c.getEndY() != null ? c.getEndY() : 0.0;
                sb.append("PU").append(u(sx)).append(',').append(u(sy)).append(';')
                        .append("PD").append(u(ex)).append(',').append(u(ey)).append(";\n");
            }
        } else {
            // 异形轮廓方案：先输出小孔冲孔 (SP2)，再输出大内孔与外轮廓 (SP1)
            boolean hasPunchOps = false;
            for (PieceGeometry p : ctx.pieces()) {
                for (List<Point> hole : p.holeWorlds()) {
                    if (isSmallPunchHole(hole)) {
                        if (!hasPunchOps) {
                            sb.append("SP2;\n");
                            hasPunchOps = true;
                        }
                        appendPunchCross(sb, hole);
                    }
                }
            }

            sb.append("SP1;\n");
            for (PieceGeometry p : ctx.pieces()) {
                for (List<Point> hole : p.holeWorlds()) {
                    if (!isSmallPunchHole(hole)) {
                        appendClosedLoop(sb, hole);
                    }
                }
                appendClosedLoop(sb, p.outerWorld());
            }
        }

        sb.append("PU0,0;SP0;\n");
        return sb.toString();
    }

    private static void appendRect(StringBuilder sb, double x1, double y1, double x2, double y2) {
        sb.append("PU").append(u(x1)).append(',').append(u(y1)).append(';')
                .append("PD").append(u(x2)).append(',').append(u(y1)).append(',')
                .append(u(x2)).append(',').append(u(y2)).append(',')
                .append(u(x1)).append(',').append(u(y2)).append(',')
                .append(u(x1)).append(',').append(u(y1)).append(";\n");
    }

    private static void appendClosedLoop(StringBuilder sb, List<Point> pts) {
        if (pts == null || pts.size() < 3) return;
        Point first = pts.get(0);
        sb.append("PU").append(u(first.x())).append(',').append(u(first.y())).append(";PD");
        for (int i = 1; i < pts.size(); i++) {
            Point p = pts.get(i);
            sb.append(u(p.x())).append(',').append(u(p.y())).append(',');
        }
        sb.append(u(first.x())).append(',').append(u(first.y())).append(";\n");
    }

    private static boolean isSmallPunchHole(List<Point> ring) {
        if (ring == null || ring.size() < 3) return false;
        double minX = Double.POSITIVE_INFINITY, maxX = Double.NEGATIVE_INFINITY;
        double minY = Double.POSITIVE_INFINITY, maxY = Double.NEGATIVE_INFINITY;
        for (Point p : ring) {
            minX = Math.min(minX, p.x());
            maxX = Math.max(maxX, p.x());
            minY = Math.min(minY, p.y());
            maxY = Math.max(maxY, p.y());
        }
        return (maxX - minX) <= SMALL_HOLE_THRESHOLD_MM && (maxY - minY) <= SMALL_HOLE_THRESHOLD_MM;
    }

    private static void appendPunchCross(StringBuilder sb, List<Point> ring) {
        double cx = 0.0, cy = 0.0;
        for (Point p : ring) {
            cx += p.x();
            cy += p.y();
        }
        cx /= ring.size();
        cy /= ring.size();
        double half = 2.0;
        sb.append("PU").append(u(cx - half)).append(',').append(u(cy)).append(';')
                .append("PD").append(u(cx + half)).append(',').append(u(cy)).append(';')
                .append("PU").append(u(cx)).append(',').append(u(cy - half)).append(';')
                .append("PD").append(u(cx)).append(',').append(u(cy + half)).append(";\n");
    }

    private static long u(double mm) {
        return Math.round(mm * UNITS_PER_MM);
    }
}
