package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.SchedulingScheme;

import java.util.*;

/**
 * 排程方案视图查询与需求族摘要装配协作者。
 */
final class StudioSchemeViewSupport {
    private final CuttingStatePort statePort;
    private final StudioDemandPoolService demandPoolService;

    StudioSchemeViewSupport(CuttingStatePort statePort, StudioDemandPoolService demandPoolService) {
        this.statePort = statePort;
        this.demandPoolService = demandPoolService;
    }

    List<Map<String, Object>> listSchemes(String stateFilter, String taskIdFilter, boolean summary) {
        return statePort.inRead(tx -> {
            List<SchedulingScheme> list = new ArrayList<>(tx.listSchemes());
            Collections.reverse(list);
            List<Map<String, Object>> out = new ArrayList<>();
            for (SchedulingScheme s : list) {
                if (stateFilter != null && !stateFilter.isBlank() && !"ALL".equalsIgnoreCase(stateFilter)
                        && !stateFilter.equalsIgnoreCase(s.state())) {
                    continue;
                }
                if (taskIdFilter != null && !taskIdFilter.isBlank() && !s.involvesTask(taskIdFilter)) {
                    continue;
                }
                out.add(enrichSchemeView(tx, summary ? summarizeScheme(s) : s));
            }
            return out;
        });
    }

    Map<String, Object> getSchemeDetail(String id) {
        return statePort.inRead(tx -> {
            SchedulingScheme s = tx.findScheme(id)
                    .orElseThrow(() -> new IllegalArgumentException("排程方案不存在: " + id));
            return enrichSchemeView(tx, s);
        });
    }

    Map<String, CuttingTask> loadSourceTasksForScheme(CuttingStatePort.ReadView tx, SchedulingScheme scheme) {
        Map<String, CuttingTask> map = new LinkedHashMap<>();
        for (String tid : scheme.involvedTaskIds()) {
            tx.findTask(tid).ifPresent(t -> map.put(t.id(), t));
        }
        return map;
    }

    Map<String, Object> enrichWithDemandFamilies(CuttingStatePort.ReadView tx, SchedulingScheme scheme) {
        Map<String, Object> out = new LinkedHashMap<>(enrichSchemeView(tx, scheme));
        List<Map<String, Object>> families = new ArrayList<>();
        for (String tid : scheme.involvedTaskIds()) {
            tx.findTask(tid).ifPresent(t -> families.add(demandPoolService.buildDemandFamilyView(tx, t)));
        }
        if (!families.isEmpty()) {
            out.put("demandFamily", families.get(0));
            if (families.size() > 1 || (scheme.sourceAllocations() != null && !scheme.sourceAllocations().isEmpty())) {
                out.put("demandFamilies", families);
            }
        }
        return out;
    }

    Map<String, Object> enrichSchemeView(CuttingStatePort.ReadView tx, SchedulingScheme s) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("scheme", s);
        MotherRollInfo roll = s.rollId() != null ? tx.findRoll(s.rollId()).orElse(null) : null;
        if (roll != null) {
            map.put("rollInfo", rollSummaryMap(roll));
        }
        List<Map<String, Object>> planReceipts = new ArrayList<>();
        for (String pid : s.linkedPlanIds()) {
            Map<String, Object> r = tx.findReceipt(pid).orElse(null);
            if (r != null && !"REVERSED".equals(r.get("status"))) {
                planReceipts.add(tx.projectQuality(r));
            }
        }
        map.put("receipts", planReceipts);
        boolean needsRoll = SchedulingScheme.STATE_AWAITING_ROLL.equals(s.state())
                || (SchedulingScheme.STATE_DISPATCHED_MES.equals(s.state()) && s.linkedPlanIds().isEmpty());
        map.put("canBindRoll", needsRoll);
        map.put("canComplete", !needsRoll && (SchedulingScheme.STATE_READY_TO_CUT.equals(s.state()) || SchedulingScheme.STATE_DISPATCHED_MES.equals(s.state())));
        map.put("canCancel", s.occupiesDemand() && planReceipts.isEmpty());
        return map;
    }

    Map<String, Object> rollSummaryMap(MotherRollInfo roll) {
        Map<String, Object> info = new LinkedHashMap<>();
        info.put("rollId", roll.getRollId());
        info.put("rollModel", roll.getRollModel());
        info.put("width", roll.getWidth());
        info.put("totalLength", roll.getTotalLength());
        info.put("usedLength", roll.getUsedLength());
        info.put("remainingLength", roll.getCurrentRemainingLength());
        info.put("storageLocation", Objects.toString(roll.getStorageLocation(), ""));
        info.put("inspectionStatus", Objects.toString(roll.getInspectionStatus(), ""));
        info.put("inspector", Objects.toString(roll.getInspector(), ""));
        info.put("defectCount", roll.getDefects() != null ? roll.getDefects().size() : 0);
        return info;
    }

    static SchedulingScheme summarizeScheme(SchedulingScheme s) {
        if (s.layout2D() == null) return s;
        return new SchedulingScheme(
                s.id(), s.idempotencyKey(), s.title(), s.dimension(), s.scenarioId(), s.strategyId(), s.strategyName(),
                s.taskId(), s.taskName(), s.externalOrderNo(), s.materialMode(), s.rollId(), s.remnantId(),
                s.materialModel(), s.widthMm(), s.canvasLengthMm(), s.windowStartY(), s.occupiedLengthMm(),
                s.trimStartMm(), s.pieceGapMm(), s.utilizationPct(), s.pieceAreaM2(), s.placedCount(),
                s.requestedCount(), s.gapFillCount(), s.complete(), s.allocatedDemands(), s.linkedPlanIds(),
                s.linkedExecutionId(), s.state(), s.suggestedRoll(), null, s.slitting1D(), s.mesWorkOrderNo(),
                s.createdAt(), s.dispatchedAt(), s.completedAt(), s.cancelledAt(), s.cancelReason(),
                s.sourceAllocations(), s.mesReceiptNo()
        );
    }

    static String resolveActor(String operator, String fallback) {
        if (operator == null || operator.isBlank()) return fallback;
        String clean = operator.trim();
        if (clean.length() > 100) clean = clean.substring(0, 100);
        if (clean.startsWith("MES:") || clean.startsWith("DECLARED:")) return clean;
        return "DECLARED:" + clean;
    }
}
