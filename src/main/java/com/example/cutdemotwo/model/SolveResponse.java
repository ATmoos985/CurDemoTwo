package com.example.cutdemotwo.model;

import java.util.ArrayList;
import java.util.List;

public class SolveResponse {
    private boolean success;
    private String message;
    private String engine;
    private double rollW;
    private double rollL;
    private List<PlacedPiece> pieces = new ArrayList<>();
    private List<RemnantPiece> remnants = new ArrayList<>();
    private List<CutStep> cuts = new ArrayList<>();
    private List<Defect> defects = new ArrayList<>();
    private double deductLen;
    private double pieceArea;
    private double remArea;
    private double wasteArea;
    private double totalArea;
    private String feedPortType = "roll";
    private String sourceRemnantId;
    private List<RemnantStock> derivedRemnants = new ArrayList<>();

    public SolveResponse() {}

    public String getFeedPortType() { return feedPortType; }
    public void setFeedPortType(String feedPortType) { this.feedPortType = feedPortType; }

    public String getSourceRemnantId() { return sourceRemnantId; }
    public void setSourceRemnantId(String sourceRemnantId) { this.sourceRemnantId = sourceRemnantId; }

    public List<RemnantStock> getDerivedRemnants() { return derivedRemnants; }
    public void setDerivedRemnants(List<RemnantStock> derivedRemnants) { this.derivedRemnants = derivedRemnants; }

    public boolean isSuccess() { return success; }
    public void setSuccess(boolean success) { this.success = success; }

    public String getMessage() { return message; }
    public void setMessage(String message) { this.message = message; }

    public String getEngine() { return engine; }
    public void setEngine(String engine) { this.engine = engine; }

    public double getRollW() { return rollW; }
    public void setRollW(double rollW) { this.rollW = rollW; }

    public double getRollL() { return rollL; }
    public void setRollL(double rollL) { this.rollL = rollL; }

    public List<PlacedPiece> getPieces() { return pieces; }
    public void setPieces(List<PlacedPiece> pieces) { this.pieces = pieces; }

    public List<RemnantPiece> getRemnants() { return remnants; }
    public void setRemnants(List<RemnantPiece> remnants) { this.remnants = remnants; }

    public List<CutStep> getCuts() { return cuts; }
    public void setCuts(List<CutStep> cuts) { this.cuts = cuts; }

    public List<Defect> getDefects() { return defects; }
    public void setDefects(List<Defect> defects) { this.defects = defects; }

    public double getDeductLen() { return deductLen; }
    public void setDeductLen(double deductLen) { this.deductLen = deductLen; }

    public double getPieceArea() { return pieceArea; }
    public void setPieceArea(double pieceArea) { this.pieceArea = pieceArea; }

    public double getRemArea() { return remArea; }
    public void setRemArea(double remArea) { this.remArea = remArea; }

    public double getWasteArea() { return wasteArea; }
    public void setWasteArea(double wasteArea) { this.wasteArea = wasteArea; }

    public double getTotalArea() { return totalArea; }
    public void setTotalArea(double totalArea) { this.totalArea = totalArea; }
}
