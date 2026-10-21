package com.example.cutdemotwo.business.model;

import java.util.*;

/** Posted material movement; does not alter quantities, quality or lineage. */
public record InventoryTransfer(String id, String idempotencyKey, Command command, long postedAt,
        long inventoryRevision, List<Line> lines) {
    public InventoryTransfer { lines=List.copyOf(lines); }
    public record Command(long expectedRevision,String destination,String reason,String operator,List<Material> materials) {
        public Command { materials=materials==null?null:List.copyOf(materials); }
    }
    public record Material(String type,String id) {}
    public record Line(String type,String id,String fromLocation,String toLocation) {}
    public static void requireAppendOnly(Map<String,InventoryTransfer> previous,Map<String,InventoryTransfer> next) {
        for(var entry:previous.entrySet())if(!Objects.equals(entry.getValue(),next.get(entry.getKey())))
            throw new IllegalStateException("已过账移库单不可修改或删除；请新建移库单更正");
        var keys=new HashSet<String>();
        for(var entry:next.entrySet())if(!entry.getKey().equals(entry.getValue().id()) || !keys.add(entry.getValue().idempotencyKey()))
            throw new IllegalStateException("移库单编号或幂等身份重复");
    }
}
