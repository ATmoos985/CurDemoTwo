package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.model.*;
import java.util.*;

/** File compatibility boundary; JDBC stores each aggregate in its own keyed table. */
public record InventorySnapshot(List<MotherRollInfo> rolls, List<RemnantStock> remnants,
        Map<String, Map<String, Object>> receipts, int remnantSeq, int defectSeq,
        Map<String, CuttingTask> tasks, Map<String, CuttingPlan> plans, long revision) {
    public InventorySnapshot withRevision(long value) {
        return new InventorySnapshot(rolls, remnants, receipts, remnantSeq, defectSeq, tasks, plans, value);
    }
}
