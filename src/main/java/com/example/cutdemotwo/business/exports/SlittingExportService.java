package com.example.cutdemotwo.business.exports;

import com.example.cutdemotwo.business.cutting.CuttingStatePort;
import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.CellStyle;
import org.apache.poi.ss.usermodel.Font;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.xssf.streaming.SXSSFWorkbook;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.*;

/**
 * 1D 分切设备配方导出服务：
 * 仅允许对 {@code SLITTING_1D} 方案输出 {@code json}、{@code csv}（UTF-8 BOM + 防公式注入）或 {@code xlsx}（SXSSFWorkbook 流式写入），
 * 对 2D 方案请求分切导出明确抛出 {@link IllegalArgumentException}（400）。
 */
@Service
public class SlittingExportService {
    public static final Set<String> SUPPORTED_FORMATS = Set.of("json", "csv", "xlsx");

    private final CuttingStatePort statePort;
    private final ObjectMapper json = new ObjectMapper();

    public SlittingExportService(RemnantService remnantService) {
        this.statePort = Objects.requireNonNull(remnantService, "remnantService");
    }

    public record SlittingExportPayload(String fileName, String contentType, byte[] bytes) {}

    public record SlittingRecipeDto(
            String schemeId,
            String title,
            String taskId,
            String materialModel,
            String rollId,
            double widthMm,
            double utilizationPct,
            int leftTrimMm,
            int rightTrimMm,
            int fixedLengthMm,
            int totalCars,
            int missingRolls,
            int overproducedRolls,
            List<SchedulingScheme.SlittingPatternItem> patterns,
            List<SchedulingScheme.SlittingFulfillmentItem> fulfillment
    ) {}

    public SlittingExportPayload exportSlitting(String schemeId, String format) {
        String cleanId = (schemeId == null || schemeId.isBlank()) ? null : schemeId.trim();
        if (cleanId == null) {
            throw new IllegalArgumentException("方案编号 schemeId 不能为空");
        }
        String fmt = (format == null || format.isBlank()) ? "json" : format.trim().toLowerCase(Locale.ROOT);
        if (!SUPPORTED_FORMATS.contains(fmt)) {
            throw new IllegalArgumentException("不支持的分切导出格式：" + format + "，支持 json/csv/xlsx");
        }

        SchedulingScheme scheme = statePort.inRead(view -> view.findScheme(cleanId))
                .orElseThrow(() -> new ExportNotFoundException("未找到排程方案：" + cleanId));
        if (!"SLITTING_1D".equalsIgnoreCase(scheme.dimension()) || scheme.slitting1D() == null) {
            throw new IllegalArgumentException("仅 1D 分切方案支持导出分切机台配方，当前方案维度为：" + scheme.dimension());
        }

        SchedulingScheme.Slitting1DPayload p = scheme.slitting1D();
        SlittingRecipeDto recipe = new SlittingRecipeDto(
                scheme.id(), scheme.title(), scheme.taskId(), scheme.materialModel(),
                scheme.rollId(), scheme.widthMm(), scheme.utilizationPct(),
                p.leftTrimMm(), p.rightTrimMm(), p.fixedLengthMm(), p.totalCars(),
                p.missingRolls(), p.overproducedRolls(), p.patterns(), p.fulfillment()
        );

        String stem = CamExportService.sanitizeFileStem(cleanId) + "-slitting";
        return switch (fmt) {
            case "json" -> new SlittingExportPayload(stem + ".json", "application/json; charset=UTF-8",
                    json.writerWithDefaultPrettyPrinter().writeValueAsBytes(recipe));
            case "csv" -> new SlittingExportPayload(stem + ".csv", "text/csv; charset=UTF-8", renderCsv(recipe));
            case "xlsx" -> new SlittingExportPayload(stem + ".xlsx",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", renderXlsx(recipe));
            default -> throw new IllegalArgumentException("不支持的导出格式：" + format);
        };
    }

    private byte[] renderCsv(SlittingRecipeDto recipe) {
        StringBuilder sb = new StringBuilder();
        sb.append(String.join(",",
                CsvSanitizer.csvCell("方案编号"),
                CsvSanitizer.csvCell("刀组编号"),
                CsvSanitizer.csvCell("车数(repetitions)"),
                CsvSanitizer.csvCell("定长(mm)"),
                CsvSanitizer.csvCell("已用幅宽(mm)"),
                CsvSanitizer.csvCell("余边幅宽(mm)"),
                CsvSanitizer.csvCell("左修边(mm)"),
                CsvSanitizer.csvCell("右修边(mm)"),
                CsvSanitizer.csvCell("刀位宽度明细(width x count)"),
                CsvSanitizer.csvCell("表面工艺"),
                CsvSanitizer.csvCell("订单分配"))).append("\r\n");

        for (SchedulingScheme.SlittingPatternItem pat : recipe.patterns()) {
            sb.append(String.join(",",
                    CsvSanitizer.csvCell(recipe.schemeId()),
                    CsvSanitizer.csvCell(pat.id()),
                    CsvSanitizer.csvCell(pat.repetitions()),
                    CsvSanitizer.csvCell(pat.lengthMm()),
                    CsvSanitizer.csvCell(pat.usedWidthMm()),
                    CsvSanitizer.csvCell(pat.spareWidthMm()),
                    CsvSanitizer.csvCell(recipe.leftTrimMm()),
                    CsvSanitizer.csvCell(recipe.rightTrimMm()),
                    CsvSanitizer.csvCell(formatStations(pat.stations())),
                    CsvSanitizer.csvCell(pat.surfaceTreatment()),
                    CsvSanitizer.csvCell(formatAllocations(pat.allocations())))).append("\r\n");
        }
        return CsvSanitizer.toUtf8WithBom(sb.toString());
    }

    private byte[] renderXlsx(SlittingRecipeDto recipe) {
        try (SXSSFWorkbook wb = new SXSSFWorkbook(100);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            wb.setCompressTempFiles(true);
            CellStyle headerStyle = createHeaderStyle(wb);

            Sheet recipeSheet = wb.createSheet("1D分切刀组配方");
            String[] headers = {"方案编号", "物料型号", "母卷号", "刀组编号", "车数", "定长(mm)",
                    "已用幅宽(mm)", "余边(mm)", "左修边(mm)", "右修边(mm)", "刀位组合", "表面工艺", "订单分配"};
            writeHeaderRow(recipeSheet, headers, headerStyle);
            int rowIdx = 1;
            for (SchedulingScheme.SlittingPatternItem pat : recipe.patterns()) {
                Row row = recipeSheet.createRow(rowIdx++);
                setTextCell(row, 0, recipe.schemeId());
                setTextCell(row, 1, recipe.materialModel());
                setTextCell(row, 2, recipe.rollId());
                setTextCell(row, 3, pat.id());
                row.createCell(4).setCellValue(pat.repetitions());
                row.createCell(5).setCellValue(pat.lengthMm());
                row.createCell(6).setCellValue(pat.usedWidthMm());
                row.createCell(7).setCellValue(pat.spareWidthMm());
                row.createCell(8).setCellValue(recipe.leftTrimMm());
                row.createCell(9).setCellValue(recipe.rightTrimMm());
                setTextCell(row, 10, formatStations(pat.stations()));
                setTextCell(row, 11, pat.surfaceTreatment());
                setTextCell(row, 12, formatAllocations(pat.allocations()));
            }

            Sheet fulfillSheet = wb.createSheet("订单履约汇总");
            String[] fHeaders = {"订单编号", "规格名称", "窄幅宽(mm)", "需求卷数", "计划产出卷数", "欠产卷数", "超产卷数"};
            writeHeaderRow(fulfillSheet, fHeaders, headerStyle);
            int fRowIdx = 1;
            for (SchedulingScheme.SlittingFulfillmentItem f : recipe.fulfillment()) {
                Row row = fulfillSheet.createRow(fRowIdx++);
                setTextCell(row, 0, f.orderId());
                setTextCell(row, 1, f.name());
                row.createCell(2).setCellValue(f.widthMm());
                row.createCell(3).setCellValue(f.requested());
                row.createCell(4).setCellValue(f.produced());
                row.createCell(5).setCellValue(f.missing());
                row.createCell(6).setCellValue(f.overproduced());
            }

            wb.write(out);
            wb.dispose();
            return out.toByteArray();
        } catch (IOException e) {
            throw new IllegalStateException("生成 1D 分切 XLSX 文件失败", e);
        }
    }

    private static String formatStations(List<SchedulingScheme.StationItem> stations) {
        if (stations == null || stations.isEmpty()) return "";
        List<String> parts = new ArrayList<>(stations.size());
        for (SchedulingScheme.StationItem st : stations) {
            parts.add(st.widthMm() + "mm×" + st.countPerRepetition());
        }
        return String.join(" + ", parts);
    }

    private static String formatAllocations(List<SchedulingScheme.SlittingAllocationItem> allocations) {
        if (allocations == null || allocations.isEmpty()) return "";
        List<String> parts = new ArrayList<>(allocations.size());
        for (SchedulingScheme.SlittingAllocationItem a : allocations) {
            parts.add(a.orderId() + ":" + a.quantity());
        }
        return String.join("; ", parts);
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

    private static void setTextCell(Row row, int col, Object value) {
        row.createCell(col).setCellValue(CsvSanitizer.excelCellText(value));
    }
}
