package com.example.cutdemotwo.model;

public class CutStep {
    private int step;
    private String type;
    private double pos;
    private double start;
    private double end;
    private String desc;

    private Double startX;
    private Double startY;
    private Double endX;
    private Double endY;
    private Double airDistance;

    public CutStep() {}

    public CutStep(int step, String type, double pos, double start, double end, String desc) {
        this.step = step;
        this.type = type;
        this.pos = pos;
        this.start = start;
        this.end = end;
        this.desc = desc;
        // Default directional assignment
        if ("横切".equals(type)) {
            this.startX = Math.min(start, end);
            this.startY = pos;
            this.endX = Math.max(start, end);
            this.endY = pos;
        } else {
            this.startX = pos;
            this.startY = Math.min(start, end);
            this.endX = pos;
            this.endY = Math.max(start, end);
        }
    }

    public int getStep() { return step; }
    public void setStep(int step) { this.step = step; }

    public String getType() { return type; }
    public void setType(String type) { this.type = type; }

    public double getPos() { return pos; }
    public void setPos(double pos) { this.pos = pos; }

    public double getStart() { return start; }
    public void setStart(double start) { this.start = start; }

    public double getEnd() { return end; }
    public void setEnd(double end) { this.end = end; }

    public String getDesc() { return desc; }
    public void setDesc(String desc) { this.desc = desc; }

    public Double getStartX() { return startX; }
    public void setStartX(Double startX) { this.startX = startX; }

    public Double getStartY() { return startY; }
    public void setStartY(Double startY) { this.startY = startY; }

    public Double getEndX() { return endX; }
    public void setEndX(Double endX) { this.endX = endX; }

    public Double getEndY() { return endY; }
    public void setEndY(Double endY) { this.endY = endY; }

    public Double getAirDistance() { return airDistance; }
    public void setAirDistance(Double airDistance) { this.airDistance = airDistance; }
}
