package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.contracts.geometry.Defect;

import java.util.ArrayList;
import java.util.List;

/**
 * 避疵裁窗纯计算工具（后端单一事实源）：
 * 先按安全避让边距外扩，再裁切到当前工位窗口 {@code [0, rollWidth] × [startY, startY + windowLen]}
 * 并换算为工位局部坐标（{@code margin = 0}），同时完整保留疵点类型、严重度、扣分与避让策略等元数据，
 * 确保窗外边界疵点的安全禁区绝不因实体在窗外而被丢弃。
 */
public final class DefectWindowSupport {
    private DefectWindowSupport() {}

    public static List<Defect> sliceForWindow(List<Defect> defects, double startY, double windowLen, double rollWidth) {
        if (defects == null || defects.isEmpty()) {
            return List.of();
        }
        double endY = startY + windowLen;
        List<Defect> sliced = new ArrayList<>();
        for (Defect d : defects) {
            if (d == null) continue;
            double m = Math.max(0.0, d.getMargin());
            double x = Math.max(0.0, d.getX() - m);
            double y = Math.max(startY, d.getY() - m);
            double w = cleanCoord(Math.min(rollWidth, d.getX() + d.getW() + m) - x);
            double h = cleanCoord(Math.min(endY, d.getY() + d.getH() + m) - y);
            if (w <= 0 || h <= 0) continue;
            sliced.add(new Defect(
                    d.getId(), cleanCoord(x), cleanCoord(y - startY), w, h, 0.0,
                    d.getDefectType(), d.getTypeName(), d.getSeverity(), d.getPoints(),
                    d.getDetectionSource(), d.getAvoidanceStrategy(), d.getDescription()
            ));
        }
        return List.copyOf(sliced);
    }

    private static double cleanCoord(double v) {
        if (!Double.isFinite(v)) return 0.0;
        double cleaned = Math.rint(v * 1_000_000.0) / 1_000_000.0;
        return cleaned == 0.0 ? 0.0 : cleaned;
    }
}
