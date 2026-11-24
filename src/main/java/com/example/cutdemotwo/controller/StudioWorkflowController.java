package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.business.cutting.SchedulingStudioService;
import com.example.cutdemotwo.business.model.DemandTemplate;
import com.example.cutdemotwo.persistence.InventoryConflictException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Map;

/**
 * 统一排程工作台 REST 控制器：
 * 覆盖「需求模板库、多维待排需求池、排程结果确认/手调校验/绑卷/完工/作废、母卷切割区域空间图、MES 鉴权协同接口」。
 */
@RestController
@RequestMapping("/api")
public class StudioWorkflowController {
    private final SchedulingStudioService studioService;

    @Value("${cutdemo.mes.auth-required:false}")
    private boolean mesAuthRequired = false;

    @Value("${cutdemo.mes.token:}")
    private String mesToken = "";

    public StudioWorkflowController(SchedulingStudioService studioService) {
        this.studioService = studioService;
    }

    // 1. 需求模板库 (Demand Templates)
    @GetMapping("/v2/demand-templates")
    public List<DemandTemplate> listTemplates() {
        return studioService.listTemplates();
    }

    @PostMapping("/v2/demand-templates")
    public DemandTemplate saveTemplate(@RequestBody DemandTemplate template) {
        return studioService.saveTemplate(template);
    }

    @DeleteMapping("/v2/demand-templates/{id}")
    public Map<String, Object> deleteTemplate(@PathVariable String id) {
        return studioService.deleteTemplate(id);
    }

    // 2. 多维待排需求池 (Demand Pool)
    @GetMapping("/v2/demand-pool")
    public List<Map<String, Object>> listDemandPool(
            @RequestParam(required = false) Integer limit,
            @RequestParam(required = false) Integer offset
    ) {
        return FactoryDocumentController.slicePage(studioService.listDemandPool(), limit, offset);
    }

    @GetMapping("/v2/demand-pool/{id}")
    public Map<String, Object> getDemandFamily(@PathVariable String id) {
        return studioService.getDemandFamily(id);
    }

    @PostMapping("/v2/demand-pool")
    public Map<String, Object> saveOrMergeDemandFamily(@RequestBody SchedulingStudioService.SaveDemandFamilyCommand cmd) {
        return studioService.saveOrMergeDemandFamily(cmd);
    }

    // 3. 结果管理、无副作用手调校验与方案生命周期 (Scheduling Schemes)
    @GetMapping("/v2/schemes")
    public List<Map<String, Object>> listSchemes(
            @RequestParam(required = false) String state,
            @RequestParam(required = false) String taskId,
            @RequestParam(defaultValue = "false") boolean summary,
            @RequestParam(required = false) Integer limit,
            @RequestParam(required = false) Integer offset
    ) {
        return FactoryDocumentController.slicePage(studioService.listSchemes(state, taskId, summary), limit, offset);
    }

    @GetMapping("/v2/schemes/{id}")
    public Map<String, Object> getSchemeDetail(@PathVariable String id) {
        return studioService.getSchemeDetail(id);
    }

    /** 纯计算只读手调几何校验与刀路/余料重建端点（绝不写库存）。 */
    @PostMapping("/v2/schemes/validate-layout")
    public Map<String, Object> validateLayout(@RequestBody SchedulingStudioService.ValidateLayoutRequest req) {
        return studioService.validateManualLayout(req);
    }

    @PostMapping("/v2/schemes/confirm")
    public Map<String, Object> confirmScheme(@RequestBody SchedulingStudioService.ConfirmSchemeCommand cmd) {
        return studioService.confirmScheme(cmd);
    }

    @PostMapping("/v2/schemes/{id}/bind-roll")
    public Map<String, Object> bindRollToScheme(
            @PathVariable String id,
            @RequestBody(required = false) SchedulingStudioService.BindRollCommand cmd
    ) {
        return studioService.bindRollToScheme(id, cmd);
    }

    @PostMapping("/v2/schemes/{id}/complete")
    public Map<String, Object> completeScheme(
            @PathVariable String id,
            @RequestBody(required = false) SchedulingStudioService.CompleteSchemeCommand cmd
    ) {
        SchedulingStudioService.CompleteSchemeCommand effective = cmd == null ? null : new SchedulingStudioService.CompleteSchemeCommand(
                cmd.actualCutLenMm(),
                cmd.rejectedPieceIds(),
                cmd.recoverRemnants(),
                cmd.remnantLocation(),
                FactoryDocumentController.resolveActor(cmd.operator())
        );
        return studioService.completeScheme(id, effective);
    }

    @PostMapping("/v2/schemes/{id}/cancel")
    public Map<String, Object> cancelScheme(
            @PathVariable String id,
            @RequestBody(required = false) Map<String, String> body
    ) {
        return studioService.cancelScheme(id, body != null ? body.get("reason") : null);
    }

    /** 基于源方案报工/复检判废或未满足缺口一键创建同缸加急补片任务。 */
    @PostMapping("/v2/schemes/{id}/replenish-task")
    public Map<String, Object> replenishTaskFromScheme(
            @PathVariable String id,
            @RequestHeader(value = "Idempotency-Key", required = false) String headerKey,
            @RequestBody SchedulingStudioService.ReplenishTaskCommand body
    ) {
        var cmd = body == null ? null : new SchedulingStudioService.ReplenishTaskCommand(
                FactoryDocumentController.resolveIdempotencyKey(body.idempotencyKey(), headerKey),
                FactoryDocumentController.resolveActor(body.operator()),
                body.reason()
        );
        return studioService.createReplenishTaskFromScheme(id, cmd);
    }

    // 4. 母卷全长切割/预占/疵点空间图 (Mother Roll Spatial Map)
    @GetMapping("/rolls/{rollId}/spatial-map")
    public Map<String, Object> getMotherRollSpatialMap(@PathVariable String rollId) {
        return studioService.getMotherRollSpatialMap(rollId);
    }

    // 5. MES 协同接口 (Orders / Dispatch / Feedback) —— 受 Bearer Token 鉴权保护
    @PostMapping("/v2/mes/orders")
    public Map<String, Object> syncMesOrder(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @RequestBody SchedulingStudioService.MesOrderSyncCommand cmd
    ) {
        verifyMesAuth(authorization);
        return studioService.syncMesOrder(cmd);
    }

    @PostMapping("/v2/mes/schemes/{id}/dispatch")
    public Map<String, Object> dispatchSchemeToMes(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @PathVariable String id,
            @RequestBody(required = false) Map<String, String> body
    ) {
        verifyMesAuth(authorization);
        return studioService.dispatchSchemeToMes(id, body != null ? body.get("mesWorkOrderNo") : null);
    }

    @GetMapping("/v2/mes/dispatch-packages/{id}")
    public Map<String, Object> getMesDispatchPackage(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @PathVariable String id
    ) {
        verifyMesAuth(authorization);
        return studioService.getMesDispatchPackage(id);
    }

    @PostMapping("/v2/mes/execution-feedback")
    public Map<String, Object> receiveMesFeedback(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @RequestBody SchedulingStudioService.MesFeedbackCommand cmd
    ) {
        verifyMesAuth(authorization);
        return studioService.receiveMesFeedback(cmd);
    }

    private void verifyMesAuth(String authorization) {
        String expected = mesToken == null ? "" : mesToken.trim();
        boolean enforced = mesAuthRequired || !expected.isEmpty();
        if (!enforced) return;
        if (expected.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "MES 接口鉴权已开启，但服务端未配置 cutdemo.mes.token");
        }
        if (authorization == null || authorization.length() <= 7
                || !authorization.regionMatches(true, 0, "Bearer ", 0, 7)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "MES 接口需要有效的 Authorization: Bearer <token>");
        }
        String supplied = authorization.substring(7).trim();
        boolean match = MessageDigest.isEqual(
                expected.getBytes(StandardCharsets.UTF_8),
                supplied.getBytes(StandardCharsets.UTF_8)
        );
        if (!match) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "MES 访问令牌无效");
        }
    }

    @ExceptionHandler(IllegalArgumentException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Map<String, String> handleInvalid(IllegalArgumentException err) {
        return Map.of("message", err.getMessage());
    }

    @ExceptionHandler(InventoryConflictException.class)
    @ResponseStatus(HttpStatus.CONFLICT)
    public Map<String, String> handleConflict(InventoryConflictException err) {
        return Map.of("message", err.getMessage());
    }
}
