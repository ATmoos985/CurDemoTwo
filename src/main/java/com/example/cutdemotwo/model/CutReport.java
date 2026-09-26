package com.example.cutdemotwo.model;

import java.util.List;

public record CutReport(String planId, double actualCutLen, int finishedPieceCount,
                        List<RemnantPiece> actualRemnants, String location) {}
