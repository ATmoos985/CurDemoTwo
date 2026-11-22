package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Exclusion;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;

import java.awt.geom.Area;
import java.awt.geom.Line2D;
import java.util.List;

/**
 * 异形排样与校验共享几何辅助。
 * 收拢疵点安全外扩/裁剪、AABB 粗筛、轮廓包含/重叠面积检测与多边形最小边段间距检测，
 * 留在 {@code algorithm.nesting} 包内以避免扩大 {@code algorithm.geometry} 对业务层的暴露面。
 */
public final class ContourGeometrySupport {
    private ContourGeometrySupport() {}

    public record ExpandedExclusion(
            Shape shape,
            double x,
            double y,
            double minX,
            double maxX,
            double minY,
            double maxY,
            Area worldArea
    ) {}

    /**
     * 按安全裕量外扩禁入区（无裁剪）：{@code clearance == 0} 保留原始形状，否则生成外扩安全矩形。
     */
    public static ExpandedExclusion expandExclusion(Exclusion exc) {
        double clr = exc.clearance();
        Shape shape = clr == 0.0
                ? exc.shape()
                : Shape.rectangle(exc.shape().width() + 2.0 * clr, exc.shape().height() + 2.0 * clr);
        double x = exc.x() - clr;
        double y = exc.y() - clr;
        Area worldArea = PolygonGeometry.region(shape, x, y);
        worldArea.getBounds2D();
        return new ExpandedExclusion(shape, x, y, x, x + shape.width(), y, y + shape.height(), worldArea);
    }

    /**
     * 按安全裕量外扩禁入区并裁剪到板材边界内（供原生异形求解器生成合法输入多边形）。
     */
    public static ExpandedExclusion expandExclusionClipped(Exclusion exc,
                                                           double materialWidth,
                                                           double materialHeight,
                                                           double minSizeMm) {
        double clr = exc.clearance();
        if (clr == 0.0) {
            Shape shape = exc.shape();
            double x = exc.x();
            double y = exc.y();
            Area worldArea = PolygonGeometry.region(shape, x, y);
            return new ExpandedExclusion(shape, x, y, x, x + shape.width(), y, y + shape.height(), worldArea);
        }
        double left = Math.max(0.0, exc.x() - clr);
        double top = Math.max(0.0, exc.y() - clr);
        double right = Math.min(materialWidth, exc.x() + exc.shape().width() + clr);
        double bottom = Math.min(materialHeight, exc.y() + exc.shape().height() + clr);
        Shape shape = Shape.rectangle(Math.max(minSizeMm, right - left), Math.max(minSizeMm, bottom - top));
        Area worldArea = PolygonGeometry.region(shape, left, top);
        return new ExpandedExclusion(shape, left, top, left, left + shape.width(), top, top + shape.height(), worldArea);
    }

    /** AABB 外接框相交粗筛（含外部安全间距与数值容差）。 */
    public static boolean aabbOverlaps(double minX1, double maxX1, double minY1, double maxY1,
                                       double minX2, double maxX2, double minY2, double maxY2,
                                       double margin) {
        return maxX1 >= minX2 - margin && minX1 <= maxX2 + margin
                && maxY1 >= minY2 - margin && minY1 <= maxY2 + margin;
    }

    /** 判断候选轮廓是否完全位于材料轮廓内部（允许指定面积容差）。 */
    public static boolean isWithinMaterial(Area candidateArea, Area materialArea, double areaTol) {
        Area outside = new Area(candidateArea);
        outside.subtract(materialArea);
        return PolygonGeometry.area(outside) <= areaTol;
    }

    /** 判断两个多边形区域是否存在超出容差的真实重叠。 */
    public static boolean overlapsArea(Area a, Area b, double areaTol) {
        Area overlap = new Area(a);
        overlap.intersect(b);
        return PolygonGeometry.area(overlap) > areaTol;
    }

    /**
     * 检查两个多边形的任意两条边段之间是否存在小于 {@code minGap} 的间距（带容差 {@code gapTol}）。
     * 调用方可传入局部顶点加平移偏移，或世界顶点配合 {@code (0, 0)} 偏移。
     */
    public static boolean violatesMinEdgeGap(List<Point> vertsA, double offsetAx, double offsetAy,
                                             List<Point> vertsB, double offsetBx, double offsetBy,
                                             double minGap, double gapTol) {
        if (minGap <= 0.0) {
            return false;
        }
        int an = vertsA.size();
        int bn = vertsB.size();
        double pad = minGap + gapTol;
        for (int i = 0; i < an; i++) {
            ComputationCancellation.check();
            Point a1 = vertsA.get(i);
            Point a2 = vertsA.get((i + 1) % an);
            double ax = a1.x() + offsetAx, ay = a1.y() + offsetAy;
            double bx = a2.x() + offsetAx, by = a2.y() + offsetAy;
            double aMinX = Math.min(ax, bx) - pad, aMaxX = Math.max(ax, bx) + pad;
            double aMinY = Math.min(ay, by) - pad, aMaxY = Math.max(ay, by) + pad;
            for (int j = 0; j < bn; j++) {
                ComputationCancellation.check();
                Point b1 = vertsB.get(j);
                Point b2 = vertsB.get((j + 1) % bn);
                double cx = b1.x() + offsetBx, cy = b1.y() + offsetBy;
                double dx = b2.x() + offsetBx, dy = b2.y() + offsetBy;
                if (Math.max(cx, dx) < aMinX || Math.min(cx, dx) > aMaxX
                        || Math.max(cy, dy) < aMinY || Math.min(cy, dy) > aMaxY) {
                    continue;
                }
                double dist = Line2D.linesIntersect(ax, ay, bx, by, cx, cy, dx, dy)
                        ? 0.0
                        : Math.min(
                                Math.min(Line2D.ptSegDist(ax, ay, bx, by, cx, cy), Line2D.ptSegDist(ax, ay, bx, by, dx, dy)),
                                Math.min(Line2D.ptSegDist(cx, cy, dx, dy, ax, ay), Line2D.ptSegDist(cx, cy, dx, dy, bx, by))
                        );
                if (dist + gapTol < minGap) {
                    return true;
                }
            }
        }
        return false;
    }
}
