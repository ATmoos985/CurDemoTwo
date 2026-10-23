package com.example.cutdemotwo.business.model;

import java.util.*;

/** Posted physical observation. Differences are inventory adjustments, never production output. */
public record InventoryCount(String id,String idempotencyKey,Command command,long postedAt,
        long inventoryRevision,List<Line> lines) {
    public InventoryCount { lines=List.copyOf(lines); }
    public record Command(long expectedRevision,String reason,String operator,List<Observation> materials) {
        public Command { materials=materials==null?null:List.copyOf(materials); }
    }
    /** A roll observation measures uncut length; its width cannot be changed by counting. */
    public record Observation(String type,String id,boolean present,double width,double length) {}
    public record Line(String type,String id,double beforeWidth,double beforeLength,String beforeStatus,
            double measuredWidth,double measuredLength,String afterStatus,double differenceAreaM2,
            double usedLength,double beforeTotalLength,double afterTotalLength) {}
    public static void requireAppendOnly(Map<String,InventoryCount> previous,Map<String,InventoryCount> next) {
        for(var entry:previous.entrySet())if(!Objects.equals(entry.getValue(),next.get(entry.getKey())))
            throw new IllegalStateException("已过账盘点单不可修改或删除；请新建盘点单更正");
        var keys=new HashSet<String>();
        for(var entry:next.entrySet())if(!entry.getKey().equals(entry.getValue().id()) || !keys.add(entry.getValue().idempotencyKey()))
            throw new IllegalStateException("盘点单编号或幂等身份重复");
    }
}
