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
    public record Shape(
            String type, double width, double height, List<Point> vertices,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_EMPTY)
            List<List<Point>> holes
    ) {
        public Shape {
            vertices = vertices == null ? List.of() : List.copyOf(vertices);
            if (holes == null || holes.isEmpty()) {
                holes = List.of();
            } else {
                var normalized = new java.util.ArrayList<List<Point>>(holes.size());
                for (List<Point> hole : holes) {
                    normalized.add(hole == null ? List.of() : List.copyOf(hole));
                }
                holes = List.copyOf(normalized);
            }
        }
        public Shape(String type, double width, double height, List<Point> vertices) {
            this(type, width, height, vertices, List.of());
        }
        public static Shape rectangle(double width, double height) {
            return new Shape("RECTANGLE", width, height, List.of(), List.of());
        }
        @com.fasterxml.jackson.annotation.JsonIgnore
        public boolean hasHoles() {
            return !holes.isEmpty();
        }
        private static double ringAreaMm2(List<Point> ring) {
            if (ring == null || ring.size() < 3) return 0.0;
            double sum = 0.0;
            for (int i = 0; i < ring.size(); i++) {
                Point a = ring.get(i), b = ring.get((i + 1) % ring.size());
                sum += a.x() * b.y() - b.x() * a.y();
            }
            return Math.abs(sum) / 2.0;
        }
        /** 净实体面积（若含内孔洞则自动扣除所有内孔面积），独立于具体求解引擎。 */
        public double areaMm2() {
            double outer = "RECTANGLE".equals(type) ? Math.abs(width * height) : ringAreaMm2(vertices);
            if (holes.isEmpty()) return outer;
            double holeSum = 0.0;
            for (List<Point> hole : holes) {
                holeSum += ringAreaMm2(hole);
            }
            return Math.max(0.0, outer - holeSum);
        }
    }
    /** Optional fabric-level rule (e.g. curtain selvedge exclusion and bi-axial pattern repeat). */
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
            Double phaseYMm,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            Double repeatXMm,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            Double phaseXMm
    ) {
        public FabricRule(Double leftSelvedgeMm, Double rightSelvedgeMm, Boolean allowAuxiliaryInSelvedge,
                          Double repeatYMm, Double phaseYMm) {
            this(leftSelvedgeMm, rightSelvedgeMm, allowAuxiliaryInSelvedge, repeatYMm, phaseYMm, null, null);
        }
    }

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

    /** Optional per-part rule (role, bi-axial pattern matching, custom discrete angles, and consistent grain group). */
    public record PartRule(
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            String role,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            Boolean patternMatch,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            Double patternAnchorYMm,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            Double patternToleranceMm,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            List<Integer> allowedAnglesDeg,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            Double patternAnchorXMm,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            String grainGroupId
    ) {
        public PartRule {
            allowedAnglesDeg = allowedAnglesDeg == null
                    ? null
                    : java.util.Collections.unmodifiableList(new java.util.ArrayList<>(allowedAnglesDeg));
        }
        public PartRule(String role, Boolean patternMatch, Double patternAnchorYMm, Double patternToleranceMm) {
            this(role, patternMatch, patternAnchorYMm, patternToleranceMm, null, null, null);
        }
        public PartRule(String role, Boolean patternMatch, Double patternAnchorYMm, Double patternToleranceMm,
                        List<Integer> allowedAnglesDeg) {
            this(role, patternMatch, patternAnchorYMm, patternToleranceMm, allowedAnglesDeg, null, null);
        }
    }

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
            if (rule != null && rule.allowedAnglesDeg() != null && !rule.allowedAnglesDeg().isEmpty()) {
                var normalized = new java.util.LinkedHashSet<Integer>(rule.allowedAnglesDeg().size() * 2);
                for (Integer deg : rule.allowedAnglesDeg()) {
                    if (deg != null) {
                        normalized.add(Math.floorMod(deg, 360));
                    }
                }
                if (!normalized.isEmpty()) {
                    return List.copyOf(normalized);
                }
            }
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
                          double kerf, String objective, Double pieceGap,
                          @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
                          Integer maxStages) {
        public Process {
            // Older demo/API inputs omit the optional spacing constraint.
            pieceGap = pieceGap == null ? 0.0 : pieceGap;
        }
        public static void validatePieceGap(double value) {
            if (!Double.isFinite(value) || value < 0 || value > 100 || Math.abs(value * 10 - Math.rint(value * 10)) > .000001)
                throw new IllegalArgumentException("裁片间距应为 0–100 mm，精确到 0.1 mm");
        }
        public static void validateKerf(double value) {
            if (!Double.isFinite(value) || value < 0 || value > 50 || Math.abs(value * 10 - Math.rint(value * 10)) > .000001)
                throw new IllegalArgumentException("刀缝宽度 kerf 应为 0–50 mm，精确到 0.1 mm");
        }
        public Process(String mode, String feedMode, String startCorner, String firstStageOrientation,
                       double trimStart, double minReusableWidth, double minReusableHeight, double kerf, String objective) {
            this(mode, feedMode, startCorner, firstStageOrientation, trimStart, minReusableWidth, minReusableHeight, kerf, objective, 0.0, null);
        }
        public Process(String mode, String feedMode, String startCorner, String firstStageOrientation,
                       double trimStart, double minReusableWidth, double minReusableHeight, double kerf, String objective,
                       double pieceGap) {
            this(mode, feedMode, startCorner, firstStageOrientation, trimStart, minReusableWidth,
                    minReusableHeight, kerf, objective, Double.valueOf(pieceGap), null);
        }
        public Process(String mode, String feedMode, String startCorner, String firstStageOrientation,
                       double trimStart, double minReusableWidth, double minReusableHeight, double kerf, String objective,
                       Double pieceGap) {
            this(mode, feedMode, startCorner, firstStageOrientation, trimStart, minReusableWidth,
                    minReusableHeight, kerf, objective, pieceGap, null);
        }
    }

    public double width() { return material.shape().width(); }
    public double height() { return material.shape().height(); }
    public boolean sheet() { return "SHEET".equals(process.feedMode()); }
}
