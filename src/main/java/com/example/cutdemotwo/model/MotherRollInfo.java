package com.example.cutdemotwo.model;

public class MotherRollInfo {
    private String rollId;          // 母卷编号，例如 ROLL-2026-0920
    private String rollModel;       // 母卷材质型号，例如 TC涤棉-B2026
    private double width;           // 幅宽 (mm)
    private double totalLength;     // 母卷总长 (mm)
    private int remnantCount;       // 从本卷切下的在库可用料头数量
    private double remnantTotalArea;// 在库料头总面积 (m²)

    public MotherRollInfo() {}

    public MotherRollInfo(String rollId, String rollModel, double width, double totalLength, int remnantCount, double remnantTotalArea) {
        this.rollId = rollId;
        this.rollModel = rollModel;
        this.width = width;
        this.totalLength = totalLength;
        this.remnantCount = remnantCount;
        this.remnantTotalArea = remnantTotalArea;
    }

    public String getRollId() { return rollId; }
    public void setRollId(String rollId) { this.rollId = rollId; }

    public String getRollModel() { return rollModel; }
    public void setRollModel(String rollModel) { this.rollModel = rollModel; }

    public double getWidth() { return width; }
    public void setWidth(double width) { this.width = width; }

    public double getTotalLength() { return totalLength; }
    public void setTotalLength(double totalLength) { this.totalLength = totalLength; }

    public int getRemnantCount() { return remnantCount; }
    public void setRemnantCount(int remnantCount) { this.remnantCount = remnantCount; }

    public double getRemnantTotalArea() { return remnantTotalArea; }
    public void setRemnantTotalArea(double remnantTotalArea) { this.remnantTotalArea = remnantTotalArea; }
}
