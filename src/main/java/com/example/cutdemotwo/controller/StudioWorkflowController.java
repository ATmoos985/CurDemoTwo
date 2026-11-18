package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.business.cutting.SchedulingStudioService;
import com.example.cutdemotwo.business.model.DemandTemplate;
import com.example.cutdemotwo.persistence.InventoryConflictException;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 统一排程工作台 REST 控制器：
 * 覆盖「需求模板库、多维待排需求池、排程结果确认/绑卷/完工/作废、母卷切割区域空间图、MES 协同接口」。
 */
@RestController
@RequestMapping("/api")
public class StudioWorkflowController {
    private final SchedulingStudioService studioService;

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
    public List<Map<String, Object>> listDemandPool() {
        return studioService.listDemandPool();
    }

    @GetMapping("/v2/demand-pool/{id}")
    public Map<String, Object> getDemandFamily(@PathVariable String id) {
        return studioService.getDemandFamily(id);
    }

    @PostMapping("/v2/demand-pool")
    public Map<String, Object> saveOrMergeDemandFamily(@RequestBody SchedulingStudioService.SaveDemandFamilyCommand cmd) {
        return studioService.saveOrMergeDemandFamily(cmd);
    }

    // 3. 结果管理与方案生命周期 (Scheduling Schemes)
    @GetMapping("/v2/schemes")
    public List<Map<String, Object>> listSchemes(
            @RequestParam(required = false) String state,
            @RequestParam(required = false) String taskId
    ) {
        return studioService.listSchemes(state, taskId);
    }

    @GetMapping("/v2/schemes/{id}")
    public Map<String, Object> getSchemeDetail(@PathVariable String id) {
        return studioService.getSchemeDetail(id);
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
        return studioService.completeScheme(id, cmd);
    }

    @PostMapping("/v2/schemes/{id}/cancel")
    public Map<String, Object> cancelScheme(
            @PathVariable String id,
            @RequestBody(required = false) Map<String, String> body
    ) {
        return studioService.cancelScheme(id, body != null ? body.get("reason") : null);
    }

    // 4. 母卷全长切割/预占/疵点空间图 (Mother Roll Spatial Map)
    @GetMapping("/rolls/{rollId}/spatial-map")
    public Map<String, Object> getMotherRollSpatialMap(@PathVariable String rollId) {
        return studioService.getMotherRollSpatialMap(rollId);
    }

    // 5. MES 协同接口 (Orders / Dispatch / Feedback)
    @PostMapping("/v2/mes/orders")
    public Map<String, Object> syncMesOrder(@RequestBody SchedulingStudioService.MesOrderSyncCommand cmd) {
        return studioService.syncMesOrder(cmd);
    }

    @PostMapping("/v2/mes/schemes/{id}/dispatch")
    public Map<String, Object> dispatchSchemeToMes(
            @PathVariable String id,
            @RequestBody(required = false) Map<String, String> body
    ) {
        return studioService.dispatchSchemeToMes(id, body != null ? body.get("mesWorkOrderNo") : null);
    }

    @GetMapping("/v2/mes/dispatch-packages/{id}")
    public Map<String, Object> getMesDispatchPackage(@PathVariable String id) {
        return studioService.getMesDispatchPackage(id);
    }

    @PostMapping("/v2/mes/execution-feedback")
    public Map<String, Object> receiveMesFeedback(@RequestBody SchedulingStudioService.MesFeedbackCommand cmd) {
        return studioService.receiveMesFeedback(cmd);
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
