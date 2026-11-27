package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.ExecutionOrder;
import com.example.cutdemotwo.business.model.QualityDisposition;
import com.example.cutdemotwo.business.model.SolveResponse;
import com.example.cutdemotwo.persistence.InventoryConflictException;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import java.util.function.Function;

/**
 * {@link CuttingExecutionAndReportService} 的视图投影与几何重叠校验静态辅助类。
 */
final class CuttingExecutionProjectionHelper {
    private CuttingExecutionProjectionHelper() {}

    static Map<String, Object> buildExecutionView(ExecutionOrder e, long operationTime, Consumer<ExecutionOrder> releaseValidator) {
        String effective = e.effectiveState(operationTime);
        var actions = new LinkedHashMap<String, Object>();
        for (String action : List.of("release", "start", "cancel", "report")) {
            boolean allowed = switch (action) {
                case "release" -> Set.of("DRAFT", "EXPIRED").contains(effective);
                case "start" -> "RELEASED".equals(effective);
                case "cancel" -> Set.of("DRAFT", "RELEASED", "EXPIRED").contains(effective);
                default -> "RUNNING".equals(effective);
            };
            String reason = allowed ? "" : "当前执行状态不支持此操作";
            if (allowed && Set.of("release", "start").contains(action)) {
                try {
                    releaseValidator.accept(e);
                } catch (IllegalArgumentException | InventoryConflictException error) {
                    allowed = false;
                    reason = error.getMessage();
                }
            }
            actions.put(action, Map.of("allowed", allowed, "reason", reason));
        }
        return Map.of("execution", e, "effectiveState", effective,
                "reservationActive", e.reserves(operationTime), "allowedActions", actions);
    }

    static CuttingPlan summarizePlan(CuttingPlan plan) {
        SolveResponse orig = plan.result();
        if (orig == null) return plan;
        SolveResponse slim = new SolveResponse();
        slim.setSuccess(orig.isSuccess());
        slim.setMessage(orig.getMessage());
        slim.setStatus(orig.getStatus());
        slim.setFulfillment(orig.getFulfillment() == null ? List.of() : List.copyOf(orig.getFulfillment()));
        slim.setPlanId(orig.getPlanId());
        slim.setEngine(orig.getEngine());
        slim.setRequestedEngine(orig.getRequestedEngine());
        slim.setFallbackReason(orig.getFallbackReason());
        slim.setRollW(orig.getRollW());
        slim.setRollL(orig.getRollL());
        slim.setFeedPortType(orig.getFeedPortType());
        slim.setSourceRemnantId(orig.getSourceRemnantId());
        slim.setDeductLen(orig.getDeductLen());
        slim.setTotalArea(orig.getTotalArea());
        slim.setPieceArea(orig.getPieceArea());
        slim.setRemArea(orig.getRemArea());
        slim.setWasteArea(orig.getWasteArea());
        slim.setCuts(List.of());
        slim.setPieces(List.of());
        slim.setRemnants(List.of());
        slim.setDefects(List.of());
        slim.setDerivedRemnants(List.of());
        return new CuttingPlan(plan.id(), plan.request(), slim, plan.baseline(), plan.status(),
                plan.createdAt(), plan.parentPlanId(), plan.version());
    }

    static Map<String, Object> buildPlanDetail(CuttingPlan plan, Map<String, Object> projectedReceipt) {
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("id", plan.id());
        detail.put("unit", "mm");
        detail.put("coordinateSystem", "source-local-top-left");
        detail.put("request", plan.request());
        detail.put("result", plan.result());
        detail.put("status", plan.status());
        detail.put("createdAt", plan.createdAt());
        detail.put("version", plan.version());
        detail.put("parentPlanId", plan.parentPlanId());
        detail.put("receipt", projectedReceipt);
        return detail;
    }

    static boolean overlaps(double x, double y, double w, double l,
                            double otherX, double otherY, double otherW, double otherL) {
        return x < otherX + otherW && x + w > otherX && y < otherY + otherL && y + l > otherY;
    }

    static void validateTaskCapacityForDispositionRevoke(
            Map<String, Object> receipt,
            QualityDisposition target,
            Function<String, CuttingTask> taskFinder,
            Function<String, Map<String, Integer>> completedQtyFinder
    ) {
        String affectedTaskId = null;
        Integer affectedLineId = target.demandId();
        if (receipt.get("taskDemandQuantities") instanceof Map<?, ?> && receipt.get("pieceSources") instanceof Map<?, ?> ps) {
            Object srcObj = ps.get(String.valueOf(target.command().pieceId()));
            if (srcObj == null) srcObj = ps.get(target.command().pieceId());
            if (srcObj instanceof Map<?, ?> srcMap && srcMap.get("taskId") != null && srcMap.get("lineId") instanceof Number ln) {
                affectedTaskId = srcMap.get("taskId").toString();
                affectedLineId = ln.intValue();
            }
        } else if (receipt.get("taskId") != null) {
            affectedTaskId = receipt.get("taskId").toString();
        }
        if (affectedTaskId == null || affectedLineId == null) return;
        CuttingTask task = taskFinder.apply(affectedTaskId);
        if (task == null) return;
        int targetLineId = affectedLineId;
        CuttingTask.Line line = task.demands().stream().filter(d -> d.id() == targetLineId).findFirst().orElse(null);
        if (line == null) return;
        int currentCompleted = completedQtyFinder.apply(affectedTaskId).getOrDefault(String.valueOf(targetLineId), 0);
        if (currentCompleted + 1 > line.quantity()) {
            throw new InventoryConflictException("撤销后任务「" + task.name() + "」需求「" + line.name()
                    + "」合格完成量将超过订单总数(" + line.quantity() + ")，请先核对补排或任务数量");
        }
    }

    static Map<String, Object> buildRevokeDispositionPayload(
            Map<String, Object> projectedReceipt,
            Object tidObj,
            Function<String, CuttingTask> taskFinder,
            Function<String, Map<String, Integer>> completedQtyFinder
    ) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("report", projectedReceipt);
        Map<String, Object> taskView = null;
        CuttingTask t = tidObj != null ? taskFinder.apply(tidObj.toString()) : null;
        if (t != null) {
            Map<String, Integer> completed = completedQtyFinder.apply(t.id());
            int orderedTotal = t.demands().stream().mapToInt(CuttingTask.Line::quantity).sum();
            int completedTotal = t.demands().stream().mapToInt(l -> completed.getOrDefault(String.valueOf(l.id()), 0)).sum();
            taskView = new LinkedHashMap<>();
            taskView.put("id", t.id());
            taskView.put("name", t.name());
            taskView.put("materialModel", t.materialModel());
            taskView.put("externalRef", t.externalRef());
            taskView.put("revision", t.revision());
            taskView.put("demands", t.demands());
            taskView.put("completed", completed);
            taskView.put("orderedTotal", orderedTotal);
            taskView.put("completedTotal", completedTotal);
            taskView.put("remaining", Math.max(0, orderedTotal - completedTotal));
        }
        out.put("task", taskView);
        return out;
    }
}
