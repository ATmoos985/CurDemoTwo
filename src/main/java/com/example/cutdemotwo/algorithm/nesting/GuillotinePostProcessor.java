package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.CoordinateFrame;
import com.example.cutdemotwo.algorithm.toolpath.CutBoundaryCompletionService;
import com.example.cutdemotwo.algorithm.toolpath.ToolpathOptimizerService;
import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.contracts.geometry.RemnantPiece;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;

import java.util.List;

/**
 * 矩形直刀与横切引擎共享后处理器。
 * 收拢卷头修齐第 0 刀、连续母卷尾段判定、疵点重叠打标、可回收料头装配、
 * 刀路边界补齐与空行程回零优化。
 */
public final class GuillotinePostProcessor {
    private static final double CONTINUOUS_TAIL_TOL_MM = 30.0;

    private GuillotinePostProcessor() {}

    /** 构建卷头修齐料头记录（调用方保证 {@code frame.trimStart() > 0}）。 */
    public static RemnantPiece createTrimRemnant(CoordinateFrame frame, int remIndex) {
        double trim = frame.trimStart();
        double trimArea = (frame.width() * trim) / 1_000_000.0;
        return new RemnantPiece(
                String.format("TRIM-%02d", remIndex),
                "卷头修齐料头",
                0,
                frame.trimRemnantY(),
                frame.width(),
                trim,
                trimArea,
                false
        );
    }

    /** 构建第 0 阶段卷头修齐横切刀（调用方保证 {@code frame.trimStart() > 0}）。 */
    public static CutStep createTrimCut(CoordinateFrame frame, int stepIndex) {
        double trim = frame.trimStart();
        return new CutStep(
                stepIndex,
                "横切",
                frame.trimCutY(),
                0,
                frame.width(),
                String.format("第 0 阶段：卷头修齐横切断刀，切除 0~%.0f mm 不规则料头并确立绝对测量原点", trim)
        );
    }

    /** 判断某块矩形余料是否为连续母卷尾部的全幅贯通连续段（不生成独立回收块）。 */
    public static boolean isContinuousTail(NestingProblem req,
                                           CoordinateFrame frame,
                                           double localY,
                                           double physY,
                                           double w,
                                           double h) {
        return !frame.isSheet()
                && req.material().continuesAfterRegion()
                && (w >= frame.width() - CONTINUOUS_TAIL_TOL_MM)
                && (physY + h >= frame.height() - CONTINUOUS_TAIL_TOL_MM
                || localY + h >= frame.activeLength() - CONTINUOUS_TAIL_TOL_MM);
    }

    /** 检查矩形物理区域是否与任意疵点安全外框重叠。 */
    public static boolean hasDefectOverlap(double x, double y, double w, double h, List<Defect> defects) {
        if (defects == null || defects.isEmpty()) {
            return false;
        }
        for (Defect d : defects) {
            ComputationCancellation.check();
            boolean noOverlap = (x + w <= d.getSafeX() || x >= d.getSafeX() + d.getSafeW()
                    || y + h <= d.getSafeY() || y >= d.getSafeY() + d.getSafeH());
            if (!noOverlap) {
                return true;
            }
        }
        return false;
    }

    /**
     * 按连续母卷尾段规则与最小可回收尺寸门禁构建余料记录；不符合回收条件时返回 {@code null}。
     */
    public static RemnantPiece tryCreateRemnant(NestingProblem req,
                                                CoordinateFrame frame,
                                                String remPrefix,
                                                int remIndex,
                                                double localY,
                                                double physX,
                                                double physY,
                                                double w,
                                                double h,
                                                List<Defect> defects) {
        if (isContinuousTail(req, frame, localY, physY, w, h)) {
            return null;
        }
        if (w < req.process().minReusableWidth() || h < req.process().minReusableHeight()) {
            return null;
        }
        double area = (w * h) / 1_000_000.0;
        boolean hasDefect = hasDefectOverlap(physX, physY, w, h, defects);
        String status = hasDefect ? "带疵料头" : "可用料头";
        return new RemnantPiece(
                String.format("%s-%02d", remPrefix, remIndex),
                status,
                physX,
                physY,
                w,
                h,
                area,
                hasDefect
        );
    }

    /** 串联 100% 无粘连边界补齐与空行程回零刀路优化。 */
    public static List<CutStep> completeAndOptimizeCuts(CutBoundaryCompletionService completionService,
                                                        ToolpathOptimizerService optimizerService,
                                                        List<PlacedPiece> pieces,
                                                        List<RemnantPiece> remnants,
                                                        List<CutStep> rawCuts,
                                                        CoordinateFrame frame,
                                                        boolean enforceStrictStages) {
        List<CutStep> separated = completionService.ensureCompleteSeparation(
                pieces, remnants, rawCuts, frame.width(), frame.height(), frame.isSheet()
        );
        return optimizeCuts(optimizerService, separated, frame, enforceStrictStages);
    }

    /** 仅执行刀路回零平滑与空行程优化（如纯横切无需边界补齐）。 */
    public static List<CutStep> optimizeCuts(ToolpathOptimizerService optimizerService,
                                             List<CutStep> cuts,
                                             CoordinateFrame frame,
                                             boolean enforceStrictStages) {
        return optimizerService.optimizeAndChain(cuts, frame.homeX(), frame.homeY(), enforceStrictStages);
    }

    /** 计算当前排样裁片所占用的建议进给长度。 */
    public static double suggestedFeedLength(List<PlacedPiece> pieces) {
        return pieces.stream().mapToDouble(p -> p.getY() + p.getL()).max().orElse(0.0);
    }
}
