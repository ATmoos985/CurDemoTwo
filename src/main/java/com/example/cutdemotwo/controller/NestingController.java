package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.model.nesting.NestingProblem;
import com.example.cutdemotwo.model.nesting.NestingResult;
import com.example.cutdemotwo.service.solver.EngineCapabilities;
import com.example.cutdemotwo.service.solver.SolverFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;
import java.util.List;

/** Pure computation endpoint: never creates a task, saves a plan, or updates stock. */
@RestController
@RequestMapping("/api/v1/nesting")
public class NestingController {
    private final SolverFactory solvers;
    private final JsonMapper json = JsonMapper.builder()
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT).build();
    public NestingController(SolverFactory solvers) { this.solvers = solvers; }

    @GetMapping("/engines")
    public List<EngineCapabilities> engines() { return solvers.capabilities(); }

    @PostMapping(value = "/solve", consumes = "application/json")
    public ResponseEntity<NestingResult> solve(@RequestBody String body) {
        NestingProblem problem;
        try { problem = json.readValue(body, NestingProblem.class); }
        catch (RuntimeException invalid) {
            return ResponseEntity.badRequest().body(NestingResult.failure("INVALID_INPUT", "输入格式无效、存在未知字段或字段类型错误", null, 0));
        }
        NestingResult result = solvers.solve(problem);
        int status = switch (result.status()) {
            case "INVALID_INPUT" -> 400;
            case "UNSUPPORTED" -> 422;
            case "UNAVAILABLE" -> 503;
            case "FAILED", "INVALID_RESULT" -> 500;
            default -> 200;
        };
        return ResponseEntity.status(status).body(result);
    }
}
