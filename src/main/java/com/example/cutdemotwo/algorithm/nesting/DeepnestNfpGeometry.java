package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Exclusion;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.Envelope;
import org.locationtech.jts.geom.Geometry;
import org.locationtech.jts.geom.LinearRing;
import org.locationtech.jts.geom.Polygon;
import org.locationtech.jts.geom.util.AffineTransformation;
import org.locationtech.jts.geom.util.PolygonExtracter;
import org.locationtech.jts.operation.buffer.BufferOp;
import org.locationtech.jts.operation.buffer.BufferParameters;
import org.locationtech.jts.operation.union.UnaryUnionOp;

import java.awt.geom.Area;
import java.util.ArrayList;
import java.util.Arrays;
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
 *   <li>Ear-clipping triangulation + Hertel-Mehlhorn convex polygon decomposition (via {@link DeepnestConvexPolygonSupport});</li>
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
    /** Micro-tolerance keeping exact zero-slack contact channels open during boolean subtraction. */
    static final double OPEN_CHANNEL_EPS = DeepnestJtsGeometrySupport.OPEN_CHANNEL_EPS;
    /** Extra safety margin on pieceGap offset so discrete NFP edges strictly exceed pieceGap. */
    private static final double GAP_SAFETY_MM = DeepnestJtsGeometrySupport.GAP_SAFETY_MM;
    /** JTS round-buffer segments per quadrant (8/quadrant = 32-gon, chord compensation 1/cos(pi/32) ≈ 1.00484). */
    static final int BUFFER_QUADRANT_SEGMENTS = DeepnestJtsGeometrySupport.BUFFER_QUADRANT_SEGMENTS;
    static final int MAX_OUTER_NFP_CACHE_SIZE = 2048;

    static final Geometry EMPTY_GEOM = DeepnestJtsGeometrySupport.EMPTY_GEOM;

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
            List<Point> pts = DeepnestConvexPolygonSupport.normalizePositiveWinding(PolygonGeometry.vertices(shape));
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
                List<Point> normHole = DeepnestConvexPolygonSupport.normalizePositiveWinding(hole);
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
     * 对简单多边形（含凹多边形）按半径 {@code inradius} 执行精确 JTS 欧氏外扩，
     * 保留原局部原点 {@code (0, 0)} 坐标系并返回所有闭合轮廓环（含外环与可能的内洞环）。
     */
    static List<Ring> inflateShapeRings(Shape shape, double inradius) {
        ComputationCancellation.check();
        if (inradius <= 0) {
            List<Point> raw = PolygonGeometry.vertices(shape);
            return List.of(new Ring(raw, PolygonGeometry.signedArea(raw)));
        }
        Geometry base = DeepnestJtsGeometrySupport.toJtsPolygon(shape, 0.0, 0.0);
        if (base.isEmpty()) {
            return List.of();
        }
        Geometry inflated = DeepnestJtsGeometrySupport.bufferPrecise(base, inradius, 0.0);
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
                return DeepnestJtsGeometrySupport.invertGeometry(cached);
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
        return inverted ? DeepnestJtsGeometrySupport.invertGeometry(computed) : computed;
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
                List<Point> effA = pieceGap > 0
                        ? ca
                        : DeepnestConvexPolygonSupport.shrinkConvexMicro(ca, OPEN_CHANNEL_EPS);
                for (List<Point> cb : convexB) {
                    List<Point> negB = pieceGap > 0
                            ? DeepnestConvexPolygonSupport.negateConvex(cb)
                            : DeepnestConvexPolygonSupport.shrinkConvexMicro(
                                    DeepnestConvexPolygonSupport.negateConvex(cb), OPEN_CHANNEL_EPS);
                    List<Point> sum = DeepnestConvexPolygonSupport.minkowskiSumConvex(effA, negB);
                    if (sum.size() >= 3) {
                        Geometry poly = DeepnestJtsGeometrySupport.toJtsConvexPolygon(sum);
                        if (!poly.isEmpty()) {
                            pieces.add(poly);
                        }
                    }
                }
            }
            baseNfp = DeepnestJtsGeometrySupport.unionGeometries(pieces);
        } else {
            baseNfp = convolveGeomWithNegatedShape(
                    DeepnestJtsGeometrySupport.toJtsPolygon(shapeA, 0.0, 0.0), shapeB);
        }

        Geometry resultNfp = (pieceGap > 0.0 && !baseNfp.isEmpty())
                ? DeepnestJtsGeometrySupport.bufferPrecise(baseNfp, pieceGap, GAP_SAFETY_MM)
                : baseNfp;

        if (!resultNfp.isEmpty() && shapeA.hasHoles()) {
            for (List<Point> holeA : shapeA.holes()) {
                Geometry holeIfp = computeHoleInnerNfp(holeA, shapeB, pieceGap);
                if (!holeIfp.isEmpty()) {
                    resultNfp = DeepnestJtsGeometrySupport.differenceGeometry(resultNfp, holeIfp);
                }
            }
        }
        if (!resultNfp.isEmpty() && shapeB.hasHoles()) {
            for (List<Point> holeB : shapeB.holes()) {
                Geometry holeIfpBA = computeHoleInnerNfp(holeB, shapeA, pieceGap);
                if (!holeIfpBA.isEmpty()) {
                    resultNfp = DeepnestJtsGeometrySupport.differenceGeometry(
                            resultNfp, DeepnestJtsGeometrySupport.invertGeometry(holeIfpBA));
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

        Geometry holeGeom = DeepnestJtsGeometrySupport.toJtsPolygon(holeRing, 0.0, 0.0);
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
            effHole = DeepnestJtsGeometrySupport.ensureValidPolygonal(
                    BufferOp.bufferOp(holeGeom, -(pieceGap + GAP_SAFETY_MM), params));
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
            return DeepnestJtsGeometrySupport.rectGeometry(env.getMinX() - eps, env.getMinY() - eps, w, h);
        }

        double margin = partW + partH + 20.0;
        Geometry frame = DeepnestJtsGeometrySupport.rectGeometry(
                env.getMinX() - margin,
                env.getMinY() - margin,
                env.getWidth() + 2.0 * margin,
                env.getHeight() + 2.0 * margin
        );
        Geometry frameMinusHole = DeepnestJtsGeometrySupport.differenceGeometry(frame, effHole);
        Shape shrunkPart = pieceGap > 0.0 ? innerPart : shrinkShapeMicro(innerPart, OPEN_CHANNEL_EPS * 2.0);
        Geometry forbiddenOutside = convolveGeomWithNegatedShape(frameMinusHole, shrunkPart);

        double eps = pieceGap > 0.0 ? 0.0 : OPEN_CHANNEL_EPS;
        Geometry boundingRect = DeepnestJtsGeometrySupport.rectGeometry(
                env.getMinX() - eps,
                env.getMinY() - eps,
                Math.max(0.0, maxOriginX - env.getMinX()) + 2.0 * eps,
                Math.max(0.0, maxOriginY - env.getMinY()) + 2.0 * eps
        );
        return DeepnestJtsGeometrySupport.differenceGeometry(boundingRect, forbiddenOutside);
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
        parts.add(DeepnestJtsGeometrySupport.translateGeometry(geomA, b0.x(), b0.y()));

        Geometry negBGeom = DeepnestJtsGeometrySupport.toJtsPolygon(negB, 0.0, 0.0);
        for (Ring ringA : ringsA) {
            ComputationCancellation.check();
            List<Point> va = ringA.vertices();
            if (va.isEmpty()) continue;
            if (!negBGeom.isEmpty()) {
                parts.add(DeepnestJtsGeometrySupport.translateGeometry(negBGeom, va.get(0).x(), va.get(0).y()));
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
                    Geometry quadGeom = DeepnestJtsGeometrySupport.toJtsPolygon(quad, 0.0, 0.0);
                    if (!quadGeom.isEmpty()) {
                        parts.add(quadGeom);
                    }
                }
            }
        }
        return DeepnestJtsGeometrySupport.unionGeometries(parts);
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
            innerFeasible = DeepnestJtsGeometrySupport.rectGeometry(
                    -OPEN_CHANNEL_EPS,
                    -OPEN_CHANNEL_EPS,
                    maxX + 2 * OPEN_CHANNEL_EPS,
                    maxY + 2 * OPEN_CHANNEL_EPS
            );
        } else {
            double margin = partW + partH + 20.0;
            Geometry frame = DeepnestJtsGeometrySupport.rectGeometry(-margin, -margin, matW + 2 * margin, matH + 2 * margin);
            Geometry sheetRegion = DeepnestJtsGeometrySupport.toJtsPolygon(materialShape, 0.0, 0.0);
            Geometry frameMinusSheet = DeepnestJtsGeometrySupport.differenceGeometry(frame, sheetRegion);

            Shape shrunkPart = shrinkShapeMicro(partShape, OPEN_CHANNEL_EPS * 2);
            Geometry forbiddenOutside = convolveGeomWithNegatedShape(frameMinusSheet, shrunkPart);

            Geometry boundingRect = DeepnestJtsGeometrySupport.rectGeometry(
                    -OPEN_CHANNEL_EPS,
                    -OPEN_CHANNEL_EPS,
                    maxX + 2 * OPEN_CHANNEL_EPS,
                    maxY + 2 * OPEN_CHANNEL_EPS
            );
            innerFeasible = DeepnestJtsGeometrySupport.differenceGeometry(boundingRect, forbiddenOutside);
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
                List<List<Point>> excConvex = DeepnestConvexPolygonSupport.decomposeConvex(excShape);
                Geometry rawExcNfp = computeOuterNfpGeom(excShape, excConvex, partShape, partConvex, 0.0);
                if (!rawExcNfp.isEmpty()) {
                    defectNfps.add(DeepnestJtsGeometrySupport.translateGeometry(rawExcNfp, ex, ey));
                }
            }
            if (!defectNfps.isEmpty()) {
                innerFeasible = DeepnestJtsGeometrySupport.differenceGeometry(
                        innerFeasible, DeepnestJtsGeometrySupport.unionGeometries(defectNfps));
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
            if (pts.isEmpty() || DeepnestConvexPolygonSupport.distSq(pts.get(pts.size() - 1), p) > 1e-18) {
                pts.add(p);
            }
        }
        if (pts.size() > 1 && DeepnestConvexPolygonSupport.distSq(pts.get(0), pts.get(pts.size() - 1)) <= 1e-18) {
            pts.remove(pts.size() - 1);
        }
        if (pts.size() >= 3) {
            double sa = PolygonGeometry.signedArea(pts);
            out.add(new Ring(List.copyOf(pts), sa));
        }
    }

    // ==================== 向后兼容包装与门面委托 ====================

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
     * 基于 JTS 负 Buffer 的形状微缩（保留局部左上归零外接框与拓扑合法性，专门修复 U/C 形凹轮廓自交问题）。
     */
    static Shape shrinkShapeMicro(Shape shape, double delta) {
        if (shape == null || delta <= 0.0) {
            return shape;
        }
        Geometry base = DeepnestJtsGeometrySupport.toJtsPolygon(PolygonGeometry.vertices(shape), 0.0, 0.0);
        if (base.isEmpty()) {
            return shape;
        }
        Geometry shrunk = DeepnestJtsGeometrySupport.shrinkGeometryMicro(base, delta);
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

    static List<Point> normalizePositiveWinding(List<Point> raw) {
        return DeepnestConvexPolygonSupport.normalizePositiveWinding(raw);
    }

    static boolean isConvexPositive(List<Point> pts) {
        return DeepnestConvexPolygonSupport.isConvexPositive(pts);
    }

    static List<List<Point>> decomposeConvex(Shape shape) {
        return DeepnestConvexPolygonSupport.decomposeConvex(shape);
    }

    static List<Point> minkowskiSumConvex(List<Point> p, List<Point> q) {
        return DeepnestConvexPolygonSupport.minkowskiSumConvex(p, q);
    }

    static List<Point> negateConvex(List<Point> convex) {
        return DeepnestConvexPolygonSupport.negateConvex(convex);
    }

    static double mergedLength(List<List<Point>> placedWorldPolygons,
                               List<Point> candidateLocalVerts, double candX, double candY,
                               double minLength, double tolerance) {
        return DeepnestConvexPolygonSupport.mergedLength(
                placedWorldPolygons, candidateLocalVerts, candX, candY, minLength, tolerance);
    }

    static double convexHullArea(List<Point> points) {
        return DeepnestConvexPolygonSupport.convexHullArea(points);
    }

    static Geometry toJtsPolygon(List<Point> points, double dx, double dy) {
        return DeepnestJtsGeometrySupport.toJtsPolygon(points, dx, dy);
    }

    static Geometry toJtsPolygon(Shape shape, double dx, double dy) {
        return DeepnestJtsGeometrySupport.toJtsPolygon(shape, dx, dy);
    }

    static Geometry rectGeometry(double x, double y, double w, double h) {
        return DeepnestJtsGeometrySupport.rectGeometry(x, y, w, h);
    }

    static boolean translatedEnvelopeIntersects(Geometry geom, double dx, double dy, Envelope targetEnv) {
        return DeepnestJtsGeometrySupport.translatedEnvelopeIntersects(geom, dx, dy, targetEnv);
    }

    static Geometry ensureValidPolygonal(Geometry geom) {
        return DeepnestJtsGeometrySupport.ensureValidPolygonal(geom);
    }

    static Geometry unionTwoGeometries(Geometry a, Geometry b) {
        return DeepnestJtsGeometrySupport.unionTwoGeometries(a, b);
    }

    static Geometry unionGeometries(List<Geometry> geoms) {
        return DeepnestJtsGeometrySupport.unionGeometries(geoms);
    }

    static Geometry differenceGeometry(Geometry a, Geometry b) {
        return DeepnestJtsGeometrySupport.differenceGeometry(a, b);
    }

    static Geometry intersectionGeometry(Geometry a, Geometry b) {
        return DeepnestJtsGeometrySupport.intersectionGeometry(a, b);
    }

    static Geometry bufferPrecise(Geometry geom, double distance, double safetyMm) {
        return DeepnestJtsGeometrySupport.bufferPrecise(geom, distance, safetyMm);
    }

    static Geometry invertGeometry(Geometry src) {
        return DeepnestJtsGeometrySupport.invertGeometry(src);
    }

    static Geometry translateGeometry(Geometry src, double dx, double dy) {
        return DeepnestJtsGeometrySupport.translateGeometry(src, dx, dy);
    }

    static Area toArea(Geometry geom) {
        return DeepnestJtsGeometrySupport.toArea(geom);
    }

    static Area invertArea(Area src) {
        return DeepnestJtsGeometrySupport.invertArea(src);
    }

    static Geometry shrinkGeometryMicro(Geometry geom, double delta) {
        return DeepnestJtsGeometrySupport.shrinkGeometryMicro(geom, delta);
    }
}
