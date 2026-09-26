package com.example.cutdemotwo.service;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.service.solver.SolverFactory;
import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class CuttingWorkflowService {
    private final SolverFactory solverFactory;
    private final RemnantService inventory;
    // ponytail: demo plans live in one process; persist them when confirmations must survive restarts.
    private final Map<String, Plan> plans = new ConcurrentHashMap<>();

    public CuttingWorkflowService(SolverFactory solverFactory, RemnantService inventory) {
        this.solverFactory = solverFactory;
        this.inventory = inventory;
    }

    public SolveResponse solve(SolveRequest request) {
        SolveResponse result = solverFactory.solve(request);
        if (result.isSuccess() && !result.getPieces().isEmpty()) {
            String id = UUID.randomUUID().toString();
            result.setPlanId(id);
            plans.put(id, new Plan(request, result));
        }
        return result;
    }

    public synchronized Map<String, Object> confirm(CutReport report) {
        if (report == null || report.planId() == null) throw new IllegalArgumentException("请先执行排料并取得方案编号");
        Map<String, Object> confirmed = inventory.getReceipt(report.planId());
        if (confirmed != null) return confirmed;
        Plan plan = plans.get(report.planId());
        if (plan == null) throw new IllegalArgumentException("方案已失效，请重新执行排料");
        Map<String, Object> receipt = inventory.confirm(plan.request(), plan.response(), report);
        plans.remove(report.planId());
        return receipt;
    }

    private record Plan(SolveRequest request, SolveResponse response) {}
}
