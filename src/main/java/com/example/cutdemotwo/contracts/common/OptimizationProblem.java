package com.example.cutdemotwo.contracts.common;

/**
 * 跨作业类型共享的基础执行预算契约：
 * 位于底层无依赖子包 {@code contracts.common}，避免 {@code contracts.jobs} 与
 * {@code contracts.nesting} / {@code contracts.slitting} 产生双向循环依赖。
 */
public interface OptimizationProblem {
    int timeLimitSeconds();
}
