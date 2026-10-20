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
        Map<String, com.example.cutdemotwo.business.model.ExecutionOrder> executions) {
    public InventorySnapshot { executions = executions == null ? Map.of() : Map.copyOf(executions); }
    public InventorySnapshot(List<MotherRollInfo> rolls, List<RemnantStock> remnants,
            Map<String, Map<String,Object>> receipts, int remnantSeq,int defectSeq,
            Map<String,CuttingTask> tasks,Map<String,CuttingPlan> plans,long revision) {
        this(rolls,remnants,receipts,remnantSeq,defectSeq,tasks,plans,revision,Map.of());
    }
    public InventorySnapshot withRevision(long value) {
        return new InventorySnapshot(rolls, remnants, receipts, remnantSeq, defectSeq, tasks, plans, value, executions);
    }
}
