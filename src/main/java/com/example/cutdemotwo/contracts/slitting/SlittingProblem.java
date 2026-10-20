package com.example.cutdemotwo.contracts.slitting;

import com.example.cutdemotwo.contracts.jobs.OptimizationProblem;
import java.util.List;

/** slitting-v1: widths and roll lengths are mm, quantity counts finished rolls. */
public record SlittingProblem(String schemaVersion, String unit, int motherWidthMm,
        int leftTrimMm, int rightTrimMm, int minWidthMm, int maxWidthMm, int widthStepMm,
        int totalOverCap, String profile, List<Order> orders, int timeLimitSeconds) implements OptimizationProblem {
    public SlittingProblem { orders = orders == null ? List.of() : List.copyOf(orders); }
    public record Order(String id, int widthMm, long lengthMm, int quantity, String surfaceTreatment) {}
}
