package com.example.cutdemotwo.contracts.jobs;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.Map;

/** 工作台编排作业的不可变来源上下文；与作业共同归档，绝不混入求解器输入哈希。 */
public record WorkbenchJobSource(
        String taskId,
        String actor,
        long taskRevision,
        String materialType,
        String materialId,
        long materialRevision,
        double physicalWidthMm,
        double windowStartMm,
        double windowLengthMm,
        double rectGapPaddingMm,
        Map<Integer, Integer> sourceLines,
        @JsonInclude(JsonInclude.Include.NON_NULL) String dimension,
        @JsonInclude(JsonInclude.Include.NON_NULL) String materialLabel,
        @JsonInclude(JsonInclude.Include.NON_NULL) Boolean avoidDefects,
        @JsonInclude(JsonInclude.Include.NON_NULL) Double trimStartMm,
        @JsonInclude(JsonInclude.Include.NON_NULL) Double pieceGapMm
) {
    public WorkbenchJobSource {
        sourceLines = sourceLines == null ? Map.of() : Map.copyOf(sourceLines);
    }

    /** 向后兼容 11 参构造器。 */
    public WorkbenchJobSource(
            String taskId, String actor, long taskRevision, String materialType,
            String materialId, long materialRevision, double physicalWidthMm,
            double windowStartMm, double windowLengthMm, double rectGapPaddingMm,
            Map<Integer, Integer> sourceLines
    ) {
        this(taskId, actor, taskRevision, materialType, materialId, materialRevision,
                physicalWidthMm, windowStartMm, windowLengthMm, rectGapPaddingMm, sourceLines,
                null, null, null, null, null);
    }
}
