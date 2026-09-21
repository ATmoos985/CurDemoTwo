package com.example.cutdemotwo.model;

import java.util.List;

public class ToolpathRequest {
    private List<CutStep> cuts;
    private double homeX = 2000.0;
    private double homeY = 5000.0;
    private boolean respectPrecedence = true;

    public ToolpathRequest() {}

    public List<CutStep> getCuts() { return cuts; }
    public void setCuts(List<CutStep> cuts) { this.cuts = cuts; }

    public double getHomeX() { return homeX; }
    public void setHomeX(double homeX) { this.homeX = homeX; }

    public double getHomeY() { return homeY; }
    public void setHomeY(double homeY) { this.homeY = homeY; }

    public boolean isRespectPrecedence() { return respectPrecedence; }
    public void setRespectPrecedence(boolean respectPrecedence) { this.respectPrecedence = respectPrecedence; }
}
