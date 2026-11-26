package com.example.cutdemotwo.contracts.jobs;

import java.util.List;

/** A comparison of two archived, single-task 2D trials. Quantities concern submitted demand only. */
public record WorkbenchComparison(String taskId, Side left, Side right, boolean sameConstraints,
        List<String> constraintDifferences, List<MetricDelta> metricDeltas, LengthComparison lengthComparison) {

    public record Side(String resultId, String inputHash, String fulfillmentStatus,
            int requested, int placed, int unplaced, List<Demand> demands, Double occupiedLengthMm,
            String lengthBasis, double rectGapPaddingMm, MaterialWindow materialWindow,
            List<OptimizationResult.Metric> metrics) {}

    public record Demand(int demandId, Integer sourceLineId, String name, int requested, int placed, int unplaced) {}

    public record MaterialWindow(String type, String id, long revision, double widthMm, double windowStartMm,
            double windowLengthMm, long taskRevision) {}

    /** Signed delta is right minus left. Each metric preserves its original denominator, unit and version. */
    public record MetricDelta(String name, OptimizationResult.Metric left, OptimizationResult.Metric right,
            Double delta, String status) {}

    public record LengthComparison(String status, String shorterResultId, Double savedLengthMm, String basis,
            String reason) {}
}
