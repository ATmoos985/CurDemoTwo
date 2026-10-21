package com.example.cutdemotwo.business.model;

import java.util.List;

/** Immutable accounting fact. JSON values retain exact geometry and lineage, quantities use mm / m² / pieces. */
public record InventoryLedgerEntry(String id, long sequence, String transactionId, String eventType,
        String aggregateType, String aggregateId, String businessId, List<String> sourceReportIds,
        String actor, long occurredAt, long beforeVersion, long afterVersion,
        List<String> reverses, String beforeJson, String afterJson) {
    public InventoryLedgerEntry {
        sourceReportIds = List.copyOf(sourceReportIds);
        reverses = List.copyOf(reverses);
    }
    public static void requireAppendOnly(List<InventoryLedgerEntry> previous, List<InventoryLedgerEntry> next) {
        if (next.size() < previous.size() || !next.subList(0, previous.size()).equals(previous))
            throw new IllegalStateException("库存流水不可修改或删除；请追加冲销记录");
        var ids = new java.util.HashSet<String>();
        for (int i = 0; i < next.size(); i++) {
            var entry = next.get(i);
            if (entry.sequence() != i + 1L || !ids.add(entry.id()))
                throw new IllegalStateException("库存流水序号或身份不连续");
        }
    }
}
