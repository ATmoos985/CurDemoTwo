package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.ExecutionOrder;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.QualityDisposition;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.persistence.HotColdModels;
import com.example.cutdemotwo.persistence.InventoryStore;
import tools.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * 热冷分离查询与裁剪桥接器（包级私有协作者，严格单向向下依赖 InventoryStore 与 business.model，绝不引用 InventoryStateKernel）。
 */
final class ColdStateQueryBridge {
    private static final Set<String> TERMINAL_EXECUTION_STATES = Set.of("REPORTED", "CANCELLED", "REVERSED", "FAILED");
    private static final Set<String> HOT_SCHEME_STATES = Set.of("AWAITING_ROLL", "READY_TO_CUT", "DISPATCHED_MES");
    private static final Set<String> HOT_REMNANT_STATUSES = Set.of("AVAILABLE", "QUARANTINED", "LOST");

    private ColdStateQueryBridge() {}

    static boolean isHotRoll(MotherRollInfo roll, Set<String> pinnedRollIds) {
        if (roll == null) return false;
        if (pinnedRollIds.contains(roll.getRollId())) return true;
        return !"SCRAPPED".equalsIgnoreCase(roll.getInspectionStatus()) && roll.getCurrentRemainingLength() > 0.001;
    }

    static boolean isHotRemnant(RemnantStock rem, Set<String> pinnedRemnantIds) {
        if (rem == null) return false;
        return pinnedRemnantIds.contains(rem.getId()) || HOT_REMNANT_STATUSES.contains(rem.getStatus());
    }

    static boolean isHotExecution(ExecutionOrder exec) {
        return exec != null && !TERMINAL_EXECUTION_STATES.contains(exec.state());
    }

    static boolean isHotScheme(SchedulingScheme scheme) {
        return scheme != null && HOT_SCHEME_STATES.contains(scheme.state());
    }

    static boolean isHotPlan(CuttingPlan plan, Set<String> pinnedPlanIds) {
        return plan != null && ("PENDING".equals(plan.status()) || pinnedPlanIds.contains(plan.id()));
    }

    static boolean isHotTask(CuttingTask task, Map<String, Integer> completed, Set<String> pinnedTaskIds) {
        if (task == null) return false;
        if (pinnedTaskIds.contains(task.id()) || task.demands().isEmpty()) return true;
        return task.demands().stream().anyMatch(line ->
                completed.getOrDefault(String.valueOf(line.id()), 0) < line.quantity());
    }

    static List<QualityDisposition> qualityEvents(ObjectMapper json, Map<String, Object> receipt) {
        if (receipt == null || !(receipt.get("qualityDispositions") instanceof List<?> events)) return List.of();
        return events.stream().map(event -> json.convertValue(event, QualityDisposition.class)).toList();
    }

    static int qualityRevisionOf(List<QualityDisposition> events) {
        int revoked = (int) events.stream().filter(QualityDisposition::hasRevocation).count();
        return events.size() + revoked;
    }

    static Map<String, Object> qualityProjection(ObjectMapper json, Map<String, Object> receipt) {
        if (receipt == null) return null;
        var result = new LinkedHashMap<>(receipt);
        if (receipt.get("inventoryCountRevision") instanceof Number counted) {
            result.put("inventoryCountRevision", counted.longValue());
        }
        var events = qualityEvents(json, receipt);
        var activeEvents = events.stream().filter(e -> !e.hasRevocation()).toList();
        var removed = activeEvents.stream().filter(e -> "QUALIFIED".equals(e.originalOutcome())).toList();
        double removedArea = removed.stream().mapToDouble(QualityDisposition::pieceAreaMm2).sum() / 1_000_000;
        double recovered = activeEvents.stream().mapToDouble(QualityDisposition::recoveredAreaMm2).sum() / 1_000_000;
        double goodArea = ((Number) receipt.get("pieceArea")).doubleValue() - removedArea;
        double usedArea = ((Number) receipt.get("usedArea")).doubleValue();
        result.put("qualityDispositions", events);
        result.put("qualityRevision", qualityRevisionOf(events));
        int finishedCnt = receipt.get("finishedPieceCount") instanceof Number n ? n.intValue() : 0;
        result.put("netFinishedPieceCount", finishedCnt - removed.size());
        result.put("netPieceArea", Math.max(0, goodArea));
        result.put("netRemArea", ((Number) receipt.get("remArea")).doubleValue() + recovered);
        result.put("netWasteArea", Math.max(0, ((Number) receipt.get("wasteArea")).doubleValue() + removedArea - recovered));
        result.put("netUtilization", usedArea > 0 ? Math.max(0, goodArea) / usedArea * 100 : 0);
        return result;
    }

    static Map<String, Integer> computeTaskCompleted(
            InventoryStore store,
            Map<String, Map<String, Object>> hotReceipts,
            String taskId
    ) {
        Map<String, Integer> result = new LinkedHashMap<>();
        List<Map<String, Object>> reports;
        if (store.supportsHotColdLoading()) {
            Map<String, Map<String, Object>> merged = new LinkedHashMap<>();
            for (Map<String, Object> dbRec : store.findCutReportsByTaskId(taskId)) {
                Object pid = dbRec.get("planId");
                if (pid != null) merged.put(pid.toString(), dbRec);
            }
            for (Map<String, Object> hot : hotReceipts.values()) {
                if (InventoryJournal.receiptTaskIds(hot).contains(taskId) && hot.get("planId") != null) {
                    merged.put(hot.get("planId").toString(), hot);
                }
            }
            reports = new ArrayList<>(merged.values());
        } else {
            reports = hotReceipts.values().stream()
                    .filter(r -> InventoryJournal.receiptTaskIds(r).contains(taskId))
                    .toList();
        }
        for (Map<String, Object> receipt : reports) {
            InventoryJournal.accumulateCompletedForTask(receipt, taskId, result);
        }
        return result;
    }

    static List<Map<String, Object>> loadTaskReports(
            ObjectMapper json,
            InventoryStore store,
            Map<String, Map<String, Object>> hotReceipts,
            String taskId
    ) {
        List<Map<String, Object>> raw;
        if (store.supportsHotColdLoading()) {
            Map<String, Map<String, Object>> merged = new LinkedHashMap<>();
            for (Map<String, Object> dbRec : store.findCutReportsByTaskId(taskId)) {
                Object pid = dbRec.get("planId");
                if (pid != null) merged.put(pid.toString(), dbRec);
            }
            for (Map<String, Object> hot : hotReceipts.values()) {
                if (InventoryJournal.receiptTaskIds(hot).contains(taskId) && hot.get("planId") != null) {
                    merged.put(hot.get("planId").toString(), hot);
                }
            }
            raw = new ArrayList<>(merged.values());
        } else {
            raw = hotReceipts.values().stream()
                    .filter(r -> InventoryJournal.receiptTaskIds(r).contains(taskId))
                    .toList();
        }
        return raw.stream().map(r -> qualityProjection(json, r)).toList();
    }

    static Map<String, Object> buildReconciliationReportsPage(
            ObjectMapper json,
            InventoryStore store,
            Map<String, Map<String, Object>> hotReceipts,
            Map<String, SchedulingScheme> hotSchemes,
            Function<String, Optional<CuttingTask>> taskLookup,
            Function<String, Optional<CuttingPlan>> planLookup,
            Function<String, Optional<MotherRollInfo>> rollLookup,
            Function<String, Optional<RemnantStock>> remnantLookup,
            int limit,
            int offset,
            String statusFilter,
            String taskIdFilter
    ) {
        List<Map<String, Object>> selectedRaw;
        long total;
        boolean hasMore;
        if (store.supportsHotColdLoading()) {
            HotColdModels.PagedSlice<Map<String, Object>> slice = store.queryCutReportsPage(limit, offset, statusFilter, taskIdFilter);
            selectedRaw = slice.items();
            total = slice.total();
            hasMore = slice.hasMore();
        } else {
            List<Map<String, Object>> filtered = new ArrayList<>();
            for (Map<String, Object> raw : hotReceipts.values()) {
                String status = Objects.toString(raw.get("status"), "CONFIRMED");
                if (statusFilter != null && !statusFilter.isBlank() && !"ALL".equalsIgnoreCase(statusFilter)
                        && !statusFilter.equalsIgnoreCase(status)) {
                    continue;
                }
                if (taskIdFilter != null && !taskIdFilter.isBlank() && !InventoryJournal.receiptTaskIds(raw).contains(taskIdFilter)) {
                    continue;
                }
                filtered.add(raw);
            }
            filtered.sort((a, b) -> Objects.toString(b.get("confirmedAt"), "")
                    .compareTo(Objects.toString(a.get("confirmedAt"), "")));
            total = filtered.size();
            int from = Math.min(offset, filtered.size());
            int to = Math.min(from + limit, filtered.size());
            selectedRaw = filtered.subList(from, to);
            hasMore = to < filtered.size();
        }

        Map<String, String> planToSchemeId = new HashMap<>();
        if (!selectedRaw.isEmpty()) {
            Set<String> neededPlanIds = new LinkedHashSet<>();
            Set<String> neededTaskIds = new LinkedHashSet<>();
            for (Map<String, Object> raw : selectedRaw) {
                Object pid = raw.get("planId");
                if (pid != null && !pid.toString().isBlank()) neededPlanIds.add(pid.toString());
                neededTaskIds.addAll(InventoryJournal.receiptTaskIds(raw));
            }
            for (SchedulingScheme sc : hotSchemes.values()) {
                for (String pid : sc.linkedPlanIds()) {
                    if (neededPlanIds.contains(pid)) {
                        planToSchemeId.put(pid, sc.id());
                    }
                }
            }
            if (store.supportsHotColdLoading()) {
                Set<String> missingPlanIds = new LinkedHashSet<>();
                for (String pid : neededPlanIds) {
                    if (!planToSchemeId.containsKey(pid)) missingPlanIds.add(pid);
                }
                if (!missingPlanIds.isEmpty()) {
                    for (SchedulingScheme sc : store.findSchemesForPlanIds(missingPlanIds, neededTaskIds)) {
                        for (String pid : sc.linkedPlanIds()) {
                            if (neededPlanIds.contains(pid)) {
                                planToSchemeId.putIfAbsent(pid, sc.id());
                            }
                        }
                    }
                }
            }
        }

        Map<String, CuttingTask> taskCache = new HashMap<>();
        Map<String, MotherRollInfo> rollCache = new HashMap<>();
        Map<String, RemnantStock> remCache = new HashMap<>();
        List<Map<String, Object>> page = new ArrayList<>(selectedRaw.size());

        for (Map<String, Object> raw : selectedRaw) {
            String status = Objects.toString(raw.get("status"), "CONFIRMED");
            String taskId = raw.get("taskId") != null ? raw.get("taskId").toString() : null;
            String planId = Objects.toString(raw.get("planId"), "");
            Map<String, Object> projected = qualityProjection(json, raw);
            CuttingTask task = taskId != null ? taskCache.computeIfAbsent(taskId, id -> taskLookup.apply(id).orElse(null)) : null;
            CuttingPlan plan = planLookup.apply(planId).orElse(null);
            String rollId = raw.get("rollId") != null ? raw.get("rollId").toString() : null;
            MotherRollInfo roll = rollId != null ? rollCache.computeIfAbsent(rollId, id -> rollLookup.apply(id).orElse(null)) : null;
            String sourceRemnantId = raw.get("sourceRemnantId") != null ? raw.get("sourceRemnantId").toString() : null;
            RemnantStock sourceRemnant = sourceRemnantId != null
                    ? remCache.computeIfAbsent(sourceRemnantId, id -> remnantLookup.apply(id).orElse(null)) : null;

            String materialModel = task != null ? task.materialModel()
                    : (plan != null && plan.request() != null && plan.request().getRollModel() != null && !plan.request().getRollModel().isBlank()
                    ? plan.request().getRollModel().trim()
                    : (roll != null ? roll.getRollModel() : (sourceRemnant != null ? sourceRemnant.getMaterialBatch() : "")));
            String batchNo = sourceRemnant != null && sourceRemnant.getBatchNo() != null && !sourceRemnant.getBatchNo().isBlank()
                    ? sourceRemnant.getBatchNo().trim()
                    : (roll != null ? roll.getBatchNo() : null);
            String color = sourceRemnant != null && sourceRemnant.getColor() != null && !sourceRemnant.getColor().isBlank()
                    ? sourceRemnant.getColor().trim()
                    : (roll != null ? roll.getColor() : null);

            List<QualityDisposition> dispositions = qualityEvents(json, raw);
            Set<Integer> activeDisposedPieceIds = dispositions.stream()
                    .filter(d -> !d.hasRevocation())
                    .map(d -> d.command().pieceId())
                    .collect(Collectors.toSet());
            int activeDispCount = activeDisposedPieceIds.size();
            int revokedDispCount = dispositions.size() - activeDispCount;
            int reinspectionRemaining = 0;
            if (!"REVERSED".equals(status) && raw.get("pieceResults") instanceof List<?> pieceList) {
                for (Object pObj : pieceList) {
                    var piece = json.convertValue(pObj, ReportOutput.ReportedPiece.class);
                    if (Set.of("QUALIFIED", "REJECTED").contains(piece.outcome())
                            && !activeDisposedPieceIds.contains(piece.pieceId())) {
                        reinspectionRemaining++;
                    }
                }
            }

            Map<String, Object> item = new LinkedHashMap<>(projected);
            item.put("reportId", planId);
            item.put("schemeId", planToSchemeId.get(planId));
            item.put("taskId", taskId);
            item.put("taskName", task != null ? task.name() : "独立裁切");
            item.put("externalRef", task != null ? task.externalRef() : null);
            item.put("materialModel", materialModel);
            item.put("batchNo", batchNo);
            item.put("color", color);
            item.put("dispositions", dispositions);
            item.put("activeDispositionCount", activeDispCount);
            item.put("revokedDispositionCount", revokedDispCount);
            item.put("reinspectionRemainingCount", reinspectionRemaining);
            item.put("availableForReinspection", reinspectionRemaining);
            page.add(item);
        }

        Map<String, Object> res = new LinkedHashMap<>();
        res.put("items", List.copyOf(page));
        res.put("total", total);
        res.put("limit", limit);
        res.put("offset", offset);
        res.put("hasMore", hasMore);
        return res;
    }
}
