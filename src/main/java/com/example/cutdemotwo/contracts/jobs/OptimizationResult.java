package com.example.cutdemotwo.contracts.jobs;

import com.example.cutdemotwo.contracts.nesting.NestingResult;
import java.util.List;

/** Immutable verified computation result, not a work order or an inventory receipt. */
public record OptimizationResult(String id, String jobId, String inputHash, String schemaVersion,
                                 String validationStatus, String fulfillmentStatus, boolean meetsRequirement,
                                 String terminationReason, List<Metric> metrics,
                                 @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
                                 NestingResult layout,
                                 @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
                                 MarkerReport marker,
                                 @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
                                 com.example.cutdemotwo.contracts.slitting.SlittingResult slitting) {
    public OptimizationResult(String id, String jobId, String inputHash, String schemaVersion,
                              String validationStatus, String fulfillmentStatus, boolean meetsRequirement,
                              String terminationReason, List<Metric> metrics,
                              com.example.cutdemotwo.contracts.slitting.SlittingResult slitting) {
        this(id, jobId, inputHash, schemaVersion, validationStatus, fulfillmentStatus, meetsRequirement,
                terminationReason, metrics, null, null, slitting);
    }
    public OptimizationResult(String id, String jobId, String inputHash, String schemaVersion,
                              String validationStatus, String fulfillmentStatus, boolean meetsRequirement,
                              String terminationReason, List<Metric> metrics, NestingResult layout, MarkerReport marker) {
        this(id,jobId,inputHash,schemaVersion,validationStatus,fulfillmentStatus,meetsRequirement,
                terminationReason,metrics,layout,marker,null);
    }
    public OptimizationResult(String id, String jobId, String inputHash, String schemaVersion,
                              String validationStatus, String fulfillmentStatus, boolean meetsRequirement,
                              String terminationReason, List<Metric> metrics, NestingResult layout) {
        this(id, jobId, inputHash, schemaVersion, validationStatus, fulfillmentStatus, meetsRequirement,
                terminationReason, metrics, layout, null);
    }
    public record Metric(String name, double value, String unit, double numerator, double denominator,
                         String basis, String version) {}
    public record MarkerReport(String strategyVersion, Double firstOccupiedLengthMm, Double occupiedLengthMm,
                               double trialLengthMm, List<Trial> trials, boolean optimalityProven) {
        public MarkerReport { trials = List.copyOf(trials); }
    }
    public record Trial(int index, double lengthMm, Double occupiedLengthMm, String status, boolean complete,
                        int placed, int timeLimitSeconds, long elapsedMillis, String engine, String engineVersion) {}
}
