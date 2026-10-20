package com.example.cutdemotwo.contracts.slitting;

import java.util.List;

/** Independently verified, planned output; no inventory consumption or optimality claim. */
public record SlittingResult(String schemaVersion, String unit, String engine, String engineVersion,
        String status, boolean optimalityProven, List<Pattern> patterns, List<Fulfillment> fulfillment,
        long pieceAreaMm2, long motherAreaMm2, long usableAreaMm2, int totalOverproduced) {
    public SlittingResult { patterns=List.copyOf(patterns);fulfillment=List.copyOf(fulfillment); }
    public record Pattern(String id, int rollWidthMm, int patternWidthMm, long lengthMm,
            String surfaceTreatment, int repetitions, List<Station> stations, List<Allocation> allocations) {
        public Pattern {stations=List.copyOf(stations);allocations=List.copyOf(allocations);}
    }
    public record Station(int widthMm, int countPerRepetition) {}
    /** Counts already cover every repetition; never multiply these by repetitions again. */
    public record Allocation(String orderId, int quantity) {}
    public record Fulfillment(String orderId, int requested, int produced, int missing, int overproduced) {}
}
