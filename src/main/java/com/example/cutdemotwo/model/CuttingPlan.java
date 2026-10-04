package com.example.cutdemotwo.model;

public record CuttingPlan(String id, SolveRequest request, SolveResponse result, String baseline,
                          String status, String createdAt, String parentPlanId, int version) {
    public CuttingPlan { if (version < 1) version = 1; }
    public CuttingPlan(String id, SolveRequest request, SolveResponse result, String baseline, String status, String createdAt) {
        this(id, request, result, baseline, status, createdAt, null, 1);
    }
    public CuttingPlan withStatus(String value) { return new CuttingPlan(id, request, result, baseline, value, createdAt, parentPlanId, version); }
}
