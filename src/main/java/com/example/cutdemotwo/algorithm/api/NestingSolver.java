package com.example.cutdemotwo.algorithm.api;

import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.contracts.jobs.ProblemCheck;
import com.example.cutdemotwo.contracts.jobs.OptimizationRequest.InitialPlacement;
import com.example.cutdemotwo.contracts.nesting.EngineCapabilities;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;

/** 二维算法公共入口；调用方只使用标准输入输出，不取得引擎实例或内部候选解。 */
public interface NestingSolver {
    List<EngineCapabilities> capabilities();
    String fallbackFor(String engine);
    ProblemCheck validateProblem(NestingProblem problem, boolean allowFallback);
    NestingResult solve(NestingProblem problem, boolean allowFallback);
    /** The selected engine may also search directly for a minimum occupied sheet length. */
    default Optional<Function<NestingProblem, NestingResult>> stripSearch(NestingProblem problem, boolean allowFallback) {
        return Optional.empty();
    }
    /** Improve a validated complete strip layout within the remaining computation budget. */
    default Optional<NestingResult> compactMarker(NestingProblem problem, NestingResult incumbent, long deadlineNanos) {
        return Optional.empty();
    }
    /** Rebuild a complete input layout from demand shapes and independently verify all geometric constraints. */
    NestingResult validateMarkerSeed(NestingProblem problem, List<InitialPlacement> poses);
    /** Add only explicitly requested spare pieces inside a complete marker's occupied length. */
    default List<NestingResult.Placement> fillMarkerGaps(NestingProblem problem, NestingResult incumbent,
                                                         Map<Integer, Integer> limits, long deadlineNanos) {
        return List.of();
    }
    default NestingResult solve(NestingProblem problem) { return solve(problem, true); }
    NestingResult validateAdjustment(NestingProblem problem, List<PlacedPiece> pieces);
    List<NestingResult.Placement> validateContourAdjustment(NestingProblem problem, List<PlacedPiece> pieces);
}
