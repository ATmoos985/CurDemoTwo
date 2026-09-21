package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.model.SolveRequest;
import com.example.cutdemotwo.model.SolveResponse;
import com.example.cutdemotwo.service.PackingSolverService;
import com.example.cutdemotwo.service.ScenarioOneService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.Map;

@RestController
@RequestMapping("/api")
@CrossOrigin(origins = "*")
public class FabricCutController {

    private final com.example.cutdemotwo.service.solver.SolverFactory solverFactory;
    private final ScenarioOneService scenarioOneService;
    private final com.example.cutdemotwo.service.RemnantService remnantService;
    private final com.example.cutdemotwo.service.toolpath.ToolpathOptimizerService toolpathOptimizerService;

    @Autowired
    public FabricCutController(com.example.cutdemotwo.service.solver.SolverFactory solverFactory,
                                ScenarioOneService scenarioOneService,
                                com.example.cutdemotwo.service.RemnantService remnantService,
                                com.example.cutdemotwo.service.toolpath.ToolpathOptimizerService toolpathOptimizerService) {
        this.solverFactory = solverFactory;
        this.scenarioOneService = scenarioOneService;
        this.remnantService = remnantService;
        this.toolpathOptimizerService = toolpathOptimizerService;
    }

    @PostMapping("/solve")
    public SolveResponse solve(@RequestBody SolveRequest request) {
        return solverFactory.solve(request);
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

    @GetMapping("/rolls")
    public java.util.List<com.example.cutdemotwo.model.MotherRollInfo> listRolls() {
        return remnantService.getMotherRolls();
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
