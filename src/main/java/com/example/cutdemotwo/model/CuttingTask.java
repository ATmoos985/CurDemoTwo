package com.example.cutdemotwo.model;

import java.util.List;

/** A demand batch survives changing material and reporting several cutting stations. */
public record CuttingTask(String id, String name, String materialModel, String externalRef,
                          long revision, List<Line> demands, Process process) {
    public CuttingTask(String id, String name, String materialModel, String externalRef, long revision, List<Line> demands) {
        this(id, name, materialModel, externalRef, revision, demands, null);
    }
    public record Line(int id, String name, double width, double length, int quantity, boolean allowRotation) {}
    public record Process(double bedLength, double trimStart, String cutOrigin, String firstStageOrientation,
                          boolean allowRotation, boolean allowLongitudinal) {}
}
