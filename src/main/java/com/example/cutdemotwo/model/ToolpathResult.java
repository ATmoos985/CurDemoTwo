package com.example.cutdemotwo.model;

import java.util.List;

public class ToolpathResult {
    private boolean success = true;
    private String message;
    private double startX;
    private double startY;
    private double originalAirDistance;
    private double optimizedAirDistance;
    private double savedAirDistance;
    private double savingRatio;
    private double cutDistance;
    private double totalDistance;
    private List<CutStep> optimizedCuts;

    public ToolpathResult() {}

    public boolean isSuccess() { return success; }
    public void setSuccess(boolean success) { this.success = success; }

    public String getMessage() { return message; }
    public void setMessage(String message) { this.message = message; }

    public double getStartX() { return startX; }
    public void setStartX(double startX) { this.startX = startX; }

    public double getStartY() { return startY; }
    public void setStartY(double startY) { this.startY = startY; }

    public double getOriginalAirDistance() { return originalAirDistance; }
    public void setOriginalAirDistance(double originalAirDistance) { this.originalAirDistance = originalAirDistance; }

    public double getOptimizedAirDistance() { return optimizedAirDistance; }
    public void setOptimizedAirDistance(double optimizedAirDistance) { this.optimizedAirDistance = optimizedAirDistance; }

    public double getSavedAirDistance() { return savedAirDistance; }
    public void setSavedAirDistance(double savedAirDistance) { this.savedAirDistance = savedAirDistance; }

    public double getSavingRatio() { return savingRatio; }
    public void setSavingRatio(double savingRatio) { this.savingRatio = savingRatio; }

    public double getCutDistance() { return cutDistance; }
    public void setCutDistance(double cutDistance) { this.cutDistance = cutDistance; }

    public double getTotalDistance() { return totalDistance; }
    public void setTotalDistance(double totalDistance) { this.totalDistance = totalDistance; }

    public List<CutStep> getOptimizedCuts() { return optimizedCuts; }
    public void setOptimizedCuts(List<CutStep> optimizedCuts) { this.optimizedCuts = optimizedCuts; }
}
