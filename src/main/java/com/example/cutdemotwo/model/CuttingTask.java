package com.example.cutdemotwo.model;

import java.util.List;

/** A demand batch survives changing material and reporting several cutting stations. */
public record CuttingTask(String id, String name, String materialModel, String externalRef,
                          long revision, List<Line> demands, Process process) {
    public CuttingTask(String id, String name, String materialModel, String externalRef, long revision, List<Line> demands) {
        this(id, name, materialModel, externalRef, revision, demands, null);
    }
    public record Line(int id, String name, double width, double length, int quantity, boolean allowRotation,
                       com.example.cutdemotwo.model.nesting.NestingProblem.Shape shape) {
        public Line(int id, String name, double width, double length, int quantity, boolean allowRotation) {
            this(id, name, width, length, quantity, allowRotation, null);
        }
    }
    public record Process(double bedLength, double trimStart, String cutOrigin, String firstStageOrientation,
                          boolean allowRotation, boolean allowLongitudinal, Double pieceGap) {
        public Process { pieceGap = pieceGap == null ? 0.0 : pieceGap; }
        public Process(double bedLength, double trimStart, String cutOrigin, String firstStageOrientation,
                       boolean allowRotation, boolean allowLongitudinal) {
            this(bedLength, trimStart, cutOrigin, firstStageOrientation, allowRotation, allowLongitudinal, 0.0);
        }
    }
}
