package com.example.cutdemotwo.contracts.jobs;

import java.util.List;

/** Deterministic comparison of archived forecasts, never production actuals or an optimality claim. */
public record ResultComparison(String schemaVersion, String leftResultId, String rightResultId,
        boolean sameHardConstraints, List<String> differences, String leftFulfillment, String rightFulfillment,
        boolean leftMeetsRequirement, boolean rightMeetsRequirement, List<MetricDelta> metrics) {
    public record MetricDelta(String name, OptimizationResult.Metric left, OptimizationResult.Metric right,
            Double rightMinusLeft, String status) {}
}
