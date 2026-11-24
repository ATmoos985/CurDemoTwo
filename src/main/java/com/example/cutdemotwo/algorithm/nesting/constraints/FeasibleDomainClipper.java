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

    /** 对候选 Y 坐标做可行域单向向上吸附（如经向花距循环对花向上对齐到最近合法格点）。 */
    default double snapY(NestingProblem problem, NestingProblem.Part part, int angleDeg, double rawY) {
        return rawY;
    }

    /** 对候选 X 坐标做可行域单向向右吸附（如纬向花距对格）。 */
    default double snapX(NestingProblem problem, NestingProblem.Part part, int angleDeg, double rawX) {
        return rawX;
    }

    /** 对候选 Y 坐标在 [minY, maxY] 范围内执行双向最近合法格点吸附。 */
    default double snapYNearest(NestingProblem problem, NestingProblem.Part part, int angleDeg,
                                double rawY, double minY, double maxY) {
        return snapY(problem, part, angleDeg, rawY);
    }

    /** 对候选 X 坐标在 [minX, maxX] 范围内执行双向最近合法格点吸附。 */
    default double snapXNearest(NestingProblem problem, NestingProblem.Part part, int angleDeg,
                                double rawX, double minX, double maxX) {
        return snapX(problem, part, angleDeg, rawX);
    }
}
