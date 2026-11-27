package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.CoordinateFrame;
import com.example.cutdemotwo.algorithm.nesting.constraints.ConstraintPipeline;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

/**
 * 自主二维直刀（Guillotine）核心搜索数据结构、排序策略、优劣比较与压缩高度整板回嵌模型。
 */
final class GuillotineSearchModel {

    static final double EPS = 1e-6;
    static final double MIN_SPLIT_MM = 0.5;

    private GuillotineSearchModel() {}

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

    record Strategy(SortRule sortRule, FitRule fitRule, SplitRule splitRule) {}

    record CandidatePlacement(
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

    static final class SearchContext {
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

    static int[] buildOrder(SearchContext ctx, SortRule rule) {
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

    /**
     * 当使用压缩高度 {@code workingHeight < ctx.activeL} 求解时，将其严格合法地嵌入整板 {@code [0, ctx.activeL]}：
     * <ul>
     *   <li>水平首刀：在 {@code Y = workingHeight + kerf/2} 补一条第 1 阶段全幅横切（与同向第 1 阶横切平行，不额外升阶），
     *       并加入尾部大块余料；</li>
     *   <li>垂直首刀：将全部第 1 阶段垂直纵切延伸至 {@code ctx.activeL}，对含裁片的垂直列在
     *       {@code Y = workingHeight + kerf/2} 处补第 2 阶段列内横切截断，纯空列直接纵向贯通延伸至 {@code ctx.activeL}。</li>
     * </ul>
     */
    static LayoutSolution wrapWorkingHeightIfCompressed(
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
        ComputationCancellation.check();
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
}
