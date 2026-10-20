package com.example.cutdemotwo.algorithm.solver;

import com.example.cutdemotwo.contracts.slitting.SlittingProblem;
import com.example.cutdemotwo.contracts.slitting.SlittingResult;

/**
 * 一维分切求解引擎 SPI。
 * 遵循架构约定：纯计算引擎，不依赖业务、持久化与 HTTP 控制器。
 */
public interface ISlittingSolverEngine {
    String getEngineType();
    boolean isAvailable();
    SlittingResult solve(SlittingProblem problem);
}
