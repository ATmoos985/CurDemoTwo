package com.example.cutdemotwo.model;

import java.util.ArrayList;
import java.util.List;

public class SolveRequest {
    private double rollW = 2000.0;
    private double rollL = 5000.0;
    private boolean allowLongitudinal = true;
    private boolean allowRotation = false;
    private String solver = "packingsolver";
    private List<Defect> defects = new ArrayList<>();
    private List<PieceDemand> demands = new ArrayList<>();
    private String firstStageOrientation = "horizontal";
    private double trimStart = 0.0;
    private String cutOrigin = "right-top";  // 默认右上角基准 (靠右导轨对齐 · 顺流进给)
    private double totalRollL = 60000.0;
    private double windowStartY = 0.0;
    private String rollId = "ROLL-2026-0920";    // 母卷编号
    private String rollModel = "TC涤棉-B2026";   // 母卷材质型号
    private String feedPortType = "roll"; // "roll"(母卷连续料口) 或 "remnant"(手工料头投料口)
    private String sourceRemnantId;      // 若为料头投料，记录原料头编号

    public SolveRequest() {}

    public String getRollId() { return rollId; }
    public void setRollId(String rollId) { this.rollId = rollId; }

    public String getRollModel() { return rollModel; }
    public void setRollModel(String rollModel) { this.rollModel = rollModel; }

    public String getFeedPortType() { return feedPortType; }
    public void setFeedPortType(String feedPortType) { this.feedPortType = feedPortType; }

    public String getSourceRemnantId() { return sourceRemnantId; }
    public void setSourceRemnantId(String sourceRemnantId) { this.sourceRemnantId = sourceRemnantId; }

    public double getTotalRollL() { return totalRollL; }
    public void setTotalRollL(double totalRollL) { this.totalRollL = totalRollL; }

    public double getWindowStartY() { return windowStartY; }
    public void setWindowStartY(double windowStartY) { this.windowStartY = windowStartY; }

    public String getFirstStageOrientation() { return firstStageOrientation; }
    public void setFirstStageOrientation(String firstStageOrientation) { this.firstStageOrientation = firstStageOrientation; }

    public double getTrimStart() { return trimStart; }
    public void setTrimStart(double trimStart) { this.trimStart = trimStart; }

    public String getCutOrigin() { return cutOrigin; }
    public void setCutOrigin(String cutOrigin) { this.cutOrigin = cutOrigin; }

    public double getRollW() { return rollW; }
    public void setRollW(double rollW) { this.rollW = rollW; }

    public double getRollL() { return rollL; }
    public void setRollL(double rollL) { this.rollL = rollL; }

    public boolean isAllowLongitudinal() { return allowLongitudinal; }
    public void setAllowLongitudinal(boolean allowLongitudinal) { this.allowLongitudinal = allowLongitudinal; }

    public boolean isAllowRotation() { return allowRotation; }
    public void setAllowRotation(boolean allowRotation) { this.allowRotation = allowRotation; }

    public String getSolver() { return solver; }
    public void setSolver(String solver) { this.solver = solver; }

    public List<Defect> getDefects() { return defects; }
    public void setDefects(List<Defect> defects) { this.defects = defects; }

    public List<PieceDemand> getDemands() { return demands; }
    public void setDemands(List<PieceDemand> demands) { this.demands = demands; }
}
