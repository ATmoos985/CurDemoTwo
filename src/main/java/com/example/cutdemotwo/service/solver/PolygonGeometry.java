package com.example.cutdemotwo.service.solver;

import com.example.cutdemotwo.model.nesting.NestingProblem.Point;
import com.example.cutdemotwo.model.nesting.NestingProblem.Shape;
import java.awt.geom.Area;
import java.awt.geom.Line2D;
import java.awt.geom.Path2D;
import java.awt.geom.PathIterator;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import static com.example.cutdemotwo.service.solver.NestingValidation.*;

/** Straight-edge geometry in source coordinates. No bounding-box approximation of material area. */
public final class PolygonGeometry {
    private PolygonGeometry() {}
    public static List<Point> vertices(Shape shape) {
        return "RECTANGLE".equals(shape.type()) ? List.of(new Point(0, 0), new Point(shape.width(), 0),
                new Point(shape.width(), shape.height()), new Point(0, shape.height())) : shape.vertices();
    }
    public static double area(Shape shape) { return Math.abs(signedArea(vertices(shape))); }
    public static double signedArea(List<Point> points) {
        double sum = 0;
        for (int i = 0; i < points.size(); i++) {
            Point a = points.get(i), b = points.get((i + 1) % points.size());
            sum += a.x() * b.y() - b.x() * a.y();
        }
        return sum / 2;
    }
    static void validate(Shape shape) {
        require(shape != null && shape.type() != null, "必须提供几何类型");
        if ("RECTANGLE".equals(shape.type())) { rectangle(shape); return; }
        supported("POLYGON".equals(shape.type()), "仅支持矩形和简单多边形");
        require(positive(shape.width()) && positive(shape.height()), "多边形外接尺寸必须是有效正数");
        var points = shape.vertices();
        require(points.size() >= 3 && points.size() <= 128, "多边形应提供 3–128 个顶点，末点不重复首点");
        var unique = new HashSet<Point>();
        for (Point p : points) require(p != null && nonnegative(p.x()) && nonnegative(p.y()) && unique.add(p), "多边形顶点坐标无效或重复");
        double minX = points.stream().mapToDouble(Point::x).min().orElseThrow(), minY = points.stream().mapToDouble(Point::y).min().orElseThrow();
        double maxX = points.stream().mapToDouble(Point::x).max().orElseThrow(), maxY = points.stream().mapToDouble(Point::y).max().orElseThrow();
        require(Math.abs(minX) < 1e-7 && Math.abs(minY) < 1e-7 && Math.abs(maxX - shape.width()) < 1e-7
                && Math.abs(maxY - shape.height()) < 1e-7, "多边形应以外接框左上角归零，宽高必须匹配顶点范围");
        require(area(shape) > 1e-6, "多边形面积必须大于零");
        int n = points.size();
        for (int i = 0; i < n; i++) {
            Point a = points.get(i), b = points.get((i + 1) % n), c = points.get((i + 2) % n);
            double cross = (b.x()-a.x())*(c.y()-b.y()) - (b.y()-a.y())*(c.x()-b.x());
            double dot = (b.x()-a.x())*(c.x()-b.x()) + (b.y()-a.y())*(c.y()-b.y());
            require(Math.abs(cross) > 1e-9 || dot >= 0, "多边形相邻边不能折返重叠");
            for (int j = i + 2; j < n; j++) {
                if (i == 0 && j == n - 1) continue;
                Point d = points.get(j), e = points.get((j + 1) % n);
                require(!Line2D.linesIntersect(a.x(), a.y(), b.x(), b.y(), d.x(), d.y(), e.x(), e.y()), "多边形边界不能自交或自接触");
            }
        }
    }
    public static Area region(Shape shape, double x, double y) {
        Path2D.Double path = new Path2D.Double();
        var points = vertices(shape);
        path.moveTo(points.get(0).x() + x, points.get(0).y() + y);
        for (int i = 1; i < points.size(); i++) path.lineTo(points.get(i).x() + x, points.get(i).y() + y);
        path.closePath(); return new Area(path);
    }
    /** Area boolean operations may return multiple rings, including holes. */
    public static double area(Area region) {
        double sum = 0; var ring = new ArrayList<Point>(); double[] c = new double[6];
        for (var it = region.getPathIterator(null); !it.isDone(); it.next()) {
            int kind = it.currentSegment(c);
            if (kind == PathIterator.SEG_MOVETO) { ring.clear(); ring.add(new Point(c[0], c[1])); }
            else if (kind == PathIterator.SEG_LINETO) ring.add(new Point(c[0], c[1]));
            else if (kind == PathIterator.SEG_CLOSE) sum += signedArea(ring);
            else throw new IllegalArgumentException("仅支持直线轮廓");
        }
        return Math.abs(sum);
    }
    /** Positive angles follow x-right/y-down source coordinates (clockwise on the canvas). */
    public static Shape rotate(Shape shape, int degrees) {
        var points = vertices(shape).stream().map(p -> switch (degrees) {
            case 0 -> p;
            case 90 -> new Point(-p.y(), p.x());
            case 180 -> new Point(-p.x(), -p.y());
            case 270 -> new Point(p.y(), -p.x());
            default -> throw new IllegalArgumentException("仅支持 90 度步进旋转");
        }).toList();
        double minX = points.stream().mapToDouble(Point::x).min().orElseThrow(), minY = points.stream().mapToDouble(Point::y).min().orElseThrow();
        double w = points.stream().mapToDouble(Point::x).max().orElseThrow() - minX, h = points.stream().mapToDouble(Point::y).max().orElseThrow() - minY;
        return "RECTANGLE".equals(shape.type()) ? Shape.rectangle(w, h) : new Shape("POLYGON", w, h,
                points.stream().map(p -> new Point(p.x() - minX, p.y() - minY)).toList());
    }
}
