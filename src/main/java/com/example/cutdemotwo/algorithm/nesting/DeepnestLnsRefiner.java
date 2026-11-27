package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.ChosenSpot;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.ClipCacheEntry;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.EvaluationResult;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.ExpandedPart;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.NfpInnerKey;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.OrientedPart;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.PlacedBvhTracker;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.PlacedInstance;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.ProblemContext;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import org.locationtech.jts.geom.Envelope;
import org.locationtech.jts.geom.Geometry;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.SplittableRandom;

import static com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.LNS_CANDIDATES_TO_VALIDATE;
import static com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.LNS_MAX_RUIN;
import static com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.LNS_MIN_PIECES;
import static com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.LNS_MIN_RUIN;
import static com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.isStrictlyBetter;
import static com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.reachedTheoreticalBound;
import static com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.resolveCandidateAngles;
import static com.example.cutdemotwo.algorithm.nesting.DeepnestSearchModel.toPlacements;

/**
 * Deepnest 阶段 2 LNS 大邻域精修（Ruin-and-Recreate）与跨接缝/末端精确 NFP 微调器。
 */
final class DeepnestLnsRefiner {

    private DeepnestLnsRefiner() {}

    /**
     * 包级局部跨缝与末端精确 NFP 微调（供 {@link ContourPartitionSolver} 拼接压紧后打通子区接缝、压缩锯齿尾端）。
     * 采用确定性轮次与局部 Y 视窗裁剪，仅保留严格缩短版长且零容忍校验通过的改进解。
     */
    static List<Placement> refineSeamAndTail(NestingProblem problem,
                                             List<Placement> incumbent,
                                             List<Double> seamYs,
                                             int maxRounds,
                                             long deadlineNanos) {
        ComputationCancellation.check();
        if (incumbent == null || incumbent.size() < LNS_MIN_PIECES || maxRounds <= 0 || System.nanoTime() >= deadlineNanos) {
            return incumbent;
        }
        ProblemContext ctx = new ProblemContext(problem, false);
        if (ctx.items.size() != incumbent.size() || !ctx.pipeline.isNoop() || ctx.preferBottom) {
            return incumbent;
        }

        // 将既有 Placement 一一映射到 ProblemContext.items 的确定性 instanceId
        Map<Integer, List<ExpandedPart>> poolByDemand = new HashMap<>();
        for (ExpandedPart ep : ctx.items) {
            poolByDemand.computeIfAbsent(ep.demandId, k -> new ArrayList<>()).add(ep);
        }
        Map<Integer, Integer> cursorByDemand = new HashMap<>();
        List<PlacedInstance> initialPlaced = new ArrayList<>(incumbent.size());
        double initialArea = 0.0;
        double initialMaxY = 0.0;
        double initialMaxX = 0.0;
        for (Placement p : incumbent) {
            List<ExpandedPart> list = poolByDemand.get(p.demandId());
            if (list == null) return incumbent;
            int idx = cursorByDemand.getOrDefault(p.demandId(), 0);
            if (idx >= list.size()) return incumbent;
            cursorByDemand.put(p.demandId(), idx + 1);
            ExpandedPart ep = list.get(idx);
            OrientedPart ori = ep.byAngle.get(p.rotationDegrees());
            if (ori == null) return incumbent;
            PlacedInstance pi = new PlacedInstance(ep.instanceId, ori, p.x(), p.y());
            initialPlaced.add(pi);
            initialArea += ori.area();
            if (pi.maxY > initialMaxY) initialMaxY = pi.maxY;
            if (pi.maxX > initialMaxX) initialMaxX = pi.maxX;
        }

        double initialFitness = initialMaxY * 1000.0 + initialMaxX;
        EvaluationResult best = new EvaluationResult(initialPlaced, initialArea, initialMaxY, initialFitness);
        boolean improved = false;
        int n = ctx.items.size();

        // 阶段 A：接缝“门闩拔除 → 剩余全体轴向整体推进 → 精确 NFP 回插”
        // 专治分区接缝处少数突出件卡死整块后区无法上推的瓶颈，尤其对交替 180° 翻转后的双锯齿接缝威力极大
        if (seamYs != null && !seamYs.isEmpty() && AxisMarkerCompactor.supports(problem)) {
            int boltCount = n >= 100 ? 6 : 8;
            for (int si = 0; si < seamYs.size(); si++) {
                ComputationCancellation.check();
                if (System.nanoTime() >= deadlineNanos) break;
                double seamY = seamYs.get(si);
                // 随已有压紧比例缩放接缝位置，跟踪压紧后的真实接缝带
                double scaledSeamY = initialMaxY > 1e-6 ? seamY * (best.extentY() / initialMaxY) : seamY;
                List<PlacedInstance> currentPlaced = best.placed();

                // 精选接缝上下两侧紧邻的门闩件（优先选与接缝最近且跨度较大的阻挡件）
                List<PlacedInstance> above = new ArrayList<>();
                List<PlacedInstance> below = new ArrayList<>();
                for (PlacedInstance pi : currentPlaced) {
                    double cy = (pi.minY + pi.maxY) * 0.5;
                    if (cy <= scaledSeamY) {
                        above.add(pi);
                    } else {
                        below.add(pi);
                    }
                }
                above.sort(Comparator.comparingDouble((PlacedInstance p) -> Math.abs(scaledSeamY - p.maxY))
                        .thenComparingInt(p -> p.instanceId));
                below.sort(Comparator.comparingDouble((PlacedInstance p) -> Math.abs(p.minY - scaledSeamY))
                        .thenComparingInt(p -> p.instanceId));

                Set<Integer> boltIds = new HashSet<>(boltCount * 2);
                int half = boltCount / 2;
                for (int i = 0; i < half && i < above.size(); i++) {
                    boltIds.add(above.get(i).instanceId);
                }
                for (int i = 0; i < half && i < below.size(); i++) {
                    boltIds.add(below.get(i).instanceId);
                }
                for (int i = half; boltIds.size() < boltCount && i < above.size(); i++) {
                    boltIds.add(above.get(i).instanceId);
                }
                for (int i = half; boltIds.size() < boltCount && i < below.size(); i++) {
                    boltIds.add(below.get(i).instanceId);
                }

                List<PlacedInstance> keptRaw = new ArrayList<>(currentPlaced.size() - boltIds.size());
                List<ExpandedPart> removed = new ArrayList<>(boltIds.size());
                for (PlacedInstance pi : currentPlaced) {
                    if (boltIds.contains(pi.instanceId)) {
                        removed.add(ctx.items.get(pi.instanceId));
                    } else {
                        keptRaw.add(pi);
                    }
                }
                if (removed.isEmpty() || keptRaw.isEmpty()) continue;

                // 摘除门闩件后，用 AxisMarkerCompactor 把整个后区顺滑推进前区凹腔（按剩余预算合理放宽至最高 350ms 使其自然收敛）
                List<Placement> keptPlacements = toPlacements(keptRaw);
                long nowAxis = System.nanoTime();
                long remainingAxis = deadlineNanos - nowAxis;
                long axisBudget = Math.min(350_000_000L, Math.max(120_000_000L, remainingAxis / 2));
                long axisCap = Math.min(deadlineNanos, nowAxis + axisBudget);
                List<Placement> slidPlacements = AxisMarkerCompactor.compact(problem, keptPlacements, axisCap);
                if (slidPlacements == keptPlacements) {
                    continue;
                }
                List<PlacedInstance> slidKept = new ArrayList<>(keptRaw.size());
                for (int i = 0; i < keptRaw.size(); i++) {
                    PlacedInstance orig = keptRaw.get(i);
                    Placement sp = slidPlacements.get(i);
                    slidKept.add(new PlacedInstance(orig.instanceId, orig.ori, sp.x(), sp.y()));
                }

                // 将摘出的门闩件用精确 NFP 按多种启发序插回腾出的接缝与新尾部
                Map<NfpInnerKey, Geometry> keptFeasibleCache = new HashMap<>();
                double windowMinY = n > 80
                        ? Math.max(0.0, scaledSeamY - Math.max(900.0, best.extentY() * 0.22))
                        : 0.0;
                List<List<ExpandedPart>> allOrders = buildRecreateOrders(removed);
                int ordersToTry = Math.min(2, allOrders.size());
                for (int oi = 0; oi < ordersToTry; oi++) {
                    ComputationCancellation.check();
                    if (System.nanoTime() >= deadlineNanos) break;
                    EvaluationResult cand = recreateFromPartialWindowed(
                            ctx, slidKept, allOrders.get(oi), keptFeasibleCache,
                            DeepnestGeneticAlgorithm.PlacementMode.GRAVITY_Y, best, windowMinY, deadlineNanos);
                    if (cand != null
                            && cand.placed().size() == n
                            && cand.extentY() < best.extentY() - 1e-4) {
                        best = cand;
                        improved = true;
                        break;
                    }
                }
            }
        }

        // 阶段 B：末端聚焦 LNS 微调（压缩最底端锯齿突出件）
        int ruinTarget = n >= 100 ? 8 : 10;
        int tailRounds = Math.min(2, maxRounds);
        for (int round = 0; round < tailRounds; round++) {
            ComputationCancellation.check();
            if (System.nanoTime() >= deadlineNanos) {
                break;
            }
            List<PlacedInstance> currentPlaced = best.placed();
            Set<Integer> ruinIds = new HashSet<>(ruinTarget * 2);
            List<PlacedInstance> byTail = new ArrayList<>(currentPlaced);
            byTail.sort(Comparator.comparingDouble((PlacedInstance p) -> -p.maxY)
                    .thenComparingInt(p -> p.instanceId));

            int tailPick = Math.min(ruinTarget + (round == 1 ? 2 : 0), currentPlaced.size());
            for (int i = 0; i < tailPick && i < byTail.size(); i++) {
                ruinIds.add(byTail.get(i).instanceId);
            }
            double windowMinY = n > 80
                    ? Math.max(0.0, best.extentY() - Math.max(1400.0, best.extentY() * 0.30))
                    : 0.0;

            List<PlacedInstance> kept = new ArrayList<>(currentPlaced.size() - ruinIds.size());
            List<ExpandedPart> removed = new ArrayList<>(ruinIds.size());
            for (PlacedInstance pi : currentPlaced) {
                if (ruinIds.contains(pi.instanceId)) {
                    removed.add(ctx.items.get(pi.instanceId));
                } else {
                    kept.add(pi);
                }
            }
            if (removed.isEmpty()) continue;

            Map<NfpInnerKey, Geometry> keptFeasibleCache = new HashMap<>();
            List<List<ExpandedPart>> allOrders = buildRecreateOrders(removed);
            int ordersToTry = Math.min(2, allOrders.size());
            for (int oi = 0; oi < ordersToTry; oi++) {
                ComputationCancellation.check();
                if (System.nanoTime() >= deadlineNanos) break;
                EvaluationResult cand = recreateFromPartialWindowed(
                        ctx, kept, allOrders.get(oi), keptFeasibleCache,
                        DeepnestGeneticAlgorithm.PlacementMode.GRAVITY_Y, best, windowMinY, deadlineNanos);
                if (cand != null
                        && cand.placed().size() == n
                        && cand.extentY() < best.extentY() - 1e-4) {
                    best = cand;
                    improved = true;
                    break;
                }
            }
        }

        if (!improved) {
            return incumbent;
        }
        List<Placement> refined = toPlacements(best.placed());
        EngineResult check = new EngineResult();
        check.setSuccess(true);
        check.setPlacements(refined);
        return PolygonResultValidator.validate(problem, check) == null ? refined : incumbent;
    }

    /**
     * 阶段 2：确定性 LNS 大邻域精修（Ruin-and-Recreate）。
     * 围绕当前最优解轮换执行多种破坏策略（高 Y 末端、空间邻域、确定性随机子集），
     * 保持其余件不动并用精确 NFP + ConstraintPipeline 按多种启发序与全允许角度重新插回。
     */
    static EvaluationResult runLnsRefinement(ProblemContext ctx,
                                             EvaluationResult incumbent,
                                             double theoreticalMinY,
                                             long seed,
                                             long deadlineNanos,
                                             int maxRoundsOverride,
                                             int maxStagnantOverride) {
        int n = ctx.items.size();
        SplittableRandom rng = new SplittableRandom(seed ^ 0x517CC1B727220A95L);
        EvaluationResult best = incumbent;
        int defaultMaxRounds = Math.min(28, Math.max(8, n * 2));
        int defaultMaxStagnant = n <= 12 ? 6 : 8;
        int maxRounds = maxRoundsOverride > 0 ? Math.min(defaultMaxRounds, maxRoundsOverride) : defaultMaxRounds;
        int maxStagnant = maxStagnantOverride > 0 ? Math.min(defaultMaxStagnant, maxStagnantOverride) : defaultMaxStagnant;
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

            // 预计算 kept 集合的基础状态与剩余可行域缓存（同一轮 Ruin 的多种 Recreate 序共享）
            Map<NfpInnerKey, Geometry> keptFeasibleCache = new HashMap<>();
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
                        ctx, kept, order, keptFeasibleCache, recreateMode, best, deadlineNanos);
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
                                                        Map<NfpInnerKey, Geometry> keptFeasibleCache,
                                                        DeepnestGeneticAlgorithm.PlacementMode mode,
                                                        EvaluationResult incumbent,
                                                        long deadlineNanos) {
        return recreateFromPartialWindowed(ctx, kept, toReinsert, keptFeasibleCache, mode, incumbent, 0.0, deadlineNanos);
    }

    private static EvaluationResult recreateFromPartialWindowed(ProblemContext ctx,
                                                                List<PlacedInstance> kept,
                                                                List<ExpandedPart> toReinsert,
                                                                Map<NfpInnerKey, Geometry> keptFeasibleCache,
                                                                DeepnestGeneticAlgorithm.PlacementMode mode,
                                                                EvaluationResult incumbent,
                                                                double windowMinY,
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

        Map<String, Integer> lockedGroupAngles = new HashMap<>();
        for (PlacedInstance pi : kept) {
            placed.add(pi);
            placedWorldPolys.add(pi.worldVertices);
            placedBvh.add(pi);
            placedArea += pi.ori.area();
            ExpandedPart ep = ctx.items.get(pi.instanceId);
            if (ep.grainGroupId != null) {
                lockedGroupAngles.putIfAbsent(ep.grainGroupId, pi.ori.angle());
            }
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
        // 满件且无软惩罚权衡时，任何超出当前最优版长的候选点都不可能产生更优解，直接启用严格 Y 上界剪枝与视窗裁剪
        double maxAllowedExtentY = (incumbentComplete && ctx.pipeline.isNoop())
                ? (incumbent.extentY() + 1e-3)
                : Double.POSITIVE_INFINITY;
        int keptSize = kept.size();
        Map<NfpInnerKey, ClipCacheEntry> clipCache = new HashMap<>();

        for (ExpandedPart item : toReinsert) {
            ComputationCancellation.check();
            if (System.nanoTime() >= deadlineNanos) {
                return null;
            }

            List<Integer> candidateAngles = resolveCandidateAngles(item, lockedGroupAngles);
            ChosenSpot bestSpot = null;
            for (int angle : candidateAngles) {
                ComputationCancellation.check();
                OrientedPart ori = item.byAngle.get(angle);

                // 数学界限快速过滤：该角度自身高度已超过允许版长上界则直接跳过
                if (ori.height() > maxAllowedExtentY + 1e-6) {
                    continue;
                }

                // 利用 keptFeasibleCache 复用 kept 集合的剩余可行域（已按视窗裁剪并跳过不相交 OuterNFP）
                if (keptSize > 0) {
                    NfpInnerKey key = new NfpInnerKey(ori.demandId(), ori.angle());
                    if (!clipCache.containsKey(key)) {
                        Geometry baseFeasible = keptFeasibleCache.get(key);
                        if (baseFeasible == null) {
                            Geometry rem = DeepnestPlacementEvaluator.clipSheetNfpToExtentWindow(
                                    ctx, ori, ctx.getInnerNfp(ori), maxAllowedExtentY);
                            if (windowMinY > 1e-6 && !ctx.preferBottom && !rem.isEmpty()) {
                                Envelope env = rem.getEnvelopeInternal();
                                if (windowMinY > env.getMinY() + 1e-4) {
                                    double pad = DeepnestNfpGeometry.OPEN_CHANNEL_EPS * 4.0 + 1e-4;
                                    if (windowMinY > env.getMaxY() + 1e-6) {
                                        rem = DeepnestNfpGeometry.EMPTY_GEOM;
                                    } else {
                                        Geometry lowerClip = DeepnestNfpGeometry.rectGeometry(
                                                env.getMinX() - pad,
                                                windowMinY - pad,
                                                (env.getMaxX() - env.getMinX()) + 2.0 * pad,
                                                Math.max(2.0 * pad, (env.getMaxY() - windowMinY) + 2.0 * pad)
                                        );
                                        rem = DeepnestNfpGeometry.intersectionGeometry(rem, lowerClip);
                                    }
                                }
                            }
                            for (int j = 0; j < keptSize && !rem.isEmpty(); j++) {
                                ComputationCancellation.check();
                                PlacedInstance p = kept.get(j);
                                Geometry outer = ctx.getOuterNfp(p.ori, ori);
                                if (DeepnestNfpGeometry.translatedEnvelopeIntersects(outer, p.x, p.y, rem.getEnvelopeInternal())) {
                                    Geometry translated = DeepnestNfpGeometry.translateGeometry(outer, p.x, p.y);
                                    rem = DeepnestNfpGeometry.differenceGeometry(rem, translated);
                                }
                            }
                            baseFeasible = rem;
                            keptFeasibleCache.put(key, baseFeasible);
                        }
                        ClipCacheEntry entry = new ClipCacheEntry(baseFeasible);
                        entry.nextPlacedIndex = keptSize;
                        clipCache.put(key, entry);
                    }
                }

                double upperBoundScore = bestSpot != null ? bestSpot.score() : Double.POSITIVE_INFINITY;
                ChosenSpot candidate = DeepnestPlacementEvaluator.findBestSpotForOrientation(
                        ctx, ori, mode, placed, placedWorldPolys, placedBvh, clipCache,
                        currentMinX, currentMaxX, currentMinY, currentMaxY, LNS_CANDIDATES_TO_VALIDATE,
                        maxAllowedExtentY, upperBoundScore
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
            if (item.grainGroupId != null) {
                lockedGroupAngles.putIfAbsent(item.grainGroupId, bestSpot.ori().angle());
            }
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
}
