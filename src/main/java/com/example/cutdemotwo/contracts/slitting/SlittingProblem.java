package com.example.cutdemotwo.contracts.slitting;

import com.example.cutdemotwo.contracts.jobs.OptimizationProblem;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/** slitting-v1: widths and roll lengths are mm, quantity counts finished rolls. */
public record SlittingProblem(
        String schemaVersion,
        String unit,
        @JsonProperty(required = true) int motherWidthMm,
        @JsonProperty(required = true) int leftTrimMm,
        @JsonProperty(required = true) int rightTrimMm,
        @JsonProperty(required = true) int minWidthMm,
        @JsonProperty(required = true) int maxWidthMm,
        @JsonProperty(required = true) int widthStepMm,
        @JsonProperty(required = true) int totalOverCap,
        String profile,
        List<Order> orders,
        @JsonProperty(required = true) int timeLimitSeconds,
        @JsonInclude(JsonInclude.Include.NON_NULL) Integer topK,
        @JsonInclude(JsonInclude.Include.NON_NULL) Integer maxIterations,
        @JsonInclude(JsonInclude.Include.NON_NULL) Integer maxPatterns,
        @JsonInclude(JsonInclude.Include.NON_NULL) Integer maxDistinctWidths,
        @JsonInclude(JsonInclude.Include.NON_NULL) Long stageTimeLimitMs,
        @JsonInclude(JsonInclude.Include.NON_NULL) Boolean useOptimizedAssignment,
        @JsonInclude(JsonInclude.Include.NON_NULL) Double underPenalty,
        @JsonInclude(JsonInclude.Include.NON_NULL) Double seqGroupAlpha,
        @JsonInclude(JsonInclude.Include.NON_NULL) Double seqGroupBeta,
        @JsonInclude(JsonInclude.Include.NON_NULL) Boolean lnsEnabled
) implements OptimizationProblem {
    public SlittingProblem {
        orders = orders == null ? List.of() : List.copyOf(orders);
    }

    /** 向后兼容 12 参构造器：未显式传入高级求解参数时由内核采用 Solartron-Cut 默认值。 */
    public SlittingProblem(
            String schemaVersion,
            String unit,
            int motherWidthMm,
            int leftTrimMm,
            int rightTrimMm,
            int minWidthMm,
            int maxWidthMm,
            int widthStepMm,
            int totalOverCap,
            String profile,
            List<Order> orders,
            int timeLimitSeconds
    ) {
        this(schemaVersion, unit, motherWidthMm, leftTrimMm, rightTrimMm, minWidthMm, maxWidthMm, widthStepMm,
                totalOverCap, profile, orders, timeLimitSeconds,
                null, null, null, null, null, null, null, null, null, null);
    }

    public SlittingProblem withTimeLimitSeconds(int seconds) {
        return new SlittingProblem(schemaVersion, unit, motherWidthMm, leftTrimMm, rightTrimMm, minWidthMm,
                maxWidthMm, widthStepMm, totalOverCap, profile, orders, seconds,
                topK, maxIterations, maxPatterns, maxDistinctWidths, stageTimeLimitMs,
                useOptimizedAssignment, underPenalty, seqGroupAlpha, seqGroupBeta, lnsEnabled);
    }

    public record Order(
            String id,
            @JsonProperty(required = true) int widthMm,
            @JsonProperty(required = true) long lengthMm,
            @JsonProperty(required = true) int quantity,
            String surfaceTreatment
    ) {}
}
