package com.example.cutdemotwo.algorithm.nesting.constraints;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;

/**
 * 阶段 3：候选位姿软约束打分（返回非负等效进给惩罚，单位 mm；0 表示无惩罚，越小越优）。
 */
@FunctionalInterface
public interface PlacementScorer {
    double penalty(NestingProblem problem, NestingProblem.Part part,
                   double x, double y, int angleDeg, NestingProblem.Shape orientedShape);
}
