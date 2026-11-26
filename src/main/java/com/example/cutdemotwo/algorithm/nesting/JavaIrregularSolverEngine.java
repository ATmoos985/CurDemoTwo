package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.geometry.EngineGeometry;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;

import com.example.cutdemotwo.contracts.nesting.EngineCapabilities;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
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
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.awt.geom.Area;
import java.util.*;
import java.util.concurrent.Callable;

/**
 * 纯 Java 工业级二维异形与轮廓（Contour/Irregular）排样求解引擎
 * 特性：
 * 1. 严格遵守材料轮廓（含矩形与凹多边形），绝不出界；
 * 2. 100% 严密避让全量禁入区与瑕疵及其安全边距（Clearance）；
 * 3. 严格遵守裁片旋转约束与裁片间最小安全间距（pieceGap）；
 * 4. 基于正交拐角锚点、天际线左上微调挤压与多轮自适应排序启发式，毫秒级快速收敛且高利用率；
 * 5. 100% 通过 PolygonResultValidator 几何校验，为无 C++ 运筹内核环境提供无缝降级平滑自愈。
 */
@Service
public class JavaIrregularSolverEngine implements ICutSolverEngine {
    private static final Logger log = LoggerFactory.getLogger(JavaIrregularSolverEngine.class);
    private static final double EPS = EngineGeometry.COORDINATE_EPS_MM;

    @Override
    public String getEngineType() {
        return "javairregular";
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
                isAvailable()
        );
    }

    private record OrientedShape(Shape shape, double width, double height, Area localArea,
                                 List<Point> vertices, double area, int rotationDegrees) {}

    private static class PartItem {
        final Part part;
        final int demandId;
        final String name;
        final List<OrientedShape> orientations;
        final double maxArea;
        final double minX;
        final double maxX;
        final List<ExclusionRecord> hardExclusions;
        final AabbBvh hardExclusionBvh;
        final boolean patternMatch;
        final boolean patternMatchX;
        final boolean patternMatchY;
        final String grainGroupId;

        PartItem(NestingProblem problem, Part part, double minX, double maxX, List<ExclusionRecord> hardExclusions,
                 boolean patternMatch, boolean patternMatchX, boolean patternMatchY) {
            this.part = part;
            this.demandId = part.id();
            this.name = part.name();
            this.minX = minX;
            this.maxX = maxX;
            this.hardExclusions = hardExclusions;
            this.hardExclusionBvh = buildExclusionBvh(hardExclusions);
            this.patternMatch = patternMatch;
            this.patternMatchX = patternMatchX;
            this.patternMatchY = patternMatchY;
            this.grainGroupId = GrainGroupRule.normalizedGroupId(part);
            List<OrientedShape> list = new ArrayList<>();
            double maxA = 0;
            List<Integer> allowedAngles = this.grainGroupId != null
                    ? GrainGroupRule.allowedAnglesForPart(problem, part)
                    : part.contourAngles();
            for (int angle : allowedAngles) {
                ComputationCancellation.check();
                Shape rotShape = PolygonGeometry.rotate(part.shape(), angle);
                double a = PolygonGeometry.area(rotShape);
                if (a > maxA) maxA = a;
                list.add(new OrientedShape(
                        rotShape,
                        rotShape.width(),
                        rotShape.height(),
                        PolygonGeometry.region(rotShape, 0, 0),
                        PolygonGeometry.vertices(rotShape),
                        a,
                        angle
                ));
            }
            this.orientations = list;
            this.maxArea = maxA;
        }
    }

    private static class PlacedRecord {
        final Placement placement;
        final OrientedShape orientedShape;
        final Area worldArea;
        final double minX, maxX, minY, maxY;

        PlacedRecord(Placement placement, OrientedShape orientedShape, Area worldArea) {
            this.placement = placement;
            this.orientedShape = orientedShape;
            this.worldArea = worldArea;
            this.minX = placement.x();
            this.maxX = placement.x() + orientedShape.width();
            this.minY = placement.y();
            this.maxY = placement.y() + orientedShape.height();
        }
    }

    private static class ExclusionRecord {
        final int id;
        final Area worldArea;
        final double minX, maxX, minY, maxY;

        ExclusionRecord(Exclusion d) {
            this.id = d.id();
            var expanded = ContourGeometrySupport.expandExclusion(d);
            this.worldArea = expanded.worldArea();
            this.minX = expanded.minX();
            this.maxX = expanded.maxX();
            this.minY = expanded.minY();
            this.maxY = expanded.maxY();
        }
    }

    @Override
    public EngineResult solve(NestingProblem problem) {
        ComputationCancellation.check();
        long startTime = System.currentTimeMillis();
        long marginMs = Math.min(800L, Math.max(250L, problem.timeLimitSeconds() * 150L));
        long timeBudgetMs = Math.max(350L, problem.timeLimitSeconds() * 1000L - marginMs);

        Shape matShape = problem.material().shape();
        Area matArea = PolygonGeometry.region(matShape, 0, 0);
        matArea.getBounds2D();
        boolean isRectMat = "RECTANGLE".equals(matShape.type()) && !matShape.hasHoles();
        double matW = matShape.width();
        double matH = matShape.height();
        double gap = Math.max(Math.max(0.0, problem.process().pieceGap()), Math.max(0.0, problem.process().kerf()));

        ConstraintPipeline pipeline = CurtainConstraintPack.forProblem(problem);
        List<ExclusionRecord> exclusionRecords = new ArrayList<>();
        Map<Integer, ExclusionRecord> exclusionById = new HashMap<>();
        for (Exclusion d : problem.material().exclusions()) {
            ComputationCancellation.check();
            ExclusionRecord rec = new ExclusionRecord(d);
            exclusionRecords.add(rec);
            exclusionById.put(d.id(), rec);
        }

        // Expand demands to individual instances
        List<PartItem> items = new ArrayList<>();
        for (Part p : problem.parts()) {
            ComputationCancellation.check();
            double[] xBounds = pipeline.isNoop() ? new double[]{0.0, matW} : pipeline.clipXBounds(problem, p, 0.0, matW);
            List<ExclusionRecord> hardRecs;
            if (pipeline.isNoop()) {
                hardRecs = exclusionRecords;
            } else {
                List<Exclusion> hardRaw = pipeline.hardExclusionsFor(problem, p);
                hardRecs = new ArrayList<>(hardRaw.size());
                for (Exclusion he : hardRaw) {
                    ExclusionRecord r = exclusionById.get(he.id());
                    if (r != null) hardRecs.add(r);
                }
            }
            boolean patternMatchX = !pipeline.isNoop() && PatternRepeatRule.requiresPatternMatchX(problem, p);
            boolean patternMatchY = !pipeline.isNoop() && PatternRepeatRule.requiresPatternMatchY(problem, p);
            boolean patternMatch = patternMatchX || patternMatchY;
            PartItem pi = new PartItem(problem, p, xBounds[0], xBounds[1], hardRecs, patternMatch, patternMatchX, patternMatchY);
            if (pi.orientations.isEmpty()) continue;
            for (int i = 0; i < p.quantity(); i++) {
                ComputationCancellation.check();
                items.add(pi);
            }
        }

        if (items.isEmpty()) {
            EngineResult emptyRes = new EngineResult();
            emptyRes.setSuccess(true);
            emptyRes.setPlacements(List.of());
            return emptyRes;
        }

        // Strategy variations for multi-pass search
        List<Comparator<PartItem>> strategies = List.of(
                Comparator.comparingDouble((PartItem a) -> a.maxArea).reversed(),
                Comparator.comparingDouble((PartItem a) -> a.orientations.get(0).height()).reversed()
                        .thenComparing(Comparator.comparingDouble((PartItem a) -> a.maxArea).reversed()),
                Comparator.comparingDouble((PartItem a) -> a.orientations.get(0).width()).reversed()
                        .thenComparing(Comparator.comparingDouble((PartItem a) -> a.maxArea).reversed()),
                Comparator.comparingDouble((PartItem a) -> a.orientations.get(0).width() + a.orientations.get(0).height()).reversed()
        );

        List<Callable<List<PlacedRecord>>> passTasks = new ArrayList<>(strategies.size());
        for (int pass = 0; pass < strategies.size(); pass++) {
            final Comparator<PartItem> strategy = strategies.get(pass);
            passTasks.add(() -> {
                ComputationCancellation.check();
                if (System.currentTimeMillis() - startTime > timeBudgetMs) {
                    return List.of();
                }
                List<PartItem> sortedItems = new ArrayList<>(items);
                sortedItems.sort(strategy);
                Area localMatArea = isRectMat ? matArea : new Area(matArea);
                return runPlacementPass(
                        problem, pipeline, sortedItems, localMatArea, isRectMat, matW, matH, gap, exclusionRecords, startTime, timeBudgetMs
                );
            });
        }

        List<List<PlacedRecord>> passResults = NestingParallelExecutor.runDeterministic(passTasks);

        List<PlacedRecord> bestPlan = null;
        int bestPlacedCount = -1;
        double bestPlacedArea = -1;
        double bestMaxY = Double.MAX_VALUE;

        for (List<PlacedRecord> currentPlacements : passResults) {
            if (currentPlacements.isEmpty()) continue;

            int placedCount = currentPlacements.size();
            double placedArea = currentPlacements.stream().mapToDouble(p -> p.orientedShape.area()).sum();
            double maxY = currentPlacements.stream().mapToDouble(p -> p.maxY).max().orElse(0.0);

            boolean isBetter = false;
            if (placedCount > bestPlacedCount) {
                isBetter = true;
            } else if (placedCount == bestPlacedCount) {
                if (Math.abs(placedArea - bestPlacedArea) > EPS) {
                    isBetter = placedArea > bestPlacedArea;
                } else if (maxY < bestMaxY - EPS) {
                    isBetter = true;
                }
            }

            if (isBetter) {
                bestPlan = currentPlacements;
                bestPlacedCount = placedCount;
                bestPlacedArea = placedArea;
                bestMaxY = maxY;
            }
        }

        EngineResult result = new EngineResult();
        if (bestPlan == null || bestPlan.isEmpty()) {
            result.setSuccess(false);
            result.setFailureStatus("NO_SOLUTION_FOUND");
            result.setMessage("未找到可行排样方案");
            return result;
        }

        List<Placement> finalPlacements = new ArrayList<>();
        int idSeq = 1;
        for (PlacedRecord rec : bestPlan) {
            Placement old = rec.placement;
            finalPlacements.add(new Placement(
                    idSeq++,
                    old.demandId(),
                    old.name(),
                    old.x(),
                    old.y(),
                    old.shape(),
                    old.rotationDegrees()
            ));
        }

        result.setSuccess(true);
        result.setPlacements(finalPlacements);
        return result;
    }

    private static AabbBvh buildExclusionBvh(List<ExclusionRecord> exclusions) {
        int count = exclusions.size();
        if (count <= AabbBvh.LINEAR_THRESHOLD) {
            return AabbBvh.EMPTY;
        }
        double[] minX = new double[count];
        double[] minY = new double[count];
        double[] maxX = new double[count];
        double[] maxY = new double[count];
        for (int i = 0; i < count; i++) {
            ExclusionRecord e = exclusions.get(i);
            minX[i] = e.minX;
            minY[i] = e.minY;
            maxX[i] = e.maxX;
            maxY[i] = e.maxY;
        }
        return AabbBvh.build(minX, minY, maxX, maxY, count);
    }

    private List<PlacedRecord> runPlacementPass(
            NestingProblem problem, ConstraintPipeline pipeline,
            List<PartItem> items, Area matArea, boolean isRectMat, double matW, double matH,
            double gap, List<ExclusionRecord> exclusions, long startTime, long timeBudgetMs) {

        List<PlacedRecord> placedList = new ArrayList<>();
        Map<String, Integer> lockedGroupAngles = new HashMap<>();
        double[] placedMinX = new double[items.size()];
        double[] placedMinY = new double[items.size()];
        double[] placedMaxX = new double[items.size()];
        double[] placedMaxY = new double[items.size()];
        AabbBvh placedBvh = null;
        int placementId = 1;

        for (PartItem item : items) {
            ComputationCancellation.check();
            if (System.currentTimeMillis() - startTime > timeBudgetMs) break;

            CandidateBest bestCandidate = null;
            Integer lockedAngle = item.grainGroupId == null ? null : lockedGroupAngles.get(item.grainGroupId);

            // Collect candidate anchor points
            SortedSet<Double> xAnchors = new TreeSet<>();
            SortedSet<Double> yAnchors = new TreeSet<>();
            xAnchors.add(item.minX);
            yAnchors.add(0.0);

            for (PlacedRecord p : placedList) {
                ComputationCancellation.check();
                xAnchors.add(Math.max(item.minX, Math.min(item.maxX, p.maxX + gap)));
                yAnchors.add(Math.min(matH, p.maxY + gap));
                xAnchors.add(Math.max(item.minX, Math.min(item.maxX, p.minX)));
                yAnchors.add(Math.min(matH, p.minY));
                if (p.orientedShape.shape().hasHoles()) {
                    for (List<Point> hole : p.orientedShape.shape().holes()) {
                        double hMinX = Double.POSITIVE_INFINITY, hMinY = Double.POSITIVE_INFINITY;
                        for (Point hp : hole) {
                            if (hp.x() < hMinX) hMinX = hp.x();
                            if (hp.y() < hMinY) hMinY = hp.y();
                        }
                        if (Double.isFinite(hMinX) && Double.isFinite(hMinY)) {
                            xAnchors.add(Math.max(item.minX, Math.min(item.maxX, p.minX + hMinX + gap)));
                            yAnchors.add(Math.min(matH, p.minY + hMinY + gap));
                        }
                    }
                }
            }
            for (ExclusionRecord e : exclusions) {
                ComputationCancellation.check();
                xAnchors.add(Math.max(item.minX, Math.min(item.maxX, e.maxX + gap)));
                yAnchors.add(Math.min(matH, e.maxY + gap));
            }

            // Add fine-grained grid anchors along Y
            List<Double> yList = new ArrayList<>(yAnchors);
            List<Double> xList = new ArrayList<>(xAnchors);

            for (OrientedShape orientation : item.orientations) {
                ComputationCancellation.check();
                if (lockedAngle != null && orientation.rotationDegrees() != lockedAngle) {
                    continue;
                }
                double pw = orientation.width();
                double ph = orientation.height();
                if (pw > (item.maxX - item.minX) + EPS || ph > matH + EPS) continue;

                // Try corner anchors
                for (double rawY : yList) {
                    ComputationCancellation.check();
                    double cy = item.patternMatchY
                            ? pipeline.snapY(problem, item.part, orientation.rotationDegrees(), rawY)
                            : rawY;
                    if (cy + ph > matH + EPS) continue;

                    // Try key x positions
                    for (double rawX : xList) {
                        ComputationCancellation.check();
                        double cx = item.patternMatchX
                                ? pipeline.snapX(problem, item.part, orientation.rotationDegrees(), rawX)
                                : rawX;
                        if (cx < item.minX - EPS) continue;
                        if (cx + pw > item.maxX + EPS) continue;

                        if (isPositionValid(cx, cy, orientation, matArea, isRectMat, item.minX, item.maxX, matH, gap, placedList, placedBvh, item.hardExclusions, item.hardExclusionBvh)) {
                            // Local squeeze to left and up
                            double[] squeezed = squeezeLeftUp(problem, pipeline, item, cx, cy, orientation, matArea, isRectMat, matH, gap, placedList, placedBvh);
                            double sx = squeezed[0];
                            double sy = squeezed[1];

                            double softPen = pipeline.isNoop() ? 0.0
                                    : pipeline.penalty(problem, item.part, sx, sy, orientation.rotationDegrees(), orientation.shape());
                            double score = calculateScore(sx, sy, pw, ph) + softPen * 1_000_000.0;
                            if (bestCandidate == null || score < bestCandidate.score) {
                                bestCandidate = new CandidateBest(sx, sy, orientation, score);
                            }
                        }
                    }

                    // Also try a few stepped x positions if xList didn't yield a solution at this y
                    double availSpan = item.maxX - item.minX - pw;
                    if (bestCandidate == null && availSpan > 50) {
                        double step = Math.max(30.0, availSpan / 15.0);
                        for (double rawX = item.minX; rawX + pw <= item.maxX + EPS; rawX += step) {
                            ComputationCancellation.check();
                            double cx = item.patternMatchX
                                    ? pipeline.snapX(problem, item.part, orientation.rotationDegrees(), rawX)
                                    : rawX;
                            if (cx < item.minX - EPS || cx + pw > item.maxX + EPS) continue;
                            if (isPositionValid(cx, cy, orientation, matArea, isRectMat, item.minX, item.maxX, matH, gap, placedList, placedBvh, item.hardExclusions, item.hardExclusionBvh)) {
                                double[] squeezed = squeezeLeftUp(problem, pipeline, item, cx, cy, orientation, matArea, isRectMat, matH, gap, placedList, placedBvh);
                                double sx = squeezed[0];
                                double sy = squeezed[1];
                                double softPen = pipeline.isNoop() ? 0.0
                                        : pipeline.penalty(problem, item.part, sx, sy, orientation.rotationDegrees(), orientation.shape());
                                double score = calculateScore(sx, sy, pw, ph) + softPen * 1_000_000.0;
                                if (bestCandidate == null || score < bestCandidate.score) {
                                    bestCandidate = new CandidateBest(sx, sy, orientation, score);
                                }
                            }
                        }
                    }
                }
            }

            if (bestCandidate != null) {
                double placeX = bestCandidate.x;
                double placeY = bestCandidate.y;
                OrientedShape chosenOri = bestCandidate.orientation;
                if (item.grainGroupId != null) {
                    lockedGroupAngles.putIfAbsent(item.grainGroupId, chosenOri.rotationDegrees());
                }
                Area worldArea = PolygonGeometry.region(chosenOri.shape(), placeX, placeY);

                Placement pl = new Placement(
                        placementId++,
                        item.demandId,
                        item.name,
                        placeX,
                        placeY,
                        chosenOri.shape(),
                        chosenOri.rotationDegrees
                );
                PlacedRecord rec = new PlacedRecord(pl, chosenOri, worldArea);
                int idx = placedList.size();
                placedMinX[idx] = rec.minX;
                placedMinY[idx] = rec.minY;
                placedMaxX[idx] = rec.maxX;
                placedMaxY[idx] = rec.maxY;
                placedList.add(rec);
                if (placedList.size() > AabbBvh.LINEAR_THRESHOLD) {
                    placedBvh = AabbBvh.build(placedMinX, placedMinY, placedMaxX, placedMaxY, placedList.size());
                }
            }
        }

        return placedList;
    }

    private static double calculateScore(double x, double y, double w, double h) {
        // Primary objective: minimize bounding length (y + h), secondary: minimize x
        double bottom = y + h;
        double right = x + w;
        return bottom * 1000000.0 + right * 1000.0 + y * 10.0 + x;
    }

    private static double[] squeezeLeftUp(
            NestingProblem problem, ConstraintPipeline pipeline, PartItem item,
            double startX, double startY, OrientedShape ori, Area matArea, boolean isRectMat,
            double matH, double gap, List<PlacedRecord> placed, AabbBvh placedBvh) {

        double currX = startX;
        double currY = startY;
        double currPenalty = pipeline.isNoop() ? 0.0
                : pipeline.penalty(problem, item.part, currX, currY, ori.rotationDegrees(), ori.shape());

        // Step sizes for multi-resolution squeeze
        double[] steps = {50.0, 10.0, 2.0, 0.5};

        for (double step : steps) {
            ComputationCancellation.check();
            // Squeeze left (skip if X is locked to pattern repeat grid)
            if (!item.patternMatchX) {
                while (currX - step >= item.minX - 1e-9) {
                    ComputationCancellation.check();
                    double nx = Math.max(item.minX, currX - step);
                    if (isPositionValid(nx, currY, ori, matArea, isRectMat, item.minX, item.maxX, matH, gap, placed, placedBvh, item.hardExclusions, item.hardExclusionBvh)) {
                        if (!pipeline.isNoop()) {
                            double np = pipeline.penalty(problem, item.part, nx, currY, ori.rotationDegrees(), ori.shape());
                            if (np > currPenalty + 1e-6) break;
                            currPenalty = np;
                        }
                        currX = nx;
                    } else {
                        break;
                    }
                }
            }
            // Squeeze up (skip if Y is locked to pattern repeat grid)
            if (!item.patternMatchY) {
                while (currY - step >= 0) {
                    ComputationCancellation.check();
                    double ny = currY - step;
                    if (isPositionValid(currX, ny, ori, matArea, isRectMat, item.minX, item.maxX, matH, gap, placed, placedBvh, item.hardExclusions, item.hardExclusionBvh)) {
                        if (!pipeline.isNoop()) {
                            double np = pipeline.penalty(problem, item.part, currX, ny, ori.rotationDegrees(), ori.shape());
                            if (np > currPenalty + 1e-6) break;
                            currPenalty = np;
                        }
                        currY = ny;
                    } else {
                        break;
                    }
                }
            }
        }

        double roundedX = item.patternMatchX ? currX : Math.max(item.minX, Math.round(currX * 10.0) / 10.0);
        double roundedY = item.patternMatchY ? currY : Math.round(currY * 10.0) / 10.0;
        if ((Math.abs(roundedX - currX) > 1e-9 || Math.abs(roundedY - currY) > 1e-9)
                && !isPositionValid(roundedX, roundedY, ori, matArea, isRectMat, item.minX, item.maxX, matH, gap,
                        placed, placedBvh, item.hardExclusions, item.hardExclusionBvh)) {
            return new double[]{currX, currY};
        }
        return new double[]{roundedX, roundedY};
    }

    private static boolean isPositionValid(
            double x, double y, OrientedShape ori, Area matArea, boolean isRectMat,
            double minX, double maxX, double matH, double gap,
            List<PlacedRecord> placedList, AabbBvh placedBvh,
            List<ExclusionRecord> exclusions, AabbBvh exclusionBvh) {

        double w = ori.width();
        double h = ori.height();

        // 1. Boundary check (AABB outer bound applies to both rectangular and polygon materials)
        if (x < minX - EPS || y < -EPS || x + w > maxX + EPS || y + h > matH + EPS) return false;

        Area[] candidateAreaRef = new Area[1];

        // 2. Non-rectangular material containment
        if (!isRectMat) {
            candidateAreaRef[0] = PolygonGeometry.region(ori.shape(), x, y);
            if (!ContourGeometrySupport.isWithinMaterial(candidateAreaRef[0], matArea, EPS)) {
                return false;
            }
        }

        // 3. Exclusions intersection
        if (exclusionBvh != null && !exclusionBvh.isEmpty()) {
            if (exclusionBvh.queryAnyExpanded(x, y, x + w, y + h, EPS, idx -> {
                ComputationCancellation.check();
                ExclusionRecord exc = exclusions.get(idx);
                if (candidateAreaRef[0] == null) {
                    candidateAreaRef[0] = PolygonGeometry.region(ori.shape(), x, y);
                }
                return ContourGeometrySupport.overlapsArea(candidateAreaRef[0], exc.worldArea, EPS);
            })) {
                return false;
            }
        } else {
            for (ExclusionRecord exc : exclusions) {
                ComputationCancellation.check();
                if (ContourGeometrySupport.aabbOverlaps(x, x + w, y, y + h, exc.minX, exc.maxX, exc.minY, exc.maxY, EPS)) {
                    if (candidateAreaRef[0] == null) {
                        candidateAreaRef[0] = PolygonGeometry.region(ori.shape(), x, y);
                    }
                    if (ContourGeometrySupport.overlapsArea(candidateAreaRef[0], exc.worldArea, EPS)) {
                        return false;
                    }
                }
            }
        }

        // 4. Collision & pieceGap check with placed parts
        List<Point> candVerts = ori.vertices();
        double buf = Math.max(0.0, gap) + EPS;

        if (placedBvh != null) {
            return !placedBvh.queryAnyExpanded(x, y, x + w, y + h, buf, idx -> {
                ComputationCancellation.check();
                PlacedRecord placed = placedList.get(idx);
                if (candidateAreaRef[0] == null) {
                    candidateAreaRef[0] = PolygonGeometry.region(ori.shape(), x, y);
                }
                if (ContourGeometrySupport.overlapsArea(candidateAreaRef[0], placed.worldArea, EPS)) {
                    return true;
                }
                return gap > 0 && ContourGeometrySupport.violatesMinEdgeGap(
                        ori.shape(), x, y,
                        placed.orientedShape.shape(), placed.placement.x(), placed.placement.y(),
                        gap, EPS);
            });
        }

        for (PlacedRecord placed : placedList) {
            ComputationCancellation.check();
            if (!ContourGeometrySupport.aabbOverlaps(
                    x, x + w, y, y + h, placed.minX, placed.maxX, placed.minY, placed.maxY, buf)) {
                continue;
            }

            if (candidateAreaRef[0] == null) {
                candidateAreaRef[0] = PolygonGeometry.region(ori.shape(), x, y);
            }
            if (ContourGeometrySupport.overlapsArea(candidateAreaRef[0], placed.worldArea, EPS)) {
                return false;
            }

            if (gap > 0 && ContourGeometrySupport.violatesMinEdgeGap(
                    ori.shape(), x, y,
                    placed.orientedShape.shape(), placed.placement.x(), placed.placement.y(),
                    gap, EPS)) {
                return false;
            }
        }

        return true;
    }

    private static class CandidateBest {
        final double x, y;
        final OrientedShape orientation;
        final double score;

        CandidateBest(double x, double y, OrientedShape orientation, double score) {
            this.x = x;
            this.y = y;
            this.orientation = orientation;
            this.score = score;
        }
    }
}
