package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.business.cutting.BatchImportValidationException;
import com.example.cutdemotwo.business.cutting.InventoryImportService;
import com.example.cutdemotwo.business.cutting.InventoryImportService.BatchImportRequest;
import com.example.cutdemotwo.business.cutting.InventoryImportService.BatchImportResult;
import com.example.cutdemotwo.business.cutting.InventoryImportService.DefectRowInput;
import com.example.cutdemotwo.business.cutting.InventoryImportService.RemnantRowInput;
import com.example.cutdemotwo.business.cutting.InventoryImportService.RollRowInput;
import com.example.cutdemotwo.config.TraceIdFilter;
import org.slf4j.MDC;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

/**
 * 原子批量库存导入控制器：
 * 提供母卷、料头与瑕疵的只读预检（preview）与单事务原子提交（commit）端点。
 */
@RestController
@RequestMapping("/api/v2/inventory/import")
public class InventoryImportController {
    private final InventoryImportService importService;

    public InventoryImportController(InventoryImportService importService) {
        this.importService = importService;
    }

    public record ValidationErrorResponse(
            String code,
            String message,
            List<BatchImportValidationException.RowError> errors,
            String traceId,
            boolean retryable
    ) {}

    @PostMapping("/rolls/preview")
    public BatchImportResult previewRolls(@RequestBody BatchImportRequest<RollRowInput> body) {
        String actor = FactoryDocumentController.resolveActor(body == null ? null : body.operator());
        return importService.previewRolls(body, actor);
    }

    @PostMapping("/rolls")
    public BatchImportResult commitRolls(
            @RequestHeader(value = "Idempotency-Key", required = false) String headerKey,
            @RequestBody BatchImportRequest<RollRowInput> body
    ) {
        String key = FactoryDocumentController.resolveIdempotencyKey(body == null ? null : body.idempotencyKey(), headerKey);
        String actor = FactoryDocumentController.resolveActor(body == null ? null : body.operator());
        return importService.commitRolls(body, key, actor);
    }

    @PostMapping("/remnants/preview")
    public BatchImportResult previewRemnants(@RequestBody BatchImportRequest<RemnantRowInput> body) {
        String actor = FactoryDocumentController.resolveActor(body == null ? null : body.operator());
        return importService.previewRemnants(body, actor);
    }

    @PostMapping("/remnants")
    public BatchImportResult commitRemnants(
            @RequestHeader(value = "Idempotency-Key", required = false) String headerKey,
            @RequestBody BatchImportRequest<RemnantRowInput> body
    ) {
        String key = FactoryDocumentController.resolveIdempotencyKey(body == null ? null : body.idempotencyKey(), headerKey);
        String actor = FactoryDocumentController.resolveActor(body == null ? null : body.operator());
        return importService.commitRemnants(body, key, actor);
    }

    @PostMapping("/defects/preview")
    public BatchImportResult previewDefects(@RequestBody BatchImportRequest<DefectRowInput> body) {
        String actor = FactoryDocumentController.resolveActor(body == null ? null : body.operator());
        return importService.previewDefects(body, actor);
    }

    @PostMapping("/defects")
    public BatchImportResult commitDefects(
            @RequestHeader(value = "Idempotency-Key", required = false) String headerKey,
            @RequestBody BatchImportRequest<DefectRowInput> body
    ) {
        String key = FactoryDocumentController.resolveIdempotencyKey(body == null ? null : body.idempotencyKey(), headerKey);
        String actor = FactoryDocumentController.resolveActor(body == null ? null : body.operator());
        return importService.commitDefects(body, key, actor);
    }

    @ExceptionHandler(BatchImportValidationException.class)
    public ResponseEntity<ValidationErrorResponse> handleBatchValidation(BatchImportValidationException ex) {
        String traceId = MDC.get(TraceIdFilter.MDC_KEY);
        if (traceId == null || traceId.isBlank()) {
            traceId = UUID.randomUUID().toString().replace("-", "");
        }
        return ResponseEntity.badRequest().body(new ValidationErrorResponse(
                "BATCH_IMPORT_VALIDATION_FAILED",
                ex.getMessage(),
                ex.getErrors(),
                traceId,
                false
        ));
    }
}
