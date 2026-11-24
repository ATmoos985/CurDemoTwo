package com.example.cutdemotwo.contracts.slitting;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/** Independently verified, planned output; no inventory consumption or optimality claim. */
public record SlittingResult(
        String schemaVersion,
        String unit,
        String engine,
        String engineVersion,
        String status,
        boolean optimalityProven,
        List<Pattern> patterns,
        List<Fulfillment> fulfillment,
        long pieceAreaMm2,
        long motherAreaMm2,
        long usableAreaMm2,
        int totalOverproduced,
        @JsonInclude(JsonInclude.Include.NON_NULL) Integer estimatedKnifeChanges,
        @JsonInclude(JsonInclude.Include.NON_NULL) Integer knifeChangesSaved
) {
    public SlittingResult {
        patterns = List.copyOf(patterns);
        fulfillment = List.copyOf(fulfillment);
    }

    /** 向后兼容 12 参构造器：未写入换刀统计摘要时保持原有字段语义。 */
    public SlittingResult(
            String schemaVersion,
            String unit,
            String engine,
            String engineVersion,
            String status,
            boolean optimalityProven,
            List<Pattern> patterns,
            List<Fulfillment> fulfillment,
            long pieceAreaMm2,
            long motherAreaMm2,
            long usableAreaMm2,
            int totalOverproduced
    ) {
        this(schemaVersion, unit, engine, engineVersion, status, optimalityProven,
                patterns, fulfillment, pieceAreaMm2, motherAreaMm2, usableAreaMm2, totalOverproduced,
                null, null);
    }

    public record Pattern(
            String id,
            int rollWidthMm,
            int patternWidthMm,
            long lengthMm,
            String surfaceTreatment,
            int repetitions,
            List<Station> stations,
            List<Allocation> allocations,
            @JsonInclude(JsonInclude.Include.NON_NULL) Integer motherWidthMm
    ) {
        public Pattern {
            stations = List.copyOf(stations);
            allocations = List.copyOf(allocations);
        }

        /** 向后兼容 8 参构造器：单幅宽母卷场景下不输出额外 motherWidthMm 字段。 */
        public Pattern(
                String id,
                int rollWidthMm,
                int patternWidthMm,
                long lengthMm,
                String surfaceTreatment,
                int repetitions,
                List<Station> stations,
                List<Allocation> allocations
        ) {
            this(id, rollWidthMm, patternWidthMm, lengthMm, surfaceTreatment, repetitions, stations, allocations, null);
        }
    }

    public record Station(int widthMm, int countPerRepetition) {}

    /** Counts already cover every repetition; never multiply these by repetitions again. */
    public record Allocation(String orderId, int quantity) {}

    public record Fulfillment(String orderId, int requested, int produced, int missing, int overproduced) {}
}
