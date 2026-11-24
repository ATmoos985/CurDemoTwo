package com.example.cutdemotwo.contracts.geometry;

import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;

import java.util.List;

/**
 * 工业级闭合异形轮廓 CAM 刀路优化方案（支持小件优先防飞料、先内孔后外轮廓、引入线与微连接、共边去重）。
 */
public record ContourToolpathPlan(
        double homeX,
        double homeY,
        double originalAirDistanceMm,
        double optimizedAirDistanceMm,
        double savedAirDistanceMm,
        double savingRatioPct,
        double totalCutLengthMm,
        double deduplicatedEdgeLengthMm,
        double totalDistanceMm,
        List<ContourLoop> loops,
        List<CutStep> cutSteps
) {
    public ContourToolpathPlan {
        loops = loops == null ? List.of() : List.copyOf(loops);
        cutSteps = cutSteps == null ? List.of() : List.copyOf(cutSteps);
    }

    /** 闭合异形轮廓 CAM 刀路优化配置。 */
    public record Options(
            double homeX,
            double homeY,
            double leadInMm,
            double microJointWidthMm,
            boolean smallPartsFirst,
            boolean deduplicateCommonEdges,
            double commonEdgeToleranceMm
    ) {
        public static Options defaults(double homeX, double homeY) {
            return new Options(homeX, homeY, 0.0, 0.0, true, false, 0.05);
        }

        public Options(double homeX, double homeY, double leadInMm, double microJointWidthMm) {
            this(homeX, homeY, leadInMm, microJointWidthMm, true, false, 0.05);
        }
    }

    /** 单个闭合切割轮廓工步（外轮廓或内孔轮廓）。 */
    public record ContourLoop(
            int sequence,
            int placementId,
            String partName,
            boolean hole,
            int holeIndex,
            double areaMm2,
            double pierceX,
            double pierceY,
            double entryX,
            double entryY,
            double leadInMm,
            double microJointWidthMm,
            List<Point> pathPoints,
            double airDistanceMm,
            double cutLengthMm
    ) {
        public ContourLoop {
            pathPoints = pathPoints == null ? List.of() : List.copyOf(pathPoints);
        }
    }
}
