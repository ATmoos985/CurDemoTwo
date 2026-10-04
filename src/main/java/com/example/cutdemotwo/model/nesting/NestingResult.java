package com.example.cutdemotwo.model.nesting;

import java.util.List;

/** Geometry uses mm and mm² throughout; coordinates never include business station offsets. */
public record NestingResult(
        String schemaVersion, String unit, String coordinateSystem, String status, String message,
        String engine, String engineVersion, long elapsedMs, String materialId,
        NestingProblem.Shape processingRegion, List<Placement> placements, List<Leftover> leftovers,
        List<Cut> cuts, List<Fulfillment> fulfillment, Metrics metrics, List<Contour> contours) {
    public boolean feasible() { return "FEASIBLE".equals(status); }
    public record Placement(int id, int demandId, String name, double x, double y,
                            NestingProblem.Shape shape, int rotationDegrees) {}
    public record Leftover(String id, double x, double y, NestingProblem.Shape shape, boolean hasDefect) {}
    public record Cut(int sequence, String kind, double startX, double startY, double endX, double endY,
                      double airDistanceMm, String description) {}
    /** Closed part boundaries in source coordinates; not an executable or ordered machine toolpath. */
    public record Contour(int placementId, List<NestingProblem.Point> vertices, boolean closed) {}
    public record Fulfillment(int demandId, int requested, int placed, int unplaced, String reason) {}
    /** Unassigned area includes untouched material; it must not be treated as confirmed scrap. */
    public record Metrics(double processingAreaMm2, double pieceAreaMm2, double reusableAreaMm2,
                          double unassignedAreaMm2, double suggestedFeedLengthMm) {}

    public static NestingResult failure(String status, String message, String engine, long elapsedMs) {
        return new NestingResult("1", "mm", "source-local-top-left", status, message, engine, "1", elapsedMs,
                null, null, List.of(), List.of(), List.of(), List.of(), null, List.of());
    }
}
