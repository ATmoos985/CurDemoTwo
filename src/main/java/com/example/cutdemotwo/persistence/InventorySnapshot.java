package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.DemandTemplate;
import com.example.cutdemotwo.business.model.InventoryReceiptDocument;
import com.example.cutdemotwo.business.model.MaterialIssueDocument;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.QualityReleaseDocument;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.*;

/** File compatibility boundary; JDBC stores each aggregate in its own keyed table. */
public record InventorySnapshot(List<MotherRollInfo> rolls, List<RemnantStock> remnants,
        Map<String, Map<String, Object>> receipts, int remnantSeq, int defectSeq,
        Map<String, CuttingTask> tasks, Map<String, CuttingPlan> plans, long revision,
        Map<String, com.example.cutdemotwo.business.model.ExecutionOrder> executions,
        List<com.example.cutdemotwo.business.model.InventoryLedgerEntry> ledger,
        Map<String,com.example.cutdemotwo.business.model.InventoryTransfer> transfers,
        List<com.example.cutdemotwo.business.model.InventoryEvent> outbox,
        Map<String,com.example.cutdemotwo.business.model.InventoryCount> counts,
        @JsonInclude(JsonInclude.Include.NON_EMPTY) Map<String, DemandTemplate> templates,
        @JsonInclude(JsonInclude.Include.NON_EMPTY) Map<String, SchedulingScheme> schemes,
        @JsonInclude(JsonInclude.Include.NON_EMPTY) Map<String, QualityReleaseDocument> qualityReleases,
        @JsonInclude(JsonInclude.Include.NON_EMPTY) Map<String, InventoryReceiptDocument> inventoryReceipts,
        @JsonInclude(JsonInclude.Include.NON_EMPTY) Map<String, MaterialIssueDocument> materialIssues) {
    public InventorySnapshot {
        executions = orderedCopy(executions);
        ledger = ledger == null ? List.of() : List.copyOf(ledger);
        transfers = orderedCopy(transfers);
        outbox = outbox == null ? List.of() : List.copyOf(outbox);
        counts = orderedCopy(counts);
        templates = orderedCopy(templates);
        schemes = orderedCopy(schemes);
        qualityReleases = orderedCopy(qualityReleases);
        inventoryReceipts = orderedCopy(inventoryReceipts);
        materialIssues = orderedCopy(materialIssues);
    }

    /** 保持 LinkedHashMap 确定性迭代顺序，防止跨重启哈希盐变化引发 JDBC sync 整表无效 UPDATE。 */
    private static <K, V> Map<K, V> orderedCopy(Map<K, V> source) {
        if (source == null || source.isEmpty()) return Map.of();
        return Collections.unmodifiableMap(new LinkedHashMap<>(source));
    }
    public InventorySnapshot(List<MotherRollInfo> rolls, List<RemnantStock> remnants,
            Map<String, Map<String, Object>> receipts, int remnantSeq, int defectSeq,
            Map<String, CuttingTask> tasks, Map<String, CuttingPlan> plans, long revision,
            Map<String, com.example.cutdemotwo.business.model.ExecutionOrder> executions,
            List<com.example.cutdemotwo.business.model.InventoryLedgerEntry> ledger,
            Map<String,com.example.cutdemotwo.business.model.InventoryTransfer> transfers,
            List<com.example.cutdemotwo.business.model.InventoryEvent> outbox,
            Map<String,com.example.cutdemotwo.business.model.InventoryCount> counts,
            Map<String, DemandTemplate> templates,
            Map<String, SchedulingScheme> schemes) {
        this(rolls, remnants, receipts, remnantSeq, defectSeq, tasks, plans, revision, executions, ledger, transfers, outbox, counts, templates, schemes, Map.of(), Map.of(), Map.of());
    }
    public InventorySnapshot(List<MotherRollInfo> rolls, List<RemnantStock> remnants,
            Map<String, Map<String, Object>> receipts, int remnantSeq, int defectSeq,
            Map<String, CuttingTask> tasks, Map<String, CuttingPlan> plans, long revision,
            Map<String, com.example.cutdemotwo.business.model.ExecutionOrder> executions,
            List<com.example.cutdemotwo.business.model.InventoryLedgerEntry> ledger,
            Map<String,com.example.cutdemotwo.business.model.InventoryTransfer> transfers,
            List<com.example.cutdemotwo.business.model.InventoryEvent> outbox,
            Map<String,com.example.cutdemotwo.business.model.InventoryCount> counts) {
        this(rolls, remnants, receipts, remnantSeq, defectSeq, tasks, plans, revision, executions, ledger, transfers, outbox, counts, Map.of(), Map.of());
    }
    public InventorySnapshot(List<MotherRollInfo> rolls, List<RemnantStock> remnants,
            Map<String, Map<String,Object>> receipts, int remnantSeq,int defectSeq,
            Map<String,CuttingTask> tasks,Map<String,CuttingPlan> plans,long revision,
            Map<String,com.example.cutdemotwo.business.model.ExecutionOrder> executions,
            List<com.example.cutdemotwo.business.model.InventoryLedgerEntry> ledger,
            Map<String,com.example.cutdemotwo.business.model.InventoryTransfer> transfers,
            List<com.example.cutdemotwo.business.model.InventoryEvent> outbox) {
        this(rolls,remnants,receipts,remnantSeq,defectSeq,tasks,plans,revision,executions,ledger,transfers,outbox,Map.of());
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
        return new InventorySnapshot(rolls, remnants, receipts, remnantSeq, defectSeq, tasks, plans, value,
                executions, ledger, transfers, outbox, counts, templates, schemes,
                qualityReleases, inventoryReceipts, materialIssues);
    }
}
