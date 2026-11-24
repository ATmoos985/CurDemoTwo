package com.example.cutdemotwo.algorithm.geometry;

import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import java.awt.geom.Area;
import java.awt.geom.Line2D;
import java.awt.geom.Path2D;
import java.awt.geom.PathIterator;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import static com.example.cutdemotwo.algorithm.geometry.NestingValidation.*;

/** Straight-edge geometry in source coordinates. No bounding-box approximation of material area. */
public final class PolygonGeometry {
    private PolygonGeometry() {}
    public static List<Point> vertices(Shape shape) {
        return "RECTANGLE".equals(shape.type()) ? List.of(new Point(0, 0), new Point(shape.width(), 0),
                new Point(shape.width(), shape.height()), new Point(0, shape.height())) : shape.vertices();
    }
    /** 返回形状的全部闭合环（外轮廓 + 全部内孔环）。 */
    public static List<List<Point>> allRings(Shape shape) {
        List<Point> outer = vertices(shape);
        if (shape.holes().isEmpty()) {
            return List.of(outer);
        }
        var rings = new ArrayList<List<Point>>(1 + shape.holes().size());
        rings.add(outer);
        rings.addAll(shape.holes());
        return rings;
    }
    public static double area(Shape shape) { return shape.areaMm2(); }
    public static double signedArea(List<Point> points) {
        double sum = 0;
        for (int i = 0; i < points.size(); i++) {
            Point a = points.get(i), b = points.get((i + 1) % points.size());
            sum += a.x() * b.y() - b.x() * a.y();
        }
        return sum / 2;
    }
    public static void validate(Shape shape) {
        require(shape != null && shape.type() != null, "必须提供几何类型");
        if ("RECTANGLE".equals(shape.type())) {
            require(shape.vertices().isEmpty(), "矩形不能同时提供多边形顶点");
            require(positive(shape.width()) && positive(shape.height()), "矩形宽高必须是有效正数");
            if (shape.hasHoles()) {
                validateHoles(vertices(shape), shape.holes(), shape.width() * shape.height());
            }
            return;
        }
        supported("POLYGON".equals(shape.type()), "仅支持矩形和简单多边形");
        require(positive(shape.width()) && positive(shape.height()), "多边形外接尺寸必须是有效正数");
        var points = shape.vertices();
        require(points.size() >= 3 && points.size() <= 128, "多边形应提供 3–128 个顶点，末点不重复首点");
        validateSimpleRing(points, "多边形");
        double minX = points.stream().mapToDouble(Point::x).min().orElseThrow(), minY = points.stream().mapToDouble(Point::y).min().orElseThrow();
        double maxX = points.stream().mapToDouble(Point::x).max().orElseThrow(), maxY = points.stream().mapToDouble(Point::y).max().orElseThrow();
        require(Math.abs(minX) < 1e-7 && Math.abs(minY) < 1e-7 && Math.abs(maxX - shape.width()) < 1e-7
                && Math.abs(maxY - shape.height()) < 1e-7, "多边形应以外接框左上角归零，宽高必须匹配顶点范围");
        double outerArea = Math.abs(signedArea(points));
        require(outerArea > 1e-6, "多边形面积必须大于零");
        if (shape.hasHoles()) {
            validateHoles(points, shape.holes(), outerArea);
        }
        require(area(shape) > 1e-6, "多边形净面积必须大于零");
    }

    private static void validateSimpleRing(List<Point> points, String label) {
        var unique = new HashSet<Point>();
        for (Point p : points) {
            require(p != null && nonnegative(p.x()) && nonnegative(p.y()) && unique.add(p),
                    label + "顶点坐标无效或重复");
        }
        require(Math.abs(signedArea(points)) > 1e-6, label + "面积必须大于零");
        int n = points.size();
        for (int i = 0; i < n; i++) {
            Point a = points.get(i), b = points.get((i + 1) % n), c = points.get((i + 2) % n);
            double cross = (b.x() - a.x()) * (c.y() - b.y()) - (b.y() - a.y()) * (c.x() - b.x());
            double dot = (b.x() - a.x()) * (c.x() - b.x()) + (b.y() - a.y()) * (c.y() - b.y());
            require(Math.abs(cross) > 1e-9 || dot >= 0, label + "相邻边不能折返重叠");
            for (int j = i + 2; j < n; j++) {
                if (i == 0 && j == n - 1) continue;
                Point d = points.get(j), e = points.get((j + 1) % n);
                require(!Line2D.linesIntersect(a.x(), a.y(), b.x(), b.y(), d.x(), d.y(), e.x(), e.y()),
                        label + "边界不能自交或自接触");
            }
        }
    }

    private static void validateHoles(List<Point> outer, List<List<Point>> holes, double outerArea) {
        require(holes.size() <= 64, "单个多边形最多支持 64 个内孔洞");
        double totalHoleArea = 0.0;
        for (int hi = 0; hi < holes.size(); hi++) {
            List<Point> hole = holes.get(hi);
            require(hole != null && hole.size() >= 3 && hole.size() <= 128,
                    "内孔洞应提供 3–128 个顶点，末点不重复首点");
            validateSimpleRing(hole, "内孔洞");
            require(!ringsIntersect(outer, hole), "内孔洞边界不能与外环相交或接触");
            for (Point p : hole) {
                require(pointStrictlyInsideRing(p, outer), "内孔洞必须严格位于外环内部");
            }
            totalHoleArea += Math.abs(signedArea(hole));
        }
        require(totalHoleArea < outerArea - 1e-6, "内孔洞总面积必须小于外环面积");
        for (int i = 0; i < holes.size(); i++) {
            List<Point> h1 = holes.get(i);
            for (int j = i + 1; j < holes.size(); j++) {
                List<Point> h2 = holes.get(j);
                require(!ringsIntersect(h1, h2), "内孔洞之间两两不得相交或接触");
                require(!pointStrictlyInsideRing(h1.get(0), h2) && !pointStrictlyInsideRing(h2.get(0), h1),
                        "内孔洞之间不得互相嵌套重叠");
            }
        }
    }

    private static boolean ringsIntersect(List<Point> r1, List<Point> r2) {
        int n1 = r1.size(), n2 = r2.size();
        for (int i = 0; i < n1; i++) {
            Point a = r1.get(i), b = r1.get((i + 1) % n1);
            for (int j = 0; j < n2; j++) {
                Point c = r2.get(j), d = r2.get((j + 1) % n2);
                if (Line2D.linesIntersect(a.x(), a.y(), b.x(), b.y(), c.x(), c.y(), d.x(), d.y())) {
                    return true;
                }
            }
        }
        return false;
    }

    /** 严格点在多边形内判定：不在任何边上（距离 > 1e-7）且射线奇偶交点为奇数。 */
    public static boolean pointStrictlyInsideRing(Point p, List<Point> ring) {
        int n = ring.size();
        boolean inside = false;
        for (int i = 0, j = n - 1; i < n; j = i++) {
            Point a = ring.get(j), b = ring.get(i);
            if (Line2D.ptSegDist(a.x(), a.y(), b.x(), b.y(), p.x(), p.y()) <= 1e-7) {
                return false;
            }
            boolean intersects = ((a.y() > p.y()) != (b.y() > p.y()))
                    && (p.x() < (b.x() - a.x()) * (p.y() - a.y()) / (b.y() - a.y()) + a.x());
            if (intersects) {
                inside = !inside;
            }
        }
        return inside;
    }

    public static Area region(Shape shape, double x, double y) {
        Area outer = ringArea(vertices(shape), x, y);
        if (shape.hasHoles()) {
            for (List<Point> hole : shape.holes()) {
                outer.subtract(ringArea(hole, x, y));
            }
        }
        return outer;
    }

    private static Area ringArea(List<Point> points, double x, double y) {
        Path2D.Double path = new Path2D.Double();
        path.moveTo(points.get(0).x() + x, points.get(0).y() + y);
        for (int i = 1; i < points.size(); i++) path.lineTo(points.get(i).x() + x, points.get(i).y() + y);
        path.closePath();
        return new Area(path);
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
        int norm = Math.floorMod(degrees, 360);
        List<Point> rawVerts = vertices(shape);
        boolean orthogonal = norm == 0 || norm == 90 || norm == 180 || norm == 270;
        double rad = Math.toRadians(norm);
        double cos = Math.cos(rad);
        double sin = Math.sin(rad);
        List<Point> points = rotatePointsRaw(rawVerts, norm, orthogonal, cos, sin);
        double minX = points.stream().mapToDouble(Point::x).min().orElseThrow();
        double minY = points.stream().mapToDouble(Point::y).min().orElseThrow();
        double w = points.stream().mapToDouble(Point::x).max().orElseThrow() - minX;
        double h = points.stream().mapToDouble(Point::y).max().orElseThrow() - minY;
        List<List<Point>> rotatedHoles = List.of();
        if (shape.hasHoles()) {
            var holeList = new ArrayList<List<Point>>(shape.holes().size());
            for (List<Point> hole : shape.holes()) {
                List<Point> rh = rotatePointsRaw(hole, norm, orthogonal, cos, sin).stream()
                        .map(p -> new Point(Math.max(0.0, p.x() - minX), Math.max(0.0, p.y() - minY)))
                        .toList();
                holeList.add(rh);
            }
            rotatedHoles = List.copyOf(holeList);
        }
        if (orthogonal && "RECTANGLE".equals(shape.type())) {
            return rotatedHoles.isEmpty()
                    ? Shape.rectangle(w, h)
                    : new Shape("RECTANGLE", w, h, List.of(), rotatedHoles);
        }
        return new Shape("POLYGON", w, h,
                points.stream().map(p -> new Point(Math.max(0.0, p.x() - minX), Math.max(0.0, p.y() - minY))).toList(),
                rotatedHoles);
    }

    /** 将局部坐标点按与 {@link #rotate(Shape, int)} 完全一致的刚体旋转+左上归零公式变换到旋转后坐标系。 */
    public static Point rotatePointInShape(Shape shape, Point localPoint, int degrees) {
        int norm = Math.floorMod(degrees, 360);
        if (norm == 0) return localPoint;
        List<Point> rawVerts = vertices(shape);
        boolean orthogonal = norm == 90 || norm == 180 || norm == 270;
        double rad = Math.toRadians(norm);
        double cos = Math.cos(rad);
        double sin = Math.sin(rad);
        List<Point> rotatedVerts = rotatePointsRaw(rawVerts, norm, orthogonal, cos, sin);
        double minX = rotatedVerts.stream().mapToDouble(Point::x).min().orElseThrow();
        double minY = rotatedVerts.stream().mapToDouble(Point::y).min().orElseThrow();
        Point rp = rotatePointRaw(localPoint, norm, orthogonal, cos, sin);
        return new Point(rp.x() - minX, rp.y() - minY);
    }

    private static List<Point> rotatePointsRaw(List<Point> pts, int norm, boolean orthogonal, double cos, double sin) {
        if (norm == 0) return pts;
        var out = new ArrayList<Point>(pts.size());
        for (Point p : pts) {
            out.add(rotatePointRaw(p, norm, orthogonal, cos, sin));
        }
        return out;
    }

    private static Point rotatePointRaw(Point p, int norm, boolean orthogonal, double cos, double sin) {
        if (orthogonal) {
            return switch (norm) {
                case 0 -> p;
                case 90 -> new Point(-p.y(), p.x());
                case 180 -> new Point(-p.x(), -p.y());
                case 270 -> new Point(p.y(), -p.x());
                default -> throw new IllegalStateException();
            };
        }
        return new Point(p.x() * cos - p.y() * sin, p.x() * sin + p.y() * cos);
    }
}
