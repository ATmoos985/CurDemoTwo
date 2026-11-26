package com.example.cutdemotwo.business.workbench;

import com.example.cutdemotwo.business.cutting.CuttingStatePort;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.ExecutionOrder;
import com.example.cutdemotwo.business.model.SchedulingScheme;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * 工作台只读任务投影辅助工具：
 * 按与需求池完全一致的三态守恒口径计算 {@code orderedQty = openQty + plannedQty + completedQty}，
 * 并统一生成前端工作台深链地址。严禁在本类中执行任何写操作。
 */
final class WorkbenchTaskViewSupport {
    private WorkbenchTaskViewSupport() {}

    /** 按与 StudioDemandPoolService 完全一致的口径计算任务各需求行已排预占量（plannedQty）。 */
    static Map<String, Integer> plannedQuantitiesForTask(CuttingStatePort.ReadView tx, String taskId) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        Set<String> coveredPlans = new HashSet<>();

        for (SchedulingScheme s : tx.listSchemes()) {
            if (!s.occupiesDemand() || !s.involvesTask(taskId)) {
                continue;
            }
            coveredPlans.addAll(s.linkedPlanIds());
            Map<String, Integer> alreadyReportedInScheme = new HashMap<>();
            for (String pid : s.linkedPlanIds()) {
                Map<String, Object> rec = tx.findReceipt(pid).orElse(null);
                if (rec == null || "REVERSED".equals(rec.get("status"))) continue;
                if (rec.get("taskDemandQuantities") instanceof Map<?, ?> multi) {
                    if (multi.get(taskId) instanceof Map<?, ?> taskDq) {
                        taskDq.forEach((k, v) -> alreadyReportedInScheme.merge(
                                String.valueOf(k), ((Number) v).intValue(), Integer::sum));
                    }
                } else if (Objects.equals(taskId, rec.get("taskId"))
                        && rec.get("demandQuantities") instanceof Map<?, ?> dq) {
                    dq.forEach((k, v) -> alreadyReportedInScheme.merge(
                            String.valueOf(k), ((Number) v).intValue(), Integer::sum));
                }
            }
            for (SchedulingScheme.TaskDemandAllocation alloc : s.effectiveAllocations()) {
                if (!Objects.equals(taskId, alloc.taskId())) continue;
                String lineKey = String.valueOf(alloc.lineId());
                int netPlanned = Math.max(0, alloc.quantity() - alreadyReportedInScheme.getOrDefault(lineKey, 0));
                if (netPlanned > 0) {
                    counts.merge(lineKey, netPlanned, Integer::sum);
                }
            }
        }

        long now = tx.operationTime();
        for (ExecutionOrder e : tx.listExecutions()) {
            if (taskId.equals(e.taskId()) && !coveredPlans.contains(e.planId()) && e.reserves(now)) {
                e.demandQuantities().forEach((lineId, qty) -> counts.merge(lineId, qty, Integer::sum));
            }
        }
        return counts;
    }

    /** 计算任务各需求行当前的剩余待排量（openQty）。 */
    static Map<Integer, Integer> openQuantitiesByLineId(CuttingStatePort.ReadView tx, CuttingTask task) {
        Map<String, Integer> completedMap = tx.completedQuantities(task.id());
        Map<String, Integer> plannedMap = plannedQuantitiesForTask(tx, task.id());
        Map<Integer, Integer> openByLine = new LinkedHashMap<>();
        for (CuttingTask.Line line : task.demands()) {
            String key = String.valueOf(line.id());
            int completed = Math.max(0, completedMap.getOrDefault(key, 0));
            int planned = Math.max(0, plannedMap.getOrDefault(key, 0));
            openByLine.put(line.id(), Math.max(0, line.quantity() - completed - planned));
        }
        return openByLine;
    }

    static String inferTaskDimension(CuttingTask task) {
        if (task.slittingTask()) {
            return "SLITTING_1D";
        }
        boolean hasPoly = task.demands().stream().anyMatch(
                d -> d.shape() != null && ("POLYGON".equals(d.shape().type()) || d.shape().hasHoles())
        );
        return hasPoly ? "CONTOUR_2D" : "RECT_2D";
    }

    /** 构建与需求池一致的任务只读摘要视图，供上下文接口与前端工作台直接消费。 */
    static Map<String, Object> buildTaskSummary(CuttingStatePort.ReadView tx, CuttingTask task) {
        Map<String, Integer> completedMap = tx.completedQuantities(task.id());
        Map<String, Integer> plannedMap = plannedQuantitiesForTask(tx, task.id());
        String dimension = inferTaskDimension(task);

        int orderedTotal = 0;
        int plannedTotal = 0;
        int completedTotal = 0;
        int openTotal = 0;
        List<Map<String, Object>> lineViews = new ArrayList<>();

        for (CuttingTask.Line line : task.demands()) {
            String key = String.valueOf(line.id());
            int ordered = line.quantity();
            int completed = Math.max(0, completedMap.getOrDefault(key, 0));
            int planned = Math.max(0, plannedMap.getOrDefault(key, 0));
            int open = Math.max(0, ordered - completed - planned);

            orderedTotal += ordered;
            plannedTotal += planned;
            completedTotal += completed;
            openTotal += open;

            Map<String, Object> lv = new LinkedHashMap<>();
            lv.put("id", line.id());
            lv.put("name", line.name());
            lv.put("width", line.width());
            lv.put("length", line.length());
            lv.put("orderedQty", ordered);
            lv.put("plannedQty", planned);
            lv.put("completedQty", completed);
            lv.put("openQty", open);
            lv.put("allowRotation", line.allowRotation());
            lv.put("allowHalfTurn", Boolean.TRUE.equals(line.allowHalfTurn()));
            lv.put("sizeLabel", line.sizeLabel());
            lv.put("sourceTemplateId", line.sourceTemplateId());
            lv.put("surfaceTreatment", line.surfaceTreatment());
            lv.put("shape", line.shape());
            lineViews.add(lv);
        }

        String status = completedTotal >= orderedTotal && orderedTotal > 0
                ? "COMPLETED"
                : openTotal == 0 && plannedTotal > 0
                ? "FULLY_PLANNED"
                : (plannedTotal > 0 || completedTotal > 0)
                ? "PARTIAL_PLANNED"
                : "OPEN";

        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", task.id());
        view.put("name", task.name());
        view.put("materialModel", task.materialModel());
        view.put("externalRef", task.externalRef());
        view.put("dimension", dimension);
        view.put("revision", task.revision());
        view.put("orderedTotal", orderedTotal);
        view.put("plannedTotal", plannedTotal);
        view.put("completedTotal", completedTotal);
        view.put("openTotal", openTotal);
        view.put("status", status);
        view.put("dueDate", task.dueDate());
        view.put("priority", task.priority() != null ? task.priority() : CuttingTask.PRIORITY_NORMAL);
        view.put("requiredBatchNo", task.requiredBatchNo());
        view.put("requiredColor", task.requiredColor());
        view.put("strictBatchMatch", Boolean.TRUE.equals(task.strictBatchMatch()));
        view.put("lines", lineViews);
        return view;
    }

    /** 统一拼接前端工作台深链地址（路径内相对地址，MCP 宿主可自动补全 origin）。 */
    static String buildWorkbenchUrl(String taskId, String resultId, String draftId) {
        List<String> params = new ArrayList<>(3);
        if (taskId != null && !taskId.isBlank()) {
            params.add("taskId=" + encode(taskId.trim()));
        }
        if (resultId != null && !resultId.isBlank()) {
            params.add("resultId=" + encode(resultId.trim()));
        }
        if (draftId != null && !draftId.isBlank()) {
            params.add("draftId=" + encode(draftId.trim()));
        }
        return params.isEmpty() ? "/app/#/workbench" : "/app/#/workbench?" + String.join("&", params);
    }

    static double quantize01(double value) {
        if (!Double.isFinite(value)) return 0.0;
        double q = Math.rint(value * 10.0) / 10.0;
        return q == 0.0 ? 0.0 : q;
    }

    private static String encode(String raw) {
        return URLEncoder.encode(raw, StandardCharsets.UTF_8);
    }
}
