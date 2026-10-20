package com.example.cutdemotwo.business.model;

import com.example.cutdemotwo.contracts.geometry.CutStep;

import java.util.List;

/** Either placement edits or a reordering of saved cuts; geometry and ownership remain server-owned. */
public record PlanAdjustment(String adjustmentId, List<Position> pieces, List<CutStep> cuts) {
    public PlanAdjustment(String adjustmentId, List<Position> pieces) { this(adjustmentId, pieces, null); }
    public record Position(int id, Double x, Double y, Boolean rotated, Integer rotationDegrees) {
        public Position(int id, Double x, Double y, Boolean rotated) { this(id,x,y,rotated,null); }
    }
}
