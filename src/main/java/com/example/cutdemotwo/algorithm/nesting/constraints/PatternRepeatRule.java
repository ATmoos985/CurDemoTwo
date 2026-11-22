package com.example.cutdemotwo.algorithm.nesting.constraints;

import com.example.cutdemotwo.algorithm.geometry.EngineGeometry;
import com.example.cutdemotwo.algorithm.geometry.NestingValidation;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.FabricRule;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Part;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.PartRule;
import com.example.cutdemotwo.contracts.nesting.NestingResult;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * R4 经向花距循环对花规则（Pattern Repeat）：
 * 当 {@code repeatYMm > 0} 且 {@code part.rule.patternMatch == true} 时，
 * 阶段 2 将候选 Y 向上吸附到最近合法花距格点 {@code (y + anchorY - phaseY) mod repeatY ∈ [-tol, +tol]}，
 * 阶段 4 独立终检误差。
 */
public final class PatternRepeatRule implements ProblemConstraintCheck, FeasibleDomainClipper, ResultConstraintVerifier {
    public static final double DEFAULT_TOLERANCE_MM = 1.0;
    private static final double EPS = EngineGeometry.COORDINATE_EPS_MM;

    public static boolean requiresPatternMatch(NestingProblem problem, Part part) {
        if (problem == null || part == null || part.rule() == null) return false;
        if (!Boolean.TRUE.equals(part.rule().patternMatch())) return false;
        FabricRule fr = problem.material().fabricRule();
        return fr != null && fr.repeatYMm() != null && fr.repeatYMm() > 0;
    }

    public static boolean hasAnyPatternMatch(NestingProblem problem) {
        if (problem == null) return false;
        for (Part p : problem.parts()) {
            if (requiresPatternMatch(problem, p)) return true;
        }
        return false;
    }

    public static double alignmentErrorMm(NestingProblem problem, Part part, double y) {
        if (!requiresPatternMatch(problem, part)) return 0.0;
        FabricRule fr = problem.material().fabricRule();
        PartRule pr = part.rule();
        double repeatY = fr.repeatYMm();
        double phaseY = fr.phaseYMm() == null ? 0.0 : fr.phaseYMm();
        double anchorY = pr.patternAnchorYMm() == null ? 0.0 : pr.patternAnchorYMm();
        double delta = y + anchorY - phaseY;
        double rem = ((delta % repeatY) + repeatY) % repeatY;
        return Math.min(rem, repeatY - rem);
    }

    public static double toleranceMm(Part part) {
        if (part == null || part.rule() == null || part.rule().patternToleranceMm() == null) {
            return DEFAULT_TOLERANCE_MM;
        }
        return part.rule().patternToleranceMm();
    }

    public static boolean isAligned(NestingProblem problem, Part part, double y) {
        if (!requiresPatternMatch(problem, part)) return true;
        return alignmentErrorMm(problem, part, y) <= toleranceMm(part) + EPS;
    }

    @Override
    public void check(NestingProblem problem) {
        FabricRule fr = problem.material().fabricRule();
        if (fr != null) {
            if (fr.repeatYMm() != null) {
                NestingValidation.require(NestingValidation.positive(fr.repeatYMm()),
                        "经向花距 repeatYMm 必须为有效正数");
            }
            if (fr.phaseYMm() != null) {
                NestingValidation.require(NestingValidation.nonnegative(fr.phaseYMm()),
                        "经向花型相位 phaseYMm 必须为非负有效数值");
            }
        }
        for (Part part : problem.parts()) {
            PartRule pr = part.rule();
            if (pr == null) continue;
            if (pr.patternAnchorYMm() != null) {
                NestingValidation.require(Double.isFinite(pr.patternAnchorYMm()),
                        "对花基准偏移 patternAnchorYMm 无效：" + part.name());
            }
            if (pr.patternToleranceMm() != null) {
                NestingValidation.require(NestingValidation.nonnegative(pr.patternToleranceMm()),
                        "对花容差 patternToleranceMm 必须为非负有效数值：" + part.name());
            }
            if (Boolean.TRUE.equals(pr.patternMatch())) {
                NestingValidation.require(fr != null && fr.repeatYMm() != null && fr.repeatYMm() > 0,
                        "裁片启用了对花约束，但材料未声明有效的经向花距 repeatYMm：" + part.name());
                double tol = toleranceMm(part);
                NestingValidation.require(tol < fr.repeatYMm() / 2.0,
                        "对花容差必须小于半个花距：" + part.name());
            }
        }
    }

    @Override
    public double snapY(NestingProblem problem, Part part, int angleDeg, double rawY) {
        if (!requiresPatternMatch(problem, part)) return rawY;
        FabricRule fr = problem.material().fabricRule();
        PartRule pr = part.rule();
        double repeatY = fr.repeatYMm();
        double phaseY = fr.phaseYMm() == null ? 0.0 : fr.phaseYMm();
        double anchorY = pr.patternAnchorYMm() == null ? 0.0 : pr.patternAnchorYMm();
        double tol = toleranceMm(part);

        double delta = rawY + anchorY - phaseY;
        double rem = ((delta % repeatY) + repeatY) % repeatY;
        if (rem <= tol + 1e-9 || repeatY - rem <= tol + 1e-9) {
            return rawY;
        }
        return rawY + (repeatY - rem);
    }

    @Override
    public void verify(NestingProblem problem,
                       List<NestingResult.Placement> placements,
                       List<NestingResult.Leftover> leftovers) {
        if (placements == null || placements.isEmpty()) return;
        Map<Integer, Part> partById = new HashMap<>();
        for (Part part : problem.parts()) {
            partById.put(part.id(), part);
        }
        for (NestingResult.Placement p : placements) {
            Part part = partById.get(p.demandId());
            if (!requiresPatternMatch(problem, part)) continue;
            double err = alignmentErrorMm(problem, part, p.y());
            double tol = toleranceMm(part);
            if (err > tol + EPS) {
                throw new IllegalArgumentException(
                        "裁片未满足经向花距对花约束（误差 " + String.format("%.2f", err)
                                + " mm > 容差 " + String.format("%.2f", tol) + " mm）：" + p.name());
            }
        }
    }
}
