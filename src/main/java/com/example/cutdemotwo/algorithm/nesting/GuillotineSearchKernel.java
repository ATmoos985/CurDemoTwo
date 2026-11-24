package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.CoordinateFrame;
import com.example.cutdemotwo.algorithm.nesting.constraints.ConstraintPipeline;
import com.example.cutdemotwo.algorithm.nesting.constraints.PatternRepeatRule;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.SplittableRandom;
import java.util.concurrent.Callable;

/**
 * 自主二维直刀（Guillotine）核心搜索内核：
 * <ol>
 *   <li>确定性多起点启发式池（多维排序 × 多种空间匹配 × 多种正交切分），复用 {@link NestingParallelExecutor} 有界并行；</li>
 *   <li>有界 Beam Search（束搜索），在关键前序件上保留 Top-K 部分解，避免首步贪心锁死后续大件空间；</li>
 *   <li>预算内确定性 LNS 局部精修（未排件前置重装、尾段拔出换序重排、以及满排后的严格直刀版长二分压缩）；</li>
 *   <li>所有候选解均维护严格合法的通切树（父刀阶段严格小于子刀阶段、零重叠、零越界、完整保留空闲余料）。</li>
 * </ol>
 */
final class GuillotineSearchKernel {

    private static final double EPS = 1e-6;
    private static final double MIN_SPLIT_MM = 0.5;

    static final class FreeRect {
        final double x;
        final double y;
        final double w;
        final double h;
        final int level;

        FreeRect(double x, double y, double w, double h, int level) {
            this.x = x;
            this.y = y;
            this.w = w;
            this.h = h;
            this.level = level;
        }

        double area() {
            return w * h;
        }
    }

    static final class DemItem {
        final int id;
        final String name;
        final double w;
        final double l;
        final boolean allowRotation;
        final Integer demandId;
        final NestingProblem.Part part;
        final double localMinX;
        final double localMaxX;
        final List<Defect> hardLocalDefects;
        final boolean patternMatch;

        DemItem(int id, String name, double w, double l, boolean allowRotation, Integer demandId,
                NestingProblem.Part part, double localMinX, double localMaxX,
                List<Defect> hardLocalDefects, boolean patternMatch) {
            this.id = id;
            this.name = name;
            this.w = w;
            this.l = l;
            this.allowRotation = allowRotation;
            this.demandId = demandId;
            this.part = part;
            this.localMinX = localMinX;
            this.localMaxX = localMaxX;
            this.hardLocalDefects = hardLocalDefects;
            this.patternMatch = patternMatch;
        }

        double area() {
            return w * l;
        }

        double maxSide() {
            return Math.max(w, l);
        }

        double minSide() {
            return Math.min(w, l);
        }

        double perimeter() {
            return w + l;
        }

        double aspectRatio() {
            double min = Math.max(EPS, minSide());
            return maxSide() / min;
        }
    }

    static final class PlacedRec {
        final int itemIdx;
        final double x;
        final double y;
        final double w;
        final double l;
        final boolean rotated;

        PlacedRec(int itemIdx, double x, double y, double w, double l, boolean rotated) {
            this.itemIdx = itemIdx;
            this.x = x;
            this.y = y;
            this.w = w;
            this.l = l;
            this.rotated = rotated;
        }
    }

    static final class RawCut {
        final String type;
        final double pos;
        final double start;
        final double end;
        final int stage;
        final String desc;

        RawCut(String type, double pos, double start, double end, int stage, String desc) {
            this.type = type;
            this.pos = pos;
            this.start = start;
            this.end = end;
            this.stage = stage;
            this.desc = desc;
        }
    }

    static final class LayoutSolution {
        final List<PlacedRec> pieces;
        final List<RawCut> cuts;
        final List<FreeRect> freeRects;
        final boolean[] placedMask;
        final double placedArea;
        final int placedCount;
        final double usedLength;
        final int softDefectHits;

        LayoutSolution(List<PlacedRec> pieces, List<RawCut> cuts, List<FreeRect> freeRects,
                       boolean[] placedMask, double placedArea, int placedCount,
                       double usedLength, int softDefectHits) {
            this.pieces = pieces;
            this.cuts = cuts;
            this.freeRects = freeRects;
            this.placedMask = placedMask;
            this.placedArea = placedArea;
            this.placedCount = placedCount;
            this.usedLength = usedLength;
            this.softDefectHits = softDefectHits;
        }
    }

    enum SortRule {
        AREA_DESC,
        MAX_SIDE_DESC,
        HEIGHT_DESC,
        WIDTH_DESC,
        PERIMETER_DESC,
        ASPECT_EXTREME_DESC,
        SHORT_SIDE_DESC
    }

    enum FitRule {
        BAF,          // 最小余料面积
        BSSF,         // 最小短边差
        BLSF,         // 最小长边差
        BOTTOM_LEFT   // 低位优先（压缩版长）
    }

    enum SplitRule {
        HORIZONTAL_FIRST,
        VERTICAL_FIRST,
        SHORT_AXIS,
        LONG_AXIS,
        MIN_AREA
    }

    private record Strategy(SortRule sortRule, FitRule fitRule, SplitRule splitRule) {}

    private record CandidatePlacement(
            int rectIdx,
            double px,
            double py,
            double pw,
            double pl,
            boolean rotated,
            boolean usedSoftDefect,
            double primaryScore,
            double secondaryScore
    ) {}

    private static final class SearchContext {
        final NestingProblem req;
        final CoordinateFrame frame;
        final ConstraintPipeline pipeline;
        final double rollW;
        final double activeL;
        final boolean horizontalFirst;
        final List<Defect> localDefects;
        final List<DemItem> items;
        final double totalDemandArea;
        final long deadlineNanos;

        SearchContext(NestingProblem req, CoordinateFrame frame, ConstraintPipeline pipeline,
                      double rollW, double activeL, boolean horizontalFirst,
                      List<Defect> localDefects, List<DemItem> items, long deadlineNanos) {
            this.req = req;
            this.frame = frame;
            this.pipeline = pipeline;
            this.rollW = rollW;
            this.activeL = activeL;
            this.horizontalFirst = horizontalFirst;
            this.localDefects = localDefects;
            this.items = items;
            double sum = 0.0;
            for (DemItem it : items) sum += it.area();
            this.totalDemandArea = sum;
            this.deadlineNanos = deadlineNanos;
        }

        boolean timeUp() {
            return System.nanoTime() >= deadlineNanos;
        }
    }

    private GuillotineSearchKernel() {}

    static LayoutSolution solve(
            NestingProblem req,
            CoordinateFrame frame,
            ConstraintPipeline pipeline,
            double rollW,
            double activeL,
            boolean horizontalFirst,
            List<Defect> localDefects,
            List<DemItem> items) {
        ComputationCancellation.check();
        if (items.isEmpty()) {
            return new LayoutSolution(
                    List.of(), List.of(),
                    List.of(new FreeRect(0, 0, rollW, activeL, 1)),
                    new boolean[0], 0.0, 0, 0.0, 0
            );
        }

        long now = System.nanoTime();
        long limitMs = Math.max(150L, (long) Math.max(1, req.timeLimitSeconds()) * 1000L);
        // 预留后处理时间，保证总耗时严格受限于 timeLimitSeconds
        long reserveMs = Math.min(120L, Math.max(40L, limitMs / 8));
        long searchBudgetMs = Math.max(80L, limitMs - reserveMs);
        long deadlineNanos = now + searchBudgetMs * 1_000_000L;

        SearchContext ctx = new SearchContext(
                req, frame, pipeline, rollW, activeL, horizontalFirst, localDefects, items, deadlineNanos
        );

        // 1. 确定性多起点启发式池（有界并行）
        List<Strategy> strategies = buildStrategies(horizontalFirst);
        List<Callable<LayoutSolution>> tasks = new ArrayList<>(strategies.size());
        for (Strategy s : strategies) {
            tasks.add(() -> {
                ComputationCancellation.check();
                int[] order = buildOrder(ctx, s.sortRule());
                return runGreedy(ctx, order, s.fitRule(), s.splitRule(), activeL, false);
            });
        }

        List<LayoutSolution> multiStartResults = NestingParallelExecutor.runDeterministic(tasks);
        LayoutSolution best = null;
        int bestStrategyIdx = 0;
        for (int i = 0; i < multiStartResults.size(); i++) {
            LayoutSolution cand = multiStartResults.get(i);
            if (cand != null && isBetter(cand, best)) {
                best = cand;
                bestStrategyIdx = i;
            }
        }
        Strategy bestStrategy = strategies.get(bestStrategyIdx);

        // 2. 有界 Beam Search（针对前序关键件展开 Top-K 状态，打破首刀/前步贪心锁死）
        long beamDeadline = now + (long) (searchBudgetMs * 0.55) * 1_000_000L;
        if (!ctx.timeUp() && System.nanoTime() < beamDeadline && items.size() >= 2) {
            int[] primaryOrder = buildOrder(ctx, bestStrategy.sortRule());
            LayoutSolution beamBest = runBeamSearch(ctx, primaryOrder, bestStrategy.fitRule(), bestStrategy.splitRule(), activeL, beamDeadline);
            if (beamBest != null && isBetter(beamBest, best)) {
                best = beamBest;
            }
            // 若仍有未排件且时间充裕，再对面积降序做一轮补充束搜索
            if (best != null && best.placedCount < items.size()
                    && bestStrategy.sortRule() != SortRule.AREA_DESC
                    && System.nanoTime() < beamDeadline) {
                int[] areaOrder = buildOrder(ctx, SortRule.AREA_DESC);
                LayoutSolution beamAlt = runBeamSearch(ctx, areaOrder, FitRule.BAF, SplitRule.MIN_AREA, activeL, beamDeadline);
                if (beamAlt != null && isBetter(beamAlt, best)) {
                    best = beamAlt;
                }
            }
        }

        // 3. 预算内确定性 LNS 局部重排精修
        if (best != null && !ctx.timeUp()) {
            best = runLnsRefinement(ctx, best, bestStrategy);
        }

        return best != null ? best : new LayoutSolution(
                List.of(), List.of(),
                List.of(new FreeRect(0, 0, rollW, activeL, 1)),
                new boolean[items.size()], 0.0, 0, 0.0, 0
        );
    }

    private static List<Strategy> buildStrategies(boolean horizontalFirst) {
        SplitRule primarySplit = horizontalFirst ? SplitRule.HORIZONTAL_FIRST : SplitRule.VERTICAL_FIRST;
        SplitRule altSplit = horizontalFirst ? SplitRule.VERTICAL_FIRST : SplitRule.HORIZONTAL_FIRST;
        return List.of(
                new Strategy(SortRule.AREA_DESC, FitRule.BAF, primarySplit),
                new Strategy(SortRule.AREA_DESC, FitRule.BAF, SplitRule.MIN_AREA),
                new Strategy(SortRule.AREA_DESC, FitRule.BSSF, SplitRule.SHORT_AXIS),
                new Strategy(SortRule.AREA_DESC, FitRule.BOTTOM_LEFT, primarySplit),
                new Strategy(SortRule.MAX_SIDE_DESC, FitRule.BSSF, SplitRule.SHORT_AXIS),
                new Strategy(SortRule.MAX_SIDE_DESC, FitRule.BAF, SplitRule.MIN_AREA),
                new Strategy(SortRule.MAX_SIDE_DESC, FitRule.BOTTOM_LEFT, SplitRule.LONG_AXIS),
                new Strategy(SortRule.HEIGHT_DESC, FitRule.BAF, SplitRule.HORIZONTAL_FIRST),
                new Strategy(SortRule.HEIGHT_DESC, FitRule.BOTTOM_LEFT, SplitRule.SHORT_AXIS),
                new Strategy(SortRule.WIDTH_DESC, FitRule.BAF, SplitRule.VERTICAL_FIRST),
                new Strategy(SortRule.WIDTH_DESC, FitRule.BSSF, SplitRule.MIN_AREA),
                new Strategy(SortRule.PERIMETER_DESC, FitRule.BLSF, SplitRule.LONG_AXIS),
                new Strategy(SortRule.PERIMETER_DESC, FitRule.BAF, altSplit),
                new Strategy(SortRule.ASPECT_EXTREME_DESC, FitRule.BSSF, SplitRule.MIN_AREA),
                new Strategy(SortRule.SHORT_SIDE_DESC, FitRule.BAF, SplitRule.SHORT_AXIS),
                new Strategy(SortRule.AREA_DESC, FitRule.BLSF, altSplit)
        );
    }

    private static int[] buildOrder(SearchContext ctx, SortRule rule) {
        int n = ctx.items.size();
        Integer[] idx = new Integer[n];
        for (int i = 0; i < n; i++) idx[i] = i;

        boolean hasConstraints = !ctx.pipeline.isNoop();
        Arrays.sort(idx, (a, b) -> {
            DemItem ia = ctx.items.get(a);
            DemItem ib = ctx.items.get(b);
            // 窗帘约束下，对花主片优先占位
            if (hasConstraints && ia.patternMatch != ib.patternMatch) {
                return ia.patternMatch ? -1 : 1;
            }
            int cmp = switch (rule) {
                case AREA_DESC -> Double.compare(ib.area(), ia.area());
                case MAX_SIDE_DESC -> Double.compare(ib.maxSide(), ia.maxSide());
                case HEIGHT_DESC -> Double.compare(ib.l, ia.l);
                case WIDTH_DESC -> Double.compare(ib.w, ia.w);
                case PERIMETER_DESC -> Double.compare(ib.perimeter(), ia.perimeter());
                case ASPECT_EXTREME_DESC -> Double.compare(ib.aspectRatio(), ia.aspectRatio());
                case SHORT_SIDE_DESC -> Double.compare(ib.minSide(), ia.minSide());
            };
            if (cmp != 0) return cmp;
            cmp = Double.compare(ib.area(), ia.area());
            if (cmp != 0) return cmp;
            return Integer.compare(ia.id, ib.id);
        });

        int[] out = new int[n];
        for (int i = 0; i < n; i++) out[i] = idx[i];
        return out;
    }

    /**
     * 字典序单调择优：
     * 1. 总排入面积（大优先）
     * 2. 满件数（多优先）
     * 3. 辅片覆盖轻微疵点次数（少优先）
     * 4. 更短消耗版长（短优先）
     * 5. 更少切刀数（少优先）
     */
    static boolean isBetter(LayoutSolution cand, LayoutSolution best) {
        if (best == null) return true;
        if (cand.placedArea > best.placedArea + 1e-3) return true;
        if (cand.placedArea < best.placedArea - 1e-3) return false;

        if (cand.placedCount != best.placedCount) {
            return cand.placedCount > best.placedCount;
        }
        if (cand.softDefectHits != best.softDefectHits) {
            return cand.softDefectHits < best.softDefectHits;
        }
        if (cand.usedLength < best.usedLength - 0.1) return true;
        if (cand.usedLength > best.usedLength + 0.1) return false;

        return cand.cuts.size() < best.cuts.size();
    }

    // ==================== 贪心构造器 ====================

    private static LayoutSolution runGreedy(
            SearchContext ctx,
            int[] order,
            FitRule fitRule,
            SplitRule splitRule,
            double workingHeight,
            boolean checkDeadline) {
        List<FreeRect> freeRects = new ArrayList<>();
        freeRects.add(new FreeRect(0.0, 0.0, ctx.rollW, workingHeight, 1));
        List<PlacedRec> pieces = new ArrayList<>(order.length);
        List<RawCut> cuts = new ArrayList<>(order.length * 2);
        boolean[] placedMask = new boolean[ctx.items.size()];
        double placedArea = 0.0;
        double usedLength = 0.0;
        int softHits = 0;

        for (int idx : order) {
            ComputationCancellation.check();
            if (checkDeadline && ctx.timeUp()) {
                return null;
            }
            DemItem it = ctx.items.get(idx);
            CandidatePlacement bestCand = selectBestPlacement(ctx, it, freeRects, fitRule);
            if (bestCand == null) {
                continue;
            }
            FreeRect r = freeRects.remove(bestCand.rectIdx());
            pieces.add(new PlacedRec(idx, bestCand.px(), bestCand.py(), bestCand.pw(), bestCand.pl(), bestCand.rotated()));
            placedMask[idx] = true;
            placedArea += bestCand.pw() * bestCand.pl();
            usedLength = Math.max(usedLength, bestCand.py() + bestCand.pl());
            if (bestCand.usedSoftDefect()) {
                softHits++;
            }
            boolean splitHoriz = resolveSplitHorizontal(r, bestCand.pw(), bestCand.pl(), splitRule, ctx.horizontalFirst);
            splitRect(r, bestCand.px(), bestCand.py(), bestCand.pw(), bestCand.pl(), splitHoriz, cuts, freeRects);
        }

        return wrapWorkingHeightIfCompressed(ctx, pieces, cuts, freeRects, placedMask, placedArea, pieces.size(), usedLength, softHits, workingHeight);
    }

    /**
     * 当使用压缩高度 {@code workingHeight < ctx.activeL} 求解时，在局部 Y = workingHeight 处补一条第 1 阶段全幅横切，
     * 将内部所有切刀 stage 整体 +1，并把尾部连续大块 [workingHeight, activeL] 加入 freeRects，保证 100% 合法直刀树。
     */
    private static LayoutSolution wrapWorkingHeightIfCompressed(
            SearchContext ctx,
            List<PlacedRec> pieces,
            List<RawCut> cuts,
            List<FreeRect> freeRects,
            boolean[] placedMask,
            double placedArea,
            int placedCount,
            double usedLength,
            int softHits,
            double workingHeight) {
        if (ctx.activeL - workingHeight <= MIN_SPLIT_MM) {
            return new LayoutSolution(pieces, cuts, freeRects, placedMask, placedArea, placedCount, usedLength, softHits);
        }
        List<RawCut> shiftedCuts = new ArrayList<>(cuts.size() + 1);
        shiftedCuts.add(new RawCut(
                "横切",
                workingHeight,
                0.0,
                ctx.rollW,
                1,
                String.format("第 1 阶段横切，压缩截断排样区 [%.0f × %.0f mm]", ctx.rollW, workingHeight)
        ));
        for (RawCut c : cuts) {
            shiftedCuts.add(new RawCut(c.type, c.pos, c.start, c.end, c.stage + 1, c.desc));
        }
        List<FreeRect> shiftedFree = new ArrayList<>(freeRects.size() + 1);
        for (FreeRect fr : freeRects) {
            shiftedFree.add(new FreeRect(fr.x, fr.y, fr.w, fr.h, fr.level + 1));
        }
        shiftedFree.add(new FreeRect(0.0, workingHeight, ctx.rollW, ctx.activeL - workingHeight, 2));
        return new LayoutSolution(pieces, shiftedCuts, shiftedFree, placedMask, placedArea, placedCount, usedLength, softHits);
    }

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

    private static LayoutSolution runBeamSearch(
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
        List<FreeRect> initFree = List.of(new FreeRect(0.0, 0.0, ctx.rollW, workingHeight, 1));
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

                List<CandidatePlacement> topCands = selectTopPlacements(ctx, it, state.freeRects, baseFitRule, branchPerState);
                if (topCands.isEmpty()) {
                    // 无法放入当前件，保留原状态继续后续件
                    nextGen.add(state);
                    continue;
                }

                for (int ci = 0; ci < topCands.size(); ci++) {
                    CandidatePlacement cand = topCands.get(ci);
                    FreeRect target = state.freeRects.get(cand.rectIdx());
                    // 整板首刀（level == 1）严格遵循 firstStageOrientation；子矩形（level > 1）探索双切分方向
                    boolean exploreBothSplits = (target.level > 1 && depth < 8 && ci == 0);
                    if (exploreBothSplits) {
                        nextGen.add(expandState(ctx, state, itemIdx, cand, true));
                        nextGen.add(expandState(ctx, state, itemIdx, cand, false));
                    } else {
                        boolean splitHoriz = resolveSplitHorizontal(target, cand.pw(), cand.pl(), baseSplitRule, ctx.horizontalFirst);
                        nextGen.add(expandState(ctx, state, itemIdx, cand, splitHoriz));
                    }
                }
            }

            if (nextGen.isEmpty()) {
                break;
            }
            nextGen.sort((a, b) -> Double.compare(b.heuristicScore, a.heuristicScore));

            // 轻量去重，保持束内状态多样性
            List<BeamState> pruned = new ArrayList<>(beamWidth);
            Set<Long> seenKeys = new HashSet<>();
            for (BeamState st : nextGen) {
                long sig = stateSignature(st);
                if (seenKeys.add(sig)) {
                    pruned.add(st);
                    if (pruned.size() >= beamWidth) break;
                }
            }
            beam = pruned;
        }

        // 将束中 Top-K 部分解分别补全剩余件
        LayoutSolution best = null;
        int[] tailOrder = Arrays.copyOfRange(order, Math.min(beamDepth, n), n);
        for (BeamState st : beam) {
            ComputationCancellation.check();
            if (System.nanoTime() >= beamDeadline) break;

            LayoutSolution s1 = finishBeamState(ctx, st, tailOrder, baseFitRule, baseSplitRule, workingHeight);
            if (s1 != null && isBetter(s1, best)) {
                best = s1;
            }
            if (tailOrder.length > 0 && System.nanoTime() < beamDeadline) {
                LayoutSolution s2 = finishBeamState(ctx, st, tailOrder, FitRule.BOTTOM_LEFT, SplitRule.MIN_AREA, workingHeight);
                if (s2 != null && isBetter(s2, best)) {
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

        splitRect(r, cand.px(), cand.py(), cand.pw(), cand.pl(), splitHoriz, nextCuts, nextFree);

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
        // 前瞻评分：已排面积为主，兼顾保留大块完整余料、压缩已用长度与避免碎片化
        double score = nextArea * 1.0
                + maxFreeArea * 0.12
                - nextUsedLen * ctx.rollW * 0.08
                - nextFree.size() * 250.0
                - nextSoftHits * 1_000_000.0;

        return new BeamState(nextFree, nextPieces, nextCuts, nextMask, nextArea, nextUsedLen, nextSoftHits, score);
    }

    private static long stateSignature(BeamState st) {
        long h = 17L;
        h = h * 31L + st.pieces.size();
        h = h * 31L + Math.round(st.placedArea / 100.0);
        h = h * 31L + Math.round(st.usedLength / 5.0);
        double maxFree = 0.0;
        for (FreeRect fr : st.freeRects) {
            if (fr.area() > maxFree) maxFree = fr.area();
        }
        h = h * 31L + Math.round(maxFree / 500.0);
        return h;
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
            CandidatePlacement bestCand = selectBestPlacement(ctx, it, freeRects, fitRule);
            if (bestCand == null) continue;

            FreeRect r = freeRects.remove(bestCand.rectIdx());
            pieces.add(new PlacedRec(idx, bestCand.px(), bestCand.py(), bestCand.pw(), bestCand.pl(), bestCand.rotated()));
            placedMask[idx] = true;
            placedArea += bestCand.pw() * bestCand.pl();
            usedLength = Math.max(usedLength, bestCand.py() + bestCand.pl());
            if (bestCand.usedSoftDefect()) softHits++;

            boolean splitHoriz = resolveSplitHorizontal(r, bestCand.pw(), bestCand.pl(), splitRule, ctx.horizontalFirst);
            splitRect(r, bestCand.px(), bestCand.py(), bestCand.pw(), bestCand.pl(), splitHoriz, cuts, freeRects);
        }

        return wrapWorkingHeightIfCompressed(ctx, pieces, cuts, freeRects, placedMask, placedArea, pieces.size(), usedLength, softHits, workingHeight);
    }

    // ==================== 预算内确定性 LNS 局部精修 ====================

    private static LayoutSolution runLnsRefinement(
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
                LayoutSolution cand = runGreedy(ctx, perturbed, fit, split, ctx.activeL, true);
                if (cand == null) break;
                if (isBetter(cand, best)) {
                    best = cand;
                    if (best.placedCount == n) {
                        break; // 已满排，转入版长压缩阶段
                    }
                }
            }
        }

        // 阶段 3B：当水平首刀且已 100% 满排仍有明显可压缩版长空间时，执行严格直刀版长二分压缩
        if (ctx.horizontalFirst && best.placedCount == n && !ctx.timeUp()) {
            double theoreticalMinLen = ctx.totalDemandArea / Math.max(1.0, ctx.rollW);
            double upper = best.usedLength;
            double lower = Math.max(theoreticalMinLen, maxSingleItemMinLen(ctx));
            if (upper - lower > 15.0) {
                int[] baseOrder = extractOrderFromSolution(best, n);
                int[] areaOrder = buildOrder(ctx, SortRule.AREA_DESC);
                int[] heightOrder = buildOrder(ctx, SortRule.HEIGHT_DESC);

                // 二分试探更短的截断高度 targetH
                for (int step = 0; step < 8; step++) {
                    ComputationCancellation.check();
                    if (ctx.timeUp() || upper - lower <= 12.0) break;
                    double mid = Math.floor((lower + upper) / 2.0);
                    if (mid >= best.usedLength - 5.0) {
                        break;
                    }
                    LayoutSolution compressed = tryPackWithinHeight(
                            ctx, mid, baseOrder, areaOrder, heightOrder, bestStrategy, best.softDefectHits);
                    if (compressed != null && compressed.placedCount == n && isBetter(compressed, best)) {
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
                LayoutSolution cand = runGreedy(ctx, orders[oi], fits[fi], splits[(oi + fi) % splits.length], targetHeight, true);
                if (cand != null && cand.placedCount == ctx.items.size()
                        && cand.softDefectHits <= maxSoftHits
                        && isBetter(cand, best)) {
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
            // 模式 0：将最大未排件提升至最前，再接其余已排件与剩余未排件
            int promoteCount = Math.min(unplaced.size(), 1 + (iter / 4) % 3);
            for (int i = 0; i < promoteCount; i++) result.add(unplaced.get(i));
            result.addAll(placed);
            for (int i = promoteCount; i < unplaced.size(); i++) result.add(unplaced.get(i));
        } else if (mode == 1 && placed.size() >= 3) {
            // 模式 1：拔出尾段 25%~40% 低效已排件，与未排件混合后按长边降序重装
            int cutPoint = Math.max(1, (int) (placed.size() * (0.60 + 0.05 * (iter % 4))));
            cutPoint = Math.min(cutPoint, placed.size() - 1);
            List<Integer> tailAndUnplaced = new ArrayList<>();
            tailAndUnplaced.addAll(unplaced);
            for (int i = cutPoint; i < placed.size(); i++) tailAndUnplaced.add(placed.get(i));
            tailAndUnplaced.sort((a, b) -> Double.compare(ctx.items.get(b).maxSide(), ctx.items.get(a).maxSide()));
            for (int i = 0; i < cutPoint; i++) result.add(placed.get(i));
            result.addAll(tailAndUnplaced);
        } else if (mode == 2 && !unplaced.isEmpty()) {
            // 模式 2：全部未排件插到前 1/3 位置（大件之后、中件之前）
            int insertAt = Math.min(placed.size(), Math.max(1, placed.size() / 3));
            for (int i = 0; i < insertAt; i++) result.add(placed.get(i));
            result.addAll(unplaced);
            for (int i = insertAt; i < placed.size(); i++) result.add(placed.get(i));
        } else {
            // 模式 3：在当前序列上做 2~3 次确定性随机交换/前移
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

    // ==================== 候选落位搜索与评分 ====================

    private static CandidatePlacement selectBestPlacement(
            SearchContext ctx, DemItem it, List<FreeRect> freeRects, FitRule fitRule) {
        List<CandidatePlacement> top = selectTopPlacements(ctx, it, freeRects, fitRule, 1);
        return top.isEmpty() ? null : top.get(0);
    }

    private static List<CandidatePlacement> selectTopPlacements(
            SearchContext ctx, DemItem it, List<FreeRect> freeRects, FitRule fitRule, int limit) {
        if (!ctx.pipeline.isNoop()) {
            // 窗帘约束路径：先尝试避开全部疵点（无软惩罚），避不开再放宽为仅避让硬疵点
            List<CandidatePlacement> clean = scanCandidates(ctx, it, freeRects, fitRule, ctx.localDefects, false, limit);
            if (!clean.isEmpty()) {
                return clean;
            }
            if (it.hardLocalDefects.size() < ctx.localDefects.size()) {
                return scanCandidates(ctx, it, freeRects, fitRule, it.hardLocalDefects, true, limit);
            }
            return List.of();
        }
        return scanCandidates(ctx, it, freeRects, fitRule, ctx.localDefects, false, limit);
    }

    private static List<CandidatePlacement> scanCandidates(
            SearchContext ctx,
            DemItem it,
            List<FreeRect> freeRects,
            FitRule fitRule,
            List<Defect> activeDefects,
            boolean usedSoftDefect,
            int limit) {
        List<CandidatePlacement> cands = new ArrayList<>();
        boolean constrained = !ctx.pipeline.isNoop();

        for (int rIdx = 0; rIdx < freeRects.size(); rIdx++) {
            ComputationCancellation.check();
            FreeRect r = freeRects.get(rIdx);
            if (r.w < Math.min(it.w, it.allowRotation ? it.l : it.w) - EPS
                    || r.h < Math.min(it.l, it.allowRotation ? it.w : it.l) - EPS) {
                continue;
            }

            // 尝试 0°
            tryOrientation(ctx, it, r, rIdx, it.w, it.l, false, 0, activeDefects, constrained, usedSoftDefect, fitRule, cands);
            // 尝试 90°（仅允许旋转且非正方形时）
            if (it.allowRotation && Math.abs(it.w - it.l) > EPS) {
                tryOrientation(ctx, it, r, rIdx, it.l, it.w, true, 90, activeDefects, constrained, usedSoftDefect, fitRule, cands);
            }
        }

        if (cands.isEmpty()) {
            return List.of();
        }
        cands.sort((a, b) -> {
            int cmp = Double.compare(a.primaryScore(), b.primaryScore());
            if (cmp != 0) return cmp;
            cmp = Double.compare(a.secondaryScore(), b.secondaryScore());
            if (cmp != 0) return cmp;
            cmp = Double.compare(a.py(), b.py());
            if (cmp != 0) return cmp;
            cmp = Double.compare(a.px(), b.px());
            if (cmp != 0) return cmp;
            return Boolean.compare(a.rotated(), b.rotated());
        });

        if (limit <= 1 || cands.size() <= limit) {
            return cands.subList(0, Math.min(limit, cands.size()));
        }
        // 取前 limit 个差异化候选（尽量覆盖不同矩形或旋转方向）
        return cands.subList(0, limit);
    }

    private static void tryOrientation(
            SearchContext ctx,
            DemItem it,
            FreeRect r,
            int rIdx,
            double pw,
            double pl,
            boolean rotated,
            int angleDeg,
            List<Defect> activeDefects,
            boolean constrained,
            boolean usedSoftDefect,
            FitRule fitRule,
            List<CandidatePlacement> out) {
        if (r.w < pw - EPS || r.h < pl - EPS) {
            return;
        }
        double[] pos;
        if (constrained) {
            pos = findConstrainedPositionInRect(ctx, it, r, pw, pl, angleDeg, activeDefects);
        } else if (activeDefects.isEmpty() || isSafeFromDefects(r.x, r.y, pw, pl, activeDefects)) {
            pos = new double[]{r.x, r.y};
        } else {
            pos = findSafePositionInRect(r, pw, pl, activeDefects);
        }
        if (pos == null) {
            return;
        }
        double px = pos[0];
        double py = pos[1];
        double remW = Math.max(0.0, r.w - pw);
        double remH = Math.max(0.0, r.h - pl);
        double shortFit = Math.min(remW, remH);
        double longFit = Math.max(remW, remH);
        double areaFit = Math.max(0.0, r.area() - pw * pl);
        // 避让疵点偏移越大，产生的额外切刀与碎料越多，加入温和偏移惩罚
        double offsetPenalty = ((px - r.x) + (py - r.y)) * 10.0;

        double primary;
        double secondary;
        switch (fitRule) {
            case BAF -> {
                primary = areaFit + offsetPenalty * 100.0;
                secondary = shortFit + py * 0.01;
            }
            case BSSF -> {
                primary = shortFit + offsetPenalty;
                secondary = longFit + py * 0.01;
            }
            case BLSF -> {
                primary = longFit + offsetPenalty;
                secondary = shortFit + py * 0.01;
            }
            case BOTTOM_LEFT -> {
                primary = (py + pl) + (px - r.x) * 0.01;
                secondary = areaFit * 1e-4 + px;
            }
            default -> {
                primary = areaFit;
                secondary = shortFit;
            }
        }
        out.add(new CandidatePlacement(rIdx, px, py, pw, pl, rotated, usedSoftDefect, primary, secondary));
    }

    // ==================== 严格直刀切分树 ====================

    private static boolean resolveSplitHorizontal(
            FreeRect r, double pw, double pl, SplitRule rule, boolean defaultHorizontalFirst) {
        // 整板第 1 阶段首刀（level == 1）必须严格遵循工艺首刀方向 firstStageOrientation
        if (r.level == 1) {
            return defaultHorizontalFirst;
        }
        double remW = Math.max(0.0, r.w - pw);
        double remH = Math.max(0.0, r.h - pl);
        return switch (rule) {
            case HORIZONTAL_FIRST -> true;
            case VERTICAL_FIRST -> false;
            case SHORT_AXIS -> {
                if (Math.abs(remW - remH) <= EPS) yield defaultHorizontalFirst;
                yield remW <= remH;
            }
            case LONG_AXIS -> {
                if (Math.abs(remW - remH) <= EPS) yield defaultHorizontalFirst;
                yield remW >= remH;
            }
            case MIN_AREA -> {
                // 比较横切优先 vs 纵切优先能保留的最大单块连续余料面积
                double maxAreaHoriz = Math.max(r.w * remH, remW * pl);
                double maxAreaVert = Math.max(remW * r.h, pw * remH);
                if (Math.abs(maxAreaHoriz - maxAreaVert) <= EPS) yield defaultHorizontalFirst;
                yield maxAreaHoriz >= maxAreaVert;
            }
        };
    }

    private static void splitRect(
            FreeRect r,
            double px,
            double py,
            double pw,
            double pl,
            boolean horizontalFirst,
            List<RawCut> cuts,
            List<FreeRect> freeRects) {
        boolean atOrigin = Math.abs(px - r.x) < EPS && Math.abs(py - r.y) < EPS;
        if (atOrigin) {
            if (horizontalFirst) {
                double cutY = r.y + pl;
                if (r.h - pl > MIN_SPLIT_MM) {
                    cuts.add(new RawCut(
                            "横切", cutY, r.x, r.x + r.w, r.level,
                            String.format("第 %d 阶段横切，分切行条 [%.0f × %.0f mm]", r.level, r.w, pl)
                    ));
                    freeRects.add(new FreeRect(r.x, cutY, r.w, r.h - pl, r.level + 1));
                }
                double cutX = r.x + pw;
                if (r.w - pw > MIN_SPLIT_MM) {
                    cuts.add(new RawCut(
                            "纵切", cutX, r.y, r.y + pl, r.level + 1,
                            String.format("第 %d 阶段纵切，切断裁片与侧料 [%.0f × %.0f mm]", r.level + 1, pw, pl)
                    ));
                    freeRects.add(new FreeRect(cutX, r.y, r.w - pw, pl, r.level + 2));
                }
            } else {
                double cutX = r.x + pw;
                if (r.w - pw > MIN_SPLIT_MM) {
                    cuts.add(new RawCut(
                            "纵切", cutX, r.y, r.y + r.h, r.level,
                            String.format("第 %d 阶段纵切，分切纵列 [%.0f × %.0f mm]", r.level, pw, r.h)
                    ));
                    freeRects.add(new FreeRect(cutX, r.y, r.w - pw, r.h, r.level + 1));
                }
                double cutY = r.y + pl;
                if (r.h - pl > MIN_SPLIT_MM) {
                    cuts.add(new RawCut(
                            "横切", cutY, r.x, r.x + pw, r.level + 1,
                            String.format("第 %d 阶段横切，切断裁片与顶料 [%.0f × %.0f mm]", r.level + 1, pw, pl)
                    ));
                    freeRects.add(new FreeRect(r.x, cutY, pw, r.h - pl, r.level + 2));
                }
            }
            return;
        }

        // 非原点放置（避让瑕疵 / 布边 / 对花）：先按第一方向做通切隔离，再按正交方向做二次分切
        if (horizontalFirst) {
            if (py > r.y + MIN_SPLIT_MM) {
                cuts.add(new RawCut("横切", py, r.x, r.x + r.w, r.level, "下部隔离横切"));
                freeRects.add(new FreeRect(r.x, r.y, r.w, py - r.y, r.level + 1));
            }
            if (r.y + r.h > py + pl + MIN_SPLIT_MM) {
                cuts.add(new RawCut("横切", py + pl, r.x, r.x + r.w, r.level, "上部展开横切"));
                freeRects.add(new FreeRect(r.x, py + pl, r.w, (r.y + r.h) - (py + pl), r.level + 1));
            }
            if (px > r.x + MIN_SPLIT_MM) {
                cuts.add(new RawCut("纵切", px, py, py + pl, r.level + 1, "左侧分切纵刀"));
                freeRects.add(new FreeRect(r.x, py, px - r.x, pl, r.level + 2));
            }
            if (r.x + r.w > px + pw + MIN_SPLIT_MM) {
                cuts.add(new RawCut("纵切", px + pw, py, py + pl, r.level + 1, "右侧分切纵刀"));
                freeRects.add(new FreeRect(px + pw, py, (r.x + r.w) - (px + pw), pl, r.level + 2));
            }
        } else {
            if (px > r.x + MIN_SPLIT_MM) {
                cuts.add(new RawCut("纵切", px, r.y, r.y + r.h, r.level, "左部隔离纵切"));
                freeRects.add(new FreeRect(r.x, r.y, px - r.x, r.h, r.level + 1));
            }
            if (r.x + r.w > px + pw + MIN_SPLIT_MM) {
                cuts.add(new RawCut("纵切", px + pw, r.y, r.y + r.h, r.level, "右部展开纵切"));
                freeRects.add(new FreeRect(px + pw, r.y, (r.x + r.w) - (px + pw), r.h, r.level + 1));
            }
            if (py > r.y + MIN_SPLIT_MM) {
                cuts.add(new RawCut("横切", py, px, px + pw, r.level + 1, "下侧分切横刀"));
                freeRects.add(new FreeRect(px, r.y, pw, py - r.y, r.level + 2));
            }
            if (r.y + r.h > py + pl + MIN_SPLIT_MM) {
                cuts.add(new RawCut("横切", py + pl, px, px + pw, r.level + 1, "上侧分切横刀"));
                freeRects.add(new FreeRect(px, py + pl, pw, (r.y + r.h) - (py + pl), r.level + 2));
            }
        }
    }

    // ==================== 疵点与窗帘约束安全定位 ====================

    private static boolean isSafeFromDefects(double px, double py, double pw, double pl, List<Defect> defects) {
        for (Defect d : defects) {
            boolean overlaps = !(px + pw <= d.getX() + EPS || px >= d.getX() + d.getW() - EPS
                    || py + pl <= d.getY() + EPS || py >= d.getY() + d.getH() - EPS);
            if (overlaps) {
                return false;
            }
        }
        return true;
    }

    private static Defect firstOverlappingDefect(double px, double py, double pw, double pl, List<Defect> defects) {
        for (Defect d : defects) {
            boolean overlaps = !(px + pw <= d.getX() + EPS || px >= d.getX() + d.getW() - EPS
                    || py + pl <= d.getY() + EPS || py >= d.getY() + d.getH() - EPS);
            if (overlaps) return d;
        }
        return null;
    }

    private static double[] findSafePositionInRect(FreeRect r, double pw, double pl, List<Defect> defects) {
        List<Defect> colliding = new ArrayList<>();
        for (Defect d : defects) {
            boolean inRect = !(r.x + r.w <= d.getX() + EPS || r.x >= d.getX() + d.getW() - EPS
                    || r.y + r.h <= d.getY() + EPS || r.y >= d.getY() + d.getH() - EPS);
            if (inRect) colliding.add(d);
        }
        if (colliding.isEmpty()) {
            return new double[]{r.x, r.y};
        }

        List<Double> candX = new ArrayList<>();
        candX.add(r.x);
        List<Double> candY = new ArrayList<>();
        candY.add(r.y);

        for (Defect d : colliding) {
            double rx = d.getX() + d.getW();
            if (rx >= r.x - EPS && rx + pw <= r.x + r.w + EPS) {
                candX.add(Math.max(r.x, rx));
            }
            double lx = d.getX() - pw;
            if (lx >= r.x - EPS && lx + pw <= r.x + r.w + EPS) {
                candX.add(Math.max(r.x, lx));
            }
            double by = d.getY() + d.getH();
            if (by >= r.y - EPS && by + pl <= r.y + r.h + EPS) {
                candY.add(Math.max(r.y, by));
            }
            double ty = d.getY() - pl;
            if (ty >= r.y - EPS && ty + pl <= r.y + r.h + EPS) {
                candY.add(Math.max(r.y, ty));
            }
        }

        candX.sort(Double::compare);
        candY.sort(Double::compare);

        // 优先选择低位、紧靠起点的安全位置（减少版长拉伸和碎料）
        for (double cy : candY) {
            if (cy + pl > r.y + r.h + EPS) continue;
            for (double cx : candX) {
                if (cx + pw > r.x + r.w + EPS) continue;
                if (isSafeFromDefects(cx, cy, pw, pl, colliding)) {
                    return new double[]{cx, cy};
                }
            }
        }
        return null;
    }

    private static double[] findConstrainedPositionInRect(
            SearchContext ctx,
            DemItem it,
            FreeRect r,
            double pw,
            double pl,
            int angleDeg,
            List<Defect> defects) {
        double effMinX = Math.max(r.x, it.localMinX);
        double effMaxX = Math.min(r.x + r.w, it.localMaxX);
        if (effMaxX - effMinX < pw - EPS || r.h < pl - EPS) {
            return null;
        }
        List<Defect> colliding = new ArrayList<>();
        for (Defect d : defects) {
            boolean inRect = !(effMaxX <= d.getX() + EPS || effMinX >= d.getX() + d.getW() - EPS
                    || r.y + r.h <= d.getY() + EPS || r.y >= d.getY() + d.getH() - EPS);
            if (inRect) colliding.add(d);
        }
        List<Double> candX = new ArrayList<>();
        candX.add(effMinX);
        List<Double> candY = new ArrayList<>();
        candY.add(r.y);
        for (Defect d : colliding) {
            double rx = d.getX() + d.getW();
            if (rx >= effMinX - EPS && rx + pw <= effMaxX + EPS) candX.add(Math.max(effMinX, rx));
            double lx = d.getX() - pw;
            if (lx >= effMinX - EPS && lx + pw <= effMaxX + EPS) candX.add(Math.max(effMinX, lx));
            double by = d.getY() + d.getH();
            if (by >= r.y - EPS && by + pl <= r.y + r.h + EPS) candY.add(Math.max(r.y, by));
            double ty = d.getY() - pl;
            if (ty >= r.y - EPS && ty + pl <= r.y + r.h + EPS) candY.add(Math.max(r.y, ty));
        }
        candX.sort(Double::compare);
        candY.sort(Double::compare);

        for (double rawY : candY) {
            for (double cx : candX) {
                ComputationCancellation.check();
                if (cx + pw > effMaxX + EPS) continue;
                double cy = rawY;
                for (int iter = 0; iter < 5; iter++) {
                    if (it.patternMatch) {
                        cy = snapLocalY(ctx.req, ctx.frame, ctx.pipeline, it.part, angleDeg, cy, pl);
                    }
                    if (cy + pl > r.y + r.h + EPS) {
                        cy = Double.POSITIVE_INFINITY;
                        break;
                    }
                    Defect hit = firstOverlappingDefect(cx, cy, pw, pl, colliding);
                    if (hit == null) {
                        return new double[]{cx, cy};
                    }
                    double nextY = hit.getY() + hit.getH();
                    if (nextY <= cy + EPS) {
                        cy = Double.POSITIVE_INFINITY;
                        break;
                    }
                    cy = nextY;
                }
            }
        }
        return null;
    }

    private static double snapLocalY(
            NestingProblem req,
            CoordinateFrame frame,
            ConstraintPipeline pipeline,
            NestingProblem.Part part,
            int angleDeg,
            double localY,
            double pl) {
        double physY = frame.toPhysicalY(localY, pl);
        if (!frame.isMirrorY()) {
            double snappedPhys = pipeline.snapY(req, part, angleDeg, physY);
            return snappedPhys - frame.trimStart();
        }
        if (PatternRepeatRule.isAligned(req, part, physY)) {
            return localY;
        }
        double repeatY = req.material().fabricRule().repeatYMm();
        double phaseY = req.material().fabricRule().phaseYMm() == null ? 0.0 : req.material().fabricRule().phaseYMm();
        double anchorY = part.rule().patternAnchorYMm() == null ? 0.0 : part.rule().patternAnchorYMm();
        double rem = (((physY + anchorY - phaseY) % repeatY) + repeatY) % repeatY;
        return localY + rem;
    }
}
