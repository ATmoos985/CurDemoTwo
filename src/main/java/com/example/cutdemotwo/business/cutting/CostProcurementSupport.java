package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.business.model.QualityDisposition;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;

/**
 * {@link ProductionCostAndProcurementService} 的分片归属、物料适配桶与数值舍入纯计算辅助类。
 */
final class CostProcurementSupport {
    private static final double DEFAULT_FALLBACK_WIDTH_MM = 1500.0;

    private CostProcurementSupport() {}

    static final class TaskPieceSlice {
        int totalPieces;
        double cutAreaM2;
        int netGoodPieces;
        double netGoodAreaM2;
        double dispRecoveredRemAreaM2;
    }

    record PieceFitSpec(double widthMm, double lengthMm, boolean allowRotation) {
        boolean fits(double matW, double matL) {
            if (matW <= 0 || matL <= 0) return false;
            if (widthMm <= matW + 0.001 && lengthMm <= matL + 0.001) return true;
            return allowRotation && lengthMm <= matW + 0.001 && widthMm <= matL + 0.001;
        }
    }

    static final class TaskDemandProfile {
        final CuttingTask task;
        final List<PieceFitSpec> pieces = new ArrayList<>();
        double fallbackMinWidthMm;

        TaskDemandProfile(CuttingTask task, double fallbackMinWidthMm) {
            this.task = task;
            this.fallbackMinWidthMm = fallbackMinWidthMm;
        }

        boolean fitsGeometry(double matW, double matL) {
            if (!pieces.isEmpty()) {
                for (PieceFitSpec p : pieces) {
                    if (p.fits(matW, matL)) return true;
                }
                return false;
            }
            if (fallbackMinWidthMm > 0) {
                return matW + 0.001 >= fallbackMinWidthMm;
            }
            return matW > 0 && matL > 0;
        }
    }

    static final class BatchSupply {
        double rollAreaM2;
        double remnantAreaM2;

        double totalAreaM2() {
            return rollAreaM2 + remnantAreaM2;
        }
    }

    static final class ModelBucket {
        final String materialModel;
        double demandAreaM2;
        double availableRollAreaM2;
        double availableRemnantAreaM2;
        double maxRequiredWidthMm;
        double suggestedRollWidthMm;
        final List<Double> stockWidthsMm = new ArrayList<>();
        final Set<String> pendingTaskIds = new LinkedHashSet<>();
        final Set<String> activeBatches = new TreeSet<>();
        final Map<String, TaskDemandProfile> demandProfiles = new LinkedHashMap<>();
        final Map<String, BatchSupply> batchSupplyAreas = new LinkedHashMap<>();

        ModelBucket(String materialModel) {
            this.materialModel = materialModel;
        }

        void upsertTaskDemandProfile(CuttingTask task, List<PieceFitSpec> pieces, double fallbackMinWidthMm) {
            TaskDemandProfile profile = demandProfiles.computeIfAbsent(
                    task.id(), k -> new TaskDemandProfile(task, fallbackMinWidthMm));
            if (pieces != null && !pieces.isEmpty()) profile.pieces.addAll(pieces);
            if (fallbackMinWidthMm > 0) profile.fallbackMinWidthMm = Math.max(profile.fallbackMinWidthMm, fallbackMinWidthMm);
        }

        void addAnonymousDemandProfile(String key, List<PieceFitSpec> pieces, double fallbackMinWidthMm) {
            TaskDemandProfile profile = demandProfiles.computeIfAbsent(
                    key, k -> new TaskDemandProfile(null, fallbackMinWidthMm));
            if (pieces != null && !pieces.isEmpty()) profile.pieces.addAll(pieces);
            if (fallbackMinWidthMm > 0) profile.fallbackMinWidthMm = Math.max(profile.fallbackMinWidthMm, fallbackMinWidthMm);
        }

        void recordBatchRollArea(String batchNo, double areaM2) {
            batchSupplyAreas.computeIfAbsent(batchNo.trim().toUpperCase(Locale.ROOT), k -> new BatchSupply()).rollAreaM2 += areaM2;
        }

        void recordBatchRemnantArea(String batchNo, double areaM2) {
            batchSupplyAreas.computeIfAbsent(batchNo.trim().toUpperCase(Locale.ROOT), k -> new BatchSupply()).remnantAreaM2 += areaM2;
        }

        boolean isSingleStrictUnboundBatchTask() {
            if (demandProfiles.size() != 1) return false;
            TaskDemandProfile only = demandProfiles.values().iterator().next();
            return only.task != null && Boolean.TRUE.equals(only.task.strictBatchMatch());
        }
    }

    static Map<String, TaskPieceSlice> extractPieceAttributedTaskSlices(
            Map<String, Object> raw,
            Map<String, Object> projected,
            CuttingPlan plan,
            String primaryTaskId
    ) {
        if (!(raw.get("pieceSources") instanceof Map<?, ?> rawSources) || rawSources.isEmpty()) return Map.of();
        if (!(raw.get("pieceResults") instanceof List<?> pieceResults) || pieceResults.isEmpty()) return Map.of();

        Map<Integer, String> pieceToTask = new HashMap<>();
        for (Map.Entry<?, ?> entry : rawSources.entrySet()) {
            Integer pieceId = parseIntegerKey(entry.getKey());
            if (pieceId == null) continue;
            if (entry.getValue() instanceof Map<?, ?> srcMap && srcMap.get("taskId") != null) {
                String tid = blankToNull(srcMap.get("taskId").toString());
                if (tid != null) pieceToTask.put(pieceId, tid);
            }
        }
        if (pieceToTask.isEmpty()) return Map.of();

        Map<Integer, PlacedPiece> planPiecesById = new HashMap<>();
        if (plan != null && plan.result() != null && plan.result().getPieces() != null) {
            for (PlacedPiece pp : plan.result().getPieces()) planPiecesById.put(pp.getId(), pp);
        }

        Map<Integer, QualityDisposition> activeDispByPieceId = new HashMap<>();
        if (projected.get("qualityDispositions") instanceof List<?> qList) {
            for (Object qObj : qList) {
                if (qObj instanceof QualityDisposition qd && !qd.hasRevocation() && qd.command() != null) {
                    activeDispByPieceId.put(qd.command().pieceId(), qd);
                }
            }
        }

        String fallbackTaskId = blankToNull(primaryTaskId) != null ? primaryTaskId.trim() : "UNASSIGNED";
        Map<String, TaskPieceSlice> slices = new LinkedHashMap<>();

        for (Object pObj : pieceResults) {
            int pieceId;
            String outcome;
            double pieceAreaM2;
            if (pObj instanceof ReportOutput.ReportedPiece rp) {
                pieceId = rp.pieceId();
                outcome = Objects.toString(rp.outcome(), "");
                PlacedPiece pp = planPiecesById.get(pieceId);
                if (pp != null) pieceAreaM2 = pp.areaMm2() / 1_000_000.0;
                else if (rp.shape() != null) pieceAreaM2 = rp.shape().areaMm2() / 1_000_000.0;
                else pieceAreaM2 = (rp.w() * rp.l()) / 1_000_000.0;
            } else if (pObj instanceof Map<?, ?> pm) {
                Integer parsedId = parseIntegerKey(pm.get("pieceId"));
                if (parsedId == null) continue;
                pieceId = parsedId;
                outcome = Objects.toString(pm.get("outcome"), "");
                PlacedPiece pp = planPiecesById.get(pieceId);
                QualityDisposition dispForArea = activeDispByPieceId.get(pieceId);
                if (pp != null) pieceAreaM2 = pp.areaMm2() / 1_000_000.0;
                else if (dispForArea != null && dispForArea.pieceAreaMm2() > 0) pieceAreaM2 = dispForArea.pieceAreaMm2() / 1_000_000.0;
                else pieceAreaM2 = (numberOf(pm.get("w")) * numberOf(pm.get("l"))) / 1_000_000.0;
            } else {
                continue;
            }

            String tid = pieceToTask.getOrDefault(pieceId, fallbackTaskId);
            TaskPieceSlice slice = slices.computeIfAbsent(tid, k -> new TaskPieceSlice());
            slice.totalPieces++;
            QualityDisposition disp = activeDispByPieceId.get(pieceId);

            if ("QUALIFIED".equals(outcome)) {
                slice.cutAreaM2 += pieceAreaM2;
                if (disp == null) {
                    slice.netGoodPieces++;
                    slice.netGoodAreaM2 += pieceAreaM2;
                } else {
                    slice.dispRecoveredRemAreaM2 += Math.max(0.0, disp.recoveredAreaMm2() / 1_000_000.0);
                }
            } else if ("REJECTED".equals(outcome)) {
                slice.cutAreaM2 += pieceAreaM2;
                if (disp != null) slice.dispRecoveredRemAreaM2 += Math.max(0.0, disp.recoveredAreaMm2() / 1_000_000.0);
            } else if (disp != null) {
                slice.dispRecoveredRemAreaM2 += Math.max(0.0, disp.recoveredAreaMm2() / 1_000_000.0);
            }
        }
        return slices;
    }

    static Integer parseIntegerKey(Object key) {
        if (key instanceof Number n) return n.intValue();
        if (key instanceof String s) {
            try { return Integer.parseInt(s.trim()); }
            catch (NumberFormatException ignored) { return null; }
        }
        return null;
    }

    static List<PieceFitSpec> extractSchemePiecesForTask(SchedulingScheme scheme, CuttingTask task) {
        Map<Integer, CuttingTask.Line> lineById = new HashMap<>();
        for (CuttingTask.Line l : task.demands()) lineById.put(l.id(), l);
        List<PieceFitSpec> out = new ArrayList<>();
        for (SchedulingScheme.TaskDemandAllocation alloc : scheme.effectiveAllocations()) {
            if (!Objects.equals(task.id(), alloc.taskId()) || alloc.quantity() <= 0) continue;
            CuttingTask.Line line = lineById.get(alloc.lineId());
            if (line == null) continue;
            double pieceW = line.shape() != null ? line.shape().width() : line.width();
            double pieceL = line.shape() != null ? line.shape().height() : line.length();
            out.add(new PieceFitSpec(pieceW, pieceL, line.allowRotation()));
        }
        return out;
    }

    static List<PieceFitSpec> extractAnonymousSchemePieces(SchedulingScheme scheme) {
        if (scheme.layout2D() == null || scheme.layout2D().placements() == null || scheme.layout2D().placements().isEmpty()) {
            return List.of();
        }
        List<PieceFitSpec> out = new ArrayList<>();
        for (SchedulingScheme.PlacementItem p : scheme.layout2D().placements()) {
            if (p != null && p.w() > 0 && p.l() > 0) out.add(new PieceFitSpec(p.w(), p.l(), false));
        }
        return out;
    }

    static boolean isMaterialCompatibleWithBucket(
            CuttingStatePort.ReadView tx,
            ModelBucket bucket,
            MotherRollInfo roll,
            RemnantStock remnant,
            double matW,
            double matL
    ) {
        if (bucket.demandProfiles.isEmpty()) return true;
        for (TaskDemandProfile profile : bucket.demandProfiles.values()) {
            if (!profile.fitsGeometry(matW, matL)) continue;
            if (profile.task != null) {
                try { tx.validateBatchAndColorForTask(profile.task, roll, remnant); }
                catch (IllegalArgumentException mismatch) { continue; }
            }
            return true;
        }
        return false;
    }

    static Map<String, Integer> extractTaskWeights(Map<String, Object> receipt, String primaryTaskId) {
        Map<String, Integer> weights = new LinkedHashMap<>();
        if (receipt.get("taskDemandQuantities") instanceof Map<?, ?> multi && !multi.isEmpty()) {
            for (Map.Entry<?, ?> entry : multi.entrySet()) {
                if (entry.getKey() == null) continue;
                int sum = 0;
                if (entry.getValue() instanceof Map<?, ?> lines) {
                    for (Object v : lines.values()) if (v instanceof Number n) sum += Math.max(0, n.intValue());
                }
                weights.put(entry.getKey().toString(), Math.max(1, sum));
            }
            if (!weights.isEmpty()) return weights;
        }
        if (blankToNull(primaryTaskId) != null) weights.put(primaryTaskId.trim(), 1);
        return weights;
    }

    static double resolveRecommendedWidthMm(ModelBucket b, List<Double> knownRollWidthsMm) {
        if (b.suggestedRollWidthMm > 0) return Math.max(b.suggestedRollWidthMm, roundUp100(b.maxRequiredWidthMm));
        List<Double> candidateWidths = !b.stockWidthsMm.isEmpty() ? b.stockWidthsMm : knownRollWidthsMm;
        if (candidateWidths != null && !candidateWidths.isEmpty()) {
            Map<Long, Integer> freq = new LinkedHashMap<>();
            for (double w : candidateWidths) {
                if (w + 0.001 >= b.maxRequiredWidthMm) freq.merge(Math.round(w * 10.0), 1, Integer::sum);
            }
            if (!freq.isEmpty()) {
                long bestKey = freq.entrySet().stream()
                        .max(Comparator.<Map.Entry<Long, Integer>>comparingInt(Map.Entry::getValue)
                                .thenComparingLong(Map.Entry::getKey))
                        .map(Map.Entry::getKey).orElse(0L);
                if (bestKey > 0) return bestKey / 10.0;
            }
            double maxStockW = candidateWidths.stream().mapToDouble(Double::doubleValue).max().orElse(0.0);
            if (maxStockW >= b.maxRequiredWidthMm) return maxStockW;
        }
        if (b.maxRequiredWidthMm > 0) return Math.max(DEFAULT_FALLBACK_WIDTH_MM, roundUp100(b.maxRequiredWidthMm));
        return DEFAULT_FALLBACK_WIDTH_MM;
    }

    static double roundUp100(double mm) { return mm <= 0 ? 0.0 : Math.ceil(mm / 100.0) * 100.0; }
    static int alertRank(String alertLevel) { return switch (alertLevel) { case "CRITICAL" -> 0; case "WARNING" -> 1; default -> 2; }; }
    static double numberOf(Object value) { return value instanceof Number n ? n.doubleValue() : 0.0; }
    static int intOf(Object value) { return value instanceof Number n ? n.intValue() : 0; }
    static String blankToNull(String s) { return (s == null || s.isBlank()) ? null : s.trim(); }
    static String firstNonBlank(String a, String b) { String x = blankToNull(a); return x != null ? x : blankToNull(b); }
    static double round1(double v) { return Math.rint(v * 10.0) / 10.0; }
    static double round2(double v) { return Math.rint(v * 100.0) / 100.0; }
    static double round3(double v) { return Math.rint(v * 1000.0) / 1000.0; }
    static double round4(double v) { return Math.rint(v * 10000.0) / 10000.0; }
}
