package com.example.cutdemotwo.algorithm.nesting.constraints;

import com.example.cutdemotwo.algorithm.geometry.EngineGeometry;
import com.example.cutdemotwo.algorithm.geometry.NestingValidation;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.FabricRule;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Part;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * R2 左右布边禁区规则（Selvedge）：
 * 主片 X 有效区间收窄为 {@code [leftSelvedge, rollW - rightSelvedge]}；
 * 辅片按 {@code allowAuxiliaryInSelvedge} 决定是否可落入布边；
 * 扣布边后有效幅宽不足以容纳裁片则在阶段 1 预检明确拒绝。
 */
public final class SelvedgeRule implements ProblemConstraintCheck, FeasibleDomainClipper, ResultConstraintVerifier {
    private static final double EPS = EngineGeometry.COORDINATE_EPS_MM;

    public static boolean hasSelvedge(NestingProblem problem) {
        FabricRule rule = problem.material().fabricRule();
        if (rule == null) return false;
        return (rule.leftSelvedgeMm() != null && rule.leftSelvedgeMm() > 0)
                || (rule.rightSelvedgeMm() != null && rule.rightSelvedgeMm() > 0);
    }

    private static double leftSelvedge(FabricRule rule) {
        return rule == null || rule.leftSelvedgeMm() == null ? 0.0 : rule.leftSelvedgeMm();
    }

    private static double rightSelvedge(FabricRule rule) {
        return rule == null || rule.rightSelvedgeMm() == null ? 0.0 : rule.rightSelvedgeMm();
    }

    @Override
    public void check(NestingProblem problem) {
        FabricRule rule = problem.material().fabricRule();
        if (rule == null) return;
        double left = leftSelvedge(rule);
        double right = rightSelvedge(rule);
        NestingValidation.require(NestingValidation.nonnegative(left) && NestingValidation.nonnegative(right),
                "左右布边禁区宽度必须为非负有效数值");
        NestingValidation.require(left + right < problem.width() - EPS,
                "左右布边禁区之和必须小于材料幅宽");

        if (left <= 0 && right <= 0) return;

        boolean contour = "CONTOUR".equals(problem.process().mode());
        for (Part part : problem.parts()) {
            double[] bounds = clipXBounds(problem, part, 0.0, problem.width());
            double availW = bounds[1] - bounds[0];
            boolean fits = false;
            if (contour) {
                for (int angle : part.contourAngles()) {
                    Shape rotated = angle == 0 ? part.shape() : PolygonGeometry.rotate(part.shape(), angle);
                    if (rotated.width() <= availW + EPS) {
                        fits = true;
                        break;
                    }
                }
            } else {
                double w = part.shape().width();
                double h = part.shape().height();
                boolean canRotate = part.allowRotation() && !"CROSSCUT".equals(problem.process().mode());
                if (w <= availW + EPS || (canRotate && h <= availW + EPS)) {
                    fits = true;
                }
            }
            NestingValidation.require(fits,
                    "扣除左右布边后有效幅宽（" + String.format("%.1f", availW) + " mm）不足以容纳裁片：" + part.name());
        }
    }

    @Override
    public double[] clipXBounds(NestingProblem problem, Part part, double minX, double maxX) {
        FabricRule rule = problem.material().fabricRule();
        if (rule == null) return new double[]{minX, maxX};
        if (part != null && part.isAuxiliary() && Boolean.TRUE.equals(rule.allowAuxiliaryInSelvedge())) {
            return new double[]{minX, maxX};
        }
        double left = leftSelvedge(rule);
        double right = rightSelvedge(rule);
        return new double[]{Math.max(minX, left), Math.min(maxX, problem.width() - right)};
    }

    @Override
    public void verify(NestingProblem problem,
                       List<NestingResult.Placement> placements,
                       List<NestingResult.Leftover> leftovers) {
        if (!hasSelvedge(problem) || placements == null || placements.isEmpty()) return;
        Map<Integer, Part> partById = new HashMap<>();
        for (Part part : problem.parts()) {
            partById.put(part.id(), part);
        }
        for (NestingResult.Placement p : placements) {
            Part part = partById.get(p.demandId());
            double[] bounds = clipXBounds(problem, part, 0.0, problem.width());
            if (p.x() < bounds[0] - EPS || p.x() + p.shape().width() > bounds[1] + EPS) {
                throw new IllegalArgumentException(
                        "裁片落入左右布边禁区（允许 X 区间 [" + String.format("%.1f", bounds[0]) + ", "
                                + String.format("%.1f", bounds[1]) + "] mm）：" + p.name());
            }
        }
    }
}
