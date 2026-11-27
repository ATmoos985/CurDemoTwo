package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.CoordinateFrame;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.DemItem;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.FitRule;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.FreeRect;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.LayoutSolution;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.SearchContext;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.SortRule;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.SplitRule;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.Strategy;
import com.example.cutdemotwo.algorithm.nesting.constraints.ConstraintPipeline;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;

import java.util.ArrayList;
import java.util.List;
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
                int[] order = GuillotineSearchModel.buildOrder(ctx, s.sortRule());
                return GuillotineRectPlacer.runGreedy(ctx, order, s.fitRule(), s.splitRule(), activeL, false);
            });
        }

        List<LayoutSolution> multiStartResults = NestingParallelExecutor.runDeterministic(tasks);
        LayoutSolution best = null;
        int bestStrategyIdx = 0;
        for (int i = 0; i < multiStartResults.size(); i++) {
            LayoutSolution cand = multiStartResults.get(i);
            if (cand != null && GuillotineSearchModel.isBetter(cand, best)) {
                best = cand;
                bestStrategyIdx = i;
            }
        }
        Strategy bestStrategy = strategies.get(bestStrategyIdx);

        // 2. 有界 Beam Search（真实布局指纹去重，打破首刀/前步贪心锁死）
        long beamDeadline = now + (long) (searchBudgetMs * 0.55) * 1_000_000L;
        if (!ctx.timeUp() && System.nanoTime() < beamDeadline && items.size() >= 2) {
            int[] primaryOrder = GuillotineSearchModel.buildOrder(ctx, bestStrategy.sortRule());
            LayoutSolution beamBest = GuillotineBeamAndLnsSearch.runBeamSearch(
                    ctx, primaryOrder, bestStrategy.fitRule(), bestStrategy.splitRule(), activeL, beamDeadline);
            if (beamBest != null && GuillotineSearchModel.isBetter(beamBest, best)) {
                best = beamBest;
            }
            if (best != null && best.placedCount < items.size()
                    && bestStrategy.sortRule() != SortRule.AREA_DESC
                    && System.nanoTime() < beamDeadline) {
                int[] areaOrder = GuillotineSearchModel.buildOrder(ctx, SortRule.AREA_DESC);
                LayoutSolution beamAlt = GuillotineBeamAndLnsSearch.runBeamSearch(
                        ctx, areaOrder, FitRule.BAF, SplitRule.MIN_AREA, activeL, beamDeadline);
                if (beamAlt != null && GuillotineSearchModel.isBetter(beamAlt, best)) {
                    best = beamAlt;
                }
            }
        }

        // 3. 预算内确定性 LNS 局部重排精修与水平/垂直首刀版长二分压缩
        if (best != null && !ctx.timeUp()) {
            best = GuillotineBeamAndLnsSearch.runLnsRefinement(ctx, best, bestStrategy);
        }

        return best != null ? best : new LayoutSolution(
                List.of(), List.of(),
                List.of(new FreeRect(0, 0, rollW, activeL, 1, horizontalFirst)),
                new boolean[items.size()], 0.0, 0, 0.0, 0
        );
    }

    static boolean isBetter(LayoutSolution cand, LayoutSolution best) {
        return GuillotineSearchModel.isBetter(cand, best);
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
}
