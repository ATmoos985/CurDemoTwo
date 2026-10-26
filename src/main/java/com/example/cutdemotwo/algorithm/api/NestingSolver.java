package com.example.cutdemotwo.algorithm.api;

import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.contracts.jobs.ProblemCheck;
import com.example.cutdemotwo.contracts.nesting.EngineCapabilities;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import java.util.List;

/** 二维算法公共入口；调用方只使用标准输入输出，不取得引擎实例或内部候选解。 */
public interface NestingSolver {
    List<EngineCapabilities> capabilities();
    String fallbackFor(String engine);
    ProblemCheck validateProblem(NestingProblem problem, boolean allowFallback);
    NestingResult solve(NestingProblem problem, boolean allowFallback);
    default NestingResult solve(NestingProblem problem) { return solve(problem, true); }
    NestingResult validateAdjustment(NestingProblem problem, List<PlacedPiece> pieces);
    List<NestingResult.Placement> validateContourAdjustment(NestingProblem problem, List<PlacedPiece> pieces);
}
