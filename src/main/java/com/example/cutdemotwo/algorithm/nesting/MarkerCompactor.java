package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import java.util.*;

/** Reinsert one cut piece at a time into gaps of an already complete fixed-width marker. */
final class MarkerCompactor {
    private static final double EPS = 1e-8;

    private record Edge(Point a, Point b) {
        double y(double x) { return a.y() + (b.y() - a.y()) * ((x - a.x()) / (b.x() - a.x())); }
    }
    private record Slab(double left, double right, Edge top, Edge bottom) {}
    private record Interval(double low, double high) {}
    private record Oriented(Shape shape, int angle, List<Slab> slabs, double[] xs) {
        static Oriented of(Shape shape, int angle) {
            var vertices = PolygonGeometry.vertices(shape);
            double[] xs = vertices.stream().mapToDouble(Point::x).distinct().sorted().toArray();
            var slabs = new ArrayList<Slab>();
            // Between two consecutive vertex x-coordinates the contour edges are straight and never cross.
            // Each pair of intersections bounds one filled trapezoid, also for concave outlines.
            for (int i = 1; i < xs.length; i++) {
                double middle = (xs[i - 1] + xs[i]) / 2;
                var crossings = new ArrayList<Edge>();
                for (int j = 0; j < vertices.size(); j++) {
                    var a = vertices.get(j);
                    var b = vertices.get((j + 1) % vertices.size());
                    if (Math.min(a.x(), b.x()) < middle && middle < Math.max(a.x(), b.x()))
                        crossings.add(new Edge(a, b));
                }
                crossings.sort(Comparator.comparingDouble(e -> e.y(middle)));
                for (int j = 1; j < crossings.size(); j += 2)
                    slabs.add(new Slab(xs[i - 1], xs[i], crossings.get(j - 1), crossings.get(j)));
            }
            return new Oriented(shape, angle, slabs, xs);
        }
    }
    private record Positioned(Oriented oriented, double x, double y) {}

    static boolean supports(NestingProblem problem, List<Placement> incumbent) {
        // The translation intervals below model contour contact at zero spacing.
        return problem.process().pieceGap() == 0 && "RECTANGLE".equals(problem.material().shape().type())
                && incumbent.size() <= 80
                && problem.parts().stream().allMatch(p -> p.shape().vertices().size() <= 48)
                && problem.material().exclusions().stream().allMatch(d -> d.shape().vertices().size() <= 48);
    }

    static List<Placement> compact(NestingProblem problem, List<Placement> incumbent, long deadline) {
        var choices = new HashMap<Integer, List<Oriented>>();
        for (var part : problem.parts()) {
            if (expired(deadline)) return incumbent;
            choices.put(part.id(), part.contourAngles().stream()
                    .map(angle -> Oriented.of(PolygonGeometry.rotate(part.shape(), angle), angle)).toList());
        }
        var defects = new ArrayList<Positioned>();
        for (var d : problem.material().exclusions()) {
            if (expired(deadline)) return incumbent;
            var shape = d.clearance() == 0 ? d.shape() : Shape.rectangle(
                    d.shape().width() + 2 * d.clearance(), d.shape().height() + 2 * d.clearance());
            defects.add(new Positioned(Oriented.of(shape, 0), d.x() - d.clearance(), d.y() - d.clearance()));
        }
        var pieces = new ArrayList<Positioned>();
        for (var p : incumbent) pieces.add(new Positioned(choices.get(p.demandId()).stream()
                .filter(o -> o.angle == p.rotationDegrees()).findFirst().orElseThrow(), p.x(), p.y()));
        var order = new ArrayList<Integer>();
        for (int i = 0; i < pieces.size(); i++) order.add(i);
        for (int pass = 0; pass < 4 && !expired(deadline); pass++) {
            order.sort(Comparator.comparingDouble((Integer i) -> bottom(pieces.get(i))).reversed());
            boolean moved = false;
            for (int index : order) {
                if (expired(deadline)) break;
                var old = pieces.get(index);
                var obstacles = new ArrayList<>(pieces);
                obstacles.remove(index);
                obstacles.addAll(defects);
                var best = bestPosition(problem.width(), old, choices.get(incumbent.get(index).demandId()),
                        obstacles, pass % 2 == 0, deadline);
                if (!best.equals(old)) { pieces.set(index, best); moved = true; }
            }
            if (!moved) break;
        }
        double before = incumbent.stream().mapToDouble(p -> p.y() + p.shape().height()).max().orElse(0);
        // When sliding individual pieces is locally stuck, try rebuilding from the largest pieces.
        // Only a full marker shorter than the incumbent is accepted, even if the budget expires mid-pass.
        var byHeight = Comparator.comparingDouble((Integer i) -> pieces.get(i).oriented.shape.height());
        var byWidth = Comparator.comparingDouble((Integer i) -> pieces.get(i).oriented.shape.width());
        for (var sorting : List.of(byHeight.thenComparing(byWidth), byWidth.thenComparing(byHeight))) {
            if (expired(deadline)) break;
            order.sort(sorting.reversed());
            double limit = pieces.stream().mapToDouble(MarkerCompactor::bottom).max().orElse(0);
            var obstacles = new ArrayList<>(defects);
            var rebuilt = new Positioned[pieces.size()];
            for (int index : order) {
                if (expired(deadline)) break;
                var options = choices.get(incumbent.get(index).demandId());
                var first = options.get(0);
                var absent = new Positioned(first, 0, limit + .001 - first.shape.height());
                var placed = bestPosition(problem.width(), absent, options, obstacles, true, deadline);
                if (placed == absent || bottom(placed) >= limit - EPS) break;
                rebuilt[index] = placed;
                obstacles.add(placed);
            }
            if (!Arrays.asList(rebuilt).contains(null)) {
                for (int index : order) pieces.set(index, rebuilt[index]);
            }
        }
        if (pieces.stream().mapToDouble(MarkerCompactor::bottom).max().orElse(0) >= before - EPS) return incumbent;
        var result = new ArrayList<Placement>();
        for (int i = 0; i < pieces.size(); i++) {
            var p = pieces.get(i);
            var old = incumbent.get(i);
            result.add(new Placement(old.id(), old.demandId(), old.name(), p.x, p.y, p.oriented.shape, p.oriented.angle));
        }
        return result;
    }

    private static boolean expired(long deadline) {
        ComputationCancellation.check();
        return System.nanoTime() - deadline >= 0;
    }
    private static double bottom(Positioned p) { return p.y + p.oriented.shape.height(); }

    private static Positioned bestPosition(double width, Positioned best, List<Oriented> orientations,
                                           List<Positioned> obstacles, boolean preferLeft, long deadline) {
        for (var orientation : orientations) {
            double maxX = width - orientation.shape.width();
            if (maxX < 0 || orientation.shape.height() > bottom(best) + EPS) continue;
            var xs = new TreeSet<Double>();
            xs.add(0d);
            xs.add(maxX);
            if (best.x <= maxX) xs.add(best.x);
            for (var obstacle : obstacles) {
                if (expired(deadline)) return best;
                for (double ox : obstacle.oriented.xs) for (double sx : orientation.xs) {
                    double x = obstacle.x + ox - sx;
                    if (x > 0 && x < maxX) xs.add(x);
                }
            }
            for (double x : preferLeft ? xs : xs.descendingSet()) {
                if (expired(deadline)) return best;
                double limit = bottom(best) - orientation.shape.height();
                double y = firstFreeY(orientation, x, obstacles, limit, deadline);
                if (y > limit + EPS) continue;
                if (y < limit - EPS || (preferLeft ? x < best.x - EPS : x > best.x + EPS))
                    best = new Positioned(orientation, x, y);
            }
        }
        return best;
    }

    private static double firstFreeY(Oriented shape, double x, List<Positioned> obstacles, double limit, long deadline) {
        var forbidden = new ArrayList<Interval>();
        for (var o : obstacles) {
            if (x >= o.x + o.oriented.shape.width() || x + shape.shape.width() <= o.x) continue;
            for (var a : shape.slabs) {
              if (expired(deadline) || forbidden.size() > 8192) return Double.POSITIVE_INFINITY;
              for (var b : o.oriented.slabs) {
                double left = Math.max(x + a.left, o.x + b.left);
                double right = Math.min(x + a.right, o.x + b.right);
                if (right - left <= EPS) continue;
                // Over this shared x interval, the range of colliding y translations is the
                // difference between the two trapezoids' linear upper/lower envelopes.
                double low = o.y + Math.min(b.top.y(left - o.x) - a.bottom.y(left - x),
                        b.top.y(right - o.x) - a.bottom.y(right - x));
                double high = o.y + Math.max(b.bottom.y(left - o.x) - a.top.y(left - x),
                        b.bottom.y(right - o.x) - a.top.y(right - x));
                if (low < -EPS && high > limit + EPS) return Double.POSITIVE_INFINITY;
                if (high > 0 && low < limit + EPS) forbidden.add(new Interval(low, high));
              }
            }
        }
        forbidden.sort(Comparator.comparingDouble(Interval::low));
        double y = 0;
        for (var interval : forbidden) {
            if (interval.low >= y - EPS) break; // Contact at an interval endpoint is legal.
            y = Math.max(y, interval.high);
            if (y > limit + EPS) break;
        }
        return y;
    }
}
