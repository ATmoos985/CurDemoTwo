package com.example.cutdemotwo.service.solver;

import com.example.cutdemotwo.model.nesting.NestingProblem;
import java.util.HashSet;
import java.util.Set;

final class NestingValidation {
    private NestingValidation() {}
    static class Rejected extends IllegalArgumentException {
        final String status;
        Rejected(String status, String message) { super(message); this.status = status; }
    }
    static void require(boolean condition, String message) {
        if (!condition) throw new Rejected("INVALID_INPUT", message);
    }
    static void supported(boolean condition, String message) {
        if (!condition) throw new Rejected("UNSUPPORTED", message);
    }
    static boolean positive(double n) { return Double.isFinite(n) && n > 0 && n <= 10_000_000; }
    static boolean nonnegative(double n) { return Double.isFinite(n) && n >= 0 && n <= 10_000_000; }
    static void rectangle(NestingProblem.Shape shape) {
        require(shape != null && shape.type() != null, "必须提供几何类型");
        supported("RECTANGLE".equals(shape.type()), "当前引擎仅支持 RECTANGLE，异形尚未接入");
        require(shape.vertices().isEmpty(), "矩形不能同时提供多边形顶点");
        require(positive(shape.width()) && positive(shape.height()), "矩形宽高必须是有效正数");
    }
    static void validate(NestingProblem p) {
        require(p != null, "求解问题不能为空");
        supported("1".equals(p.schemaVersion()), "仅支持 schemaVersion=1");
        supported("mm".equals(p.unit()), "仅支持 mm；请在业务适配层转换单位");
        require(p.material() != null && p.material().id() != null && !p.material().id().isBlank(), "必须提供材料标识");
        rectangle(p.material().shape());
        require(p.process() != null, "必须提供加工约束");
        var c = p.process();
        supported(Set.of("CROSSCUT", "GUILLOTINE").contains(String.valueOf(c.mode())), "不支持的切割工艺");
        supported(Set.of("CONTINUOUS", "SHEET").contains(String.valueOf(c.feedMode())), "不支持的送料方式");
        require(!p.sheet() || !p.material().continuesAfterRegion(), "整块材料不能声明后续连续材料");
        supported(Set.of("left-top", "right-top", "left-bottom", "right-bottom").contains(String.valueOf(c.startCorner())), "不支持的起刀角");
        supported(Set.of("horizontal", "vertical").contains(String.valueOf(c.firstStageOrientation())), "不支持的首刀方向");
        require(nonnegative(c.trimStart()) && c.trimStart() < p.height(), "修边长度必须小于加工区长度");
        require(nonnegative(c.minReusableWidth()) && nonnegative(c.minReusableHeight()), "余料回收尺寸无效");
        supported(c.kerf() == 0, "当前引擎适配仅支持零刀缝");
        require(p.timeLimitSeconds() >= 1 && p.timeLimitSeconds() <= 60, "求解时限应为 1–60 秒");
        require(!p.parts().isEmpty(), "至少提供一项需求");
        Set<Integer> ids = new HashSet<>();
        long quantity = 0;
        for (var part : p.parts()) {
            require(part != null && ids.add(part.id()), "需求标识重复或为空");
            rectangle(part.shape());
            require(part.quantity() > 0, "需求数量必须为正整数");
            quantity += part.quantity();
        }
        require(quantity <= 10_000, "单次求解最多支持 10000 件");
        ids.clear();
        for (var d : p.material().exclusions()) {
            require(d != null && ids.add(d.id()), "禁入区域标识重复或为空");
            rectangle(d.shape());
            require(nonnegative(d.x()) && nonnegative(d.y()) && nonnegative(d.clearance()), "禁入区域坐标或间距无效");
            require(d.x() < p.width() && d.y() < p.height(), "禁入区域必须与加工区相交");
        }
    }
}
