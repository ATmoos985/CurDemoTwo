package com.example.cutdemotwo.model;

import java.util.ArrayList;
import java.util.List;

/**
 * 工业裁切回收料头库存档案与血统溯源模型 (Remnant Stock & Lineage)
 */
public class RemnantStock {
    private String id;               // 料头唯一编号/条码，例如 REM-202609-001
    private double width;            // 幅宽 (mm)
    private double length;           // 长度 (mm)
    private String location;         // 存放库位，例如 "库位 A-01-03"
    private String materialBatch;    // 材质与批次，例如 "TC涤棉-B2026"
    private String status;           // 状态: "AVAILABLE"(在库可用), "IN_USE"(加工中), "CONSUMED"(已领用核销), "SCRAPPED"(已报废)
    private String parentRemnantId;  // 父级料头编号(若由旧料头套裁派生)
    private String sourceRollId;     // 直系来源母卷号，例如 "ROLL-2026-0920"
    private int generation = 1;      // 代数: 1=母卷直切一代料头, 2=子料头套裁二代
    private String qualityGrade = "GRADE_A"; // 质量评级: GRADE_A(优质完好), GRADE_B(边角可用), GRADE_DEFECT(带疵隔离)
    private boolean hasDefect;       // 是否带疵
    private String defectDesc;       // 瑕疵描述
    private List<Defect> defects = new ArrayList<>(); // 内部瑕疵坐标(相对料头)
    private String createdAt;        // 入库登记时间
    private String consumedAt;       // 领用核销时间
    private String consumedByOrder;  // 消耗工单号

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
        this.qualityGrade = hasDefect ? "GRADE_DEFECT" : "GRADE_A";
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

    public int getGeneration() { return generation; }
    public void setGeneration(int generation) { this.generation = generation; }

    public String getQualityGrade() { return qualityGrade; }
    public void setQualityGrade(String qualityGrade) { this.qualityGrade = qualityGrade; }

    public boolean isHasDefect() { return hasDefect; }
    public void setHasDefect(boolean hasDefect) {
        this.hasDefect = hasDefect;
        if (hasDefect && "GRADE_A".equals(this.qualityGrade)) {
            this.qualityGrade = "GRADE_DEFECT";
        }
    }

    public String getDefectDesc() { return defectDesc; }
    public void setDefectDesc(String defectDesc) { this.defectDesc = defectDesc; }

    public List<Defect> getDefects() { return defects; }
    public void setDefects(List<Defect> defects) { this.defects = defects; }

    public String getCreatedAt() { return createdAt; }
    public void setCreatedAt(String createdAt) { this.createdAt = createdAt; }

    public String getConsumedAt() { return consumedAt; }
    public void setConsumedAt(String consumedAt) { this.consumedAt = consumedAt; }

    public String getConsumedByOrder() { return consumedByOrder; }
    public void setConsumedByOrder(String consumedByOrder) { this.consumedByOrder = consumedByOrder; }
}
