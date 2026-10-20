package com.example.cutdemotwo.contracts.slitting;

import java.util.*;

/**
 * 独立一维搭切约束与计算结果校验器。
 * 遵循严格证据链：算法不得依赖业务，结果必须具备独立几何与履约验真，防止错误结果流向后续业务。
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
            if (order.widthMm() <= 0 || order.widthMm() > maxWidth) {
                throw new ValidationException("INVALID_INPUT", "订单幅宽须为正数且不超过组合上限 " + maxWidth + " mm");
            }
            if (order.lengthMm() <= 0 || order.lengthMm() > 1_000_000_000L) {
                throw new ValidationException("INVALID_INPUT", "订单卷长须在 1000–1000000000 mm 之间");
            }
            if (order.lengthMm() % 1000 != 0) {
                throw new ValidationException("UNSUPPORTED_CONSTRAINT", "当前内核卷长分辨率为 1000 mm，不能舍入卷长");
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
        if (p.timeLimitSeconds() < 1 || p.timeLimitSeconds() > 60) {
            throw new ValidationException("INVALID_INPUT", "求解时限须在 1–60 秒之间");
        }
    }

    public static void validateResult(SlittingProblem problem, SlittingResult result) {
        validateProblem(problem);
        try { verify(problem,result); }
        catch (ArithmeticException overflow) { throw new ValidationException("INVALID_RESULT", "结果整数运算溢出"); }
    }

    private static void verify(SlittingProblem p, SlittingResult r) {
        check(r != null && "1".equals(r.schemaVersion()) && "mm".equals(r.unit()), "结果版本或单位无效");
        check(!r.optimalityProven(), "当前引擎未提供最优性证明");
        check(Set.of("FEASIBLE","NO_SOLUTION_FOUND").contains(r.status()), "不支持的结果状态");
        check("FEASIBLE".equals(r.status()) == !r.patterns().isEmpty(), "结果状态与排刀列表不一致");
        var orders=new LinkedHashMap<String,SlittingProblem.Order>();
        p.orders().forEach(o->orders.put(o.id(),o));
        var counts=new HashMap<String,Integer>();
        var ids=new HashSet<String>();
        long pieceArea=0,motherArea=0,usableArea=0,totalProduced=0;
        int usable=p.motherWidthMm()-p.leftTrimMm()-p.rightTrimMm();
        for(var pattern:r.patterns()) {
            check(pattern.id()!=null && !pattern.id().isBlank() && ids.add(pattern.id()), "排刀标识无效或重复");
            check(pattern.repetitions()>0 && pattern.lengthMm()>0 && pattern.lengthMm()<=1_000_000_000L
                    && pattern.lengthMm()%1000==0, "重复数或卷长无效");
            check(pattern.rollWidthMm()>=p.minWidthMm() && pattern.rollWidthMm()<=p.maxWidthMm()
                    && (pattern.rollWidthMm()-p.minWidthMm())%p.widthStepMm()==0, "排刀候选幅宽不符合区间/步长");
            long width=0;
            var expected=new HashMap<Integer,Long>();
            for(var station:pattern.stations()) {
                check(station.widthMm()>0 && station.countPerRepetition()>0, "工位宽度和数量必须为正");
                check(!expected.containsKey(station.widthMm()), "相同幅宽的工位必须合并计数");
                width=Math.addExact(width,Math.multiplyExact((long)station.widthMm(),station.countPerRepetition()));
                expected.put(station.widthMm(),Math.multiplyExact((long)station.countPerRepetition(),pattern.repetitions()));
            }
            check(width>0 && width==pattern.patternWidthMm() && width<=pattern.rollWidthMm() && width<=usable,
                    "工位组合宽度、排刀幅宽或扣边可用幅宽不一致");
            var actual=new HashMap<Integer,Long>();var allocatedIds=new HashSet<String>();
            for(var a:pattern.allocations()) {
                var order=orders.get(a.orderId());
                check(order!=null && a.quantity()>0 && allocatedIds.add(a.orderId()), "订单分配无效、重复或未知");
                check(order.lengthMm()==pattern.lengthMm() && Objects.equals(order.surfaceTreatment(),pattern.surfaceTreatment()),
                        "订单卷长/表面处理与实际排刀不一致");
                actual.merge(order.widthMm(),(long)a.quantity(),Math::addExact);
                counts.merge(order.id(),a.quantity(),Math::addExact);
            }
            check(actual.equals(expected), "逐幅宽产出与订单分配不一致");
            for(long n:expected.values())totalProduced=Math.addExact(totalProduced,n);
            check(totalProduced<=100_000, "结果超过产出资源限制");
            long length=Math.multiplyExact(pattern.lengthMm(),pattern.repetitions());
            pieceArea=Math.addExact(pieceArea,Math.multiplyExact(width,length));
            motherArea=Math.addExact(motherArea,Math.multiplyExact((long)p.motherWidthMm(),length));
            usableArea=Math.addExact(usableArea,Math.multiplyExact((long)usable,length));
        }
        int over=0;var seen=new HashSet<String>();
        for(var f:r.fulfillment()) {
            var o=orders.get(f.orderId());
            check(o!=null && seen.add(f.orderId()), "履约订单未知或重复");
            int produced=counts.getOrDefault(o.id(),0);
            check(f.requested()==o.quantity() && f.produced()==produced
                    && f.missing()==Math.max(0,o.quantity()-produced)
                    && f.overproduced()==Math.max(0,produced-o.quantity()), "履约统计与实际分配不一致");
            over=Math.addExact(over,f.overproduced());
        }
        check(seen.size()==orders.size(), "履约报告没有覆盖全部订单");
        check(over==r.totalOverproduced() && over<=p.totalOverCap(), "全请求总超产超过上限或统计错误");
        check(pieceArea==r.pieceAreaMm2() && motherArea==r.motherAreaMm2() && usableArea==r.usableAreaMm2(),
                "面积指标与实际排刀不一致");
    }
    private static void check(boolean valid,String message) {
        if(!valid)throw new ValidationException("INVALID_RESULT",message);
    }
}
