package com.example.cutdemotwo.business.model;

import java.util.*;

/** Immutable execution identity and whole-unit reservation, committed with inventory. */
public record ExecutionOrder(String id, String idempotencyKey, String planId, String taskId,
        String station, String materialType, String materialId, Map<String,Integer> demandQuantities,
        String state, long version, long createdAt, Long expiresAt, List<Event> events) {
    public ExecutionOrder { demandQuantities=Map.copyOf(demandQuantities);events=List.copyOf(events); }
    public record Create(String planId,String station) {}
    public record Command(String operationId,long expectedVersion,int reservationSeconds,String reason) {}
    public record Event(String operationId,String action,long expectedVersion,int reservationSeconds,String reason,long at) {}
    public boolean reserves(long now) {return "RUNNING".equals(state) || "RELEASED".equals(state) && expiresAt!=null && now<expiresAt;}
    public String effectiveState(long now) {return "RELEASED".equals(state) && !reserves(now)?"EXPIRED":state;}
    public ExecutionOrder transition(String next,Long expiry,String action,Command c,long now) {
        var history=new ArrayList<>(events);history.add(new Event(c.operationId(),action,c.expectedVersion(),c.reservationSeconds(),c.reason(),now));
        return new ExecutionOrder(id,idempotencyKey,planId,taskId,station,materialType,materialId,demandQuantities,next,version+1,createdAt,expiry,history);
    }
}
