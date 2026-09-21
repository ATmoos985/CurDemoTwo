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

    private final PackingSolverService packingSolverService;
    private final ScenarioOneService scenarioOneService;
    private final com.example.cutdemotwo.service.RemnantService remnantService;

    @Autowired
    public FabricCutController(PackingSolverService packingSolverService,
                                ScenarioOneService scenarioOneService,
                                com.example.cutdemotwo.service.RemnantService remnantService) {
        this.packingSolverService = packingSolverService;
        this.scenarioOneService = scenarioOneService;
        this.remnantService = remnantService;
    }

    @PostMapping("/solve")
    public SolveResponse solve(@RequestBody SolveRequest request) {
        return packingSolverService.solve(request);
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
        map.put("packingsolverAvailable", packingSolverService.isAvailable());
        map.put("remnantsInStock", remnantService.getAvailableRemnants().size());
        return map;
    }
}
