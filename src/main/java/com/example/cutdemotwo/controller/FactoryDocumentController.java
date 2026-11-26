package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.model.InventoryReceiptDocument;
import com.example.cutdemotwo.business.model.MaterialIssueDocument;
import com.example.cutdemotwo.business.model.QualityReleaseDocument;
import com.example.cutdemotwo.config.AuthContext;
import com.example.cutdemotwo.persistence.InventoryConflictException;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 工厂生产闭环仓储单据与聚合对账控制器：
 * 覆盖「隔离料头质量放行、采购批量入库单、车间领/退料单、母卷级报废单、聚合报工分页对账（消 N+1）」。
 */
@RestController
@RequestMapping("/api")
public class FactoryDocumentController {
    private final RemnantService inventory;

    public FactoryDocumentController(RemnantService inventory) {
        this.inventory = inventory;
    }

    // 1. 隔离料头质量复验放行 / 历史放行单
    @GetMapping("/v2/quality/releases")
    public List<QualityReleaseDocument> listQualityReleases(
            @RequestParam(required = false) Integer limit,
            @RequestParam(required = false) Integer offset
    ) {
        return slicePage(inventory.listQualityReleases(), limit, offset);
    }

    @PostMapping("/v2/quality/remnants/{id}/release")
    public Map<String, Object> releaseRemnant(
            @PathVariable String id,
            @RequestHeader(value = "Idempotency-Key", required = false) String headerKey,
            @RequestBody RemnantService.QualityReleaseCommand body
    ) {
        RemnantService.QualityReleaseCommand cmd = body == null ? null : new RemnantService.QualityReleaseCommand(
                resolveIdempotencyKey(body.idempotencyKey(), headerKey),
                body.decision(),
                resolveActor(body.inspector()),
                body.reason()
        );
        return inventory.releaseQuarantinedRemnant(id, cmd);
    }

    // 1.1 母卷跑布验疵后质检放行 / 判定不合格（RBAC 归属 ADMIN / INSPECTOR）
    @PostMapping("/v2/quality/rolls/{rollId}/inspect-complete")
    public Map<String, Object> completeMotherRollInspection(
            @PathVariable String rollId,
            @RequestBody RemnantService.MotherRollInspectionCommand body
    ) {
        RemnantService.MotherRollInspectionCommand cmd = body == null ? null : new RemnantService.MotherRollInspectionCommand(
                body.status(),
                resolveActor(body.inspector()),
                body.remarks()
        );
        return inventory.completeMotherRollInspection(rollId, cmd);
    }

    // 2. 采购批量入库单
    @GetMapping("/v2/inventory-receipts")
    public List<InventoryReceiptDocument> listInventoryReceipts(
            @RequestParam(required = false) Integer limit,
            @RequestParam(required = false) Integer offset
    ) {
        return slicePage(inventory.listInventoryReceipts(), limit, offset);
    }

    @PostMapping("/v2/inventory-receipts")
    public Map<String, Object> createInventoryReceipt(
            @RequestHeader(value = "Idempotency-Key", required = false) String headerKey,
            @RequestBody RemnantService.InventoryReceiptCommand body
    ) {
        RemnantService.InventoryReceiptCommand cmd = body == null ? null : new RemnantService.InventoryReceiptCommand(
                resolveIdempotencyKey(body.idempotencyKey(), headerKey),
                body.supplierName(),
                body.deliveryNoteNo(),
                resolveActor(body.operator()),
                body.remarks(),
                body.inspector(),
                body.rolls()
        );
        return inventory.receiveInventoryBatch(cmd);
    }

    // 3. 车间领料 / 退料单
    @GetMapping("/v2/material-issues")
    public List<MaterialIssueDocument> listMaterialIssues(
            @RequestParam(required = false) Integer limit,
            @RequestParam(required = false) Integer offset
    ) {
        return slicePage(inventory.listMaterialIssues(), limit, offset);
    }

    @PostMapping("/v2/material-issues")
    public Map<String, Object> createMaterialIssue(
            @RequestHeader(value = "Idempotency-Key", required = false) String headerKey,
            @RequestBody RemnantService.MaterialIssueCommand body
    ) {
        RemnantService.MaterialIssueCommand cmd = body == null ? null : new RemnantService.MaterialIssueCommand(
                resolveIdempotencyKey(body.idempotencyKey(), headerKey),
                body.direction(),
                body.rollId(),
                body.machineId(),
                body.shiftTeam(),
                resolveActor(body.operator()),
                body.targetLocation(),
                body.reason()
        );
        return inventory.postMaterialIssue(cmd);
    }

    // 4. 母卷级报废单
    @PostMapping("/v2/rolls/{rollId}/scrap")
    public Map<String, Object> scrapMotherRoll(
            @PathVariable String rollId,
            @RequestHeader(value = "Idempotency-Key", required = false) String headerKey,
            @RequestBody RemnantService.ScrapRollCommand body
    ) {
        RemnantService.ScrapRollCommand cmd = body == null ? null : new RemnantService.ScrapRollCommand(
                resolveIdempotencyKey(body.idempotencyKey(), headerKey),
                resolveActor(body.operator()),
                body.reason()
        );
        return inventory.scrapMotherRoll(rollId, cmd);
    }

    // 5. 聚合报工分页查询（消除前端 N+1 请求风暴）
    @GetMapping("/v2/reconciliation/reports")
    public Map<String, Object> listReconciliationReports(
            @RequestParam(defaultValue = "50") int limit,
            @RequestParam(defaultValue = "0") int offset,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String taskId
    ) {
        return inventory.reconciliationReports(limit, offset, status, taskId);
    }

    static String resolveIdempotencyKey(String bodyKey, String headerKey) {
        if (bodyKey != null && !bodyKey.isBlank()) return bodyKey.trim();
        return (headerKey == null || headerKey.isBlank()) ? null : headerKey.trim();
    }

    /** 认证开启且请求未显式指定操作人时，自动透传当前登录主体用户名，不干扰免登本地模式。 */
    static String resolveActor(String declared) {
        if (declared != null && !declared.isBlank()) return declared.trim();
        AuthContext.Principal principal = AuthContext.current();
        if (principal != null && principal.authenticated() && principal.username() != null && !principal.username().isBlank()) {
            return principal.username();
        }
        return declared;
    }

    static <T> List<T> slicePage(List<T> items, Integer limit, Integer offset) {
        if (limit == null && offset == null) return items;
        int off = offset == null ? 0 : offset;
        int lim = limit == null ? 50 : limit;
        if (off < 0 || lim < 1 || lim > 1000) {
            throw new IllegalArgumentException("分页参数无效：limit 需在 1–1000 之间，offset 不得为负");
        }
        int from = Math.min(off, items.size());
        int to = Math.min(from + lim, items.size());
        return List.copyOf(items.subList(from, to));
    }

    @ExceptionHandler(InventoryConflictException.class)
    public ResponseEntity<Map<String, String>> conflict(InventoryConflictException error) {
        return ResponseEntity.status(409).body(Map.of("code", "INVENTORY_CONFLICT", "message", error.getMessage()));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, String>> invalid(IllegalArgumentException error) {
        return ResponseEntity.badRequest().body(Map.of("code", "INVALID_INPUT", "message", error.getMessage()));
    }
}
