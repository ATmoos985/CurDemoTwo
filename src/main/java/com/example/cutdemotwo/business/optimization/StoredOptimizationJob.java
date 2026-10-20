package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.contracts.jobs.*;
import java.time.Instant;
import java.util.Set;
import java.security.MessageDigest;
import java.util.HexFormat;
import tools.jackson.databind.json.JsonMapper;

/** Internal durable document. The idempotency key is never returned in public job representations. */
public record StoredOptimizationJob(String idempotencyKey, OptimizationRequest input,
                                    OptimizationJob job, OptimizationResult result) {
    private static final JsonMapper JSON=JsonMapper.builder().build();
    public static String inputHash(OptimizationRequest input) {
        try {return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(JSON.writeValueAsBytes(input)));}
        catch(java.security.NoSuchAlgorithmException impossible){throw new IllegalStateException(impossible);}
    }
    public StoredOptimizationJob transition(String state, String phase, String code, String message,
                                             OptimizationResult result, long timeMillis) {
        String now=Instant.ofEpochMilli(timeMillis).toString();
        boolean terminal=Set.of("SUCCEEDED","FAILED","CANCELLED","TIMED_OUT").contains(state);
        var next=new OptimizationJob(job.id(),job.schemaVersion(),job.clientRequestId(),job.inputHash(),state,phase,
                job.createdAt(),"RUNNING".equals(state) && job.startedAt()==null?now:job.startedAt(),
                terminal?now:null,job.timeLimitSeconds(),result==null?null:"/api/v2/optimization-results/"+job.id(),code,message);
        return new StoredOptimizationJob(idempotencyKey,input,next,result);
    }
}
