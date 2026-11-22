package com.example.cutdemotwo.contracts.nesting;

import java.util.List;

/** A complete, source-local cutting problem. Contains no inventory or task state. */
public record NestingProblem(
        String schemaVersion, String unit, Material material, List<Part> parts,
        Process process, String engine, int timeLimitSeconds) implements com.example.cutdemotwo.contracts.jobs.OptimizationProblem {
    public NestingProblem {
        parts = parts == null ? List.of() : List.copyOf(parts);
    }

    public record Point(double x, double y) {}
    public record Shape(String type, double width, double height, List<Point> vertices) {
        public Shape { vertices = vertices == null ? List.of() : List.copyOf(vertices); }
        public static Shape rectangle(double width, double height) {
            return new Shape("RECTANGLE", width, height, List.of());
        }
        /** Net shape area; independent of engines and their validation/runtime. */
        public double areaMm2() {
            if ("RECTANGLE".equals(type)) return Math.abs(width * height);
            double sum = 0;
            for (int i = 0; i < vertices.size(); i++) {
                Point a = vertices.get(i), b = vertices.get((i + 1) % vertices.size());
                sum += a.x() * b.y() - b.x() * a.y();
            }
            return Math.abs(sum) / 2;
        }
    }
    /** Optional fabric-level rule (e.g. curtain selvedge exclusion and vertical pattern repeat). */
    public record FabricRule(
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            Double leftSelvedgeMm,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            Double rightSelvedgeMm,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            Boolean allowAuxiliaryInSelvedge,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            Double repeatYMm,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            Double phaseYMm
    ) {}

    /** Material is precisely the region submitted for this solve, at local (0,0). */
    public record Material(
            String id, Shape shape, List<Exclusion> exclusions, boolean continuesAfterRegion,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            FabricRule fabricRule
    ) {
        public Material { exclusions = exclusions == null ? List.of() : List.copyOf(exclusions); }
        public Material(String id, Shape shape, List<Exclusion> exclusions, boolean continuesAfterRegion) {
            this(id, shape, exclusions, continuesAfterRegion, null);
        }
    }

    public record Exclusion(
            int id, double x, double y, Shape shape, double clearance,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            Integer severity,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            String avoidancePolicy
    ) {
        public Exclusion(int id, double x, double y, Shape shape, double clearance) {
            this(id, x, y, shape, clearance, null, null);
        }
    }

    /** Optional per-part rule (e.g. role MAIN/AUXILIARY and pattern-matching alignment). */
    public record PartRule(
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            String role,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            Boolean patternMatch,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            Double patternAnchorYMm,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            Double patternToleranceMm
    ) {}

    public record Part(
            int id, String name, Shape shape, int quantity, boolean allowRotation,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            Boolean allowHalfTurn,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            PartRule rule
    ) {
        public Part(int id, String name, Shape shape, int quantity, boolean allowRotation) {
            this(id, name, shape, quantity, allowRotation, null, null);
        }
        public Part(int id, String name, Shape shape, int quantity, boolean allowRotation, Boolean allowHalfTurn) {
            this(id, name, shape, quantity, allowRotation, allowHalfTurn, null);
        }
        public List<Integer> contourAngles() {
            if (allowRotation) return List.of(0, 90, 180, 270);
            return Boolean.TRUE.equals(allowHalfTurn) ? List.of(0, 180) : List.of(0);
        }
        @com.fasterxml.jackson.annotation.JsonIgnore
        public boolean isAuxiliary() {
            return rule != null && "AUXILIARY".equalsIgnoreCase(rule.role());
        }
    }
    public record Process(String mode, String feedMode, String startCorner, String firstStageOrientation,
                          double trimStart, double minReusableWidth, double minReusableHeight,
                          double kerf, String objective, Double pieceGap) {
        public Process {
            // Older demo/API inputs omit the optional spacing constraint.
            pieceGap = pieceGap == null ? 0.0 : pieceGap;
        }
        public static void validatePieceGap(double value) {
            if (!Double.isFinite(value) || value < 0 || value > 100 || Math.abs(value * 10 - Math.rint(value * 10)) > .000001)
                throw new IllegalArgumentException("裁片间距应为 0–100 mm，精确到 0.1 mm");
        }
        public Process(String mode, String feedMode, String startCorner, String firstStageOrientation,
                       double trimStart, double minReusableWidth, double minReusableHeight, double kerf, String objective) {
            this(mode, feedMode, startCorner, firstStageOrientation, trimStart, minReusableWidth, minReusableHeight, kerf, objective, 0.0);
        }
        public Process(String mode, String feedMode, String startCorner, String firstStageOrientation,
                       double trimStart, double minReusableWidth, double minReusableHeight, double kerf, String objective,
                       double pieceGap) {
            this(mode, feedMode, startCorner, firstStageOrientation, trimStart, minReusableWidth,
                    minReusableHeight, kerf, objective, Double.valueOf(pieceGap));
        }
    }

    public double width() { return material.shape().width(); }
    public double height() { return material.shape().height(); }
    public boolean sheet() { return "SHEET".equals(process.feedMode()); }
}
