package com.example.cutdemotwo.model;

public class CutStep {
    private int step;
    private String type;
    private double pos;
    private double start;
    private double end;
    private String desc;

    public CutStep() {}

    public CutStep(int step, String type, double pos, double start, double end, String desc) {
        this.step = step;
        this.type = type;
        this.pos = pos;
        this.start = start;
        this.end = end;
        this.desc = desc;
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
}
