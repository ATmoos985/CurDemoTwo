package com.example.cutdemotwo.business.model;

import java.util.*;

/** Immutable committed inventory fact; delivery acknowledgements live in a separate store. */
public record InventoryEvent(String id, long sequence, String schemaVersion, String authority,
        String action, String businessId, long occurredAt, long inventoryRevision,
        List<InventoryLedgerEntry> changes) {
    public InventoryEvent { changes=List.copyOf(changes); }
    public static List<InventoryEvent> append(List<InventoryEvent> previous,int priorLedgerSize,
            List<InventoryLedgerEntry> ledger,String action,String businessId,long now,long revision) {
        var result=new ArrayList<>(previous);
        var transactions=new LinkedHashMap<String,List<InventoryLedgerEntry>>();
        for(var entry:ledger.subList(priorLedgerSize,ledger.size())) {
            if("MIGRATION_OPENING".equals(entry.eventType()) || "SYSTEM_DEMO".equals(entry.actor()))continue;
            transactions.computeIfAbsent(entry.transactionId(),id->new ArrayList<>()).add(entry);
        }
        transactions.forEach((id,entries)->result.add(new InventoryEvent(id,result.size()+1L,"1","INTERNAL",
                action,businessId,now,revision,entries)));
        return List.copyOf(result);
    }
    public static void requireAppendOnly(List<InventoryEvent> previous,List<InventoryEvent> next) {
        if(next.size()<previous.size() || !next.subList(0,previous.size()).equals(previous))
            throw new IllegalStateException("集成事件不可修改或删除");
        var ids=new HashSet<String>();
        for(int i=0;i<next.size();i++) {
            var event=next.get(i);
            if(event.sequence()!=i+1L || !ids.add(event.id()) || event.changes().isEmpty()
                    || event.changes().stream().anyMatch(e->!event.id().equals(e.transactionId())
                        || "MIGRATION_OPENING".equals(e.eventType())))
                throw new IllegalStateException("集成事件身份、序号或事务范围无效");
        }
    }
}
