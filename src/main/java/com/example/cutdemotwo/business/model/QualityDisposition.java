package com.example.cutdemotwo.business.model;

/** Append-only quality event. Original production report and original material consumption stay unchanged. */
public record QualityDisposition(
        String id, String planId, Command command, Integer demandId, String originalOutcome,
        double pieceAreaMm2, double recoveredAreaMm2, double scrapAreaMm2,
        String remnantId, String createdAt) {
    public record Command(String operationId, int expectedRevision, int pieceId, String disposition,
                          String reason, String inspector, Recovery recovery) {}
    /** Coordinates are local to the already transformed produced piece, in mm. */
    public record Recovery(double x, double y, double width, double length, String location, String quality) {}
}
