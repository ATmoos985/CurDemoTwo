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

    private CurtainConstraintPack() {}

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

        List<ProblemConstraintCheck> checks = new ArrayList<>(3);
        List<FeasibleDomainClipper> clippers = new ArrayList<>(3);
        List<PlacementScorer> scorers = new ArrayList<>(1);
        List<ResultConstraintVerifier> verifiers = new ArrayList<>(2);

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

        return new ConstraintPipeline(checks, clippers, scorers, verifiers);
    }
}
