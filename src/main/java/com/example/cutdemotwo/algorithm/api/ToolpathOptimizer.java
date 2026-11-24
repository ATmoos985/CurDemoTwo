package com.example.cutdemotwo.algorithm.api;

import com.example.cutdemotwo.contracts.geometry.ContourToolpathPlan;
import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.geometry.ToolpathResult;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import java.util.List;

/** 刀路计算和手动调整校验，不读取生产任务或修改库存。 */
public interface ToolpathOptimizer {
    List<CutStep> optimizeAndChain(List<CutStep> cuts, double homeX, double homeY, boolean respectPrecedence);
    ToolpathResult optimizeToolpath(List<CutStep> cuts, double homeX, double homeY, boolean respectPrecedence);
    List<CutStep> validateReorderedCuts(List<CutStep> saved, List<CutStep> proposed,
                                      double homeX, double homeY, boolean respectPrecedence);

    /** 共边切割去重：识别并扣除重合/部分重叠的切线段，避免激光/振动刀重切烧边。 */
    default List<CutStep> deduplicateCommonEdges(List<CutStep> cuts, double toleranceMm) {
        return cuts == null ? List.of() : List.copyOf(cuts);
    }

    /** 共边切割去重（默认容差 0.05 mm）。 */
    default List<CutStep> deduplicateCommonEdges(List<CutStep> cuts) {
        return deduplicateCommonEdges(cuts, 0.05);
    }

    /** 闭合异形轮廓 CAM 刀路优化：小件优先防飞料 + 先内孔后外轮廓 + 最佳下刀点 + 引入线/微连接。 */
    default ContourToolpathPlan optimizeContourToolpath(List<NestingResult.Placement> placements,
                                                        ContourToolpathPlan.Options options) {
        throw new UnsupportedOperationException("当前刀路优化器未实现闭合轮廓刀路优化");
    }
}
