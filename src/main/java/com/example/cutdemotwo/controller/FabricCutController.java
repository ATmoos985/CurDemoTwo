package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.algorithm.api.ISlittingSolverEngine;
import com.example.cutdemotwo.business.model.QualityDisposition;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class FabricCutController {
    private final tools.jackson.databind.json.JsonMapper reportJson = tools.jackson.databind.json.JsonMapper.builder()
            .enable(tools.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .disable(tools.jackson.databind.DeserializationFeature.ACCEPT_FLOAT_AS_INT,
                    tools.jackson.databind.DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES).build();

    private final tools.jackson.databind.json.JsonMapper qualityJson = tools.jackson.databind.json.JsonMapper.builder()
            .enable(tools.jackson.databind.DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES,
                    tools.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS,
                    tools.jackson.databind.DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES,
                    tools.jackson.databind.DeserializationFeature.FAIL_ON_MISSING_CREATOR_PROPERTIES)
            .disable(tools.jackson.databind.DeserializationFeature.ACCEPT_FLOAT_AS_INT)
            .disable(tools.jackson.databind.MapperFeature.ALLOW_COERCION_OF_SCALARS).build();

    private final com.example.cutdemotwo.algorithm.api.NestingSolver solverFactory;
    private final com.example.cutdemotwo.business.cutting.RemnantService remnantService;
    private final com.example.cutdemotwo.business.cutting.CuttingWorkflowService workflowService;
    private final List<ISlittingSolverEngine> slittingEngines;

    @Value("${cutdemo.demo.endpoints-enabled:true}")
    private boolean demoEndpointsEnabled = true;

    public FabricCutController(com.example.cutdemotwo.algorithm.api.NestingSolver solverFactory,
                               com.example.cutdemotwo.business.cutting.RemnantService remnantService,
                               com.example.cutdemotwo.business.cutting.CuttingWorkflowService workflowService) {
        this(solverFactory, remnantService, workflowService, List.of());
    }

    @Autowired
    public FabricCutController(com.example.cutdemotwo.algorithm.api.NestingSolver solverFactory,
                               com.example.cutdemotwo.business.cutting.RemnantService remnantService,
                               com.example.cutdemotwo.business.cutting.CuttingWorkflowService workflowService,
                               @Autowired(required = false) List<ISlittingSolverEngine> slittingEngines) {
        this.solverFactory = solverFactory;
        this.remnantService = remnantService;
        this.workflowService = workflowService;
        this.slittingEngines = slittingEngines == null ? List.of() : List.copyOf(slittingEngines);
    }

    @GetMapping("/v2/cutting/tasks/{id}")
    public Map<String, Object> task(@PathVariable String id) { return remnantService.taskDetail(id); }

    @PostMapping("/v2/cutting/tasks")
    public com.example.cutdemotwo.business.model.CuttingTask saveTask(@RequestBody com.example.cutdemotwo.business.model.CuttingTask task) {
        return remnantService.saveTask(task);
    }

    @GetMapping("/v2/cutting/tasks/{id}/plans")
    public java.util.List<com.example.cutdemotwo.business.model.CuttingPlan> taskPlans(
            @PathVariable String id,
            @RequestParam(defaultValue = "false") boolean summary) {
        return remnantService.taskPlans(id, summary);
    }

    @ExceptionHandler(com.example.cutdemotwo.persistence.InventoryConflictException.class)
    @ResponseStatus(HttpStatus.CONFLICT)
    public Map<String, String> conflict(RuntimeException error) { return Map.of("message", error.getMessage()); }

    @PostMapping(value = "/v2/cutting/report-confirm", consumes = "application/json")
    public Map<String, Object> confirmCut(@RequestBody String body) {
        com.example.cutdemotwo.business.model.CutReport report;
        try { report = reportJson.readValue(body, com.example.cutdemotwo.business.model.CutReport.class); }
        catch (RuntimeException invalid) { throw new IllegalArgumentException("报工格式无效：裁片编号和件数必须为整数，请核对输入"); }
        return workflowService.confirm(report);
    }

    @GetMapping("/v2/cutting/reports/{id}/quality-dispositions")
    public Map<String, Object> qualityReview(@PathVariable String id) { return remnantService.qualityReview(id); }

    @PostMapping(value = "/v2/cutting/reports/{id}/quality-dispositions", consumes = "application/json")
    public QualityDisposition disposeQuality(@PathVariable String id, @RequestBody String body) {
        QualityDisposition.Command command;
        try { command = qualityJson.readValue(body, QualityDisposition.Command.class); }
        catch (RuntimeException invalid) { throw new IllegalArgumentException("复检格式无效：请核对完整字段、整数编号及毫米数值；报废的 recovery 填 null"); }
        return remnantService.disposeQuality(id, command);
    }

    @PostMapping("/v2/cutting/reports/{reportId}/dispositions/{dispositionId}/revoke")
    public Map<String, Object> revokeQualityDisposition(
            @PathVariable String reportId,
            @PathVariable String dispositionId,
            @RequestHeader(value = "Idempotency-Key", required = false) String headerKey,
            @RequestBody com.example.cutdemotwo.business.cutting.RemnantService.RevokeDispositionCommand body) {
        var cmd = body == null ? null : new com.example.cutdemotwo.business.cutting.RemnantService.RevokeDispositionCommand(
                FactoryDocumentController.resolveIdempotencyKey(body.idempotencyKey(), headerKey),
                FactoryDocumentController.resolveActor(body.operator()),
                body.reason()
        );
        return remnantService.revokeQualityDisposition(reportId, dispositionId, cmd);
    }

    @PostMapping("/v2/cutting/reports/{id}/reverse")
    public Map<String, Object> reverseReport(@PathVariable String id, @RequestBody Map<String, String> body) {
        return remnantService.reverseReport(id, body.get("reason"));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Map<String, String> invalidInput(IllegalArgumentException error) {
        return Map.of("message", error.getMessage());
    }

    private void requireDemoEndpointsEnabled() {
        if (!demoEndpointsEnabled) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "当前环境已关闭演示初始化与母卷重置接口");
        }
    }

    @PostMapping("/v2/demo/inventory")
    public Map<String, Integer> initializeDemoInventory(@RequestBody Map<String, Boolean> body) {
        requireDemoEndpointsEnabled();
        if (body == null || !Boolean.TRUE.equals(body.get("confirmed"))) throw new IllegalArgumentException("请先确认创建示例材料");
        return remnantService.initializeDemoInventory();
    }

    @GetMapping("/v2/rolls")
    public java.util.List<com.example.cutdemotwo.business.model.MotherRollInfo> listRolls(
            @RequestParam(required = false) Integer limit,
            @RequestParam(required = false) Integer offset) {
        if (limit == null && offset == null) {
            return remnantService.getMotherRolls();
        }
        int off = offset == null ? 0 : offset;
        int lim = limit == null ? 50 : limit;
        if (off < 0 || lim < 1 || lim > 1000) {
            throw new IllegalArgumentException("分页参数无效：limit 需在 1–1000 之间，offset 不得为负");
        }
        return remnantService.getMotherRollsPage(lim, off);
    }

    @GetMapping("/v2/rolls/{rollId}")
    public com.example.cutdemotwo.business.model.MotherRollInfo getRollDetail(@PathVariable String rollId) {
        var roll = remnantService.getMotherRoll(rollId);
        if (roll == null) throw new org.springframework.web.server.ResponseStatusException(HttpStatus.NOT_FOUND, "母卷不存在");
        return roll;
    }

    @PostMapping("/v2/rolls")
    public com.example.cutdemotwo.business.model.MotherRollInfo saveRoll(@RequestBody com.example.cutdemotwo.business.model.MotherRollInfo roll) {
        return remnantService.saveOrUpdateMotherRoll(roll);
    }

    @PostMapping("/v2/rolls/{rollId}/inspection-defects")
    public com.example.cutdemotwo.business.model.MotherRollInfo saveInspection(@PathVariable String rollId,
            @RequestBody com.example.cutdemotwo.business.cutting.RemnantService.InspectionInput input) {
        return remnantService.saveInspection(rollId, input);
    }

    @PostMapping("/v2/rolls/{rollId}/defects/{defectId}/void")
    public com.example.cutdemotwo.business.model.MotherRollInfo voidDefect(@PathVariable String rollId, @PathVariable int defectId,
            @RequestBody Map<String, String> body) {
        return remnantService.voidDefect(rollId, defectId, body == null ? null : body.get("reason"));
    }

    @PostMapping("/v2/inspection/rolls")
    public com.example.cutdemotwo.business.model.MotherRollInfo createInspectionRoll(@RequestBody com.example.cutdemotwo.business.model.MotherRollInfo roll) {
        return remnantService.createInspectionRoll(roll);
    }

    @PostMapping("/v2/rolls/{rollId}/reset")
    public Map<String, Object> resetRoll(@PathVariable String rollId, @RequestBody(required = false) Map<String, Object> body) {
        requireDemoEndpointsEnabled();
        boolean ok = remnantService.resetRoll(rollId);
        Map<String, Object> res = new HashMap<>();
        res.put("success", ok);
        res.put("rollId", rollId);
        return res;
    }

    @PostMapping("/v2/remnants/{id}/scrap")
    public Map<String, Object> scrapRemnant(@PathVariable String id, @RequestBody(required = false) Map<String, String> body) {
        String reason = (body != null && body.containsKey("reason")) ? body.get("reason") : "现场破损报废";
        boolean ok = remnantService.scrapRemnant(id, reason);
        Map<String, Object> res = new HashMap<>();
        res.put("success", ok);
        res.put("id", id);
        return res;
    }

    @GetMapping("/v2/remnants")
    public java.util.List<com.example.cutdemotwo.business.model.RemnantStock> listRemnants(
            @RequestParam(required = false) String rollId,
            @RequestParam(defaultValue = "false") boolean includeQuarantined,
            @RequestParam(required = false) Integer limit,
            @RequestParam(required = false) Integer offset) {
        java.util.List<com.example.cutdemotwo.business.model.RemnantStock> all;
        if (!includeQuarantined) {
            all = remnantService.getRemnantsByRollId(rollId);
        } else {
            all = remnantService.getActiveAndQuarantinedRemnants().stream()
                    .filter(r -> "AVAILABLE".equals(r.getStatus()) || "QUARANTINED".equals(r.getStatus()) || "LOST".equals(r.getStatus()))
                    .filter(r -> rollId == null || rollId.isBlank() || "ALL".equalsIgnoreCase(rollId) || rollId.trim().equalsIgnoreCase(r.getSourceRollId()))
                    .sorted(java.util.Comparator.comparing(com.example.cutdemotwo.business.model.RemnantStock::getId)).toList();
        }
        return FactoryDocumentController.slicePage(all, limit, offset);
    }

    @PostMapping("/v2/remnants/register")
    public com.example.cutdemotwo.business.model.RemnantStock registerRemnant(@RequestBody com.example.cutdemotwo.business.model.RemnantStock item) {
        return remnantService.registerRemnant(item);
    }

    @GetMapping({"/health", "/v2/health"})
    public ResponseEntity<Map<String, Object>> health() {
        Map<String, Object> map = new HashMap<>();
        Map<String, Object> storage = remnantService.healthStatus();
        boolean storageHealthy = Boolean.TRUE.equals(storage.get("storageHealthy"));
        var capabilities = solverFactory != null ? solverFactory.capabilities() : List.<com.example.cutdemotwo.contracts.nesting.EngineCapabilities>of();
        boolean any2DAvailable = capabilities.stream().anyMatch(com.example.cutdemotwo.contracts.nesting.EngineCapabilities::available);
        boolean slittingAvailable = slittingEngines.stream().anyMatch(ISlittingSolverEngine::isAvailable);

        map.put("packingsolverAvailable", capabilities.stream().anyMatch(e -> "packingsolver".equals(e.id()) && e.available()));
        // Null unless the native engine is missing and a registered stand-in will run (and be labelled) instead.
        map.put("packingsolverFallback", solverFactory != null ? solverFactory.fallbackFor("packingsolver") : null);
        map.put("packingsolverIrregularAvailable", capabilities.stream().anyMatch(e -> "packingsolver-irregular".equals(e.id()) && e.available()));
        map.put("packingsolverIrregularFallback", solverFactory != null ? solverFactory.fallbackFor("packingsolver-irregular") : null);
        map.put("slittingAvailable", slittingAvailable);
        map.put("storageStatus", storageHealthy ? "UP" : "DOWN");
        if (!storageHealthy && storage.get("storageError") != null) {
            map.put("storageError", storage.get("storageError"));
        }
        map.put("revision", storage.get("revision"));
        map.put("remnantsInStock", storage.get("remnantsInStock"));

        if (!storageHealthy) {
            map.put("status", "DOWN");
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(map);
        }
        if (solverFactory != null && !any2DAvailable) {
            map.put("status", "DEGRADED");
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(map);
        }
        map.put("status", "UP");
        return ResponseEntity.ok(map);
    }
}
