package com.example.cutdemotwo.contracts.jobs;

import com.fasterxml.jackson.annotation.JsonInclude;
import tools.jackson.databind.json.JsonMapper;

import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Set;

/** 内部持久化作业文档契约；幂等键绝不向公开作业响应暴露。 */
public record StoredOptimizationJob(
        String idempotencyKey,
        OptimizationRequest input,
        OptimizationJob job,
        OptimizationResult result,
        @JsonInclude(JsonInclude.Include.NON_NULL) WorkbenchJobSource workbenchSource
) {
    private static final JsonMapper JSON = JsonMapper.builder().build();

    /** 兼容旧 4 参构造器及不含 workbenchSource 的历史持久化快照。 */
    public StoredOptimizationJob(String idempotencyKey, OptimizationRequest input,
                                 OptimizationJob job, OptimizationResult result) {
        this(idempotencyKey, input, job, result, null);
    }

    public static String inputHash(OptimizationRequest input) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(JSON.writeValueAsBytes(input)));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    public StoredOptimizationJob transition(String state, String phase, String code, String message,
                                            OptimizationResult result, long timeMillis) {
        String now = Instant.ofEpochMilli(timeMillis).toString();
        boolean terminal = Set.of("SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT").contains(state);
        var next = new OptimizationJob(job.id(), job.schemaVersion(), job.clientRequestId(), job.inputHash(), state, phase,
                job.createdAt(), "RUNNING".equals(state) && job.startedAt() == null ? now : job.startedAt(),
                terminal ? now : null, job.timeLimitSeconds(), result == null ? null : "/api/v2/optimization-results/" + job.id(), code, message);
        return new StoredOptimizationJob(idempotencyKey, input, next, result, workbenchSource);
    }
}
