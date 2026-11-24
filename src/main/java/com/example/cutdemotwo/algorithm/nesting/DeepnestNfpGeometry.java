package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Exclusion;
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
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Computational geometry and No-Fit Polygon (NFP) kernel backed by JTS ({@code OverlayNG} / {@code UnaryUnionOp}
 * / {@code BufferOp}), migrated from Deepnest ({@code minkowski.cc}, {@code background.js}, {@code geometryutil.js}).
 *
 * <p>Core capabilities:
 * <ul>
 *   <li>Ear-clipping triangulation + Hertel-Mehlhorn convex polygon decomposition;</li>
 *   <li>Linear-time rotating-calipers Minkowski sum for convex pieces merged via JTS {@link UnaryUnionOp};</li>
 *   <li>High-precision Euclidean offset via JTS {@link BufferOp} (32-segment round join, &lt;0.5% chord overhead);</li>
 *   <li>Outer NFP with center-inversion symmetry ({@link AffineTransformation#scaleInstance(double, double)})
 *       and thread-safe bounded LRU cache (2048 entries);</li>
 *   <li>Inner-Fit Polygon (IFP / Sheet NFP) supporting rectangular fast-path, concave polygon sheets,
 *       and arbitrary defect exclusions with clearance;</li>
 *   <li>Collinear shared-edge length detection ({@code mergedLength}) and Andrew monotone-chain convex hull.</li>
 * </ul>
 */
final class DeepnestNfpGeometry {
    private static final double EPS = 1e-9;
    /** Micro-tolerance keeping exact zero-slack contact channels open during boolean subtraction. */
    static final double OPEN_CHANNEL_EPS = 5e-7;
    /** Extra safety margin on pieceGap offset so discrete NFP edges strictly exceed pieceGap. */
    private static final double GAP_SAFETY_MM = 0.015;
    /** JTS round-buffer segments per quadrant (8/quadrant = 32-gon, chord compensation 1/cos(pi/32) ≈ 1.00484). */
    static final int BUFFER_QUADRANT_SEGMENTS = 8;
    private static final double BUFFER_CIRCUM_FACTOR = 1.0 / Math.cos(Math.PI / (4.0 * BUFFER_QUADRANT_SEGMENTS));
    static final int MAX_OUTER_NFP_CACHE_SIZE = 2048;

    private static final GeometryFactory GEOM_FACTORY = new GeometryFactory();
    static final Geometry EMPTY_GEOM = GEOM_FACTORY.createPolygon();
    static {
        EMPTY_GEOM.getEnvelopeInternal();
    }

    private static final Object OUTER_NFP_CACHE_LOCK = new Object();
    private static final Map<OuterNfpCacheKey, Geometry> OUTER_NFP_CACHE =
            new LinkedHashMap<>(256, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<OuterNfpCacheKey, Geometry> eldest) {
                    return size() > MAX_OUTER_NFP_CACHE_SIZE;
                }
            };
    private static final AtomicLong OUTER_NFP_HITS = new AtomicLong();
    private static final AtomicLong OUTER_NFP_MISSES = new AtomicLong();
    private static final AtomicLong OUTER_NFP_SYMMETRY_HITS = new AtomicLong();

    private DeepnestNfpGeometry() {}

    /** A closed polygon ring extracted from a JTS {@link Geometry}, with signed area indicating winding. */
    record Ring(List<Point> vertices, double signedArea) {}

    /**
     * 归一化多边形顶点签名，用于跨求解会话复用的 Outer NFP LRU 缓存键与对称性规范排序。
     */
    static final class ShapeSignature implements Comparable<ShapeSignature> {
        private final long[] quantizedCoords;
        private final int hash;

        private ShapeSignature(long[] quantizedCoords) {
            this.quantizedCoords = quantizedCoords;
            this.hash = Arrays.hashCode(quantizedCoords);
        }

        static ShapeSignature of(Shape shape) {
            List<Point> pts = normalizePositiveWinding(PolygonGeometry.vertices(shape));
            if (!shape.hasHoles()) {
                long[] coords = new long[pts.size() * 2];
                for (int i = 0; i < pts.size(); i++) {
                    Point p = pts.get(i);
                    coords[i * 2] = Math.round(p.x() * 100_000.0);
                    coords[i * 2 + 1] = Math.round(p.y() * 100_000.0);
                }
                return new ShapeSignature(coords);
            }
            List<long[]> holeSeqs = new ArrayList<>(shape.holes().size());
            int totalLen = pts.size() * 2;
            for (List<Point> hole : shape.holes()) {
                List<Point> normHole = normalizePositiveWinding(hole);
                long[] hc = new long[normHole.size() * 2];
                for (int i = 0; i < normHole.size(); i++) {
                    Point p = normHole.get(i);
                    hc[i * 2] = Math.round(p.x() * 100_000.0);
                    hc[i * 2 + 1] = Math.round(p.y() * 100_000.0);
                }
                holeSeqs.add(hc);
                totalLen += 1 + hc.length;
            }
            holeSeqs.sort(Arrays::compare);
            long[] all = new long[totalLen];
            int pos = 0;
            for (Point p : pts) {
                all[pos++] = Math.round(p.x() * 100_000.0);
                all[pos++] = Math.round(p.y() * 100_000.0);
            }
            for (long[] hc : holeSeqs) {
                all[pos++] = Long.MIN_VALUE;
                System.arraycopy(hc, 0, all, pos, hc.length);
                pos += hc.length;
            }
            return new ShapeSignature(all);
        }

        @Override
        public int compareTo(ShapeSignature other) {
            return Arrays.compare(this.quantizedCoords, other.quantizedCoords);
        }

        @Override
        public boolean equals(Object o) {
            if (this == o) return true;
            if (!(o instanceof ShapeSignature that)) return false;
            return this.hash == that.hash && Arrays.equals(this.quantizedCoords, that.quantizedCoords);
        }

        @Override
        public int hashCode() {
            return hash;
        }
    }

    private record OuterNfpCacheKey(ShapeSignature sigA, ShapeSignature sigB, long pieceGapMicros) {}

    static long outerNfpCacheHits() {
        return OUTER_NFP_HITS.get();
    }

    static long outerNfpCacheMisses() {
        return OUTER_NFP_MISSES.get();
    }

    static long outerNfpSymmetryHits() {
        return OUTER_NFP_SYMMETRY_HITS.get();
    }

    static int outerNfpCacheSize() {
        synchronized (OUTER_NFP_CACHE_LOCK) {
            return OUTER_NFP_CACHE.size();
        }
    }

    static void clearOuterNfpCache() {
        synchronized (OUTER_NFP_CACHE_LOCK) {
            OUTER_NFP_CACHE.clear();
        }
        OUTER_NFP_HITS.set(0);
        OUTER_NFP_MISSES.set(0);
        OUTER_NFP_SYMMETRY_HITS.set(0);
    }

    /**
     * Ensures vertices have positive {@link PolygonGeometry#signedArea(List)}
     * (counter-clockwise in standard math, clockwise in x-right/y-down screen coordinates)
     * and removes collinear redundant intermediate vertices for stable decomposition.
     */
    static List<Point> normalizePositiveWinding(List<Point> raw) {
        if (raw == null || raw.size() < 3) return List.of();
        List<Point> pts = new ArrayList<>(raw);
        if (PolygonGeometry.signedArea(pts) < 0) {
            Collections.reverse(pts);
        }
        boolean changed = true;
        while (changed && pts.size() > 3) {
            changed = false;
            int n = pts.size();
            for (int i = 0; i < n; i++) {
                Point prev = pts.get((i + n - 1) % n);
                Point curr = pts.get(i);
                Point next = pts.get((i + 1) % n);
                if (distSq(prev, curr) < 1e-12) {
                    pts.remove(i);
                    changed = true;
                    break;
                }
                double cross = cross(prev, curr, next);
                double dot = (curr.x() - prev.x()) * (next.x() - curr.x())
                        + (curr.y() - prev.y()) * (next.y() - curr.y());
                if (Math.abs(cross) <= 1e-8 && dot > 0) {
                    pts.remove(i);
                    changed = true;
                    break;
                }
            }
        }
        return List.copyOf(pts);
    }

    /** Returns true if a positively-wound simple polygon is already convex. */
    static boolean isConvexPositive(List<Point> pts) {
        int n = pts.size();
        if (n < 3) return false;
        for (int i = 0; i < n; i++) {
            Point a = pts.get(i);
            Point b = pts.get((i + 1) % n);
            Point c = pts.get((i + 2) % n);
            if (cross(a, b, c) < -1e-8) return false;
        }
        return true;
    }

    /**
     * Decomposes any simple polygon into a compact set of positively-wound convex polygons
     * using ear-clipping triangulation followed by Hertel-Mehlhorn diagonal removal.
     */
    static List<List<Point>> decomposeConvex(Shape shape) {
        List<Point> pts = normalizePositiveWinding(PolygonGeometry.vertices(shape));
        if (pts.size() < 3) return List.of();
        if (isConvexPositive(pts)) {
            return List.of(pts);
        }
        List<List<Point>> triangles = earClipTriangulate(pts);
        if (triangles.isEmpty()) {
            return List.of();
        }
        return mergeConvexPieces(triangles);
    }

    private static List<List<Point>> earClipTriangulate(List<Point> polygon) {
        List<Point> rem = new ArrayList<>(polygon);
        List<List<Point>> triangles = new ArrayList<>(Math.max(1, rem.size() - 2));
        int guard = rem.size() * rem.size() * 2 + 16;
        double edgeTol = -1e-9;

        while (rem.size() > 3 && guard-- > 0) {
            ComputationCancellation.check();
            int n = rem.size();
            boolean earFound = false;
            int bestEar = -1;
            double bestMinAngleScore = -1.0;

            for (int i = 0; i < n; i++) {
                Point prev = rem.get((i + n - 1) % n);
                Point curr = rem.get(i);
                Point next = rem.get((i + 1) % n);
                double area2 = cross(prev, curr, next);
                if (area2 <= 1e-9) continue;

                boolean containsOther = false;
                for (int j = 0; j < n; j++) {
                    if (j == (i + n - 1) % n || j == i || j == (i + 1) % n) continue;
                    Point p = rem.get(j);
                    if (pointInTriangle(p, prev, curr, next, edgeTol)) {
                        containsOther = true;
                        break;
                    }
                }
                if (!containsOther) {
                    double perimSq = distSq(prev, curr) + distSq(curr, next) + distSq(next, prev);
                    double quality = perimSq > EPS ? area2 / perimSq : area2;
                    if (quality > bestMinAngleScore) {
                        bestMinAngleScore = quality;
                        bestEar = i;
                    }
                    earFound = true;
                }
            }

            if (earFound) {
                int i = bestEar;
                Point prev = rem.get((i + n - 1) % n);
                Point curr = rem.get(i);
                Point next = rem.get((i + 1) % n);
                triangles.add(List.of(prev, curr, next));
                rem.remove(i);
            } else if (edgeTol > -1e-4) {
                edgeTol *= 10.0;
            } else {
                return List.of();
            }
        }

        if (rem.size() == 3 && cross(rem.get(0), rem.get(1), rem.get(2)) > 1e-9) {
            triangles.add(List.copyOf(rem));
        }
        return triangles;
    }

    /** Hertel-Mehlhorn greedy merging of adjacent convex polygons sharing an internal diagonal. */
    private static List<List<Point>> mergeConvexPieces(List<List<Point>> pieces) {
        List<List<Point>> work = new ArrayList<>(pieces);
        boolean mergedAny = true;
        while (mergedAny && work.size() > 1) {
            ComputationCancellation.check();
            mergedAny = false;
            outer:
            for (int i = 0; i < work.size(); i++) {
                List<Point> polyA = work.get(i);
                for (int j = i + 1; j < work.size(); j++) {
                    List<Point> polyB = work.get(j);
                    List<Point> candidate = tryMergeSharedEdge(polyA, polyB);
                    if (candidate != null && isConvexPositive(candidate)) {
                        work.set(i, candidate);
                        work.remove(j);
                        mergedAny = true;
                        break outer;
                    }
                }
            }
        }
        return work;
    }

    private static List<Point> tryMergeSharedEdge(List<Point> a, List<Point> b) {
        int na = a.size(), nb = b.size();
        for (int ia = 0; ia < na; ia++) {
            Point a1 = a.get(ia);
            Point a2 = a.get((ia + 1) % na);
            for (int ib = 0; ib < nb; ib++) {
                Point b1 = b.get(ib);
                Point b2 = b.get((ib + 1) % nb);
                if (samePoint(a1, b2) && samePoint(a2, b1)) {
                    List<Point> merged = new ArrayList<>(na + nb - 2);
                    for (int k = 0; k < na; k++) {
                        merged.add(a.get((ia + 1 + k) % na));
                    }
                    for (int k = 1; k < nb - 1; k++) {
                        merged.add(b.get((ib + 1 + k) % nb));
                    }
                    return merged;
                }
            }
        }
        return null;
    }

    /**
     * Exact $O(|P| + |Q|)$ Minkowski sum $P \oplus Q$ of two positively-wound convex polygons
     * via rotating-calipers edge polar angle merge.
     */
    static List<Point> minkowskiSumConvex(List<Point> p, List<Point> q) {
        int np = p.size(), nq = q.size();
        int ip0 = minYXIndex(p);
        int jq0 = minYXIndex(q);

        List<Point> out = new ArrayList<>(np + nq);
        int i = 0, j = 0;
        while (i < np || j < nq) {
            Point pv = p.get((ip0 + (i % np)) % np);
            Point qv = q.get((jq0 + (j % nq)) % nq);
            Point sum = new Point(pv.x() + qv.x(), pv.y() + qv.y());
            if (out.isEmpty() || distSq(out.get(out.size() - 1), sum) > 1e-16) {
                out.add(sum);
            }

            if (i >= np) {
                j++;
                continue;
            }
            if (j >= nq) {
                i++;
                continue;
            }

            Point pNext = p.get((ip0 + ((i + 1) % np)) % np);
            Point qNext = q.get((jq0 + ((j + 1) % nq)) % nq);
            double ux = pNext.x() - pv.x(), uy = pNext.y() - pv.y();
            double wx = qNext.x() - qv.x(), wy = qNext.y() - qv.y();

            int cmp = compareEdgeAngles(ux, uy, wx, wy);
            if (cmp < 0) {
                i++;
            } else if (cmp > 0) {
                j++;
            } else {
                i++;
                j++;
            }
        }
        if (out.size() > 1 && distSq(out.get(0), out.get(out.size() - 1)) <= 1e-16) {
            out.remove(out.size() - 1);
        }
        return out;
    }

    private static int minYXIndex(List<Point> poly) {
        int best = 0;
        Point bp = poly.get(0);
        for (int i = 1; i < poly.size(); i++) {
            Point p = poly.get(i);
            if (p.y() < bp.y() - 1e-12 || (Math.abs(p.y() - bp.y()) <= 1e-12 && p.x() < bp.x())) {
                best = i;
                bp = p;
            }
        }
        return best;
    }

    /** Compares directed edge angles in $[0, 2\pi)$ starting from $+X$ towards $+Y$. */
    private static int compareEdgeAngles(double ux, double uy, double wx, double wy) {
        int hu = (uy > 1e-12 || (Math.abs(uy) <= 1e-12 && ux >= 0)) ? 0 : 1;
        int hw = (wy > 1e-12 || (Math.abs(wy) <= 1e-12 && wx >= 0)) ? 0 : 1;
        if (hu != hw) return Integer.compare(hu, hw);
        double cross = ux * wy - uy * wx;
        double norm = Math.hypot(ux, uy) * Math.hypot(wx, wy);
        if (norm <= 1e-18) return 0;
        double sinDiff = cross / norm;
        if (sinDiff > 1e-9) return -1;
        if (sinDiff < -1e-9) return 1;
        return 0;
    }

    /** Negates a positively-wound convex polygon: $p \mapsto -p$, preserving positive winding. */
    static List<Point> negateConvex(List<Point> convex) {
        List<Point> neg = new ArrayList<>(convex.size());
        for (Point p : convex) {
            neg.add(new Point(-p.x(), -p.y()));
        }
        return neg;
    }

    /** Slightly contracts a convex polygon toward its centroid so exact zero-slack contact channels remain open. */
    private static List<Point> shrinkConvexMicro(List<Point> convex, double delta) {
        double cx = 0, cy = 0;
        for (Point p : convex) {
            cx += p.x();
            cy += p.y();
        }
        cx /= convex.size();
        cy /= convex.size();
        List<Point> out = new ArrayList<>(convex.size());
        for (Point p : convex) {
            double dx = p.x() - cx, dy = p.y() - cy;
            double len = Math.hypot(dx, dy);
            if (len > delta * 4) {
                double scale = (len - delta) / len;
                out.add(new Point(cx + dx * scale, cy + dy * scale));
            } else {
                out.add(p);
            }
        }
        return out;
    }

    // ==================== JTS 高精度几何内核 ====================

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
    private static Geometry toJtsConvexPolygon(List<Point> points) {
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

    /**
     * 对简单多边形（含凹多边形）按半径 {@code inradius} 执行精确 JTS 欧氏外扩，
     * 保留原局部原点 {@code (0, 0)} 坐标系并返回所有闭合轮廓环（含外环与可能的内洞环）。
     */
    static List<Ring> inflateShapeRings(Shape shape, double inradius) {
        ComputationCancellation.check();
        if (inradius <= 0) {
            List<Point> raw = PolygonGeometry.vertices(shape);
            return List.of(new Ring(raw, PolygonGeometry.signedArea(raw)));
        }
        Geometry base = toJtsPolygon(shape, 0.0, 0.0);
        if (base.isEmpty()) {
            return List.of();
        }
        Geometry inflated = bufferPrecise(base, inradius, 0.0);
        return extractRings(inflated);
    }

    /**
     * 线程安全的跨会话有界 LRU Outer NFP 查询（JTS 内核），自动利用中心反演对称性避免 {@code (B, A)} 重复计算。
     * 返回的 JTS {@link Geometry} 已预热 envelope 且仅作只读使用，多线程并发绝对安全。
     */
    static Geometry getOrComputeOuterNfpGeom(Shape shapeA, List<List<Point>> convexA, ShapeSignature sigA,
                                             Shape shapeB, List<List<Point>> convexB, ShapeSignature sigB,
                                             double pieceGap) {
        ComputationCancellation.check();
        long gapMicros = Math.round(Math.max(0.0, pieceGap) * 1_000_000.0);
        boolean inverted = sigA.compareTo(sigB) > 0;
        OuterNfpCacheKey canonicalKey = inverted
                ? new OuterNfpCacheKey(sigB, sigA, gapMicros)
                : new OuterNfpCacheKey(sigA, sigB, gapMicros);

        Geometry cached;
        synchronized (OUTER_NFP_CACHE_LOCK) {
            cached = OUTER_NFP_CACHE.get(canonicalKey);
        }
        if (cached != null) {
            OUTER_NFP_HITS.incrementAndGet();
            if (inverted) {
                OUTER_NFP_SYMMETRY_HITS.incrementAndGet();
                return invertGeometry(cached);
            }
            return cached;
        }

        OUTER_NFP_MISSES.incrementAndGet();
        Geometry computed = inverted
                ? computeOuterNfpGeom(shapeB, convexB, shapeA, convexA, pieceGap)
                : computeOuterNfpGeom(shapeA, convexA, shapeB, convexB, pieceGap);
        computed.getEnvelopeInternal();

        synchronized (OUTER_NFP_CACHE_LOCK) {
            Geometry existing = OUTER_NFP_CACHE.putIfAbsent(canonicalKey, computed);
            if (existing != null) {
                computed = existing;
            }
        }
        return inverted ? invertGeometry(computed) : computed;
    }

    /**
     * Computes the Outer No-Fit Polygon $\text{OuterNFP}(A, B) = A \oplus (-B)$ (plus JTS precise {@link BufferOp}
     * when {@code pieceGap > 0}) as a JTS {@link Geometry}.
     * 当 {@code shapeA} 或 {@code shapeB} 含内孔洞 {@code holes} 时，自动扣除各内孔对应的合法孔内套料可行域（Hole IFP），
     * 允许小件合法嵌套在母件内孔中且严格满足与孔壁的 {@code pieceGap} 安全间距，同时保持中心反演对称性。
     */
    static Geometry computeOuterNfpGeom(Shape shapeA, List<List<Point>> convexA,
                                        Shape shapeB, List<List<Point>> convexB,
                                        double pieceGap) {
        ComputationCancellation.check();
        Geometry baseNfp;
        if (!convexA.isEmpty() && !convexB.isEmpty()) {
            List<Geometry> pieces = new ArrayList<>(convexA.size() * convexB.size());
            for (List<Point> ca : convexA) {
                ComputationCancellation.check();
                List<Point> effA = pieceGap > 0 ? ca : shrinkConvexMicro(ca, OPEN_CHANNEL_EPS);
                for (List<Point> cb : convexB) {
                    List<Point> negB = pieceGap > 0
                            ? negateConvex(cb)
                            : shrinkConvexMicro(negateConvex(cb), OPEN_CHANNEL_EPS);
                    List<Point> sum = minkowskiSumConvex(effA, negB);
                    if (sum.size() >= 3) {
                        Geometry poly = toJtsConvexPolygon(sum);
                        if (!poly.isEmpty()) {
                            pieces.add(poly);
                        }
                    }
                }
            }
            baseNfp = unionGeometries(pieces);
        } else {
            baseNfp = convolveGeomWithNegatedShape(toJtsPolygon(shapeA, 0.0, 0.0), shapeB);
        }

        Geometry resultNfp = (pieceGap > 0.0 && !baseNfp.isEmpty())
                ? bufferPrecise(baseNfp, pieceGap, GAP_SAFETY_MM)
                : baseNfp;

        if (!resultNfp.isEmpty() && shapeA.hasHoles()) {
            for (List<Point> holeA : shapeA.holes()) {
                Geometry holeIfp = computeHoleInnerNfp(holeA, shapeB, pieceGap);
                if (!holeIfp.isEmpty()) {
                    resultNfp = differenceGeometry(resultNfp, holeIfp);
                }
            }
        }
        if (!resultNfp.isEmpty() && shapeB.hasHoles()) {
            for (List<Point> holeB : shapeB.holes()) {
                Geometry holeIfpBA = computeHoleInnerNfp(holeB, shapeA, pieceGap);
                if (!holeIfpBA.isEmpty()) {
                    resultNfp = differenceGeometry(resultNfp, invertGeometry(holeIfpBA));
                }
            }
        }
        return resultNfp;
    }

    /**
     * 计算移动件 {@code innerPart} 在固定件内孔 {@code holeRing}（处于固定件局部坐标系）中的精确合法落位域（Hole IFP），
     * 若 {@code pieceGap > 0} 则先使用 JTS 负 Buffer 将内孔边界向内均匀收缩 {@code pieceGap + GAP_SAFETY_MM}。
     */
    static Geometry computeHoleInnerNfp(List<Point> holeRing, Shape innerPart, double pieceGap) {
        ComputationCancellation.check();
        if (holeRing == null || holeRing.size() < 3 || innerPart == null) {
            return EMPTY_GEOM;
        }
        double hMinX = Double.POSITIVE_INFINITY, hMinY = Double.POSITIVE_INFINITY;
        double hMaxX = Double.NEGATIVE_INFINITY, hMaxY = Double.NEGATIVE_INFINITY;
        for (Point p : holeRing) {
            if (p.x() < hMinX) hMinX = p.x();
            if (p.y() < hMinY) hMinY = p.y();
            if (p.x() > hMaxX) hMaxX = p.x();
            if (p.y() > hMaxY) hMaxY = p.y();
        }
        double partW = innerPart.width();
        double partH = innerPart.height();
        double gapMargin = pieceGap > 0.0 ? (pieceGap + GAP_SAFETY_MM) : 0.0;
        if (partW + 2.0 * gapMargin > (hMaxX - hMinX) + 1e-6
                || partH + 2.0 * gapMargin > (hMaxY - hMinY) + 1e-6) {
            return EMPTY_GEOM;
        }

        Geometry holeGeom = toJtsPolygon(holeRing, 0.0, 0.0);
        if (holeGeom.isEmpty()) {
            return EMPTY_GEOM;
        }
        Geometry effHole = holeGeom;
        if (pieceGap > 0.0) {
            BufferParameters params = new BufferParameters(
                    BUFFER_QUADRANT_SEGMENTS,
                    BufferParameters.CAP_ROUND,
                    BufferParameters.JOIN_MITRE,
                    BufferParameters.DEFAULT_MITRE_LIMIT
            );
            effHole = ensureValidPolygonal(BufferOp.bufferOp(holeGeom, -(pieceGap + GAP_SAFETY_MM), params));
            if (effHole.isEmpty()) {
                return EMPTY_GEOM;
            }
        }

        Envelope env = effHole.getEnvelopeInternal();
        double maxOriginX = env.getMaxX() - partW;
        double maxOriginY = env.getMaxY() - partH;
        if (maxOriginX < env.getMinX() - 1e-6 || maxOriginY < env.getMinY() - 1e-6) {
            return EMPTY_GEOM;
        }

        // 若内孔为轴对齐矩形，直接使用 O(1) 精确解析 IFP
        if (isAxisAlignedRectangle(effHole, env)) {
            double eps = pieceGap > 0.0 ? 0.0 : OPEN_CHANNEL_EPS;
            double w = Math.max(0.0, maxOriginX - env.getMinX()) + 2.0 * eps;
            double h = Math.max(0.0, maxOriginY - env.getMinY()) + 2.0 * eps;
            if (w <= 1e-9 || h <= 1e-9) {
                return EMPTY_GEOM;
            }
            return rectGeometry(env.getMinX() - eps, env.getMinY() - eps, w, h);
        }

        double margin = partW + partH + 20.0;
        Geometry frame = rectGeometry(
                env.getMinX() - margin,
                env.getMinY() - margin,
                env.getWidth() + 2.0 * margin,
                env.getHeight() + 2.0 * margin
        );
        Geometry frameMinusHole = differenceGeometry(frame, effHole);
        Shape shrunkPart = pieceGap > 0.0 ? innerPart : shrinkShapeMicro(innerPart, OPEN_CHANNEL_EPS * 2.0);
        Geometry forbiddenOutside = convolveGeomWithNegatedShape(frameMinusHole, shrunkPart);

        double eps = pieceGap > 0.0 ? 0.0 : OPEN_CHANNEL_EPS;
        Geometry boundingRect = rectGeometry(
                env.getMinX() - eps,
                env.getMinY() - eps,
                Math.max(0.0, maxOriginX - env.getMinX()) + 2.0 * eps,
                Math.max(0.0, maxOriginY - env.getMinY()) + 2.0 * eps
        );
        return differenceGeometry(boundingRect, forbiddenOutside);
    }

    private static boolean isAxisAlignedRectangle(Geometry geom, Envelope env) {
        if (!(geom instanceof Polygon poly) || poly.getNumInteriorRing() > 0) {
            return false;
        }
        double rectArea = env.getWidth() * env.getHeight();
        return rectArea > 1e-9 && Math.abs(poly.getArea() - rectArea) <= 1e-4;
    }

    /**
     * Direct segment-pair Minkowski convolution migrated from {@code minkowski.cc}, backed by JTS {@link UnaryUnionOp},
     * supporting arbitrary polygons with holes.
     */
    static Geometry convolveGeomWithNegatedShape(Geometry geomA, Shape shapeB) {
        ComputationCancellation.check();
        List<Ring> ringsA = extractRings(geomA);
        List<Point> negB = new ArrayList<>();
        for (Point p : PolygonGeometry.vertices(shapeB)) {
            negB.add(new Point(-p.x(), -p.y()));
        }
        if (ringsA.isEmpty() || negB.size() < 3) return EMPTY_GEOM;

        List<Geometry> parts = new ArrayList<>();
        Point b0 = negB.get(0);
        parts.add(translateGeometry(geomA, b0.x(), b0.y()));

        Geometry negBGeom = toJtsPolygon(negB, 0.0, 0.0);
        for (Ring ringA : ringsA) {
            ComputationCancellation.check();
            List<Point> va = ringA.vertices();
            if (va.isEmpty()) continue;
            if (!negBGeom.isEmpty()) {
                parts.add(translateGeometry(negBGeom, va.get(0).x(), va.get(0).y()));
            }
            int na = va.size(), nb = negB.size();
            for (int i = 0; i < na; i++) {
                ComputationCancellation.check();
                Point a1 = va.get(i);
                Point a2 = va.get((i + 1) % na);
                for (int j = 0; j < nb; j++) {
                    Point p1 = negB.get(j);
                    Point p2 = negB.get((j + 1) % nb);
                    double cross = (a2.x() - a1.x()) * (p2.y() - p1.y()) - (a2.y() - a1.y()) * (p2.x() - p1.x());
                    if (Math.abs(cross) <= 1e-9) continue;
                    List<Point> quad = List.of(
                            new Point(a1.x() + p2.x(), a1.y() + p2.y()),
                            new Point(a1.x() + p1.x(), a1.y() + p1.y()),
                            new Point(a2.x() + p1.x(), a2.y() + p1.y()),
                            new Point(a2.x() + p2.x(), a2.y() + p2.y())
                    );
                    Geometry quadGeom = toJtsPolygon(quad, 0.0, 0.0);
                    if (!quadGeom.isEmpty()) {
                        parts.add(quadGeom);
                    }
                }
            }
        }
        return unionGeometries(parts);
    }

    /**
     * Computes the Inner-Fit Polygon (IFP / Sheet NFP) as a JTS {@link Geometry} representing all valid origins $(x, y)$
     * where {@code partShape} lies completely inside {@code materialShape} and outside all {@code exclusions}.
     */
    static Geometry computeInnerNfpGeom(Shape materialShape, List<Exclusion> exclusions,
                                        Shape partShape, List<List<Point>> partConvex) {
        ComputationCancellation.check();
        double matW = materialShape.width();
        double matH = materialShape.height();
        double partW = partShape.width();
        double partH = partShape.height();

        if (partW > matW + 1e-6 || partH > matH + 1e-6) {
            return EMPTY_GEOM;
        }

        Geometry innerFeasible;
        double maxX = Math.max(0.0, matW - partW);
        double maxY = Math.max(0.0, matH - partH);

        if ("RECTANGLE".equals(materialShape.type()) && !materialShape.hasHoles()) {
            // Fast exact IFP for rectangular sheet without holes
            innerFeasible = rectGeometry(
                    -OPEN_CHANNEL_EPS,
                    -OPEN_CHANNEL_EPS,
                    maxX + 2 * OPEN_CHANNEL_EPS,
                    maxY + 2 * OPEN_CHANNEL_EPS
            );
        } else {
            double margin = partW + partH + 20.0;
            Geometry frame = rectGeometry(-margin, -margin, matW + 2 * margin, matH + 2 * margin);
            Geometry sheetRegion = toJtsPolygon(materialShape, 0.0, 0.0);
            Geometry frameMinusSheet = differenceGeometry(frame, sheetRegion);

            Shape shrunkPart = shrinkShapeMicro(partShape, OPEN_CHANNEL_EPS * 2);
            Geometry forbiddenOutside = convolveGeomWithNegatedShape(frameMinusSheet, shrunkPart);

            Geometry boundingRect = rectGeometry(
                    -OPEN_CHANNEL_EPS,
                    -OPEN_CHANNEL_EPS,
                    maxX + 2 * OPEN_CHANNEL_EPS,
                    maxY + 2 * OPEN_CHANNEL_EPS
            );
            innerFeasible = differenceGeometry(boundingRect, forbiddenOutside);
        }

        if (innerFeasible.isEmpty()) {
            return EMPTY_GEOM;
        }

        if (exclusions != null && !exclusions.isEmpty()) {
            List<Geometry> defectNfps = new ArrayList<>(exclusions.size());
            for (Exclusion exc : exclusions) {
                ComputationCancellation.check();
                double clr = exc.clearance();
                Shape excShape = clr == 0
                        ? exc.shape()
                        : Shape.rectangle(exc.shape().width() + 2 * clr, exc.shape().height() + 2 * clr);
                double ex = exc.x() - clr;
                double ey = exc.y() - clr;
                List<List<Point>> excConvex = decomposeConvex(excShape);
                Geometry rawExcNfp = computeOuterNfpGeom(excShape, excConvex, partShape, partConvex, 0.0);
                if (!rawExcNfp.isEmpty()) {
                    defectNfps.add(translateGeometry(rawExcNfp, ex, ey));
                }
            }
            if (!defectNfps.isEmpty()) {
                innerFeasible = differenceGeometry(innerFeasible, unionGeometries(defectNfps));
            }
        }

        return innerFeasible;
    }

    /** Extracts all closed polygonal rings (exterior shells and interior holes) from a JTS {@link Geometry}. */
    static List<Ring> extractRings(Geometry geom) {
        if (geom == null || geom.isEmpty()) return List.of();
        @SuppressWarnings("unchecked")
        List<Polygon> polys = PolygonExtracter.getPolygons(geom);
        if (polys.isEmpty()) return List.of();
        List<Ring> rings = new ArrayList<>(polys.size());
        for (Polygon poly : polys) {
            appendRing(poly.getExteriorRing(), rings);
            int numHoles = poly.getNumInteriorRing();
            for (int i = 0; i < numHoles; i++) {
                appendRing(poly.getInteriorRingN(i), rings);
            }
        }
        return rings;
    }

    private static void appendRing(LinearRing lr, List<Ring> out) {
        if (lr == null || lr.isEmpty()) return;
        Coordinate[] coords = lr.getCoordinates();
        if (coords.length < 4) return;
        int n = coords.length - 1; // last coordinate repeats first
        List<Point> pts = new ArrayList<>(n);
        for (int i = 0; i < n; i++) {
            Point p = new Point(coords[i].x, coords[i].y);
            if (pts.isEmpty() || distSq(pts.get(pts.size() - 1), p) > 1e-18) {
                pts.add(p);
            }
        }
        if (pts.size() > 1 && distSq(pts.get(0), pts.get(pts.size() - 1)) <= 1e-18) {
            pts.remove(pts.size() - 1);
        }
        if (pts.size() >= 3) {
            double sa = PolygonGeometry.signedArea(pts);
            out.add(new Ring(List.copyOf(pts), sa));
        }
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

    // ==================== 向后兼容包装方法（供既有单测调用） ====================

    static Area invertArea(Area src) {
        if (src == null || src.isEmpty()) return new Area();
        return src.createTransformedArea(AffineTransform.getScaleInstance(-1.0, -1.0));
    }

    static Area getOrComputeOuterNfp(Shape shapeA, List<List<Point>> convexA, ShapeSignature sigA,
                                     Shape shapeB, List<List<Point>> convexB, ShapeSignature sigB,
                                     double pieceGap) {
        return toArea(getOrComputeOuterNfpGeom(shapeA, convexA, sigA, shapeB, convexB, sigB, pieceGap));
    }

    static Area computeOuterNfp(Shape shapeA, List<List<Point>> convexA,
                                Shape shapeB, List<List<Point>> convexB,
                                double pieceGap) {
        return toArea(computeOuterNfpGeom(shapeA, convexA, shapeB, convexB, pieceGap));
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

    /**
     * 基于 JTS 负 Buffer 的形状微缩（保留局部左上归零外接框与拓扑合法性，专门修复 U/C 形凹轮廓自交问题）。
     */
    static Shape shrinkShapeMicro(Shape shape, double delta) {
        if (shape == null || delta <= 0.0) {
            return shape;
        }
        Geometry base = toJtsPolygon(PolygonGeometry.vertices(shape), 0.0, 0.0);
        if (base.isEmpty()) {
            return shape;
        }
        Geometry shrunk = shrinkGeometryMicro(base, delta);
        if (shrunk.isEmpty() || shrunk == base) {
            return shape;
        }
        @SuppressWarnings("unchecked")
        List<Polygon> polys = PolygonExtracter.getPolygons(shrunk);
        if (polys.isEmpty()) {
            return shape;
        }
        Polygon largest = polys.get(0);
        for (int i = 1; i < polys.size(); i++) {
            if (polys.get(i).getArea() > largest.getArea()) {
                largest = polys.get(i);
            }
        }
        List<Ring> rings = new ArrayList<>(1);
        appendRing(largest.getExteriorRing(), rings);
        if (rings.isEmpty()) {
            return shape;
        }
        List<Point> verts = rings.get(0).vertices();
        double minX = Double.POSITIVE_INFINITY, minY = Double.POSITIVE_INFINITY;
        double maxX = Double.NEGATIVE_INFINITY, maxY = Double.NEGATIVE_INFINITY;
        for (Point p : verts) {
            if (p.x() < minX) minX = p.x();
            if (p.y() < minY) minY = p.y();
            if (p.x() > maxX) maxX = p.x();
            if (p.y() > maxY) maxY = p.y();
        }
        final double ox = minX, oy = minY;
        List<Point> shifted = verts.stream().map(p -> new Point(p.x() - ox, p.y() - oy)).toList();
        return new Shape("POLYGON", Math.max(1e-6, maxX - minX), Math.max(1e-6, maxY - minY), shifted);
    }

    /**
     * Collinear shared cutting line length detector migrated from {@code D:\GitHub\Deepnest\main\background.js}
     * ({@code mergedLength}, lines 352-487). Rewards candidate placements whose edges align flush against
     * already-placed part edges when {@code pieceGap == 0}.
     */
    static double mergedLength(List<List<Point>> placedWorldPolygons,
                               List<Point> candidateLocalVerts, double candX, double candY,
                               double minLength, double tolerance) {
        if (placedWorldPolygons.isEmpty() || candidateLocalVerts.size() < 2) {
            return 0.0;
        }
        double candMinX = Double.POSITIVE_INFINITY, candMaxX = Double.NEGATIVE_INFINITY;
        double candMinY = Double.POSITIVE_INFINITY, candMaxY = Double.NEGATIVE_INFINITY;
        for (Point p : candidateLocalVerts) {
            double wx = p.x() + candX, wy = p.y() + candY;
            if (wx < candMinX) candMinX = wx;
            if (wx > candMaxX) candMaxX = wx;
            if (wy < candMinY) candMinY = wy;
            if (wy > candMaxY) candMaxY = wy;
        }

        List<List<Point>> nearbyPolys = new ArrayList<>(placedWorldPolygons.size());
        for (List<Point> placed : placedWorldPolygons) {
            if (placed.size() < 2) continue;
            double pMinX = Double.POSITIVE_INFINITY, pMaxX = Double.NEGATIVE_INFINITY;
            double pMinY = Double.POSITIVE_INFINITY, pMaxY = Double.NEGATIVE_INFINITY;
            for (Point bp : placed) {
                if (bp.x() < pMinX) pMinX = bp.x();
                if (bp.x() > pMaxX) pMaxX = bp.x();
                if (bp.y() < pMinY) pMinY = bp.y();
                if (bp.y() > pMaxY) pMaxY = bp.y();
            }
            if (ContourGeometrySupport.aabbOverlaps(candMinX, candMaxX, candMinY, candMaxY,
                    pMinX, pMaxX, pMinY, pMaxY, tolerance)) {
                nearbyPolys.add(placed);
            }
        }
        if (nearbyPolys.isEmpty()) {
            return 0.0;
        }

        double minLenSq = minLength * minLength;
        double totalLength = 0.0;
        int cn = candidateLocalVerts.size();

        for (int i = 0; i < cn; i++) {
            Point a1Local = candidateLocalVerts.get(i);
            Point a2Local = candidateLocalVerts.get((i + 1) % cn);
            double a1x = a1Local.x() + candX, a1y = a1Local.y() + candY;
            double a2x = a2Local.x() + candX, a2y = a2Local.y() + candY;
            double dx = a2x - a1x, dy = a2y - a1y;
            double lenSq = dx * dx + dy * dy;
            if (lenSq < minLenSq) continue;

            double edgeMinX = Math.min(a1x, a2x) - tolerance;
            double edgeMaxX = Math.max(a1x, a2x) + tolerance;
            double edgeMinY = Math.min(a1y, a2y) - tolerance;
            double edgeMaxY = Math.max(a1y, a2y) + tolerance;

            double lenA = Math.sqrt(lenSq);
            double ux = dx / lenA, uy = dy / lenA;

            for (List<Point> placed : nearbyPolys) {
                int pn = placed.size();
                for (int k = 0; k < pn; k++) {
                    Point b1 = placed.get(k);
                    Point b2 = placed.get((k + 1) % pn);
                    if (Math.max(b1.x(), b2.x()) < edgeMinX || Math.min(b1.x(), b2.x()) > edgeMaxX
                            || Math.max(b1.y(), b2.y()) < edgeMinY || Math.min(b1.y(), b2.y()) > edgeMaxY) {
                        continue;
                    }
                    double bdx = b2.x() - b1.x(), bdy = b2.y() - b1.y();
                    if (bdx * bdx + bdy * bdy < minLenSq) continue;

                    double relB1x = b1.x() - a1x, relB1y = b1.y() - a1y;
                    double relB2x = b2.x() - a1x, relB2y = b2.y() - a1y;

                    double perp1 = -relB1x * uy + relB1y * ux;
                    if (Math.abs(perp1) > tolerance) continue;
                    double perp2 = -relB2x * uy + relB2y * ux;
                    if (Math.abs(perp2) > tolerance) continue;

                    double proj1 = relB1x * ux + relB1y * uy;
                    double proj2 = relB2x * ux + relB2y * uy;
                    double minB = Math.min(proj1, proj2);
                    double maxB = Math.max(proj1, proj2);

                    double overlap = Math.min(lenA, maxB) - Math.max(0.0, minB);
                    if (overlap > minLength) {
                        totalLength += overlap;
                    }
                }
            }
        }
        return totalLength;
    }

    /** Andrew's monotone chain $O(M \log M)$ 2D convex hull area (migrated from Deepnest {@code getHull}). */
    static double convexHullArea(List<Point> points) {
        if (points == null || points.size() < 3) return 0.0;
        List<Point> sorted = new ArrayList<>(points);
        sorted.sort(Comparator.comparingDouble(Point::x).thenComparingDouble(Point::y));
        int n = sorted.size();
        Point[] hull = new Point[2 * n];
        int k = 0;
        for (Point p : sorted) {
            while (k >= 2 && cross(hull[k - 2], hull[k - 1], p) <= 0) k--;
            hull[k++] = p;
        }
        for (int i = n - 1, t = k + 1; i > 0; i--) {
            Point p = sorted.get(i - 1);
            while (k >= t && cross(hull[k - 2], hull[k - 1], p) <= 0) k--;
            hull[k++] = p;
        }
        if (k < 4) return 0.0;
        double sum = 0.0;
        for (int i = 0; i < k - 1; i++) {
            Point a = hull[i], b = hull[i + 1];
            sum += a.x() * b.y() - b.x() * a.y();
        }
        return Math.abs(sum) * 0.5;
    }

    private static double cross(Point a, Point b, Point c) {
        return (b.x() - a.x()) * (c.y() - a.y()) - (b.y() - a.y()) * (c.x() - a.x());
    }

    private static double distSq(Point a, Point b) {
        double dx = a.x() - b.x(), dy = a.y() - b.y();
        return dx * dx + dy * dy;
    }

    private static boolean samePoint(Point a, Point b) {
        return Math.abs(a.x() - b.x()) <= 1e-8 && Math.abs(a.y() - b.y()) <= 1e-8;
    }

    private static boolean pointInTriangle(Point p, Point a, Point b, Point c, double tol) {
        double c1 = cross(a, b, p);
        double c2 = cross(b, c, p);
        double c3 = cross(c, a, p);
        return c1 >= tol && c2 >= tol && c3 >= tol;
    }
}
