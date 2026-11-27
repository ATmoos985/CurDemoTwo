package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.Envelope;
import org.locationtech.jts.geom.Geometry;
import org.locationtech.jts.geom.GeometryFactory;
import org.locationtech.jts.geom.LinearRing;
import org.locationtech.jts.geom.MultiPolygon;
import org.locationtech.jts.geom.Polygon;
import org.locationtech.jts.geom.TopologyException;
import org.locationtech.jts.geom.util.AffineTransformation;
import org.locationtech.jts.geom.util.GeometryFixer;
import org.locationtech.jts.geom.util.PolygonExtracter;
import org.locationtech.jts.operation.buffer.BufferOp;
import org.locationtech.jts.operation.buffer.BufferParameters;
import org.locationtech.jts.operation.overlayng.OverlayNG;
import org.locationtech.jts.operation.overlayng.OverlayNGRobust;
import org.locationtech.jts.operation.union.UnaryUnionOp;

import java.awt.geom.AffineTransform;
import java.awt.geom.Area;
import java.awt.geom.Path2D;
import java.util.ArrayList;
import java.util.List;

/**
 * 纯 JTS 高精度几何构建、快慢双轨布尔运算、Buffer 偏移与 {@link Area} 兼容转换底层内核。
 */
final class DeepnestJtsGeometrySupport {
    /** Micro-tolerance keeping exact zero-slack contact channels open during boolean subtraction. */
    static final double OPEN_CHANNEL_EPS = 5e-7;
    /** Extra safety margin on pieceGap offset so discrete NFP edges strictly exceed pieceGap. */
    static final double GAP_SAFETY_MM = 0.015;
    /** JTS round-buffer segments per quadrant (8/quadrant = 32-gon, chord compensation 1/cos(pi/32) ≈ 1.00484). */
    static final int BUFFER_QUADRANT_SEGMENTS = 8;
    private static final double BUFFER_CIRCUM_FACTOR = 1.0 / Math.cos(Math.PI / (4.0 * BUFFER_QUADRANT_SEGMENTS));

    static final GeometryFactory GEOM_FACTORY = new GeometryFactory();
    static final Geometry EMPTY_GEOM = GEOM_FACTORY.createPolygon();
    static {
        EMPTY_GEOM.getEnvelopeInternal();
    }

    private DeepnestJtsGeometrySupport() {}

    static Geometry toJtsPolygon(List<Point> points, double dx, double dy) {
        if (points == null || points.size() < 3) return EMPTY_GEOM;
        List<Coordinate> coords = new ArrayList<>(points.size() + 1);
        for (Point p : points) {
            double x = p.x() + dx;
            double y = p.y() + dy;
            if (coords.isEmpty()) {
                coords.add(new Coordinate(x, y));
            } else {
                Coordinate prev = coords.get(coords.size() - 1);
                if (Math.abs(prev.x - x) > 1e-12 || Math.abs(prev.y - y) > 1e-12) {
                    coords.add(new Coordinate(x, y));
                }
            }
        }
        if (coords.size() > 1 && coords.get(0).equals2D(coords.get(coords.size() - 1), 1e-12)) {
            coords.remove(coords.size() - 1);
        }
        if (coords.size() < 3) return EMPTY_GEOM;
        coords.add(new Coordinate(coords.get(0).x, coords.get(0).y));
        Polygon poly = GEOM_FACTORY.createPolygon(coords.toArray(Coordinate[]::new));
        return ensureValidPolygonal(poly);
    }

    static Geometry toJtsPolygon(Shape shape, double dx, double dy) {
        if (shape == null) return EMPTY_GEOM;
        if (!shape.hasHoles()) {
            if ("RECTANGLE".equals(shape.type())) {
                return rectGeometry(dx, dy, shape.width(), shape.height());
            }
            return toJtsPolygon(PolygonGeometry.vertices(shape), dx, dy);
        }
        LinearRing shell = toLinearRing(PolygonGeometry.vertices(shape), dx, dy);
        if (shell == null) return EMPTY_GEOM;
        List<LinearRing> holeRings = new ArrayList<>(shape.holes().size());
        for (List<Point> hole : shape.holes()) {
            LinearRing hr = toLinearRing(hole, dx, dy);
            if (hr != null) {
                holeRings.add(hr);
            }
        }
        Polygon poly = GEOM_FACTORY.createPolygon(shell, holeRings.toArray(LinearRing[]::new));
        return ensureValidPolygonal(poly);
    }

    private static LinearRing toLinearRing(List<Point> points, double dx, double dy) {
        if (points == null || points.size() < 3) return null;
        List<Coordinate> coords = new ArrayList<>(points.size() + 1);
        for (Point p : points) {
            double x = p.x() + dx;
            double y = p.y() + dy;
            if (coords.isEmpty()) {
                coords.add(new Coordinate(x, y));
            } else {
                Coordinate prev = coords.get(coords.size() - 1);
                if (Math.abs(prev.x - x) > 1e-12 || Math.abs(prev.y - y) > 1e-12) {
                    coords.add(new Coordinate(x, y));
                }
            }
        }
        if (coords.size() > 1 && coords.get(0).equals2D(coords.get(coords.size() - 1), 1e-12)) {
            coords.remove(coords.size() - 1);
        }
        if (coords.size() < 3) return null;
        coords.add(new Coordinate(coords.get(0).x, coords.get(0).y));
        return GEOM_FACTORY.createLinearRing(coords.toArray(Coordinate[]::new));
    }

    static Geometry rectGeometry(double x, double y, double w, double h) {
        if (w <= 0.0 || h <= 0.0 || !Double.isFinite(w) || !Double.isFinite(h)) {
            return EMPTY_GEOM;
        }
        Coordinate[] coords = new Coordinate[]{
                new Coordinate(x, y),
                new Coordinate(x + w, y),
                new Coordinate(x + w, y + h),
                new Coordinate(x, y + h),
                new Coordinate(x, y)
        };
        Polygon poly = GEOM_FACTORY.createPolygon(coords);
        poly.getEnvelopeInternal();
        return poly;
    }

    /**
     * 将已知严格凸多边形直接转换为 JTS {@link Polygon}，省去无意义的 {@code isValid()} 全边自交检查。
     */
    static Geometry toJtsConvexPolygon(List<Point> points) {
        if (points == null || points.size() < 3) return EMPTY_GEOM;
        int n = points.size();
        List<Coordinate> coords = new ArrayList<>(n + 1);
        for (int i = 0; i < n; i++) {
            Point p = points.get(i);
            if (coords.isEmpty()) {
                coords.add(new Coordinate(p.x(), p.y()));
            } else {
                Coordinate prev = coords.get(coords.size() - 1);
                if (Math.abs(prev.x - p.x()) > 1e-12 || Math.abs(prev.y - p.y()) > 1e-12) {
                    coords.add(new Coordinate(p.x(), p.y()));
                }
            }
        }
        if (coords.size() > 1 && coords.get(0).equals2D(coords.get(coords.size() - 1), 1e-12)) {
            coords.remove(coords.size() - 1);
        }
        if (coords.size() < 3) return EMPTY_GEOM;
        coords.add(new Coordinate(coords.get(0).x, coords.get(0).y));
        Polygon poly = GEOM_FACTORY.createPolygon(coords.toArray(Coordinate[]::new));
        poly.getEnvelopeInternal();
        return poly;
    }

    /**
     * 零分配外接框平移相交预判：在平移 {@code geom} 前检查其外接框平移 {@code (dx, dy)} 后是否与 {@code targetEnv} 相交。
     */
    static boolean translatedEnvelopeIntersects(Geometry geom, double dx, double dy, Envelope targetEnv) {
        if (geom == null || geom.isEmpty() || targetEnv == null || targetEnv.isNull()) {
            return false;
        }
        Envelope e = geom.getEnvelopeInternal();
        return e.getMaxX() + dx >= targetEnv.getMinX()
                && e.getMinX() + dx <= targetEnv.getMaxX()
                && e.getMaxY() + dy >= targetEnv.getMinY()
                && e.getMinY() + dy <= targetEnv.getMaxY();
    }

    /**
     * 仅提取纯二维面状几何（Polygon / MultiPolygon）并预热 envelope；
     * 若输入已是 Polygon 或 MultiPolygon 则直接复用，避免冗余拷贝与重复外接框计算。
     */
    private static Geometry extractPolygonal(Geometry geom) {
        if (geom == null || geom.isEmpty()) return EMPTY_GEOM;
        if (geom instanceof Polygon || geom instanceof MultiPolygon) {
            geom.getEnvelopeInternal();
            return geom;
        }
        @SuppressWarnings("unchecked")
        List<Polygon> polys = PolygonExtracter.getPolygons(geom);
        if (polys.isEmpty()) {
            return EMPTY_GEOM;
        }
        Geometry result = polys.size() == 1
                ? polys.get(0)
                : GEOM_FACTORY.createMultiPolygon(polys.toArray(Polygon[]::new));
        result.getEnvelopeInternal();
        return result;
    }

    /**
     * 将两个已知合法且外接框严格分离的面状几何直接拼装为 {@link MultiPolygon}（$O(1)$ 零布尔运算）。
     */
    private static Geometry combineDisjointPolygonal(Geometry a, Geometry b) {
        int countA = a instanceof Polygon ? 1 : (a instanceof MultiPolygon ? a.getNumGeometries() : -1);
        int countB = b instanceof Polygon ? 1 : (b instanceof MultiPolygon ? b.getNumGeometries() : -1);
        if (countA > 0 && countB > 0) {
            Polygon[] polys = new Polygon[countA + countB];
            int idx = 0;
            if (a instanceof Polygon pa) {
                polys[idx++] = pa;
            } else {
                for (int i = 0; i < countA; i++) {
                    polys[idx++] = (Polygon) a.getGeometryN(i);
                }
            }
            if (b instanceof Polygon pb) {
                polys[idx++] = pb;
            } else {
                for (int i = 0; i < countB; i++) {
                    polys[idx++] = (Polygon) b.getGeometryN(i);
                }
            }
            MultiPolygon mp = GEOM_FACTORY.createMultiPolygon(polys);
            mp.getEnvelopeInternal();
            return mp;
        }
        List<Polygon> polys = new ArrayList<>();
        PolygonExtracter.getPolygons(a, polys);
        PolygonExtracter.getPolygons(b, polys);
        if (polys.isEmpty()) return EMPTY_GEOM;
        Geometry res = polys.size() == 1
                ? polys.get(0)
                : GEOM_FACTORY.createMultiPolygon(polys.toArray(Polygon[]::new));
        res.getEnvelopeInternal();
        return res;
    }

    /**
     * 校验并修复任意 JTS 几何，仅保留合法的二维面状部分（Polygon / MultiPolygon），并预热 envelope 保证多线程只读安全。
     */
    static Geometry ensureValidPolygonal(Geometry geom) {
        if (geom == null || geom.isEmpty()) return EMPTY_GEOM;
        Geometry valid = geom.isValid() ? geom : GeometryFixer.fix(geom);
        return extractPolygonal(valid);
    }

    /**
     * 双几何并集快慢双轨分流：
     * 外接框严格不相交时 $O(1)$ 直拼；相交时走轻量单次 {@link OverlayNG#overlay(Geometry, Geometry, int)}，
     * 仅在抛出 {@link TopologyException} 时回退 {@link OverlayNGRobust} + {@link GeometryFixer}。
     */
    static Geometry unionTwoGeometries(Geometry a, Geometry b) {
        if (a == null || a.isEmpty()) return extractPolygonal(b);
        if (b == null || b.isEmpty()) return extractPolygonal(a);
        if (!a.getEnvelopeInternal().intersects(b.getEnvelopeInternal())) {
            return combineDisjointPolygonal(a, b);
        }
        ComputationCancellation.check();
        try {
            return extractPolygonal(OverlayNG.overlay(a, b, OverlayNG.UNION));
        } catch (TopologyException ignored) {
            return ensureValidPolygonal(OverlayNGRobust.overlay(
                    ensureValidPolygonal(a), ensureValidPolygonal(b), OverlayNG.UNION));
        }
    }

    /** 使用 JTS 快慢双轨分流批量合并多边形集合，带合法性修复兜底。 */
    static Geometry unionGeometries(List<Geometry> geoms) {
        if (geoms == null || geoms.isEmpty()) return EMPTY_GEOM;
        List<Geometry> valid = new ArrayList<>(geoms.size());
        for (Geometry g : geoms) {
            if (g != null && !g.isEmpty()) {
                valid.add(g);
            }
        }
        if (valid.isEmpty()) return EMPTY_GEOM;
        if (valid.size() == 1) return extractPolygonal(valid.get(0));
        if (valid.size() == 2) return unionTwoGeometries(valid.get(0), valid.get(1));
        ComputationCancellation.check();
        try {
            return extractPolygonal(UnaryUnionOp.union(valid));
        } catch (TopologyException ignored) {
            List<Geometry> fixed = new ArrayList<>(valid.size());
            for (Geometry g : valid) {
                Geometry fg = ensureValidPolygonal(g);
                if (!fg.isEmpty()) fixed.add(fg);
            }
            if (fixed.isEmpty()) return EMPTY_GEOM;
            if (fixed.size() == 1) return fixed.get(0);
            return ensureValidPolygonal(UnaryUnionOp.union(fixed));
        }
    }

    /**
     * 布尔差集 {@code a \ b} 快慢双轨分流：
     * 先执行外接框剪枝及 MultiPolygon 子分量外接框预筛，再走轻量单次 {@link OverlayNG#overlay(Geometry, Geometry, int)}，
     * 仅在抛出 {@link TopologyException} 时回退 {@link OverlayNGRobust} + {@link GeometryFixer}。
     */
    static Geometry differenceGeometry(Geometry a, Geometry b) {
        if (a == null || a.isEmpty()) return EMPTY_GEOM;
        if (b == null || b.isEmpty()) return a;
        Envelope envA = a.getEnvelopeInternal();
        if (!envA.intersects(b.getEnvelopeInternal())) {
            return a;
        }
        Geometry effB = b;
        if (b instanceof MultiPolygon mp) {
            int num = mp.getNumGeometries();
            List<Polygon> overlapping = null;
            for (int i = 0; i < num; i++) {
                Polygon sub = (Polygon) mp.getGeometryN(i);
                if (envA.intersects(sub.getEnvelopeInternal())) {
                    if (overlapping == null) {
                        overlapping = new ArrayList<>(num);
                    }
                    overlapping.add(sub);
                }
            }
            if (overlapping == null) {
                return a;
            }
            if (overlapping.size() == 1) {
                effB = overlapping.get(0);
            } else if (overlapping.size() < num) {
                effB = GEOM_FACTORY.createMultiPolygon(overlapping.toArray(Polygon[]::new));
                effB.getEnvelopeInternal();
            }
        }
        ComputationCancellation.check();
        try {
            return extractPolygonal(OverlayNG.overlay(a, effB, OverlayNG.DIFFERENCE));
        } catch (TopologyException ignored) {
            return ensureValidPolygonal(OverlayNGRobust.overlay(
                    ensureValidPolygonal(a), ensureValidPolygonal(effB), OverlayNG.DIFFERENCE));
        }
    }

    /**
     * 布尔交集 {@code a ∩ b} 快慢双轨分流：
     * 先外接框剪枝，再走轻量单次 {@link OverlayNG#overlay(Geometry, Geometry, int)}，
     * 仅在抛出 {@link TopologyException} 时回退 {@link OverlayNGRobust} + {@link GeometryFixer}。
     */
    static Geometry intersectionGeometry(Geometry a, Geometry b) {
        if (a == null || a.isEmpty() || b == null || b.isEmpty()) return EMPTY_GEOM;
        if (!a.getEnvelopeInternal().intersects(b.getEnvelopeInternal())) {
            return EMPTY_GEOM;
        }
        ComputationCancellation.check();
        try {
            return extractPolygonal(OverlayNG.overlay(a, b, OverlayNG.INTERSECTION));
        } catch (TopologyException ignored) {
            return ensureValidPolygonal(OverlayNGRobust.overlay(
                    ensureValidPolygonal(a), ensureValidPolygonal(b), OverlayNG.INTERSECTION));
        }
    }

    /**
     * 使用 JTS {@link BufferOp} 对多边形执行精确欧氏圆角外扩。
     * 通过外接补偿因子 {@code 1 / cos(π / (4 * quadrantSegments))} 保证离散折线的内切圆半径严格不小于 {@code distance + safetyMm}，
     * 消除旧版 16 边形圆盘 1.0196x 过膨胀（降至 ~1.0048x）。
     */
    static Geometry bufferPrecise(Geometry geom, double distance, double safetyMm) {
        if (geom == null || geom.isEmpty()) return EMPTY_GEOM;
        double total = distance + safetyMm;
        if (total <= 0.0) return geom;
        ComputationCancellation.check();
        double circumRadius = total * BUFFER_CIRCUM_FACTOR;
        BufferParameters params = new BufferParameters(
                BUFFER_QUADRANT_SEGMENTS,
                BufferParameters.CAP_ROUND,
                BufferParameters.JOIN_ROUND,
                BufferParameters.DEFAULT_MITRE_LIMIT
        );
        Geometry buffered = BufferOp.bufferOp(geom, circumRadius, params);
        return ensureValidPolygonal(buffered);
    }

    /** 中心反演 {@code p -> -p}：返回新几何实例，不修改源对象。 */
    static Geometry invertGeometry(Geometry src) {
        if (src == null || src.isEmpty()) return EMPTY_GEOM;
        Geometry inverted = AffineTransformation.scaleInstance(-1.0, -1.0).transform(src);
        inverted.getEnvelopeInternal();
        return inverted;
    }

    /** 平移几何：零偏移直接返回只读源对象，否则返回新几何实例。 */
    static Geometry translateGeometry(Geometry src, double dx, double dy) {
        if (src == null || src.isEmpty()) return EMPTY_GEOM;
        if (Math.abs(dx) < 1e-15 && Math.abs(dy) < 1e-15) {
            return src;
        }
        Geometry translated = AffineTransformation.translationInstance(dx, dy).transform(src);
        translated.getEnvelopeInternal();
        return translated;
    }

    /** 将 JTS 面状几何转换为 {@link Area}（仅用于向后兼容旧测试签名，不在求解热路径使用）。 */
    static Area toArea(Geometry geom) {
        if (geom == null || geom.isEmpty()) return new Area();
        @SuppressWarnings("unchecked")
        List<Polygon> polys = PolygonExtracter.getPolygons(geom);
        if (polys.isEmpty()) return new Area();
        Path2D.Double path = new Path2D.Double(Path2D.WIND_EVEN_ODD);
        for (Polygon poly : polys) {
            appendLinearRingToPath(poly.getExteriorRing(), path);
            for (int i = 0; i < poly.getNumInteriorRing(); i++) {
                appendLinearRingToPath(poly.getInteriorRingN(i), path);
            }
        }
        return new Area(path);
    }

    private static void appendLinearRingToPath(LinearRing lr, Path2D.Double path) {
        Coordinate[] coords = lr.getCoordinates();
        if (coords.length < 4) return;
        path.moveTo(coords[0].x, coords[0].y);
        for (int i = 1; i < coords.length - 1; i++) {
            path.lineTo(coords[i].x, coords[i].y);
        }
        path.closePath();
    }

    static Area invertArea(Area src) {
        if (src == null || src.isEmpty()) return new Area();
        return src.createTransformedArea(AffineTransform.getScaleInstance(-1.0, -1.0));
    }

    /**
     * 使用 JTS 负 Buffer 对任意多边形（含 U/C 形凹多边形）执行均匀微缩，
     * 避免旧版“向外部质心缩放”在凹腔内壁引发翻转或自交多边形。
     */
    static Geometry shrinkGeometryMicro(Geometry geom, double delta) {
        if (geom == null || geom.isEmpty() || delta <= 0.0) {
            return geom == null ? EMPTY_GEOM : geom;
        }
        BufferParameters miterParams = new BufferParameters(
                BUFFER_QUADRANT_SEGMENTS,
                BufferParameters.CAP_FLAT,
                BufferParameters.JOIN_MITRE,
                BufferParameters.DEFAULT_MITRE_LIMIT
        );
        double cur = delta;
        for (int attempt = 0; attempt < 4; attempt++) {
            Geometry shrunk = ensureValidPolygonal(BufferOp.bufferOp(geom, -cur, miterParams));
            if (!shrunk.isEmpty() && shrunk.isValid() && shrunk.getArea() > 1e-9) {
                return shrunk;
            }
            cur *= 0.25;
        }
        return geom;
    }
}
