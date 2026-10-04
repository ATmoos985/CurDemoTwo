package com.example.cutdemotwo.model;

import java.util.List;

/** Only positions and orientation are editable; sizes, ownership and process come from the saved plan. */
public record PlanAdjustment(String adjustmentId, List<Position> pieces) {
    public record Position(int id, Double x, Double y, Boolean rotated) {}
}
