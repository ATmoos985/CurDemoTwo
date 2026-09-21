package com.example.cutdemotwo.model;

import java.util.ArrayList;
import java.util.List;

/**
 * 工业母卷 (Master Roll) 完整业务属性档案模型
 * 贯通 ERP/MES 物料台账、织造染色工艺参数、AI 验布疵点全景与动态库存
 */
public class MotherRollInfo {
    // 基础物料标识
    private String rollId;                  // 母卷唯一编码/条码/RFID，例如 ROLL-2026-0920
    private String rollModel;               // 母卷规格型号，例如 TC涤棉-B2026
    private String batchNo = "BAT-202609-A1"; // 染色/织造大货批次号
    private String supplier = "华联高新纺织印染有限公司"; // 供应商/织厂名称
    private String materialName = "65/35涤棉高密斜纹布"; // 面料标准品名
    private String color = "藏青色 (PANTONE 19-4024)";  // 颜色/色号
    private double grammage = 240.0;        // 克重 (g/m²)
    private String composition = "65%涤纶, 35%精梳棉"; // 面料成分
    private double shrinkageRate = 1.5;     // 经向预缩水率 (%)

    // 几何尺寸与动态库存
    private double width;                   // 定型净幅宽 (mm)，例如 2000
    private double rawWidth = 2050;         // 毛边总幅宽 (mm)，包含左右边修齐量
    private double totalLength;             // 入库标定总长度 (mm)，例如 60000
    private double currentRemainingLength;  // 当前剩余未切长度 (mm)，动态扣减
    private double usedLength = 0;          // 累计已展开切削长度 (mm)

    // 仓储位置与质量质检
    private String storageLocation = "原料库位 R-01-A03"; // 存放库位
    private String inspectionStatus = "PASSED";           // 验布状态: PASSED(合格), QUARANTINED(隔离), PENDING(待验)
    private String inspector = "AI视觉验布机-01 (已复核)"; // 验布员/验布机型号
    private String inspectionDate = "2026-09-20";         // 验布检验日期
    private String createdAt = "2026-09-20 10:00:00";     // 入库建档时间

    // 疵点集与派生料头统计
    private List<Defect> defects = new ArrayList<>();     // 本卷所有检出的瑕疵全集
    private int remnantCount;                             // 从本卷切下并入库的料头数量
    private double remnantTotalArea;                      // 在库料头总面积 (m²)

    public MotherRollInfo() {}

    public MotherRollInfo(String rollId, String rollModel, double width, double totalLength, int remnantCount, double remnantTotalArea) {
        this.rollId = rollId;
        this.rollModel = rollModel;
        this.width = width;
        this.rawWidth = width + 50;
        this.totalLength = totalLength;
        this.currentRemainingLength = totalLength;
        this.remnantCount = remnantCount;
        this.remnantTotalArea = remnantTotalArea;
    }

    public MotherRollInfo(String rollId, String rollModel, String batchNo, String supplier,
                          String materialName, String color, double grammage, String composition,
                          double width, double totalLength, String storageLocation) {
        this.rollId = rollId;
        this.rollModel = rollModel;
        this.batchNo = batchNo;
        this.supplier = supplier;
        this.materialName = materialName;
        this.color = color;
        this.grammage = grammage;
        this.composition = composition;
        this.width = width;
        this.rawWidth = width + 50;
        this.totalLength = totalLength;
        this.currentRemainingLength = totalLength;
        this.storageLocation = storageLocation;
    }

    // Getters and Setters
    public String getRollId() { return rollId; }
    public void setRollId(String rollId) { this.rollId = rollId; }

    public String getRollModel() { return rollModel; }
    public void setRollModel(String rollModel) { this.rollModel = rollModel; }

    public String getBatchNo() { return batchNo; }
    public void setBatchNo(String batchNo) { this.batchNo = batchNo; }

    public String getSupplier() { return supplier; }
    public void setSupplier(String supplier) { this.supplier = supplier; }

    public String getMaterialName() { return materialName; }
    public void setMaterialName(String materialName) { this.materialName = materialName; }

    public String getColor() { return color; }
    public void setColor(String color) { this.color = color; }

    public double getGrammage() { return grammage; }
    public void setGrammage(double grammage) { this.grammage = grammage; }

    public String getComposition() { return composition; }
    public void setComposition(String composition) { this.composition = composition; }

    public double getShrinkageRate() { return shrinkageRate; }
    public void setShrinkageRate(double shrinkageRate) { this.shrinkageRate = shrinkageRate; }

    public double getWidth() { return width; }
    public void setWidth(double width) { this.width = width; }

    public double getRawWidth() { return rawWidth; }
    public void setRawWidth(double rawWidth) { this.rawWidth = rawWidth; }

    public double getTotalLength() { return totalLength; }
    public void setTotalLength(double totalLength) { this.totalLength = totalLength; }

    public double getCurrentRemainingLength() { return currentRemainingLength; }
    public void setCurrentRemainingLength(double currentRemainingLength) { this.currentRemainingLength = currentRemainingLength; }

    public double getUsedLength() { return usedLength; }
    public void setUsedLength(double usedLength) { this.usedLength = usedLength; }

    public String getStorageLocation() { return storageLocation; }
    public void setStorageLocation(String storageLocation) { this.storageLocation = storageLocation; }

    public String getInspectionStatus() { return inspectionStatus; }
    public void setInspectionStatus(String inspectionStatus) { this.inspectionStatus = inspectionStatus; }

    public String getInspector() { return inspector; }
    public void setInspector(String inspector) { this.inspector = inspector; }

    public String getInspectionDate() { return inspectionDate; }
    public void setInspectionDate(String inspectionDate) { this.inspectionDate = inspectionDate; }

    public String getCreatedAt() { return createdAt; }
    public void setCreatedAt(String createdAt) { this.createdAt = createdAt; }

    public List<Defect> getDefects() { return defects; }
    public void setDefects(List<Defect> defects) { this.defects = defects; }

    public int getRemnantCount() { return remnantCount; }
    public void setRemnantCount(int remnantCount) { this.remnantCount = remnantCount; }

    public double getRemnantTotalArea() { return remnantTotalArea; }
    public void setRemnantTotalArea(double remnantTotalArea) { this.remnantTotalArea = remnantTotalArea; }

    public int getDefectsCount() {
        return defects != null ? defects.size() : 0;
    }
}
