package com.example.cutdemotwo.business.model;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonInclude;

/** Append-only quality event. Original production report and original material consumption stay unchanged. */
public record QualityDisposition(
        String id, String planId, Command command, Integer demandId, String originalOutcome,
        double pieceAreaMm2, double recoveredAreaMm2, double scrapAreaMm2,
        String remnantId, String createdAt,
        @JsonInclude(JsonInclude.Include.NON_NULL) Revocation revocation) {
    public QualityDisposition(
            String id, String planId, Command command, Integer demandId, String originalOutcome,
            double pieceAreaMm2, double recoveredAreaMm2, double scrapAreaMm2,
            String remnantId, String createdAt) {
        this(id, planId, command, demandId, originalOutcome, pieceAreaMm2, recoveredAreaMm2, scrapAreaMm2,
                remnantId, createdAt, null);
    }

    @JsonIgnore
    public boolean hasRevocation() { return revocation != null; }

    public QualityDisposition withRevocation(Revocation nextRevocation) {
        return new QualityDisposition(id, planId, command, demandId, originalOutcome,
                pieceAreaMm2, recoveredAreaMm2, scrapAreaMm2, remnantId, createdAt, nextRevocation);
    }

    public record Command(String operationId, int expectedRevision, int pieceId, String disposition,
                          String reason, String inspector, Recovery recovery) {}
    /** Coordinates are local to the already transformed produced piece, in mm. */
    public record Recovery(double x, double y, double width, double length, String location, String quality) {}
    /** 受控撤销留痕：保留原始处置事实，追加撤销幂等键、经办人、原因与时间。 */
    public record Revocation(String idempotencyKey, String operator, String reason, String revokedAt) {}
}
