package com.example.cutdemotwo.service.solver;

import com.example.cutdemotwo.model.CutStep;
import com.example.cutdemotwo.model.PlacedPiece;
import com.example.cutdemotwo.model.RemnantPiece;
import com.example.cutdemotwo.model.nesting.NestingResult;
import java.util.ArrayList;
import java.util.List;

/** Internal candidates. Rectangle engines retain their cut-tree data; contour engines return actual shapes. */
public class EngineResult {
    private boolean success;
    private String message;
    private String failureStatus = "FAILED";
    private List<PlacedPiece> pieces = new ArrayList<>();
    private List<RemnantPiece> remnants = new ArrayList<>();
    private List<CutStep> cuts = new ArrayList<>();
    private double suggestedFeedLength;
    private List<NestingResult.Placement> placements = new ArrayList<>();

    public List<NestingResult.Placement> getPlacements() { return placements; }
    public void setPlacements(List<NestingResult.Placement> value) { placements = value; }

    public boolean isSuccess() { return success; }
    public void setSuccess(boolean value) { success = value; }
    public String getMessage() { return message; }
    public void setMessage(String value) { message = value; }
    public String getFailureStatus() { return failureStatus; }
    public void setFailureStatus(String value) { failureStatus = value; }
    public List<PlacedPiece> getPieces() { return pieces; }
    public void setPieces(List<PlacedPiece> value) { pieces = value; }
    public List<RemnantPiece> getRemnants() { return remnants; }
    public void setRemnants(List<RemnantPiece> value) { remnants = value; }
    public List<CutStep> getCuts() { return cuts; }
    public void setCuts(List<CutStep> value) { cuts = value; }
    public double getSuggestedFeedLength() { return suggestedFeedLength; }
    public void setSuggestedFeedLength(double value) { suggestedFeedLength = value; }
}
