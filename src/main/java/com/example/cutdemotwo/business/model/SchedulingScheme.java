package com.example.cutdemotwo.business.model;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;
import java.util.Map;

/**
 * 搭切排程正式选定方案（统一承载 2D 异形轮廓、2D 矩形直刀与 1D 定长分切结果）：
 * 1. 原样冻结保存已验证图纸/刀组，绝不在移交或锁卷时静默重新调用算法覆盖；
 * 2. 活跃状态（AWAITING_ROLL / READY_TO_CUT / DISPATCHED_MES）自动占用对应需求的 plannedQty，扣减待排量 openQty；
 * 3. 支持先在默认虚拟新母卷（VIRTUAL_ROLL）上确认方案并生成备料建议，后续再绑定在库实卷并一键完工过账或由 MES 回传核销。
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
        String cancelReason
) {
    public static final String STATE_AWAITING_ROLL = "AWAITING_ROLL";
    public static final String STATE_READY_TO_CUT = "READY_TO_CUT";
    public static final String STATE_DISPATCHED_MES = "DISPATCHED_MES";
    public static final String STATE_COMPLETED = "COMPLETED";
    public static final String STATE_CANCELLED = "CANCELLED";

    public SchedulingScheme {
        allocatedDemands = allocatedDemands == null ? Map.of() : Map.copyOf(allocatedDemands);
        linkedPlanIds = linkedPlanIds == null ? List.of() : List.copyOf(linkedPlanIds);
    }

    /** 是否处于占用待排需求（plannedQty）的未完结有效态。 */
    public boolean occupiesDemand() {
        return STATE_AWAITING_ROLL.equals(state)
                || STATE_READY_TO_CUT.equals(state)
                || STATE_DISPATCHED_MES.equals(state);
    }

    /** 是否正在占用特定实卷区段。 */
    public boolean occupiesRoll(String targetRollId) {
        return occupiesDemand()
                && "STOCK_ROLL".equals(materialMode)
                && targetRollId != null
                && targetRollId.equals(rollId)
                && occupiedLengthMm > 0;
    }

    public SchedulingScheme withBinding(String boundRollId, double startY, List<String> planIds, String execId, String nextState) {
        return new SchedulingScheme(
                id, idempotencyKey, title, dimension, scenarioId, strategyId, strategyName,
                taskId, taskName, externalOrderNo, "STOCK_ROLL", boundRollId, remnantId,
                materialModel, widthMm, canvasLengthMm, startY, occupiedLengthMm, trimStartMm, pieceGapMm,
                utilizationPct, pieceAreaM2, placedCount, requestedCount, gapFillCount, complete,
                allocatedDemands, planIds, execId, nextState, suggestedRoll, layout2D, slitting1D,
                mesWorkOrderNo, createdAt, dispatchedAt, completedAt, cancelledAt, cancelReason
        );
    }

    public SchedulingScheme withDispatched(String workOrderNo, String at) {
        return new SchedulingScheme(
                id, idempotencyKey, title, dimension, scenarioId, strategyId, strategyName,
                taskId, taskName, externalOrderNo, materialMode, rollId, remnantId,
                materialModel, widthMm, canvasLengthMm, windowStartY, occupiedLengthMm, trimStartMm, pieceGapMm,
                utilizationPct, pieceAreaM2, placedCount, requestedCount, gapFillCount, complete,
                allocatedDemands, linkedPlanIds, linkedExecutionId, STATE_DISPATCHED_MES, suggestedRoll,
                layout2D, slitting1D, workOrderNo, createdAt, at, completedAt, cancelledAt, cancelReason
        );
    }

    public SchedulingScheme withCompleted(String at) {
        return new SchedulingScheme(
                id, idempotencyKey, title, dimension, scenarioId, strategyId, strategyName,
                taskId, taskName, externalOrderNo, materialMode, rollId, remnantId,
                materialModel, widthMm, canvasLengthMm, windowStartY, occupiedLengthMm, trimStartMm, pieceGapMm,
                utilizationPct, pieceAreaM2, placedCount, requestedCount, gapFillCount, complete,
                allocatedDemands, linkedPlanIds, linkedExecutionId, STATE_COMPLETED, suggestedRoll,
                layout2D, slitting1D, mesWorkOrderNo, createdAt, dispatchedAt, at, cancelledAt, cancelReason
        );
    }

    public SchedulingScheme withCancelled(String at, String reason) {
        return new SchedulingScheme(
                id, idempotencyKey, title, dimension, scenarioId, strategyId, strategyName,
                taskId, taskName, externalOrderNo, materialMode, rollId, remnantId,
                materialModel, widthMm, canvasLengthMm, windowStartY, occupiedLengthMm, trimStartMm, pieceGapMm,
                utilizationPct, pieceAreaM2, placedCount, requestedCount, gapFillCount, complete,
                allocatedDemands, linkedPlanIds, linkedExecutionId, STATE_CANCELLED, suggestedRoll,
                layout2D, slitting1D, mesWorkOrderNo, createdAt, dispatchedAt, completedAt, at, reason
        );
    }

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
            NestingProblem.Shape shape
    ) {}

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
            List<StationItem> stations
    ) {
        public SlittingPatternItem {
            stations = stations == null ? List.of() : List.copyOf(stations);
        }
    }

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
