package com.example.cutdemotwo.model;

import java.util.ArrayList;
import java.util.List;

public class RemnantStock {
    private String id;               // 料头唯一编号，例如 REM-202609-001
    private double width;            // 幅宽 (mm)
    private double length;           // 长度 (mm)
    private String location;         // 存放库位，例如 "库位 A-03-01"
    private String materialBatch;    // 材质与批次，例如 "TC涤棉-B2026"
    private String status;           // 状态: "AVAILABLE"(在库可用), "IN_USE"(加工中), "CONSUMED"(已领用核销)
    private String parentRemnantId;  // 父级料头编号(若为子料头派生)
    private String sourceRollId;     // 来源母卷号，例如 "ROLL-2026-0920"
    private boolean hasDefect;       // 是否带疵
    private String defectDesc;       // 瑕疵描述
    private List<Defect> defects = new ArrayList<>(); // 内部瑕疵坐标(相对料头)
    private String createdAt;        // 入库登记时间

    public RemnantStock() {}

    public RemnantStock(String id, double width, double length, String location, String materialBatch,
                        String status, String sourceRollId, boolean hasDefect, String defectDesc) {
        this.id = id;
        this.width = width;
        this.length = length;
        this.location = location;
        this.materialBatch = materialBatch;
        this.status = status;
        this.sourceRollId = sourceRollId;
        this.hasDefect = hasDefect;
        this.defectDesc = defectDesc;
    }

    public double getArea() {
        return (width * length) / 1_000_000.0; // 平方米
    }

    // Getters and Setters
    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public double getWidth() { return width; }
    public void setWidth(double width) { this.width = width; }

    public double getLength() { return length; }
    public void setLength(double length) { this.length = length; }

    public String getLocation() { return location; }
    public void setLocation(String location) { this.location = location; }

    public String getMaterialBatch() { return materialBatch; }
    public void setMaterialBatch(String materialBatch) { this.materialBatch = materialBatch; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public String getParentRemnantId() { return parentRemnantId; }
    public void setParentRemnantId(String parentRemnantId) { this.parentRemnantId = parentRemnantId; }

    public String getSourceRollId() { return sourceRollId; }
    public void setSourceRollId(String sourceRollId) { this.sourceRollId = sourceRollId; }

    public boolean isHasDefect() { return hasDefect; }
    public void setHasDefect(boolean hasDefect) { this.hasDefect = hasDefect; }

    public String getDefectDesc() { return defectDesc; }
    public void setDefectDesc(String defectDesc) { this.defectDesc = defectDesc; }

    public List<Defect> getDefects() { return defects; }
    public void setDefects(List<Defect> defects) { this.defects = defects; }

    public String getCreatedAt() { return createdAt; }
    public void setCreatedAt(String createdAt) { this.createdAt = createdAt; }
}
