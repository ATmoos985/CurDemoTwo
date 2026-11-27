package com.example.cutdemotwo.business.exports;

import com.example.cutdemotwo.business.cutting.CuttingStatePort;
import com.example.cutdemotwo.business.cutting.DefectWindowSupport;
import com.example.cutdemotwo.business.cutting.ProductionCostAndProcurementService;
import com.example.cutdemotwo.business.cutting.ProductionCostAndProcurementService.CostSummaryResult;
import com.example.cutdemotwo.business.cutting.ProductionCostAndProcurementService.TaskCostItem;
import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.exports.pdf.PdfTicketRenderer;
import com.example.cutdemotwo.business.exports.pdf.PdfTicketRenderer.ProductionPdfSummary;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.contracts.geometry.Defect;
import org.apache.poi.ss.usermodel.*;
import org.apache.poi.xssf.streaming.SXSSFWorkbook;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.*;

/**
 * 生产工单 PDF 与多维生产汇总报表导出服务：
 * <ul>
 *   <li>支持单方案 A4 随工单 PDF（{@code ticket.pdf}）；</li>
 *   <li>支持按 {@code taskId / state / from / to} 过滤聚合方案、实绩、复检对账与成本核算，导出 PDF 或 5-Sheet SXSSF Excel。</li>
 * </ul>
 */
@Service
public class ProductionReportService {
    public static final Set<String> SUMMARY_FORMATS = Set.of("pdf", "xlsx");
    private static final double DEFAULT_UNIT_PRICE_PER_SQM = 35.0;
    private static final double DEFAULT_REMNANT_RESIDUAL_FACTOR = 0.4;
    private static final DateTimeFormatter SPACE_TS_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private final RemnantService remnantService;
    private final CuttingStatePort statePort;
    private final ProductionCostAndProcurementService costService;
    private final PdfTicketRenderer pdfRenderer = new PdfTicketRenderer();

    public ProductionReportService(
            RemnantService remnantService,
            ProductionCostAndProcurementService costService
    ) {
        this.remnantService = Objects.requireNonNull(remnantService, "remnantService");
        this.statePort = remnantService;
        this.costService = Objects.requireNonNull(costService, "costService");
    }

    public record ReportPayload(String fileName, String contentType, byte[] bytes) {}

    public ReportPayload exportTicketPdf(String schemeId) {
        String cleanId = (schemeId == null || schemeId.isBlank()) ? null : schemeId.trim();
        if (cleanId == null) {
            throw new IllegalArgumentException("方案编号 schemeId 不能为空");
        }
        byte[] pdfBytes = statePort.inRead(view -> {
            SchedulingScheme scheme = view.findScheme(cleanId)
                    .orElseThrow(() -> new ExportNotFoundException("未找到排程方案：" + cleanId));
            MotherRollInfo roll = (scheme.rollId() != null && !scheme.rollId().isBlank())
                    ? view.findRoll(scheme.rollId()).orElse(null)
                    : null;
            CuttingTask task = (scheme.taskId() != null && !scheme.taskId().isBlank())
                    ? view.findTask(scheme.taskId()).orElse(null)
                    : null;
            double width = scheme.widthMm() > 0 ? scheme.widthMm() : 2000.0;
            double bedLen = scheme.canvasLengthMm() > 0 ? scheme.canvasLengthMm()
                    : (scheme.occupiedLengthMm() > 0 ? scheme.occupiedLengthMm() : 5000.0);
            List<Defect> windowDefects = roll == null
                    ? List.of()
                    : DefectWindowSupport.sliceForWindow(roll.getDefects(), Math.max(0.0, scheme.windowStartY()), bedLen, width);
            return pdfRenderer.renderTicketPdf(scheme, roll, task, windowDefects);
        });
        return new ReportPayload(
                "WO-" + CamExportService.sanitizeFileStem(cleanId) + ".pdf",
                "application/pdf",
                pdfBytes
        );
    }

    public ReportPayload exportProductionSummary(String format, String taskId, String state, String from, String to) {
        String fmt = (format == null || format.isBlank()) ? "xlsx" : format.trim().toLowerCase(Locale.ROOT);
        if (!SUMMARY_FORMATS.contains(fmt)) {
            throw new IllegalArgumentException("不支持的汇总报表格式：" + format + "，支持 pdf/xlsx");
        }
        String cleanTaskId = blankToNull(taskId);
        String cleanState = blankToNull(state);
        if (cleanState != null) {
            cleanState = cleanState.toUpperCase(Locale.ROOT);
        }
        Instant fromTs = parseDateBound(from, false);
        Instant toTs = parseDateBound(to, true);
        if (fromTs != null && toTs != null && fromTs.isAfter(toTs)) {
            throw new IllegalArgumentException("起始日期 from 不能晚于结束日期 to");
        }

        String finalState = cleanState;
        List<SchedulingScheme> filteredSchemes = statePort.inRead(view -> view.querySchemes(finalState, cleanTaskId).stream()
                .filter(s -> matchesDateWindow(s.createdAt(), fromTs, toTs))
                .sorted(Comparator.comparing(s -> Objects.toString(s.createdAt(), ""), Comparator.reverseOrder()))
                .toList());

        List<Map<String, Object>> reports = fetchAllReconciliationReports(cleanTaskId, fromTs, toTs);
        CostSummaryResult costResult = costService.summarizeCosts(DEFAULT_UNIT_PRICE_PER_SQM, DEFAULT_REMNANT_RESIDUAL_FACTOR);

        double avgUtil = filteredSchemes.isEmpty() ? 0.0
                : filteredSchemes.stream().mapToDouble(SchedulingScheme::utilizationPct).average().orElse(0.0);
        int completedSchemes = (int) filteredSchemes.stream()
                .filter(s -> SchedulingScheme.STATE_COMPLETED.equalsIgnoreCase(s.state())).count();

        double totalConsumed = 0.0;
        double netGoodArea = 0.0;
        double totalCost = 0.0;
        double netCost = 0.0;
        if (cleanTaskId == null) {
            totalConsumed = costResult.summary().totalConsumedAreaM2();
            netGoodArea = costResult.summary().netGoodAreaM2();
            totalCost = costResult.summary().totalMaterialCost();
            netCost = costResult.summary().netEffectiveCost();
        } else {
            for (TaskCostItem item : costResult.byTask()) {
                if (cleanTaskId.equals(item.taskId())) {
                    totalConsumed += item.totalConsumedAreaM2();
                    netGoodArea += item.netGoodAreaM2();
                    totalCost += item.totalMaterialCost();
                    netCost += item.netEffectiveCost();
                }
            }
        }

        String filterDesc = String.format(Locale.ROOT, "taskId=%s, state=%s, from=%s, to=%s",
                cleanTaskId == null ? "ALL" : cleanTaskId,
                cleanState == null ? "ALL" : cleanState,
                from == null || from.isBlank() ? "*" : from.trim(),
                to == null || to.isBlank() ? "*" : to.trim());

        if ("pdf".equals(fmt)) {
            byte[] pdfBytes = pdfRenderer.renderSummaryPdf(new ProductionPdfSummary(
                    filterDesc, filteredSchemes.size(), completedSchemes, avgUtil,
                    totalConsumed, netGoodArea, totalCost, netCost, filteredSchemes
            ));
            return new ReportPayload("production-summary.pdf", "application/pdf", pdfBytes);
        }

        byte[] xlsxBytes = renderSummaryWorkbook(
                filterDesc, filteredSchemes, completedSchemes, avgUtil,
                totalConsumed, netGoodArea, totalCost, netCost,
                reports, costResult, cleanTaskId
        );
        return new ReportPayload(
                "production-summary.xlsx",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                xlsxBytes
        );
    }

    private List<Map<String, Object>> fetchAllReconciliationReports(String taskId, Instant fromTs, Instant toTs) {
        List<Map<String, Object>> all = new ArrayList<>();
        int offset = 0;
        int limit = 200;
        while (true) {
            Map<String, Object> page = remnantService.reconciliationReports(limit, offset, null, taskId);
            Object rawItems = page.get("items");
            if (!(rawItems instanceof List<?> list) || list.isEmpty()) {
                break;
            }
            for (Object obj : list) {
                if (obj instanceof Map<?, ?> rawMap) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> item = (Map<String, Object>) rawMap;
                    String confirmedAt = Objects.toString(item.get("confirmedAt"), "");
                    if (matchesDateWindow(confirmedAt, fromTs, toTs)) {
                        all.add(item);
                    }
                }
            }
            if (!Boolean.TRUE.equals(page.get("hasMore"))) {
                break;
            }
            offset += limit;
        }
        return all;
    }

    private byte[] renderSummaryWorkbook(
            String filterDesc,
            List<SchedulingScheme> schemes,
            int completedSchemes,
            double avgUtil,
            double totalConsumed,
            double netGoodArea,
            double totalCost,
            double netCost,
            List<Map<String, Object>> reports,
            CostSummaryResult costResult,
            String taskIdFilter
    ) {
        try (SXSSFWorkbook wb = new SXSSFWorkbook(100);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            wb.setCompressTempFiles(true);
            CellStyle headerStyle = createHeaderStyle(wb);

            // Sheet 1: 总览指标
            Sheet s1 = wb.createSheet("1_总览指标");
            writeHeaderRow(s1, new String[]{"指标项", "指标值", "说明"}, headerStyle);
            writeKvRow(s1, 1, "筛选条件", filterDesc, "查询范围参数");
            writeKvRow(s1, 2, "筛选方案总数", String.valueOf(schemes.size()), "已选定/执行中的排程方案数");
            writeKvRow(s1, 3, "已完工方案数", String.valueOf(completedSchemes), "状态为 COMPLETED");
            writeKvRow(s1, 4, "平均材料利用率(%)", round2Str(avgUtil), "方案平均面积利用率");
            writeKvRow(s1, 5, "实绩消耗面积(m2)", round4Str(totalConsumed), "报工实际投料消耗面积");
            writeKvRow(s1, 6, "净良品面积(m2)", round4Str(netGoodArea), "扣除复检判废后净合格面积");
            writeKvRow(s1, 7, "材料总成本(CNY)", round2Str(totalCost), "含实卷采购价及默认估价");
            writeKvRow(s1, 8, "净有效成本(CNY)", round2Str(netCost), "扣除可回收余料残值后");

            // Sheet 2: 方案台账
            Sheet s2 = wb.createSheet("2_方案台账");
            writeHeaderRow(s2, new String[]{
                    "方案编号", "标题", "维度", "任务编号", "外部单号", "物料型号", "材料模式",
                    "绑定母卷", "绑定料头", "幅宽(mm)", "占长(mm)", "利用率(%)", "已排件数", "需求件数", "状态", "创建时间"
            }, headerStyle);
            int r2 = 1;
            for (SchedulingScheme s : schemes) {
                Row row = s2.createRow(r2++);
                setText(row, 0, s.id());
                setText(row, 1, s.title());
                setText(row, 2, s.dimension());
                setText(row, 3, s.taskId());
                setText(row, 4, s.externalOrderNo());
                setText(row, 5, s.materialModel());
                setText(row, 6, s.materialMode());
                setText(row, 7, s.rollId());
                setText(row, 8, s.remnantId());
                row.createCell(9).setCellValue(s.widthMm());
                row.createCell(10).setCellValue(s.occupiedLengthMm());
                row.createCell(11).setCellValue(s.utilizationPct());
                row.createCell(12).setCellValue(s.placedCount());
                row.createCell(13).setCellValue(s.requestedCount());
                setText(row, 14, s.state());
                setText(row, 15, s.createdAt());
            }

            // Sheet 3: 裁片与分切明细
            Sheet s3 = wb.createSheet("3_裁片与分切明细");
            writeHeaderRow(s3, new String[]{
                    "方案编号", "维度", "明细序号/刀组", "名称/规格", "宽/已用宽(mm)", "长/定长(mm)",
                    "坐标/车数", "旋转/余边", "内孔/刀位"
            }, headerStyle);
            int r3 = 1;
            for (SchedulingScheme s : schemes) {
                if ("SLITTING_1D".equalsIgnoreCase(s.dimension()) && s.slitting1D() != null) {
                    for (var pat : s.slitting1D().patterns()) {
                        Row row = s3.createRow(r3++);
                        setText(row, 0, s.id());
                        setText(row, 1, "SLITTING_1D");
                        setText(row, 2, pat.id());
                        setText(row, 3, pat.surfaceTreatment() == null ? "分切刀组" : pat.surfaceTreatment());
                        row.createCell(4).setCellValue(pat.usedWidthMm());
                        row.createCell(5).setCellValue(pat.lengthMm());
                        row.createCell(6).setCellValue(pat.repetitions());
                        row.createCell(7).setCellValue(pat.spareWidthMm());
                        setText(row, 8, pat.stations().toString());
                    }
                } else if (s.layout2D() != null) {
                    for (var p : s.layout2D().placements()) {
                        Row row = s3.createRow(r3++);
                        setText(row, 0, s.id());
                        setText(row, 1, "NESTING_2D");
                        setText(row, 2, String.valueOf(p.id()));
                        setText(row, 3, p.name());
                        row.createCell(4).setCellValue(p.w());
                        row.createCell(5).setCellValue(p.l());
                        setText(row, 6, String.format(Locale.ROOT, "(%.1f, %.1f)", p.x(), p.y()));
                        row.createCell(7).setCellValue(p.rotationDegrees());
                        row.createCell(8).setCellValue(p.shape() == null ? 0 : p.shape().holes().size());
                    }
                }
            }

            // Sheet 4: 实绩消耗与复检对账
            Sheet s4 = wb.createSheet("4_实绩消耗与复检对账");
            writeHeaderRow(s4, new String[]{
                    "报工单号", "关联方案", "任务编号", "任务名称", "物料型号", "缸号", "色号",
                    "消耗面积(m2)", "净良品面积(m2)", "净良品件数", "回收料头面积(m2)", "废料面积(m2)",
                    "净利用率(%)", "有效复检处置数", "待复检件数", "状态", "报工时间"
            }, headerStyle);
            int r4 = 1;
            for (Map<String, Object> rep : reports) {
                Row row = s4.createRow(r4++);
                setText(row, 0, rep.get("reportId"));
                setText(row, 1, rep.get("schemeId"));
                setText(row, 2, rep.get("taskId"));
                setText(row, 3, rep.get("taskName"));
                setText(row, 4, rep.get("materialModel"));
                setText(row, 5, rep.get("batchNo"));
                setText(row, 6, rep.get("color"));
                row.createCell(7).setCellValue(numVal(rep.get("usedArea")));
                row.createCell(8).setCellValue(numVal(rep.get("netPieceArea")));
                row.createCell(9).setCellValue(numVal(rep.get("netFinishedPieceCount")));
                row.createCell(10).setCellValue(numVal(rep.get("netRemArea")));
                row.createCell(11).setCellValue(numVal(rep.get("netWasteArea")));
                row.createCell(12).setCellValue(numVal(rep.get("netUtilization")));
                row.createCell(13).setCellValue(numVal(rep.get("activeDispositionCount")));
                row.createCell(14).setCellValue(numVal(rep.get("reinspectionRemainingCount")));
                setText(row, 15, rep.get("status"));
                setText(row, 16, rep.get("confirmedAt"));
            }

            // Sheet 5: 成本核算摘要
            Sheet s5 = wb.createSheet("5_成本核算摘要");
            writeHeaderRow(s5, new String[]{
                    "归集维度", "任务/型号标识", "名称", "物料型号", "报工数", "消耗面积(m2)",
                    "净良品面积(m2)", "材料成本(CNY)", "余料残值(CNY)", "净有效成本(CNY)", "废料成本(CNY)", "单位良品成本(CNY/m2)"
            }, headerStyle);
            int r5 = 1;
            for (TaskCostItem t : costResult.byTask()) {
                if (taskIdFilter != null && !taskIdFilter.equals(t.taskId())) continue;
                Row row = s5.createRow(r5++);
                setText(row, 0, "TASK");
                setText(row, 1, t.taskId());
                setText(row, 2, t.taskName());
                setText(row, 3, t.materialModel());
                row.createCell(4).setCellValue(t.reportCount());
                row.createCell(5).setCellValue(t.totalConsumedAreaM2());
                row.createCell(6).setCellValue(t.netGoodAreaM2());
                row.createCell(7).setCellValue(t.totalMaterialCost());
                row.createCell(8).setCellValue(t.recoveredResidualValue());
                row.createCell(9).setCellValue(t.netEffectiveCost());
                row.createCell(10).setCellValue(t.wasteCost());
                row.createCell(11).setCellValue(t.avgCostPerGoodSqm());
            }
            if (taskIdFilter == null) {
                for (var m : costResult.byMaterialModel()) {
                    Row row = s5.createRow(r5++);
                    setText(row, 0, "MATERIAL_MODEL");
                    setText(row, 1, m.materialModel());
                    setText(row, 2, m.materialModel());
                    setText(row, 3, m.materialModel());
                    row.createCell(4).setCellValue(m.reportCount());
                    row.createCell(5).setCellValue(m.totalConsumedAreaM2());
                    row.createCell(6).setCellValue(m.netGoodAreaM2());
                    row.createCell(7).setCellValue(m.totalMaterialCost());
                    row.createCell(8).setCellValue(m.recoveredResidualValue());
                    row.createCell(9).setCellValue(m.netEffectiveCost());
                    row.createCell(10).setCellValue(m.wasteCost());
                    row.createCell(11).setCellValue(m.avgCostPerGoodSqm());
                }
            }

            wb.write(out);
            wb.dispose();
            return out.toByteArray();
        } catch (IOException e) {
            throw new IllegalStateException("生成多维生产汇总 XLSX 失败", e);
        }
    }

    static Instant parseDateBound(String raw, boolean endOfDay) {
        String clean = blankToNull(raw);
        if (clean == null) return null;
        try {
            if (clean.matches("\\d{4}-\\d{2}-\\d{2}")) {
                LocalDate d = LocalDate.parse(clean);
                LocalDateTime dt = endOfDay ? d.atTime(23, 59, 59, 999_000_000) : d.atStartOfDay();
                return dt.atZone(ZoneId.systemDefault()).toInstant();
            }
            if (clean.matches("\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}")) {
                return LocalDateTime.parse(clean, SPACE_TS_FMT).atZone(ZoneId.systemDefault()).toInstant();
            }
            return Instant.parse(clean);
        } catch (DateTimeParseException e) {
            try {
                return LocalDateTime.parse(clean).atZone(ZoneId.systemDefault()).toInstant();
            } catch (DateTimeParseException ex) {
                throw new IllegalArgumentException("日期时间格式无效：" + raw + "，支持 yyyy-MM-dd、yyyy-MM-dd HH:mm:ss 或 ISO-8601");
            }
        }
    }

    private static boolean matchesDateWindow(String tsStr, Instant fromTs, Instant toTs) {
        if (fromTs == null && toTs == null) return true;
        if (tsStr == null || tsStr.isBlank()) return false;
        Instant actual;
        try {
            actual = parseDateBound(tsStr, false);
        } catch (IllegalArgumentException e) {
            return false;
        }
        if (fromTs != null && actual.isBefore(fromTs)) return false;
        return toTs == null || !actual.isAfter(toTs);
    }

    private static CellStyle createHeaderStyle(SXSSFWorkbook wb) {
        CellStyle style = wb.createCellStyle();
        Font font = wb.createFont();
        font.setBold(true);
        style.setFont(font);
        return style;
    }

    private static void writeHeaderRow(Sheet sheet, String[] headers, CellStyle style) {
        Row row = sheet.createRow(0);
        for (int i = 0; i < headers.length; i++) {
            Cell c = row.createCell(i);
            c.setCellValue(CsvSanitizer.excelCellText(headers[i]));
            c.setCellStyle(style);
        }
    }

    private static void writeKvRow(Sheet sheet, int rowIdx, String k, String v, String note) {
        Row row = sheet.createRow(rowIdx);
        setText(row, 0, k);
        setText(row, 1, v);
        setText(row, 2, note);
    }

    private static void setText(Row row, int col, Object value) {
        row.createCell(col).setCellValue(CsvSanitizer.excelCellText(value));
    }

    private static double numVal(Object v) {
        return v instanceof Number n ? n.doubleValue() : 0.0;
    }

    private static String round2Str(double v) {
        return String.format(Locale.ROOT, "%.2f", v);
    }

    private static String round4Str(double v) {
        return String.format(Locale.ROOT, "%.4f", v);
    }

    private static String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s.trim();
    }
}
