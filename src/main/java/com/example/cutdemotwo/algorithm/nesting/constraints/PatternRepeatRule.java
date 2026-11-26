package com.example.cutdemotwo.algorithm.nesting.constraints;

import com.example.cutdemotwo.algorithm.geometry.EngineGeometry;
import com.example.cutdemotwo.algorithm.geometry.NestingValidation;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.FabricRule;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Part;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.PartRule;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingResult;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * R4 双轴花距循环对格与旋转锚点规则（Bi-axial Pattern Repeat &amp; Plaid Matching）：
 * <ul>
 *   <li>经向（Y）花距 {@code repeatYMm} 与纬向（X）花距 {@code repeatXMm} 可独立或同时启用；</li>
 *   <li>裁片旋转后自动执行刚体锚点变换（如 180° 旋转时锚点变换为 {@code (w - anchorX, h - anchorY)}，
 *       90° 旋转时变换为 {@code (h - anchorY, anchorX)}）；</li>
 *   <li>提供单向推进吸附与有界区间双向最近吸附，并在阶段 4 独立终检双轴对格误差。</li>
 * </ul>
 */
public final class PatternRepeatRule implements ProblemConstraintCheck, FeasibleDomainClipper, ResultConstraintVerifier {
    public static final double DEFAULT_TOLERANCE_MM = 1.0;
    private static final double EPS = EngineGeometry.COORDINATE_EPS_MM;

    public static boolean requiresPatternMatchY(NestingProblem problem, Part part) {
        if (problem == null || part == null || part.rule() == null) return false;
        if (!Boolean.TRUE.equals(part.rule().patternMatch())) return false;
        FabricRule fr = problem.material().fabricRule();
        return fr != null && fr.repeatYMm() != null && fr.repeatYMm() > 0;
    }

    public static boolean requiresPatternMatchX(NestingProblem problem, Part part) {
        if (problem == null || part == null || part.rule() == null) return false;
        if (!Boolean.TRUE.equals(part.rule().patternMatch())) return false;
        FabricRule fr = problem.material().fabricRule();
        return fr != null && fr.repeatXMm() != null && fr.repeatXMm() > 0;
    }

    public static boolean requiresPatternMatch(NestingProblem problem, Part part) {
        return requiresPatternMatchY(problem, part) || requiresPatternMatchX(problem, part);
    }

    public static boolean hasAnyPatternMatch(NestingProblem problem) {
        if (problem == null) return false;
        for (Part p : problem.parts()) {
            if (requiresPatternMatch(problem, p)) return true;
        }
        return false;
    }

    /**
     * 计算裁片经 {@code angleDeg} 顺时针旋转并左上归零后的对花锚点 {@code [anchorX', anchorY']}。
     * <ul>
     *   <li>0°：{@code (ax, ay)}</li>
     *   <li>90°：{@code (h - ay, ax)}</li>
     *   <li>180°：{@code (w - ax, h - ay)}</li>
     *   <li>270°：{@code (ay, w - ax)}</li>
     *   <li>任意角度：与 {@link PolygonGeometry#rotate} 严格同步的刚体旋转并平移归零</li>
     * </ul>
     */
    public static double[] transformedAnchor(Part part, int angleDeg) {
        PartRule pr = part == null ? null : part.rule();
        double rawAx = (pr == null || pr.patternAnchorXMm() == null) ? 0.0 : pr.patternAnchorXMm();
        double rawAy = (pr == null || pr.patternAnchorYMm() == null) ? 0.0 : pr.patternAnchorYMm();
        int norm = Math.floorMod(angleDeg, 360);
        if (norm == 0 || part == null || part.shape() == null) {
            return new double[]{rawAx, rawAy};
        }
        Point rotated = PolygonGeometry.rotatePointInShape(part.shape(), new Point(rawAx, rawAy), norm);
        return new double[]{rotated.x(), rotated.y()};
    }

    /** 向后兼容单轴（0°）经向对花误差计算。 */
    public static double alignmentErrorMm(NestingProblem problem, Part part, double y) {
        return alignmentErrorYMm(problem, part, 0, y);
    }

    public static double alignmentErrorYMm(NestingProblem problem, Part part, int angleDeg, double y) {
        if (!requiresPatternMatchY(problem, part)) return 0.0;
        FabricRule fr = problem.material().fabricRule();
        double repeatY = fr.repeatYMm();
        double phaseY = fr.phaseYMm() == null ? 0.0 : fr.phaseYMm();
        double anchorY = transformedAnchor(part, angleDeg)[1];
        return axisErrorMm(y, anchorY, phaseY, repeatY);
    }

    public static double alignmentErrorXMm(NestingProblem problem, Part part, int angleDeg, double x) {
        if (!requiresPatternMatchX(problem, part)) return 0.0;
        FabricRule fr = problem.material().fabricRule();
        double repeatX = fr.repeatXMm();
        double phaseX = fr.phaseXMm() == null ? 0.0 : fr.phaseXMm();
        double anchorX = transformedAnchor(part, angleDeg)[0];
        return axisErrorMm(x, anchorX, phaseX, repeatX);
    }

    private static double axisErrorMm(double coord, double anchor, double phase, double repeat) {
        double delta = coord + anchor - phase;
        double rem = ((delta % repeat) + repeat) % repeat;
        return Math.min(rem, repeat - rem);
    }

    public static double toleranceMm(Part part) {
        if (part == null || part.rule() == null || part.rule().patternToleranceMm() == null) {
            return DEFAULT_TOLERANCE_MM;
        }
        return part.rule().patternToleranceMm();
    }

    /** 向后兼容单轴（0°）经向对齐判定。 */
    public static boolean isAligned(NestingProblem problem, Part part, double y) {
        return isAlignedY(problem, part, 0, y);
    }

    public static boolean isAlignedY(NestingProblem problem, Part part, int angleDeg, double y) {
        if (!requiresPatternMatchY(problem, part)) return true;
        return alignmentErrorYMm(problem, part, angleDeg, y) <= toleranceMm(part) + EPS;
    }

    public static boolean isAlignedX(NestingProblem problem, Part part, int angleDeg, double x) {
        if (!requiresPatternMatchX(problem, part)) return true;
        return alignmentErrorXMm(problem, part, angleDeg, x) <= toleranceMm(part) + EPS;
    }

    public static boolean isAligned(NestingProblem problem, Part part, int angleDeg, double x, double y) {
        return isAlignedX(problem, part, angleDeg, x) && isAlignedY(problem, part, angleDeg, y);
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
            if (fr.repeatXMm() != null) {
                NestingValidation.require(NestingValidation.positive(fr.repeatXMm()),
                        "纬向花距 repeatXMm 必须为有效正数");
            }
            if (fr.phaseXMm() != null) {
                NestingValidation.require(NestingValidation.nonnegative(fr.phaseXMm()),
                        "纬向花型相位 phaseXMm 必须为非负有效数值");
            }
        }
        for (Part part : problem.parts()) {
            PartRule pr = part.rule();
            if (pr == null) continue;
            if (pr.patternAnchorYMm() != null) {
                NestingValidation.require(Double.isFinite(pr.patternAnchorYMm()),
                        "经向对花基准偏移 patternAnchorYMm 无效：" + part.name());
            }
            if (pr.patternAnchorXMm() != null) {
                NestingValidation.require(Double.isFinite(pr.patternAnchorXMm()),
                        "纬向对花基准偏移 patternAnchorXMm 无效：" + part.name());
            }
            if (pr.patternToleranceMm() != null) {
                NestingValidation.require(NestingValidation.nonnegative(pr.patternToleranceMm()),
                        "对花容差 patternToleranceMm 必须为非负有效数值：" + part.name());
            }
            if (Boolean.TRUE.equals(pr.patternMatch())) {
                boolean hasY = fr != null && fr.repeatYMm() != null && fr.repeatYMm() > 0;
                boolean hasX = fr != null && fr.repeatXMm() != null && fr.repeatXMm() > 0;
                NestingValidation.require(hasY || hasX,
                        "裁片启用了对花约束，但材料未声明有效的经向花距 repeatYMm 或纬向花距 repeatXMm：" + part.name());
                double tol = toleranceMm(part);
                if (hasY) {
                    NestingValidation.require(tol < fr.repeatYMm() / 2.0,
                            "对花容差必须小于半个经向花距：" + part.name());
                }
                if (hasX) {
                    NestingValidation.require(tol < fr.repeatXMm() / 2.0,
                            "对花容差必须小于半个纬向花距：" + part.name());
                }
            }
        }
    }

    @Override
    public double snapY(NestingProblem problem, Part part, int angleDeg, double rawY) {
        if (!requiresPatternMatchY(problem, part)) return rawY;
        FabricRule fr = problem.material().fabricRule();
        double repeatY = fr.repeatYMm();
        double phaseY = fr.phaseYMm() == null ? 0.0 : fr.phaseYMm();
        double anchorY = transformedAnchor(part, angleDeg)[1];
        return snapAxisForward(rawY, anchorY, phaseY, repeatY, toleranceMm(part));
    }

    @Override
    public double snapX(NestingProblem problem, Part part, int angleDeg, double rawX) {
        if (!requiresPatternMatchX(problem, part)) return rawX;
        FabricRule fr = problem.material().fabricRule();
        double repeatX = fr.repeatXMm();
        double phaseX = fr.phaseXMm() == null ? 0.0 : fr.phaseXMm();
        double anchorX = transformedAnchor(part, angleDeg)[0];
        return snapAxisForward(rawX, anchorX, phaseX, repeatX, toleranceMm(part));
    }

    @Override
    public double snapYNearest(NestingProblem problem, Part part, int angleDeg,
                               double rawY, double minY, double maxY) {
        if (!requiresPatternMatchY(problem, part)) return rawY;
        FabricRule fr = problem.material().fabricRule();
        double repeatY = fr.repeatYMm();
        double phaseY = fr.phaseYMm() == null ? 0.0 : fr.phaseYMm();
        double anchorY = transformedAnchor(part, angleDeg)[1];
        return snapAxisNearest(rawY, anchorY, phaseY, repeatY, toleranceMm(part), minY, maxY);
    }

    @Override
    public double snapXNearest(NestingProblem problem, Part part, int angleDeg,
                               double rawX, double minX, double maxX) {
        if (!requiresPatternMatchX(problem, part)) return rawX;
        FabricRule fr = problem.material().fabricRule();
        double repeatX = fr.repeatXMm();
        double phaseX = fr.phaseXMm() == null ? 0.0 : fr.phaseXMm();
        double anchorX = transformedAnchor(part, angleDeg)[0];
        return snapAxisNearest(rawX, anchorX, phaseX, repeatX, toleranceMm(part), minX, maxX);
    }

    /** 单向向前吸附到不小于 {@code raw} 的最近合法花距格点。 */
    public static double snapAxisForward(double raw, double anchor, double phase, double repeat, double tol) {
        double delta = raw + anchor - phase;
        double rem = ((delta % repeat) + repeat) % repeat;
        if (rem <= tol + 1e-9 || repeat - rem <= tol + 1e-9) {
            return raw;
        }
        return raw + (repeat - rem);
    }

    /**
     * 有界区间 {@code [minBound, maxBound]} 内的双向最近格点吸附：
     * 若 {@code raw} 已满足容差直接返回；否则在前后相邻两个格点 {@code down = raw - rem} 与
     * {@code up = raw + (repeat - rem)} 中选择落在界内且距离 {@code raw} 更近者。
     */
    public static double snapAxisNearest(double raw, double anchor, double phase, double repeat,
                                         double tol, double minBound, double maxBound) {
        double delta = raw + anchor - phase;
        double rem = ((delta % repeat) + repeat) % repeat;
        if (rem <= tol + 1e-9 || repeat - rem <= tol + 1e-9) {
            return raw;
        }
        double down = raw - rem;
        double up = raw + (repeat - rem);
        boolean downOk = down >= minBound - EPS && down <= maxBound + EPS;
        boolean upOk = up >= minBound - EPS && up <= maxBound + EPS;
        if (downOk && upOk) {
            return rem <= (repeat - rem) ? Math.max(minBound, down) : Math.min(maxBound, up);
        }
        if (downOk) return Math.max(minBound, down);
        if (upOk) return Math.min(maxBound, up);
        return up;
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
            double tol = toleranceMm(part);
            if (requiresPatternMatchY(problem, part)) {
                double errY = alignmentErrorYMm(problem, part, p.rotationDegrees(), p.y());
                if (errY > tol + EPS) {
                    throw new IllegalArgumentException(
                            "裁片未满足经向花距对花约束（角度 " + p.rotationDegrees() + "°，误差 "
                                    + String.format("%.2f", errY) + " mm > 容差 "
                                    + String.format("%.2f", tol) + " mm）：" + p.name());
                }
            }
            if (requiresPatternMatchX(problem, part)) {
                double errX = alignmentErrorXMm(problem, part, p.rotationDegrees(), p.x());
                if (errX > tol + EPS) {
                    throw new IllegalArgumentException(
                            "裁片未满足纬向花距对格约束（角度 " + p.rotationDegrees() + "°，误差 "
                                    + String.format("%.2f", errX) + " mm > 容差 "
                                    + String.format("%.2f", tol) + " mm）：" + p.name());
                }
            }
        }
    }
}
