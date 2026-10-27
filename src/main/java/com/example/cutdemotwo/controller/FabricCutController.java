package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.business.model.QualityDisposition;
import com.example.cutdemotwo.business.model.SolveResponse;
import com.example.cutdemotwo.business.cutting.ScenarioOneService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.HttpStatus;

import java.util.HashMap;
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
    private final ScenarioOneService scenarioOneService;
    private final com.example.cutdemotwo.business.cutting.RemnantService remnantService;
    private final com.example.cutdemotwo.algorithm.api.ToolpathOptimizer toolpathOptimizerService;
    private final com.example.cutdemotwo.business.cutting.CuttingWorkflowService workflowService;

    @Autowired
    public FabricCutController(com.example.cutdemotwo.algorithm.api.NestingSolver solverFactory,
                                ScenarioOneService scenarioOneService,
                                com.example.cutdemotwo.business.cutting.RemnantService remnantService,
                                com.example.cutdemotwo.algorithm.api.ToolpathOptimizer toolpathOptimizerService,
                                com.example.cutdemotwo.business.cutting.CuttingWorkflowService workflowService) {
        this.solverFactory = solverFactory;
        this.scenarioOneService = scenarioOneService;
        this.remnantService = remnantService;
        this.toolpathOptimizerService = toolpathOptimizerService;
        this.workflowService = workflowService;
    }

    @GetMapping("/cutting/tasks")
    public java.util.List<com.example.cutdemotwo.business.model.CuttingTask> tasks() { return remnantService.listTasks(); }

    @GetMapping("/cutting/task-summaries")
    public java.util.List<Map<String, Object>> taskSummaries() { return remnantService.taskSummaries(); }

    @GetMapping("/cutting/tasks/{id}")
    public Map<String, Object> task(@PathVariable String id) { return remnantService.taskDetail(id); }

    @PostMapping("/cutting/tasks")
    public com.example.cutdemotwo.business.model.CuttingTask saveTask(@RequestBody com.example.cutdemotwo.business.model.CuttingTask task) {
        return remnantService.saveTask(task);
    }

    @PostMapping("/cutting/material-candidates")
    public java.util.List<Map<String, Object>> candidates(@RequestBody SolveRequest request) { return remnantService.materialCandidates(request); }

    @GetMapping("/cutting/plans/{id}")
    public Map<String, Object> plan(@PathVariable String id) { return workflowService.getPlan(id); }

    @GetMapping("/cutting/tasks/{id}/plans")
    public java.util.List<com.example.cutdemotwo.business.model.CuttingPlan> taskPlans(@PathVariable String id) { return remnantService.taskPlans(id); }

    @PostMapping("/cutting/plans/{id}/cancel")
    public Object cancelPlan(@PathVariable String id) { return remnantService.changePlanStatus(id, false); }

    @PostMapping("/cutting/plans/{id}/restore")
    public Object restorePlan(@PathVariable String id) { return remnantService.changePlanStatus(id, true); }

    @PostMapping("/cutting/plans/{id}/adjust")
    public Object adjustPlan(@PathVariable String id, @RequestBody com.example.cutdemotwo.business.model.PlanAdjustment adjustment) {
        return workflowService.adjust(id, adjustment);
    }

    @ExceptionHandler(com.example.cutdemotwo.persistence.InventoryConflictException.class)
    @ResponseStatus(HttpStatus.CONFLICT)
    public Map<String, String> conflict(RuntimeException error) { return Map.of("message", error.getMessage()); }

    @PostMapping("/solve")
    public SolveResponse solve(@RequestBody SolveRequest request) {
        return workflowService.solve(request);
    }

    @PostMapping(value = "/cutting/report-confirm", consumes = "application/json")
    public Map<String, Object> confirmCut(@RequestBody String body) {
        com.example.cutdemotwo.business.model.CutReport report;
        try { report = reportJson.readValue(body, com.example.cutdemotwo.business.model.CutReport.class); }
        catch (RuntimeException invalid) { throw new IllegalArgumentException("报工格式无效：裁片编号和件数必须为整数，请核对输入"); }
        return workflowService.confirm(report);
    }

    @GetMapping("/cutting/reports/{id}/quality-dispositions")
    public Map<String, Object> qualityReview(@PathVariable String id) { return remnantService.qualityReview(id); }

    @PostMapping(value = "/cutting/reports/{id}/quality-dispositions", consumes = "application/json")
    public QualityDisposition disposeQuality(@PathVariable String id, @RequestBody String body) {
        QualityDisposition.Command command;
        try { command = qualityJson.readValue(body, QualityDisposition.Command.class); }
        catch (RuntimeException invalid) { throw new IllegalArgumentException("复检格式无效：请核对完整字段、整数编号及毫米数值；报废的 recovery 填 null"); }
        return remnantService.disposeQuality(id, command);
    }

    @PostMapping("/cutting/reports/{id}/reverse")
    public Map<String, Object> reverseReport(@PathVariable String id, @RequestBody Map<String, String> body) {
        return remnantService.reverseReport(id, body.get("reason"));
    }

    @PostMapping(value = "/cutting/report-batch", consumes = "application/json")
    public Object reportBatch(@RequestBody String body, @RequestParam(defaultValue = "false") boolean preview) {
        com.example.cutdemotwo.business.model.CutReport[] reports;
        try { reports = reportJson.readValue(body, com.example.cutdemotwo.business.model.CutReport[].class); }
        catch (RuntimeException invalid) { throw new IllegalArgumentException("报工格式无效，请核对各工位的裁片结果和件数"); }
        return remnantService.reportBatch(reports == null ? null : java.util.Arrays.asList(reports), preview);
    }

    @ExceptionHandler(IllegalArgumentException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Map<String, String> invalidInput(IllegalArgumentException error) {
        return Map.of("message", error.getMessage());
    }

    @PostMapping("/toolpath/optimize")
    public com.example.cutdemotwo.contracts.geometry.ToolpathResult optimizeToolpath(@RequestBody com.example.cutdemotwo.business.model.ToolpathRequest req) {
        double hx = req.getHomeX();
        double hy = req.getHomeY();
        return toolpathOptimizerService.optimizeToolpath(req.getCuts(), hx, hy, req.isRespectPrecedence());
    }

    @GetMapping("/scenario/{id}")
    public SolveResponse getScenario(@PathVariable int id) {
        return scenarioOneService.getScenario(id);
    }

    @PostMapping("/demo/inventory")
    public Map<String, Integer> initializeDemoInventory(@RequestBody Map<String, Boolean> body) {
        if (!Boolean.TRUE.equals(body.get("confirmed"))) throw new IllegalArgumentException("请先确认创建示例材料");
        return remnantService.initializeDemoInventory();
    }

    @GetMapping("/rolls")
    public java.util.List<com.example.cutdemotwo.business.model.MotherRollInfo> listRolls() {
        return remnantService.getMotherRolls();
    }

    @GetMapping("/rolls/{rollId}")
    public com.example.cutdemotwo.business.model.MotherRollInfo getRollDetail(@PathVariable String rollId) {
        var roll = remnantService.getMotherRoll(rollId);
        if (roll == null) throw new org.springframework.web.server.ResponseStatusException(HttpStatus.NOT_FOUND, "母卷不存在");
        return roll;
    }

    @PostMapping("/rolls")
    public com.example.cutdemotwo.business.model.MotherRollInfo saveRoll(@RequestBody com.example.cutdemotwo.business.model.MotherRollInfo roll) {
        return remnantService.saveOrUpdateMotherRoll(roll);
    }

    @PostMapping("/rolls/{rollId}/defects")
    public com.example.cutdemotwo.contracts.geometry.Defect addDefect(@PathVariable String rollId, @RequestBody com.example.cutdemotwo.contracts.geometry.Defect defect) {
        return remnantService.addDefectToRoll(rollId, defect);
    }

    @PostMapping("/rolls/{rollId}/inspection-defects")
    public com.example.cutdemotwo.business.model.MotherRollInfo saveInspection(@PathVariable String rollId,
            @RequestBody com.example.cutdemotwo.business.cutting.RemnantService.InspectionInput input) {
        return remnantService.saveInspection(rollId, input);
    }

    @PostMapping("/rolls/{rollId}/defects/{defectId}/void")
    public com.example.cutdemotwo.business.model.MotherRollInfo voidDefect(@PathVariable String rollId, @PathVariable int defectId,
            @RequestBody Map<String, String> body) {
        return remnantService.voidDefect(rollId, defectId, body == null ? null : body.get("reason"));
    }

    @PostMapping("/inspection/rolls")
    public com.example.cutdemotwo.business.model.MotherRollInfo createInspectionRoll(@RequestBody com.example.cutdemotwo.business.model.MotherRollInfo roll) {
        return remnantService.createInspectionRoll(roll);
    }

    @PostMapping("/rolls/{rollId}/reset")
    public Map<String, Object> resetRoll(@PathVariable String rollId, @RequestBody(required = false) Map<String, Object> body) {
        boolean force = body != null && Boolean.TRUE.equals(body.get("force"));
        boolean ok = remnantService.resetRoll(rollId, force);
        Map<String, Object> res = new HashMap<>();
        res.put("success", ok);
        res.put("rollId", rollId);
        return res;
    }

    @PostMapping("/remnants/{id}/scrap")
    public Map<String, Object> scrapRemnant(@PathVariable String id, @RequestBody(required = false) Map<String, String> body) {
        String reason = (body != null && body.containsKey("reason")) ? body.get("reason") : "现场破损报废";
        boolean ok = remnantService.scrapRemnant(id, reason);
        Map<String, Object> res = new HashMap<>();
        res.put("success", ok);
        res.put("id", id);
        return res;
    }

    @GetMapping("/remnants")
    public java.util.List<com.example.cutdemotwo.business.model.RemnantStock> listRemnants(@RequestParam(required = false) String rollId,
            @RequestParam(defaultValue = "false") boolean includeQuarantined) {
        if (!includeQuarantined) return remnantService.getRemnantsByRollId(rollId);
        return remnantService.getAllRemnants().stream()
                .filter(r -> "AVAILABLE".equals(r.getStatus()) || "QUARANTINED".equals(r.getStatus()))
                .filter(r -> rollId == null || rollId.isBlank() || "ALL".equalsIgnoreCase(rollId) || rollId.trim().equalsIgnoreCase(r.getSourceRollId()))
                .sorted(java.util.Comparator.comparing(com.example.cutdemotwo.business.model.RemnantStock::getId)).toList();
    }

    @PostMapping("/remnants/scan")
    public com.example.cutdemotwo.business.model.RemnantStock scanRemnant(@RequestBody Map<String, String> body) {
        String id = body.get("id");
        return remnantService.scanOrGetById(id);
    }

    @PostMapping("/remnants/match")
    public java.util.List<com.example.cutdemotwo.business.model.RemnantStock> matchRemnants(@RequestBody Map<String, Object> body) {
        String rollId = body.containsKey("rollId") && body.get("rollId") != null ? body.get("rollId").toString() : null;
        double w = body.containsKey("w") ? Double.parseDouble(body.get("w").toString()) : 0;
        double l = body.containsKey("l") ? Double.parseDouble(body.get("l").toString()) : 0;
        boolean rot = body.containsKey("allowRotation") && Boolean.parseBoolean(body.get("allowRotation").toString());
        return remnantService.matchRemnants(rollId, w, l, rot);
    }

    @PostMapping("/remnants/register")
    public com.example.cutdemotwo.business.model.RemnantStock registerRemnant(@RequestBody com.example.cutdemotwo.business.model.RemnantStock item) {
        return remnantService.registerRemnant(item);
    }

    @GetMapping("/health")
    public Map<String, Object> health() {
        Map<String, Object> map = new HashMap<>();
        map.put("status", "UP");
        var capabilities = solverFactory.capabilities();
        map.put("packingsolverAvailable", capabilities.stream().anyMatch(e -> "packingsolver".equals(e.id()) && e.available()));
        // Null unless the native engine is missing and a registered stand-in will run (and be labelled) instead.
        map.put("packingsolverFallback", solverFactory.fallbackFor("packingsolver"));
        map.put("packingsolverIrregularAvailable", capabilities.stream().anyMatch(e -> "packingsolver-irregular".equals(e.id()) && e.available()));
        map.put("packingsolverIrregularFallback", solverFactory.fallbackFor("packingsolver-irregular"));
        map.put("remnantsInStock", remnantService.getAvailableRemnants().size());
        return map;
    }
}
