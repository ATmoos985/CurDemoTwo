package com.example.cutdemotwo.contracts.slitting;

import java.util.*;

/**
 * 独立一维搭切约束与计算结果校验器。
 * 遵循严格证据链：算法不得依赖业务，结果必须具备独立几何、物理刀架与履约验真，防止错误结果流向后续业务。
 */
public final class SlittingValidation {
    private SlittingValidation() {}

    public static class ValidationException extends IllegalArgumentException {
        private final String code;
        public ValidationException(String code, String message) {
            super(message);
            this.code = code;
        }
        public String getCode() { return code; }
    }

    public static void validateProblem(SlittingProblem p) {
        if (p == null) throw new ValidationException("INVALID_INPUT", "分切求解问题不能为空");
        if (!"1".equals(p.schemaVersion())) throw new ValidationException("UNSUPPORTED", "一维分切仅支持 schemaVersion=1");
        if (!"mm".equals(p.unit())) throw new ValidationException("UNSUPPORTED", "一维分切仅支持 unit=mm");

        int motherWidth = p.motherWidthMm();
        int leftTrim = p.leftTrimMm();
        int rightTrim = p.rightTrimMm();
        long available = (long) motherWidth - leftTrim - rightTrim;

        if (motherWidth <= 0 || motherWidth > 100_000 || leftTrim < 0 || rightTrim < 0 || available <= 0) {
            throw new ValidationException("INVALID_INPUT", "母卷幅宽须在 1–100000 mm 之间，左右切边非负且留有正可用幅宽");
        }

        int minWidth = p.minWidthMm();
        int maxWidth = p.maxWidthMm();
        int step = p.widthStepMm();

        if (minWidth <= 0 || maxWidth < minWidth || maxWidth > available || step <= 0) {
            throw new ValidationException("INVALID_INPUT", "组合宽度必须位于扣除切边后的有效区间内，步长必须为正");
        }
        if ((maxWidth - minWidth) / step > 1000) {
            throw new ValidationException("INVALID_INPUT", "候选宽度跨度不能超过 1001 个步长");
        }

        // 校验可选物理机台约束与多规格母卷池
        if (p.maxKnives() != null && (p.maxKnives() < 1 || p.maxKnives() > 100)) {
            throw new ValidationException("INVALID_INPUT", "单车最大刀数/切条数上限 maxKnives 须在 1–100 之间");
        }
        if (p.minBladeSpacingMm() != null && (p.minBladeSpacingMm() < 1 || p.minBladeSpacingMm() > 100_000)) {
            throw new ValidationException("INVALID_INPUT", "最小物理刀距 minBladeSpacingMm 须在 1–100000 mm 之间");
        }
        if ((p.forbiddenNarrowEdgeMinMm() == null) != (p.forbiddenNarrowEdgeMaxMm() == null)) {
            throw new ValidationException("INVALID_INPUT", "危险细边丝禁区必须同时提供下限和上限");
        }
        if (p.forbiddenNarrowEdgeMinMm() != null) {
            int fMin = p.forbiddenNarrowEdgeMinMm();
            int fMax = p.forbiddenNarrowEdgeMaxMm();
            if (fMin < 0 || fMax < fMin || fMax > 100_000) {
                throw new ValidationException("INVALID_INPUT", "危险细边丝禁区范围无效，须满足 0 <= min <= max <= 100000");
            }
        }
        if (p.kerfMm() != null && (p.kerfMm() < 0 || p.kerfMm() > 500)) {
            throw new ValidationException("INVALID_INPUT", "每刀切缝损耗 kerfMm 须在 0–500 mm 之间");
        }

        long maxOrderAllowedWidth = maxWidth;
        if (p.hasCandidateRollWidths()) {
            var pool = p.candidateRollWidths();
            if (pool.size() > 50) {
                throw new ValidationException("INVALID_INPUT", "候选母卷宽幅池最多支持 50 种规格");
            }
            Set<Integer> seenWidths = new HashSet<>();
            long maxCandidateUsable = 0;
            for (var c : pool) {
                if (c == null) {
                    throw new ValidationException("INVALID_INPUT", "候选母卷规格项不能为 null");
                }
                if (c.widthMm() <= 0 || c.widthMm() > 100_000) {
                    throw new ValidationException("INVALID_INPUT", "候选母卷幅宽须在 1–100000 mm 之间");
                }
                long candidateUsable = (long) c.widthMm() - leftTrim - rightTrim;
                if (candidateUsable <= 0) {
                    throw new ValidationException("INVALID_INPUT", "候选母卷扣除左右切边后必须留有正可用幅宽: " + c.widthMm());
                }
                if (!seenWidths.add(c.widthMm())) {
                    throw new ValidationException("INVALID_INPUT", "候选母卷宽幅规格重复: " + c.widthMm());
                }
                if (c.availableRolls() != null && (c.availableRolls() < 1 || c.availableRolls() > 100_000)) {
                    throw new ValidationException("INVALID_INPUT", "候选母卷可用卷数上限须在 1–100000 之间");
                }
                if (candidateUsable > maxCandidateUsable) {
                    maxCandidateUsable = candidateUsable;
                }
            }
            maxOrderAllowedWidth = maxCandidateUsable;
        }

        if (p.totalOverCap() < 0 || p.totalOverCap() > 10_000) {
            throw new ValidationException("INVALID_INPUT", "超产上限须在 0–10000 卷之间");
        }

        if (!"FAST".equals(p.profile()) && !"QUALITY".equals(p.profile())) {
            throw new ValidationException("UNSUPPORTED", "求解策略仅支持 FAST 或 QUALITY");
        }

        if (p.orders() == null || p.orders().isEmpty() || p.orders().size() > 500) {
            throw new ValidationException("INVALID_INPUT", "分切订单条数须在 1–500 条之间");
        }

        Set<String> orderIds = new HashSet<>();
        for (SlittingProblem.Order order : p.orders()) {
            if (order == null) throw new ValidationException("INVALID_INPUT", "订单项不能为 null");
            if (order.id() == null || order.id().isBlank() || order.id().length() > 200) {
                throw new ValidationException("INVALID_INPUT", "每条订单必须包含 1–200 字有效标识");
            }
            if (!orderIds.add(order.id())) {
                throw new ValidationException("INVALID_INPUT", "订单标识重复: " + order.id());
            }
            if (order.widthMm() <= 0 || order.widthMm() > maxOrderAllowedWidth) {
                throw new ValidationException("INVALID_INPUT", "订单幅宽须为正数且不超过可用幅宽上限 " + maxOrderAllowedWidth + " mm");
            }
            if (p.minBladeSpacingMm() != null && order.widthMm() < p.minBladeSpacingMm()) {
                throw new ValidationException("INVALID_INPUT",
                        "订单幅宽 " + order.widthMm() + " mm 小于机台最小物理刀距 " + p.minBladeSpacingMm() + " mm");
            }
            if (order.lengthMm() <= 0 || order.lengthMm() > 1_000_000_000L) {
                throw new ValidationException("INVALID_INPUT", "订单卷长须在 1–1000000000 mm 之间");
            }
            if (order.quantity() <= 0 || order.quantity() > 100_000) {
                throw new ValidationException("INVALID_INPUT", "订单需求件数须在 1–100000 之间");
            }
            if (order.surfaceTreatment() == null || order.surfaceTreatment().isBlank() || order.surfaceTreatment().length() > 100) {
                throw new ValidationException("INVALID_INPUT", "订单必须指定表面处理（1–100 字）");
            }
        }

        if (p.orders().stream().mapToLong(SlittingProblem.Order::quantity).sum() + p.totalOverCap() > 100_000)
            throw new ValidationException("INVALID_INPUT", "请求需求与允许超产合计最多 100000 卷");
        if (p.timeLimitSeconds() < 1 || p.timeLimitSeconds() > 180) {
            throw new ValidationException("INVALID_INPUT", "求解时限须在 1–180 秒之间");
        }
        if (p.topK() != null && (p.topK() < 0 || p.topK() > 50)) {
            throw new ValidationException("INVALID_INPUT", "TOP K 超产宽度数须在 0–50 之间");
        }
        if (p.maxIterations() != null && (p.maxIterations() < 1 || p.maxIterations() > 5_000)) {
            throw new ValidationException("INVALID_INPUT", "列生成最大迭代次数须在 1–5000 之间");
        }
        if (p.maxPatterns() != null && (p.maxPatterns() < 1 || p.maxPatterns() > 20_000)) {
            throw new ValidationException("INVALID_INPUT", "最大花型池上限须在 1–20000 之间");
        }
        if (p.maxDistinctWidths() != null && (p.maxDistinctWidths() < 1 || p.maxDistinctWidths() > 20)) {
            throw new ValidationException("INVALID_INPUT", "单卷不同宽幅上限须在 1–20 之间");
        }
        if (p.stageTimeLimitMs() != null && (p.stageTimeLimitMs() < 1_000L || p.stageTimeLimitMs() > 600_000L)) {
            throw new ValidationException("INVALID_INPUT", "MIP 单阶段安全时限须在 1000–600000 毫秒之间");
        }
        if (p.underPenalty() != null && (!Double.isFinite(p.underPenalty()) || p.underPenalty() < 0.0)) {
            throw new ValidationException("INVALID_INPUT", "欠产惩罚系数必须为非负有限数");
        }
        if (p.seqGroupAlpha() != null && (!Double.isFinite(p.seqGroupAlpha()) || p.seqGroupAlpha() < 0.0)) {
            throw new ValidationException("INVALID_INPUT", "顺序组惩罚权重 alpha 必须为非负有限数");
        }
        if (p.seqGroupBeta() != null && (!Double.isFinite(p.seqGroupBeta()) || p.seqGroupBeta() < 0.0)) {
            throw new ValidationException("INVALID_INPUT", "顺序组惩罚权重 beta 必须为非负有限数");
        }
    }

    public static void validateResult(SlittingProblem problem, SlittingResult result) {
        validateProblem(problem);
        try { verify(problem, result); }
        catch (ArithmeticException overflow) { throw new ValidationException("INVALID_RESULT", "结果整数运算溢出"); }
    }

    private static void verify(SlittingProblem p, SlittingResult r) {
        check(r != null && "1".equals(r.schemaVersion()) && "mm".equals(r.unit()), "结果版本或单位无效");
        check(!r.optimalityProven(), "当前引擎未提供最优性证明");
        check(Set.of("FEASIBLE", "NO_SOLUTION_FOUND").contains(r.status()), "不支持的结果状态");
        check("FEASIBLE".equals(r.status()) == !r.patterns().isEmpty(), "结果状态与排刀列表不一致");
        check(r.estimatedKnifeChanges() == null || r.estimatedKnifeChanges() >= 0, "预计换刀次数不能为负数");
        check(r.knifeChangesSaved() == null || r.knifeChangesSaved() >= 0, "减少换刀次数不能为负数");

        var orders = new LinkedHashMap<String, SlittingProblem.Order>();
        p.orders().forEach(o -> orders.put(o.id(), o));
        var counts = new HashMap<String, Integer>();
        var ids = new HashSet<String>();
        long pieceArea = 0, motherArea = 0, usableArea = 0, totalProduced = 0;

        boolean hasPool = p.hasCandidateRollWidths();
        int leftTrim = p.leftTrimMm();
        int rightTrim = p.rightTrimMm();
        int defaultUsable = p.motherWidthMm() - leftTrim - rightTrim;
        int kerf = p.effectiveKerfMm();

        Map<Integer, SlittingProblem.CandidateRollWidth> usableToCandidate = new HashMap<>();
        Map<Integer, Long> usedRollsByMotherWidth = new HashMap<>();
        if (hasPool) {
            for (var c : p.candidateRollWidths()) {
                int candidateUsable = c.widthMm() - leftTrim - rightTrim;
                usableToCandidate.put(candidateUsable, c);
            }
        }

        for (var pattern : r.patterns()) {
            check(pattern.id() != null && !pattern.id().isBlank() && ids.add(pattern.id()), "排刀标识无效或重复");
            check(pattern.repetitions() > 0 && pattern.lengthMm() > 0 && pattern.lengthMm() <= 1_000_000_000L, "重复数或卷长无效");

            int carMotherWidth;
            int carUsableWidth;
            if (hasPool) {
                var candidate = usableToCandidate.get(pattern.rollWidthMm());
                check(candidate != null, "排刀幅宽未命中候选母卷宽幅池（扣边可用宽=" + pattern.rollWidthMm() + " mm）");
                check(pattern.motherWidthMm() == null || pattern.motherWidthMm() == candidate.widthMm(),
                        "排刀母卷规格宽幅与候选池不一致");
                carMotherWidth = candidate.widthMm();
                carUsableWidth = pattern.rollWidthMm();
                long usedRolls = usedRollsByMotherWidth.merge(carMotherWidth, (long) pattern.repetitions(), Math::addExact);
                if (candidate.availableRolls() != null) {
                    check(usedRolls <= candidate.availableRolls(),
                            "母卷规格 " + carMotherWidth + " mm 使用卷数 " + usedRolls + " 超过可用上限 " + candidate.availableRolls());
                }
            } else {
                check(pattern.rollWidthMm() >= p.minWidthMm() && pattern.rollWidthMm() <= p.maxWidthMm()
                        && (pattern.rollWidthMm() - p.minWidthMm()) % p.widthStepMm() == 0, "排刀候选幅宽不符合区间/步长");
                check(pattern.motherWidthMm() == null || pattern.motherWidthMm() == p.motherWidthMm(),
                        "排刀母卷规格宽幅与母卷宽不一致");
                carMotherWidth = p.motherWidthMm();
                carUsableWidth = defaultUsable;
            }

            long width = 0;
            long totalStrips = 0;
            var expected = new HashMap<Integer, Long>();
            for (var station : pattern.stations()) {
                check(station.widthMm() > 0 && station.countPerRepetition() > 0, "工位宽度和数量必须为正");
                if (p.minBladeSpacingMm() != null) {
                    check(station.widthMm() >= p.minBladeSpacingMm(),
                            "工位宽幅 " + station.widthMm() + " mm 小于机台最小刀距 " + p.minBladeSpacingMm() + " mm");
                }
                check(!expected.containsKey(station.widthMm()), "相同幅宽的工位必须合并计数");
                width = Math.addExact(width, Math.multiplyExact((long) station.widthMm(), station.countPerRepetition()));
                totalStrips = Math.addExact(totalStrips, station.countPerRepetition());
                expected.put(station.widthMm(), Math.multiplyExact((long) station.countPerRepetition(), pattern.repetitions()));
            }
            if (p.maxKnives() != null) {
                check(totalStrips <= p.maxKnives(),
                        "单车切条/刀数 " + totalStrips + " 超过机台最大刀数上限 " + p.maxKnives());
            }
            long kerfLoss = totalStrips > 1 ? Math.multiplyExact(totalStrips - 1, kerf) : 0L;
            long occupiedWidth = Math.addExact(width, kerfLoss);
            check(width > 0 && width == pattern.patternWidthMm()
                    && occupiedWidth <= pattern.rollWidthMm() && occupiedWidth <= carUsableWidth,
                    "工位组合宽度（含切缝损耗）、排刀幅宽或扣边可用幅宽不一致");

            if (p.hasForbiddenNarrowEdge()) {
                long tailEdge = pattern.rollWidthMm() - occupiedWidth;
                // 0 视为无边丝合法；若剩余尾边落在 [min, max] 危险细边丝禁区内则拒收。
                check(!(tailEdge > 0 && tailEdge >= p.forbiddenNarrowEdgeMinMm() && tailEdge <= p.forbiddenNarrowEdgeMaxMm()),
                        "排刀剩余尾边 " + tailEdge + " mm 落入危险细边丝禁区 ["
                                + p.forbiddenNarrowEdgeMinMm() + ", " + p.forbiddenNarrowEdgeMaxMm() + "]");
            }

            var actual = new HashMap<Integer, Long>();
            var allocatedIds = new HashSet<String>();
            for (var a : pattern.allocations()) {
                var order = orders.get(a.orderId());
                check(order != null && a.quantity() > 0 && allocatedIds.add(a.orderId()), "订单分配无效、重复或未知");
                check(order.lengthMm() == pattern.lengthMm() && Objects.equals(order.surfaceTreatment(), pattern.surfaceTreatment()),
                        "订单卷长/表面处理与实际排刀不一致");
                actual.merge(order.widthMm(), (long) a.quantity(), Math::addExact);
                counts.merge(order.id(), a.quantity(), Math::addExact);
            }
            check(actual.equals(expected), "逐幅宽产出与订单分配不一致");
            for (long n : expected.values()) totalProduced = Math.addExact(totalProduced, n);
            check(totalProduced <= 100_000, "结果超过产出资源限制");

            long length = Math.multiplyExact(pattern.lengthMm(), pattern.repetitions());
            pieceArea = Math.addExact(pieceArea, Math.multiplyExact(width, length));
            motherArea = Math.addExact(motherArea, Math.multiplyExact((long) carMotherWidth, length));
            usableArea = Math.addExact(usableArea, Math.multiplyExact((long) carUsableWidth, length));
        }

        int over = 0;
        var seen = new HashSet<String>();
        for (var f : r.fulfillment()) {
            var o = orders.get(f.orderId());
            check(o != null && seen.add(f.orderId()), "履约订单未知或重复");
            int produced = counts.getOrDefault(o.id(), 0);
            check(f.requested() == o.quantity() && f.produced() == produced
                    && f.missing() == Math.max(0, o.quantity() - produced)
                    && f.overproduced() == Math.max(0, produced - o.quantity()), "履约统计与实际分配不一致");
            over = Math.addExact(over, f.overproduced());
        }
        check(seen.size() == orders.size(), "履约报告没有覆盖全部订单");
        check(over == r.totalOverproduced() && over <= p.totalOverCap(), "全请求总超产超过上限或统计错误");
        check(pieceArea == r.pieceAreaMm2() && motherArea == r.motherAreaMm2() && usableArea == r.usableAreaMm2(),
                "面积指标与实际排刀不一致");
    }

    private static void check(boolean valid, String message) {
        if (!valid) throw new ValidationException("INVALID_RESULT", message);
    }
}
