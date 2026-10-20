package com.example.cutdemotwo.contracts.jobs;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;

/** v2 job envelope; nesting-v1 is the explicitly supported geometry profile. */
public record OptimizationRequest(String schemaVersion, String problemType, String clientRequestId,
                                  NestingProblem problem, Boolean allowFallback, Boolean requireComplete,
                                  @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
                                  Strategy strategy) {
    public OptimizationRequest(String schemaVersion, String problemType, String clientRequestId,
                               NestingProblem problem, Boolean allowFallback, Boolean requireComplete) {
        this(schemaVersion, problemType, clientRequestId, problem, allowFallback, requireComplete, null);
    }
    public record Strategy(String id, String version, int maxTrials) {}
}
