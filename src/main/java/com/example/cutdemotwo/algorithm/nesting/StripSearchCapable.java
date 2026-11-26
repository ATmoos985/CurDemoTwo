package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;

/**
 * 可选求解能力接口：支持固定幅宽下的开放带状缩长试算（{@code STRIP_SEARCH}）。
 * 用于消除 {@link SolverFactory} 对具体异形求解器类的 {@code instanceof} 硬编码。
 */
public interface StripSearchCapable {
    EngineResult solveStripCandidate(NestingProblem problem);
}
