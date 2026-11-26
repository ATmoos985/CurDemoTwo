package com.example.cutdemotwo.algorithm.nesting.constraints;

import com.example.cutdemotwo.algorithm.geometry.NestingValidation;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Part;
import com.example.cutdemotwo.contracts.nesting.NestingResult;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * R5 同组一致倒顺毛规则（Consistent Nap / Pile Grain Group）：
 * 同一 {@code grainGroupId} 组内所有已排裁片必须统一沿经向 {@code 0°} 或统一沿 {@code 180°} 放置，
 * 严禁同组内出现 {@code 0°} 与 {@code 180°} 混向或出现纬向/斜向角度（如 {@code 90°/270°/45°}）。
 */
public final class GrainGroupRule implements ProblemConstraintCheck, ResultConstraintVerifier {

    public static String normalizedGroupId(Part part) {
        if (part == null || part.rule() == null || part.rule().grainGroupId() == null) {
            return null;
        }
        String trimmed = part.rule().grainGroupId().trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    public static boolean hasAnyGrainGroup(NestingProblem problem) {
        if (problem == null) return false;
        for (Part part : problem.parts()) {
            if (normalizedGroupId(part) != null) {
                return true;
            }
        }
        return false;
    }

    /**
     * 计算指定 {@code grainGroupId} 在当前问题下允许的组共识经向角度集合（{@code [0]}、{@code [180]} 或 {@code [0, 180]}）。
     * 矩形直刀/横切模式仅支持 {@code 0°}。
     */
    public static List<Integer> allowedGroupAngles(NestingProblem problem, String groupId) {
        if (problem == null || groupId == null || groupId.isBlank()) {
            return List.of(0, 180);
        }
        boolean contour = "CONTOUR".equals(problem.process().mode());
        boolean can0 = true;
        boolean can180 = contour;
        for (Part part : problem.parts()) {
            if (!groupId.equals(normalizedGroupId(part))) continue;
            if (contour) {
                List<Integer> angles = part.contourAngles();
                if (!angles.contains(0)) can0 = false;
                if (!angles.contains(180)) can180 = false;
            } else {
                // 矩形工艺仅支持 0°（90° 属于纬向，违反倒顺毛经向一致约束）
                can180 = false;
            }
        }
        List<Integer> result = new ArrayList<>(2);
        if (can0) result.add(0);
        if (can180) result.add(180);
        return List.copyOf(result);
    }

    /** 获取单件裁片在同组倒顺毛约束下的有效允许角度集合。 */
    public static List<Integer> allowedAnglesForPart(NestingProblem problem, Part part) {
        String gid = normalizedGroupId(part);
        if (gid == null) {
            return part.contourAngles();
        }
        return allowedGroupAngles(problem, gid);
    }

    @Override
    public void check(NestingProblem problem) {
        if (problem == null) return;
        Map<String, List<Part>> groups = new LinkedHashMap<>();
        for (Part part : problem.parts()) {
            String gid = normalizedGroupId(part);
            if (gid != null) {
                groups.computeIfAbsent(gid, k -> new ArrayList<>()).add(part);
            }
        }
        for (Map.Entry<String, List<Part>> entry : groups.entrySet()) {
            String gid = entry.getKey();
            List<Integer> common = allowedGroupAngles(problem, gid);
            NestingValidation.require(!common.isEmpty(),
                    "同组倒顺毛（grainGroupId=" + gid + "）成员间不存在共同允许的 0° 或 180° 经向角度");
        }
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
        Map<String, Integer> groupDirection = new HashMap<>();
        for (NestingResult.Placement p : placements) {
            Part part = partById.get(p.demandId());
            String gid = normalizedGroupId(part);
            if (gid == null) continue;
            int deg = Math.floorMod(p.rotationDegrees(), 360);
            if (deg != 0 && deg != 180) {
                throw new IllegalArgumentException(
                        "同组倒顺毛裁片（grainGroupId=" + gid + "）仅允许 0° 或 180° 经向放置，实际角度 "
                                + deg + "°：" + p.name());
            }
            Integer existing = groupDirection.putIfAbsent(gid, deg);
            if (existing != null && existing != deg) {
                throw new IllegalArgumentException(
                        "同组倒顺毛（grainGroupId=" + gid + "）裁片方向不一致：同时存在 "
                                + existing + "° 与 " + deg + "° 混向放置（裁片：" + p.name() + "）");
            }
        }
    }
}
