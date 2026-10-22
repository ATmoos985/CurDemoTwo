package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.RemnantStock;
import java.util.*;

/** File compatibility boundary; JDBC stores each aggregate in its own keyed table. */
public record InventorySnapshot(List<MotherRollInfo> rolls, List<RemnantStock> remnants,
        Map<String, Map<String, Object>> receipts, int remnantSeq, int defectSeq,
        Map<String, CuttingTask> tasks, Map<String, CuttingPlan> plans, long revision,
        Map<String, com.example.cutdemotwo.business.model.ExecutionOrder> executions,
        List<com.example.cutdemotwo.business.model.InventoryLedgerEntry> ledger,
        Map<String,com.example.cutdemotwo.business.model.InventoryTransfer> transfers,
        List<com.example.cutdemotwo.business.model.InventoryEvent> outbox) {
    public InventorySnapshot {
        executions = executions == null ? Map.of() : Map.copyOf(executions);
        ledger = ledger == null ? List.of() : List.copyOf(ledger);
        transfers = transfers == null ? Map.of() : Map.copyOf(transfers);
        outbox = outbox == null ? List.of() : List.copyOf(outbox);
    }
    public InventorySnapshot(List<MotherRollInfo> rolls, List<RemnantStock> remnants,
            Map<String, Map<String,Object>> receipts, int remnantSeq,int defectSeq,
            Map<String,CuttingTask> tasks,Map<String,CuttingPlan> plans,long revision,
            Map<String,com.example.cutdemotwo.business.model.ExecutionOrder> executions,
            List<com.example.cutdemotwo.business.model.InventoryLedgerEntry> ledger,
            Map<String,com.example.cutdemotwo.business.model.InventoryTransfer> transfers) {
        this(rolls,remnants,receipts,remnantSeq,defectSeq,tasks,plans,revision,executions,ledger,transfers,List.of());
    }
    public InventorySnapshot(List<MotherRollInfo> rolls, List<RemnantStock> remnants,
            Map<String, Map<String,Object>> receipts, int remnantSeq,int defectSeq,
            Map<String,CuttingTask> tasks,Map<String,CuttingPlan> plans,long revision,
            Map<String,com.example.cutdemotwo.business.model.ExecutionOrder> executions,
            List<com.example.cutdemotwo.business.model.InventoryLedgerEntry> ledger) {
        this(rolls,remnants,receipts,remnantSeq,defectSeq,tasks,plans,revision,executions,ledger,Map.of());
    }
    public InventorySnapshot(List<MotherRollInfo> rolls, List<RemnantStock> remnants,
            Map<String, Map<String,Object>> receipts, int remnantSeq,int defectSeq,
            Map<String,CuttingTask> tasks,Map<String,CuttingPlan> plans,long revision,
            Map<String,com.example.cutdemotwo.business.model.ExecutionOrder> executions) {
        this(rolls,remnants,receipts,remnantSeq,defectSeq,tasks,plans,revision,executions,List.of());
    }
    public InventorySnapshot(List<MotherRollInfo> rolls, List<RemnantStock> remnants,
            Map<String, Map<String,Object>> receipts, int remnantSeq,int defectSeq,
            Map<String,CuttingTask> tasks,Map<String,CuttingPlan> plans,long revision) {
        this(rolls,remnants,receipts,remnantSeq,defectSeq,tasks,plans,revision,Map.of());
    }
    public InventorySnapshot withRevision(long value) {
        return new InventorySnapshot(rolls, remnants, receipts, remnantSeq, defectSeq, tasks, plans, value, executions, ledger, transfers, outbox);
    }
}
