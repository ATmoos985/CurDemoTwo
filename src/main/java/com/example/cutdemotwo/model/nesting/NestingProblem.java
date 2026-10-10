package com.example.cutdemotwo.model.nesting;

import java.util.List;

/** A complete, source-local cutting problem. Contains no inventory or task state. */
public record NestingProblem(
        String schemaVersion, String unit, Material material, List<Part> parts,
        Process process, String engine, int timeLimitSeconds) {
    public NestingProblem {
        parts = parts == null ? List.of() : List.copyOf(parts);
    }

    public record Point(double x, double y) {}
    public record Shape(String type, double width, double height, List<Point> vertices) {
        public Shape { vertices = vertices == null ? List.of() : List.copyOf(vertices); }
        public static Shape rectangle(double width, double height) {
            return new Shape("RECTANGLE", width, height, List.of());
        }
    }
    /** Material is precisely the region submitted for this solve, at local (0,0). */
    public record Material(String id, Shape shape, List<Exclusion> exclusions, boolean continuesAfterRegion) {
        public Material { exclusions = exclusions == null ? List.of() : List.copyOf(exclusions); }
    }
    public record Exclusion(int id, double x, double y, Shape shape, double clearance) {}
    public record Part(int id, String name, Shape shape, int quantity, boolean allowRotation) {}
    public record Process(String mode, String feedMode, String startCorner, String firstStageOrientation,
                          double trimStart, double minReusableWidth, double minReusableHeight,
                          double kerf, String objective) {}

    public double width() { return material.shape().width(); }
    public double height() { return material.shape().height(); }
    public boolean sheet() { return "SHEET".equals(process.feedMode()); }
}
