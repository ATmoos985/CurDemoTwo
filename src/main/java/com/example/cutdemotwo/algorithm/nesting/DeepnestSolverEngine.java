package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.EngineGeometry;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.algorithm.nesting.constraints.ConstraintPipeline;
import com.example.cutdemotwo.algorithm.nesting.constraints.CurtainConstraintPack;
import com.example.cutdemotwo.algorithm.nesting.constraints.PatternRepeatRule;
import com.example.cutdemotwo.contracts.nesting.EngineCapabilities;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Exclusion;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Part;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import org.locationtech.jts.geom.Geometry;
import org.springframework.stereotype.Service;

import java.awt.geom.Area;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.SplittableRandom;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;

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
public class DeepnestSolverEngine implements ICutSolverEngine, StripSearchCapable {
    private static final double VALIDATOR_AREA_TOL = EngineGeometry.AREA_EPS_MM2 * 0.5; // Strictly tighter than PolygonResultValidator's 0.001 mm^2
    private static final double VALIDATOR_GAP_TOL = EngineGeometry.COORDINATE_EPS_MM * 0.5; // Strictly tighter than PolygonResultValidator's 0.001 mm
    private static final int DEFAULT_POPULATION_SIZE = 10;
    private static final int DEFAULT_MUTATION_RATE = 15;
    private static final int TOP_CANDIDATES_TO_VALIDATE = 28;
    private static final int LARGE_SET_CANDIDATES_TO_VALIDATE = 36;
    private static final int LNS_CANDIDATES_TO_VALIDATE = 48;
    private static final int STRATIFIED_EXTRA_CANDIDATES = 6;
    private static final int LNS_MIN_PIECES = 4;
    private static final int LNS_MIN_RUIN = 2;
    private static final int LNS_MAX_RUIN = 12;

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
    @Override
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
            List<List<Point>> convexPieces,
            DeepnestNfpGeometry.ShapeSignature signature
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
        final int id;
        final Area worldArea;
        final double minX, maxX, minY, maxY;

        ExclusionObstacle(Exclusion exc) {
            this.id = exc.id();
            var expanded = ContourGeometrySupport.expandExclusion(exc);
            this.worldArea = expanded.worldArea();
            this.minX = expanded.minX();
            this.maxX = expanded.maxX();
            this.minY = expanded.minY();
            this.maxY = expanded.maxY();
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
        Geometry combinedNfp = DeepnestNfpGeometry.EMPTY_GEOM;
        int nextPlacedIndex = 0;
    }

    private record NfpOuterKey(int aDemand, int aAngle, int bDemand, int bAngle) {}
    private record NfpInnerKey(int bDemand, int bAngle) {}

    private static final class ProblemContext {
        final NestingProblem problem;
        final ConstraintPipeline pipeline;
        final Shape matShape;
        final Area matArea;
        final boolean isRectMat;
        final double matW, matH;
        final double pieceGap;
        final boolean preferRight;
        final boolean preferBottom;
        final double gravityWeight;
        final List<ExclusionObstacle> exclusions;
        final AabbBvh exclusionBvh;
        final Map<Integer, Part> partById;
        final Map<Integer, double[]> xBoundsByDemand;
        final Map<Integer, List<Exclusion>> hardRawExclusionsByDemand;
        final Map<Integer, List<ExclusionObstacle>> hardObstaclesByDemand;
        final Map<Integer, AabbBvh> hardObstacleBvhByDemand;
        final List<ExpandedPart> items;
        final double totalRequestedArea;
        final double sheetArea;
        final Map<NfpInnerKey, Geometry> innerNfpCache = new ConcurrentHashMap<>();
        final Map<NfpOuterKey, Geometry> outerNfpCache = new ConcurrentHashMap<>();

        ProblemContext(NestingProblem problem, boolean stripMode) {
            this.problem = problem;
            this.pipeline = CurtainConstraintPack.forProblem(problem);
            this.matShape = problem.material().shape();
            this.matArea = PolygonGeometry.region(matShape, 0, 0);
            this.matArea.getBounds2D();
            this.isRectMat = "RECTANGLE".equals(matShape.type());
            this.matW = matShape.width();
            this.matH = matShape.height();
            this.pieceGap = problem.process().pieceGap();
            String corner = problem.process().startCorner() == null ? "left-top" : problem.process().startCorner();
            this.preferRight = corner.startsWith("right");
            this.preferBottom = !stripMode && corner.endsWith("bottom");

            this.exclusions = new ArrayList<>(problem.material().exclusions().size());
            Map<Integer, ExclusionObstacle> obstacleById = new HashMap<>(problem.material().exclusions().size() * 2);
            for (Exclusion exc : problem.material().exclusions()) {
                ComputationCancellation.check();
                ExclusionObstacle obs = new ExclusionObstacle(exc);
                this.exclusions.add(obs);
                obstacleById.put(exc.id(), obs);
            }
            this.exclusionBvh = buildExclusionBvh(this.exclusions);

            this.partById = new HashMap<>(problem.parts().size() * 2);
            this.xBoundsByDemand = new HashMap<>(problem.parts().size() * 2);
            this.hardRawExclusionsByDemand = new HashMap<>(problem.parts().size() * 2);
            this.hardObstaclesByDemand = new HashMap<>(problem.parts().size() * 2);
            this.hardObstacleBvhByDemand = new HashMap<>(problem.parts().size() * 2);

            Map<NfpInnerKey, OrientedPart> uniqueOrientations = new HashMap<>();
            this.items = new ArrayList<>();
            double reqArea = 0.0;
            double sumPartH = 0.0;
            int instanceSeq = 0;

            for (Part part : problem.parts()) {
                ComputationCancellation.check();
                this.partById.put(part.id(), part);
                if (!this.pipeline.isNoop()) {
                    this.xBoundsByDemand.put(part.id(), this.pipeline.clipXBounds(problem, part, 0.0, this.matW));
                    List<Exclusion> hardRaw = this.pipeline.hardExclusionsFor(problem, part);
                    this.hardRawExclusionsByDemand.put(part.id(), hardRaw);
                    List<ExclusionObstacle> hardObs = new ArrayList<>(hardRaw.size());
                    for (Exclusion he : hardRaw) {
                        ExclusionObstacle obs = obstacleById.get(he.id());
                        if (obs != null) hardObs.add(obs);
                    }
                    this.hardObstaclesByDemand.put(part.id(), hardObs);
                    this.hardObstacleBvhByDemand.put(part.id(), buildExclusionBvh(hardObs));
                }
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
                                DeepnestNfpGeometry.decomposeConvex(rotated),
                                DeepnestNfpGeometry.ShapeSignature.of(rotated)
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

        double minValidX(int demandId) {
            if (pipeline.isNoop()) return 0.0;
            double[] bounds = xBoundsByDemand.get(demandId);
            return bounds == null ? 0.0 : bounds[0];
        }

        double maxValidXEdge(int demandId) {
            if (pipeline.isNoop()) return matW;
            double[] bounds = xBoundsByDemand.get(demandId);
            return bounds == null ? matW : bounds[1];
        }

        List<ExclusionObstacle> hardObstaclesFor(int demandId) {
            if (pipeline.isNoop()) return exclusions;
            return hardObstaclesByDemand.getOrDefault(demandId, exclusions);
        }

        AabbBvh hardObstacleBvhFor(int demandId) {
            if (pipeline.isNoop()) return exclusionBvh;
            return hardObstacleBvhByDemand.getOrDefault(demandId, exclusionBvh);
        }

        private static AabbBvh buildExclusionBvh(List<ExclusionObstacle> list) {
            int count = list.size();
            if (count <= AabbBvh.LINEAR_THRESHOLD) {
                return AabbBvh.EMPTY;
            }
            double[] minX = new double[count];
            double[] minY = new double[count];
            double[] maxX = new double[count];
            double[] maxY = new double[count];
            for (int i = 0; i < count; i++) {
                ExclusionObstacle obs = list.get(i);
                minX[i] = obs.minX;
                minY[i] = obs.minY;
                maxX[i] = obs.maxX;
                maxY[i] = obs.maxY;
            }
            return AabbBvh.build(minX, minY, maxX, maxY, count);
        }

        Geometry getInnerNfp(OrientedPart ori) {
            NfpInnerKey key = new NfpInnerKey(ori.demandId(), ori.angle());
            Geometry cached = innerNfpCache.get(key);
            if (cached != null) return cached;
            List<Exclusion> hardRaw = pipeline.isNoop()
                    ? problem.material().exclusions()
                    : hardRawExclusionsByDemand.getOrDefault(ori.demandId(), problem.material().exclusions());
            Geometry computed = DeepnestNfpGeometry.computeInnerNfpGeom(
                    matShape, hardRaw, ori.shape(), ori.convexPieces()
            );
            if (!pipeline.isNoop() && !computed.isEmpty()) {
                double lo = minValidX(ori.demandId());
                double hi = maxValidXEdge(ori.demandId());
                if (lo > 0.0 || hi < matW) {
                    double maxStartX = hi - ori.width();
                    if (maxStartX < lo - 1e-6) {
                        computed = DeepnestNfpGeometry.EMPTY_GEOM;
                    } else {
                        Geometry xClip = DeepnestNfpGeometry.rectGeometry(
                                lo - 1e-4, -1e-4, Math.max(2e-4, maxStartX - lo + 2e-4), matH + 2e-4);
                        computed = DeepnestNfpGeometry.intersectionGeometry(computed, xClip);
                    }
                }
            }
            computed.getEnvelopeInternal();
            Geometry existing = innerNfpCache.putIfAbsent(key, computed);
            return existing != null ? existing : computed;
        }

        Geometry getOuterNfp(OrientedPart placedOri, OrientedPart candOri) {
            NfpOuterKey key = new NfpOuterKey(
                    placedOri.demandId(), placedOri.angle(), candOri.demandId(), candOri.angle()
            );
            Geometry cached = outerNfpCache.get(key);
            if (cached != null) return cached;
            Geometry computed = DeepnestNfpGeometry.getOrComputeOuterNfpGeom(
                    placedOri.shape(), placedOri.convexPieces(), placedOri.signature(),
                    candOri.shape(), candOri.convexPieces(), candOri.signature(),
                    pieceGap
            );
            computed.getEnvelopeInternal();
            Geometry existing = outerNfpCache.putIfAbsent(key, computed);
            return existing != null ? existing : computed;
        }
    }

    private record CandidatePoint(double x, double y, double baseScore, double newExtentY) {}
    private record ChosenSpot(double x, double y, OrientedPart ori, double score, double mergedLen) {}
    private record EvaluationResult(List<PlacedInstance> placed, double placedArea, double extentY, double fitness) {}

    private EngineResult runDeepnest(NestingProblem problem, boolean stripMode) {
        ComputationCancellation.check();
        long startNanos = System.nanoTime();
        long budgetNanos = Math.max(1L, problem.timeLimitSeconds()) * 1_000_000_000L;

        ProblemContext ctx = new ProblemContext(problem, stripMode);
        if (ctx.items.isEmpty()) {
            EngineResult empty = new EngineResult();
            empty.setSuccess(true);
            empty.setPlacements(List.of());
            return empty;
        }

        int n = ctx.items.size();
        // 三阶段预算划分：留出出口安全裕量，确保阶段1(构造+GA)、阶段2(LNS大邻域精修)、阶段3(联动压紧+终检)严格不超时
        long exitMarginNanos = Math.min(600_000_000L, Math.max(200_000_000L, budgetNanos / 6));
        long effectiveBudget = Math.max(200_000_000L, budgetNanos - exitMarginNanos);
        long stage3Deadline = startNanos + effectiveBudget;
        long stage3Reserve = n >= 2 ? Math.min(450_000_000L, Math.max(120_000_000L, effectiveBudget / 5)) : 0L;
        long stage2Deadline = stage3Deadline - stage3Reserve;
        long stage1Budget = n >= LNS_MIN_PIECES
                ? Math.max(150_000_000L, (long) ((stage2Deadline - startNanos) * 0.65))
                : Math.max(150_000_000L, stage2Deadline - startNanos);
        long stage1Deadline = startNanos + stage1Budget;

        int popSize = n == 1 ? 1 : (n <= 4 ? 6 : 12);
        long seed = computeDeterministicSeed(problem);
        DeepnestGeneticAlgorithm ga = new DeepnestGeneticAlgorithm(ctx.items, popSize, DEFAULT_MUTATION_RATE, seed);

        double theoreticalMinY = Math.max(
                ctx.items.stream().mapToDouble(ep -> ep.byAngle.values().stream()
                        .mapToDouble(OrientedPart::height).min().orElse(0.0)).max().orElse(0.0),
                ctx.totalRequestedArea / Math.max(1.0, ctx.matW)
        );

        // ==================== 阶段 1：构造 + 并行 GA 初解 ====================
        EvaluationResult bestEval = null;
        int stagnantGenerations = 0;
        int maxStagnantComplete = stripMode ? 6 : 4;

        int generation = 0;
        outerSearch:
        while (true) {
            ComputationCancellation.check();
            boolean improvedInGen = false;

            List<DeepnestGeneticAlgorithm.Individual> pop = ga.population();
            List<DeepnestGeneticAlgorithm.Individual> pending = new ArrayList<>(pop.size());
            for (DeepnestGeneticAlgorithm.Individual ind : pop) {
                if (!ind.evaluated) {
                    pending.add(ind);
                }
            }

            int batchSize = NestingParallelExecutor.MAX_PARALLELISM;
            for (int start = 0; start < pending.size(); start += batchSize) {
                ComputationCancellation.check();
                if (bestEval != null && System.nanoTime() >= stage1Deadline) {
                    break outerSearch;
                }
                int end = Math.min(pending.size(), start + batchSize);
                final boolean hasIncumbent = bestEval != null;
                List<Callable<EvaluationResult>> tasks = new ArrayList<>(end - start);
                for (int i = start; i < end; i++) {
                    final DeepnestGeneticAlgorithm.Individual ind = pending.get(i);
                    tasks.add(() -> evaluateIndividual(ctx, ind, stage1Deadline, hasIncumbent));
                }

                List<EvaluationResult> batchResults = NestingParallelExecutor.runDeterministic(tasks);
                for (int i = 0; i < batchResults.size(); i++) {
                    DeepnestGeneticAlgorithm.Individual ind = pending.get(start + i);
                    EvaluationResult eval = batchResults.get(i);
                    ind.fitness = eval.fitness();
                    ind.evaluated = true;

                    if (isStrictlyBetter(eval, bestEval)) {
                        bestEval = eval;
                        improvedInGen = true;
                    }

                    // Stop immediately if 100% of pieces are placed and theoretical lower bound is achieved
                    if (reachedTheoreticalBound(bestEval, n, theoreticalMinY)) {
                        break outerSearch;
                    }
                }
            }

            if (n <= 1 || System.nanoTime() >= stage1Deadline) {
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

        // ==================== 阶段 2：LNS 大邻域精修（Ruin-and-Recreate） ====================
        if (n >= LNS_MIN_PIECES
                && !reachedTheoreticalBound(bestEval, n, theoreticalMinY)
                && System.nanoTime() < stage2Deadline) {
            bestEval = runLnsRefinement(ctx, bestEval, theoreticalMinY, seed, stage2Deadline);
        }

        // ==================== 阶段 3：微滑 + 联动压紧 + 独立终检 ====================
        ComputationCancellation.check();
        List<Placement> incumbentPlacements = toPlacements(bestEval.placed());
        List<Placement> finalPlacements = incumbentPlacements;

        if (bestEval.placed().size() >= 2
                && !reachedTheoreticalBound(bestEval, n, theoreticalMinY)
                && System.nanoTime() < stage3Deadline) {
            long remainingStage3 = stage3Deadline - System.nanoTime();
            long polishDeadline = System.nanoTime() + Math.min(120_000_000L, Math.max(25_000_000L, remainingStage3 / 4));
            List<PlacedInstance> polished = polishPlacements(ctx, bestEval.placed(), polishDeadline);
            finalPlacements = toPlacements(polished);

            if (!ctx.preferBottom
                    && ctx.pipeline.isNoop()
                    && finalPlacements.size() <= MarkerCompactor.MAX_COMPACT_PIECES
                    && System.nanoTime() < stage3Deadline) {
                finalPlacements = runLinkedCompaction(problem, finalPlacements, stage3Deadline);
            }
        }

        ComputationCancellation.check();
        out.setSuccess(true);
        out.setPlacements(finalPlacements);
        if (PolygonResultValidator.validate(problem, out) != null) {
            out.setPlacements(incumbentPlacements);
        }
        return out;
    }

    private static boolean reachedTheoreticalBound(EvaluationResult eval, int totalPieces, double theoreticalMinY) {
        return eval != null && eval.placed().size() == totalPieces && eval.extentY() <= theoreticalMinY + 0.2;
    }

    private static boolean isStrictlyBetter(EvaluationResult cand, EvaluationResult incumbent) {
        if (cand == null) return false;
        if (incumbent == null) return true;
        if (cand.placed().size() != incumbent.placed().size()) {
            return cand.placed().size() > incumbent.placed().size();
        }
        if (Math.abs(cand.placedArea() - incumbent.placedArea()) > 1e-4) {
            return cand.placedArea() > incumbent.placedArea();
        }
        return cand.fitness() < incumbent.fitness() - 1e-6;
    }

    private static List<Placement> toPlacements(List<PlacedInstance> instances) {
        List<Placement> result = new ArrayList<>(instances.size());
        int seq = 1;
        for (PlacedInstance pi : instances) {
            result.add(new Placement(
                    seq++,
                    pi.ori.demandId(),
                    pi.ori.name(),
                    pi.x,
                    pi.y,
                    pi.ori.shape(),
                    pi.ori.angle()
            ));
        }
        return result;
    }

    private static double placementsExtentY(List<Placement> placements) {
        double maxY = 0.0;
        for (Placement p : placements) {
            maxY = Math.max(maxY, p.y() + p.shape().height());
        }
        return maxY;
    }

    /**
     * 阶段 3 联动压紧：先尝试空隙重插压紧（MarkerCompactor），再串联轴向同步压紧（AxisMarkerCompactor）。
     * 两者内部均支持 pieceGap > 0、带疵点与 200 件上限，并在带不兼容窗帘约束时安全跳过且内置零容忍兜底。
     */
    private static List<Placement> runLinkedCompaction(NestingProblem problem,
                                                       List<Placement> incumbent,
                                                       long deadlineNanos) {
        ComputationCancellation.check();
        List<Placement> current = incumbent;
        double currentExtentY = placementsExtentY(current);

        if (MarkerCompactor.supportsGapSearch(problem)) {
            long now = System.nanoTime();
            long remaining = deadlineNanos - now;
            if (remaining > 5_000_000L) {
                long gapDeadline = now + (long) (remaining * 0.60);
                List<Placement> gapCompacted = MarkerCompactor.compact(problem, current, gapDeadline);
                if (gapCompacted != current && gapCompacted.size() == current.size()) {
                    double newExtentY = placementsExtentY(gapCompacted);
                    if (newExtentY < currentExtentY - 1e-6) {
                        current = gapCompacted;
                        currentExtentY = newExtentY;
                    }
                }
            }
            ComputationCancellation.check();
            if (System.nanoTime() < deadlineNanos) {
                List<Placement> axisCompacted = AxisMarkerCompactor.compact(problem, current, deadlineNanos);
                if (axisCompacted != current && axisCompacted.size() == current.size()) {
                    double newExtentY = placementsExtentY(axisCompacted);
                    if (newExtentY < currentExtentY - 1e-6) {
                        current = axisCompacted;
                    }
                }
            }
        } else if (AxisMarkerCompactor.supports(problem) && System.nanoTime() < deadlineNanos) {
            List<Placement> axisCompacted = AxisMarkerCompactor.compact(problem, current, deadlineNanos);
            if (axisCompacted != current && axisCompacted.size() == current.size()) {
                double newExtentY = placementsExtentY(axisCompacted);
                if (newExtentY < currentExtentY - 1e-6) {
                    current = axisCompacted;
                }
            }
        }

        return current;
    }

    /**
     * 阶段 2：确定性 LNS 大邻域精修（Ruin-and-Recreate）。
     * 围绕当前最优解轮换执行多种破坏策略（高 Y 末端、空间邻域、确定性随机子集），
     * 保持其余件不动并用精确 NFP + ConstraintPipeline 按多种启发序与全允许角度重新插回。
     */
    private static EvaluationResult runLnsRefinement(ProblemContext ctx,
                                                     EvaluationResult incumbent,
                                                     double theoreticalMinY,
                                                     long seed,
                                                     long deadlineNanos) {
        int n = ctx.items.size();
        SplittableRandom rng = new SplittableRandom(seed ^ 0x517CC1B727220A95L);
        EvaluationResult best = incumbent;
        int maxRounds = Math.min(28, Math.max(8, n * 2));
        int maxStagnant = n <= 12 ? 6 : 8;
        int stagnant = 0;

        for (int round = 0; round < maxRounds; round++) {
            ComputationCancellation.check();
            if (System.nanoTime() >= deadlineNanos
                    || reachedTheoreticalBound(best, n, theoreticalMinY)
                    || stagnant >= maxStagnant) {
                break;
            }

            List<PlacedInstance> currentPlaced = best.placed();
            int placedCount = currentPlaced.size();
            if (placedCount < LNS_MIN_RUIN) {
                break;
            }

            int minRuin = Math.min(LNS_MIN_RUIN, placedCount);
            int maxRuin = Math.min(LNS_MAX_RUIN, Math.max(minRuin, (int) Math.ceil(n * 0.30)));
            double ratio = 0.15 + 0.15 * rng.nextDouble();
            int ruinCount = Math.max(minRuin, Math.min(maxRuin, (int) Math.round(n * ratio)));
            ruinCount = Math.min(ruinCount, placedCount);

            Set<Integer> ruinInstanceIds = selectRuinTargets(ctx, currentPlaced, ruinCount, round % 3, rng);
            if (ruinInstanceIds.isEmpty()) {
                stagnant++;
                continue;
            }

            List<PlacedInstance> kept = new ArrayList<>(placedCount - ruinInstanceIds.size());
            List<ExpandedPart> removedParts = new ArrayList<>(ruinInstanceIds.size() + (n - placedCount));
            Set<Integer> placedIds = new HashSet<>(placedCount * 2);
            for (PlacedInstance pi : currentPlaced) {
                placedIds.add(pi.instanceId);
                if (ruinInstanceIds.contains(pi.instanceId)) {
                    removedParts.add(ctx.items.get(pi.instanceId));
                } else {
                    kept.add(pi);
                }
            }
            // 若当前解存在未放置裁片，也一并纳入重建池尝试救回
            if (placedCount < n) {
                for (ExpandedPart ep : ctx.items) {
                    if (!placedIds.contains(ep.instanceId)) {
                        removedParts.add(ep);
                    }
                }
            }

            // 预计算 kept 集合的基础状态与 NFP 增量缓存（同一轮 Ruin 的多种 Recreate 序共享）
            Map<NfpInnerKey, Geometry> keptNfpCache = new HashMap<>();
            List<List<ExpandedPart>> recreateOrders = buildRecreateOrders(removedParts);
            DeepnestGeneticAlgorithm.PlacementMode recreateMode = (round % 4 == 3)
                    ? DeepnestGeneticAlgorithm.PlacementMode.TIGHT_CORNER
                    : DeepnestGeneticAlgorithm.PlacementMode.GRAVITY_Y;

            boolean improvedRound = false;
            for (List<ExpandedPart> order : recreateOrders) {
                ComputationCancellation.check();
                if (System.nanoTime() >= deadlineNanos) {
                    break;
                }
                EvaluationResult candidate = recreateFromPartial(
                        ctx, kept, order, keptNfpCache, recreateMode, best, deadlineNanos);
                if (isStrictlyBetter(candidate, best)) {
                    best = candidate;
                    improvedRound = true;
                    break;
                }
            }

            if (improvedRound) {
                stagnant = 0;
            } else {
                stagnant++;
            }
        }

        return best;
    }

    private static Set<Integer> selectRuinTargets(ProblemContext ctx,
                                                  List<PlacedInstance> placed,
                                                  int ruinCount,
                                                  int strategy,
                                                  SplittableRandom rng) {
        int m = placed.size();
        Set<Integer> selected = new HashSet<>(ruinCount * 2);
        List<PlacedInstance> byTail = new ArrayList<>(placed);
        byTail.sort(Comparator
                .comparingDouble((PlacedInstance p) -> ctx.preferBottom ? p.minY : -p.maxY)
                .thenComparingInt(p -> p.instanceId));

        if (strategy == 0) {
            // 策略 0：高 Y 末端裁片破坏（直接松动版长瓶颈）
            int window = Math.min(m, ruinCount + Math.min(3, Math.max(1, ruinCount / 2)));
            List<PlacedInstance> pool = new ArrayList<>(byTail.subList(0, window));
            // 始终包含最末端 1 件，其余在末端窗口中确定性抽样避免重复陷入同一子集
            selected.add(pool.remove(0).instanceId);
            while (selected.size() < ruinCount && !pool.isEmpty()) {
                int pick = rng.nextInt(pool.size());
                selected.add(pool.remove(pick).instanceId);
            }
        } else if (strategy == 1) {
            // 策略 1：空间邻域破坏（围绕末端区域种子件拔出连续空洞）
            int anchorPoolSize = Math.max(1, (int) Math.ceil(m * 0.45));
            PlacedInstance anchor = byTail.get(rng.nextInt(anchorPoolSize));
            double ax = (anchor.minX + anchor.maxX) * 0.5;
            double ay = (anchor.minY + anchor.maxY) * 0.5;
            List<PlacedInstance> byDist = new ArrayList<>(placed);
            byDist.sort(Comparator
                    .comparingDouble((PlacedInstance p) -> {
                        double dx = (p.minX + p.maxX) * 0.5 - ax;
                        double dy = (p.minY + p.maxY) * 0.5 - ay;
                        return dx * dx + dy * dy;
                    })
                    .thenComparingInt(p -> p.instanceId));
            for (int i = 0; i < ruinCount && i < byDist.size(); i++) {
                selected.add(byDist.get(i).instanceId);
            }
        } else {
            // 策略 2：确定性随机子集破坏（跳出局部最优）
            List<PlacedInstance> shuffled = new ArrayList<>(placed);
            for (int i = 0; i < ruinCount && i < m; i++) {
                int j = i + rng.nextInt(m - i);
                PlacedInstance tmp = shuffled.get(i);
                shuffled.set(i, shuffled.get(j));
                shuffled.set(j, tmp);
                selected.add(shuffled.get(i).instanceId);
            }
        }
        return selected;
    }

    private static List<List<ExpandedPart>> buildRecreateOrders(List<ExpandedPart> removed) {
        List<List<ExpandedPart>> orders = new ArrayList<>(4);

        // 1. 面积降序
        List<ExpandedPart> byArea = new ArrayList<>(removed);
        byArea.sort(Comparator.comparingDouble((ExpandedPart ep) -> ep.area).reversed()
                .thenComparingInt(ep -> ep.instanceId));
        orders.add(byArea);

        // 2. 高度降序
        List<ExpandedPart> byHeight = new ArrayList<>(removed);
        byHeight.sort(Comparator.comparingDouble(ExpandedPart::primaryHeight).reversed()
                .thenComparing(Comparator.comparingDouble((ExpandedPart ep) -> ep.area).reversed())
                .thenComparingInt(ep -> ep.instanceId));
        orders.add(byHeight);

        // 3. 宽度降序
        List<ExpandedPart> byWidth = new ArrayList<>(removed);
        byWidth.sort(Comparator.comparingDouble(ExpandedPart::primaryWidth).reversed()
                .thenComparing(Comparator.comparingDouble((ExpandedPart ep) -> ep.area).reversed())
                .thenComparingInt(ep -> ep.instanceId));
        orders.add(byWidth);

        // 4. 原逆序（优先重排末端件）
        List<ExpandedPart> reversed = new ArrayList<>(removed.size());
        for (int i = removed.size() - 1; i >= 0; i--) {
            reversed.add(removed.get(i));
        }
        orders.add(reversed);

        return orders;
    }

    private static EvaluationResult recreateFromPartial(ProblemContext ctx,
                                                        List<PlacedInstance> kept,
                                                        List<ExpandedPart> toReinsert,
                                                        Map<NfpInnerKey, Geometry> keptNfpCache,
                                                        DeepnestGeneticAlgorithm.PlacementMode mode,
                                                        EvaluationResult incumbent,
                                                        long deadlineNanos) {
        int totalCapacity = kept.size() + toReinsert.size();
        List<PlacedInstance> placed = new ArrayList<>(totalCapacity);
        List<List<Point>> placedWorldPolys = new ArrayList<>(totalCapacity);
        PlacedBvhTracker placedBvh = new PlacedBvhTracker(totalCapacity);

        double currentMaxX = 0.0;
        double currentMinX = ctx.matW;
        double currentMaxY = 0.0;
        double currentMinY = ctx.matH;
        double placedArea = 0.0;
        double totalMergedLength = 0.0;
        double totalSoftPenalty = 0.0;

        for (PlacedInstance pi : kept) {
            placed.add(pi);
            placedWorldPolys.add(pi.worldVertices);
            placedBvh.add(pi);
            placedArea += pi.ori.area();
            if (pi.minX < currentMinX) currentMinX = pi.minX;
            if (pi.maxX > currentMaxX) currentMaxX = pi.maxX;
            if (pi.minY < currentMinY) currentMinY = pi.minY;
            if (pi.maxY > currentMaxY) currentMaxY = pi.maxY;
            if (!ctx.pipeline.isNoop()) {
                totalSoftPenalty += ctx.pipeline.penalty(
                        ctx.problem, ctx.partById.get(pi.ori.demandId()),
                        pi.x, pi.y, pi.ori.angle(), pi.ori.shape());
            }
        }

        boolean incumbentComplete = incumbent.placed().size() == ctx.items.size();
        int keptSize = kept.size();
        Map<NfpInnerKey, ClipCacheEntry> clipCache = new HashMap<>();

        for (ExpandedPart item : toReinsert) {
            ComputationCancellation.check();
            if (System.nanoTime() >= deadlineNanos) {
                return null;
            }

            ChosenSpot bestSpot = null;
            for (int angle : item.allowedAngles) {
                ComputationCancellation.check();
                OrientedPart ori = item.byAngle.get(angle);

                // 利用 keptNfpCache 复用 kept 集合的联合 OuterNFP，避免同一轮多启发序重复做布尔并集
                if (keptSize > 0) {
                    NfpInnerKey key = new NfpInnerKey(ori.demandId(), ori.angle());
                    if (!clipCache.containsKey(key)) {
                        Geometry baseCombined = keptNfpCache.get(key);
                        if (baseCombined == null) {
                            List<Geometry> keptGeoms = new ArrayList<>(keptSize);
                            for (int j = 0; j < keptSize; j++) {
                                ComputationCancellation.check();
                                PlacedInstance p = kept.get(j);
                                Geometry outer = ctx.getOuterNfp(p.ori, ori);
                                if (!outer.isEmpty()) {
                                    keptGeoms.add(DeepnestNfpGeometry.translateGeometry(outer, p.x, p.y));
                                }
                            }
                            baseCombined = DeepnestNfpGeometry.unionGeometries(keptGeoms);
                            keptNfpCache.put(key, baseCombined);
                        }
                        ClipCacheEntry entry = new ClipCacheEntry();
                        entry.combinedNfp = baseCombined;
                        entry.nextPlacedIndex = keptSize;
                        clipCache.put(key, entry);
                    }
                }

                ChosenSpot candidate = findBestSpotForOrientation(
                        ctx, ori, mode, placed, placedWorldPolys, placedBvh, clipCache,
                        currentMinX, currentMaxX, currentMinY, currentMaxY, LNS_CANDIDATES_TO_VALIDATE
                );
                if (candidate != null && (bestSpot == null || candidate.score() < bestSpot.score())) {
                    bestSpot = candidate;
                }
            }

            if (bestSpot == null) {
                if (incumbentComplete) {
                    return null;
                }
                continue;
            }

            PlacedInstance pi = new PlacedInstance(item.instanceId, bestSpot.ori(), bestSpot.x(), bestSpot.y());
            placed.add(pi);
            placedWorldPolys.add(pi.worldVertices);
            placedBvh.add(pi);
            placedArea += bestSpot.ori().area();
            totalMergedLength += bestSpot.mergedLen();
            if (!ctx.pipeline.isNoop()) {
                totalSoftPenalty += ctx.pipeline.penalty(
                        ctx.problem, ctx.partById.get(item.demandId),
                        bestSpot.x(), bestSpot.y(), bestSpot.ori().angle(), bestSpot.ori().shape());
            }

            if (pi.minX < currentMinX) currentMinX = pi.minX;
            if (pi.maxX > currentMaxX) currentMaxX = pi.maxX;
            if (pi.minY < currentMinY) currentMinY = pi.minY;
            if (pi.maxY > currentMaxY) currentMaxY = pi.maxY;

            // 早剪枝：若原解已全放置且无软惩罚权衡，当前延伸 Y 已严格超出原最优则无需继续
            if (incumbentComplete && ctx.pipeline.isNoop()) {
                double curExtentY = ctx.preferBottom ? (ctx.matH - currentMinY) : currentMaxY;
                if (curExtentY > incumbent.extentY() + 1e-3) {
                    return null;
                }
            }
        }

        double extentY = placed.isEmpty() ? ctx.matH : (ctx.preferBottom ? (ctx.matH - currentMinY) : currentMaxY);
        double extentX = placed.isEmpty() ? ctx.matW : (ctx.preferRight ? (ctx.matW - currentMinX) : currentMaxX);
        double unplacedArea = Math.max(0.0, ctx.totalRequestedArea - placedArea);
        int unplacedCount = ctx.items.size() - placed.size();

        double fitness = 1e12 * (unplacedArea / ctx.sheetArea)
                + 1e8 * unplacedCount
                + extentY * 1000.0
                + totalSoftPenalty * 1000.0
                + extentX
                - totalMergedLength * 0.5;

        return new EvaluationResult(placed, placedArea, extentY, fitness);
    }

    private static final class PlacedBvhTracker {
        private final double[] minX;
        private final double[] minY;
        private final double[] maxX;
        private final double[] maxY;
        private int count;
        private AabbBvh cachedBvh = AabbBvh.EMPTY;
        private boolean dirty;

        PlacedBvhTracker(int capacity) {
            this.minX = new double[capacity];
            this.minY = new double[capacity];
            this.maxX = new double[capacity];
            this.maxY = new double[capacity];
        }

        void add(PlacedInstance pi) {
            minX[count] = pi.minX;
            minY[count] = pi.minY;
            maxX[count] = pi.maxX;
            maxY[count] = pi.maxY;
            count++;
            dirty = true;
        }

        void set(int idx, PlacedInstance pi) {
            minX[idx] = pi.minX;
            minY[idx] = pi.minY;
            maxX[idx] = pi.maxX;
            maxY[idx] = pi.maxY;
            dirty = true;
        }

        AabbBvh get() {
            if (count <= AabbBvh.LINEAR_THRESHOLD) {
                return null;
            }
            if (dirty) {
                cachedBvh = AabbBvh.build(minX, minY, maxX, maxY, count);
                dirty = false;
            }
            return cachedBvh;
        }
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
        PlacedBvhTracker placedBvh = new PlacedBvhTracker(ind.order.length);
        Map<NfpInnerKey, ClipCacheEntry> clipCache = new HashMap<>();

        double currentMaxX = 0.0;
        double currentMinX = ctx.matW;
        double currentMaxY = 0.0;
        double currentMinY = ctx.matH;
        double placedArea = 0.0;
        double totalMergedLength = 0.0;
        double totalSoftPenalty = 0.0;

        for (int step = 0; step < ind.order.length; step++) {
            ComputationCancellation.check();
            if (hasIncumbent && step > 0 && System.nanoTime() >= deadlineNanos) {
                break;
            }

            ExpandedPart item = ctx.items.get(ind.order[step]);
            int preferredAngle = ind.rotations[step];

            ChosenSpot bestSpot = null;
            int candidateLimit = ctx.items.size() >= 12 ? LARGE_SET_CANDIDATES_TO_VALIDATE : TOP_CANDIDATES_TO_VALIDATE;

            if (ind.greedyAngles || placed.isEmpty()) {
                // Evaluate all allowed rotations and record the best angle back into chromosome
                for (int angle : item.allowedAngles) {
                    ComputationCancellation.check();
                    OrientedPart ori = item.byAngle.get(angle);
                    ChosenSpot candidate = findBestSpotForOrientation(
                            ctx, ori, ind.placementMode, placed, placedWorldPolys, placedBvh, clipCache,
                            currentMinX, currentMaxX, currentMinY, currentMaxY, candidateLimit
                    );
                    if (candidate != null && (bestSpot == null || candidate.score() < bestSpot.score())) {
                        bestSpot = candidate;
                    }
                }
            } else {
                // Evaluate chromosome's evolved rotation first
                OrientedPart prefOri = item.byAngle.getOrDefault(preferredAngle, item.primary);
                bestSpot = findBestSpotForOrientation(
                        ctx, prefOri, ind.placementMode, placed, placedWorldPolys, placedBvh, clipCache,
                        currentMinX, currentMaxX, currentMinY, currentMaxY, candidateLimit
                );
                // Fallback to other allowed rotations if preferred orientation cannot fit on remaining sheet
                if (bestSpot == null && item.allowedAngles.size() > 1) {
                    for (int angle : item.allowedAngles) {
                        if (angle == prefOri.angle()) continue;
                        ComputationCancellation.check();
                        OrientedPart altOri = item.byAngle.get(angle);
                        ChosenSpot candidate = findBestSpotForOrientation(
                                ctx, altOri, ind.placementMode, placed, placedWorldPolys, placedBvh, clipCache,
                                currentMinX, currentMaxX, currentMinY, currentMaxY, candidateLimit
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
                placedBvh.add(pi);
                placedArea += bestSpot.ori().area();
                totalMergedLength += bestSpot.mergedLen();
                if (!ctx.pipeline.isNoop()) {
                    totalSoftPenalty += ctx.pipeline.penalty(
                            ctx.problem, ctx.partById.get(item.demandId),
                            bestSpot.x(), bestSpot.y(), bestSpot.ori().angle(), bestSpot.ori().shape());
                }

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
                + totalSoftPenalty * 1000.0
                + extentX
                - totalMergedLength * 0.5;

        return new EvaluationResult(placed, placedArea, extentY, fitness);
    }

    private static ChosenSpot findBestSpotForOrientation(ProblemContext ctx,
                                                         OrientedPart ori,
                                                         DeepnestGeneticAlgorithm.PlacementMode mode,
                                                         List<PlacedInstance> placed,
                                                         List<List<Point>> placedWorldPolys,
                                                         PlacedBvhTracker placedBvhTracker,
                                                         Map<NfpInnerKey, ClipCacheEntry> clipCache,
                                                         double currentMinX, double currentMaxX,
                                                         double currentMinY, double currentMaxY,
                                                         int maxCandidatesToValidate) {
        Geometry sheetNfp = ctx.getInnerNfp(ori);
        if (sheetNfp.isEmpty()) return null;

        double minValidX = ctx.minValidX(ori.demandId());
        double maxValidXEdge = ctx.maxValidXEdge(ori.demandId());
        if (maxValidXEdge - ori.width() < minValidX - 1e-6) return null;
        double maxValidX = Math.max(minValidX, maxValidXEdge - ori.width());
        double maxValidY = Math.max(0.0, ctx.matH - ori.height());
        Part part = ctx.pipeline.isNoop() ? null : ctx.partById.get(ori.demandId());

        if (placed.isEmpty()) {
            // First part on the sheet: place at extremal corner of sheetNfp (background.js:887-906)
            List<DeepnestNfpGeometry.Ring> rings = DeepnestNfpGeometry.extractRings(sheetNfp);
            List<Point> rawPts = new ArrayList<>();
            rawPts.add(new Point(ctx.preferRight ? maxValidX : minValidX, ctx.preferBottom ? maxValidY : 0.0));
            for (DeepnestNfpGeometry.Ring ring : rings) {
                rawPts.addAll(ring.vertices());
            }
            if (!ctx.pipeline.isNoop() && part != null && part.isAuxiliary()
                    && ctx.hardObstaclesFor(ori.demandId()).size() < ctx.exclusions.size()) {
                for (ExclusionObstacle obs : ctx.exclusions) {
                    rawPts.add(new Point(obs.maxX, 0.0));
                    rawPts.add(new Point(minValidX, obs.maxY));
                }
            }

            ChosenSpot bestFirst = null;
            for (Point pt : rawPts) {
                ComputationCancellation.check();
                double cx = snapCoord(pt.x(), minValidX, maxValidX);
                double cy = snapCoord(pt.y(), 0.0, maxValidY);
                if (!ctx.pipeline.isNoop() && part != null) {
                    cy = ctx.pipeline.snapY(ctx.problem, part, ori.angle(), cy);
                    if (cy > maxValidY + 1e-6) continue;
                }
                double primaryY = ctx.preferBottom ? (ctx.matH - cy) : (cy + ori.height());
                double secondaryX = ctx.preferRight ? (ctx.matW - cx) : (cx + ori.width());
                double score = mode == DeepnestGeneticAlgorithm.PlacementMode.GRAVITY_X
                        ? (secondaryX * ctx.gravityWeight + primaryY)
                        : (primaryY * ctx.gravityWeight + secondaryX);
                if (!ctx.pipeline.isNoop() && part != null) {
                    score += ctx.pipeline.penalty(ctx.problem, part, cx, cy, ori.angle(), ori.shape()) * ctx.gravityWeight;
                }
                if (bestFirst != null && score >= bestFirst.score() - 1e-9) continue;
                if (isPlacementValid(ctx, cx, cy, ori, placed, null, -1)) {
                    bestFirst = new ChosenSpot(cx, cy, ori, score, 0.0);
                }
            }
            return bestFirst;
        }

        // Incremental union of OuterNFPs via clipCache (JTS UnaryUnionOp + OverlayNG difference)
        NfpInnerKey cacheKey = new NfpInnerKey(ori.demandId(), ori.angle());
        ClipCacheEntry entry = clipCache.computeIfAbsent(cacheKey, k -> new ClipCacheEntry());
        if (entry.nextPlacedIndex < placed.size()) {
            List<Geometry> deltaGeoms = new ArrayList<>(placed.size() - entry.nextPlacedIndex + 1);
            if (!entry.combinedNfp.isEmpty()) {
                deltaGeoms.add(entry.combinedNfp);
            }
            for (int j = entry.nextPlacedIndex; j < placed.size(); j++) {
                ComputationCancellation.check();
                PlacedInstance p = placed.get(j);
                Geometry outer = ctx.getOuterNfp(p.ori, ori);
                if (!outer.isEmpty()) {
                    deltaGeoms.add(DeepnestNfpGeometry.translateGeometry(outer, p.x, p.y));
                }
            }
            entry.combinedNfp = DeepnestNfpGeometry.unionGeometries(deltaGeoms);
            entry.nextPlacedIndex = placed.size();
        }

        Geometry finalNfp = entry.combinedNfp.isEmpty()
                ? sheetNfp
                : DeepnestNfpGeometry.differenceGeometry(sheetNfp, entry.combinedNfp);
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

        if (!ctx.pipeline.isNoop() && part != null && part.isAuxiliary()
                && ctx.hardObstaclesFor(ori.demandId()).size() < ctx.exclusions.size()) {
            for (ExclusionObstacle obs : ctx.exclusions) {
                addScoredCandidate(ctx, ori, mode, obs.maxX, 0.0, maxValidX, maxValidY,
                        currentMinX, currentMaxX, currentMinY, currentMaxY, candidates);
                addScoredCandidate(ctx, ori, mode, minValidX, obs.maxY, maxValidX, maxValidY,
                        currentMinX, currentMaxX, currentMinY, currentMaxY, candidates);
                addScoredCandidate(ctx, ori, mode, obs.maxX, currentMinY, maxValidX, maxValidY,
                        currentMinX, currentMaxX, currentMinY, currentMaxY, candidates);
                addScoredCandidate(ctx, ori, mode, minValidX, currentMaxY, maxValidX, maxValidY,
                        currentMinX, currentMaxX, currentMinY, currentMaxY, candidates);
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

        AabbBvh placedBvh = placedBvhTracker.get();
        List<List<Point>> nearbyScratch = (checkMerged && placedBvh != null) ? new ArrayList<>(16) : null;
        double maxPossibleBonus = checkMerged ? (ori.width() + ori.height()) * 2.0 * mergeWeight : 0.0;

        int stoppedAt = candidates.size();
        boolean truncatedByLimit = false;

        for (int idx = 0; idx < candidates.size(); idx++) {
            CandidatePoint cp = candidates.get(idx);
            ComputationCancellation.check();
            if (Math.abs(cp.x() - lastX) < 1e-4 && Math.abs(cp.y() - lastY) < 1e-4) {
                continue;
            }
            lastX = cp.x();
            lastY = cp.y();

            if (best != null && cp.baseScore() - maxPossibleBonus >= best.score()) {
                break;
            }

            if (isPlacementValid(ctx, cp.x(), cp.y(), ori, placed, placedBvh, -1)) {
                best = updateBestSpot(best, cp, ori, checkMerged, mergeWeight, placedBvh, placedWorldPolys, nearbyScratch);
                checked++;
                if (checked >= maxCandidatesToValidate) {
                    stoppedAt = idx + 1;
                    truncatedByLimit = true;
                    break;
                }
            } else {
                checked++;
                if (checked >= maxCandidatesToValidate * 2 && best != null) {
                    stoppedAt = idx + 1;
                    truncatedByLimit = true;
                    break;
                }
            }
        }

        // 分层补检：若因候选点上限截断且尚未到达数学剪枝下界，从剩余候选中补检低 Y / 边界贴合代表点
        if (truncatedByLimit && stoppedAt < candidates.size()) {
            double bestExtentY = best != null
                    ? (ctx.preferBottom ? Math.max(ctx.matH - currentMinY, ctx.matH - best.y())
                                        : Math.max(currentMaxY, best.y() + ori.height()))
                    : Double.POSITIVE_INFINITY;
            int extraChecked = 0;
            double prevExtraX = Double.NaN, prevExtraY = Double.NaN;
            for (int idx = stoppedAt; idx < candidates.size() && extraChecked < STRATIFIED_EXTRA_CANDIDATES; idx++) {
                CandidatePoint cp = candidates.get(idx);
                ComputationCancellation.check();
                if (best != null && cp.baseScore() - maxPossibleBonus >= best.score()) {
                    break;
                }
                if (Math.abs(cp.x() - prevExtraX) < 1e-3 && Math.abs(cp.y() - prevExtraY) < 1e-3) {
                    continue;
                }
                boolean boundaryFlush = cp.x() <= minValidX + 1e-3 || cp.x() >= maxValidX - 1e-3;
                boolean lowerOrEqualY = cp.newExtentY() <= bestExtentY + 1e-3;
                if (!lowerOrEqualY && !boundaryFlush) {
                    continue;
                }
                prevExtraX = cp.x();
                prevExtraY = cp.y();
                extraChecked++;
                if (isPlacementValid(ctx, cp.x(), cp.y(), ori, placed, placedBvh, -1)) {
                    best = updateBestSpot(best, cp, ori, checkMerged, mergeWeight, placedBvh, placedWorldPolys, nearbyScratch);
                    bestExtentY = ctx.preferBottom
                            ? Math.max(ctx.matH - currentMinY, ctx.matH - best.y())
                            : Math.max(currentMaxY, best.y() + ori.height());
                }
            }
        }

        return best;
    }

    private static ChosenSpot updateBestSpot(ChosenSpot best,
                                             CandidatePoint cp,
                                             OrientedPart ori,
                                             boolean checkMerged,
                                             double mergeWeight,
                                             AabbBvh placedBvh,
                                             List<List<Point>> placedWorldPolys,
                                             List<List<Point>> nearbyScratch) {
        double merged;
        if (!checkMerged) {
            merged = 0.0;
        } else if (placedBvh != null) {
            nearbyScratch.clear();
            placedBvh.queryExpanded(cp.x(), cp.y(), cp.x() + ori.width(), cp.y() + ori.height(), 0.05,
                    idx -> nearbyScratch.add(placedWorldPolys.get(idx)));
            merged = nearbyScratch.isEmpty()
                    ? 0.0
                    : DeepnestNfpGeometry.mergedLength(nearbyScratch, ori.vertices(), cp.x(), cp.y(), 10.0, 0.05);
        } else {
            merged = DeepnestNfpGeometry.mergedLength(placedWorldPolys, ori.vertices(), cp.x(), cp.y(), 10.0, 0.05);
        }
        double totalScore = cp.baseScore() - merged * mergeWeight;
        if (best == null || totalScore < best.score()) {
            return new ChosenSpot(cp.x(), cp.y(), ori, totalScore, merged);
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
        double minValidX = ctx.minValidX(ori.demandId());
        if (rawX < minValidX - 0.05 || rawX > maxValidX + 0.05 || rawY < -0.05 || rawY > maxValidY + 0.05) return;

        double cx = snapCoord(rawX, minValidX, maxValidX);
        double cy = snapCoord(rawY, 0.0, maxValidY);
        double softPenalty = 0.0;
        if (!ctx.pipeline.isNoop()) {
            Part part = ctx.partById.get(ori.demandId());
            cy = ctx.pipeline.snapY(ctx.problem, part, ori.angle(), cy);
            if (cy > maxValidY + 1e-6) return;
            softPenalty = ctx.pipeline.penalty(ctx.problem, part, cx, cy, ori.angle(), ori.shape());
        }

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
        if (softPenalty > 0.0) {
            baseScore += softPenalty * ctx.gravityWeight;
        }

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

        PlacedBvhTracker workBvh = new PlacedBvhTracker(work.size());
        for (PlacedInstance pi : work) {
            workBvh.add(pi);
        }

        // Sort indices so upstream pieces (closer to startCorner) settle first, then downstream pieces slide into them
        List<Integer> order = new ArrayList<>(work.size());
        for (int i = 0; i < work.size(); i++) order.add(i);
        order.sort(Comparator.comparingDouble(i -> ctx.preferBottom ? -work.get(i).maxY : work.get(i).minY));

        for (int idx : order) {
            if (System.nanoTime() >= deadlineNanos) break;
            ComputationCancellation.check();
            PlacedInstance current = work.get(idx);
            double minValidX = ctx.minValidX(current.ori.demandId());
            double maxValidX = Math.max(minValidX, ctx.maxValidXEdge(current.ori.demandId()) - current.ori.width());
            double maxValidY = Math.max(0.0, ctx.matH - current.ori.height());
            Part part = ctx.pipeline.isNoop() ? null : ctx.partById.get(current.ori.demandId());
            boolean lockYForPattern = !ctx.pipeline.isNoop() && PatternRepeatRule.requiresPatternMatch(ctx.problem, part);
            double curPenalty = ctx.pipeline.isNoop() ? 0.0
                    : ctx.pipeline.penalty(ctx.problem, part, current.x, current.y, current.ori.angle(), current.ori.shape());

            AabbBvh currentBvh = workBvh.get();

            double bestX = current.x;
            double bestY = current.y;
            boolean moved = false;

            for (double step : steps) {
                if (System.nanoTime() >= deadlineNanos) break;
                // Slide along primary feed axis (-Y or +Y)
                if (!lockYForPattern) {
                    while (true) {
                        ComputationCancellation.check();
                        double ny = snapCoord(bestY + dirY * step, 0.0, maxValidY);
                        if (Math.abs(ny - bestY) < 1e-6) break;
                        if (isPlacementValid(ctx, bestX, ny, current.ori, work, currentBvh, idx)) {
                            if (!ctx.pipeline.isNoop() && ctx.pipeline.penalty(ctx.problem, part, bestX, ny, current.ori.angle(), current.ori.shape()) > curPenalty + 1e-6) {
                                break;
                            }
                            bestY = ny;
                            moved = true;
                        } else {
                            break;
                        }
                    }
                }
                // Slide along cross axis (-X or +X)
                while (true) {
                    ComputationCancellation.check();
                    double nx = snapCoord(bestX + dirX * step, minValidX, maxValidX);
                    if (Math.abs(nx - bestX) < 1e-6) break;
                    if (isPlacementValid(ctx, nx, bestY, current.ori, work, currentBvh, idx)) {
                        if (!ctx.pipeline.isNoop() && ctx.pipeline.penalty(ctx.problem, part, nx, bestY, current.ori.angle(), current.ori.shape()) > curPenalty + 1e-6) {
                            break;
                        }
                        bestX = nx;
                        moved = true;
                    } else {
                        break;
                    }
                }
            }

            if (moved) {
                PlacedInstance updated = new PlacedInstance(current.instanceId, current.ori, bestX, bestY);
                work.set(idx, updated);
                workBvh.set(idx, updated);
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
                                            List<PlacedInstance> placedList,
                                            AabbBvh placedBvh,
                                            int skipIndex) {
        double w = ori.width();
        double h = ori.height();
        double minValidX = ctx.minValidX(ori.demandId());
        double maxValidXEdge = ctx.maxValidXEdge(ori.demandId());
        if (x < minValidX - 1e-7 || y < -1e-7 || x + w > maxValidXEdge + 1e-6 || y + h > ctx.matH + 1e-6) {
            return false;
        }
        if (!ctx.pipeline.isNoop()) {
            Part part = ctx.partById.get(ori.demandId());
            if (!PatternRepeatRule.isAligned(ctx.problem, part, y)) {
                return false;
            }
        }

        Area[] candAreaRef = new Area[1];

        if (!ctx.isRectMat) {
            candAreaRef[0] = PolygonGeometry.region(ori.shape(), x, y);
            if (!ContourGeometrySupport.isWithinMaterial(candAreaRef[0], ctx.matArea, VALIDATOR_AREA_TOL)) {
                return false;
            }
        }

        List<ExclusionObstacle> hardObstacles = ctx.hardObstaclesFor(ori.demandId());
        AabbBvh obstacleBvh = ctx.hardObstacleBvhFor(ori.demandId());
        if (obstacleBvh != null && !obstacleBvh.isEmpty()) {
            if (obstacleBvh.queryAnyExpanded(x, y, x + w, y + h, 1e-6, idx -> {
                ComputationCancellation.check();
                ExclusionObstacle exc = hardObstacles.get(idx);
                if (candAreaRef[0] == null) {
                    candAreaRef[0] = PolygonGeometry.region(ori.shape(), x, y);
                }
                return ContourGeometrySupport.overlapsArea(candAreaRef[0], exc.worldArea, VALIDATOR_AREA_TOL);
            })) {
                return false;
            }
        } else {
            for (ExclusionObstacle exc : hardObstacles) {
                ComputationCancellation.check();
                if (ContourGeometrySupport.aabbOverlaps(x, x + w, y, y + h, exc.minX, exc.maxX, exc.minY, exc.maxY, 1e-6)) {
                    if (candAreaRef[0] == null) {
                        candAreaRef[0] = PolygonGeometry.region(ori.shape(), x, y);
                    }
                    if (ContourGeometrySupport.overlapsArea(candAreaRef[0], exc.worldArea, VALIDATOR_AREA_TOL)) {
                        return false;
                    }
                }
            }
        }

        double gap = ctx.pieceGap;
        List<Point> cVerts = ori.vertices();
        double margin = gap + 1e-6;

        if (placedBvh != null) {
            return !placedBvh.queryAnyExpanded(x, y, x + w, y + h, margin, idx -> {
                if (idx == skipIndex) {
                    return false;
                }
                ComputationCancellation.check();
                PlacedInstance p = placedList.get(idx);
                if (candAreaRef[0] == null) {
                    candAreaRef[0] = PolygonGeometry.region(ori.shape(), x, y);
                }
                if (ContourGeometrySupport.overlapsArea(candAreaRef[0], p.worldArea, VALIDATOR_AREA_TOL)) {
                    return true;
                }
                return gap > 0 && ContourGeometrySupport.violatesMinEdgeGap(
                        cVerts, x, y, p.worldVertices, 0.0, 0.0, gap, VALIDATOR_GAP_TOL);
            });
        }

        int n = placedList.size();
        for (int i = 0; i < n; i++) {
            if (i == skipIndex) continue;
            ComputationCancellation.check();
            PlacedInstance p = placedList.get(i);
            if (!ContourGeometrySupport.aabbOverlaps(
                    x, x + w, y, y + h, p.minX, p.maxX, p.minY, p.maxY, margin)) {
                continue;
            }

            if (candAreaRef[0] == null) {
                candAreaRef[0] = PolygonGeometry.region(ori.shape(), x, y);
            }
            if (ContourGeometrySupport.overlapsArea(candAreaRef[0], p.worldArea, VALIDATOR_AREA_TOL)) {
                return false;
            }

            if (gap > 0 && ContourGeometrySupport.violatesMinEdgeGap(
                    cVerts, x, y, p.worldVertices, 0.0, 0.0, gap, VALIDATOR_GAP_TOL)) {
                return false;
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
