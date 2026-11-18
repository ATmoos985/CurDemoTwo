package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import java.util.*;

/** Simultaneously slide interlocking outlines along one axis while preserving their collision-free order. */
final class AxisMarkerCompactor {
    private static final double EPS = 1e-7;
    private record Bound(int from, int to, double distance) {}
    private record Profile(MarkerCompactor.Oriented vertical, MarkerCompactor.Oriented horizontal) {
        static Profile of(Shape shape) {
            var swapped = "RECTANGLE".equals(shape.type()) ? Shape.rectangle(shape.height(), shape.width())
                    : new Shape("POLYGON", shape.height(), shape.width(),
                    PolygonGeometry.vertices(shape).stream().map(p -> new Point(p.y(), p.x())).toList());
            return new Profile(MarkerCompactor.Oriented.of(shape, 0), MarkerCompactor.Oriented.of(swapped, 0));
        }
    }

    static boolean supports(NestingProblem p) {
        return p.process().pieceGap() == 0 && p.material().exclusions().isEmpty()
                && "RECTANGLE".equals(p.material().shape().type());
    }

    static List<Placement> compact(NestingProblem problem, List<Placement> original, long deadline) {
        if (!supports(problem) || original.isEmpty() || original.size() > 80 || expired(deadline)) return original;
        int n = original.size();
        var cache = new HashMap<Shape, Profile>();
        var profiles = new Profile[n];
        double[] x = new double[n], y = new double[n];
        for (int i = 0; i < n; i++) {
            if (expired(deadline)) return original;
            var p = original.get(i);
            profiles[i] = cache.computeIfAbsent(p.shape(), Profile::of);
            x[i] = p.x(); y[i] = p.y();
        }
        double bestLength = length(original, y);
        List<Placement> best = original;
        for (int pass = 0; pass < 12 && !expired(deadline); pass++) {
            if (!slide(profiles, x, y, true, false, problem.height(), deadline)) break;
            double occupied = length(original, y);
            if (occupied < bestLength - EPS) {
                bestLength = occupied;
                var improved = new ArrayList<Placement>(n);
                for (int i = 0; i < n; i++) {
                    var p = original.get(i);
                    improved.add(new Placement(p.id(), p.demandId(), p.name(), x[i], y[i], p.shape(), p.rotationDegrees()));
                }
                best = improved;
            }
            if (!slide(profiles, y, x, false, pass % 2 != 0, problem.width(), deadline)) break;
        }
        return best;
    }

    private static double length(List<Placement> pieces, double[] y) {
        double length = 0;
        for (int i = 0; i < y.length; i++) length = Math.max(length, y[i] + pieces.get(i).shape().height());
        return length;
    }

    private static boolean expired(long deadline) {
        ComputationCancellation.check();
        return System.nanoTime() - deadline >= 0;
    }

    private static boolean slide(Profile[] profiles, double[] fixed, double[] moving, boolean vertical,
                                 boolean towardEnd, double limit, long deadline) {
        int n = profiles.length;
        var outlines = new MarkerCompactor.Oriented[n];
        var positions = new double[n];
        for (int i = 0; i < n; i++) {
            outlines[i] = vertical ? profiles[i].vertical : profiles[i].horizontal;
            positions[i] = towardEnd ? limit - outlines[i].shape().height() : 0;
        }
        var bounds = new ArrayList<Bound>();
        for (int i = 0; i < n; i++) for (int j = i + 1; j < n; j++) {
            if (expired(deadline)) return false;
            var a = outlines[i]; var b = outlines[j];
            double dx = fixed[j] - fixed[i], dy = moving[j] - moving[i];
            if (dx >= a.shape().width() || dx + b.shape().width() <= 0) continue;
            double lower = Double.NEGATIVE_INFINITY, upper = Double.POSITIVE_INFINITY;
            for (var s : a.slabs()) for (var t : b.slabs()) {
                if (dx + t.left() >= s.right()) break;
                double l = Math.max(s.left(), dx + t.left()), r = Math.min(s.right(), dx + t.right());
                if (r - l <= EPS) continue;
                // Relative translations colliding on this pair of trapezoids form one open interval.
                double lo = Math.min(s.top().y(l) - t.bottom().y(l-dx), s.top().y(r) - t.bottom().y(r-dx));
                double hi = Math.max(s.bottom().y(l) - t.top().y(l-dx), s.bottom().y(r) - t.top().y(r-dx));
                if (hi <= dy + EPS) lower = Math.max(lower, Math.min(hi, dy));
                else if (lo >= dy - EPS) upper = Math.min(upper, Math.max(lo, dy));
                else return false;
            }
            if (Double.isFinite(lower)) bounds.add(new Bound(i, j, lower));
            if (Double.isFinite(upper)) bounds.add(new Bound(j, i, -upper));
        }
        // Each bound is p[to] >= p[from] + distance. The incumbent satisfies every bound,
        // so longest-path relaxation can move whole contacting groups without crossing an outline.
        for (int pass = 0; pass < n; pass++) {
            boolean changed = false;
            for (var b : bounds) {
                if (positions[b.to] + EPS >= positions[b.from] + b.distance) continue;
                if (towardEnd) positions[b.from] = positions[b.to] - b.distance;
                else positions[b.to] = positions[b.from] + b.distance;
                changed = true;
            }
            if (!changed) break;
        }
        System.arraycopy(positions, 0, moving, 0, n);
        return true;
    }
}
