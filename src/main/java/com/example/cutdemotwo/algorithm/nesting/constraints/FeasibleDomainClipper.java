package com.example.cutdemotwo.algorithm.nesting.constraints;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;

import java.util.List;

/**
 * 阶段 2：按裁片裁剪可行域与候选位姿（核心搜索只消费裁剪结果，不感知具体行业规则）。
 */
public interface FeasibleDomainClipper {
    /** 裁剪该裁片可用的 X 有效区间 [minX, maxX]（如左右布边禁区）。 */
    default double[] clipXBounds(NestingProblem problem, NestingProblem.Part part, double minX, double maxX) {
        return new double[]{minX, maxX};
    }

    /** 过滤该裁片必须硬避让的禁入区列表（如辅片放行轻微/ALLOW_AUXILIARY 疵点）。 */
    default List<NestingProblem.Exclusion> hardExclusionsFor(NestingProblem problem, NestingProblem.Part part) {
        return problem.material().exclusions();
    }

    /** 对候选 Y 坐标做可行域吸附（如经向花距循环对花向上对齐到最近合法格点）。 */
    default double snapY(NestingProblem problem, NestingProblem.Part part, int angleDeg, double rawY) {
        return rawY;
    }
}
