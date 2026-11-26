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
import java.util.TreeSet;
import java.util.concurrent.Callable;

/**
 * 自主二维直刀（Guillotine）核心搜索内核：
 * <ol>
 *   <li>确定性多起点启发式池（多维排序 × 多种空间匹配 × 多种正交切分），复用 {@link NestingParallelExecutor} 有界并行；</li>
 *   <li>有界 Beam Search（束搜索）+ 真实布局指纹去重与差异化候选筛选，避免首步贪心锁死后续大件空间；</li>
 *   <li>预算内确定性 LNS 局部精修（未排件前置重装、尾段拔出换序重排，以及水平/垂直首刀全支持的严格直刀版长二分压缩）；</li>
 *   <li>原生支持每刀 {@code kerf} 刀缝扣除、矩形原生 {@code pieceGap} 间距内缩、可选 {@code maxStages} 最大通切阶数限制，
 *       以及双轴对格/旋转锚点/同组倒顺毛约束。</li>
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
        final boolean axisHorizontal;

        FreeRect(double x, double y, double w, double h, int level, boolean axisHorizontal) {
            this.x = x;
            this.y = y;
            this.w = w;
            this.h = h;
            this.level = level;
            this.axisHorizontal = axisHorizontal;
        }

        FreeRect(double x, double y, double w, double h, int level) {
            this(x, y, w, h, level, true);
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
        final boolean patternMatchX;
        final boolean patternMatchY;

        DemItem(int id, String name, double w, double l, boolean allowRotation, Integer demandId,
                NestingProblem.Part part, double localMinX, double localMaxX,
                List<Defect> hardLocalDefects, boolean patternMatch) {
            this(id, name, w, l, allowRotation, demandId, part, localMinX, localMaxX,
                    hardLocalDefects, patternMatch, false, patternMatch);
        }

        DemItem(int id, String name, double w, double l, boolean allowRotation, Integer demandId,
                NestingProblem.Part part, double localMinX, double localMaxX,
                List<Defect> hardLocalDefects, boolean patternMatch, boolean patternMatchX, boolean patternMatchY) {
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
            this.patternMatchX = patternMatchX;
            this.patternMatchY = patternMatchY;
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
        final double kerf;
        final double pieceGap;
        final double cutSpacing;
        final Integer maxStages;
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
            this.kerf = Math.max(0.0, req.process().kerf());
            this.pieceGap = Math.max(0.0, req.process().pieceGap());
            this.cutSpacing = Math.max(this.kerf, this.pieceGap);
            this.maxStages = req.process().maxStages();
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
                    List.of(new FreeRect(0, 0, rollW, activeL, 1, horizontalFirst)),
                    new boolean[0], 0.0, 0, 0.0, 0
            );
        }

        long now = System.nanoTime();
        long limitMs = Math.max(150L, (long) Math.max(1, req.timeLimitSeconds()) * 1000L);
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

        // 2. 有界 Beam Search（真实布局指纹去重，打破首刀/前步贪心锁死）
        long beamDeadline = now + (long) (searchBudgetMs * 0.55) * 1_000_000L;
        if (!ctx.timeUp() && System.nanoTime() < beamDeadline && items.size() >= 2) {
            int[] primaryOrder = buildOrder(ctx, bestStrategy.sortRule());
            LayoutSolution beamBest = runBeamSearch(ctx, primaryOrder, bestStrategy.fitRule(), bestStrategy.splitRule(), activeL, beamDeadline);
            if (beamBest != null && isBetter(beamBest, best)) {
                best = beamBest;
            }
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

        // 3. 预算内确定性 LNS 局部重排精修与水平/垂直首刀版长二分压缩
        if (best != null && !ctx.timeUp()) {
            best = runLnsRefinement(ctx, best, bestStrategy);
        }

        return best != null ? best : new LayoutSolution(
                List.of(), List.of(),
                List.of(new FreeRect(0, 0, rollW, activeL, 1, horizontalFirst)),
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
        freeRects.add(new FreeRect(0.0, 0.0, ctx.rollW, workingHeight, 1, ctx.horizontalFirst));
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
            boolean splitHoriz = resolveSplitHorizontal(ctx, r, bestCand.px(), bestCand.py(), bestCand.pw(), bestCand.pl(), splitRule);
            splitRect(ctx, r, bestCand.px(), bestCand.py(), bestCand.pw(), bestCand.pl(), splitHoriz, cuts, freeRects);
        }

        return wrapWorkingHeightIfCompressed(ctx, pieces, cuts, freeRects, placedMask, placedArea, pieces.size(), usedLength, softHits, workingHeight);
    }

    /**
     * 当使用压缩高度 {@code workingHeight < ctx.activeL} 求解时，将其严格合法地嵌入整板 {@code [0, ctx.activeL]}：
     * <ul>
     *   <li>水平首刀：在 {@code Y = workingHeight + kerf/2} 补一条第 1 阶段全幅横切（与同向第 1 阶横切平行，不额外升阶），
     *       并加入尾部大块余料；</li>
     *   <li>垂直首刀：将全部第 1 阶段垂直纵切延伸至 {@code ctx.activeL}，对含裁片的垂直列在
     *       {@code Y = workingHeight + kerf/2} 处补第 2 阶段列内横切截断，纯空列直接纵向贯通延伸至 {@code ctx.activeL}。</li>
     * </ul>
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
        if (ctx.horizontalFirst) {
            List<RawCut> outCuts = new ArrayList<>(cuts.size() + 1);
            double cutY = Math.min(ctx.activeL - EPS, workingHeight + ctx.kerf * 0.5);
            outCuts.add(new RawCut(
                    "横切",
                    cutY,
                    0.0,
                    ctx.rollW,
                    1,
                    String.format("第 1 阶段横切，压缩截断排样区 [%.0f × %.0f mm]", ctx.rollW, workingHeight)
            ));
            outCuts.addAll(cuts);
            List<FreeRect> outFree = new ArrayList<>(freeRects.size() + 1);
            outFree.addAll(freeRects);
            double tailY = workingHeight + ctx.cutSpacing;
            if (ctx.activeL - tailY > MIN_SPLIT_MM) {
                outFree.add(new FreeRect(0.0, tailY, ctx.rollW, ctx.activeL - tailY, 1, true));
            }
            return new LayoutSolution(pieces, outCuts, outFree, placedMask, placedArea, placedCount, usedLength, softHits);
        }

        // 垂直首刀压缩：要求 maxStages 未限制为 1（需要第 2 阶段列内横切截断）且至少存在第 1 阶段纵切
        if (ctx.maxStages != null && ctx.maxStages < 2) {
            return null;
        }
        TreeSet<Double> stage1VertX = new TreeSet<>();
        for (RawCut c : cuts) {
            if (c.stage == 1 && "纵切".equals(c.type)) {
                stage1VertX.add(c.pos);
            }
        }
        if (stage1VertX.isEmpty()) {
            return null;
        }

        List<RawCut> outCuts = new ArrayList<>(cuts.size() + stage1VertX.size() + 1);
        for (RawCut c : cuts) {
            if (c.stage == 1 && "纵切".equals(c.type)) {
                outCuts.add(new RawCut("纵切", c.pos, 0.0, ctx.activeL, 1, c.desc));
            } else {
                outCuts.add(c);
            }
        }

        List<Double> boundaries = new ArrayList<>(stage1VertX.size() + 2);
        boundaries.add(0.0);
        boundaries.addAll(stage1VertX);
        boundaries.add(ctx.rollW);

        List<FreeRect> outFree = new ArrayList<>(freeRects.size() + boundaries.size());
        Set<Integer> extendedFullEmptyCols = new HashSet<>();
        for (FreeRect fr : freeRects) {
            // 若某空闲矩形横跨某整列高度 [0, workingHeight]，直接拉通至 activeL 形成整条垂直大余料
            int colIdx = findFullHeightColumnIndex(fr, boundaries, workingHeight, ctx.kerf);
            if (colIdx >= 0) {
                extendedFullEmptyCols.add(colIdx);
                outFree.add(new FreeRect(fr.x, 0.0, fr.w, ctx.activeL, fr.level, fr.axisHorizontal));
            } else {
                outFree.add(fr);
            }
        }

        double cutY = Math.min(ctx.activeL - EPS, workingHeight + ctx.kerf * 0.5);
        double tailY = workingHeight + ctx.cutSpacing;
        for (int ci = 0; ci < boundaries.size() - 1; ci++) {
            if (extendedFullEmptyCols.contains(ci)) {
                continue;
            }
            double colCutStart = boundaries.get(ci);
            double colCutEnd = boundaries.get(ci + 1);
            if (colCutEnd - colCutStart <= MIN_SPLIT_MM) {
                continue;
            }
            outCuts.add(new RawCut(
                    "横切",
                    cutY,
                    colCutStart,
                    colCutEnd,
                    2,
                    String.format("第 2 阶段列内横切，垂直首刀压缩截断 [X=%.0f~%.0f mm, Y=%.0f mm]", colCutStart, colCutEnd, workingHeight)
            ));
            double innerStart = ci == 0 ? 0.0 : (colCutStart + ctx.cutSpacing - ctx.kerf * 0.5);
            double innerEnd = (ci == boundaries.size() - 2) ? ctx.rollW : (colCutEnd - ctx.kerf * 0.5);
            if (innerEnd - innerStart > MIN_SPLIT_MM && ctx.activeL - tailY > MIN_SPLIT_MM) {
                outFree.add(new FreeRect(innerStart, tailY, innerEnd - innerStart, ctx.activeL - tailY, 2, true));
            }
        }

        return new LayoutSolution(pieces, outCuts, outFree, placedMask, placedArea, placedCount, usedLength, softHits);
    }

    private static int findFullHeightColumnIndex(FreeRect fr, List<Double> boundaries, double workingHeight, double kerf) {
        if (Math.abs(fr.y) > MIN_SPLIT_MM || Math.abs(fr.h - workingHeight) > MIN_SPLIT_MM) {
            return -1;
        }
        double tol = Math.max(MIN_SPLIT_MM, kerf + 0.5);
        for (int i = 0; i < boundaries.size() - 1; i++) {
            double cStart = boundaries.get(i);
            double cEnd = boundaries.get(i + 1);
            if (fr.x >= cStart - tol && fr.x + fr.w <= cEnd + tol && fr.w >= (cEnd - cStart) - tol * 2.0) {
                return i;
            }
        }
        return -1;
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

                List<CandidatePlacement> topCands = selectTopPlacements(ctx, it, state.freeRects, baseFitRule, branchPerState);
                if (topCands.isEmpty()) {
                    nextGen.add(state);
                    continue;
                }

                for (int ci = 0; ci < topCands.size(); ci++) {
                    CandidatePlacement cand = topCands.get(ci);
                    FreeRect target = state.freeRects.get(cand.rectIdx());
                    boolean canHoriz = isSplitAllowedByMaxStages(ctx, target, cand.px(), cand.py(), cand.pw(), cand.pl(), true);
                    boolean canVert = isSplitAllowedByMaxStages(ctx, target, cand.px(), cand.py(), cand.pw(), cand.pl(), false);
                    boolean exploreBothSplits = (target.level > 1 && depth < 8 && ci == 0 && canHoriz && canVert);
                    if (exploreBothSplits) {
                        nextGen.add(expandState(ctx, state, itemIdx, cand, true));
                        nextGen.add(expandState(ctx, state, itemIdx, cand, false));
                    } else {
                        boolean splitHoriz = resolveSplitHorizontal(ctx, target, cand.px(), cand.py(), cand.pw(), cand.pl(), baseSplitRule);
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

        splitRect(ctx, r, cand.px(), cand.py(), cand.pw(), cand.pl(), splitHoriz, nextCuts, nextFree);

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
            CandidatePlacement bestCand = selectBestPlacement(ctx, it, freeRects, fitRule);
            if (bestCand == null) continue;

            FreeRect r = freeRects.remove(bestCand.rectIdx());
            pieces.add(new PlacedRec(idx, bestCand.px(), bestCand.py(), bestCand.pw(), bestCand.pl(), bestCand.rotated()));
            placedMask[idx] = true;
            placedArea += bestCand.pw() * bestCand.pl();
            usedLength = Math.max(usedLength, bestCand.py() + bestCand.pl());
            if (bestCand.usedSoftDefect()) softHits++;

            boolean splitHoriz = resolveSplitHorizontal(ctx, r, bestCand.px(), bestCand.py(), bestCand.pw(), bestCand.pl(), splitRule);
            splitRect(ctx, r, bestCand.px(), bestCand.py(), bestCand.pw(), bestCand.pl(), splitHoriz, cuts, freeRects);
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
                int[] areaOrder = buildOrder(ctx, SortRule.AREA_DESC);
                int[] heightOrder = buildOrder(ctx, SortRule.HEIGHT_DESC);

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

    // ==================== 候选落位搜索与差异化去重 ====================

    private static CandidatePlacement selectBestPlacement(
            SearchContext ctx, DemItem it, List<FreeRect> freeRects, FitRule fitRule) {
        List<CandidatePlacement> top = selectTopPlacements(ctx, it, freeRects, fitRule, 1);
        return top.isEmpty() ? null : top.get(0);
    }

    private static List<CandidatePlacement> selectTopPlacements(
            SearchContext ctx, DemItem it, List<FreeRect> freeRects, FitRule fitRule, int limit) {
        if (!ctx.pipeline.isNoop()) {
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

            tryOrientation(ctx, it, r, rIdx, it.w, it.l, false, 0, activeDefects, constrained, usedSoftDefect, fitRule, cands);
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

        if (limit <= 1 || cands.size() <= 1) {
            return List.of(cands.get(0));
        }

        // 基于真实候选落位指纹（矩形桶位 + 旋转方向 + 几何位置）选取差异化 Top-K，而非简单 subList
        List<CandidatePlacement> diverse = new ArrayList<>(limit);
        Set<Long> seenPosKeys = new HashSet<>(limit * 2);
        Set<Integer> seenRectRot = new HashSet<>(limit * 2);
        List<CandidatePlacement> remainder = new ArrayList<>();

        for (CandidatePlacement cp : cands) {
            long posKey = candidatePositionFingerprint(cp);
            if (!seenPosKeys.add(posKey)) {
                continue;
            }
            int rectRotKey = (cp.rectIdx() << 1) | (cp.rotated() ? 1 : 0);
            if (seenRectRot.add(rectRotKey)) {
                diverse.add(cp);
                if (diverse.size() >= limit) return diverse;
            } else {
                remainder.add(cp);
            }
        }
        for (CandidatePlacement cp : remainder) {
            diverse.add(cp);
            if (diverse.size() >= limit) break;
        }
        return diverse;
    }

    private static long candidatePositionFingerprint(CandidatePlacement cp) {
        long rx = Math.round(cp.px() * 10.0) & 0xFFFFFL;
        long ry = Math.round(cp.py() * 10.0) & 0xFFFFFL;
        long rw = Math.round(cp.pw() * 10.0) & 0xFFFFL;
        return (rx << 40) | (ry << 20) | (rw << 1) | (cp.rotated() ? 1L : 0L);
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

        // 严格 maxStages 门控：至少存在一种合法切分方向不超过最大通切阶数
        if (ctx.maxStages != null) {
            boolean okHoriz = isSplitAllowedByMaxStages(ctx, r, px, py, pw, pl, true);
            boolean okVert = isSplitAllowedByMaxStages(ctx, r, px, py, pw, pl, false);
            boolean allowed = (r.level == 1)
                    ? (ctx.horizontalFirst ? okHoriz : okVert)
                    : (okHoriz || okVert);
            if (!allowed) {
                return;
            }
        }

        double remW = Math.max(0.0, r.w - pw);
        double remH = Math.max(0.0, r.h - pl);
        double shortFit = Math.min(remW, remH);
        double longFit = Math.max(remW, remH);
        double areaFit = Math.max(0.0, r.area() - pw * pl);
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

    // ==================== 严格直刀切分树（含 kerf、pieceGap 与 k-stage 阶数模型） ====================

    private static int[] computeCutStages(FreeRect r, double px, double py, double pw, double pl, boolean splitHoriz) {
        boolean needFirst;
        boolean needSecond;
        if (splitHoriz) {
            needFirst = (py > r.y + MIN_SPLIT_MM) || (r.y + r.h > py + pl + MIN_SPLIT_MM);
            needSecond = (px > r.x + MIN_SPLIT_MM) || (r.x + r.w > px + pw + MIN_SPLIT_MM);
        } else {
            needFirst = (px > r.x + MIN_SPLIT_MM) || (r.x + r.w > px + pw + MIN_SPLIT_MM);
            needSecond = (py > r.y + MIN_SPLIT_MM) || (r.y + r.h > py + pl + MIN_SPLIT_MM);
        }
        int stage1 = (splitHoriz == r.axisHorizontal) ? r.level : (r.level + 1);
        int stage2;
        if (needFirst) {
            stage2 = stage1 + 1;
        } else if (r.level == 1 && splitHoriz == r.axisHorizontal) {
            // 整板首阶未切第一刀时，正交方向仍归入第 2 阶以严守 firstStageOrientation
            stage2 = 2;
        } else {
            stage2 = (!splitHoriz == r.axisHorizontal) ? r.level : (r.level + 1);
        }
        int maxStage = needSecond ? stage2 : (needFirst ? stage1 : 0);
        return new int[]{stage1, stage2, maxStage};
    }

    private static boolean isSplitAllowedByMaxStages(
            SearchContext ctx, FreeRect r, double px, double py, double pw, double pl, boolean splitHoriz) {
        if (ctx.maxStages == null) return true;
        if (r.level == 1 && splitHoriz != ctx.horizontalFirst) return false;
        int maxStage = computeCutStages(r, px, py, pw, pl, splitHoriz)[2];
        return maxStage <= ctx.maxStages;
    }

    private static boolean resolveSplitHorizontal(
            SearchContext ctx, FreeRect r, double px, double py, double pw, double pl, SplitRule rule) {
        if (r.level == 1) {
            return ctx.horizontalFirst;
        }
        double remW = Math.max(0.0, r.w - pw);
        double remH = Math.max(0.0, r.h - pl);
        boolean preferred = switch (rule) {
            case HORIZONTAL_FIRST -> true;
            case VERTICAL_FIRST -> false;
            case SHORT_AXIS -> Math.abs(remW - remH) <= EPS ? ctx.horizontalFirst : remW <= remH;
            case LONG_AXIS -> Math.abs(remW - remH) <= EPS ? ctx.horizontalFirst : remW >= remH;
            case MIN_AREA -> {
                double maxAreaHoriz = Math.max(r.w * remH, remW * pl);
                double maxAreaVert = Math.max(remW * r.h, pw * remH);
                yield Math.abs(maxAreaHoriz - maxAreaVert) <= EPS ? ctx.horizontalFirst : maxAreaHoriz >= maxAreaVert;
            }
        };
        if (ctx.maxStages != null) {
            boolean prefOk = isSplitAllowedByMaxStages(ctx, r, px, py, pw, pl, preferred);
            if (!prefOk && isSplitAllowedByMaxStages(ctx, r, px, py, pw, pl, !preferred)) {
                return !preferred;
            }
        }
        return preferred;
    }

    private static void splitRect(
            SearchContext ctx,
            FreeRect r,
            double px,
            double py,
            double pw,
            double pl,
            boolean horizontalFirst,
            List<RawCut> cuts,
            List<FreeRect> freeRects) {
        int[] stages = computeCutStages(r, px, py, pw, pl, horizontalFirst);
        int stage1 = stages[0];
        int stage2 = stages[1];
        double kerf = ctx.kerf;
        double spacing = ctx.cutSpacing;
        boolean atOrigin = Math.abs(px - r.x) < EPS && Math.abs(py - r.y) < EPS;

        if (atOrigin) {
            if (horizontalFirst) {
                if (r.h - pl > MIN_SPLIT_MM) {
                    double cutY = Math.min(r.y + r.h - EPS, r.y + pl + kerf * 0.5);
                    cuts.add(new RawCut(
                            "横切", cutY, r.x, r.x + r.w, stage1,
                            String.format("第 %d 阶段横切，分切行条 [%.0f × %.0f mm]", stage1, r.w, pl)
                    ));
                    double nextY = r.y + pl + spacing;
                    double nextH = (r.y + r.h) - nextY;
                    if (nextH > MIN_SPLIT_MM) {
                        freeRects.add(new FreeRect(r.x, nextY, r.w, nextH, stage1, true));
                    }
                }
                if (r.w - pw > MIN_SPLIT_MM) {
                    double cutX = Math.min(r.x + r.w - EPS, r.x + pw + kerf * 0.5);
                    cuts.add(new RawCut(
                            "纵切", cutX, r.y, r.y + pl, stage2,
                            String.format("第 %d 阶段纵切，切断裁片与侧料 [%.0f × %.0f mm]", stage2, pw, pl)
                    ));
                    double nextX = r.x + pw + spacing;
                    double nextW = (r.x + r.w) - nextX;
                    if (nextW > MIN_SPLIT_MM) {
                        freeRects.add(new FreeRect(nextX, r.y, nextW, pl, stage2, false));
                    }
                }
            } else {
                if (r.w - pw > MIN_SPLIT_MM) {
                    double cutX = Math.min(r.x + r.w - EPS, r.x + pw + kerf * 0.5);
                    cuts.add(new RawCut(
                            "纵切", cutX, r.y, r.y + r.h, stage1,
                            String.format("第 %d 阶段纵切，分切纵列 [%.0f × %.0f mm]", stage1, pw, r.h)
                    ));
                    double nextX = r.x + pw + spacing;
                    double nextW = (r.x + r.w) - nextX;
                    if (nextW > MIN_SPLIT_MM) {
                        freeRects.add(new FreeRect(nextX, r.y, nextW, r.h, stage1, false));
                    }
                }
                if (r.h - pl > MIN_SPLIT_MM) {
                    double cutY = Math.min(r.y + r.h - EPS, r.y + pl + kerf * 0.5);
                    cuts.add(new RawCut(
                            "横切", cutY, r.x, r.x + pw, stage2,
                            String.format("第 %d 阶段横切，切断裁片与顶料 [%.0f × %.0f mm]", stage2, pw, pl)
                    ));
                    double nextY = r.y + pl + spacing;
                    double nextH = (r.y + r.h) - nextY;
                    if (nextH > MIN_SPLIT_MM) {
                        freeRects.add(new FreeRect(r.x, nextY, pw, nextH, stage2, true));
                    }
                }
            }
            return;
        }

        // 非原点放置（避让瑕疵 / 布边 / 双轴对格）：先按第一方向做通切隔离，再按正交方向做二次分切
        if (horizontalFirst) {
            if (py > r.y + MIN_SPLIT_MM) {
                double cutY = Math.max(r.y + EPS, py - kerf * 0.5);
                cuts.add(new RawCut("横切", cutY, r.x, r.x + r.w, stage1, "下部隔离横切"));
                double botH = py - r.y - spacing;
                if (botH > MIN_SPLIT_MM) {
                    freeRects.add(new FreeRect(r.x, r.y, r.w, botH, stage1, true));
                }
            }
            if (r.y + r.h > py + pl + MIN_SPLIT_MM) {
                double cutY = Math.min(r.y + r.h - EPS, py + pl + kerf * 0.5);
                cuts.add(new RawCut("横切", cutY, r.x, r.x + r.w, stage1, "上部展开横切"));
                double topY = py + pl + spacing;
                double topH = (r.y + r.h) - topY;
                if (topH > MIN_SPLIT_MM) {
                    freeRects.add(new FreeRect(r.x, topY, r.w, topH, stage1, true));
                }
            }
            if (px > r.x + MIN_SPLIT_MM) {
                double cutX = Math.max(r.x + EPS, px - kerf * 0.5);
                cuts.add(new RawCut("纵切", cutX, py, py + pl, stage2, "左侧分切纵刀"));
                double leftW = px - r.x - spacing;
                if (leftW > MIN_SPLIT_MM) {
                    freeRects.add(new FreeRect(r.x, py, leftW, pl, stage2, false));
                }
            }
            if (r.x + r.w > px + pw + MIN_SPLIT_MM) {
                double cutX = Math.min(r.x + r.w - EPS, px + pw + kerf * 0.5);
                cuts.add(new RawCut("纵切", cutX, py, py + pl, stage2, "右侧分切纵刀"));
                double rightX = px + pw + spacing;
                double rightW = (r.x + r.w) - rightX;
                if (rightW > MIN_SPLIT_MM) {
                    freeRects.add(new FreeRect(rightX, py, rightW, pl, stage2, false));
                }
            }
        } else {
            if (px > r.x + MIN_SPLIT_MM) {
                double cutX = Math.max(r.x + EPS, px - kerf * 0.5);
                cuts.add(new RawCut("纵切", cutX, r.y, r.y + r.h, stage1, "左部隔离纵切"));
                double leftW = px - r.x - spacing;
                if (leftW > MIN_SPLIT_MM) {
                    freeRects.add(new FreeRect(r.x, r.y, leftW, r.h, stage1, false));
                }
            }
            if (r.x + r.w > px + pw + MIN_SPLIT_MM) {
                double cutX = Math.min(r.x + r.w - EPS, px + pw + kerf * 0.5);
                cuts.add(new RawCut("纵切", cutX, r.y, r.y + r.h, stage1, "右部展开纵切"));
                double rightX = px + pw + spacing;
                double rightW = (r.x + r.w) - rightX;
                if (rightW > MIN_SPLIT_MM) {
                    freeRects.add(new FreeRect(rightX, r.y, rightW, r.h, stage1, false));
                }
            }
            if (py > r.y + MIN_SPLIT_MM) {
                double cutY = Math.max(r.y + EPS, py - kerf * 0.5);
                cuts.add(new RawCut("横切", cutY, px, px + pw, stage2, "下侧分切横刀"));
                double botH = py - r.y - spacing;
                if (botH > MIN_SPLIT_MM) {
                    freeRects.add(new FreeRect(px, r.y, pw, botH, stage2, true));
                }
            }
            if (r.y + r.h > py + pl + MIN_SPLIT_MM) {
                double cutY = Math.min(r.y + r.h - EPS, py + pl + kerf * 0.5);
                cuts.add(new RawCut("横切", cutY, px, px + pw, stage2, "上侧分切横刀"));
                double topY = py + pl + spacing;
                double topH = (r.y + r.h) - topY;
                if (topH > MIN_SPLIT_MM) {
                    freeRects.add(new FreeRect(px, topY, pw, topH, stage2, true));
                }
            }
        }
    }

    // ==================== 疵点与窗帘/双轴对格约束安全定位 ====================

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
            if (rx >= r.x - EPS && rx + pw <= r.x + r.w + EPS) candX.add(Math.max(r.x, rx));
            double lx = d.getX() - pw;
            if (lx >= r.x - EPS && lx + pw <= r.x + r.w + EPS) candX.add(Math.max(r.x, lx));
            double by = d.getY() + d.getH();
            if (by >= r.y - EPS && by + pl <= r.y + r.h + EPS) candY.add(Math.max(r.y, by));
            double ty = d.getY() - pl;
            if (ty >= r.y - EPS && ty + pl <= r.y + r.h + EPS) candY.add(Math.max(r.y, ty));
        }

        candX.sort(Double::compare);
        candY.sort(Double::compare);

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
            for (double rawX : candX) {
                ComputationCancellation.check();
                double cx = rawX;
                if (it.patternMatchX) {
                    cx = snapLocalX(ctx.req, ctx.frame, ctx.pipeline, it.part, angleDeg, cx, pw);
                }
                if (cx < effMinX - EPS || cx + pw > effMaxX + EPS) continue;
                double cy = rawY;
                for (int iter = 0; iter < 5; iter++) {
                    if (it.patternMatchY) {
                        cy = snapLocalY(ctx.req, ctx.frame, ctx.pipeline, it.part, angleDeg, cy, pl);
                    }
                    if (cy < r.y - EPS || cy + pl > r.y + r.h + EPS) {
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
        if (PatternRepeatRule.isAlignedY(req, part, angleDeg, physY)) {
            return localY;
        }
        double repeatY = req.material().fabricRule().repeatYMm();
        double phaseY = req.material().fabricRule().phaseYMm() == null ? 0.0 : req.material().fabricRule().phaseYMm();
        double anchorY = PatternRepeatRule.transformedAnchor(part, angleDeg)[1];
        double rem = (((physY + anchorY - phaseY) % repeatY) + repeatY) % repeatY;
        return localY + rem;
    }

    private static double snapLocalX(
            NestingProblem req,
            CoordinateFrame frame,
            ConstraintPipeline pipeline,
            NestingProblem.Part part,
            int angleDeg,
            double localX,
            double pw) {
        double physX = frame.toPhysicalX(localX, pw);
        if (!frame.isRightOrigin()) {
            return pipeline.snapX(req, part, angleDeg, physX);
        }
        if (PatternRepeatRule.isAlignedX(req, part, angleDeg, physX)) {
            return localX;
        }
        double repeatX = req.material().fabricRule().repeatXMm();
        double phaseX = req.material().fabricRule().phaseXMm() == null ? 0.0 : req.material().fabricRule().phaseXMm();
        double anchorX = PatternRepeatRule.transformedAnchor(part, angleDeg)[0];
        double rem = (((physX + anchorX - phaseX) % repeatX) + repeatX) % repeatX;
        return localX + rem;
    }
}
