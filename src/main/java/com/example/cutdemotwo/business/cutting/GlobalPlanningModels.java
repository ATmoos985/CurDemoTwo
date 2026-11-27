package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 全局联合排产内部只读快照载体与纯数值/几何辅助工具（零业务服务依赖）。
 */
final class GlobalPlanningModels {

    private GlobalPlanningModels() {}

    record DemandSpec(
            Integer id,
            String name,
            double width,
            double length,
            int quantity,
            Boolean allowRotation,
            Boolean allowHalfTurn,
            NestingProblem.Shape shape,
            String sourceTaskId,
            Integer sourceLineId
    ) {}

    record NormalizedDemand(
            int id,
            String name,
            double width,
            double length,
            int quantity,
            boolean allowRotation,
            Boolean allowHalfTurn,
            NestingProblem.Shape shape,
            double areaMm2,
            String sourceTaskId,
            Integer sourceLineId
    ) {}

    record RemnantSnapshot(
            String id,
            String materialModel,
            String batchNo,
            String color,
            double width,
            double length,
            double areaM2,
            boolean hasDefect,
            List<Defect> defects
    ) {}

    record RollSnapshot(
            String rollId,
            String materialModel,
            String batchNo,
            String color,
            double width,
            double totalLength,
            double startY,
            double availableLengthMm,
            List<Defect> defects
    ) {}

    record PlanningContext(
            String materialModel,
            boolean isContour,
            double pieceGapMm,
            double trimStartMm,
            List<NormalizedDemand> demands,
            List<RemnantSnapshot> candidateRemnants,
            List<RollSnapshot> candidateRolls,
            List<String> warnings
    ) {}

    record PlacementData(
            int id,
            int demandId,
            String name,
            double x,
            double y,
            double w,
            double l,
            int rotationDegrees,
            boolean rotated,
            List<NestingProblem.Point> polygon,
            List<List<NestingProblem.Point>> holes,
            String sourceTaskId,
            Integer sourceLineId
    ) {}

    record RollTrialOutcome(
            String rollId,
            double widthMm,
            double availableLengthMm,
            double estimatedCutLengthMm,
            double estimatedConsumedAreaMm2,
            double utilizationPct,
            int placedCount,
            boolean feasible,
            double windowStartY,
            double totalLengthMm,
            List<PlacementData> placements,
            List<Defect> defects,
            String rollModel,
            String batchNo,
            String color
    ) {}

    static List<NestingProblem.Point> sanitizePointRing(List<NestingProblem.Point> ring) {
        List<NestingProblem.Point> clean = new ArrayList<>(ring.size());
        for (NestingProblem.Point pt : ring) {
            if (pt == null) continue;
            clean.add(new NestingProblem.Point(
                    Math.max(0.0, cleanCoord(pt.x())),
                    Math.max(0.0, cleanCoord(pt.y()))
            ));
        }
        return List.copyOf(clean);
    }

    static List<List<NestingProblem.Point>> sanitizeHoleRings(List<List<NestingProblem.Point>> holes) {
        List<List<NestingProblem.Point>> clean = new ArrayList<>(holes.size());
        for (List<NestingProblem.Point> ring : holes) {
            if (ring == null || ring.size() < 3) continue;
            clean.add(sanitizePointRing(ring));
        }
        return clean.isEmpty() ? null : List.copyOf(clean);
    }

    static List<Defect> copyDefects(List<Defect> defects) {
        if (defects == null || defects.isEmpty()) return List.of();
        List<Defect> copy = new ArrayList<>(defects.size());
        for (Defect d : defects) {
            if (d == null) continue;
            copy.add(new Defect(
                    d.getId(), d.getX(), d.getY(), d.getW(), d.getH(), d.getMargin(),
                    d.getDefectType(), d.getTypeName(), d.getSeverity(), d.getPoints(),
                    d.getDetectionSource(), d.getAvoidanceStrategy(), d.getDescription()
            ));
        }
        return List.copyOf(copy);
    }

    static int sumValues(Map<?, Integer> map) {
        int s = 0;
        for (Integer v : map.values()) if (v != null) s += v;
        return s;
    }

    static String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s.trim();
    }

    static String firstNonBlank(String a, String b) {
        String x = blankToNull(a);
        return x != null ? x : blankToNull(b);
    }

    static double round1(double v) {
        return Math.rint(v * 10.0) / 10.0;
    }

    static double floor1(double v) {
        if (!Double.isFinite(v)) return 0.0;
        return Math.floor(v * 10.0 + 1e-9) / 10.0;
    }

    static double ceil1(double v) {
        if (!Double.isFinite(v)) return 0.0;
        return Math.ceil(v * 10.0 - 1e-9) / 10.0;
    }

    static double round2(double v) {
        return Math.rint(v * 100.0) / 100.0;
    }

    static double round4(double v) {
        return Math.rint(v * 10000.0) / 10000.0;
    }

    static double cleanCoord(double v) {
        if (!Double.isFinite(v)) return 0.0;
        double cleaned = Math.rint(v * 1_000_000.0) / 1_000_000.0;
        return cleaned == 0.0 ? 0.0 : cleaned;
    }
}
