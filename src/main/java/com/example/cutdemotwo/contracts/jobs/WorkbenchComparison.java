package com.example.cutdemotwo.contracts.jobs;

import java.util.List;

/** 工作台同口径双方案比较契约：逐规格应排/已排/缺件、还原外扩后的物理占长与齐套节省量。 */
public record WorkbenchComparison(
        String taskId,
        Side left,
        Side right,
        boolean sameConstraints,
        List<String> constraintDifferences,
        List<MetricDelta> metricDeltas,
        LengthComparison lengthComparison
) {
    public WorkbenchComparison {
        constraintDifferences = constraintDifferences == null ? List.of() : List.copyOf(constraintDifferences);
        metricDeltas = metricDeltas == null ? List.of() : List.copyOf(metricDeltas);
    }

    public record Side(
            String resultId,
            String inputHash,
            String problemType,
            String fulfillmentStatus,
            int requested,
            int placed,
            int unplaced,
            List<Demand> demands,
            Double occupiedLengthMm,
            String lengthBasis,
            double rectGapPaddingMm,
            MaterialWindow materialWindow,
            List<OptimizationResult.Metric> metrics
    ) {
        public Side {
            demands = demands == null ? List.of() : List.copyOf(demands);
            metrics = metrics == null ? List.of() : List.copyOf(metrics);
        }
    }

    public record Demand(
            int demandId,
            Integer sourceLineId,
            String name,
            int requested,
            int placed,
            int unplaced
    ) {}

    public record MaterialWindow(
            String type,
            String id,
            long revision,
            double widthMm,
            double windowStartMm,
            double windowLengthMm,
            long taskRevision
    ) {}

    /** 符号差值为 right 减去 left，保留每项指标原有单位、分母口径与版本。 */
    public record MetricDelta(
            String name,
            OptimizationResult.Metric left,
            OptimizationResult.Metric right,
            Double delta,
            String status
    ) {}

    public record LengthComparison(
            String status,
            String shorterResultId,
            Double savedLengthMm,
            String basis,
            String reason
    ) {}
}
