package com.example.cutdemotwo.business.exports.pdf;

import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;
import java.util.Objects;

/**
 * 生产级 A4 随工单与多维汇总报表 PDF 渲染器（仅依赖 {@link PurePdfWriter}、领域模型与几何工具，零反向依赖导出业务包）。
 */
public final class PdfTicketRenderer {
    private static final float MARGIN_X = 36.0f;
    private static final float CONTENT_W = PurePdfWriter.A4_WIDTH - MARGIN_X * 2;
    private static final DateTimeFormatter TS_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    public record ProductionPdfSummary(
            String filterSummary,
            int schemeCount,
            int completedSchemes,
            double avgUtilizationPct,
            double totalConsumedAreaM2,
            double netGoodAreaM2,
            double totalMaterialCost,
            double netEffectiveCost,
            List<SchedulingScheme> schemes
    ) {}

    public byte[] renderTicketPdf(SchedulingScheme scheme, MotherRollInfo roll, CuttingTask task, List<Defect> windowDefects) {
        Objects.requireNonNull(scheme, "scheme");
        PurePdfWriter pdf = new PurePdfWriter();
        String workOrderNo = "WO-" + scheme.id();
        String printTime = LocalDateTime.now().format(TS_FMT);

        // 1. 顶部工单头栏
        pdf.setFillColor(0.11f, 0.17f, 0.27f);
        pdf.drawRectTop(MARGIN_X, 28, CONTENT_W, 44, false, true);
        pdf.setFillColor(1.0f, 1.0f, 1.0f);
        pdf.drawTextTop(MARGIN_X + 12, 48, 13, "生产裁切随工单 / PRODUCTION WORK ORDER");
        pdf.drawTextTop(MARGIN_X + CONTENT_W - 150, 48, 11, workOrderNo);
        pdf.drawTextTop(MARGIN_X + 12, 64, 9, "方案状态: " + nz(scheme.state()) + "  |  打印时间: " + printTime);

        // 2. 元数据面板
        pdf.setFillColor(0.96f, 0.97f, 0.98f);
        pdf.setStrokeColor(0.80f, 0.84f, 0.88f);
        pdf.setLineWidth(0.75f);
        pdf.drawRectTop(MARGIN_X, 82, CONTENT_W, 92, true, true);

        pdf.setFillColor(0.10f, 0.14f, 0.20f);
        String taskTitle = task != null ? task.name() : nz(scheme.taskName());
        String orderNo = nz(scheme.externalOrderNo());
        String batchNo = roll != null ? nz(roll.getBatchNo()) : "-";
        String color = roll != null ? nz(roll.getColor()) : "-";
        pdf.drawTextTop(MARGIN_X + 10, 100, 9.5f, "方案标题: " + truncate(nz(scheme.title()), 38) + "    维度: " + nz(scheme.dimension()));
        pdf.drawTextTop(MARGIN_X + 10, 118, 9.0f, "关联任务: " + nz(scheme.taskId()) + " (" + truncate(taskTitle, 22) + ")    外部单号: " + orderNo);
        pdf.drawTextTop(MARGIN_X + 10, 136, 9.0f, "物料型号: " + nz(scheme.materialModel()) + "    绑定材料: "
                + nz(scheme.rollId(), nz(scheme.remnantId(), "VIRTUAL_ROLL")) + "    缸号/色号: " + batchNo + " / " + color);
        pdf.drawTextTop(MARGIN_X + 10, 154, 9.0f, String.format(Locale.ROOT,
                "工位幅宽×占长: %.1f × %.1f mm (起始Y %.1f)    利用率: %.2f%%    件数: %d / %d",
                scheme.widthMm(), scheme.occupiedLengthMm() > 0 ? scheme.occupiedLengthMm() : scheme.canvasLengthMm(),
                scheme.windowStartY(), scheme.utilizationPct(), scheme.placedCount(), scheme.requestedCount()));

        // 3. 等比例矢量下刀缩略图
        float diagramTop = 186;
        float diagramH = 220;
        pdf.setFillColor(1.0f, 1.0f, 1.0f);
        pdf.setStrokeColor(0.70f, 0.75f, 0.80f);
        pdf.drawRectTop(MARGIN_X, diagramTop, CONTENT_W, diagramH, true, true);
        pdf.setFillColor(0.25f, 0.30f, 0.38f);
        pdf.drawTextTop(MARGIN_X + 8, diagramTop + 14, 8.5f, "等比例矢量排料/分切下刀图 (Scaled Vector Layout)");

        if ("SLITTING_1D".equalsIgnoreCase(scheme.dimension()) && scheme.slitting1D() != null) {
            drawSlittingDiagram(pdf, scheme, MARGIN_X + 12, diagramTop + 24, CONTENT_W - 24, diagramH - 34);
        } else if (scheme.layout2D() != null) {
            draw2DDiagram(pdf, scheme, windowDefects, MARGIN_X + 12, diagramTop + 24, CONTENT_W - 24, diagramH - 34);
        }

        // 4. 明细表（超页自动分页）
        float tableTop = diagramTop + diagramH + 14;
        if ("SLITTING_1D".equalsIgnoreCase(scheme.dimension()) && scheme.slitting1D() != null) {
            drawSlittingTable(pdf, workOrderNo, scheme.slitting1D(), tableTop);
        } else if (scheme.layout2D() != null) {
            draw2DPieceTable(pdf, workOrderNo, scheme.layout2D().placements(), tableTop);
        }

        // 5. 底部三方签字栏（确保画在最后一页底部）
        drawSignatureFooter(pdf, workOrderNo);
        return pdf.toPdfBytes();
    }

    public byte[] renderSummaryPdf(ProductionPdfSummary summary) {
        Objects.requireNonNull(summary, "summary");
        PurePdfWriter pdf = new PurePdfWriter();
        String printTime = LocalDateTime.now().format(TS_FMT);

        pdf.setFillColor(0.11f, 0.17f, 0.27f);
        pdf.drawRectTop(MARGIN_X, 28, CONTENT_W, 44, false, true);
        pdf.setFillColor(1.0f, 1.0f, 1.0f);
        pdf.drawTextTop(MARGIN_X + 12, 48, 14, "生产排程与实绩汇总报表 / PRODUCTION SUMMARY");
        pdf.drawTextTop(MARGIN_X + 12, 64, 9, "筛选条件: " + truncate(summary.filterSummary(), 56) + "  |  生成时间: " + printTime);

        // KPI 卡片
        pdf.setFillColor(0.95f, 0.97f, 0.99f);
        pdf.setStrokeColor(0.78f, 0.83f, 0.88f);
        pdf.drawRectTop(MARGIN_X, 82, CONTENT_W, 56, true, true);
        pdf.setFillColor(0.10f, 0.14f, 0.20f);
        pdf.drawTextTop(MARGIN_X + 12, 102, 9.5f, String.format(Locale.ROOT,
                "方案总数: %d    已完工方案: %d    平均利用率: %.2f%%",
                summary.schemeCount(), summary.completedSchemes(), summary.avgUtilizationPct()));
        pdf.drawTextTop(MARGIN_X + 12, 122, 9.5f, String.format(Locale.ROOT,
                "累计消耗面积: %.2f m2    净良品面积: %.2f m2    总材料成本: %.2f CNY    净有效成本: %.2f CNY",
                summary.totalConsumedAreaM2(), summary.netGoodAreaM2(),
                summary.totalMaterialCost(), summary.netEffectiveCost()));

        // 方案明细表
        float y = 152;
        drawSummaryTableHeader(pdf, y);
        y += 20;
        for (SchedulingScheme s : summary.schemes()) {
            if (y > 780) {
                pdf.newPage();
                pdf.setFillColor(0.15f, 0.20f, 0.28f);
                pdf.drawTextTop(MARGIN_X, 34, 10, "生产排程与实绩汇总报表（续页）");
                y = 48;
                drawSummaryTableHeader(pdf, y);
                y += 20;
            }
            pdf.setStrokeColor(0.88f, 0.90f, 0.92f);
            pdf.setLineWidth(0.4f);
            pdf.drawLineTop(MARGIN_X, y + 16, MARGIN_X + CONTENT_W, y + 16);
            pdf.setFillColor(0.12f, 0.15f, 0.20f);
            pdf.drawTextTop(MARGIN_X + 4, y + 12, 8, truncate(s.id(), 18));
            pdf.drawTextTop(MARGIN_X + 108, y + 12, 8, truncate(nz(s.taskId()), 14));
            pdf.drawTextTop(MARGIN_X + 190, y + 12, 8, truncate(nz(s.materialModel()), 14));
            pdf.drawTextTop(MARGIN_X + 275, y + 12, 8, truncate(nz(s.state()), 14));
            pdf.drawTextTop(MARGIN_X + 360, y + 12, 8, String.format(Locale.ROOT, "%.1f%%", s.utilizationPct()));
            pdf.drawTextTop(MARGIN_X + 412, y + 12, 8, s.placedCount() + "/" + s.requestedCount());
            pdf.drawTextTop(MARGIN_X + 462, y + 12, 8, truncate(nz(s.createdAt()), 16));
            y += 18;
        }
        return pdf.toPdfBytes();
    }

    private void draw2DDiagram(
            PurePdfWriter pdf, SchedulingScheme scheme, List<Defect> defects,
            float boxX, float boxY, float boxW, float boxH
    ) {
        double bedL = scheme.canvasLengthMm() > 0 ? scheme.canvasLengthMm() : Math.max(100.0, scheme.occupiedLengthMm());
        double rollW = scheme.widthMm() > 0 ? scheme.widthMm() : 2000.0;
        double scale = Math.min(boxW / bedL, boxH / rollW);
        float drawW = (float) (bedL * scale);
        float drawH = (float) (rollW * scale);
        float ox = boxX + (boxW - drawW) / 2.0f;
        float oy = boxY + (boxH - drawH) / 2.0f;

        // 母卷工位底框（横轴为长度 Y，纵轴为幅宽 X）
        pdf.setFillColor(0.98f, 0.99f, 1.0f);
        pdf.setStrokeColor(0.20f, 0.25f, 0.35f);
        pdf.setLineWidth(1.0f);
        pdf.drawRectTop(ox, oy, drawW, drawH, true, true);

        // 余料块
        for (SchedulingScheme.LeftoverItem r : scheme.layout2D().leftovers()) {
            pdf.setFillColor(0.88f, 0.97f, 0.91f);
            pdf.setStrokeColor(0.16f, 0.62f, 0.38f);
            pdf.setLineWidth(0.5f);
            pdf.drawRectTop(ox + (float) (r.y() * scale), oy + (float) (r.x() * scale),
                    (float) (r.l() * scale), (float) (r.w() * scale), true, true);
        }

        // 窗口疵点框
        if (defects != null) {
            for (Defect d : defects) {
                pdf.setFillColor(0.99f, 0.86f, 0.86f);
                pdf.setStrokeColor(0.85f, 0.18f, 0.18f);
                pdf.setLineWidth(0.6f);
                pdf.drawRectTop(ox + (float) (d.getY() * scale), oy + (float) (d.getX() * scale),
                        (float) (d.getH() * scale), (float) (d.getW() * scale), true, true);
            }
        }

        // 裁片多边形与内孔
        for (SchedulingScheme.PlacementItem p : scheme.layout2D().placements()) {
            Shape shape = (p.shape() != null && p.shape().width() > 0 && p.shape().height() > 0)
                    ? p.shape() : Shape.rectangle(Math.max(1, p.w()), Math.max(1, p.l()));
            List<Point> outer = PolygonGeometry.vertices(shape);
            drawScaledPolygon(pdf, outer, p.x(), p.y(), ox, oy, scale, true);
            for (List<Point> hole : shape.holes()) {
                drawScaledPolygon(pdf, hole, p.x(), p.y(), ox, oy, scale, false);
            }
        }

        // 直刀切割线
        pdf.setStrokeColor(0.82f, 0.22f, 0.45f);
        pdf.setLineWidth(0.7f);
        for (SchedulingScheme.CutLineItem c : scheme.layout2D().cuts()) {
            pdf.drawLineTop(ox + (float) (c.startY() * scale), oy + (float) (c.startX() * scale),
                    ox + (float) (c.endY() * scale), oy + (float) (c.endX() * scale));
        }
    }

    private static void drawScaledPolygon(
            PurePdfWriter pdf, List<Point> ring, double px, double py,
            float ox, float oy, double scale, boolean isOuter
    ) {
        if (ring == null || ring.size() < 3) return;
        float[] xs = new float[ring.size()];
        float[] ys = new float[ring.size()];
        for (int i = 0; i < ring.size(); i++) {
            Point pt = ring.get(i);
            xs[i] = ox + (float) ((py + pt.y()) * scale);
            ys[i] = oy + (float) ((px + pt.x()) * scale);
        }
        if (isOuter) {
            pdf.setFillColor(0.83f, 0.90f, 0.98f);
            pdf.setStrokeColor(0.12f, 0.36f, 0.68f);
        } else {
            pdf.setFillColor(1.0f, 1.0f, 1.0f);
            pdf.setStrokeColor(0.75f, 0.45f, 0.10f);
        }
        pdf.setLineWidth(0.6f);
        pdf.drawPolygonTop(xs, ys, true, true);
    }

    private void drawSlittingDiagram(
            PurePdfWriter pdf, SchedulingScheme scheme,
            float boxX, float boxY, float boxW, float boxH
    ) {
        var pats = scheme.slitting1D().patterns();
        if (pats.isEmpty()) return;
        int showCount = Math.min(pats.size(), 6);
        float rowH = Math.min(26.0f, (boxH - 8.0f) / showCount);
        double rollW = Math.max(1.0, scheme.widthMm());
        for (int i = 0; i < showCount; i++) {
            var pat = pats.get(i);
            float ry = boxY + i * (rowH + 3.0f);
            pdf.setFillColor(0.95f, 0.96f, 0.98f);
            pdf.setStrokeColor(0.45f, 0.50f, 0.58f);
            pdf.drawRectTop(boxX, ry, boxW, rowH - 4, true, true);
            float curX = boxX;
            for (var st : pat.stations()) {
                for (int c = 0; c < st.countPerRepetition(); c++) {
                    float sw = (float) ((st.widthMm() / rollW) * boxW);
                    pdf.setFillColor(0.82f, 0.91f, 0.98f);
                    pdf.setStrokeColor(0.15f, 0.40f, 0.72f);
                    pdf.drawRectTop(curX, ry, Math.max(2f, sw), rowH - 4, true, true);
                    curX += sw;
                }
            }
            pdf.setFillColor(0.15f, 0.20f, 0.25f);
            pdf.drawTextTop(boxX + 4, ry + 13, 7.5f, pat.id() + " x" + pat.repetitions() + " (" + pat.usedWidthMm() + "mm)");
        }
    }

    private void draw2DPieceTable(PurePdfWriter pdf, String workOrderNo, List<SchedulingScheme.PlacementItem> items, float startY) {
        float y = startY;
        drawPieceHeader(pdf, y);
        y += 18;
        for (SchedulingScheme.PlacementItem p : items) {
            if (y > 755) {
                pdf.newPage();
                pdf.setFillColor(0.15f, 0.20f, 0.28f);
                pdf.drawTextTop(MARGIN_X, 34, 9.5f, workOrderNo + " 裁片排料明细（续页）");
                y = 48;
                drawPieceHeader(pdf, y);
                y += 18;
            }
            pdf.setStrokeColor(0.88f, 0.90f, 0.92f);
            pdf.setLineWidth(0.4f);
            pdf.drawLineTop(MARGIN_X, y + 14, MARGIN_X + CONTENT_W, y + 14);
            pdf.setFillColor(0.12f, 0.15f, 0.20f);
            pdf.drawTextTop(MARGIN_X + 6, y + 11, 8, String.valueOf(p.id()));
            pdf.drawTextTop(MARGIN_X + 44, y + 11, 8, truncate(nz(p.name()), 24));
            pdf.drawTextTop(MARGIN_X + 190, y + 11, 8, String.format(Locale.ROOT, "%.1f × %.1f", p.w(), p.l()));
            pdf.drawTextTop(MARGIN_X + 290, y + 11, 8, String.format(Locale.ROOT, "(%.1f, %.1f)", p.x(), p.y()));
            pdf.drawTextTop(MARGIN_X + 390, y + 11, 8, p.rotationDegrees() + " deg");
            int holeCnt = p.shape() != null ? p.shape().holes().size() : 0;
            pdf.drawTextTop(MARGIN_X + 455, y + 11, 8, holeCnt > 0 ? (holeCnt + "孔") : "实心");
            y += 16;
        }
    }

    private void drawSlittingTable(PurePdfWriter pdf, String workOrderNo, SchedulingScheme.Slitting1DPayload payload, float startY) {
        float y = startY;
        drawSlittingHeader(pdf, y);
        y += 18;
        for (var pat : payload.patterns()) {
            if (y > 755) {
                pdf.newPage();
                pdf.setFillColor(0.15f, 0.20f, 0.28f);
                pdf.drawTextTop(MARGIN_X, 34, 9.5f, workOrderNo + " 分切刀组明细（续页）");
                y = 48;
                drawSlittingHeader(pdf, y);
                y += 18;
            }
            pdf.setStrokeColor(0.88f, 0.90f, 0.92f);
            pdf.setLineWidth(0.4f);
            pdf.drawLineTop(MARGIN_X, y + 14, MARGIN_X + CONTENT_W, y + 14);
            pdf.setFillColor(0.12f, 0.15f, 0.20f);
            pdf.drawTextTop(MARGIN_X + 6, y + 11, 8, truncate(pat.id(), 14));
            pdf.drawTextTop(MARGIN_X + 95, y + 11, 8, String.valueOf(pat.repetitions()));
            pdf.drawTextTop(MARGIN_X + 145, y + 11, 8, pat.lengthMm() + " mm");
            pdf.drawTextTop(MARGIN_X + 215, y + 11, 8, pat.usedWidthMm() + " / " + pat.spareWidthMm());
            StringBuilder stStr = new StringBuilder();
            for (var st : pat.stations()) {
                if (stStr.length() > 0) stStr.append(" + ");
                stStr.append(st.widthMm()).append("×").append(st.countPerRepetition());
            }
            pdf.drawTextTop(MARGIN_X + 305, y + 11, 8, truncate(stStr.toString(), 32));
            y += 16;
        }
    }

    private static void drawPieceHeader(PurePdfWriter pdf, float y) {
        pdf.setFillColor(0.92f, 0.94f, 0.97f);
        pdf.drawRectTop(MARGIN_X, y, CONTENT_W, 16, false, true);
        pdf.setFillColor(0.15f, 0.20f, 0.28f);
        pdf.drawTextTop(MARGIN_X + 6, y + 11, 8.5f, "序号");
        pdf.drawTextTop(MARGIN_X + 44, y + 11, 8.5f, "裁片名称");
        pdf.drawTextTop(MARGIN_X + 190, y + 11, 8.5f, "尺寸 (mm)");
        pdf.drawTextTop(MARGIN_X + 290, y + 11, 8.5f, "定位坐标");
        pdf.drawTextTop(MARGIN_X + 390, y + 11, 8.5f, "旋转角");
        pdf.drawTextTop(MARGIN_X + 455, y + 11, 8.5f, "内孔");
    }

    private static void drawSlittingHeader(PurePdfWriter pdf, float y) {
        pdf.setFillColor(0.92f, 0.94f, 0.97f);
        pdf.drawRectTop(MARGIN_X, y, CONTENT_W, 16, false, true);
        pdf.setFillColor(0.15f, 0.20f, 0.28f);
        pdf.drawTextTop(MARGIN_X + 6, y + 11, 8.5f, "刀组号");
        pdf.drawTextTop(MARGIN_X + 95, y + 11, 8.5f, "车数");
        pdf.drawTextTop(MARGIN_X + 145, y + 11, 8.5f, "定长");
        pdf.drawTextTop(MARGIN_X + 215, y + 11, 8.5f, "已用/余边");
        pdf.drawTextTop(MARGIN_X + 305, y + 11, 8.5f, "刀位明细");
    }

    private static void drawSummaryTableHeader(PurePdfWriter pdf, float y) {
        pdf.setFillColor(0.92f, 0.94f, 0.97f);
        pdf.drawRectTop(MARGIN_X, y, CONTENT_W, 18, false, true);
        pdf.setFillColor(0.15f, 0.20f, 0.28f);
        pdf.drawTextTop(MARGIN_X + 4, y + 13, 8.5f, "方案编号");
        pdf.drawTextTop(MARGIN_X + 108, y + 13, 8.5f, "任务号");
        pdf.drawTextTop(MARGIN_X + 190, y + 13, 8.5f, "物料型号");
        pdf.drawTextTop(MARGIN_X + 275, y + 13, 8.5f, "状态");
        pdf.drawTextTop(MARGIN_X + 360, y + 13, 8.5f, "利用率");
        pdf.drawTextTop(MARGIN_X + 412, y + 13, 8.5f, "件数");
        pdf.drawTextTop(MARGIN_X + 462, y + 13, 8.5f, "创建时间");
    }

    private static void drawSignatureFooter(PurePdfWriter pdf, String workOrderNo) {
        pdf.setStrokeColor(0.65f, 0.70f, 0.76f);
        pdf.setLineWidth(0.75f);
        pdf.drawLineTop(MARGIN_X, 782, MARGIN_X + CONTENT_W, 782);
        pdf.setFillColor(0.15f, 0.20f, 0.25f);
        pdf.drawTextTop(MARGIN_X + 6, 804, 9, "制单/排程员: ______________     机台操作员: ______________     质检复核员: ______________");
        pdf.drawTextTop(MARGIN_X + 6, 822, 8, workOrderNo + "  |  第 " + pdf.pageCount() + " 页");
    }

    private static String nz(String s) {
        return (s == null || s.isBlank()) ? "-" : s.trim();
    }

    private static String nz(String s, String fallback) {
        return (s == null || s.isBlank()) ? fallback : s.trim();
    }

    private static String truncate(String s, int maxLen) {
        if (s == null) return "-";
        if (maxLen <= 0) return "";
        if (s.length() <= maxLen) return s;
        int end = Math.max(0, maxLen - 2);
        if (end > 0 && end < s.length() && Character.isHighSurrogate(s.charAt(end - 1))) {
            end--;
        }
        return s.substring(0, end) + "..";
    }
}
