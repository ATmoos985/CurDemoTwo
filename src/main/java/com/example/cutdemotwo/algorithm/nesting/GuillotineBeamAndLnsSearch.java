package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.CandidatePlacement;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.DemItem;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.FitRule;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.FreeRect;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.LayoutSolution;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.PlacedRec;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.RawCut;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.SearchContext;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.SortRule;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.SplitRule;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.Strategy;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.SplittableRandom;

/**
 * 直刀有界 Beam Search（束搜索）与预算内确定性 LNS 局部精修、版长二分压缩器。
 */
final class GuillotineBeamAndLnsSearch {

    private GuillotineBeamAndLnsSearch() {}

    // ==================== 有界 Beam Search（束搜索） ====================

    private static final class BeamState {
        final List<FreeRect> freeRects;
        final List<PlacedRec> pieces;
        final List<RawCut> cuts;
        final boolean[] placedMask;
        final double placedArea;
        final double usedLength;
        final int softDefectHits;
        final double heuristicScore;

        BeamState(List<FreeRect> freeRects, List<PlacedRec> pieces, List<RawCut> cuts,
                  boolean[] placedMask, double placedArea, double usedLength,
                  int softDefectHits, double heuristicScore) {
            this.freeRects = freeRects;
            this.pieces = pieces;
            this.cuts = cuts;
            this.placedMask = placedMask;
            this.placedArea = placedArea;
            this.usedLength = usedLength;
            this.softDefectHits = softDefectHits;
            this.heuristicScore = heuristicScore;
        }
    }

    static LayoutSolution runBeamSearch(
            SearchContext ctx,
            int[] order,
            FitRule baseFitRule,
            SplitRule baseSplitRule,
            double workingHeight,
            long beamDeadline) {
        int n = order.length;
        int beamWidth = n <= 30 ? 6 : (n <= 60 ? 5 : 4);
        int branchPerState = 3;
        int beamDepth = Math.min(n, 20);

        List<BeamState> beam = new ArrayList<>(beamWidth);
        List<FreeRect> initFree = List.of(new FreeRect(0.0, 0.0, ctx.rollW, workingHeight, 1, ctx.horizontalFirst));
        beam.add(new BeamState(initFree, List.of(), List.of(), new boolean[n], 0.0, 0.0, 0, 0.0));

        for (int depth = 0; depth < beamDepth; depth++) {
            ComputationCancellation.check();
            if (System.nanoTime() >= beamDeadline) {
                break;
            }
            int itemIdx = order[depth];
            DemItem it = ctx.items.get(itemIdx);
            List<BeamState> nextGen = new ArrayList<>(beam.size() * branchPerState * 2);

            for (BeamState state : beam) {
                ComputationCancellation.check();
                if (System.nanoTime() >= beamDeadline) break;

                List<CandidatePlacement> topCands = GuillotineRectPlacer.selectTopPlacements(
                        ctx, it, state.freeRects, baseFitRule, branchPerState);
                if (topCands.isEmpty()) {
                    nextGen.add(state);
                    continue;
                }

                for (int ci = 0; ci < topCands.size(); ci++) {
                    CandidatePlacement cand = topCands.get(ci);
                    FreeRect target = state.freeRects.get(cand.rectIdx());
                    boolean canHoriz = GuillotineRectPlacer.isSplitAllowedByMaxStages(
                            ctx, target, cand.px(), cand.py(), cand.pw(), cand.pl(), true);
                    boolean canVert = GuillotineRectPlacer.isSplitAllowedByMaxStages(
                            ctx, target, cand.px(), cand.py(), cand.pw(), cand.pl(), false);
                    boolean exploreBothSplits = (target.level > 1 && depth < 8 && ci == 0 && canHoriz && canVert);
                    if (exploreBothSplits) {
                        nextGen.add(expandState(ctx, state, itemIdx, cand, true));
                        nextGen.add(expandState(ctx, state, itemIdx, cand, false));
                    } else {
                        boolean splitHoriz = GuillotineRectPlacer.resolveSplitHorizontal(
                                ctx, target, cand.px(), cand.py(), cand.pw(), cand.pl(), baseSplitRule);
                        nextGen.add(expandState(ctx, state, itemIdx, cand, splitHoriz));
                    }
                }
            }

            if (nextGen.isEmpty()) {
                break;
            }
            nextGen.sort((a, b) -> Double.compare(b.heuristicScore, a.heuristicScore));

            // 基于真实布局指纹（规范化裁片位姿 + 空闲区状态）去重，确保束内真正多样性
            List<BeamState> pruned = new ArrayList<>(beamWidth);
            Set<String> seenFingerprints = new HashSet<>(beamWidth * 2);
            for (BeamState st : nextGen) {
                String fp = layoutFingerprint(ctx, st);
                if (seenFingerprints.add(fp)) {
                    pruned.add(st);
                    if (pruned.size() >= beamWidth) break;
                }
            }
            beam = pruned;
        }

        LayoutSolution best = null;
        int[] tailOrder = Arrays.copyOfRange(order, Math.min(beamDepth, n), n);
        for (BeamState st : beam) {
            ComputationCancellation.check();
            if (System.nanoTime() >= beamDeadline) break;

            LayoutSolution s1 = finishBeamState(ctx, st, tailOrder, baseFitRule, baseSplitRule, workingHeight);
            if (s1 != null && GuillotineSearchModel.isBetter(s1, best)) {
                best = s1;
            }
            if (tailOrder.length > 0 && System.nanoTime() < beamDeadline) {
                LayoutSolution s2 = finishBeamState(ctx, st, tailOrder, FitRule.BOTTOM_LEFT, SplitRule.MIN_AREA, workingHeight);
                if (s2 != null && GuillotineSearchModel.isBetter(s2, best)) {
                    best = s2;
                }
            }
        }
        return best;
    }

    private static BeamState expandState(
            SearchContext ctx,
            BeamState state,
            int itemIdx,
            CandidatePlacement cand,
            boolean splitHoriz) {
        List<FreeRect> nextFree = new ArrayList<>(state.freeRects.size() + 3);
        for (int i = 0; i < state.freeRects.size(); i++) {
            if (i != cand.rectIdx()) nextFree.add(state.freeRects.get(i));
        }
        FreeRect r = state.freeRects.get(cand.rectIdx());

        List<PlacedRec> nextPieces = new ArrayList<>(state.pieces.size() + 1);
        nextPieces.addAll(state.pieces);
        nextPieces.add(new PlacedRec(itemIdx, cand.px(), cand.py(), cand.pw(), cand.pl(), cand.rotated()));

        List<RawCut> nextCuts = new ArrayList<>(state.cuts.size() + 4);
        nextCuts.addAll(state.cuts);

        GuillotineRectPlacer.splitRect(ctx, r, cand.px(), cand.py(), cand.pw(), cand.pl(), splitHoriz, nextCuts, nextFree);

        boolean[] nextMask = Arrays.copyOf(state.placedMask, state.placedMask.length);
        nextMask[itemIdx] = true;

        double nextArea = state.placedArea + cand.pw() * cand.pl();
        double nextUsedLen = Math.max(state.usedLength, cand.py() + cand.pl());
        int nextSoftHits = state.softDefectHits + (cand.usedSoftDefect() ? 1 : 0);

        double maxFreeArea = 0.0;
        for (FreeRect fr : nextFree) {
            double a = fr.area();
            if (a > maxFreeArea) maxFreeArea = a;
        }
        double score = nextArea * 1.0
                + maxFreeArea * 0.12
                - nextUsedLen * ctx.rollW * 0.08
                - nextFree.size() * 250.0
                - nextSoftHits * 1_000_000.0;

        return new BeamState(nextFree, nextPieces, nextCuts, nextMask, nextArea, nextUsedLen, nextSoftHits, score);
    }

    /**
     * 基于真实几何布局构造规范指纹：
     * 将已排裁片按规范坐标/规格排序并串接空闲矩形状态，消除顺序对称重复，同时避免不同几何布局误碰撞。
     */
    static String layoutFingerprint(SearchContext ctx, BeamState st) {
        StringBuilder sb = new StringBuilder(st.pieces.size() * 24 + st.freeRects.size() * 20 + 16);
        long[] pieceKeys = new long[st.pieces.size()];
        for (int i = 0; i < st.pieces.size(); i++) {
            PlacedRec p = st.pieces.get(i);
            DemItem item = ctx.items.get(p.itemIdx);
            long demandId = item.demandId == null ? item.id : item.demandId;
            long rx = Math.round(p.x * 10.0) & 0xFFFFFL;
            long ry = Math.round(p.y * 10.0) & 0xFFFFFL;
            long rw = Math.round(p.w * 10.0) & 0x7FFFL;
            long rot = p.rotated ? 1L : 0L;
            pieceKeys[i] = ((demandId & 0xFFL) << 56) | (rx << 36) | (ry << 16) | (rw << 1) | rot;
        }
        Arrays.sort(pieceKeys);
        sb.append('P');
        for (long k : pieceKeys) {
            sb.append(Long.toHexString(k)).append(',');
        }
        long[] freeKeys = new long[st.freeRects.size()];
        for (int i = 0; i < st.freeRects.size(); i++) {
            FreeRect fr = st.freeRects.get(i);
            long fx = Math.round(fr.x * 5.0) & 0xFFFFL;
            long fy = Math.round(fr.y * 5.0) & 0xFFFFL;
            long fw = Math.round(fr.w * 5.0) & 0xFFFFL;
            long fh = Math.round(fr.h * 5.0) & 0x7FFFL;
            long axis = fr.axisHorizontal ? 1L : 0L;
            freeKeys[i] = (fx << 48) | (fy << 32) | (fw << 16) | (fh << 1) | axis;
        }
        Arrays.sort(freeKeys);
        sb.append("|F");
        for (long k : freeKeys) {
            sb.append(Long.toHexString(k)).append(',');
        }
        return sb.toString();
    }

    private static LayoutSolution finishBeamState(
            SearchContext ctx,
            BeamState st,
            int[] tailOrder,
            FitRule fitRule,
            SplitRule splitRule,
            double workingHeight) {
        List<FreeRect> freeRects = new ArrayList<>(st.freeRects);
        List<PlacedRec> pieces = new ArrayList<>(st.pieces);
        List<RawCut> cuts = new ArrayList<>(st.cuts);
        boolean[] placedMask = Arrays.copyOf(st.placedMask, st.placedMask.length);
        double placedArea = st.placedArea;
        double usedLength = st.usedLength;
        int softHits = st.softDefectHits;

        for (int idx : tailOrder) {
            ComputationCancellation.check();
            DemItem it = ctx.items.get(idx);
            CandidatePlacement bestCand = GuillotineRectPlacer.selectBestPlacement(ctx, it, freeRects, fitRule);
            if (bestCand == null) continue;

            FreeRect r = freeRects.remove(bestCand.rectIdx());
            pieces.add(new PlacedRec(idx, bestCand.px(), bestCand.py(), bestCand.pw(), bestCand.pl(), bestCand.rotated()));
            placedMask[idx] = true;
            placedArea += bestCand.pw() * bestCand.pl();
            usedLength = Math.max(usedLength, bestCand.py() + bestCand.pl());
            if (bestCand.usedSoftDefect()) softHits++;

            boolean splitHoriz = GuillotineRectPlacer.resolveSplitHorizontal(
                    ctx, r, bestCand.px(), bestCand.py(), bestCand.pw(), bestCand.pl(), splitRule);
            GuillotineRectPlacer.splitRect(
                    ctx, r, bestCand.px(), bestCand.py(), bestCand.pw(), bestCand.pl(), splitHoriz, cuts, freeRects);
        }

        return GuillotineSearchModel.wrapWorkingHeightIfCompressed(
                ctx, pieces, cuts, freeRects, placedMask, placedArea, pieces.size(), usedLength, softHits, workingHeight);
    }

    // ==================== 预算内确定性 LNS 局部精修 ====================

    static LayoutSolution runLnsRefinement(
            SearchContext ctx,
            LayoutSolution currentBest,
            Strategy bestStrategy) {
        LayoutSolution best = currentBest;
        int n = ctx.items.size();
        FitRule[] lnsFits = {bestStrategy.fitRule(), FitRule.BAF, FitRule.BSSF, FitRule.BOTTOM_LEFT};
        SplitRule[] lnsSplits = {bestStrategy.splitRule(), SplitRule.MIN_AREA, SplitRule.SHORT_AXIS,
                ctx.horizontalFirst ? SplitRule.HORIZONTAL_FIRST : SplitRule.VERTICAL_FIRST};

        // 阶段 3A：当存在未排件时，拔出尾段低效件 + 未排件前置/确定性邻域重排
        if (best.placedCount < n && !ctx.timeUp()) {
            SplittableRandom rng = new SplittableRandom(0x6D2B79F5L ^ (long) n * 31L);
            int maxIter = Math.min(80, Math.max(24, n * 3));
            for (int iter = 0; iter < maxIter; iter++) {
                ComputationCancellation.check();
                if (ctx.timeUp()) break;

                int[] perturbed = buildPerturbedOrder(ctx, best, iter, rng);
                FitRule fit = lnsFits[iter % lnsFits.length];
                SplitRule split = lnsSplits[(iter / 2) % lnsSplits.length];
                LayoutSolution cand = GuillotineRectPlacer.runGreedy(ctx, perturbed, fit, split, ctx.activeL, true);
                if (cand == null) break;
                if (GuillotineSearchModel.isBetter(cand, best)) {
                    best = cand;
                    if (best.placedCount == n) {
                        break;
                    }
                }
            }
        }

        // 阶段 3B：水平首刀与垂直首刀均支持满排后的严格直刀版长二分压缩
        boolean canCompressLength = ctx.horizontalFirst || (ctx.maxStages == null || ctx.maxStages >= 2);
        if (canCompressLength && best.placedCount == n && !ctx.timeUp()) {
            double theoreticalMinLen = ctx.totalDemandArea / Math.max(1.0, ctx.rollW);
            double upper = best.usedLength;
            double lower = Math.max(theoreticalMinLen, maxSingleItemMinLen(ctx));
            if (upper - lower > 15.0) {
                int[] baseOrder = extractOrderFromSolution(best, n);
                int[] areaOrder = GuillotineSearchModel.buildOrder(ctx, SortRule.AREA_DESC);
                int[] heightOrder = GuillotineSearchModel.buildOrder(ctx, SortRule.HEIGHT_DESC);

                for (int step = 0; step < 8; step++) {
                    ComputationCancellation.check();
                    if (ctx.timeUp() || upper - lower <= 12.0) break;
                    double mid = Math.floor((lower + upper) / 2.0);
                    if (mid >= best.usedLength - 5.0) {
                        break;
                    }
                    LayoutSolution compressed = tryPackWithinHeight(
                            ctx, mid, baseOrder, areaOrder, heightOrder, bestStrategy, best.softDefectHits);
                    if (compressed != null && compressed.placedCount == n
                            && GuillotineSearchModel.isBetter(compressed, best)) {
                        best = compressed;
                        upper = compressed.usedLength;
                    } else {
                        lower = mid;
                    }
                }
            }
        }

        return best;
    }

    private static double maxSingleItemMinLen(SearchContext ctx) {
        double maxMin = 0.0;
        for (DemItem it : ctx.items) {
            double minH = it.allowRotation ? Math.min(it.w, it.l) : it.l;
            if (minH > maxMin) maxMin = minH;
        }
        return maxMin;
    }

    private static LayoutSolution tryPackWithinHeight(
            SearchContext ctx,
            double targetHeight,
            int[] baseOrder,
            int[] areaOrder,
            int[] heightOrder,
            Strategy bestStrategy,
            int maxSoftHits) {
        int[][] orders = {baseOrder, areaOrder, heightOrder};
        FitRule[] fits = {FitRule.BOTTOM_LEFT, FitRule.BAF, bestStrategy.fitRule()};
        SplitRule[] splits = {SplitRule.MIN_AREA, SplitRule.SHORT_AXIS, bestStrategy.splitRule()};

        LayoutSolution best = null;
        for (int oi = 0; oi < orders.length; oi++) {
            for (int fi = 0; fi < fits.length; fi++) {
                ComputationCancellation.check();
                if (ctx.timeUp()) return best;
                LayoutSolution cand = GuillotineRectPlacer.runGreedy(
                        ctx, orders[oi], fits[fi], splits[(oi + fi) % splits.length], targetHeight, true);
                if (cand != null && cand.placedCount == ctx.items.size()
                        && cand.softDefectHits <= maxSoftHits
                        && GuillotineSearchModel.isBetter(cand, best)) {
                    best = cand;
                }
            }
        }
        return best;
    }

    private static int[] extractOrderFromSolution(LayoutSolution sol, int n) {
        int[] order = new int[n];
        int pos = 0;
        for (PlacedRec p : sol.pieces) {
            order[pos++] = p.itemIdx;
        }
        for (int i = 0; i < n; i++) {
            if (!sol.placedMask[i]) {
                order[pos++] = i;
            }
        }
        return order;
    }

    private static int[] buildPerturbedOrder(SearchContext ctx, LayoutSolution best, int iter, SplittableRandom rng) {
        int n = ctx.items.size();
        List<Integer> unplaced = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            if (!best.placedMask[i]) unplaced.add(i);
        }
        unplaced.sort((a, b) -> Double.compare(ctx.items.get(b).area(), ctx.items.get(a).area()));

        List<Integer> placed = new ArrayList<>(best.pieces.size());
        for (PlacedRec p : best.pieces) {
            placed.add(p.itemIdx);
        }

        List<Integer> result = new ArrayList<>(n);
        int mode = iter % 4;
        if (mode == 0 && !unplaced.isEmpty()) {
            int promoteCount = Math.min(unplaced.size(), 1 + (iter / 4) % 3);
            for (int i = 0; i < promoteCount; i++) result.add(unplaced.get(i));
            result.addAll(placed);
            for (int i = promoteCount; i < unplaced.size(); i++) result.add(unplaced.get(i));
        } else if (mode == 1 && placed.size() >= 3) {
            int cutPoint = Math.max(1, (int) (placed.size() * (0.60 + 0.05 * (iter % 4))));
            cutPoint = Math.min(cutPoint, placed.size() - 1);
            List<Integer> tailAndUnplaced = new ArrayList<>();
            tailAndUnplaced.addAll(unplaced);
            for (int i = cutPoint; i < placed.size(); i++) tailAndUnplaced.add(placed.get(i));
            tailAndUnplaced.sort((a, b) -> Double.compare(ctx.items.get(b).maxSide(), ctx.items.get(a).maxSide()));
            for (int i = 0; i < cutPoint; i++) result.add(placed.get(i));
            result.addAll(tailAndUnplaced);
        } else if (mode == 2 && !unplaced.isEmpty()) {
            int insertAt = Math.min(placed.size(), Math.max(1, placed.size() / 3));
            for (int i = 0; i < insertAt; i++) result.add(placed.get(i));
            result.addAll(unplaced);
            for (int i = insertAt; i < placed.size(); i++) result.add(placed.get(i));
        } else {
            result.addAll(placed);
            result.addAll(unplaced);
            int swaps = 2 + rng.nextInt(3);
            for (int s = 0; s < swaps && n >= 2; s++) {
                int a = rng.nextInt(n);
                int b = rng.nextInt(n);
                int tmp = result.get(a);
                result.set(a, result.get(b));
                result.set(b, tmp);
            }
        }

        int[] out = new int[n];
        for (int i = 0; i < n; i++) out[i] = result.get(i);
        return out;
    }
}
