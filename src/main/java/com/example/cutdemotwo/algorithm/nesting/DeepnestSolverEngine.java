package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.contracts.nesting.EngineCapabilities;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Exclusion;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Part;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import org.springframework.stereotype.Service;

import java.awt.geom.Area;
import java.awt.geom.Line2D;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Pure-Java 2D Irregular / Contour Nesting Engine migrated from {@code D:\GitHub\Deepnest}.
 *
 * <p>Combines Deepnest's three signature algorithmic layers:
 * <ol>
 *   <li><b>Exact Minkowski No-Fit Polygon (NFP) &amp; Inner-Fit Polygon (IFP)</b>
 *       ({@link DeepnestNfpGeometry}): convex polygon decomposition + rotating-calipers Minkowski sum
 *       + hole-aware segment convolution, with full NFP pair memoization and incremental {@code clipCache}
 *       boolean union;</li>
 *   <li><b>Genetic Algorithm Metaheuristic</b> ({@link DeepnestGeneticAlgorithm}): evolves part insertion
 *       permutations and discrete allowed orientations ({@code 0°/90°/180°/270°} or {@code 0°/180°}) via
 *       single-point order crossover, swap/rotation mutation, rank-weighted selection, and elitism;</li>
 *   <li><b>Gravity Bounding Compression &amp; Collinear Common-Line Merging</b>: evaluates NFP boundary
 *       vertices and crease-line intersections with collinear shared-edge rewards ({@code mergedLength}),
 *       backed by strict geometric verification matching {@link PolygonResultValidator}.</li>
 * </ol>
 */
@Service
public class DeepnestSolverEngine implements ICutSolverEngine {
    private static final double VALIDATOR_AREA_TOL = 0.0005; // Strictly tighter than PolygonResultValidator's 0.001 mm^2
    private static final double VALIDATOR_GAP_TOL = 0.0005;  // Strictly tighter than PolygonResultValidator's 0.001 mm
    private static final int DEFAULT_POPULATION_SIZE = 10;
    private static final int DEFAULT_MUTATION_RATE = 15;
    private static final int TOP_CANDIDATES_TO_VALIDATE = 28;

    @Override
    public String getEngineType() {
        return "deepnest";
    }

    @Override
    public boolean isAvailable() {
        return true;
    }

    @Override
    public EngineCapabilities capabilities() {
        return new EngineCapabilities(
                getEngineType(),
                "1",
                List.of("RECTANGLE", "POLYGON"),
                List.of("CONTOUR"),
                List.of("MAXIMIZE_PIECE_AREA"),
                0.1,
                true
        );
    }

    @Override
    public EngineResult solve(NestingProblem problem) {
        return runDeepnest(problem, false);
    }

    /** Direct fixed-width open-strip minimization entry for {@code MarkerOptimization} STRIP_SEARCH. */
    public EngineResult solveStripCandidate(NestingProblem problem) {
        return runDeepnest(problem, true);
    }

    private record OrientedPart(
            int demandId,
            String name,
            int angle,
            Shape shape,
            double width,
            double height,
            double area,
            List<Point> vertices,
            List<List<Point>> convexPieces
    ) {}

    private static final class ExpandedPart implements DeepnestGeneticAlgorithm.PartDescriptor {
        final int instanceId;
        final int demandId;
        final String name;
        final double area;
        final List<Integer> allowedAngles;
        final Map<Integer, OrientedPart> byAngle;
        final OrientedPart primary;

        ExpandedPart(int instanceId, int demandId, String name, double area,
                     List<Integer> allowedAngles, Map<Integer, OrientedPart> byAngle) {
            this.instanceId = instanceId;
            this.demandId = demandId;
            this.name = name;
            this.area = area;
            this.allowedAngles = allowedAngles;
            this.byAngle = byAngle;
            this.primary = byAngle.get(allowedAngles.get(0));
        }

        @Override public int instanceId() { return instanceId; }
        @Override public int demandId() { return demandId; }
        @Override public double area() { return area; }
        @Override public double primaryHeight() { return primary.height(); }
        @Override public double primaryWidth() { return primary.width(); }
        @Override public List<Integer> allowedAngles() { return allowedAngles; }
    }

    private static final class ExclusionObstacle {
        final Area worldArea;
        final double minX, maxX, minY, maxY;

        ExclusionObstacle(Exclusion exc) {
            double clr = exc.clearance();
            Shape s = clr == 0
                    ? exc.shape()
                    : Shape.rectangle(exc.shape().width() + 2 * clr, exc.shape().height() + 2 * clr);
            double x = exc.x() - clr;
            double y = exc.y() - clr;
            this.worldArea = PolygonGeometry.region(s, x, y);
            this.minX = x;
            this.maxX = x + s.width();
            this.minY = y;
            this.maxY = y + s.height();
        }
    }

    private static final class PlacedInstance {
        final int instanceId;
        final OrientedPart ori;
        final double x;
        final double y;
        final Area worldArea;
        final List<Point> worldVertices;
        final double minX, maxX, minY, maxY;

        PlacedInstance(int instanceId, OrientedPart ori, double x, double y) {
            this.instanceId = instanceId;
            this.ori = ori;
            this.x = x;
            this.y = y;
            this.worldArea = PolygonGeometry.region(ori.shape(), x, y);
            List<Point> wv = new ArrayList<>(ori.vertices().size());
            for (Point v : ori.vertices()) {
                wv.add(new Point(v.x() + x, v.y() + y));
            }
            this.worldVertices = wv;
            this.minX = x;
            this.maxX = x + ori.width();
            this.minY = y;
            this.maxY = y + ori.height();
        }
    }

    private static final class ClipCacheEntry {
        Area combinedNfp = new Area();
        int nextPlacedIndex = 0;
    }

    private record NfpOuterKey(int aDemand, int aAngle, int bDemand, int bAngle) {}
    private record NfpInnerKey(int bDemand, int bAngle) {}

    private static final class ProblemContext {
        final NestingProblem problem;
        final Shape matShape;
        final Area matArea;
        final boolean isRectMat;
        final double matW, matH;
        final double pieceGap;
        final boolean preferRight;
        final boolean preferBottom;
        final double gravityWeight;
        final List<ExclusionObstacle> exclusions;
        final List<ExpandedPart> items;
        final double totalRequestedArea;
        final double sheetArea;
        final Map<NfpInnerKey, Area> innerNfpCache = new HashMap<>();
        final Map<NfpOuterKey, Area> outerNfpCache = new HashMap<>();

        ProblemContext(NestingProblem problem, boolean stripMode) {
            this.problem = problem;
            this.matShape = problem.material().shape();
            this.matArea = PolygonGeometry.region(matShape, 0, 0);
            this.isRectMat = "RECTANGLE".equals(matShape.type());
            this.matW = matShape.width();
            this.matH = matShape.height();
            this.pieceGap = problem.process().pieceGap();
            String corner = problem.process().startCorner() == null ? "left-top" : problem.process().startCorner();
            this.preferRight = corner.startsWith("right");
            this.preferBottom = !stripMode && corner.endsWith("bottom");

            this.exclusions = new ArrayList<>(problem.material().exclusions().size());
            for (Exclusion exc : problem.material().exclusions()) {
                ComputationCancellation.check();
                this.exclusions.add(new ExclusionObstacle(exc));
            }

            Map<NfpInnerKey, OrientedPart> uniqueOrientations = new HashMap<>();
            this.items = new ArrayList<>();
            double reqArea = 0.0;
            double sumPartH = 0.0;
            int instanceSeq = 0;

            for (Part part : problem.parts()) {
                ComputationCancellation.check();
                List<Integer> angles = part.contourAngles();
                Map<Integer, OrientedPart> oriMap = new HashMap<>();
                for (int angle : angles) {
                    ComputationCancellation.check();
                    NfpInnerKey key = new NfpInnerKey(part.id(), angle);
                    OrientedPart op = uniqueOrientations.computeIfAbsent(key, k -> {
                        Shape rotated = PolygonGeometry.rotate(part.shape(), angle);
                        double a = PolygonGeometry.area(rotated);
                        return new OrientedPart(
                                part.id(),
                                part.name(),
                                angle,
                                rotated,
                                rotated.width(),
                                rotated.height(),
                                a,
                                PolygonGeometry.vertices(rotated),
                                DeepnestNfpGeometry.decomposeConvex(rotated)
                        );
                    });
                    oriMap.put(angle, op);
                }
                double partArea = PolygonGeometry.area(part.shape());
                for (int q = 0; q < part.quantity(); q++) {
                    ComputationCancellation.check();
                    ExpandedPart ep = new ExpandedPart(instanceSeq++, part.id(), part.name(), partArea, angles, oriMap);
                    items.add(ep);
                    reqArea += partArea;
                    sumPartH += ep.primaryHeight();
                }
            }

            this.totalRequestedArea = reqArea;
            this.sheetArea = Math.max(1.0, PolygonGeometry.area(matShape));
            double avgH = items.isEmpty() ? 100.0 : Math.max(30.0, sumPartH / items.size());
            // Weight feed-direction extent (Y) strongly relative to roll width (X) so wide parts pack side-by-side first
            this.gravityWeight = Math.max(3.0, (2.2 * matW) / avgH);
        }

        Area getInnerNfp(OrientedPart ori) {
            NfpInnerKey key = new NfpInnerKey(ori.demandId(), ori.angle());
            Area cached = innerNfpCache.get(key);
            if (cached != null) return cached;
            Area computed = DeepnestNfpGeometry.computeInnerNfp(
                    matShape, problem.material().exclusions(), ori.shape(), ori.convexPieces()
            );
            innerNfpCache.put(key, computed);
            return computed;
        }

        Area getOuterNfp(OrientedPart placedOri, OrientedPart candOri) {
            NfpOuterKey key = new NfpOuterKey(
                    placedOri.demandId(), placedOri.angle(), candOri.demandId(), candOri.angle()
            );
            Area cached = outerNfpCache.get(key);
            if (cached != null) return cached;
            Area computed = DeepnestNfpGeometry.computeOuterNfp(
                    placedOri.shape(), placedOri.convexPieces(),
                    candOri.shape(), candOri.convexPieces(),
                    pieceGap
            );
            outerNfpCache.put(key, computed);
            return computed;
        }
    }

    private record CandidatePoint(double x, double y, double baseScore, double newExtentY) {}
    private record ChosenSpot(double x, double y, OrientedPart ori, double score, double mergedLen) {}
    private record EvaluationResult(List<PlacedInstance> placed, double placedArea, double extentY, double fitness) {}

    private EngineResult runDeepnest(NestingProblem problem, boolean stripMode) {
        ComputationCancellation.check();
        long startNanos = System.nanoTime();
        long budgetNanos = Math.max(1L, problem.timeLimitSeconds()) * 1_000_000_000L;
        // Reserve 10% (up to 150 ms) at the end for post-GA coordinate polish and result construction
        long searchDeadline = startNanos + budgetNanos - Math.min(150_000_000L, budgetNanos / 10);

        ProblemContext ctx = new ProblemContext(problem, stripMode);
        if (ctx.items.isEmpty()) {
            EngineResult empty = new EngineResult();
            empty.setSuccess(true);
            empty.setPlacements(List.of());
            return empty;
        }

        int n = ctx.items.size();
        int popSize = n == 1 ? 1 : (n <= 4 ? 6 : 12);
        long seed = computeDeterministicSeed(problem);
        DeepnestGeneticAlgorithm ga = new DeepnestGeneticAlgorithm(ctx.items, popSize, DEFAULT_MUTATION_RATE, seed);

        double theoreticalMinY = Math.max(
                ctx.items.stream().mapToDouble(ep -> ep.byAngle.values().stream()
                        .mapToDouble(OrientedPart::height).min().orElse(0.0)).max().orElse(0.0),
                ctx.totalRequestedArea / Math.max(1.0, ctx.matW)
        );

        EvaluationResult bestEval = null;
        int stagnantGenerations = 0;
        int maxStagnantComplete = stripMode ? 6 : 4;

        int generation = 0;
        outerSearch:
        while (true) {
            ComputationCancellation.check();
            boolean improvedInGen = false;

            List<DeepnestGeneticAlgorithm.Individual> pop = ga.population();
            for (int idx = 0; idx < pop.size(); idx++) {
                ComputationCancellation.check();
                if (bestEval != null && System.nanoTime() >= searchDeadline) {
                    break outerSearch;
                }
                DeepnestGeneticAlgorithm.Individual ind = pop.get(idx);
                if (ind.evaluated) continue;

                EvaluationResult eval = evaluateIndividual(ctx, ind, searchDeadline, bestEval != null);
                ind.fitness = eval.fitness();
                ind.evaluated = true;

                if (bestEval == null || eval.fitness() < bestEval.fitness() - 1e-6) {
                    bestEval = eval;
                    improvedInGen = true;
                }

                // Stop immediately if 100% of pieces are placed and theoretical lower bound is achieved
                if (bestEval.placed().size() == n && bestEval.extentY() <= theoreticalMinY + 0.2) {
                    break outerSearch;
                }
            }

            if (n <= 1 || System.nanoTime() >= searchDeadline) {
                break;
            }

            boolean allEvaluated = pop.stream().allMatch(i -> i.evaluated);
            if (!allEvaluated) break;

            if (improvedInGen) {
                stagnantGenerations = 0;
                ga.nextGeneration();
            } else {
                stagnantGenerations++;
                if (bestEval != null && bestEval.placed().size() == n && stagnantGenerations >= maxStagnantComplete) {
                    break;
                }
                if (bestEval != null && bestEval.placed().size() < n && stagnantGenerations % 3 == 0) {
                    // Kit is still incomplete and time budget remains: inject diversified permutations & placement modes
                    ga.diversifyPopulation();
                } else {
                    ga.nextGeneration();
                }
            }

            generation++;
            if (generation >= 120) break;
        }

        EngineResult out = new EngineResult();
        if (bestEval == null || bestEval.placed().isEmpty()) {
            out.setSuccess(false);
            out.setFailureStatus("NO_SOLUTION_FOUND");
            out.setMessage("未找到可行排样方案");
            return out;
        }

        long polishDeadline = startNanos + budgetNanos;
        List<PlacedInstance> polished = polishPlacements(ctx, bestEval.placed(), polishDeadline);

        List<Placement> finalPlacements = new ArrayList<>(polished.size());
        int seq = 1;
        for (PlacedInstance pi : polished) {
            ComputationCancellation.check();
            finalPlacements.add(new Placement(
                    seq++,
                    pi.ori.demandId(),
                    pi.ori.name(),
                    pi.x,
                    pi.y,
                    pi.ori.shape(),
                    pi.ori.angle()
            ));
        }

        out.setSuccess(true);
        out.setPlacements(finalPlacements);
        return out;
    }

    /**
     * Evaluates one GA chromosome using Deepnest's NFP boolean difference placement rule
     * ({@code placeParts} in {@code background.js:804-1173}).
     */
    private static EvaluationResult evaluateIndividual(ProblemContext ctx,
                                                       DeepnestGeneticAlgorithm.Individual ind,
                                                       long deadlineNanos,
                                                       boolean hasIncumbent) {
        List<PlacedInstance> placed = new ArrayList<>(ind.order.length);
        List<List<Point>> placedWorldPolys = new ArrayList<>(ind.order.length);
        Map<NfpInnerKey, ClipCacheEntry> clipCache = new HashMap<>();

        double currentMaxX = 0.0;
        double currentMinX = ctx.matW;
        double currentMaxY = 0.0;
        double currentMinY = ctx.matH;
        double placedArea = 0.0;
        double totalMergedLength = 0.0;

        for (int step = 0; step < ind.order.length; step++) {
            ComputationCancellation.check();
            if (hasIncumbent && step > 0 && System.nanoTime() >= deadlineNanos) {
                break;
            }

            ExpandedPart item = ctx.items.get(ind.order[step]);
            int preferredAngle = ind.rotations[step];

            ChosenSpot bestSpot = null;

            if (ind.greedyAngles || placed.isEmpty()) {
                // Evaluate all allowed rotations and record the best angle back into chromosome
                for (int angle : item.allowedAngles) {
                    ComputationCancellation.check();
                    OrientedPart ori = item.byAngle.get(angle);
                    ChosenSpot candidate = findBestSpotForOrientation(
                            ctx, ori, ind.placementMode, placed, placedWorldPolys, clipCache,
                            currentMinX, currentMaxX, currentMinY, currentMaxY
                    );
                    if (candidate != null && (bestSpot == null || candidate.score() < bestSpot.score())) {
                        bestSpot = candidate;
                    }
                }
            } else {
                // Evaluate chromosome's evolved rotation first
                OrientedPart prefOri = item.byAngle.getOrDefault(preferredAngle, item.primary);
                bestSpot = findBestSpotForOrientation(
                        ctx, prefOri, ind.placementMode, placed, placedWorldPolys, clipCache,
                        currentMinX, currentMaxX, currentMinY, currentMaxY
                );
                // Fallback to other allowed rotations if preferred orientation cannot fit on remaining sheet
                if (bestSpot == null && item.allowedAngles.size() > 1) {
                    for (int angle : item.allowedAngles) {
                        if (angle == prefOri.angle()) continue;
                        ComputationCancellation.check();
                        OrientedPart altOri = item.byAngle.get(angle);
                        ChosenSpot candidate = findBestSpotForOrientation(
                                ctx, altOri, ind.placementMode, placed, placedWorldPolys, clipCache,
                                currentMinX, currentMaxX, currentMinY, currentMaxY
                        );
                        if (candidate != null && (bestSpot == null || candidate.score() < bestSpot.score())) {
                            bestSpot = candidate;
                        }
                    }
                }
            }

            if (bestSpot != null) {
                ind.rotations[step] = bestSpot.ori().angle();
                PlacedInstance pi = new PlacedInstance(item.instanceId, bestSpot.ori(), bestSpot.x(), bestSpot.y());
                placed.add(pi);
                placedWorldPolys.add(pi.worldVertices);
                placedArea += bestSpot.ori().area();
                totalMergedLength += bestSpot.mergedLen();

                if (pi.minX < currentMinX) currentMinX = pi.minX;
                if (pi.maxX > currentMaxX) currentMaxX = pi.maxX;
                if (pi.minY < currentMinY) currentMinY = pi.minY;
                if (pi.maxY > currentMaxY) currentMaxY = pi.maxY;
            }
        }

        double extentY = placed.isEmpty() ? ctx.matH : (ctx.preferBottom ? (ctx.matH - currentMinY) : currentMaxY);
        double extentX = placed.isEmpty() ? ctx.matW : (ctx.preferRight ? (ctx.matW - currentMinX) : currentMaxX);
        double unplacedArea = Math.max(0.0, ctx.totalRequestedArea - placedArea);
        int unplacedCount = ctx.items.size() - placed.size();

        // Deepnest hierarchical fitness (lower is better):
        // 1. Penalize unplaced piece area & count heavily (background.js:1167)
        // 2. Minimize feed-direction extent (extentY)
        // 3. Minimize cross-width extent (extentX) and reward merged collinear lines
        double fitness = 1e12 * (unplacedArea / ctx.sheetArea)
                + 1e8 * unplacedCount
                + extentY * 1000.0
                + extentX
                - totalMergedLength * 0.5;

        return new EvaluationResult(placed, placedArea, extentY, fitness);
    }

    private static ChosenSpot findBestSpotForOrientation(ProblemContext ctx,
                                                         OrientedPart ori,
                                                         DeepnestGeneticAlgorithm.PlacementMode mode,
                                                         List<PlacedInstance> placed,
                                                         List<List<Point>> placedWorldPolys,
                                                         Map<NfpInnerKey, ClipCacheEntry> clipCache,
                                                         double currentMinX, double currentMaxX,
                                                         double currentMinY, double currentMaxY) {
        Area sheetNfp = ctx.getInnerNfp(ori);
        if (sheetNfp.isEmpty()) return null;

        double maxValidX = Math.max(0.0, ctx.matW - ori.width());
        double maxValidY = Math.max(0.0, ctx.matH - ori.height());

        if (placed.isEmpty()) {
            // First part on the sheet: place at extremal corner of sheetNfp (background.js:887-906)
            List<DeepnestNfpGeometry.Ring> rings = DeepnestNfpGeometry.extractRings(sheetNfp);
            List<Point> rawPts = new ArrayList<>();
            rawPts.add(new Point(ctx.preferRight ? maxValidX : 0.0, ctx.preferBottom ? maxValidY : 0.0));
            for (DeepnestNfpGeometry.Ring ring : rings) {
                rawPts.addAll(ring.vertices());
            }

            ChosenSpot bestFirst = null;
            for (Point pt : rawPts) {
                ComputationCancellation.check();
                double cx = snapCoord(pt.x(), 0.0, maxValidX);
                double cy = snapCoord(pt.y(), 0.0, maxValidY);
                double primaryY = ctx.preferBottom ? (ctx.matH - cy) : (cy + ori.height());
                double secondaryX = ctx.preferRight ? (ctx.matW - cx) : (cx + ori.width());
                double score = mode == DeepnestGeneticAlgorithm.PlacementMode.GRAVITY_X
                        ? (secondaryX * ctx.gravityWeight + primaryY)
                        : (primaryY * ctx.gravityWeight + secondaryX);
                if (bestFirst != null && score >= bestFirst.score() - 1e-9) continue;
                if (isPlacementValid(ctx, cx, cy, ori, placed)) {
                    bestFirst = new ChosenSpot(cx, cy, ori, score, 0.0);
                }
            }
            return bestFirst;
        }

        // Incremental union of OuterNFPs via clipCache (background.js:920-968)
        NfpInnerKey cacheKey = new NfpInnerKey(ori.demandId(), ori.angle());
        ClipCacheEntry entry = clipCache.computeIfAbsent(cacheKey, k -> new ClipCacheEntry());
        if (entry.nextPlacedIndex < placed.size()) {
            List<Area> deltaAreas = new ArrayList<>(placed.size() - entry.nextPlacedIndex + 1);
            if (!entry.combinedNfp.isEmpty()) {
                deltaAreas.add(entry.combinedNfp);
            }
            for (int j = entry.nextPlacedIndex; j < placed.size(); j++) {
                ComputationCancellation.check();
                PlacedInstance p = placed.get(j);
                Area outer = ctx.getOuterNfp(p.ori, ori);
                if (!outer.isEmpty()) {
                    deltaAreas.add(DeepnestNfpGeometry.translateArea(outer, p.x, p.y));
                }
            }
            entry.combinedNfp = DeepnestNfpGeometry.unionBalanced(deltaAreas);
            entry.nextPlacedIndex = placed.size();
        }

        Area finalNfp = new Area(sheetNfp);
        if (!entry.combinedNfp.isEmpty()) {
            finalNfp.subtract(entry.combinedNfp);
        }
        if (finalNfp.isEmpty()) return null;

        List<DeepnestNfpGeometry.Ring> rings = DeepnestNfpGeometry.extractRings(finalNfp);
        if (rings.isEmpty()) return null;

        double creaseY = ctx.preferBottom ? currentMinY : (currentMaxY - ori.height());
        double creaseX = ctx.preferRight ? currentMinX : (currentMaxX - ori.width());

        List<CandidatePoint> candidates = new ArrayList<>(rings.size() * 12);
        for (DeepnestNfpGeometry.Ring ring : rings) {
            ComputationCancellation.check();
            List<Point> verts = ring.vertices();
            int vn = verts.size();
            for (int k = 0; k < vn; k++) {
                Point p1 = verts.get(k);
                addScoredCandidate(ctx, ori, mode, p1.x(), p1.y(), maxValidX, maxValidY,
                        currentMinX, currentMaxX, currentMinY, currentMaxY, candidates);

                Point p2 = verts.get((k + 1) % vn);
                // Crease-line intersection along diagonal NFP edge for tight tucking without growing extentY/extentX
                if ((p1.y() - creaseY) * (p2.y() - creaseY) < -1e-12) {
                    double t = (creaseY - p1.y()) / (p2.y() - p1.y());
                    double ix = p1.x() + t * (p2.x() - p1.x());
                    addScoredCandidate(ctx, ori, mode, ix, creaseY, maxValidX, maxValidY,
                            currentMinX, currentMaxX, currentMinY, currentMaxY, candidates);
                }
                if ((p1.x() - creaseX) * (p2.x() - creaseX) < -1e-12) {
                    double t = (creaseX - p1.x()) / (p2.x() - p1.x());
                    double iy = p1.y() + t * (p2.y() - p1.y());
                    addScoredCandidate(ctx, ori, mode, creaseX, iy, maxValidX, maxValidY,
                            currentMinX, currentMaxX, currentMinY, currentMaxY, candidates);
                }
            }
        }

        if (candidates.isEmpty()) return null;
        candidates.sort(Comparator.comparingDouble(CandidatePoint::baseScore));

        ChosenSpot best = null;
        int checked = 0;
        double lastX = Double.NaN, lastY = Double.NaN;
        boolean checkMerged = ctx.pieceGap == 0.0;
        double mergeWeight = switch (mode) {
            case TIGHT_CORNER -> 1.8;
            case BOX_AREA -> ctx.matW * 0.5;
            default -> 0.35;
        };

        for (CandidatePoint cp : candidates) {
            ComputationCancellation.check();
            if (Math.abs(cp.x() - lastX) < 1e-4 && Math.abs(cp.y() - lastY) < 1e-4) {
                continue;
            }
            lastX = cp.x();
            lastY = cp.y();

            double maxPossibleBonus = checkMerged ? (ori.width() + ori.height()) * 2.0 * mergeWeight : 0.0;
            if (best != null && cp.baseScore() - maxPossibleBonus >= best.score()) {
                break;
            }

            if (isPlacementValid(ctx, cp.x(), cp.y(), ori, placed)) {
                double merged = checkMerged
                        ? DeepnestNfpGeometry.mergedLength(placedWorldPolys, ori.vertices(), cp.x(), cp.y(), 10.0, 0.05)
                        : 0.0;
                double totalScore = cp.baseScore() - merged * mergeWeight;
                if (best == null || totalScore < best.score()) {
                    best = new ChosenSpot(cp.x(), cp.y(), ori, totalScore, merged);
                }
                checked++;
                if (checked >= TOP_CANDIDATES_TO_VALIDATE) {
                    break;
                }
            } else {
                checked++;
                if (checked >= TOP_CANDIDATES_TO_VALIDATE * 2 && best != null) {
                    break;
                }
            }
        }

        return best;
    }

    private static void addScoredCandidate(ProblemContext ctx, OrientedPart ori,
                                           DeepnestGeneticAlgorithm.PlacementMode mode,
                                           double rawX, double rawY,
                                           double maxValidX, double maxValidY,
                                           double currentMinX, double currentMaxX,
                                           double currentMinY, double currentMaxY,
                                           List<CandidatePoint> out) {
        if (!Double.isFinite(rawX) || !Double.isFinite(rawY)) return;
        if (rawX < -0.05 || rawX > maxValidX + 0.05 || rawY < -0.05 || rawY > maxValidY + 0.05) return;

        double cx = snapCoord(rawX, 0.0, maxValidX);
        double cy = snapCoord(rawY, 0.0, maxValidY);

        double newExtentY = ctx.preferBottom
                ? Math.max(ctx.matH - currentMinY, ctx.matH - cy)
                : Math.max(currentMaxY, cy + ori.height());
        double newExtentX = ctx.preferRight
                ? Math.max(ctx.matW - currentMinX, ctx.matW - cx)
                : Math.max(currentMaxX, cx + ori.width());

        double ownY = ctx.preferBottom ? (ctx.matH - cy) : (cy + ori.height());
        double ownX = ctx.preferRight ? (ctx.matW - cx) : cx;

        double baseScore = switch (mode) {
            case GRAVITY_Y -> newExtentY * ctx.gravityWeight + newExtentX + ownY * 0.25 + ownX * 0.02;
            case GRAVITY_X -> newExtentX * ctx.gravityWeight + newExtentY + ownX * 0.25 + ownY * 0.02;
            // Deepnest 'box' mode (background.js:1063): bounding rectangle area width * height
            case BOX_AREA -> newExtentX * newExtentY + (ownY + ownX) * 10.0;
            // Tight corner packing: packs into the closest pocket toward startCorner first
            case TIGHT_CORNER -> ownY * 2.5 + ownX * 2.0 + newExtentY * 0.8 + newExtentX * 0.5;
        };

        out.add(new CandidatePoint(cx, cy, baseScore, newExtentY));
    }

    private static double snapCoord(double val, double minVal, double maxVal) {
        double clamped = Math.max(minVal, Math.min(maxVal, val));
        double roundedMilli = Math.rint(clamped * 1000.0) / 1000.0;
        if (Math.abs(clamped - roundedMilli) <= 2e-5 && roundedMilli >= minVal && roundedMilli <= maxVal) {
            return roundedMilli;
        }
        return clamped;
    }

    /**
     * Fast post-GA local coordinate slide (0.1 mm resolution) that eliminates any residual micro-gap
     * left by NFP tolerances while strictly preserving validity.
     */
    private static List<PlacedInstance> polishPlacements(ProblemContext ctx,
                                                         List<PlacedInstance> incumbent,
                                                         long deadlineNanos) {
        if (incumbent.size() <= 1 || System.nanoTime() >= deadlineNanos) return incumbent;
        List<PlacedInstance> work = new ArrayList<>(incumbent);
        double[] steps = {2.0, 0.5, 0.1};
        double dirY = ctx.preferBottom ? 1.0 : -1.0;
        double dirX = ctx.preferRight ? 1.0 : -1.0;

        // Sort indices so upstream pieces (closer to startCorner) settle first, then downstream pieces slide into them
        List<Integer> order = new ArrayList<>(work.size());
        for (int i = 0; i < work.size(); i++) order.add(i);
        order.sort(Comparator.comparingDouble(i -> ctx.preferBottom ? -work.get(i).maxY : work.get(i).minY));

        for (int idx : order) {
            if (System.nanoTime() >= deadlineNanos) break;
            ComputationCancellation.check();
            PlacedInstance current = work.get(idx);
            double maxValidX = Math.max(0.0, ctx.matW - current.ori.width());
            double maxValidY = Math.max(0.0, ctx.matH - current.ori.height());

            List<PlacedInstance> others = new ArrayList<>(work.size() - 1);
            for (int j = 0; j < work.size(); j++) {
                if (j != idx) others.add(work.get(j));
            }

            double bestX = current.x;
            double bestY = current.y;
            boolean moved = false;

            for (double step : steps) {
                if (System.nanoTime() >= deadlineNanos) break;
                // Slide along primary feed axis (-Y or +Y)
                while (true) {
                    ComputationCancellation.check();
                    double ny = snapCoord(bestY + dirY * step, 0.0, maxValidY);
                    if (Math.abs(ny - bestY) < 1e-6) break;
                    if (isPlacementValid(ctx, bestX, ny, current.ori, others)) {
                        bestY = ny;
                        moved = true;
                    } else {
                        break;
                    }
                }
                // Slide along cross axis (-X or +X)
                while (true) {
                    ComputationCancellation.check();
                    double nx = snapCoord(bestX + dirX * step, 0.0, maxValidX);
                    if (Math.abs(nx - bestX) < 1e-6) break;
                    if (isPlacementValid(ctx, nx, bestY, current.ori, others)) {
                        bestX = nx;
                        moved = true;
                    } else {
                        break;
                    }
                }
            }

            if (moved) {
                work.set(idx, new PlacedInstance(current.instanceId, current.ori, bestX, bestY));
            }
        }
        return work;
    }

    /**
     * Exact feasibility guard matching {@link PolygonResultValidator} rules:
     * material containment, defect exclusion avoidance, non-overlapping area, and {@code pieceGap} segment distance.
     */
    private static boolean isPlacementValid(ProblemContext ctx,
                                            double x, double y,
                                            OrientedPart ori,
                                            List<PlacedInstance> placedList) {
        double w = ori.width();
        double h = ori.height();
        if (x < -1e-7 || y < -1e-7 || x + w > ctx.matW + 1e-6 || y + h > ctx.matH + 1e-6) {
            return false;
        }

        Area candArea = PolygonGeometry.region(ori.shape(), x, y);

        if (!ctx.isRectMat) {
            Area outside = new Area(candArea);
            outside.subtract(ctx.matArea);
            if (PolygonGeometry.area(outside) > VALIDATOR_AREA_TOL) {
                return false;
            }
        }

        for (ExclusionObstacle exc : ctx.exclusions) {
            ComputationCancellation.check();
            if (x + w > exc.minX - 1e-6 && x < exc.maxX + 1e-6
                    && y + h > exc.minY - 1e-6 && y < exc.maxY + 1e-6) {
                Area overlap = new Area(candArea);
                overlap.intersect(exc.worldArea);
                if (PolygonGeometry.area(overlap) > VALIDATOR_AREA_TOL) {
                    return false;
                }
            }
        }

        double gap = ctx.pieceGap;
        List<Point> cVerts = ori.vertices();
        int cn = cVerts.size();

        for (PlacedInstance p : placedList) {
            ComputationCancellation.check();
            if (x + w < p.minX - gap - 1e-6 || x > p.maxX + gap + 1e-6
                    || y + h < p.minY - gap - 1e-6 || y > p.maxY + gap + 1e-6) {
                continue;
            }

            Area overlap = new Area(candArea);
            overlap.intersect(p.worldArea);
            if (PolygonGeometry.area(overlap) > VALIDATOR_AREA_TOL) {
                return false;
            }

            if (gap > 0) {
                List<Point> pVerts = p.worldVertices;
                int pn = pVerts.size();
                for (int i = 0; i < cn; i++) {
                    Point c1 = cVerts.get(i);
                    Point c2 = cVerts.get((i + 1) % cn);
                    double ax = c1.x() + x, ay = c1.y() + y;
                    double bx = c2.x() + x, by = c2.y() + y;
                    for (int j = 0; j < pn; j++) {
                        Point q1 = pVerts.get(j);
                        Point q2 = pVerts.get((j + 1) % pn);
                        double cx = q1.x(), cy = q1.y();
                        double dx = q2.x(), dy = q2.y();
                        double dist = Line2D.linesIntersect(ax, ay, bx, by, cx, cy, dx, dy) ? 0.0 : Math.min(
                                Math.min(Line2D.ptSegDist(ax, ay, bx, by, cx, cy), Line2D.ptSegDist(ax, ay, bx, by, dx, dy)),
                                Math.min(Line2D.ptSegDist(cx, cy, dx, dy, ax, ay), Line2D.ptSegDist(cx, cy, dx, dy, bx, by))
                        );
                        if (dist + VALIDATOR_GAP_TOL < gap) {
                            return false;
                        }
                    }
                }
            }
        }

        return true;
    }

    private static long computeDeterministicSeed(NestingProblem p) {
        long h = 0x9E3779B97F4A7C15L;
        h = h * 31 + Double.hashCode(p.width());
        h = h * 31 + Double.hashCode(p.height());
        h = h * 31 + Double.hashCode(p.process().pieceGap());
        for (Part part : p.parts()) {
            h = h * 31 + Objects.hash(part.id(), part.quantity(), part.allowRotation(), part.allowHalfTurn());
            h = h * 31 + Double.hashCode(part.shape().width());
            h = h * 31 + Double.hashCode(part.shape().height());
        }
        return h;
    }
}
