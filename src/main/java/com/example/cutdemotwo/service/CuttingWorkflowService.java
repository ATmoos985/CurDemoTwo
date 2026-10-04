package com.example.cutdemotwo.service;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.service.solver.SolverFactory;
import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.UUID;

@Service
public class CuttingWorkflowService {
    private final SolverFactory solverFactory;
    private final RemnantService inventory;

    public CuttingWorkflowService(SolverFactory solverFactory, RemnantService inventory) {
        this.solverFactory = solverFactory;
        this.inventory = inventory;
    }

    public SolveResponse solve(SolveRequest request) {
        request.validateSettings();
        inventory.prepareTaskSolve(request);
        String baseline = inventory.materialFingerprint(request);
        SolveResponse result = FabricSolveAdapter.solve(solverFactory, request);
        if (result.isSuccess() && !result.getPieces().isEmpty()) {
            String id = UUID.randomUUID().toString();
            result.setPlanId(id);
            inventory.rememberPlan(new CuttingPlan(id, request, result, baseline, "PENDING", java.time.LocalDateTime.now().toString()));
        }
        return result;
    }

    public synchronized Map<String, Object> confirm(CutReport report) {
        return inventory.confirmPlan(report);
    }

    public Map<String, Object> getPlan(String id) {
        CuttingPlan plan = inventory.getPlan(id);
        return Map.of("unit", "mm", "coordinateSystem", "source-local-top-left", "request", plan.request(),
                "result", plan.result(), "status", plan.status(), "createdAt", plan.createdAt());
    }

}
