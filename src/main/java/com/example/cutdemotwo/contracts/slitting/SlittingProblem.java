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
        @JsonInclude(JsonInclude.Include.NON_NULL) Boolean lnsEnabled,
        @JsonInclude(JsonInclude.Include.NON_NULL) Integer maxKnives,
        @JsonInclude(JsonInclude.Include.NON_NULL) Integer minBladeSpacingMm,
        @JsonInclude(JsonInclude.Include.NON_NULL) Integer forbiddenNarrowEdgeMinMm,
        @JsonInclude(JsonInclude.Include.NON_NULL) Integer forbiddenNarrowEdgeMaxMm,
        @JsonInclude(JsonInclude.Include.NON_NULL) Integer kerfMm,
        @JsonInclude(JsonInclude.Include.NON_NULL) List<CandidateRollWidth> candidateRollWidths
) implements OptimizationProblem {
    public SlittingProblem {
        orders = orders == null ? List.of() : List.copyOf(orders);
        // 保持未传入时的 null 语义，避免影响历史请求的规范 JSON 序列化与幂等输入哈希。
        candidateRollWidths = candidateRollWidths == null ? null : List.copyOf(candidateRollWidths);
    }

    /** 向后兼容 12 参构造器：未显式传入高级求解参数与物理刀架扩展约束时采用默认值。 */
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
                null, null, null, null, null, null, null, null, null, null,
                null, null, null, null, null, null);
    }

    /** 向后兼容 22 参构造器：保留原有高级求解参数调用方零修改兼容。 */
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
            int timeLimitSeconds,
            Integer topK,
            Integer maxIterations,
            Integer maxPatterns,
            Integer maxDistinctWidths,
            Long stageTimeLimitMs,
            Boolean useOptimizedAssignment,
            Double underPenalty,
            Double seqGroupAlpha,
            Double seqGroupBeta,
            Boolean lnsEnabled
    ) {
        this(schemaVersion, unit, motherWidthMm, leftTrimMm, rightTrimMm, minWidthMm, maxWidthMm, widthStepMm,
                totalOverCap, profile, orders, timeLimitSeconds,
                topK, maxIterations, maxPatterns, maxDistinctWidths, stageTimeLimitMs,
                useOptimizedAssignment, underPenalty, seqGroupAlpha, seqGroupBeta, lnsEnabled,
                null, null, null, null, null, null);
    }

    public SlittingProblem withTimeLimitSeconds(int seconds) {
        return new SlittingProblem(schemaVersion, unit, motherWidthMm, leftTrimMm, rightTrimMm, minWidthMm,
                maxWidthMm, widthStepMm, totalOverCap, profile, orders, seconds,
                topK, maxIterations, maxPatterns, maxDistinctWidths, stageTimeLimitMs,
                useOptimizedAssignment, underPenalty, seqGroupAlpha, seqGroupBeta, lnsEnabled,
                maxKnives, minBladeSpacingMm, forbiddenNarrowEdgeMinMm, forbiddenNarrowEdgeMaxMm,
                kerfMm, candidateRollWidths);
    }

    public int effectiveKerfMm() {
        return kerfMm == null ? 0 : kerfMm;
    }

    public boolean hasCandidateRollWidths() {
        return candidateRollWidths != null && !candidateRollWidths.isEmpty();
    }

    public boolean hasForbiddenNarrowEdge() {
        return forbiddenNarrowEdgeMinMm != null && forbiddenNarrowEdgeMaxMm != null;
    }

    public record Order(
            String id,
            @JsonProperty(required = true) int widthMm,
            @JsonProperty(required = true) long lengthMm,
            @JsonProperty(required = true) int quantity,
            String surfaceTreatment
    ) {}

    /** 可选多规格母卷宽幅池条目：widthMm 为母卷总幅宽（mm），availableRolls 为可用卷数上限（null 表示不限）。 */
    public record CandidateRollWidth(
            @JsonProperty(required = true) int widthMm,
            @JsonInclude(JsonInclude.Include.NON_NULL) Integer availableRolls
    ) {
        public CandidateRollWidth(int widthMm) {
            this(widthMm, null);
        }
    }
}
