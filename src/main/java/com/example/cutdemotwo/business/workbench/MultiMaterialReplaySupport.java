package com.example.cutdemotwo.business.workbench;

import com.example.cutdemotwo.business.cutting.GlobalPlanningService;
import com.example.cutdemotwo.business.optimization.OptimizationService;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.jobs.StoredOptimizationJob;
import com.example.cutdemotwo.contracts.jobs.WorkbenchJobSource;
import com.example.cutdemotwo.contracts.jobs.WorkbenchSchemeDraft;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingResult;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 多料联排批量草案冷重启幂等重放重建工具（同包只读无环辅助类）：
 * 严格依据持久化 {@link WorkbenchSchemeDraft} 与已归档 {@link StoredOptimizationJob}
 * 确定性重建 {@link GlobalPlanningService.MultiMaterialPlanResult}，绝不触发实时规划或读取最新库存/任务。
 */
final class MultiMaterialReplaySupport {

    private MultiMaterialReplaySupport() {}

    static GlobalPlanningService.MultiMaterialPlanResult rebuildPlanResultFromArchived(
            String cleanTaskId,
            String cleanModel,
            String requiredBatchNo,
            String requiredColor,
            List<GlobalPlanningService.DemandItem> demands,
            boolean continueAcrossRolls,
            List<WorkbenchSchemeDraft> existingDrafts,
            OptimizationService optimizationService
    ) {
        List<GlobalPlanningService.RemnantAllocation> remnantAllocations = new ArrayList<>();
        List<GlobalPlanningService.RollOption> rollOptions = new ArrayList<>();
        int placedByRemnants = 0;
        int placedByRoll = 0;
        double totalSavedAreaM2 = 0.0;
        int rollRelayCounter = 0;

        String cleanBatchNo = blankToNull(requiredBatchNo);
        String cleanColor = blankToNull(requiredColor);

        for (WorkbenchSchemeDraft draft : existingDrafts) {
            WorkbenchSchemeDraft.Target target = draft.target();
            String resultId = target != null ? target.resultId() : null;
            StoredOptimizationJob doc = resultId != null ? optimizationService.findJobWithSource(resultId) : null;
            WorkbenchJobSource source = doc != null ? doc.workbenchSource() : null;
            NestingProblem problem = (doc != null && doc.input() != null
                    && doc.input().problem() instanceof NestingProblem np) ? np : null;
            NestingResult layout = (doc != null && doc.result() != null) ? doc.result().layout() : null;

            String materialType = source != null && source.materialType() != null
                    ? source.materialType()
                    : (target != null ? target.materialType() : "STOCK_ROLL");
            String materialId = source != null && source.materialId() != null
                    ? source.materialId()
                    : (target != null ? target.materialId() : "");
            double widthMm = source != null && source.physicalWidthMm() > 0
                    ? source.physicalWidthMm()
                    : (problem != null && problem.material() != null && problem.material().shape() != null
                    ? problem.material().shape().width() : 0.0);
            double lengthMm = source != null && source.windowLengthMm() > 0
                    ? source.windowLengthMm()
                    : (problem != null && problem.material() != null && problem.material().shape() != null
                    ? problem.material().shape().height() : 0.0);
            double windowStartY = source != null ? source.windowStartMm() : 0.0;

            List<NestingResult.Placement> rawPlacements = (layout != null && layout.placements() != null)
                    ? layout.placements() : List.of();
            List<GlobalPlanningService.PlacementSnapshot> snapshots = new ArrayList<>(rawPlacements.size());
            Map<Integer, String> demandNames = new LinkedHashMap<>();
            Map<Integer, Integer> demandCounts = new LinkedHashMap<>();
            double piecesAreaMm2 = 0.0;

            for (NestingResult.Placement p : rawPlacements) {
                NestingProblem.Shape shape = p.shape();
                double pw = shape != null ? shape.width() : 0.0;
                double pl = shape != null ? shape.height() : 0.0;
                boolean isPoly = shape != null && "POLYGON".equals(shape.type())
                        && shape.vertices() != null && !shape.vertices().isEmpty();
                List<NestingProblem.Point> poly = isPoly ? shape.vertices() : List.of();
                List<List<NestingProblem.Point>> holes = (shape != null && shape.holes() != null)
                        ? shape.holes() : List.of();
                String pName = p.name() != null ? p.name() : ("裁片 #" + p.demandId());
                Integer sourceLineId = source != null ? source.sourceLines().get(p.demandId()) : null;
                boolean rotated = Math.floorMod(p.rotationDegrees(), 180) != 0;

                snapshots.add(new GlobalPlanningService.PlacementSnapshot(
                        p.id(),
                        p.demandId(),
                        pName,
                        p.x(),
                        p.y(),
                        pw,
                        pl,
                        p.rotationDegrees(),
                        rotated,
                        poly,
                        holes,
                        source != null ? source.taskId() : cleanTaskId,
                        sourceLineId
                ));
                demandNames.putIfAbsent(p.demandId(), pName);
                demandCounts.merge(p.demandId(), 1, Integer::sum);
                piecesAreaMm2 += shape != null ? shape.areaMm2() : 0.0;
            }

            List<GlobalPlanningService.AllocatedItem> allocatedItems = new ArrayList<>(demandCounts.size());
            for (Map.Entry<Integer, Integer> e : demandCounts.entrySet()) {
                allocatedItems.add(new GlobalPlanningService.AllocatedItem(
                        e.getKey(),
                        demandNames.getOrDefault(e.getKey(), "裁片 #" + e.getKey()),
                        e.getValue()
                ));
            }

            int placedCount = snapshots.size();
            double piecesAreaM2 = piecesAreaMm2 / 1_000_000.0;
            double matAreaM2 = (widthMm * lengthMm) / 1_000_000.0;
            double utilPct = matAreaM2 > 0 ? Math.min(100.0, piecesAreaM2 / matAreaM2 * 100.0) : 0.0;
            List<Defect> archivedDefects = extractExclusionsAsDefects(problem);

            if ("REMNANT".equals(materialType)) {
                remnantAllocations.add(new GlobalPlanningService.RemnantAllocation(
                        materialId,
                        round1(widthMm),
                        round1(lengthMm),
                        round2(utilPct),
                        placedCount,
                        round4(piecesAreaM2),
                        List.copyOf(allocatedItems),
                        List.copyOf(snapshots),
                        archivedDefects,
                        cleanModel,
                        cleanBatchNo,
                        cleanColor
                ));
                placedByRemnants += placedCount;
                totalSavedAreaM2 += piecesAreaM2;
            } else {
                rollRelayCounter++;
                Integer relayOrder = extractRelayOrder(source != null ? source.materialLabel() : null,
                        continueAcrossRolls ? rollRelayCounter : null);
                rollOptions.add(new GlobalPlanningService.RollOption(
                        materialId,
                        round1(widthMm),
                        round1(lengthMm),
                        round1(lengthMm),
                        round2(utilPct),
                        placedCount,
                        true,
                        true,
                        windowStartY,
                        round1(lengthMm),
                        List.copyOf(snapshots),
                        archivedDefects,
                        cleanModel,
                        cleanBatchNo,
                        cleanColor,
                        relayOrder,
                        List.copyOf(allocatedItems)
                ));
                placedByRoll += placedCount;
                totalSavedAreaM2 += piecesAreaM2;
            }
        }

        int totalPlaced = placedByRemnants + placedByRoll;
        int requestedFromReq = 0;
        if (demands != null && !demands.isEmpty()) {
            for (GlobalPlanningService.DemandItem d : demands) {
                if (d != null && d.quantity() > 0) {
                    requestedFromReq += d.quantity();
                }
            }
        }
        int totalRequestedPieces = requestedFromReq > 0 ? Math.max(requestedFromReq, totalPlaced) : totalPlaced;
        int unplacedPieces = Math.max(0, totalRequestedPieces - totalPlaced);

        return new GlobalPlanningService.MultiMaterialPlanResult(
                cleanModel,
                totalRequestedPieces,
                placedByRemnants,
                placedByRoll,
                unplacedPieces,
                List.copyOf(remnantAllocations),
                List.copyOf(rollOptions),
                round4(totalSavedAreaM2),
                0L,
                List.of()
        );
    }

    private static List<Defect> extractExclusionsAsDefects(NestingProblem problem) {
        if (problem == null || problem.material() == null || problem.material().exclusions() == null) {
            return List.of();
        }
        List<NestingProblem.Exclusion> exclusions = problem.material().exclusions();
        if (exclusions.isEmpty()) {
            return List.of();
        }
        List<Defect> defects = new ArrayList<>(exclusions.size());
        for (NestingProblem.Exclusion ex : exclusions) {
            if (ex == null || ex.shape() == null) continue;
            defects.add(new Defect(
                    ex.id(),
                    ex.x(),
                    ex.y(),
                    ex.shape().width(),
                    ex.shape().height(),
                    ex.clearance(),
                    "EXCLUSION",
                    "已归档禁区",
                    ex.severity(),
                    0,
                    "ARCHIVED",
                    ex.avoidancePolicy(),
                    null
            ));
        }
        return List.copyOf(defects);
    }

    private static Integer extractRelayOrder(String materialLabel, Integer fallback) {
        if (materialLabel != null) {
            int marker = materialLabel.indexOf("接力母卷 #");
            if (marker >= 0) {
                int start = marker + "接力母卷 #".length();
                int end = start;
                while (end < materialLabel.length() && Character.isDigit(materialLabel.charAt(end))) {
                    end++;
                }
                if (end > start) {
                    try {
                        return Integer.parseInt(materialLabel.substring(start, end));
                    } catch (NumberFormatException ignored) {
                    }
                }
            }
        }
        return fallback;
    }

    private static double round1(double v) {
        if (!Double.isFinite(v)) return 0.0;
        double q = Math.rint(v * 10.0) / 10.0;
        return q == 0.0 ? 0.0 : q;
    }

    private static double round2(double v) {
        if (!Double.isFinite(v)) return 0.0;
        double q = Math.rint(v * 100.0) / 100.0;
        return q == 0.0 ? 0.0 : q;
    }

    private static double round4(double v) {
        if (!Double.isFinite(v)) return 0.0;
        double q = Math.rint(v * 10000.0) / 10000.0;
        return q == 0.0 ? 0.0 : q;
    }

    private static String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s.trim();
    }
}
