package com.example.cutdemotwo.algorithm.nesting.constraints;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;

import java.util.ArrayList;
import java.util.List;

/**
 * 窗帘行业声明式约束预设包工厂。
 * 当输入问题未携带任何窗帘约束（{@code fabricRule}、{@code part.rule}、疵点分级策略均为空）时，
 * 直接返回零开销 {@link ConstraintPipeline#NOOP} 单例；否则按需装配 R1/R2/R4 规则。
 */
public final class CurtainConstraintPack {
    private static final DefectSeverityRule DEFECT_SEVERITY_RULE = new DefectSeverityRule();
    private static final SelvedgeRule SELVEDGE_RULE = new SelvedgeRule();
    private static final PatternRepeatRule PATTERN_REPEAT_RULE = new PatternRepeatRule();
    private static final GrainGroupRule GRAIN_GROUP_RULE = new GrainGroupRule();

    private CurtainConstraintPack() {}

    /**
     * 判断问题是否仅含“统一作用于全员的纯左右布边禁区”（不含对花、不含同组倒顺毛、不含辅片进布边特例，
     * 且按 {@code allowPlainDefects} 控制是否允许仅含普通硬疵点），用于放宽分区求解与阶段 3 联动压紧。
     */
    public static boolean isPureSelvedgeOnly(NestingProblem problem, boolean allowPlainDefects) {
        if (problem == null || problem.material() == null) return false;
        NestingProblem.FabricRule fr = problem.material().fabricRule();
        if (fr == null) return false;
        double left = fr.leftSelvedgeMm() == null ? 0.0 : fr.leftSelvedgeMm();
        double right = fr.rightSelvedgeMm() == null ? 0.0 : fr.rightSelvedgeMm();
        if (left <= 0.0 && right <= 0.0) return false;
        if (fr.repeatYMm() != null || fr.repeatXMm() != null || PatternRepeatRule.hasAnyPatternMatch(problem)) {
            return false;
        }
        if (GrainGroupRule.hasAnyGrainGroup(problem)) {
            return false;
        }
        boolean auxAllowedInSelvedge = Boolean.TRUE.equals(fr.allowAuxiliaryInSelvedge());
        for (NestingProblem.Part part : problem.parts()) {
            if (part == null) continue;
            if (auxAllowedInSelvedge && part.isAuxiliary()) {
                return false;
            }
        }
        if (!allowPlainDefects) {
            return problem.material().exclusions().isEmpty();
        }
        for (NestingProblem.Exclusion exc : problem.material().exclusions()) {
            if (exc != null && (exc.severity() != null || exc.avoidancePolicy() != null)) {
                return false;
            }
        }
        return true;
    }

    public static ConstraintPipeline forProblem(NestingProblem problem) {
        if (problem == null || problem.material() == null) {
            return ConstraintPipeline.NOOP;
        }
        boolean hasFabricRule = problem.material().fabricRule() != null;
        boolean hasPartRule = false;
        for (NestingProblem.Part part : problem.parts()) {
            if (part != null && part.rule() != null) {
                hasPartRule = true;
                break;
            }
        }
        boolean hasDefectMeta = false;
        for (NestingProblem.Exclusion exc : problem.material().exclusions()) {
            if (exc != null && (exc.severity() != null || exc.avoidancePolicy() != null)) {
                hasDefectMeta = true;
                break;
            }
        }
        if (!hasFabricRule && !hasPartRule && !hasDefectMeta) {
            return ConstraintPipeline.NOOP;
        }

        List<ProblemConstraintCheck> checks = new ArrayList<>(4);
        List<FeasibleDomainClipper> clippers = new ArrayList<>(3);
        List<PlacementScorer> scorers = new ArrayList<>(1);
        List<ResultConstraintVerifier> verifiers = new ArrayList<>(3);

        if (hasDefectMeta || hasPartRule) {
            checks.add(DEFECT_SEVERITY_RULE);
            clippers.add(DEFECT_SEVERITY_RULE);
            scorers.add(DEFECT_SEVERITY_RULE);
        }
        if (hasFabricRule) {
            checks.add(SELVEDGE_RULE);
            clippers.add(SELVEDGE_RULE);
            verifiers.add(SELVEDGE_RULE);
        }
        if (hasFabricRule || hasPartRule) {
            checks.add(PATTERN_REPEAT_RULE);
            clippers.add(PATTERN_REPEAT_RULE);
            verifiers.add(PATTERN_REPEAT_RULE);
        }
        if (hasPartRule) {
            checks.add(GRAIN_GROUP_RULE);
            verifiers.add(GRAIN_GROUP_RULE);
        }

        return new ConstraintPipeline(checks, clippers, scorers, verifiers);
    }
}
