package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.CoordinateFrame;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.CandidatePlacement;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.DemItem;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.FitRule;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.FreeRect;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.LayoutSolution;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.PlacedRec;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.RawCut;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.SearchContext;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.SplitRule;
import com.example.cutdemotwo.algorithm.nesting.constraints.ConstraintPipeline;
import com.example.cutdemotwo.algorithm.nesting.constraints.PatternRepeatRule;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.EPS;
import static com.example.cutdemotwo.algorithm.nesting.GuillotineSearchModel.MIN_SPLIT_MM;

/**
 * 直刀贪心放置器、候选落位筛选、严格直刀切分树与疵点/双轴对格安全定位器。
 */
final class GuillotineRectPlacer {

    private GuillotineRectPlacer() {}

    // ==================== 贪心构造器 ====================

    static LayoutSolution runGreedy(
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

        return GuillotineSearchModel.wrapWorkingHeightIfCompressed(
                ctx, pieces, cuts, freeRects, placedMask, placedArea, pieces.size(), usedLength, softHits, workingHeight);
    }

    // ==================== 候选落位搜索与差异化去重 ====================

    static CandidatePlacement selectBestPlacement(
            SearchContext ctx, DemItem it, List<FreeRect> freeRects, FitRule fitRule) {
        List<CandidatePlacement> top = selectTopPlacements(ctx, it, freeRects, fitRule, 1);
        return top.isEmpty() ? null : top.get(0);
    }

    static List<CandidatePlacement> selectTopPlacements(
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

    static boolean isSplitAllowedByMaxStages(
            SearchContext ctx, FreeRect r, double px, double py, double pw, double pl, boolean splitHoriz) {
        if (ctx.maxStages == null) return true;
        if (r.level == 1 && splitHoriz != ctx.horizontalFirst) return false;
        int maxStage = computeCutStages(r, px, py, pw, pl, splitHoriz)[2];
        return maxStage <= ctx.maxStages;
    }

    static boolean resolveSplitHorizontal(
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

    static void splitRect(
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
