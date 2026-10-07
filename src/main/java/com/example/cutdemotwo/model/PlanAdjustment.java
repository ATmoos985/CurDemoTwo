package com.example.cutdemotwo.model;

import java.util.List;

/** Either placement edits or a reordering of saved cuts; geometry and ownership remain server-owned. */
public record PlanAdjustment(String adjustmentId, List<Position> pieces, List<CutStep> cuts) {
    public PlanAdjustment(String adjustmentId, List<Position> pieces) { this(adjustmentId, pieces, null); }
    public record Position(int id, Double x, Double y, Boolean rotated) {}
}
