package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.contracts.jobs.*;

/** Internal durable document. The idempotency key is never returned in public job representations. */
public record StoredOptimizationJob(String idempotencyKey, OptimizationRequest input,
                                    OptimizationJob job, OptimizationResult result) {}
