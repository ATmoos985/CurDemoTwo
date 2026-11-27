package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.EngineGeometry;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.algorithm.nesting.constraints.ConstraintPipeline;
import com.example.cutdemotwo.algorithm.nesting.constraints.CurtainConstraintPack;
import com.example.cutdemotwo.algorithm.nesting.constraints.GrainGroupRule;
import com.example.cutdemotwo.algorithm.nesting.constraints.PatternRepeatRule;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Exclusion;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Part;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import org.locationtech.jts.geom.Geometry;

import java.awt.geom.Area;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Deepnest 求解引擎核心搜索数据模型、NFP 问题上下文、BVH 追踪器与几何合法性守卫。
 */
final class DeepnestSearchModel {
    static final double VALIDATOR_AREA_TOL = EngineGeometry.AREA_EPS_MM2 * 0.5; // Strictly tighter than PolygonResultValidator's 0.001 mm^2
    static final double VALIDATOR_GAP_TOL = EngineGeometry.COORDINATE_EPS_MM * 0.5; // Strictly tighter than PolygonResultValidator's 0.001 mm
    static final int TOP_CANDIDATES_TO_VALIDATE = 28;
    static final int LARGE_SET_CANDIDATES_TO_VALIDATE = 36;
    static final int LNS_CANDIDATES_TO_VALIDATE = 48;
    static final int STRATIFIED_EXTRA_CANDIDATES = 6;
    static final int LNS_MIN_PIECES = 4;
    static final int LNS_MIN_RUIN = 2;
    static final int LNS_MAX_RUIN = 12;

    private DeepnestSearchModel() {}

    record SearchOptions(
            boolean stripMode,
            boolean allowPartition,
            boolean allowParallel,
            long deadlineNanos,
            int popSizeCap,
            int maxGenerations,
            int maxStagnantComplete,
            int maxLnsRounds,
            int maxLnsStagnant
    ) {
        static SearchOptions standard(boolean stripMode, boolean allowPartition) {
            return new SearchOptions(stripMode, allowPartition, true, 0L, 0, 0, 0, 0, 0);
        }
    }

    record OrientedPart(
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

    static final class ExpandedPart implements DeepnestGeneticAlgorithm.PartDescriptor {
        final int instanceId;
        final int demandId;
        final String name;
        final double area;
        final List<Integer> allowedAngles;
        final Map<Integer, OrientedPart> byAngle;
        final OrientedPart primary;
        final String grainGroupId;

        ExpandedPart(int instanceId, int demandId, String name, double area,
                     List<Integer> allowedAngles, Map<Integer, OrientedPart> byAngle, String grainGroupId) {
            this.instanceId = instanceId;
            this.demandId = demandId;
            this.name = name;
            this.area = area;
            this.allowedAngles = allowedAngles;
            this.byAngle = byAngle;
            this.primary = byAngle.get(allowedAngles.get(0));
            this.grainGroupId = grainGroupId;
        }

        @Override public int instanceId() { return instanceId; }
        @Override public int demandId() { return demandId; }
        @Override public double area() { return area; }
        @Override public double primaryHeight() { return primary.height(); }
        @Override public double primaryWidth() { return primary.width(); }
        @Override public List<Integer> allowedAngles() { return allowedAngles; }
        @Override public String grainGroupId() { return grainGroupId; }
    }

    static final class ExclusionObstacle {
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

    static final class PlacedInstance {
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

    static final class ClipCacheEntry {
        Geometry feasibleNfp;
        int nextPlacedIndex = 0;

        ClipCacheEntry(Geometry initialFeasible) {
            this.feasibleNfp = initialFeasible;
        }
    }

    record NfpOuterKey(int aDemand, int aAngle, int bDemand, int bAngle) {}
    record NfpInnerKey(int bDemand, int bAngle) {}

    static final class ProblemContext {
        final NestingProblem problem;
        final ConstraintPipeline pipeline;
        final Shape matShape;
        final Area matArea;
        final boolean isRectMat;
        final boolean hasAnyHoles;
        final boolean pureSelvedgeForCompact;
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
            this.hasAnyHoles = MarkerCompactor.hasAnyHoles(problem);
            this.pureSelvedgeForCompact = CurtainConstraintPack.isPureSelvedgeOnly(problem, true);
            this.isRectMat = "RECTANGLE".equals(matShape.type()) && !matShape.hasHoles();
            this.matW = matShape.width();
            this.matH = matShape.height();
            this.pieceGap = Math.max(Math.max(0.0, problem.process().pieceGap()), Math.max(0.0, problem.process().kerf()));
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
                String grainGroupId = GrainGroupRule.normalizedGroupId(part);
                List<Integer> angles = grainGroupId != null
                        ? GrainGroupRule.allowedAnglesForPart(problem, part)
                        : part.contourAngles();
                if (angles.isEmpty()) {
                    continue;
                }
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
                    ExpandedPart ep = new ExpandedPart(instanceSeq++, part.id(), part.name(), partArea, angles, oriMap, grainGroupId);
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

    record CandidatePoint(double x, double y, double baseScore, double newExtentY) {}
    record ChosenSpot(double x, double y, OrientedPart ori, double score, double mergedLen) {}
    record EvaluationResult(List<PlacedInstance> placed, double placedArea, double extentY, double fitness) {}

    static final class PlacedBvhTracker {
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

    static boolean reachedTheoreticalBound(EvaluationResult eval, int totalPieces, double theoreticalMinY) {
        return eval != null && eval.placed().size() == totalPieces && eval.extentY() <= theoreticalMinY + 0.2;
    }

    static boolean isStrictlyBetter(EvaluationResult cand, EvaluationResult incumbent) {
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

    static List<Placement> toPlacements(List<PlacedInstance> instances) {
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

    static double placementsExtentY(List<Placement> placements) {
        double maxY = 0.0;
        for (Placement p : placements) {
            maxY = Math.max(maxY, p.y() + p.shape().height());
        }
        return maxY;
    }

    static List<Integer> resolveCandidateAngles(ExpandedPart item, Map<String, Integer> lockedGroupAngles) {
        if (item.grainGroupId == null) {
            return item.allowedAngles;
        }
        Integer locked = lockedGroupAngles.get(item.grainGroupId);
        if (locked == null) {
            return item.allowedAngles;
        }
        return item.byAngle.containsKey(locked) ? List.of(locked) : List.of();
    }

    static double snapCoord(double val, double minVal, double maxVal) {
        double clamped = Math.max(minVal, Math.min(maxVal, val));
        double roundedMilli = Math.rint(clamped * 1000.0) / 1000.0;
        if (Math.abs(clamped - roundedMilli) <= 2e-5 && roundedMilli >= minVal && roundedMilli <= maxVal) {
            return roundedMilli;
        }
        return clamped;
    }

    /**
     * Exact feasibility guard matching {@link PolygonResultValidator} rules:
     * material containment, defect exclusion avoidance, non-overlapping area, and {@code pieceGap} segment distance.
     */
    static boolean isPlacementValid(ProblemContext ctx,
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
            if (!PatternRepeatRule.isAligned(ctx.problem, part, ori.angle(), x, y)) {
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
                        ori.shape(), x, y, p.ori.shape(), p.x, p.y, gap, VALIDATOR_GAP_TOL);
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
                    ori.shape(), x, y, p.ori.shape(), p.x, p.y, gap, VALIDATOR_GAP_TOL)) {
                return false;
            }
        }

        return true;
    }
}
