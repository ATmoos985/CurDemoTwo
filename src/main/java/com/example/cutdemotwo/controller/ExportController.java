package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.business.exports.BatchExportService;
import com.example.cutdemotwo.business.exports.BatchExportService.BatchExportRequest;
import com.example.cutdemotwo.business.exports.BatchExportService.PreparedBatch;
import com.example.cutdemotwo.business.exports.CamExportOptions;
import com.example.cutdemotwo.business.exports.CamExportService;
import com.example.cutdemotwo.business.exports.ExportNotFoundException;
import com.example.cutdemotwo.business.exports.ProductionReportService;
import com.example.cutdemotwo.business.exports.SlittingExportService;
import com.example.cutdemotwo.config.TraceIdFilter;
import com.example.cutdemotwo.controller.GlobalApiExceptionHandler.ApiError;
import org.slf4j.MDC;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

/**
 * 服务端生产级导出引擎 REST 控制器：
 * <ul>
 *   <li>{@code GET /api/v2/exports/schemes/{schemeId}/cam}：DXF(R12/LWPOLYLINE/AAMA)、HPGL(.plt)、CNC G-Code(.nc)；</li>
 *   <li>{@code GET /api/v2/exports/schemes/{schemeId}/slitting}：1D 分切配方（json/csv/xlsx）；</li>
 *   <li>{@code GET /api/v2/exports/schemes/{schemeId}/ticket.pdf}：A4 随工单 PDF；</li>
 *   <li>{@code GET /api/v2/exports/production-summary}：多维生产汇总报表（pdf/xlsx）；</li>
 *   <li>{@code POST /api/v2/exports/batch-zip}：多方案流式 ZIP 打包导出（带 manifest.json 与防 Zip Slip）。</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/v2/exports")
public class ExportController {
    private final CamExportService camExportService;
    private final SlittingExportService slittingExportService;
    private final ProductionReportService productionReportService;
    private final BatchExportService batchExportService;

    public ExportController(
            CamExportService camExportService,
            SlittingExportService slittingExportService,
            ProductionReportService productionReportService,
            BatchExportService batchExportService
    ) {
        this.camExportService = camExportService;
        this.slittingExportService = slittingExportService;
        this.productionReportService = productionReportService;
        this.batchExportService = batchExportService;
    }

    @GetMapping("/schemes/{schemeId}/cam")
    public ResponseEntity<byte[]> exportCam(
            @PathVariable String schemeId,
            @RequestParam(defaultValue = "dxf_lwpolyline") String format,
            @RequestParam(defaultValue = "0") double overcutMm,
            @RequestParam(defaultValue = "0") double leadInMm,
            @RequestParam(defaultValue = "0") double microJointWidthMm,
            @RequestParam(defaultValue = "false") boolean deduplicateCommonEdges,
            @RequestParam(defaultValue = "T01") String cutTool,
            @RequestParam(defaultValue = "T02") String punchTool,
            @RequestParam(defaultValue = "T03") String creaseTool
    ) {
        CamExportOptions options = new CamExportOptions(
                overcutMm, leadInMm, microJointWidthMm, deduplicateCommonEdges,
                cutTool, punchTool, creaseTool
        );
        var payload = camExportService.exportCam(schemeId, format, options);
        return downloadResponse(payload.fileName(), payload.contentType(), payload.bytes());
    }

    @GetMapping("/schemes/{schemeId}/slitting")
    public ResponseEntity<byte[]> exportSlitting(
            @PathVariable String schemeId,
            @RequestParam(defaultValue = "json") String format
    ) {
        var payload = slittingExportService.exportSlitting(schemeId, format);
        return downloadResponse(payload.fileName(), payload.contentType(), payload.bytes());
    }

    @GetMapping("/schemes/{schemeId}/ticket.pdf")
    public ResponseEntity<byte[]> exportTicketPdf(@PathVariable String schemeId) {
        var payload = productionReportService.exportTicketPdf(schemeId);
        return downloadResponse(payload.fileName(), payload.contentType(), payload.bytes());
    }

    @GetMapping("/production-summary")
    public ResponseEntity<byte[]> exportProductionSummary(
            @RequestParam(defaultValue = "xlsx") String format,
            @RequestParam(required = false) String taskId,
            @RequestParam(required = false) String state,
            @RequestParam(required = false) String from,
            @RequestParam(required = false) String to
    ) {
        var payload = productionReportService.exportProductionSummary(format, taskId, state, from, to);
        return downloadResponse(payload.fileName(), payload.contentType(), payload.bytes());
    }

    @PostMapping("/batch-zip")
    public ResponseEntity<StreamingResponseBody> exportBatchZip(@RequestBody BatchExportRequest request) {
        PreparedBatch prepared = batchExportService.prepareBatch(request);
        StreamingResponseBody body = outputStream -> batchExportService.streamZip(prepared, outputStream);
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.parseMediaType("application/zip"));
        headers.setContentDisposition(ContentDisposition.attachment()
                .filename("cutplan-batch-export.zip", StandardCharsets.UTF_8)
                .build());
        return new ResponseEntity<>(body, headers, HttpStatus.OK);
    }

    @ExceptionHandler(ExportNotFoundException.class)
    public ResponseEntity<ApiError> handleNotFound(ExportNotFoundException ex) {
        String traceId = MDC.get(TraceIdFilter.MDC_KEY);
        if (traceId == null || traceId.isBlank()) {
            traceId = UUID.randomUUID().toString().replace("-", "");
        }
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(new ApiError("NOT_FOUND", ex.getMessage(), traceId, false));
    }

    private static ResponseEntity<byte[]> downloadResponse(String fileName, String contentType, byte[] bytes) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.parseMediaType(contentType));
        headers.setContentDisposition(ContentDisposition.attachment()
                .filename(fileName, StandardCharsets.UTF_8)
                .build());
        headers.setContentLength(bytes.length);
        return new ResponseEntity<>(bytes, headers, HttpStatus.OK);
    }
}
