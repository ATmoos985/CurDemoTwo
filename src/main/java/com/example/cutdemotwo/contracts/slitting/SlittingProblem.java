package com.example.cutdemotwo.contracts.slitting;

import com.example.cutdemotwo.contracts.jobs.OptimizationProblem;
import java.util.List;
import com.fasterxml.jackson.annotation.JsonProperty;

/** slitting-v1: widths and roll lengths are mm, quantity counts finished rolls. */
public record SlittingProblem(String schemaVersion, String unit, @JsonProperty(required=true) int motherWidthMm,
        @JsonProperty(required=true) int leftTrimMm, @JsonProperty(required=true) int rightTrimMm, @JsonProperty(required=true) int minWidthMm, @JsonProperty(required=true) int maxWidthMm, @JsonProperty(required=true) int widthStepMm,
        @JsonProperty(required=true) int totalOverCap, String profile, List<Order> orders, @JsonProperty(required=true) int timeLimitSeconds) implements OptimizationProblem {
    public SlittingProblem { orders = orders == null ? List.of() : List.copyOf(orders); }
    public record Order(String id, @JsonProperty(required=true) int widthMm, @JsonProperty(required=true) long lengthMm, @JsonProperty(required=true) int quantity, String surfaceTreatment) {}
}
