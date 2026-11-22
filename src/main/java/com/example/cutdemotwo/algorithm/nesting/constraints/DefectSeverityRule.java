package com.example.cutdemotwo.algorithm.nesting.constraints;

import com.example.cutdemotwo.algorithm.geometry.EngineGeometry;
import com.example.cutdemotwo.algorithm.geometry.NestingValidation;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.algorithm.nesting.ContourGeometrySupport;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Exclusion;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Part;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;

import java.awt.geom.Area;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * R1 疵点分级避让规则：
 * <ul>
 *   <li>严重/致命（{@code severity >= 3}）或显式 {@code HARD_FORBID}/{@code MUST_AVOID}：全员硬避让；</li>
 *   <li>轻微（{@code severity == 1}）或 {@code ALLOW_AUXILIARY}/{@code PENETRABLE}：允许 {@code AUXILIARY} 辅片穿透/覆盖（附软惩罚分优先避让），主片依然硬避让；</li>
 *   <li>一般（{@code severity == 2}）：主片硬避让，辅片按 {@code ALLOW_AUXILIARY}/{@code PENETRABLE} 放行。</li>
 * </ul>
 */
public final class DefectSeverityRule implements ProblemConstraintCheck, FeasibleDomainClipper, PlacementScorer {
    private static final Set<String> ALLOWED_POLICIES = Set.of(
            "HARD_FORBID", "MUST_AVOID", "ALLOW_AUXILIARY", "ALLOW_REMNANT", "PENETRABLE"
    );
    private static final Set<String> ALLOWED_ROLES = Set.of("MAIN", "AUXILIARY");
    /** 单次覆盖轻微/可穿透疵点的基础等效进给惩罚（mm），确保能避开时优先避开、避不开时仍优先排入。 */
    private static final double SOFT_DEFECT_BASE_PENALTY_MM = 2000.0;
    private static final double SOFT_DEFECT_AREA_WEIGHT = 0.05;

    @Override
    public void check(NestingProblem problem) {
        for (Exclusion exc : problem.material().exclusions()) {
            if (exc.severity() != null) {
                int sev = exc.severity();
                NestingValidation.require(sev >= 1 && sev <= 4,
                        "疵点严重等级 severity 必须为 1–4 整数");
            }
            if (exc.avoidancePolicy() != null && !exc.avoidancePolicy().isBlank()) {
                String normalized = exc.avoidancePolicy().trim().toUpperCase(Locale.ROOT);
                NestingValidation.require(ALLOWED_POLICIES.contains(normalized),
                        "不支持的疵点避让策略 avoidancePolicy：" + exc.avoidancePolicy());
            }
        }
        for (Part part : problem.parts()) {
            if (part.rule() != null && part.rule().role() != null && !part.rule().role().isBlank()) {
                String role = part.rule().role().trim().toUpperCase(Locale.ROOT);
                NestingValidation.require(ALLOWED_ROLES.contains(role),
                        "不支持的裁片角色 role：" + part.rule().role());
            }
        }
    }

    /** 判断指定禁入区对该裁片是否属于必须硬避让的禁区。 */
    public static boolean isHardExclusionFor(Exclusion exc, Part part) {
        Integer sev = exc.severity();
        String policy = exc.avoidancePolicy() == null ? null : exc.avoidancePolicy().trim().toUpperCase(Locale.ROOT);
        if (policy != null && policy.isEmpty()) policy = null;

        // 严重/致命或显式硬避让：全员硬避让
        if (sev != null && sev >= 3) return true;
        if ("HARD_FORBID".equals(policy) || "MUST_AVOID".equals(policy)) return true;

        // 非辅片（主片或未标角色）始终硬避让
        if (part == null || !part.isAuxiliary()) return true;

        // 辅片放行条件：
        // 1) severity == 1（未指定硬避让策略）
        // 2) avoidancePolicy 为 ALLOW_AUXILIARY 或 PENETRABLE（含 severity == 2 搭配 ALLOW_AUXILIARY）
        if ("ALLOW_AUXILIARY".equals(policy) || "PENETRABLE".equals(policy)) {
            return false;
        }
        if (sev != null && sev == 1) {
            return false;
        }
        return true;
    }

    @Override
    public List<Exclusion> hardExclusionsFor(NestingProblem problem, Part part) {
        List<Exclusion> all = problem.material().exclusions();
        if (all.isEmpty() || part == null || !part.isAuxiliary()) {
            return all;
        }
        List<Exclusion> filtered = null;
        for (int i = 0; i < all.size(); i++) {
            Exclusion exc = all.get(i);
            if (!isHardExclusionFor(exc, part)) {
                if (filtered == null) {
                    filtered = new ArrayList<>(all.subList(0, i));
                }
            } else if (filtered != null) {
                filtered.add(exc);
            }
        }
        return filtered == null ? all : List.copyOf(filtered);
    }

    @Override
    public double penalty(NestingProblem problem, Part part,
                          double x, double y, int angleDeg, Shape orientedShape) {
        if (part == null || !part.isAuxiliary()) return 0.0;
        List<Exclusion> all = problem.material().exclusions();
        if (all.isEmpty()) return 0.0;

        double px2 = x + orientedShape.width();
        double py2 = y + orientedShape.height();
        boolean isRectPart = "RECTANGLE".equals(orientedShape.type());
        Area partArea = null;
        double totalPenalty = 0.0;

        for (Exclusion exc : all) {
            if (isHardExclusionFor(exc, part)) continue;
            double clr = exc.clearance();
            double ex1 = exc.x() - clr;
            double ey1 = exc.y() - clr;
            double ex2 = exc.x() + exc.shape().width() + clr;
            double ey2 = exc.y() + exc.shape().height() + clr;
            if (!ContourGeometrySupport.aabbOverlaps(x, px2, y, py2, ex1, ex2, ey1, ey2, -EngineGeometry.COORDINATE_EPS_MM)) {
                continue;
            }
            double overlapArea;
            if (isRectPart && "RECTANGLE".equals(exc.shape().type())) {
                double ox = Math.min(px2, ex2) - Math.max(x, ex1);
                double oy = Math.min(py2, ey2) - Math.max(y, ey1);
                overlapArea = (ox > EngineGeometry.COORDINATE_EPS_MM && oy > EngineGeometry.COORDINATE_EPS_MM) ? ox * oy : 0.0;
            } else {
                if (partArea == null) {
                    partArea = PolygonGeometry.region(orientedShape, x, y);
                }
                var expanded = ContourGeometrySupport.expandExclusion(exc);
                Area inter = new Area(partArea);
                inter.intersect(expanded.worldArea());
                overlapArea = PolygonGeometry.area(inter);
            }
            if (overlapArea > EngineGeometry.AREA_EPS_MM2) {
                totalPenalty += SOFT_DEFECT_BASE_PENALTY_MM + overlapArea * SOFT_DEFECT_AREA_WEIGHT;
            }
        }
        return totalPenalty;
    }
}
