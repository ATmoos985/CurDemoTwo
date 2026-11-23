package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.algorithm.nesting.constraints.CurtainConstraintPack;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import java.util.*;

/** Simultaneously slide interlocking outlines along one axis while preserving their collision-free order. */
final class AxisMarkerCompactor {
    private static final double EPS = 1e-7;
    private record Bound(int from, int to, double distance) {}

    private record Profile(
            Shape shape,
            MarkerCompactor.SlabProfile rawVertical,
            MarkerCompactor.SlabProfile rawHorizontal,
            MarkerCompactor.SlabProfile collVertical,
            MarkerCompactor.SlabProfile collHorizontal
    ) {
        static Profile of(Shape shape, double pieceGap) {
            List<List<Point>> rawRings = List.of(PolygonGeometry.vertices(shape));
            var rawV = MarkerCompactor.SlabProfile.ofRings(rawRings);
            var rawH = MarkerCompactor.SlabProfile.ofSwappedRings(rawRings);
            if (pieceGap <= 0.0) {
                return new Profile(shape, rawV, rawH, rawV, rawH);
            }
            var inflatedRings = DeepnestNfpGeometry.inflateShapeRings(
                    shape, pieceGap / 2.0 + MarkerCompactor.GAP_HALF_SAFETY_MM);
            List<List<Point>> collRings = inflatedRings.isEmpty()
                    ? rawRings
                    : inflatedRings.stream().map(DeepnestNfpGeometry.Ring::vertices).toList();
            var collV = MarkerCompactor.SlabProfile.ofRings(collRings);
            var collH = MarkerCompactor.SlabProfile.ofSwappedRings(collRings);
            return new Profile(shape, rawV, rawH, collV, collH);
        }
    }

    static boolean supports(NestingProblem p) {
        return "RECTANGLE".equals(p.material().shape().type())
                && CurtainConstraintPack.forProblem(p).isNoop();
    }

    static List<Placement> compact(NestingProblem problem, List<Placement> original, long deadline) {
        if (!supports(problem) || original.isEmpty() || original.size() > MarkerCompactor.MAX_COMPACT_PIECES || expired(deadline)) return original;
        int n = original.size();
        double pieceGap = problem.process().pieceGap();

        var cache = new HashMap<Shape, Profile>();
        var rawExclusions = problem.material().exclusions();
        int m = rawExclusions.size();
        var profiles = new Profile[n + m];
        double[] x = new double[n + m];
        double[] y = new double[n + m];

        for (int i = 0; i < n; i++) {
            if (expired(deadline)) return original;
            var p = original.get(i);
            profiles[i] = cache.computeIfAbsent(p.shape(), s -> Profile.of(s, pieceGap));
            x[i] = p.x();
            y[i] = p.y();
        }
        // 将禁入区（含安全外扩）作为位移锁死为 0 的固定障碍节点纳入约束图
        for (int k = 0; k < m; k++) {
            if (expired(deadline)) return original;
            var expanded = ContourGeometrySupport.expandExclusion(rawExclusions.get(k));
            profiles[n + k] = Profile.of(expanded.shape(), 0.0);
            x[n + k] = expanded.x();
            y[n + k] = expanded.y();
        }

        double bestLength = length(original, y);
        List<Placement> best = original;
        for (int pass = 0; pass < 12 && !expired(deadline); pass++) {
            if (!slide(profiles, n, x, y, true, false, problem.height(), pieceGap, deadline)) break;
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
            if (!slide(profiles, n, y, x, false, pass % 2 != 0, problem.width(), pieceGap, deadline)) break;
        }
        return MarkerCompactor.validateOrFallback(problem, original, best);
    }

    private static double length(List<Placement> pieces, double[] y) {
        double length = 0;
        for (int i = 0; i < pieces.size(); i++) length = Math.max(length, y[i] + pieces.get(i).shape().height());
        return length;
    }

    private static boolean expired(long deadline) {
        ComputationCancellation.check();
        return System.nanoTime() - deadline >= 0;
    }

    private static boolean slide(Profile[] profiles, int movableCount, double[] fixed, double[] moving,
                                 boolean vertical, boolean towardEnd, double limit, double pieceGap, long deadline) {
        int total = profiles.length;
        var rawOutlines = new MarkerCompactor.SlabProfile[total];
        var collOutlines = new MarkerCompactor.SlabProfile[total];
        var rawSizes = new double[movableCount];
        var positions = new double[total];

        for (int i = 0; i < total; i++) {
            rawOutlines[i] = vertical ? profiles[i].rawVertical : profiles[i].rawHorizontal;
            collOutlines[i] = vertical ? profiles[i].collVertical : profiles[i].collHorizontal;
            if (i < movableCount) {
                rawSizes[i] = vertical ? profiles[i].shape.height() : profiles[i].shape.width();
                positions[i] = towardEnd ? limit - rawSizes[i] : 0.0;
            } else {
                // 固定障碍节点位移锁死为 0
                positions[i] = moving[i];
            }
        }

        double[] bvhMinX = new double[total];
        double[] bvhMinY = new double[total];
        double[] bvhMaxX = new double[total];
        double[] bvhMaxY = new double[total];
        for (int i = 0; i < total; i++) {
            double loX = Math.min(rawOutlines[i].minX(), collOutlines[i].minX());
            double hiX = Math.max(rawOutlines[i].maxX(), collOutlines[i].maxX());
            bvhMinX[i] = fixed[i] + loX;
            bvhMaxX[i] = fixed[i] + hiX;
            bvhMinY[i] = 0.0;
            bvhMaxY[i] = 0.0;
        }
        AabbBvh fixedAxisBvh = AabbBvh.build(bvhMinX, bvhMinY, bvhMaxX, bvhMaxY, total);

        double inflateSlack = pieceGap > 0.0 ? pieceGap * 0.03 + 0.02 : 0.0;
        var bounds = new ArrayList<Bound>();
        for (int i = 0; i < movableCount; i++) {
            if (expired(deadline)) return false;
            int idxI = i;
            boolean failed = fixedAxisBvh.queryAny(bvhMinX[idxI], 0.0, bvhMaxX[idxI], 0.0, j -> {
                if (j <= idxI) return false;
                if (expired(deadline)) return true;
                boolean withObstacle = j >= movableCount;
                var a = withObstacle ? rawOutlines[idxI] : collOutlines[idxI];
                var b = withObstacle ? rawOutlines[j] : collOutlines[j];
                double dx = fixed[j] - fixed[idxI], dy = moving[j] - moving[idxI];
                if (dx + b.minX() >= a.maxX() || dx + b.maxX() <= a.minX()) return false;

                double lower = Double.NEGATIVE_INFINITY, upper = Double.POSITIVE_INFINITY;
                for (var s : a.slabs()) {
                    for (var t : b.slabs()) {
                        if (dx + t.left() >= s.right()) break;
                        double l = Math.max(s.left(), dx + t.left()), r = Math.min(s.right(), dx + t.right());
                        if (r - l <= EPS) continue;
                        // Relative translations colliding on this pair of trapezoids form one open interval.
                        double lo = Math.min(s.top().y(l) - t.bottom().y(l - dx), s.top().y(r) - t.bottom().y(r - dx));
                        double hi = Math.max(s.bottom().y(l) - t.top().y(l - dx), s.bottom().y(r) - t.top().y(r - dx));
                        if (hi <= dy + EPS) {
                            lower = Math.max(lower, Math.min(hi, dy));
                        } else if (lo >= dy - EPS) {
                            upper = Math.min(upper, Math.max(lo, dy));
                        } else if (!withObstacle && pieceGap > 0.0) {
                            // 紧贴 pieceGap 的初始解在多边形外接圆盘近似下可能出现极微小重叠，按最近方向安全推开
                            double pushDown = hi - dy;
                            double pushUp = dy - lo;
                            if (pushDown <= inflateSlack && pushDown <= pushUp) {
                                lower = Math.max(lower, hi);
                            } else if (pushUp <= inflateSlack) {
                                upper = Math.min(upper, lo);
                            } else {
                                return true;
                            }
                        } else {
                            return true;
                        }
                    }
                }
                if (Double.isFinite(lower)) bounds.add(new Bound(idxI, j, lower));
                if (Double.isFinite(upper)) bounds.add(new Bound(j, idxI, -upper));
                return false;
            });
            if (failed) return false;
        }

        // Each bound is p[to] >= p[from] + distance. Fixed obstacles (index >= movableCount) stay locked.
        for (int pass = 0; pass < total; pass++) {
            if (expired(deadline)) return false;
            boolean changed = false;
            for (var b : bounds) {
                if (positions[b.to] + EPS >= positions[b.from] + b.distance) continue;
                if (towardEnd) {
                    if (b.from < movableCount) {
                        positions[b.from] = positions[b.to] - b.distance;
                        changed = true;
                    }
                } else {
                    if (b.to < movableCount) {
                        positions[b.to] = positions[b.from] + b.distance;
                        changed = true;
                    }
                }
            }
            if (!changed) break;
        }

        // 核验所有可移动裁片未出界且全部约束满足（防止带障碍或件距时锁死冲突）
        for (int i = 0; i < movableCount; i++) {
            if (positions[i] < -1e-5 || positions[i] > limit - rawSizes[i] + 1e-5) {
                return false;
            }
            positions[i] = Math.max(0.0, Math.min(limit - rawSizes[i], positions[i]));
        }
        for (var b : bounds) {
            if (positions[b.to] + 1e-5 < positions[b.from] + b.distance) {
                return false;
            }
        }

        System.arraycopy(positions, 0, moving, 0, movableCount);
        return true;
    }
}
