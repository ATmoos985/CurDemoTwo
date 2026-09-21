package com.example.cutdemotwo.service.solver;

import com.example.cutdemotwo.model.SolveRequest;
import com.example.cutdemotwo.model.SolveResponse;

/**
 * 排料求解引擎可插拔 SPI 统一接口
 * 允许未来无缝扩展启发式算法、遗传算法或第三方云端排料引擎
 */
public interface ICutSolverEngine {
    /**
     * 引擎唯一标识，如 "packingsolver", "scenario_one", "heuristic"
     */
    String getEngineType();

    /**
     * 检查当前求解环境是否就绪 (例如可执行文件/动态链接库是否存在)
     */
    boolean isAvailable();

    /**
     * 执行排料求解
     */
    SolveResponse solve(SolveRequest request);
}
