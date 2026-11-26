package com.example.cutdemotwo.contracts.jobs;

import java.util.Map;

/** Immutable workbench provenance stored alongside a job, never part of the solver input. */
public record WorkbenchJobSource(String taskId, String actor, long taskRevision, String materialType,
                                 String materialId, long materialRevision, double physicalWidthMm,
                                 double windowStartMm, double windowLengthMm, double rectGapPaddingMm,
                                 Map<Integer, Integer> sourceLines) {
    public WorkbenchJobSource {
        sourceLines = Map.copyOf(sourceLines);
    }
}
