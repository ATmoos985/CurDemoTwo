package com.example.cutdemotwo.model;

/**
 * 纺织面料疵点实体模型 (符合国家标准 GB/T 及国际纺织 4 分制质检规范)
 */
public class Defect {
    private Integer id = 0;             // 疵点流水序号
    private double x;                   // 横向坐标 (距左导轨/靠山 mm)
    private double y;                   // 经向坐标 (距布卷起始端 mm)
    private double w;                   // 横向缺陷宽度 (mm)
    private double h;                   // 经向缺陷长度/高度 (mm)
    private double margin = 20.0;       // 工艺安全外扩避让裕量 (mm, 默认 20mm)

    // 工业质检与标准分类属性
    private String defectType = "STAIN";         // 工业类型编码: HOLE(破洞), STAIN(污渍), WEFT_DEFECT(跳纱), SLUB(粗节), SHADING(色差)
    private String typeName = "污渍/斑点";        // 中文类型名称
    private int severity = 2;                    // 严重等级: 1=轻微, 2=一般, 3=严重, 4=致命
    private int points = 2;                      // 国际纺织 4 分制扣分 (1, 2, 3, 4 分)
    private String detectionSource = "AI_VISION_SCANNER"; // 检出方式: AI_VISION_SCANNER(视觉验布机), MANUAL_INSPECT(人工标定)
    private String avoidanceStrategy = "MUST_AVOID";      // 避让策略: MUST_AVOID(绝对避让), PENETRABLE(允许进余料)
    private String description = "局部污斑";     // 现场质检描述

    public Defect() {}

    public Defect(int id, double x, double y, double w, double h, double margin) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.w = w;
        this.h = h;
        this.margin = margin;
    }

    public Defect(int id, double x, double y, double w, double h, double margin,
                  String defectType, String typeName, int severity, int points,
                  String detectionSource, String avoidanceStrategy, String description) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.w = w;
        this.h = h;
        this.margin = margin;
        this.defectType = defectType;
        this.typeName = typeName;
        this.severity = severity;
        this.points = points;
        this.detectionSource = detectionSource;
        this.avoidanceStrategy = avoidanceStrategy;
        this.description = description;
    }

    public int getId() { return id != null ? id : 0; }
    public void setId(Integer id) { this.id = id; }

    public double getX() { return x; }
    public void setX(double x) { this.x = x; }

    public double getY() { return y; }
    public void setY(double y) { this.y = y; }

    public double getW() { return w; }
    public void setW(double w) { this.w = w; }

    public double getH() { return h; }
    public void setH(double h) { this.h = h; }

    public double getMargin() { return margin; }
    public void setMargin(double margin) { this.margin = margin; }

    public double getSafeX() { return Math.max(0, x - margin); }
    public double getSafeY() { return Math.max(0, y - margin); }
    public double getSafeW() { return w + 2 * margin; }
    public double getSafeH() { return h + 2 * margin; }

    public String getDefectType() { return defectType; }
    public void setDefectType(String defectType) { this.defectType = defectType; }

    public String getTypeName() { return typeName; }
    public void setTypeName(String typeName) { this.typeName = typeName; }

    public int getSeverity() { return severity; }
    public void setSeverity(int severity) { this.severity = severity; }

    public int getPoints() { return points; }
    public void setPoints(int points) { this.points = points; }

    public String getDetectionSource() { return detectionSource; }
    public void setDetectionSource(String detectionSource) { this.detectionSource = detectionSource; }

    public String getAvoidanceStrategy() { return avoidanceStrategy; }
    public void setAvoidanceStrategy(String avoidanceStrategy) { this.avoidanceStrategy = avoidanceStrategy; }

    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }
}
