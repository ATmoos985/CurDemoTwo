package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Exclusion;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;

import java.awt.geom.Area;
import java.awt.geom.Path2D;
import java.awt.geom.PathIterator;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * Computational geometry and No-Fit Polygon (NFP) kernel migrated from Deepnest
 * ({@code minkowski.cc}, {@code background.js}, and {@code util/geometryutil.js}).
 *
 * <p>Core capabilities:
 * <ul>
 *   <li>Ear-clipping triangulation + Hertel-Mehlhorn convex polygon decomposition;</li>
 *   <li>Linear-time rotating-calipers Minkowski sum for convex pieces plus direct edge-segment
 *       convolution ({@code minkowski.cc}) for polygons with holes;</li>
 *   <li>Outer NFP with optional circumscribed spacing disk for strict Euclidean {@code pieceGap};</li>
 *   <li>Inner-Fit Polygon (IFP / Sheet NFP) supporting both rectangular and concave polygon sheets
 *       as well as arbitrary defect exclusions with clearance;</li>
 *   <li>Collinear shared-edge length detection ({@code mergedLength}) and Andrew monotone-chain convex hull.</li>
 * </ul>
 */
final class DeepnestNfpGeometry {
    private static final double EPS = 1e-9;
    /** Micro-tolerance keeping exact zero-slack contact channels open during boolean Area subtraction. */
    static final double OPEN_CHANNEL_EPS = 5e-7;
    /** Extra safety margin on pieceGap circumscribed disk so discrete NFP edges strictly exceed pieceGap. */
    private static final double GAP_SAFETY_MM = 0.015;
    private static final int GAP_DISK_SIDES = 16;

    private DeepnestNfpGeometry() {}

    /** A closed polygon ring extracted from an {@link Area}, with signed area indicating winding. */
    record Ring(List<Point> vertices, double signedArea) {}

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
                // Relax boundary inclusion slightly if near-collinear reflex vertices graze an ear diagonal
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
                // Shared internal diagonal has opposite orientation in two positively-wound pieces: a1==b2 && a2==b1
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

    /**
     * Builds a positively-wound regular polygon circumscribing a circle of radius {@code gap + GAP_SAFETY_MM}.
     * Because its inradius strictly exceeds {@code gap}, any placement outside the Minkowski sum with this disk
     * guarantees Euclidean distance $> \text{gap}$ at every edge and sharp vertex.
     */
    static List<Point> spacingDisk(double gap) {
        if (gap <= 0) return List.of();
        double inradius = gap + GAP_SAFETY_MM;
        double circumradius = inradius / Math.cos(Math.PI / GAP_DISK_SIDES);
        List<Point> pts = new ArrayList<>(GAP_DISK_SIDES);
        for (int i = 0; i < GAP_DISK_SIDES; i++) {
            double theta = (2.0 * Math.PI * i) / GAP_DISK_SIDES;
            pts.add(new Point(circumradius * Math.cos(theta), circumradius * Math.sin(theta)));
        }
        return pts;
    }

    /**
     * Computes the Outer No-Fit Polygon $\text{OuterNFP}(A, B) = A \oplus (-B)$ (plus {@code pieceGap} disk if $>0$).
     * Represents the forbidden open region of $B$'s local top-left origin when $A$ is placed at $(0, 0)$.
     * Interior holes (e.g., when $B$ fits inside a deep cavity of $A$) are naturally preserved in the returned {@link Area}.
     */
    static Area computeOuterNfp(Shape shapeA, List<List<Point>> convexA,
                                Shape shapeB, List<List<Point>> convexB,
                                double pieceGap) {
        ComputationCancellation.check();
        List<Point> disk = pieceGap > 0 ? spacingDisk(pieceGap) : List.of();

        if (!convexA.isEmpty() && !convexB.isEmpty()) {
            List<Area> pieces = new ArrayList<>(convexA.size() * convexB.size());
            for (List<Point> ca : convexA) {
                ComputationCancellation.check();
                List<Point> effA = pieceGap > 0 ? minkowskiSumConvex(ca, disk) : shrinkConvexMicro(ca, OPEN_CHANNEL_EPS);
                for (List<Point> cb : convexB) {
                    List<Point> negB = pieceGap > 0
                            ? negateConvex(cb)
                            : shrinkConvexMicro(negateConvex(cb), OPEN_CHANNEL_EPS);
                    List<Point> sum = minkowskiSumConvex(effA, negB);
                    if (sum.size() >= 3) {
                        pieces.add(toArea(sum, 0, 0));
                    }
                }
            }
            return unionBalanced(pieces);
        }

        // Fallback to direct segment convolution from minkowski.cc if decomposition was degenerate
        return convolveSimpleShapes(shapeA, shapeB, disk);
    }

    /**
     * Direct segment-pair Minkowski convolution migrated from {@code D:\GitHub\Deepnest\minkowski.cc}
     * ({@code convolve_two_polygon_sets}), supporting arbitrary polygons with holes.
     */
    static Area convolveAreaWithNegatedShape(Area areaA, Shape shapeB) {
        ComputationCancellation.check();
        List<Ring> ringsA = extractRings(areaA);
        List<Point> negB = new ArrayList<>();
        for (Point p : PolygonGeometry.vertices(shapeB)) {
            negB.add(new Point(-p.x(), -p.y()));
        }
        if (ringsA.isEmpty() || negB.size() < 3) return new Area();

        List<Area> parts = new ArrayList<>();
        Point b0 = negB.get(0);
        parts.add(translateArea(areaA, b0.x(), b0.y()));

        Area negBArea = toArea(negB, 0, 0);
        for (Ring ringA : ringsA) {
            ComputationCancellation.check();
            List<Point> va = ringA.vertices();
            if (va.isEmpty()) continue;
            parts.add(translateArea(negBArea, va.get(0).x(), va.get(0).y()));
            int na = va.size(), nb = negB.size();
            for (int i = 0; i < na; i++) {
                ComputationCancellation.check();
                Point a1 = va.get(i);
                Point a2 = va.get((i + 1) % na);
                for (int j = 0; j < nb; j++) {
                    Point p1 = negB.get(j);
                    Point p2 = negB.get((j + 1) % nb);
                    // Parallelogram swept by edge (a1->a2) and edge (p1->p2) as in minkowski.cc:convolve_two_segments
                    double cross = (a2.x() - a1.x()) * (p2.y() - p1.y()) - (a2.y() - a1.y()) * (p2.x() - p1.x());
                    if (Math.abs(cross) <= 1e-9) continue;
                    List<Point> quad = List.of(
                            new Point(a1.x() + p2.x(), a1.y() + p2.y()),
                            new Point(a1.x() + p1.x(), a1.y() + p1.y()),
                            new Point(a2.x() + p1.x(), a2.y() + p1.y()),
                            new Point(a2.x() + p2.x(), a2.y() + p2.y())
                    );
                    parts.add(toArea(quad, 0, 0));
                }
            }
        }
        return unionBalanced(parts);
    }

    private static Area convolveSimpleShapes(Shape shapeA, Shape shapeB, List<Point> disk) {
        Area base = convolveAreaWithNegatedShape(PolygonGeometry.region(shapeA, 0, 0), shapeB);
        if (disk.isEmpty()) return base;
        Shape diskShape = toNormalizedShape(disk);
        double minX = disk.stream().mapToDouble(Point::x).min().orElse(0);
        double minY = disk.stream().mapToDouble(Point::y).min().orElse(0);
        // disk is symmetric (-disk == disk); convolving with negated normalized disk shifted back
        Area expanded = convolveAreaWithNegatedShape(base, diskShape);
        return translateArea(expanded, -minX, -minY);
    }

    private static Shape toNormalizedShape(List<Point> pts) {
        double minX = pts.stream().mapToDouble(Point::x).min().orElse(0);
        double minY = pts.stream().mapToDouble(Point::y).min().orElse(0);
        double maxX = pts.stream().mapToDouble(Point::x).max().orElse(0);
        double maxY = pts.stream().mapToDouble(Point::y).max().orElse(0);
        List<Point> norm = pts.stream().map(p -> new Point(p.x() - minX, p.y() - minY)).toList();
        return new Shape("POLYGON", maxX - minX, maxY - minY, norm);
    }

    /**
     * Computes the Inner-Fit Polygon (IFP / Sheet NFP) representing all valid origins $(x, y)$
     * where {@code partShape} lies completely inside {@code materialShape} and outside all {@code exclusions}.
     * Migrated from {@code getFrame} + {@code getInnerNfp} ({@code background.js}) and
     * {@code noFitPolygonRectangle} ({@code geometryutil.js}), generalized for exact zero-slack fits.
     */
    static Area computeInnerNfp(Shape materialShape, List<Exclusion> exclusions,
                                Shape partShape, List<List<Point>> partConvex) {
        ComputationCancellation.check();
        double matW = materialShape.width();
        double matH = materialShape.height();
        double partW = partShape.width();
        double partH = partShape.height();

        if (partW > matW + 1e-6 || partH > matH + 1e-6) {
            return new Area();
        }

        Area innerFeasible;
        double maxX = Math.max(0.0, matW - partW);
        double maxY = Math.max(0.0, matH - partH);

        if ("RECTANGLE".equals(materialShape.type())) {
            // Fast exact IFP for rectangular sheet, expanded by OPEN_CHANNEL_EPS so 0-width/0-height exact fits survive Area
            innerFeasible = rectArea(
                    -OPEN_CHANNEL_EPS,
                    -OPEN_CHANNEL_EPS,
                    maxX + 2 * OPEN_CHANNEL_EPS,
                    maxY + 2 * OPEN_CHANNEL_EPS
            );
        } else {
            // Concave / general polygon sheet: frame \ sheet convolution as in Deepnest getFrame + calculateNFP
            double margin = partW + partH + 20.0;
            Area frame = rectArea(-margin, -margin, matW + 2 * margin, matH + 2 * margin);
            Area sheetRegion = PolygonGeometry.region(materialShape, 0, 0);
            frame.subtract(sheetRegion);

            // Shrink part slightly around its centroid so exact boundary-fitting placements (e.g. L-part in identical L-sheet) survive
            Shape shrunkPart = shrinkShapeMicro(partShape, OPEN_CHANNEL_EPS * 2);
            Area forbiddenOutside = convolveAreaWithNegatedShape(frame, shrunkPart);

            innerFeasible = rectArea(
                    -OPEN_CHANNEL_EPS,
                    -OPEN_CHANNEL_EPS,
                    maxX + 2 * OPEN_CHANNEL_EPS,
                    maxY + 2 * OPEN_CHANNEL_EPS
            );
            innerFeasible.subtract(forbiddenOutside);
        }

        if (innerFeasible.isEmpty()) {
            return innerFeasible;
        }

        // Subtract OuterNFP(exclusion, part) for each material defect exclusion (including its clearance)
        if (exclusions != null && !exclusions.isEmpty()) {
            List<Area> defectNfps = new ArrayList<>(exclusions.size());
            for (Exclusion exc : exclusions) {
                ComputationCancellation.check();
                double clr = exc.clearance();
                Shape excShape = clr == 0
                        ? exc.shape()
                        : Shape.rectangle(exc.shape().width() + 2 * clr, exc.shape().height() + 2 * clr);
                double ex = exc.x() - clr;
                double ey = exc.y() - clr;
                List<List<Point>> excConvex = decomposeConvex(excShape);
                Area rawExcNfp = computeOuterNfp(excShape, excConvex, partShape, partConvex, 0.0);
                if (!rawExcNfp.isEmpty()) {
                    defectNfps.add(translateArea(rawExcNfp, ex, ey));
                }
            }
            if (!defectNfps.isEmpty()) {
                innerFeasible.subtract(unionBalanced(defectNfps));
            }
        }

        return innerFeasible;
    }

    private static Shape shrinkShapeMicro(Shape shape, double delta) {
        List<Point> verts = PolygonGeometry.vertices(shape);
        double cx = 0, cy = 0;
        for (Point p : verts) {
            cx += p.x();
            cy += p.y();
        }
        cx /= verts.size();
        cy /= verts.size();
        List<Point> scaled = new ArrayList<>(verts.size());
        double minX = Double.POSITIVE_INFINITY, minY = Double.POSITIVE_INFINITY;
        double maxX = Double.NEGATIVE_INFINITY, maxY = Double.NEGATIVE_INFINITY;
        for (Point p : verts) {
            double dx = p.x() - cx, dy = p.y() - cy;
            double len = Math.hypot(dx, dy);
            double nx = len > delta * 4 ? cx + dx * ((len - delta) / len) : p.x();
            double ny = len > delta * 4 ? cy + dy * ((len - delta) / len) : p.y();
            scaled.add(new Point(nx, ny));
            if (nx < minX) minX = nx;
            if (ny < minY) minY = ny;
            if (nx > maxX) maxX = nx;
            if (ny > maxY) maxY = ny;
        }
        final double ox = minX, oy = minY;
        List<Point> shifted = scaled.stream().map(p -> new Point(p.x() - ox, p.y() - oy)).toList();
        return new Shape("POLYGON", Math.max(1e-6, maxX - minX), Math.max(1e-6, maxY - minY), shifted);
    }

    /** Pairwise divide-and-conquer boolean union reducing {@link Area#add(Area)} complexity from $O(K^2)$ to $O(K \log K)$. */
    static Area unionBalanced(List<Area> areas) {
        if (areas.isEmpty()) return new Area();
        if (areas.size() == 1) return new Area(areas.get(0));
        List<Area> current = new ArrayList<>(areas.size());
        for (Area a : areas) {
            if (a != null && !a.isEmpty()) current.add(new Area(a));
        }
        if (current.isEmpty()) return new Area();
        while (current.size() > 1) {
            ComputationCancellation.check();
            List<Area> next = new ArrayList<>((current.size() + 1) / 2);
            for (int i = 0; i < current.size(); i += 2) {
                ComputationCancellation.check();
                if (i + 1 < current.size()) {
                    Area merged = current.get(i);
                    merged.add(current.get(i + 1));
                    next.add(merged);
                } else {
                    next.add(current.get(i));
                }
            }
            current = next;
        }
        return current.get(0);
    }

    static Area toArea(List<Point> points, double dx, double dy) {
        Path2D.Double path = new Path2D.Double();
        path.moveTo(points.get(0).x() + dx, points.get(0).y() + dy);
        for (int i = 1; i < points.size(); i++) {
            path.lineTo(points.get(i).x() + dx, points.get(i).y() + dy);
        }
        path.closePath();
        return new Area(path);
    }

    static Area rectArea(double x, double y, double w, double h) {
        Path2D.Double path = new Path2D.Double();
        path.moveTo(x, y);
        path.lineTo(x + w, y);
        path.lineTo(x + w, y + h);
        path.lineTo(x, y + h);
        path.closePath();
        return new Area(path);
    }

    static Area translateArea(Area src, double dx, double dy) {
        if (src.isEmpty() || (Math.abs(dx) < 1e-15 && Math.abs(dy) < 1e-15)) {
            return new Area(src);
        }
        return src.createTransformedArea(java.awt.geom.AffineTransform.getTranslateInstance(dx, dy));
    }

    /** Extracts all closed polygonal rings from a boolean {@link Area}. */
    static List<Ring> extractRings(Area area) {
        if (area == null || area.isEmpty()) return List.of();
        List<Ring> rings = new ArrayList<>();
        List<Point> current = new ArrayList<>();
        double[] coords = new double[6];
        for (PathIterator it = area.getPathIterator(null); !it.isDone(); it.next()) {
            int type = it.currentSegment(coords);
            if (type == PathIterator.SEG_MOVETO) {
                current.clear();
                current.add(new Point(coords[0], coords[1]));
            } else if (type == PathIterator.SEG_LINETO) {
                Point p = new Point(coords[0], coords[1]);
                if (current.isEmpty() || distSq(current.get(current.size() - 1), p) > 1e-18) {
                    current.add(p);
                }
            } else if (type == PathIterator.SEG_CLOSE) {
                if (current.size() > 1 && distSq(current.get(0), current.get(current.size() - 1)) <= 1e-18) {
                    current.remove(current.size() - 1);
                }
                if (current.size() >= 3) {
                    double sa = PolygonGeometry.signedArea(current);
                    rings.add(new Ring(List.copyOf(current), sa));
                }
                current.clear();
            }
        }
        return rings;
    }

    /**
     * Collinear shared cutting line length detector migrated from {@code D:\GitHub\Deepnest\main\background.js}
     * ({@code mergedLength}, lines 352-487). Rewards candidate placements whose edges align flush against
     * already-placed part edges when {@code pieceGap == 0}.
     */
    static double mergedLength(List<List<Point>> placedWorldPolygons,
                               List<Point> candidateLocalVerts, double candX, double candY,
                               double minLength, double tolerance) {
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

            double lenA = Math.sqrt(lenSq);
            double ux = dx / lenA, uy = dy / lenA; // unit tangent along A1->A2

            for (List<Point> placed : placedWorldPolygons) {
                int pn = placed.size();
                for (int k = 0; k < pn; k++) {
                    Point b1 = placed.get(k);
                    Point b2 = placed.get((k + 1) % pn);
                    double bdx = b2.x() - b1.x(), bdy = b2.y() - b1.y();
                    if (bdx * bdx + bdy * bdy < minLenSq) continue;

                    double relB1x = b1.x() - a1x, relB1y = b1.y() - a1y;
                    double relB2x = b2.x() - a1x, relB2y = b2.y() - a1y;

                    // Perpendicular signed distance to infinite line A1->A2
                    double perp1 = -relB1x * uy + relB1y * ux;
                    if (Math.abs(perp1) > tolerance) continue;
                    double perp2 = -relB2x * uy + relB2y * ux;
                    if (Math.abs(perp2) > tolerance) continue;

                    // Parallel projection onto A1->A2 ([0, lenA])
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
