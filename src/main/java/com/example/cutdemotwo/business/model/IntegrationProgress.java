package com.example.cutdemotwo.business.model;

import java.util.List;

/** Consumer checkpoint and fenced attempt history, deliberately separate from inventory revision. */
public record IntegrationProgress(long version,String streamId,long acknowledgedThrough,List<Attempt> attempts) {
    public IntegrationProgress { attempts=List.copyOf(attempts); }
    public static IntegrationProgress empty(){return new IntegrationProgress(0,"",0,List.of());}
    public IntegrationProgress withVersion(long value){return new IntegrationProgress(value,streamId,acknowledgedThrough,attempts);}
    public record Attempt(String requestId,String retryOf,String eventId,long eventSequence,int number,
            String token,long expiresAt,String state,String externalReceipt,String reason) {}
}
