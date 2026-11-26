package com.example.cutdemotwo.business.model;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 搭切排程正式选定方案（统一承载 2D 异形轮廓、2D 矩形直刀与 1D 定长分切结果）：
 * 1. 原样冻结保存已验证图纸/刀组，绝不在移交或锁卷时静默重新调用算法覆盖；
 * 2. 活跃状态（AWAITING_ROLL / READY_TO_CUT / DISPATCHED_MES）自动占用对应需求的 plannedQty，扣减待排量 openQty；
 * 3. 支持先在默认虚拟新母卷（VIRTUAL_ROLL）上确认方案并生成备料建议，后续再绑定在库实卷并一键完工过账或由 MES 回传核销；
 * 4. 支持跨任务多族合排（sourceAllocations）与报工冲销状态联动（REVERSED）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SchedulingScheme(
        String id,
        String idempotencyKey,
        String title,
        String dimension,
        String scenarioId,
        String strategyId,
        String strategyName,
        String taskId,
        String taskName,
        String externalOrderNo,
        String materialMode,
        String rollId,
        String remnantId,
        String materialModel,
        double widthMm,
        double canvasLengthMm,
        double windowStartY,
        double occupiedLengthMm,
        double trimStartMm,
        double pieceGapMm,
        double utilizationPct,
        double pieceAreaM2,
        int placedCount,
        int requestedCount,
        int gapFillCount,
        boolean complete,
        Map<String, Integer> allocatedDemands,
        List<String> linkedPlanIds,
        String linkedExecutionId,
        String state,
        SuggestedRollSpec suggestedRoll,
        Layout2DPayload layout2D,
        Slitting1DPayload slitting1D,
        String mesWorkOrderNo,
        String createdAt,
        String dispatchedAt,
        String completedAt,
        String cancelledAt,
        String cancelReason,
        @JsonInclude(JsonInclude.Include.NON_EMPTY) List<TaskDemandAllocation> sourceAllocations,
        @JsonInclude(JsonInclude.Include.NON_NULL) String mesReceiptNo
) {
    public static final String STATE_AWAITING_ROLL = "AWAITING_ROLL";
    public static final String STATE_READY_TO_CUT = "READY_TO_CUT";
    public static final String STATE_DISPATCHED_MES = "DISPATCHED_MES";
    public static final String STATE_COMPLETED = "COMPLETED";
    public static final String STATE_CANCELLED = "CANCELLED";
    public static final String STATE_REVERSED = "REVERSED";

    public SchedulingScheme {
        allocatedDemands = allocatedDemands == null || allocatedDemands.isEmpty()
                ? Map.of()
                : Collections.unmodifiableMap(new LinkedHashMap<>(allocatedDemands));
        linkedPlanIds = linkedPlanIds == null ? List.of() : List.copyOf(linkedPlanIds);
        sourceAllocations = sourceAllocations == null ? List.of() : List.copyOf(sourceAllocations);
    }

    /** 兼容旧 39 参数构造器（单任务无 MES 回执号）。 */
    public SchedulingScheme(
            String id, String idempotencyKey, String title, String dimension,
            String scenarioId, String strategyId, String strategyName,
            String taskId, String taskName, String externalOrderNo,
            String materialMode, String rollId, String remnantId, String materialModel,
            double widthMm, double canvasLengthMm, double windowStartY, double occupiedLengthMm,
            double trimStartMm, double pieceGapMm, double utilizationPct, double pieceAreaM2,
            int placedCount, int requestedCount, int gapFillCount, boolean complete,
            Map<String, Integer> allocatedDemands, List<String> linkedPlanIds, String linkedExecutionId,
            String state, SuggestedRollSpec suggestedRoll, Layout2DPayload layout2D,
            Slitting1DPayload slitting1D, String mesWorkOrderNo, String createdAt,
            String dispatchedAt, String completedAt, String cancelledAt, String cancelReason
    ) {
        this(id, idempotencyKey, title, dimension, scenarioId, strategyId, strategyName,
                taskId, taskName, externalOrderNo, materialMode, rollId, remnantId, materialModel,
                widthMm, canvasLengthMm, windowStartY, occupiedLengthMm, trimStartMm, pieceGapMm,
                utilizationPct, pieceAreaM2, placedCount, requestedCount, gapFillCount, complete,
                allocatedDemands, linkedPlanIds, linkedExecutionId, state, suggestedRoll, layout2D,
                slitting1D, mesWorkOrderNo, createdAt, dispatchedAt, completedAt, cancelledAt, cancelReason,
                List.of(), null);
    }

    /** 是否处于占用待排需求（plannedQty）的未完结有效态。 */
    public boolean occupiesDemand() {
        return STATE_AWAITING_ROLL.equals(state)
                || STATE_READY_TO_CUT.equals(state)
                || STATE_DISPATCHED_MES.equals(state);
    }

    /** 是否处于占用实物材料（已绑实卷或料头，未完工未作废未冲销）的活跃锁料态。 */
    public boolean isMaterialLockActive() {
        return STATE_READY_TO_CUT.equals(state) || STATE_DISPATCHED_MES.equals(state);
    }

    /** 是否正在占用特定实卷区段。 */
    public boolean occupiesRoll(String targetRollId) {
        return isMaterialLockActive()
                && "STOCK_ROLL".equals(materialMode)
                && targetRollId != null
                && targetRollId.equals(rollId)
                && occupiedLengthMm > 0;
    }

    /** 是否正在占用特定在库料头。 */
    public boolean occupiesRemnant(String targetRemnantId) {
        return isMaterialLockActive()
                && "REMNANT".equals(materialMode)
                && targetRemnantId != null
                && targetRemnantId.equals(remnantId);
    }

    /** 按材料类型（roll / remnant）判断是否锁定指定物理材料。 */
    public boolean occupiesMaterial(String materialType, String materialId) {
        if ("roll".equalsIgnoreCase(materialType)) return occupiesRoll(materialId);
        if ("remnant".equalsIgnoreCase(materialType)) return occupiesRemnant(materialId);
        return false;
    }

    /** 统一展开本方案占用的任务需求行分配（兼容多族合排 sourceAllocations 与单任务 allocatedDemands）。 */
    public List<TaskDemandAllocation> effectiveAllocations() {
        if (sourceAllocations != null && !sourceAllocations.isEmpty()) {
            return sourceAllocations;
        }
        if (taskId == null || taskId.isBlank() || allocatedDemands.isEmpty()) {
            return List.of();
        }
        List<TaskDemandAllocation> list = new ArrayList<>();
        for (Map.Entry<String, Integer> entry : allocatedDemands.entrySet()) {
            int qty = entry.getValue() == null ? 0 : entry.getValue();
            if (qty <= 0) continue;
            try {
                list.add(new TaskDemandAllocation(taskId, Integer.parseInt(entry.getKey().trim()), qty));
            } catch (NumberFormatException ignored) {
                // 兼容历史或复合键
            }
        }
        return List.copyOf(list);
    }

    /** 是否属于跨多个源任务的合排方案。 */
    public boolean isMultiTaskMerged() {
        if (sourceAllocations == null || sourceAllocations.isEmpty()) return false;
        return sourceAllocations.stream().map(TaskDemandAllocation::taskId).distinct().count() > 1;
    }

    /** 判断本方案是否涉及指定任务（支持单任务与跨任务合排）。 */
    public boolean involvesTask(String targetTaskId) {
        if (targetTaskId == null || targetTaskId.isBlank()) return false;
        if (targetTaskId.equals(taskId)) return true;
        return sourceAllocations != null && sourceAllocations.stream().anyMatch(a -> targetTaskId.equals(a.taskId()));
    }

    /** 返回本方案涉及的全部唯一源任务编号列表。 */
    public List<String> involvedTaskIds() {
        List<String> ids = new ArrayList<>();
        if (sourceAllocations != null && !sourceAllocations.isEmpty()) {
            for (TaskDemandAllocation alloc : sourceAllocations) {
                if (alloc.taskId() != null && !alloc.taskId().isBlank() && !ids.contains(alloc.taskId())) {
                    ids.add(alloc.taskId());
                }
            }
        }
        if (ids.isEmpty() && taskId != null && !taskId.isBlank()) {
            ids.add(taskId);
        }
        return List.copyOf(ids);
    }

    public SchedulingScheme withBinding(String boundRollId, double startY, List<String> planIds, String execId, String nextState) {
        return new SchedulingScheme(
                id, idempotencyKey, title, dimension, scenarioId, strategyId, strategyName,
                taskId, taskName, externalOrderNo, "STOCK_ROLL", boundRollId, remnantId,
                materialModel, widthMm, canvasLengthMm, startY, occupiedLengthMm, trimStartMm, pieceGapMm,
                utilizationPct, pieceAreaM2, placedCount, requestedCount, gapFillCount, complete,
                allocatedDemands, planIds, execId, nextState, suggestedRoll, layout2D, slitting1D,
                mesWorkOrderNo, createdAt, dispatchedAt, completedAt, cancelledAt, cancelReason,
                sourceAllocations, mesReceiptNo
        );
    }

    public SchedulingScheme withDispatched(String workOrderNo, String at) {
        return new SchedulingScheme(
                id, idempotencyKey, title, dimension, scenarioId, strategyId, strategyName,
                taskId, taskName, externalOrderNo, materialMode, rollId, remnantId,
                materialModel, widthMm, canvasLengthMm, windowStartY, occupiedLengthMm, trimStartMm, pieceGapMm,
                utilizationPct, pieceAreaM2, placedCount, requestedCount, gapFillCount, complete,
                allocatedDemands, linkedPlanIds, linkedExecutionId, STATE_DISPATCHED_MES, suggestedRoll,
                layout2D, slitting1D, workOrderNo, createdAt, at, completedAt, cancelledAt, cancelReason,
                sourceAllocations, mesReceiptNo
        );
    }

    public SchedulingScheme withCompleted(String at) {
        return withCompleted(at, mesReceiptNo);
    }

    public SchedulingScheme withCompleted(String at, String receiptNo) {
        String effectiveReceiptNo = (receiptNo != null && !receiptNo.isBlank()) ? receiptNo.trim() : mesReceiptNo;
        return new SchedulingScheme(
                id, idempotencyKey, title, dimension, scenarioId, strategyId, strategyName,
                taskId, taskName, externalOrderNo, materialMode, rollId, remnantId,
                materialModel, widthMm, canvasLengthMm, windowStartY, occupiedLengthMm, trimStartMm, pieceGapMm,
                utilizationPct, pieceAreaM2, placedCount, requestedCount, gapFillCount, complete,
                allocatedDemands, linkedPlanIds, linkedExecutionId, STATE_COMPLETED, suggestedRoll,
                layout2D, slitting1D, mesWorkOrderNo, createdAt, dispatchedAt, at, cancelledAt, cancelReason,
                sourceAllocations, effectiveReceiptNo
        );
    }

    public SchedulingScheme withCancelled(String at, String reason) {
        return new SchedulingScheme(
                id, idempotencyKey, title, dimension, scenarioId, strategyId, strategyName,
                taskId, taskName, externalOrderNo, materialMode, rollId, remnantId,
                materialModel, widthMm, canvasLengthMm, windowStartY, occupiedLengthMm, trimStartMm, pieceGapMm,
                utilizationPct, pieceAreaM2, placedCount, requestedCount, gapFillCount, complete,
                allocatedDemands, linkedPlanIds, linkedExecutionId, STATE_CANCELLED, suggestedRoll,
                layout2D, slitting1D, mesWorkOrderNo, createdAt, dispatchedAt, completedAt, at, reason,
                sourceAllocations, mesReceiptNo
        );
    }

    public SchedulingScheme withReversed(String at, String reason) {
        return new SchedulingScheme(
                id, idempotencyKey, title, dimension, scenarioId, strategyId, strategyName,
                taskId, taskName, externalOrderNo, materialMode, rollId, remnantId,
                materialModel, widthMm, canvasLengthMm, windowStartY, occupiedLengthMm, trimStartMm, pieceGapMm,
                utilizationPct, pieceAreaM2, placedCount, requestedCount, gapFillCount, complete,
                allocatedDemands, linkedPlanIds, linkedExecutionId, STATE_REVERSED, suggestedRoll,
                layout2D, slitting1D, mesWorkOrderNo, createdAt, dispatchedAt, completedAt, at, reason,
                sourceAllocations, mesReceiptNo
        );
    }

    /** 跨任务多族合排时的源任务需求行分配项。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record TaskDemandAllocation(
            String taskId,
            int lineId,
            int quantity
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SuggestedRollSpec(
            String materialModel,
            double widthMm,
            double minLengthMm,
            int totalCars
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Layout2DPayload(
            List<PlacementItem> placements,
            List<LeftoverItem> leftovers,
            List<CutLineItem> cuts
    ) {
        public Layout2DPayload {
            placements = placements == null ? List.of() : List.copyOf(placements);
            leftovers = leftovers == null ? List.of() : List.copyOf(leftovers);
            cuts = cuts == null ? List.of() : List.copyOf(cuts);
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PlacementItem(
            int id,
            int demandId,
            String name,
            double x,
            double y,
            double w,
            double l,
            int rotationDegrees,
            Boolean gapFill,
            NestingProblem.Shape shape,
            String sourceTaskId,
            Integer sourceLineId
    ) {
        public PlacementItem(
                int id, int demandId, String name, double x, double y, double w, double l,
                int rotationDegrees, Boolean gapFill, NestingProblem.Shape shape
        ) {
            this(id, demandId, name, x, y, w, l, rotationDegrees, gapFill, shape, null, null);
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record LeftoverItem(
            String id,
            double x,
            double y,
            double w,
            double l,
            boolean hasDefect
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record CutLineItem(
            int sequence,
            String kind,
            double startX,
            double startY,
            double endX,
            double endY
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Slitting1DPayload(
            int leftTrimMm,
            int rightTrimMm,
            int minWidthMm,
            int maxWidthMm,
            int widthStepMm,
            int totalOverCap,
            int fixedLengthMm,
            int totalCars,
            int missingRolls,
            int overproducedRolls,
            List<SlittingPatternItem> patterns,
            List<SlittingFulfillmentItem> fulfillment
    ) {
        public Slitting1DPayload {
            patterns = patterns == null ? List.of() : List.copyOf(patterns);
            fulfillment = fulfillment == null ? List.of() : List.copyOf(fulfillment);
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SlittingPatternItem(
            String id,
            int lengthMm,
            int repetitions,
            int usedWidthMm,
            int spareWidthMm,
            List<StationItem> stations,
            String surfaceTreatment,
            @JsonInclude(JsonInclude.Include.NON_EMPTY) List<SlittingAllocationItem> allocations
    ) {
        public SlittingPatternItem {
            stations = stations == null ? List.of() : List.copyOf(stations);
            allocations = allocations == null ? List.of() : List.copyOf(allocations);
        }

        public SlittingPatternItem(
                String id, int lengthMm, int repetitions, int usedWidthMm, int spareWidthMm, List<StationItem> stations
        ) {
            this(id, lengthMm, repetitions, usedWidthMm, spareWidthMm, stations, null, List.of());
        }
    }

    /** 算法验证后的每刀组归属分配（quantity 已含全部 repetitions 总卷数，不重复乘 repetitions）。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SlittingAllocationItem(String orderId, int quantity) {}

    public record StationItem(int widthMm, int countPerRepetition) {}

    public record SlittingFulfillmentItem(
            String orderId,
            String name,
            int widthMm,
            int requested,
            int produced,
            int missing,
            int overproduced
    ) {}
}
