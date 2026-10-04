package com.example.cutdemotwo.model;

import java.util.List;

public record CutReport(String planId, double actualCutLen, int finishedPieceCount,
                        List<RemnantPiece> actualRemnants, String location, List<PieceResult> pieceResults) {
    public CutReport(String planId, double actualCutLen, int finishedPieceCount, List<RemnantPiece> actualRemnants, String location) {
        this(planId, actualCutLen, finishedPieceCount, actualRemnants, location, null);
    }
    public record PieceResult(int pieceId, String outcome, String reason) {}
}
