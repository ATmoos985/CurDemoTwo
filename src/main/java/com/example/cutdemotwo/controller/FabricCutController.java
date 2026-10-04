package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.model.SolveRequest;
import com.example.cutdemotwo.model.SolveResponse;
import com.example.cutdemotwo.service.PackingSolverService;
import com.example.cutdemotwo.service.ScenarioOneService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.HttpStatus;

import java.util.HashMap;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class FabricCutController {

    private final com.example.cutdemotwo.service.solver.SolverFactory solverFactory;
    private final ScenarioOneService scenarioOneService;
    private final com.example.cutdemotwo.service.RemnantService remnantService;
    private final com.example.cutdemotwo.service.toolpath.ToolpathOptimizerService toolpathOptimizerService;
    private final com.example.cutdemotwo.service.CuttingWorkflowService workflowService;

    @Autowired
    public FabricCutController(com.example.cutdemotwo.service.solver.SolverFactory solverFactory,
                                ScenarioOneService scenarioOneService,
                                com.example.cutdemotwo.service.RemnantService remnantService,
                                com.example.cutdemotwo.service.toolpath.ToolpathOptimizerService toolpathOptimizerService,
                                com.example.cutdemotwo.service.CuttingWorkflowService workflowService) {
        this.solverFactory = solverFactory;
        this.scenarioOneService = scenarioOneService;
        this.remnantService = remnantService;
        this.toolpathOptimizerService = toolpathOptimizerService;
        this.workflowService = workflowService;
    }

    @GetMapping("/cutting/tasks")
    public java.util.List<com.example.cutdemotwo.model.CuttingTask> tasks() { return remnantService.listTasks(); }

    @GetMapping("/cutting/tasks/{id}")
    public Map<String, Object> task(@PathVariable String id) { return remnantService.taskDetail(id); }

    @PostMapping("/cutting/tasks")
    public com.example.cutdemotwo.model.CuttingTask saveTask(@RequestBody com.example.cutdemotwo.model.CuttingTask task) {
        return remnantService.saveTask(task);
    }

    @PostMapping("/cutting/material-candidates")
    public java.util.List<Map<String, Object>> candidates(@RequestBody SolveRequest request) { return remnantService.materialCandidates(request); }

    @GetMapping("/cutting/plans/{id}")
    public Map<String, Object> plan(@PathVariable String id) { return workflowService.getPlan(id); }

    @GetMapping("/cutting/tasks/{id}/plans")
    public java.util.List<com.example.cutdemotwo.model.CuttingPlan> taskPlans(@PathVariable String id) { return remnantService.taskPlans(id); }

    @PostMapping("/cutting/plans/{id}/cancel")
    public Object cancelPlan(@PathVariable String id) { return remnantService.changePlanStatus(id, false); }

    @PostMapping("/cutting/plans/{id}/restore")
    public Object restorePlan(@PathVariable String id) { return remnantService.changePlanStatus(id, true); }

    @PostMapping("/cutting/plans/{id}/adjust")
    public Object adjustPlan(@PathVariable String id, @RequestBody com.example.cutdemotwo.model.PlanAdjustment adjustment) {
        return workflowService.adjust(id, adjustment);
    }

    @ExceptionHandler(com.example.cutdemotwo.persistence.InventoryConflictException.class)
    @ResponseStatus(HttpStatus.CONFLICT)
    public Map<String, String> conflict(RuntimeException error) { return Map.of("message", error.getMessage()); }

    @PostMapping("/solve")
    public SolveResponse solve(@RequestBody SolveRequest request) {
        return workflowService.solve(request);
    }

    @PostMapping("/cutting/report-confirm")
    public Map<String, Object> confirmCut(@RequestBody com.example.cutdemotwo.model.CutReport report) {
        return workflowService.confirm(report);
    }

    @PostMapping("/cutting/reports/{id}/reverse")
    public Map<String, Object> reverseReport(@PathVariable String id, @RequestBody Map<String, String> body) {
        return remnantService.reverseReport(id, body.get("reason"));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Map<String, String> invalidInput(IllegalArgumentException error) {
        return Map.of("message", error.getMessage());
    }

    @PostMapping("/toolpath/optimize")
    public com.example.cutdemotwo.model.ToolpathResult optimizeToolpath(@RequestBody com.example.cutdemotwo.model.ToolpathRequest req) {
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
    public java.util.List<com.example.cutdemotwo.model.MotherRollInfo> listRolls() {
        return remnantService.getMotherRolls();
    }

    @GetMapping("/rolls/{rollId}")
    public com.example.cutdemotwo.model.MotherRollInfo getRollDetail(@PathVariable String rollId) {
        var roll = remnantService.getMotherRoll(rollId);
        if (roll == null) throw new org.springframework.web.server.ResponseStatusException(HttpStatus.NOT_FOUND, "母卷不存在");
        return roll;
    }

    @PostMapping("/rolls")
    public com.example.cutdemotwo.model.MotherRollInfo saveRoll(@RequestBody com.example.cutdemotwo.model.MotherRollInfo roll) {
        return remnantService.saveOrUpdateMotherRoll(roll);
    }

    @PostMapping("/rolls/{rollId}/defects")
    public com.example.cutdemotwo.model.Defect addDefect(@PathVariable String rollId, @RequestBody com.example.cutdemotwo.model.Defect defect) {
        return remnantService.addDefectToRoll(rollId, defect);
    }

    @PostMapping("/rolls/{rollId}/reset")
    public Map<String, Object> resetRoll(@PathVariable String rollId) {
        boolean ok = remnantService.resetRoll(rollId);
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
    public java.util.List<com.example.cutdemotwo.model.RemnantStock> listRemnants(@RequestParam(required = false) String rollId) {
        return remnantService.getRemnantsByRollId(rollId);
    }

    @PostMapping("/remnants/scan")
    public com.example.cutdemotwo.model.RemnantStock scanRemnant(@RequestBody Map<String, String> body) {
        String id = body.get("id");
        return remnantService.scanOrGetById(id);
    }

    @PostMapping("/remnants/match")
    public java.util.List<com.example.cutdemotwo.model.RemnantStock> matchRemnants(@RequestBody Map<String, Object> body) {
        String rollId = body.containsKey("rollId") && body.get("rollId") != null ? body.get("rollId").toString() : null;
        double w = body.containsKey("w") ? Double.parseDouble(body.get("w").toString()) : 0;
        double l = body.containsKey("l") ? Double.parseDouble(body.get("l").toString()) : 0;
        boolean rot = body.containsKey("allowRotation") && Boolean.parseBoolean(body.get("allowRotation").toString());
        return remnantService.matchRemnants(rollId, w, l, rot);
    }

    @PostMapping("/remnants/register")
    public com.example.cutdemotwo.model.RemnantStock registerRemnant(@RequestBody com.example.cutdemotwo.model.RemnantStock item) {
        return remnantService.registerRemnant(item);
    }

    @GetMapping("/health")
    public Map<String, Object> health() {
        Map<String, Object> map = new HashMap<>();
        map.put("status", "UP");
        com.example.cutdemotwo.service.solver.ICutSolverEngine packingEngine = solverFactory.getEngine("packingsolver");
        map.put("packingsolverAvailable", packingEngine != null && packingEngine.isAvailable());
        map.put("remnantsInStock", remnantService.getAvailableRemnants().size());
        return map;
    }
}
