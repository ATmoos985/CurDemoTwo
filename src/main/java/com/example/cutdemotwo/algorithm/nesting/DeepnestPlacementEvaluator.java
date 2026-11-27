package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.CandidatePoint;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.ChosenSpot;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.ClipCacheEntry;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.EvaluationResult;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.ExclusionObstacle;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.ExpandedPart;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.NfpInnerKey;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.OrientedPart;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.PlacedBvhTracker;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.PlacedInstance;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.ProblemContext;
import com.example.cutdemotwo.algorithm.nesting.constraints.PatternRepeatRule;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Part;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import org.locationtech.jts.geom.Envelope;
import org.locationtech.jts.geom.Geometry;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.LARGE_SET_CANDIDATES_TO_VALIDATE;
import static com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.STRATIFIED_EXTRA_CANDIDATES;
import static com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.TOP_CANDIDATES_TO_VALIDATE;
import static com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.isPlacementValid;
import static com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.resolveCandidateAngles;
import static com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.snapCoord;

/**
 * Deepnest 染色体解码评估、NFP 视窗裁剪、候选落位采样共边打分与局部微滑压紧器。
 */
final class DeepnestPlacementEvaluator {

    private DeepnestPlacementEvaluator() {}

    /**
     * Evaluates one GA chromosome using Deepnest's NFP boolean difference placement rule
     * ({@code placeParts} in {@code background.js:804-1173}).
     */
    static EvaluationResult evaluateIndividual(ProblemContext ctx,
                                               DeepnestGeneticAlgorithm.Individual ind,
                                               long deadlineNanos,
                                               boolean hasIncumbent) {
        List<PlacedInstance> placed = new ArrayList<>(ind.order.length);
        List<List<Point>> placedWorldPolys = new ArrayList<>(ind.order.length);
        PlacedBvhTracker placedBvh = new PlacedBvhTracker(ind.order.length);
        Map<NfpInnerKey, ClipCacheEntry> clipCache = new HashMap<>();
        Map<String, Integer> lockedGroupAngles = new HashMap<>();

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
            List<Integer> candidateAngles = resolveCandidateAngles(item, lockedGroupAngles);
            if (candidateAngles.isEmpty()) {
                continue;
            }
            int preferredAngle = ind.rotations[step];
            if (!candidateAngles.contains(preferredAngle)) {
                preferredAngle = candidateAngles.get(0);
            }

            ChosenSpot bestSpot = null;
            int candidateLimit = ctx.items.size() >= 12 ? LARGE_SET_CANDIDATES_TO_VALIDATE : TOP_CANDIDATES_TO_VALIDATE;

            if (ind.greedyAngles || placed.isEmpty() || candidateAngles.size() == 1) {
                // Evaluate all allowed rotations and record the best angle back into chromosome
                for (int angle : candidateAngles) {
                    ComputationCancellation.check();
                    OrientedPart ori = item.byAngle.get(angle);
                    double upperBoundScore = bestSpot != null ? bestSpot.score() : Double.POSITIVE_INFINITY;
                    ChosenSpot candidate = findBestSpotForOrientation(
                            ctx, ori, ind.placementMode, placed, placedWorldPolys, placedBvh, clipCache,
                            currentMinX, currentMaxX, currentMinY, currentMaxY, candidateLimit,
                            Double.POSITIVE_INFINITY, upperBoundScore
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
                        currentMinX, currentMaxX, currentMinY, currentMaxY, candidateLimit,
                        Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY
                );
                // Fallback to other allowed rotations if preferred orientation cannot fit on remaining sheet
                if (bestSpot == null && candidateAngles.size() > 1) {
                    for (int angle : candidateAngles) {
                        if (angle == prefOri.angle()) continue;
                        ComputationCancellation.check();
                        OrientedPart altOri = item.byAngle.get(angle);
                        double upperBoundScore = bestSpot != null ? bestSpot.score() : Double.POSITIVE_INFINITY;
                        ChosenSpot candidate = findBestSpotForOrientation(
                                ctx, altOri, ind.placementMode, placed, placedWorldPolys, placedBvh, clipCache,
                                currentMinX, currentMaxX, currentMinY, currentMaxY, candidateLimit,
                                Double.POSITIVE_INFINITY, upperBoundScore
                        );
                        if (candidate != null && (bestSpot == null || candidate.score() < bestSpot.score())) {
                            bestSpot = candidate;
                        }
                    }
                }
            }

            if (bestSpot != null) {
                ind.rotations[step] = bestSpot.ori().angle();
                if (item.grainGroupId != null) {
                    lockedGroupAngles.putIfAbsent(item.grainGroupId, bestSpot.ori().angle());
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

    /**
     * 当存在严格版长上界 {@code maxAllowedExtentY} 时，将 {@code sheetNfp} 裁剪至有效 Y 视窗，
     * 避免后续布尔差集与顶点采样浪费在已不可能优于当前最优解的高 Y 废区域上。
     */
    static Geometry clipSheetNfpToExtentWindow(ProblemContext ctx,
                                                OrientedPart ori,
                                                Geometry sheetNfp,
                                                double maxAllowedExtentY) {
        if (sheetNfp == null || sheetNfp.isEmpty() || !Double.isFinite(maxAllowedExtentY)) {
            return sheetNfp;
        }
        Envelope env = sheetNfp.getEnvelopeInternal();
        double pad = DeepnestNfpGeometry.OPEN_CHANNEL_EPS * 4.0 + 1e-4;
        if (!ctx.preferBottom) {
            double maxOriginY = maxAllowedExtentY - ori.height();
            if (maxOriginY < env.getMinY() - 1e-6) {
                return DeepnestNfpGeometry.EMPTY_GEOM;
            }
            if (maxOriginY + pad >= env.getMaxY()) {
                return sheetNfp;
            }
            Geometry win = DeepnestNfpGeometry.rectGeometry(
                    env.getMinX() - pad,
                    env.getMinY() - pad,
                    (env.getMaxX() - env.getMinX()) + 2.0 * pad,
                    Math.max(2.0 * pad, (maxOriginY - env.getMinY()) + 2.0 * pad)
            );
            return DeepnestNfpGeometry.intersectionGeometry(sheetNfp, win);
        } else {
            double minOriginY = ctx.matH - maxAllowedExtentY;
            if (minOriginY > env.getMaxY() + 1e-6) {
                return DeepnestNfpGeometry.EMPTY_GEOM;
            }
            if (minOriginY - pad <= env.getMinY()) {
                return sheetNfp;
            }
            Geometry win = DeepnestNfpGeometry.rectGeometry(
                    env.getMinX() - pad,
                    minOriginY - pad,
                    (env.getMaxX() - env.getMinX()) + 2.0 * pad,
                    Math.max(2.0 * pad, (env.getMaxY() - minOriginY) + 2.0 * pad)
            );
            return DeepnestNfpGeometry.intersectionGeometry(sheetNfp, win);
        }
    }

    static ChosenSpot findBestSpotForOrientation(ProblemContext ctx,
                                                 OrientedPart ori,
                                                 DeepnestGeneticAlgorithm.PlacementMode mode,
                                                 List<PlacedInstance> placed,
                                                 List<List<Point>> placedWorldPolys,
                                                 PlacedBvhTracker placedBvhTracker,
                                                 Map<NfpInnerKey, ClipCacheEntry> clipCache,
                                                 double currentMinX, double currentMaxX,
                                                 double currentMinY, double currentMaxY,
                                                 int maxCandidatesToValidate,
                                                 double maxAllowedExtentY,
                                                 double upperBoundScore) {
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
            double bestScoreBound = upperBoundScore;
            for (Point pt : rawPts) {
                ComputationCancellation.check();
                double baseX = snapCoord(pt.x(), minValidX, maxValidX);
                double baseY = snapCoord(pt.y(), 0.0, maxValidY);
                double[][] snappedPairs;
                if (!ctx.pipeline.isNoop() && part != null && PatternRepeatRule.requiresPatternMatch(ctx.problem, part)) {
                    double nxNear = ctx.pipeline.snapXNearest(ctx.problem, part, ori.angle(), baseX, minValidX, maxValidX);
                    double nyNear = ctx.pipeline.snapYNearest(ctx.problem, part, ori.angle(), baseY, 0.0, maxValidY);
                    double nxFwd = ctx.pipeline.snapX(ctx.problem, part, ori.angle(), baseX);
                    double nyFwd = ctx.pipeline.snapY(ctx.problem, part, ori.angle(), baseY);
                    if (Math.abs(nxNear - nxFwd) > 1e-6 || Math.abs(nyNear - nyFwd) > 1e-6) {
                        snappedPairs = new double[][]{{nxNear, nyNear}, {nxFwd, nyFwd}};
                    } else {
                        snappedPairs = new double[][]{{nxNear, nyNear}};
                    }
                } else {
                    snappedPairs = new double[][]{{baseX, baseY}};
                }
                for (double[] xy : snappedPairs) {
                    double cx = xy[0];
                    double cy = xy[1];
                    if (cx < minValidX - 1e-6 || cx > maxValidX + 1e-6 || cy < -1e-6 || cy > maxValidY + 1e-6) continue;
                    double primaryY = ctx.preferBottom ? (ctx.matH - cy) : (cy + ori.height());
                    if (primaryY > maxAllowedExtentY) continue;
                    double secondaryX = ctx.preferRight ? (ctx.matW - cx) : (cx + ori.width());
                    double score = mode == DeepnestGeneticAlgorithm.PlacementMode.GRAVITY_X
                            ? (secondaryX * ctx.gravityWeight + primaryY)
                            : (primaryY * ctx.gravityWeight + secondaryX);
                    if (!ctx.pipeline.isNoop() && part != null) {
                        score += ctx.pipeline.penalty(ctx.problem, part, cx, cy, ori.angle(), ori.shape()) * ctx.gravityWeight;
                    }
                    if (score >= bestScoreBound - 1e-9) continue;
                    if (isPlacementValid(ctx, cx, cy, ori, placed, null, -1)) {
                        bestFirst = new ChosenSpot(cx, cy, ori, score, 0.0);
                        bestScoreBound = score;
                    }
                }
            }
            return bestFirst;
        }

        // Incremental feasible region update via clipCache:
        // 维护剩余可行域 feasibleNfp = ((sheetNfp \ nfp_0) \ nfp_1) ...，
        // 对每个新增已放件先做零分配外接框相交预判，跳过与当前剩余可行域无交集的 NFP 并集与差集运算。
        NfpInnerKey cacheKey = new NfpInnerKey(ori.demandId(), ori.angle());
        ClipCacheEntry entry = clipCache.get(cacheKey);
        if (entry == null) {
            Geometry initFeasible = Double.isFinite(maxAllowedExtentY)
                    ? clipSheetNfpToExtentWindow(ctx, ori, sheetNfp, maxAllowedExtentY)
                    : sheetNfp;
            entry = new ClipCacheEntry(initFeasible);
            clipCache.put(cacheKey, entry);
        }
        if (entry.nextPlacedIndex < placed.size() && !entry.feasibleNfp.isEmpty()) {
            Geometry rem = entry.feasibleNfp;
            for (int j = entry.nextPlacedIndex; j < placed.size() && !rem.isEmpty(); j++) {
                ComputationCancellation.check();
                PlacedInstance p = placed.get(j);
                Geometry outer = ctx.getOuterNfp(p.ori, ori);
                if (DeepnestNfpGeometry.translatedEnvelopeIntersects(outer, p.x, p.y, rem.getEnvelopeInternal())) {
                    Geometry translated = DeepnestNfpGeometry.translateGeometry(outer, p.x, p.y);
                    rem = DeepnestNfpGeometry.differenceGeometry(rem, translated);
                }
            }
            entry.feasibleNfp = rem;
            entry.nextPlacedIndex = placed.size();
        }

        Geometry finalNfp = entry.feasibleNfp;
        if (finalNfp.isEmpty()) return null;

        List<DeepnestNfpGeometry.Ring> rings = DeepnestNfpGeometry.extractRings(finalNfp);
        if (rings.isEmpty()) return null;

        boolean checkMerged = ctx.pieceGap == 0.0;
        double mergeWeight = switch (mode) {
            case TIGHT_CORNER -> 1.8;
            case BOX_AREA -> ctx.matW * 0.5;
            default -> 0.35;
        };
        double maxPossibleBonus = checkMerged ? (ori.width() + ori.height()) * 2.0 * mergeWeight : 0.0;
        double maxAllowedBaseScore = Double.isFinite(upperBoundScore)
                ? (upperBoundScore + maxPossibleBonus)
                : Double.POSITIVE_INFINITY;

        double creaseY = ctx.preferBottom ? currentMinY : (currentMaxY - ori.height());
        double creaseX = ctx.preferRight ? currentMinX : (currentMaxX - ori.width());

        List<CandidatePoint> candidates = new ArrayList<>(rings.size() * 12);
        for (DeepnestNfpGeometry.Ring ring : rings) {
            ComputationCancellation.check();
            List<Point> verts = ring.vertices();
            int vn = verts.size();
            for (int k = 0; k < vn; k++) {
                Point p1 = verts.get(k);
                addScoredCandidate(ctx, ori, mode, p1.x(), p1.y(), minValidX, maxValidX, maxValidY,
                        currentMinX, currentMaxX, currentMinY, currentMaxY,
                        maxAllowedExtentY, maxAllowedBaseScore, candidates);

                Point p2 = verts.get((k + 1) % vn);
                // Crease-line intersection along diagonal NFP edge for tight tucking without growing extentY/extentX
                if ((p1.y() - creaseY) * (p2.y() - creaseY) < -1e-12) {
                    double t = (creaseY - p1.y()) / (p2.y() - p1.y());
                    double ix = p1.x() + t * (p2.x() - p1.x());
                    addScoredCandidate(ctx, ori, mode, ix, creaseY, minValidX, maxValidX, maxValidY,
                            currentMinX, currentMaxX, currentMinY, currentMaxY,
                            maxAllowedExtentY, maxAllowedBaseScore, candidates);
                }
                if ((p1.x() - creaseX) * (p2.x() - creaseX) < -1e-12) {
                    double t = (creaseX - p1.x()) / (p2.x() - p1.x());
                    double iy = p1.y() + t * (p2.y() - p1.y());
                    addScoredCandidate(ctx, ori, mode, creaseX, iy, minValidX, maxValidX, maxValidY,
                            currentMinX, currentMaxX, currentMinY, currentMaxY,
                            maxAllowedExtentY, maxAllowedBaseScore, candidates);
                }
            }
        }

        if (!ctx.pipeline.isNoop() && part != null && part.isAuxiliary()
                && ctx.hardObstaclesFor(ori.demandId()).size() < ctx.exclusions.size()) {
            for (ExclusionObstacle obs : ctx.exclusions) {
                addScoredCandidate(ctx, ori, mode, obs.maxX, 0.0, minValidX, maxValidX, maxValidY,
                        currentMinX, currentMaxX, currentMinY, currentMaxY,
                        maxAllowedExtentY, maxAllowedBaseScore, candidates);
                addScoredCandidate(ctx, ori, mode, minValidX, obs.maxY, minValidX, maxValidX, maxValidY,
                        currentMinX, currentMaxX, currentMinY, currentMaxY,
                        maxAllowedExtentY, maxAllowedBaseScore, candidates);
                addScoredCandidate(ctx, ori, mode, obs.maxX, currentMinY, minValidX, maxValidX, maxValidY,
                        currentMinX, currentMaxX, currentMinY, currentMaxY,
                        maxAllowedExtentY, maxAllowedBaseScore, candidates);
                addScoredCandidate(ctx, ori, mode, minValidX, currentMaxY, minValidX, maxValidX, maxValidY,
                        currentMinX, currentMaxX, currentMinY, currentMaxY,
                        maxAllowedExtentY, maxAllowedBaseScore, candidates);
            }
        }

        if (candidates.isEmpty()) return null;
        candidates.sort(Comparator.comparingDouble(CandidatePoint::baseScore));

        ChosenSpot best = null;
        double bestScoreBound = upperBoundScore;
        int checked = 0;
        double lastX = Double.NaN, lastY = Double.NaN;

        AabbBvh placedBvh = placedBvhTracker.get();
        List<List<Point>> nearbyScratch = (checkMerged && placedBvh != null) ? new ArrayList<>(16) : null;

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

            if (cp.baseScore() - maxPossibleBonus >= bestScoreBound) {
                break;
            }

            if (isPlacementValid(ctx, cp.x(), cp.y(), ori, placed, placedBvh, -1)) {
                best = updateBestSpot(best, cp, ori, checkMerged, mergeWeight, placedBvh, placedWorldPolys, nearbyScratch);
                if (best != null && best.score() < bestScoreBound) {
                    bestScoreBound = best.score();
                }
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
                if (cp.baseScore() - maxPossibleBonus >= bestScoreBound) {
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
                    if (best != null && best.score() < bestScoreBound) {
                        bestScoreBound = best.score();
                    }
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
                                           double minValidX, double maxValidX, double maxValidY,
                                           double currentMinX, double currentMaxX,
                                           double currentMinY, double currentMaxY,
                                           double maxAllowedExtentY,
                                           double maxAllowedBaseScore,
                                           List<CandidatePoint> out) {
        if (!Double.isFinite(rawX) || !Double.isFinite(rawY)) return;
        if (rawX < minValidX - 0.05 || rawX > maxValidX + 0.05 || rawY < -0.05 || rawY > maxValidY + 0.05) return;

        double baseX = snapCoord(rawX, minValidX, maxValidX);
        double baseY = snapCoord(rawY, 0.0, maxValidY);
        if (!ctx.pipeline.isNoop()) {
            Part part = ctx.partById.get(ori.demandId());
            if (PatternRepeatRule.requiresPatternMatch(ctx.problem, part)) {
                double nxNear = ctx.pipeline.snapXNearest(ctx.problem, part, ori.angle(), baseX, minValidX, maxValidX);
                double nyNear = ctx.pipeline.snapYNearest(ctx.problem, part, ori.angle(), baseY, 0.0, maxValidY);
                appendScoredPoint(ctx, ori, mode, part, nxNear, nyNear, minValidX, maxValidX, maxValidY,
                        currentMinX, currentMaxX, currentMinY, currentMaxY, maxAllowedExtentY, maxAllowedBaseScore, out);
                double nxFwd = ctx.pipeline.snapX(ctx.problem, part, ori.angle(), baseX);
                double nyFwd = ctx.pipeline.snapY(ctx.problem, part, ori.angle(), baseY);
                if (Math.abs(nxFwd - nxNear) > 1e-6 || Math.abs(nyFwd - nyNear) > 1e-6) {
                    appendScoredPoint(ctx, ori, mode, part, nxFwd, nyFwd, minValidX, maxValidX, maxValidY,
                            currentMinX, currentMaxX, currentMinY, currentMaxY, maxAllowedExtentY, maxAllowedBaseScore, out);
                }
                return;
            }
            appendScoredPoint(ctx, ori, mode, part, baseX, baseY, minValidX, maxValidX, maxValidY,
                    currentMinX, currentMaxX, currentMinY, currentMaxY, maxAllowedExtentY, maxAllowedBaseScore, out);
            return;
        }
        appendScoredPoint(ctx, ori, mode, null, baseX, baseY, minValidX, maxValidX, maxValidY,
                currentMinX, currentMaxX, currentMinY, currentMaxY, maxAllowedExtentY, maxAllowedBaseScore, out);
    }

    private static void appendScoredPoint(ProblemContext ctx, OrientedPart ori,
                                          DeepnestGeneticAlgorithm.PlacementMode mode,
                                          Part part,
                                          double cx, double cy,
                                          double minValidX, double maxValidX, double maxValidY,
                                          double currentMinX, double currentMaxX,
                                          double currentMinY, double currentMaxY,
                                          double maxAllowedExtentY,
                                          double maxAllowedBaseScore,
                                          List<CandidatePoint> out) {
        if (cx < minValidX - 1e-6 || cx > maxValidX + 1e-6 || cy < -1e-6 || cy > maxValidY + 1e-6) return;
        double softPenalty = 0.0;
        if (!ctx.pipeline.isNoop() && part != null) {
            softPenalty = ctx.pipeline.penalty(ctx.problem, part, cx, cy, ori.angle(), ori.shape());
        }

        double newExtentY = ctx.preferBottom
                ? Math.max(ctx.matH - currentMinY, ctx.matH - cy)
                : Math.max(currentMaxY, cy + ori.height());
        if (newExtentY > maxAllowedExtentY) {
            return;
        }

        double newExtentX = ctx.preferRight
                ? Math.max(ctx.matW - currentMinX, ctx.matW - cx)
                : Math.max(currentMaxX, cx + ori.width());

        double ownY = ctx.preferBottom ? (ctx.matH - cy) : (cy + ori.height());
        double ownX = ctx.preferRight ? (ctx.matW - cx) : cx;

        double baseScore = switch (mode) {
            case GRAVITY_Y -> newExtentY * ctx.gravityWeight + newExtentX + ownY * 0.25 + ownX * 0.02;
            case GRAVITY_X -> newExtentX * ctx.gravityWeight + newExtentY + ownX * 0.25 + ownY * 0.02;
            case BOX_AREA -> newExtentX * newExtentY + (ownY + ownX) * 10.0;
            case TIGHT_CORNER -> ownY * 2.5 + ownX * 2.0 + newExtentY * 0.8 + newExtentX * 0.5;
        };
        if (softPenalty > 0.0) {
            baseScore += softPenalty * ctx.gravityWeight;
        }
        if (baseScore >= maxAllowedBaseScore) {
            return;
        }

        out.add(new CandidatePoint(cx, cy, baseScore, newExtentY));
    }

    /**
     * Fast post-GA local coordinate slide (0.1 mm resolution) that eliminates any residual micro-gap
     * left by NFP tolerances while strictly preserving validity.
     */
    static List<PlacedInstance> polishPlacements(ProblemContext ctx,
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
            boolean lockYForPattern = !ctx.pipeline.isNoop() && PatternRepeatRule.requiresPatternMatchY(ctx.problem, part);
            boolean lockXForPattern = !ctx.pipeline.isNoop() && PatternRepeatRule.requiresPatternMatchX(ctx.problem, part);
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
                if (!lockXForPattern) {
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
            }

            if (moved) {
                PlacedInstance updated = new PlacedInstance(current.instanceId, current.ori, bestX, bestY);
                work.set(idx, updated);
                workBvh.set(idx, updated);
            }
        }
        return work;
    }
}
