package com.example.cutdemotwo.contracts.jobs;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;

/** v2 job envelope; nesting-v1 is the explicitly supported geometry profile. */
public record OptimizationRequest(String schemaVersion, String problemType, String clientRequestId,
                                  NestingProblem problem, Boolean allowFallback, Boolean requireComplete) {}
