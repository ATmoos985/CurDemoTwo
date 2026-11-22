package com.example.cutdemotwo.algorithm.nesting.constraints;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;

/**
 * 阶段 1：求解前约束预检（如布边扣减后幅宽预检、花距合法性、疵点分级参数校验）。
 * 不合法时直接抛出 {@link com.example.cutdemotwo.algorithm.geometry.NestingValidation.Rejected}。
 */
@FunctionalInterface
public interface ProblemConstraintCheck {
    void check(NestingProblem problem);
}
