package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.algorithm.nesting.constraints.CurtainConstraintPack;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import java.util.*;

/** Reinsert one cut piece at a time into gaps of an already complete fixed-width marker. */
final class MarkerCompactor {
    private static final double EPS = 1e-8;
    /** 压紧器 pieceGap/2 欧氏外扩单侧安全裕量（双侧合计 0.004mm > 校验器 0.001mm 容差）。 */
    static final double GAP_HALF_SAFETY_MM = 0.002;
    // Match the standard contour problem limit when validating the fixed pieces and spares together.
    static final int MAX_FILLED_PIECES = 200;
    static final int MAX_COMPACT_PIECES = MAX_FILLED_PIECES;

    record Edge(Point a, Point b) {
        double y(double x) { return a.y() + (b.y() - a.y()) * ((x - a.x()) / (b.x() - a.x())); }
    }
    record Slab(double left, double right, Edge top, Edge bottom) {}
    private record Interval(double low, double high) {}

    record SlabProfile(List<Slab> slabs, double[] xs, double[] coarseXs,
                       double minX, double maxX, double minY, double maxY) {
        static SlabProfile ofShape(Shape shape) {
            return ofRings(List.of(PolygonGeometry.vertices(shape)));
        }

        static SlabProfile ofInflated(Shape shape, double inradius) {
            var rings = DeepnestNfpGeometry.inflateShapeRings(shape, inradius);
            if (rings.isEmpty()) return ofShape(shape);
            var pointRings = rings.stream().map(DeepnestNfpGeometry.Ring::vertices).toList();
            return ofRings(pointRings);
        }

        static SlabProfile ofSwappedRings(List<List<Point>> rings) {
            var swapped = rings.stream()
                    .map(r -> r.stream().map(p -> new Point(p.y(), p.x())).toList())
                    .toList();
            return ofRings(swapped);
        }

        static SlabProfile ofRings(List<List<Point>> rings) {
            double[] rawXs = rings.stream()
                    .flatMap(List::stream)
                    .mapToDouble(Point::x)
                    .sorted()
                    .toArray();
            if (rawXs.length == 0) {
                return new SlabProfile(List.of(), new double[0], new double[0], 0.0, 0.0, 0.0, 0.0);
            }
            double minY = Double.POSITIVE_INFINITY;
            double maxY = Double.NEGATIVE_INFINITY;
            for (var ring : rings) {
                for (var pt : ring) {
                    double py = pt.y();
                    if (py < minY) minY = py;
                    if (py > maxY) maxY = py;
                }
            }
            var dedup = new double[rawXs.length];
            int count = 0;
            for (double v : rawXs) {
                if (count == 0 || v - dedup[count - 1] > 1e-10) {
                    dedup[count++] = v;
                }
            }
            double[] xs = Arrays.copyOf(dedup, count);
            double[] coarseXs = extractCoarseXs(xs);
            var slabs = new ArrayList<Slab>();
            // Between two consecutive vertex x-coordinates the contour edges are straight and never cross.
            // Each pair of intersections bounds one filled trapezoid, also for concave outlines and holes.
            for (int i = 1; i < xs.length; i++) {
                double middle = (xs[i - 1] + xs[i]) / 2.0;
                var crossings = new ArrayList<Edge>();
                for (var ring : rings) {
                    int n = ring.size();
                    for (int j = 0; j < n; j++) {
                        var a = ring.get(j);
                        var b = ring.get((j + 1) % n);
                        if (Math.min(a.x(), b.x()) < middle && middle < Math.max(a.x(), b.x()))
                            crossings.add(new Edge(a, b));
                    }
                }
                crossings.sort(Comparator.comparingDouble(e -> e.y(middle)));
                for (int j = 1; j < crossings.size(); j += 2)
                    slabs.add(new Slab(xs[i - 1], xs[i], crossings.get(j - 1), crossings.get(j)));
            }
            return new SlabProfile(slabs, xs, coarseXs, xs[0], xs[xs.length - 1], minY, maxY);
        }

        /**
         * 仅用于大批量无疵点（{@code >= 48} 件）压紧的粗粒度关键 X 抽稀，
         * 避免圆弧外扩后百万级笛卡尔积爆炸；小批量及带疵点算例始终使用全量 {@code xs}，精确碰撞检测始终使用全量 {@code slabs}。
         */
        private static double[] extractCoarseXs(double[] xs) {
            if (xs.length <= 6) {
                return xs;
            }
            double span = xs[xs.length - 1] - xs[0];
            double minStep = Math.max(2.0, span / 4.0);
            double[] buf = new double[xs.length];
            int k = 0;
            buf[k++] = xs[0];
            for (int i = 1; i < xs.length - 1; i++) {
                if (xs[i] - buf[k - 1] >= minStep) {
                    buf[k++] = xs[i];
                }
            }
            if (xs[xs.length - 1] - buf[k - 1] > 1e-10) {
                buf[k++] = xs[xs.length - 1];
            }
            return Arrays.copyOf(buf, k);
        }
    }

    record Oriented(Shape shape, int angle, SlabProfile raw, SlabProfile collision) {
        static Oriented of(Shape shape, int angle) {
            return of(shape, angle, 0.0);
        }

        static Oriented of(Shape shape, int angle, double pieceGap) {
            SlabProfile raw = SlabProfile.ofShape(shape);
            SlabProfile collision = pieceGap > 0.0
                    ? SlabProfile.ofInflated(shape, pieceGap / 2.0 + GAP_HALF_SAFETY_MM)
                    : raw;
            return new Oriented(shape, angle, raw, collision);
        }
    }

    private record Positioned(Oriented oriented, double x, double y, boolean defect) {}

    private static List<Oriented> orientations(NestingProblem.Part part, double pieceGap) {
        return part.contourAngles().stream()
                .map(angle -> Oriented.of(PolygonGeometry.rotate(part.shape(), angle), angle, pieceGap)).toList();
    }

    private static Positioned obstacle(NestingProblem.Exclusion defect) {
        var expanded = ContourGeometrySupport.expandExclusion(defect);
        return new Positioned(Oriented.of(expanded.shape(), 0, 0.0), expanded.x(), expanded.y(), true);
    }

    static boolean hasAnyHoles(NestingProblem problem) {
        if (problem.material().shape().hasHoles()) return true;
        for (var p : problem.parts()) {
            if (p.shape().hasHoles()) return true;
        }
        return false;
    }

    static double pureSelvedgeLeft(NestingProblem problem) {
        var fr = problem.material().fabricRule();
        return fr == null || fr.leftSelvedgeMm() == null ? 0.0 : fr.leftSelvedgeMm();
    }

    static double pureSelvedgeRight(NestingProblem problem) {
        var fr = problem.material().fabricRule();
        return fr == null || fr.rightSelvedgeMm() == null ? 0.0 : fr.rightSelvedgeMm();
    }

    /** 将仅含纯布边禁区的问题转换为等效净幅宽无布边问题（所有普通硬疵点同步平移 -leftSelvedge 并裁剪到有效幅宽）。 */
    static NestingProblem stripPureSelvedgeProblem(NestingProblem problem) {
        double left = pureSelvedgeLeft(problem);
        double right = pureSelvedgeRight(problem);
        double effW = problem.width() - left - right;
        var shiftedExcs = new ArrayList<NestingProblem.Exclusion>(problem.material().exclusions().size());
        for (var exc : problem.material().exclusions()) {
            double clr = exc.clearance();
            double ex1 = exc.x() - clr - left;
            double ex2 = exc.x() + exc.shape().width() + clr - left;
            if (ex2 <= 1e-6 || ex1 >= effW - 1e-6) {
                continue;
            }
            if ("RECTANGLE".equals(exc.shape().type())) {
                double cx1 = Math.max(0.0, ex1);
                double cx2 = Math.min(effW, ex2);
                double cy1 = Math.max(0.0, exc.y() - clr);
                double cy2 = Math.min(problem.height(), exc.y() + exc.shape().height() + clr);
                if (cx2 - cx1 > 1e-6 && cy2 - cy1 > 1e-6) {
                    shiftedExcs.add(new NestingProblem.Exclusion(
                            exc.id(), cx1, cy1, Shape.rectangle(cx2 - cx1, cy2 - cy1), 0.0));
                }
            } else {
                shiftedExcs.add(new NestingProblem.Exclusion(
                        exc.id(), exc.x() - left, exc.y(), exc.shape(), exc.clearance()));
            }
        }
        var netMat = new NestingProblem.Material(
                problem.material().id(),
                Shape.rectangle(effW, problem.height()),
                shiftedExcs,
                problem.material().continuesAfterRegion(),
                null
        );
        return new NestingProblem(
                problem.schemaVersion(), problem.unit(), netMat, problem.parts(),
                problem.process(), problem.engine(), problem.timeLimitSeconds()
        );
    }

    static List<Placement> shiftPlacementsX(List<Placement> placements, double dx) {
        if (Math.abs(dx) < 1e-12) return placements;
        var out = new ArrayList<Placement>(placements.size());
        for (var p : placements) {
            out.add(new Placement(p.id(), p.demandId(), p.name(), p.x() + dx, p.y(), p.shape(), p.rotationDegrees()));
        }
        return out;
    }

    static boolean supports(NestingProblem problem, List<Placement> incumbent) {
        return incumbent.size() <= MAX_COMPACT_PIECES && (supportsGapSearch(problem) || AxisMarkerCompactor.supports(problem));
    }

    static boolean supportsGapSearch(NestingProblem problem) {
        boolean constraintOk = CurtainConstraintPack.forProblem(problem).isNoop()
                || CurtainConstraintPack.isPureSelvedgeOnly(problem, true);
        return "RECTANGLE".equals(problem.material().shape().type())
                && !hasAnyHoles(problem)
                && constraintOk
                && problem.parts().stream().allMatch(p -> p.shape().vertices().size() <= 48)
                && problem.material().exclusions().stream().allMatch(d -> d.shape().vertices().size() <= 48);
    }

    static List<Placement> validateOrFallback(NestingProblem problem, List<Placement> incumbent, List<Placement> candidate) {
        if (candidate == incumbent) return incumbent;
        var engine = new EngineResult();
        engine.setSuccess(true);
        engine.setPlacements(candidate);
        return PolygonResultValidator.validate(problem, engine) == null ? candidate : incumbent;
    }

    static List<Placement> compact(NestingProblem problem, List<Placement> incumbent, long deadline) {
        if (!supportsGapSearch(problem))
            return AxisMarkerCompactor.compact(problem, incumbent, deadline);
        if (!CurtainConstraintPack.forProblem(problem).isNoop()
                && CurtainConstraintPack.isPureSelvedgeOnly(problem, true)) {
            double left = pureSelvedgeLeft(problem);
            NestingProblem netProb = stripPureSelvedgeProblem(problem);
            List<Placement> shiftedIn = shiftPlacementsX(incumbent, -left);
            List<Placement> compactedNet = compact(netProb, shiftedIn, deadline);
            if (compactedNet == shiftedIn) return incumbent;
            return validateOrFallback(problem, incumbent, shiftPlacementsX(compactedNet, left));
        }
        double pieceGap = Math.max(Math.max(0.0, problem.process().pieceGap()), Math.max(0.0, problem.process().kerf()));
        var choices = new HashMap<Integer, List<Oriented>>();
        for (var part : problem.parts()) {
            if (expired(deadline)) return incumbent;
            choices.put(part.id(), orientations(part, pieceGap));
        }
        var defects = new ArrayList<Positioned>();
        for (var d : problem.material().exclusions()) {
            if (expired(deadline)) return incumbent;
            defects.add(obstacle(d));
        }
        var pieces = new ArrayList<Positioned>();
        for (var p : incumbent) pieces.add(new Positioned(choices.get(p.demandId()).stream()
                .filter(o -> o.angle == p.rotationDegrees()).findFirst().orElseThrow(), p.x(), p.y(), false));
        var order = new ArrayList<Integer>();
        for (int i = 0; i < pieces.size(); i++) order.add(i);
        // 严格门控：仅 >= 48 件且无疵点算例启用大批量末端剥皮与抽稀采样；< 48 件或带疵点算例 100% 沿用原路径零变化
        boolean largeBatch = pieces.size() >= ContourPartitionSolver.MIN_PARTITION_PIECES && defects.isEmpty();
        int maxPasses = largeBatch ? 2 : 4;
        for (int pass = 0; pass < maxPasses && !expired(deadline); pass++) {
            order.sort(largeBatch
                    ? Comparator.comparingDouble((Integer i) -> bottom(pieces.get(i))).reversed()
                            .thenComparingInt(Integer::intValue)
                    : Comparator.comparingDouble((Integer i) -> bottom(pieces.get(i))).reversed());
            boolean moved = false;
            int limitCount = largeBatch ? Math.min(order.size(), 10) : order.size();
            int consecutiveNoYDrop = 0;
            for (int k = 0; k < limitCount; k++) {
                int index = order.get(k);
                if (expired(deadline)) break;
                var old = pieces.get(index);
                double oldBottom = bottom(old);
                var obstacles = new ArrayList<>(pieces);
                obstacles.remove(index);
                obstacles.addAll(defects);
                var best = bestPosition(problem.width(), old, choices.get(incumbent.get(index).demandId()),
                        obstacles, pass % 2 == 0, largeBatch, deadline);
                if (!best.equals(old)) {
                    pieces.set(index, best);
                    if (!largeBatch || bottom(best) < oldBottom - 0.5) {
                        moved = true;
                        consecutiveNoYDrop = 0;
                    } else {
                        consecutiveNoYDrop++;
                    }
                } else if (largeBatch) {
                    consecutiveNoYDrop++;
                }
                // 大批量末端剥皮：仅靠 X 方向微挪不降低 Y 时，最末端瓶颈件连续 3 件无法降高即确定性早停
                if (largeBatch && consecutiveNoYDrop >= 3 && !moved) {
                    break;
                }
            }
            if (!moved) break;
        }
        double before = incumbent.stream().mapToDouble(p -> p.y() + p.shape().height()).max().orElse(0);
        // When sliding individual pieces is locally stuck, try rebuilding from the largest pieces.
        // Only a full marker shorter than the incumbent is accepted, even if the budget expires mid-pass.
        if (!largeBatch) {
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
                    var absent = new Positioned(first, 0, limit + .001 - first.shape.height(), false);
                    var placed = bestPosition(problem.width(), absent, options, obstacles, true, false, deadline);
                    if (placed == absent || bottom(placed) >= limit - EPS) break;
                    rebuilt[index] = placed;
                    obstacles.add(placed);
                }
                if (!Arrays.asList(rebuilt).contains(null)) {
                    for (int index : order) pieces.set(index, rebuilt[index]);
                }
            }
        }
        if (pieces.stream().mapToDouble(MarkerCompactor::bottom).max().orElse(0) >= before - EPS) return incumbent;
        var result = new ArrayList<Placement>();
        for (int i = 0; i < pieces.size(); i++) {
            var p = pieces.get(i);
            var old = incumbent.get(i);
            result.add(new Placement(old.id(), old.demandId(), old.name(), p.x, p.y, p.oriented.shape, p.oriented.angle));
        }
        return validateOrFallback(problem, incumbent, result);
    }

    private static boolean expired(long deadline) {
        ComputationCancellation.check();
        return System.nanoTime() - deadline >= 0;
    }
    private static double bottom(Positioned p) { return p.y + p.oriented.shape.height(); }

    static List<Placement> fillGaps(NestingProblem problem, List<Placement> fixed, Map<Integer, Integer> limits,
                                    double length, long deadline) {
        double pieceGap = problem.process().pieceGap();
        double freeArea = problem.width() * length - fixed.stream().mapToDouble(p -> p.shape().areaMm2()).sum();
        var candidates = problem.parts().stream()
                .filter(p -> limits.getOrDefault(p.id(), 0) > 0 && p.shape().areaMm2() <= freeArea + EPS)
                .sorted(Comparator.comparingDouble((NestingProblem.Part p) -> p.shape().areaMm2()).reversed()).toList();
        if (candidates.isEmpty() || fixed.size() >= MAX_FILLED_PIECES || expired(deadline)) return List.of();

        var obstacles = new ArrayList<Positioned>();
        var usedIds = new HashSet<Integer>();
        for (var piece : fixed) {
            if (expired(deadline)) return List.of();
            usedIds.add(piece.id());
            obstacles.add(new Positioned(Oriented.of(piece.shape(), piece.rotationDegrees(), pieceGap),
                    piece.x(), piece.y(), false));
        }
        for (var defect : problem.material().exclusions()) obstacles.add(obstacle(defect));
        var extras = new ArrayList<Placement>();
        int nextId = 1;
        double remainingArea = freeArea;
        for (var part : candidates) {
            if (expired(deadline) || fixed.size() + extras.size() >= MAX_FILLED_PIECES) break;
            var choices = orientations(part, pieceGap);
            var first = choices.get(0);
            // A sentinel to the right of every legal x also accepts a piece ending exactly at the marker edge.
            var absent = new Positioned(first, problem.width() + 1, length - first.shape.height(), false);
            double area = part.shape().areaMm2();
            for (int i = 0; i < limits.get(part.id()) && area <= remainingArea + EPS; i++) {
                if (expired(deadline) || fixed.size() + extras.size() >= MAX_FILLED_PIECES) break;
                var placed = bestPosition(problem.width(), absent, choices, obstacles, true, false, deadline);
                if (placed == absent || bottom(placed) > length) break;
                while (usedIds.contains(nextId)) nextId++;
                extras.add(new Placement(nextId++, part.id(), part.name(), placed.x, placed.y,
                        placed.oriented.shape, placed.oriented.angle));
                obstacles.add(placed);
                remainingArea -= area;
            }
        }
        return List.copyOf(extras);
    }

    private static AabbBvh buildObstacleBvh(List<Positioned> obstacles) {
        int count = obstacles.size();
        if (count == 0) {
            return AabbBvh.EMPTY;
        }
        double[] minX = new double[count];
        double[] minY = new double[count];
        double[] maxX = new double[count];
        double[] maxY = new double[count];
        for (int i = 0; i < count; i++) {
            var o = obstacles.get(i);
            var profile = o.defect ? o.oriented.raw : o.oriented.collision;
            minX[i] = o.x + profile.minX;
            maxX[i] = o.x + profile.maxX;
            minY[i] = o.y + profile.minY;
            maxY[i] = o.y + profile.maxY;
        }
        return AabbBvh.build(minX, minY, maxX, maxY, count);
    }

    private static Positioned bestPosition(double width, Positioned best, List<Oriented> orientations,
                                           List<Positioned> obstacles, boolean preferLeft, boolean largeBatch, long deadline) {
        AabbBvh obstacleBvh = buildObstacleBvh(obstacles);
        double[] xBuf = new double[256];
        for (var orientation : orientations) {
            double maxX = width - orientation.shape.width();
            if (maxX < 0 || orientation.shape.height() > bottom(best) + EPS) continue;
            int xCount = 0;
            xBuf[xCount++] = 0d;
            xBuf[xCount++] = maxX;
            if (best.x <= maxX) xBuf[xCount++] = best.x;
            double currentLimit = bottom(best) - orientation.shape.height();
            for (var obstacle : obstacles) {
                if (expired(deadline)) return best;
                var obsProfile = obstacle.defect ? obstacle.oriented.raw : obstacle.oriented.collision;
                var selfProfile = obstacle.defect ? orientation.raw : orientation.collision;
                if (obstacle.y + obsProfile.minY > currentLimit + selfProfile.maxY + EPS) {
                    continue;
                }
                double[] oxs = largeBatch ? obsProfile.coarseXs : obsProfile.xs;
                double[] sxs = largeBatch ? selfProfile.coarseXs : selfProfile.xs;
                int needed = xCount + oxs.length * sxs.length;
                if (needed > xBuf.length) {
                    xBuf = Arrays.copyOf(xBuf, Math.max(needed, xBuf.length * 2));
                }
                double obX = obstacle.x;
                for (double ox : oxs) {
                    double base = obX + ox;
                    for (double sx : sxs) {
                        double x = base - sx;
                        if (x > 0 && x < maxX) {
                            xBuf[xCount++] = x;
                        }
                    }
                }
            }
            Arrays.sort(xBuf, 0, xCount);
            // 原地线性去重；仅大批量无疵点时提高去重步长防超时，小批量与带疵点算例严格保持原有精细采样
            int uniqueCount = 0;
            double dedupTol = largeBatch && xCount > 160
                    ? Math.max(8.0, width / 100.0)
                    : (xCount > 1200 ? 0.25 : 1e-9);
            for (int i = 0; i < xCount; i++) {
                double v = xBuf[i];
                if (uniqueCount == 0 || v - xBuf[uniqueCount - 1] > dedupTol || i == xCount - 1) {
                    if (uniqueCount == 0 || v - xBuf[uniqueCount - 1] > 1e-10) {
                        xBuf[uniqueCount++] = v;
                    }
                }
            }
            int start = preferLeft ? 0 : uniqueCount - 1;
            int step = preferLeft ? 1 : -1;
            for (int idx = start; idx >= 0 && idx < uniqueCount; idx += step) {
                if (expired(deadline)) return best;
                double x = xBuf[idx];
                double limit = bottom(best) - orientation.shape.height();
                double y = firstFreeY(orientation, x, obstacles, obstacleBvh, limit, deadline);
                if (y > limit + EPS) continue;
                if (y < limit - EPS || (preferLeft ? x < best.x - EPS : x > best.x + EPS))
                    best = new Positioned(orientation, x, y, false);
            }
        }
        return best;
    }

    private static double firstFreeY(Oriented shape, double x, List<Positioned> obstacles,
                                     AabbBvh obstacleBvh, double limit, long deadline) {
        var forbidden = new ArrayList<Interval>();
        double qMinX = x + Math.min(shape.raw.minX, shape.collision.minX);
        double qMaxX = x + Math.max(shape.raw.maxX, shape.collision.maxX);
        double qMinY = Math.min(shape.raw.minY, shape.collision.minY);
        double qMaxY = limit + Math.max(shape.raw.maxY, shape.collision.maxY) + EPS;

        boolean aborted = obstacleBvh.queryAnyExpanded(qMinX, qMinY, qMaxX, qMaxY, EPS, idx -> {
            var o = obstacles.get(idx);
            var aProfile = o.defect ? shape.raw : shape.collision;
            var bProfile = o.defect ? o.oriented.raw : o.oriented.collision;
            if (x + aProfile.minX >= o.x + bProfile.maxX || x + aProfile.maxX <= o.x + bProfile.minX) {
                return false;
            }
            // 双指针利用 slabs 按 left 升序特性，将 O(|A|*|B|) 降至近线性扫描
            var aSlabs = aProfile.slabs;
            var bSlabs = bProfile.slabs;
            int bStart = 0;
            int bLen = bSlabs.size();
            for (int ai = 0, aLen = aSlabs.size(); ai < aLen; ai++) {
                if (expired(deadline) || forbidden.size() > 8192) return true;
                var a = aSlabs.get(ai);
                double aLeft = x + a.left;
                double aRight = x + a.right;
                while (bStart < bLen && o.x + bSlabs.get(bStart).right <= aLeft + EPS) {
                    bStart++;
                }
                for (int bi = bStart; bi < bLen; bi++) {
                    var b = bSlabs.get(bi);
                    double bLeft = o.x + b.left;
                    if (bLeft >= aRight - EPS) break;
                    double left = Math.max(aLeft, bLeft);
                    double right = Math.min(aRight, o.x + b.right);
                    if (right - left <= EPS) continue;
                    // Over this shared x interval, the range of colliding y translations is the
                    // difference between the two trapezoids' linear upper/lower envelopes.
                    double low = o.y + Math.min(b.top.y(left - o.x) - a.bottom.y(left - x),
                            b.top.y(right - o.x) - a.bottom.y(right - x));
                    double high = o.y + Math.max(b.bottom.y(left - o.x) - a.top.y(left - x),
                            b.bottom.y(right - o.x) - a.top.y(right - x));
                    if (low < -EPS && high > limit + EPS) return true;
                    if (high > 0 && low < limit + EPS) forbidden.add(new Interval(low, high));
                }
            }
            return false;
        });
        if (aborted) {
            return Double.POSITIVE_INFINITY;
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
