package com.example.cutdemotwo.contracts.jobs;

/** Execution state is distinct from feasibility and complete fulfillment. No invented percent progress. */
public record OptimizationJob(String id, String schemaVersion, String clientRequestId, String inputHash,
                              String state, String phase, String createdAt, String startedAt, String finishedAt,
                              int timeLimitSeconds, String resultRef, String code, String message) {
    public boolean terminal() { return switch (state) {
        case "SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT" -> true; default -> false;
    }; }
}
