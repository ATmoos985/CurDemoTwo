package com.example.cutdemotwo.business.exports;

import com.example.cutdemotwo.algorithm.toolpath.ToolpathOptimizerService;
import com.example.cutdemotwo.business.cutting.ProductionCostAndProcurementService;
import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.persistence.FileInventoryStore;
import org.apache.poi.xssf.usermodel.XSSFSheet;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.*;
import java.util.zip.InflaterInputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import static org.junit.jupiter.api.Assertions.*;

/**
 * M4-2 CSV 防公式注入、1D 分切配方、纯 Java PDF 随工单/汇总报表、5-Sheet SXSSF Excel 与防 Zip Slip 批量导出测试。
 */
class ReportAndBatchExportTests {

    @TempDir
    Path tempDir;

    private RemnantService createServiceWithSchemes(String fileName, int extraPlacementsCount) {
        RemnantService svc = new RemnantService(new FileInventoryStore(tempDir.resolve(fileName).toString()), false);

        List<SchedulingScheme.PlacementItem> manyPlacements = new ArrayList<>();
        for (int i = 1; i <= extraPlacementsCount; i++) {
            manyPlacements.add(new SchedulingScheme.PlacementItem(
                    i, i, "件号-" + i, 10.0 * (i % 5), 20.0 * i, 100, 80, 0, false, Shape.rectangle(100, 80)));
        }

        SchedulingScheme scheme2D = new SchedulingScheme(
                "SCH-2D-RPT", "k-2d-rpt", "=cmd|' /C calc'!A0", "NESTING_2D",
                "SC-1", "STR-1", "标准2D", "TASK-A", "测试任务A", "ORD-A",
                "VIRTUAL_ROLL", null, null, "TC-01",
                1500.0, 3000.0, 0.0, 1200.0, 0.0, 0.0, 78.5, 1.4,
                manyPlacements.size(), manyPlacements.size(), 0, true, Map.of("1", 1), List.of(), null,
                SchedulingScheme.STATE_COMPLETED, null,
                new SchedulingScheme.Layout2DPayload(manyPlacements, List.of(), List.of()),
                null, null, "2026-11-26 10:00:00", null, "2026-11-26 12:00:00", null, null
        );

        SchedulingScheme scheme1D = new SchedulingScheme(
                "SCH-1D-RPT", "k-1d-rpt", "+SUM(1,2)", "SLITTING_1D",
                "SC-1", "STR-1D", "一维分切", "TASK-B", "分切任务B", "ORD-B",
                "VIRTUAL_ROLL", null, null, "TC-01",
                1600.0, 0.0, 0.0, 0.0, 0.0, 0.0, 96.2, 12.0,
                6, 6, 0, true, Map.of(), List.of(), null,
                SchedulingScheme.STATE_AWAITING_ROLL, null, null,
                new SchedulingScheme.Slitting1DPayload(
                        10, 10, 100, 1600, 1, 0, 1000, 3, 0, 0,
                        List.of(new SchedulingScheme.SlittingPatternItem(
                                "PAT-1", 1000, 3, 1580, 20,
                                List.of(new SchedulingScheme.StationItem(790, 2)),
                                "=HYPERLINK(\"http://evil\")",
                                List.of(new SchedulingScheme.SlittingAllocationItem("=ORD-B", 6))
                        )),
                        List.of(new SchedulingScheme.SlittingFulfillmentItem("=ORD-B", "@危险规格", 790, 6, 6, 0, 0))
                ),
                null, "2026-11-27 09:00:00", null, null, null, null
        );

        svc.inWrite("SEED_REPORT", "SEED", "TEST", tx -> {
            tx.putScheme(scheme2D);
            tx.putScheme(scheme1D);
            return null;
        });
        return svc;
    }

    @Test
    void csvSanitizerNeutralizesAllFormulaInjectionPrefixes() {
        assertEquals("'=cmd|' /C calc'!A0", CsvSanitizer.sanitizeText("=cmd|' /C calc'!A0"));
        assertEquals("'+1+1", CsvSanitizer.sanitizeText("+1+1"));
        assertEquals("'-2+3", CsvSanitizer.sanitizeText("-2+3"));
        assertEquals("'@SUM(A1:A2)", CsvSanitizer.sanitizeText("@SUM(A1:A2)"));
        assertEquals("'\t=1", CsvSanitizer.sanitizeText("\t=1"));
        assertEquals("'\r+1", CsvSanitizer.sanitizeText("\r+1"));
        assertEquals("'  =1", CsvSanitizer.sanitizeText("  =1"));
        assertEquals("'\u00A0=1+1", CsvSanitizer.sanitizeText("\u00A0=1+1"));
        assertEquals("'\u200B=1+1", CsvSanitizer.sanitizeText("\u200B=1+1"));
        assertEquals("'\uFEFF=1+1", CsvSanitizer.sanitizeText("\uFEFF=1+1"));
        assertEquals("'\u0001=1+1", CsvSanitizer.sanitizeText("\u0001=1+1"));
        assertEquals("'\u200C=1+1", CsvSanitizer.sanitizeText("\u200C=1+1"));
        assertEquals("'\u200D+1+1", CsvSanitizer.sanitizeText("\u200D+1+1"));
        assertEquals("'\u2060-1+1", CsvSanitizer.sanitizeText("\u2060-1+1"));
        assertEquals("'\u00AD@SUM(1,1)", CsvSanitizer.sanitizeText("\u00AD@SUM(1,1)"));
        assertEquals("'\u007F=1+1", CsvSanitizer.sanitizeText("\u007F=1+1"));
        assertEquals("'\u0085=1+1", CsvSanitizer.sanitizeText("\u0085=1+1"));
        assertEquals("'\u200E=1+1", CsvSanitizer.sanitizeText("\u200E=1+1"));
        assertEquals("' \u00A0\u200C\u200D\u2060\u00AD\u0085=1+1",
                CsvSanitizer.sanitizeText(" \u00A0\u200C\u200D\u2060\u00AD\u0085=1+1"));
        assertEquals("'\u0085ABC", CsvSanitizer.sanitizeText("\u0085ABC"));
        assertEquals("'\u007FABC", CsvSanitizer.sanitizeText("\u007FABC"));
        assertEquals("\"'=1+1\"", CsvSanitizer.csvCell("=1+1"));
        // 零误伤负向验证：正常中文、中置连字符、带 BOM 正常文本与 ZWJ Emoji
        assertEquals("正常文本123", CsvSanitizer.sanitizeText("正常文本123"));
        assertEquals("PAT-1", CsvSanitizer.sanitizeText("PAT-1"));
        assertEquals("布料A-01", CsvSanitizer.sanitizeText("布料A-01"));
        assertEquals("\uFEFF正常中文", CsvSanitizer.sanitizeText("\uFEFF正常中文"));
        assertEquals("👨‍👩‍👧家庭", CsvSanitizer.sanitizeText("👨‍👩‍👧家庭"));
    }

    @Test
    void slittingExportSupportsJsonCsvXlsxWithSanitizationAndRejects2DSchemes() throws Exception {
        RemnantService svc = createServiceWithSchemes("slitting-export.json", 2);
        SlittingExportService slitting = new SlittingExportService(svc);

        // JSON
        byte[] jsonBytes = slitting.exportSlitting("SCH-1D-RPT", "json").bytes();
        assertTrue(new String(jsonBytes, StandardCharsets.UTF_8).contains("PAT-1"));

        // CSV (BOM + sanitized)
        byte[] csvBytes = slitting.exportSlitting("SCH-1D-RPT", "csv").bytes();
        assertEquals((byte) 0xEF, csvBytes[0]);
        assertEquals((byte) 0xBB, csvBytes[1]);
        assertEquals((byte) 0xBF, csvBytes[2]);
        String csv = new String(csvBytes, StandardCharsets.UTF_8);
        assertTrue(csv.contains("'=HYPERLINK"));
        assertTrue(csv.contains("'=ORD-B:6"));

        // XLSX 回读
        byte[] xlsxBytes = slitting.exportSlitting("SCH-1D-RPT", "xlsx").bytes();
        try (XSSFWorkbook wb = new XSSFWorkbook(new ByteArrayInputStream(xlsxBytes))) {
            assertEquals(2, wb.getNumberOfSheets());
            XSSFSheet s1 = wb.getSheet("1D分切刀组配方");
            assertNotNull(s1);
            assertEquals("PAT-1", s1.getRow(1).getCell(3).getStringCellValue());
            assertTrue(s1.getRow(1).getCell(11).getStringCellValue().startsWith("'="));
            XSSFSheet s2 = wb.getSheet("订单履约汇总");
            assertNotNull(s2);
            assertTrue(s2.getRow(1).getCell(1).getStringCellValue().startsWith("'@"));
        }

        // 2D 方案请求 /slitting 必须抛 400
        assertThrows(IllegalArgumentException.class, () -> slitting.exportSlitting("SCH-2D-RPT", "json"));
    }

    @Test
    void productionReportGeneratesMultiPageTicketPdfSummaryPdfAndFiveSheetWorkbook() throws Exception {
        RemnantService svc = createServiceWithSchemes("report-export.json", 55);
        ProductionCostAndProcurementService costSvc = new ProductionCostAndProcurementService(svc);
        ProductionReportService reportSvc = new ProductionReportService(svc, costSvc);

        // 1. 随工单 PDF（55 裁片应自动分页 >= 2 页，验证压缩内容流含 WO- 与矢量操作）
        byte[] ticketPdf = reportSvc.exportTicketPdf("SCH-2D-RPT").bytes();
        String pdfAscii = new String(ticketPdf, StandardCharsets.ISO_8859_1);
        assertTrue(pdfAscii.startsWith("%PDF-1.4\n"));
        assertTrue(pdfAscii.trim().endsWith("%%EOF"));
        assertTrue(pdfAscii.contains("/STSong-Light"));
        assertTrue(pdfAscii.contains("/UniGB-UTF16-H"));
        assertTrue(pdfAscii.contains("/Count 2") || pdfAscii.contains("/Count 3"), "55 个裁片应自动分页至第 2 页及以上");
        String decompressed = decompressPdfStreams(ticketPdf);
        assertTrue(decompressed.contains("WO-SCH-2D-RPT"));
        assertTrue(decompressed.contains(" re "));

        // 2. 生产汇总 PDF（带过滤条件）
        byte[] summaryPdf = reportSvc.exportProductionSummary("pdf", "TASK-A", "COMPLETED", "2026-11-26", "2026-11-26").bytes();
        String summaryPdfStr = new String(summaryPdf, StandardCharsets.ISO_8859_1);
        assertTrue(summaryPdfStr.startsWith("%PDF-1.4\n"));
        assertTrue(decompressPdfStreams(summaryPdf).contains("SCH-2D-RPT"));
        assertFalse(decompressPdfStreams(summaryPdf).contains("SCH-1D-RPT"), "TASK-A 过滤不应包含 TASK-B 的 1D 方案");

        // 3. 5-Sheet XLSX 回读校验与防注入
        byte[] summaryXlsx = reportSvc.exportProductionSummary("xlsx", null, null, "2026-11-25", "2026-11-28").bytes();
        try (XSSFWorkbook wb = new XSSFWorkbook(new ByteArrayInputStream(summaryXlsx))) {
            assertEquals(5, wb.getNumberOfSheets());
            assertNotNull(wb.getSheet("1_总览指标"));
            assertNotNull(wb.getSheet("2_方案台账"));
            assertNotNull(wb.getSheet("3_裁片与分切明细"));
            assertNotNull(wb.getSheet("4_实绩消耗与复检对账"));
            assertNotNull(wb.getSheet("5_成本核算摘要"));
            XSSFSheet ledgerSheet = wb.getSheet("2_方案台账");
            assertEquals("2", wb.getSheet("1_总览指标").getRow(2).getCell(1).getStringCellValue());
            // 第1行是按 createdAt 降序排列的 SCH-1D-RPT (+SUM 应被清洗前置 ')
            assertTrue(ledgerSheet.getRow(1).getCell(1).getStringCellValue().startsWith("'+"));
            assertTrue(ledgerSheet.getRow(2).getCell(1).getStringCellValue().startsWith("'="));
        }

        // 4. 非法日期区间拦截
        assertThrows(IllegalArgumentException.class,
                () -> reportSvc.exportProductionSummary("xlsx", null, null, "bad-date", null));
        assertThrows(IllegalArgumentException.class,
                () -> reportSvc.exportProductionSummary("xlsx", null, null, "2026-11-28", "2026-11-25"));

        // 5. 控制字符过滤与 UTF-16 增补字符截断不劈开代理对（绝不产生 U+FFFD）
        SchedulingScheme unicodeScheme = new SchedulingScheme(
                "SCH-UNI-PDF", "k-uni-pdf", "工单\u0000控制\u0007测试", "NESTING_2D",
                "SC-1", "STR-UNI", "编码测试", "TASK-UNI", "编码任务", "ORD-UNI",
                "VIRTUAL_ROLL", null, null, "TC-01",
                1500.0, 3000.0, 0.0, 1200.0, 0.0, 0.0, 75.0, 1.0,
                1, 1, 0, true, Map.of("1", 1), List.of(), null,
                SchedulingScheme.STATE_COMPLETED, null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(new SchedulingScheme.PlacementItem(
                                1, 1, "ABCDEFGHIJKLMNOPQRSTU\uD840\uDC00VWXYZ", 0, 0, 100, 80, 0, false, Shape.rectangle(100, 80))),
                        List.of(), List.of()
                ),
                null, null, "2026-11-27 10:00:00", null, "2026-11-27 10:10:00", null, null
        );
        svc.inWrite("SEED_UNICODE_PDF", "SEED", "TEST", tx -> {
            tx.putScheme(unicodeScheme);
            return null;
        });
        byte[] uniPdf = reportSvc.exportTicketPdf("SCH-UNI-PDF").bytes();
        String uniStream = decompressPdfStreams(uniPdf);
        List<String> hexTokens = extractPdfHexCodeUnits(uniStream);
        assertFalse(hexTokens.isEmpty(), "应包含 UTF-16BE HEX 文本流");
        assertFalse(hexTokens.contains("FFFD"), "PDF 截断增补字符代理对绝不能产生 U+FFFD");
        assertFalse(hexTokens.contains("0000"), "PDF 文本渲染应过滤 ISO 控制字符 \\u0000");
        assertFalse(hexTokens.contains("0007"), "PDF 文本渲染应过滤 ISO 控制字符 \\u0007");
    }

    private static List<String> extractPdfHexCodeUnits(String stream) {
        List<String> units = new ArrayList<>();
        int idx = 0;
        while (true) {
            int s = stream.indexOf('<', idx);
            if (s < 0) break;
            int e = stream.indexOf('>', s + 1);
            if (e < 0) break;
            String hex = stream.substring(s + 1, e).trim();
            for (int i = 0; i + 4 <= hex.length(); i += 4) {
                units.add(hex.substring(i, i + 4));
            }
            idx = e + 1;
        }
        return units;
    }

    @Test
    void batchZipStreamsEntriesManifestSanitizesZipSlipAndEnforcesLimits() throws Exception {
        RemnantService svc = createServiceWithSchemes("batch-zip.json", 2);
        CamExportService camSvc = new CamExportService(svc, new ToolpathOptimizerService());
        SlittingExportService slitSvc = new SlittingExportService(svc);
        ProductionReportService rptSvc = new ProductionReportService(svc, new ProductionCostAndProcurementService(svc));
        BatchExportService batchSvc = new BatchExportService(svc, camSvc, slitSvc, rptSvc);

        // 1. 合法批量流式导出（混合 2D + 1D 方案）
        var prepared = batchSvc.prepareBatch(new BatchExportService.BatchExportRequest(
                List.of("SCH-2D-RPT", "SCH-1D-RPT"),
                List.of("dxf_lwpolyline", "slitting_csv", "ticket_pdf"),
                CamExportOptions.defaults()
        ));
        ByteArrayOutputStream zipOut = new ByteArrayOutputStream();
        batchSvc.streamZip(prepared, zipOut);

        Map<String, String> entries = new LinkedHashMap<>();
        try (ZipInputStream zis = new ZipInputStream(new ByteArrayInputStream(zipOut.toByteArray()), StandardCharsets.UTF_8)) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                assertFalse(entry.getName().contains(".."), "ZipEntry 不得含 .. : " + entry.getName());
                assertFalse(entry.getName().startsWith("/"), "ZipEntry 不得为绝对路径: " + entry.getName());
                entries.put(entry.getName(), new String(zis.readAllBytes(), StandardCharsets.UTF_8));
            }
        }
        assertTrue(entries.containsKey("manifest.json"));
        assertTrue(entries.containsKey("SCH-2D-RPT/SCH-2D-RPT-dxf_lwpolyline.dxf"));
        assertTrue(entries.containsKey("SCH-2D-RPT/WO-SCH-2D-RPT.pdf"));
        assertTrue(entries.containsKey("SCH-1D-RPT/SCH-1D-RPT-slitting.csv"));
        assertTrue(entries.get("manifest.json").contains("SKIPPED"));

        // 2. Zip Slip 清洗验证
        String safe = BatchExportService.sanitizeEntrySegment("../../etc/passwd\0");
        assertFalse(safe.contains(".."));
        assertFalse(safe.contains("/"));
        assertFalse(safe.contains("\\"));
        assertFalse(safe.contains("\0"));

        // 3. 超过 50 个方案拒绝 400
        List<String> fiftyOne = new ArrayList<>();
        for (int i = 0; i < 51; i++) fiftyOne.add("SCH-" + i);
        assertThrows(IllegalArgumentException.class, () -> batchSvc.prepareBatch(
                new BatchExportService.BatchExportRequest(fiftyOne, List.of("ticket_pdf"), null)));

        // 4. 不存在方案预检阶段直接抛 404
        assertThrows(ExportNotFoundException.class, () -> batchSvc.prepareBatch(
                new BatchExportService.BatchExportRequest(List.of("SCH-2D-RPT", "SCH-NONE"), List.of("ticket_pdf"), null)));
    }

    private static String decompressPdfStreams(byte[] pdfBytes) throws Exception {
        String raw = new String(pdfBytes, StandardCharsets.ISO_8859_1);
        StringBuilder out = new StringBuilder();
        int idx = 0;
        while (true) {
            int start = raw.indexOf("stream\n", idx);
            if (start < 0) break;
            start += "stream\n".length();
            int end = raw.indexOf("\nendstream", start);
            if (end < 0) break;
            byte[] slice = Arrays.copyOfRange(pdfBytes, start, end);
            try (InflaterInputStream iis = new InflaterInputStream(new ByteArrayInputStream(slice))) {
                out.append(new String(iis.readAllBytes(), StandardCharsets.UTF_8)).append('\n');
            }
            idx = end + "\nendstream".length();
        }
        return out.toString();
    }
}
