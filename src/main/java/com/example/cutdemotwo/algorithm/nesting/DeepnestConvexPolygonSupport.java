package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * 纯 {@link Point} 二维多边形凸分解、Minkowski 凸和、共边探测与凸包计算内核。
 */
final class DeepnestConvexPolygonSupport {
    private static final double EPS = 1e-9;

    private DeepnestConvexPolygonSupport() {}

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
    static List<Point> shrinkConvexMicro(List<Point> convex, double delta) {
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

    static double distSq(Point a, Point b) {
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
