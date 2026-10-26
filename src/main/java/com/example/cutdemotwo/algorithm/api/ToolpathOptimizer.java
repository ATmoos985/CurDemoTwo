package com.example.cutdemotwo.algorithm.api;

import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.geometry.ToolpathResult;
import java.util.List;

/** 刀路计算和手动调整校验，不读取生产任务或修改库存。 */
public interface ToolpathOptimizer {
    List<CutStep> optimizeAndChain(List<CutStep> cuts, double homeX, double homeY, boolean respectPrecedence);
    ToolpathResult optimizeToolpath(List<CutStep> cuts, double homeX, double homeY, boolean respectPrecedence);
    List<CutStep> validateReorderedCuts(List<CutStep> saved, List<CutStep> proposed,
                                      double homeX, double homeY, boolean respectPrecedence);
}
