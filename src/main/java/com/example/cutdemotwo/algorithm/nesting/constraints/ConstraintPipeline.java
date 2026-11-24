package com.example.cutdemotwo.algorithm.nesting.constraints;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingResult;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 四阶段声明式约束管线。
 * 未携带行业约束的旧请求统一复用 {@link #NOOP} 单例，确保零对象分配与零性能开销。
 */
public final class ConstraintPipeline {
    public static final ConstraintPipeline NOOP = new ConstraintPipeline(
            List.of(), List.of(), List.of(), List.of(), true);

    private final List<ProblemConstraintCheck> checks;
    private final List<FeasibleDomainClipper> clippers;
    private final List<PlacementScorer> scorers;
    private final List<ResultConstraintVerifier> verifiers;
    private final boolean noop;

    public ConstraintPipeline(List<ProblemConstraintCheck> checks,
                              List<FeasibleDomainClipper> clippers,
                              List<PlacementScorer> scorers,
                              List<ResultConstraintVerifier> verifiers) {
        this(checks, clippers, scorers, verifiers,
                (checks == null || checks.isEmpty())
                        && (clippers == null || clippers.isEmpty())
                        && (scorers == null || scorers.isEmpty())
                        && (verifiers == null || verifiers.isEmpty()));
    }

    private ConstraintPipeline(List<ProblemConstraintCheck> checks,
                               List<FeasibleDomainClipper> clippers,
                               List<PlacementScorer> scorers,
                               List<ResultConstraintVerifier> verifiers,
                               boolean noop) {
        this.checks = checks == null ? List.of() : List.copyOf(checks);
        this.clippers = clippers == null ? List.of() : List.copyOf(clippers);
        this.scorers = scorers == null ? List.of() : List.copyOf(scorers);
        this.verifiers = verifiers == null ? List.of() : List.copyOf(verifiers);
        this.noop = noop;
    }

    public boolean isNoop() {
        return noop;
    }

    /** 阶段 1：求解前预检。 */
    public void checkProblem(NestingProblem problem) {
        if (noop) return;
        for (ProblemConstraintCheck check : checks) {
            check.check(problem);
        }
    }

    /** 阶段 2a：裁剪裁片 X 有效区间 [minX, maxX]。 */
    public double[] clipXBounds(NestingProblem problem, NestingProblem.Part part, double minX, double maxX) {
        if (noop || clippers.isEmpty()) return new double[]{minX, maxX};
        double lo = minX;
        double hi = maxX;
        for (FeasibleDomainClipper clipper : clippers) {
            double[] clipped = clipper.clipXBounds(problem, part, lo, hi);
            lo = Math.max(lo, clipped[0]);
            hi = Math.min(hi, clipped[1]);
        }
        return new double[]{lo, hi};
    }

    /** 阶段 2b：获取该裁片必须硬避让的禁入区列表（多条规则取交集）。 */
    public List<NestingProblem.Exclusion> hardExclusionsFor(NestingProblem problem, NestingProblem.Part part) {
        List<NestingProblem.Exclusion> all = problem.material().exclusions();
        if (noop || clippers.isEmpty() || all.isEmpty()) return all;
        if (clippers.size() == 1) {
            return clippers.get(0).hardExclusionsFor(problem, part);
        }
        Set<Integer> allowedHardIds = null;
        for (FeasibleDomainClipper clipper : clippers) {
            List<NestingProblem.Exclusion> hard = clipper.hardExclusionsFor(problem, part);
            if (hard == all) continue;
            Set<Integer> ids = new HashSet<>(hard.size());
            for (NestingProblem.Exclusion exc : hard) ids.add(exc.id());
            if (allowedHardIds == null) {
                allowedHardIds = ids;
            } else {
                allowedHardIds.retainAll(ids);
            }
        }
        if (allowedHardIds == null) return all;
        Set<Integer> finalIds = allowedHardIds;
        return all.stream().filter(e -> finalIds.contains(e.id())).toList();
    }

    /** 阶段 2c：候选 Y 坐标单向向上吸附（如经向花距循环对花）。 */
    public double snapY(NestingProblem problem, NestingProblem.Part part, int angleDeg, double rawY) {
        if (noop || clippers.isEmpty()) return rawY;
        double y = rawY;
        for (FeasibleDomainClipper clipper : clippers) {
            y = clipper.snapY(problem, part, angleDeg, y);
        }
        return y;
    }

    /** 阶段 2c：候选 X 坐标单向向右吸附（如纬向花距对格）。 */
    public double snapX(NestingProblem problem, NestingProblem.Part part, int angleDeg, double rawX) {
        if (noop || clippers.isEmpty()) return rawX;
        double x = rawX;
        for (FeasibleDomainClipper clipper : clippers) {
            x = clipper.snapX(problem, part, angleDeg, x);
        }
        return x;
    }

    /** 阶段 2c：候选 Y 坐标在 [minY, maxY] 范围内双向最近吸附。 */
    public double snapYNearest(NestingProblem problem, NestingProblem.Part part, int angleDeg,
                               double rawY, double minY, double maxY) {
        if (noop || clippers.isEmpty()) return rawY;
        double y = rawY;
        for (FeasibleDomainClipper clipper : clippers) {
            y = clipper.snapYNearest(problem, part, angleDeg, y, minY, maxY);
        }
        return y;
    }

    /** 阶段 2c：候选 X 坐标在 [minX, maxX] 范围内双向最近吸附。 */
    public double snapXNearest(NestingProblem problem, NestingProblem.Part part, int angleDeg,
                               double rawX, double minX, double maxX) {
        if (noop || clippers.isEmpty()) return rawX;
        double x = rawX;
        for (FeasibleDomainClipper clipper : clippers) {
            x = clipper.snapXNearest(problem, part, angleDeg, x, minX, maxX);
        }
        return x;
    }

    /** 阶段 3：候选位姿软约束惩罚（>= 0，越小越优）。 */
    public double penalty(NestingProblem problem, NestingProblem.Part part,
                          double x, double y, int angleDeg, NestingProblem.Shape orientedShape) {
        if (noop || scorers.isEmpty()) return 0.0;
        double total = 0.0;
        for (PlacementScorer scorer : scorers) {
            total += Math.max(0.0, scorer.penalty(problem, part, x, y, angleDeg, orientedShape));
        }
        return total;
    }

    /** 阶段 4：独立终检校验（违规抛 IllegalArgumentException）。 */
    public void verifyResult(NestingProblem problem,
                             List<NestingResult.Placement> placements,
                             List<NestingResult.Leftover> leftovers) {
        if (noop || verifiers.isEmpty()) return;
        for (ResultConstraintVerifier verifier : verifiers) {
            verifier.verify(problem, placements, leftovers);
        }
    }

    /** 阶段 4 便捷封装：返回 null 表示通过，否则返回违规原因。 */
    public String validateResult(NestingProblem problem,
                                 List<NestingResult.Placement> placements,
                                 List<NestingResult.Leftover> leftovers) {
        if (noop || verifiers.isEmpty()) return null;
        try {
            verifyResult(problem, placements, leftovers);
            return null;
        } catch (IllegalArgumentException violation) {
            return violation.getMessage();
        }
    }
}
