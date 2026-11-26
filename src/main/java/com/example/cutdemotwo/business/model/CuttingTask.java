package com.example.cutdemotwo.business.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * A demand batch survives changing material and reporting several cutting stations.
 * problemType 为空即二维排料（NESTING_2D）；一维分切（SLITTING_1D）的需求为“分切宽度 × 成品卷长 × 卷数”，
 * 每一车按定长拉布段落在母卷上报工。新增字段为空时不序列化，旧状态文件逐字节不变。
 */
public record CuttingTask(String id, String name, String materialModel, String externalRef,
                          long revision, List<Line> demands, Process process,
                          @JsonInclude(JsonInclude.Include.NON_NULL) String problemType,
                          @JsonInclude(JsonInclude.Include.NON_NULL) Slitting slitting,
                          @JsonInclude(JsonInclude.Include.NON_NULL) String dueDate,
                          @JsonInclude(JsonInclude.Include.NON_NULL) String priority,
                          @JsonInclude(JsonInclude.Include.NON_NULL) String customerName,
                          @JsonInclude(JsonInclude.Include.NON_NULL) String kittingGroup,
                          @JsonInclude(JsonInclude.Include.NON_NULL) String requiredBatchNo,
                          @JsonInclude(JsonInclude.Include.NON_NULL) String requiredColor,
                          @JsonInclude(JsonInclude.Include.NON_NULL) Boolean strictBatchMatch,
                          @JsonInclude(JsonInclude.Include.NON_NULL) String machineId,
                          @JsonInclude(JsonInclude.Include.NON_NULL) String shiftTeam,
                          @JsonInclude(JsonInclude.Include.NON_NULL) String sourceSchemeId,
                          @JsonInclude(JsonInclude.Include.NON_NULL) String replenishIdempotencyKey) {
    public static final String NESTING_2D = "NESTING_2D", SLITTING_1D = "SLITTING_1D";
    public static final String PRIORITY_NORMAL = "NORMAL", PRIORITY_HIGH = "HIGH", PRIORITY_URGENT = "URGENT";

    public CuttingTask(String id, String name, String materialModel, String externalRef,
                       long revision, List<Line> demands, Process process, String problemType, Slitting slitting) {
        this(id, name, materialModel, externalRef, revision, demands, process, problemType, slitting,
                null, null, null, null, null, null, null, null, null, null, null);
    }
    public CuttingTask(String id, String name, String materialModel, String externalRef, long revision, List<Line> demands, Process process) {
        this(id, name, materialModel, externalRef, revision, demands, process, null, null);
    }
    public CuttingTask(String id, String name, String materialModel, String externalRef, long revision, List<Line> demands) {
        this(id, name, materialModel, externalRef, revision, demands, null);
    }
    public boolean slittingTask() { return SLITTING_1D.equals(problemType); }

    public CuttingTask withMaterialModel(String nextMaterialModel) {
        return new CuttingTask(id, name, nextMaterialModel, externalRef, revision, demands, process, problemType, slitting,
                dueDate, priority, customerName, kittingGroup, requiredBatchNo, requiredColor, strictBatchMatch,
                machineId, shiftTeam, sourceSchemeId, replenishIdempotencyKey);
    }

    public CuttingTask withDemands(List<Line> nextDemands) {
        return new CuttingTask(id, name, materialModel, externalRef, revision, nextDemands, process, problemType, slitting,
                dueDate, priority, customerName, kittingGroup, requiredBatchNo, requiredColor, strictBatchMatch,
                machineId, shiftTeam, sourceSchemeId, replenishIdempotencyKey);
    }

    public record Line(int id, String name, double width, double length, int quantity, boolean allowRotation,
                       com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape shape,
                       @JsonInclude(JsonInclude.Include.NON_NULL) Boolean allowHalfTurn,
                       @JsonInclude(JsonInclude.Include.NON_NULL) String sizeLabel,
                       @JsonInclude(JsonInclude.Include.NON_NULL) String sourceTemplateId,
                       @JsonInclude(JsonInclude.Include.NON_NULL) String surfaceTreatment) {
        public Line(int id, String name, double width, double length, int quantity, boolean allowRotation,
                    com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape shape) {
            this(id, name, width, length, quantity, allowRotation, shape, null, null, null, null);
        }
        public Line(int id, String name, double width, double length, int quantity, boolean allowRotation) {
            this(id, name, width, length, quantity, allowRotation, null, null, null, null, null);
        }
    }
    public record Process(double bedLength, double trimStart, String cutOrigin, String firstStageOrientation,
                          boolean allowRotation, boolean allowLongitudinal, Double pieceGap) {
        public Process { pieceGap = pieceGap == null ? 0.0 : pieceGap; }
        public Process(double bedLength, double trimStart, String cutOrigin, String firstStageOrientation,
                       boolean allowRotation, boolean allowLongitudinal) {
            this(bedLength, trimStart, cutOrigin, firstStageOrientation, allowRotation, allowLongitudinal, 0.0);
        }
    }
    /** 一维分切工艺：左右固定切边、组合宽度范围与步长、整体超产上限（卷），均为整数 mm。 */
    public record Slitting(int leftTrim, int rightTrim, int minWidth, int maxWidth, int widthStep, int totalOverCap) {
        public void validate() {
            if (leftTrim < 0 || rightTrim < 0 || minWidth <= 0 || maxWidth < minWidth || widthStep <= 0
                    || (maxWidth - minWidth) / widthStep > 1000 || totalOverCap < 0 || totalOverCap > 10000)
                throw new IllegalArgumentException("一维分切参数无效：切边不能为负，组合宽度下限 ≤ 上限，步长为正且候选宽度不超过 1001 个，超产上限 0–10000 卷");
        }
    }
}
