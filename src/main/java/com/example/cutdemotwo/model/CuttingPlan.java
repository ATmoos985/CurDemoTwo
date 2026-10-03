package com.example.cutdemotwo.model;

public record CuttingPlan(String id, SolveRequest request, SolveResponse result, String baseline,
                          String status, String createdAt) {
    public CuttingPlan withStatus(String value) { return new CuttingPlan(id, request, result, baseline, value, createdAt); }
}
