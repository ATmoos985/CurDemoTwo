package com.example.cutdemotwo.contracts.jobs;

import com.example.cutdemotwo.contracts.nesting.NestingResult;
import java.util.List;

/** Immutable verified computation result, not a work order or an inventory receipt. */
public record OptimizationResult(String id, String jobId, String inputHash, String schemaVersion,
                                 String validationStatus, String fulfillmentStatus, boolean meetsRequirement,
                                 String terminationReason, List<Metric> metrics, NestingResult layout) {
    public record Metric(String name, double value, String unit, double numerator, double denominator,
                         String basis, String version) {}
}
