package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;

import java.util.List;

/**
 * 排程工作室命令输入协议接口：
 * 供上层排程门面的公开嵌套 Record 实现，使底层协作者面向抽象契约编程，
 * 彻底消除对上层门面的反向循环依赖，同时保持既有构造器与 JSON 契约零破坏。
 */
public final class StudioCommandContracts {
    private StudioCommandContracts() {}

    /** 单条需求明细输入只读视图。 */
    public interface DemandLineView {
        Integer id();
        String name();
        double width();
        double length();
        int quantity();
        Boolean allowRotation();
        Boolean allowHalfTurn();
        String sizeLabel();
        String sourceTemplateId();
        String surfaceTreatment();
        NestingProblem.Shape shape();
        String sourceTaskId();
        Integer sourceLineId();
    }

    /** 保存或合并多维需求族命令只读视图。 */
    public interface SaveDemandFamilyInput {
        String id();
        String mergeIntoTaskId();
        String name();
        String materialModel();
        String externalRef();
        String dimension();
        Double bedLengthMm();
        Double trimStartMm();
        Double pieceGapMm();
        Integer leftTrimMm();
        Integer rightTrimMm();
        Integer minWidthMm();
        Integer maxWidthMm();
        Integer widthStepMm();
        Integer totalOverCap();
        List<? extends DemandLineView> demands();
        String dueDate();
        String priority();
        String customerName();
        String kittingGroup();
        String requiredBatchNo();
        String requiredColor();
        Boolean strictBatchMatch();
        String machineId();
        String shiftTeam();
    }

    /** 无副作用手调几何校验与刀路重建请求只读视图。 */
    public interface ValidateLayoutInput {
        double materialWidthMm();
        double materialLengthMm();
        double trimStartMm();
        double pieceGapMm();
        Boolean avoidDefects();
        String rollId();
        String remnantId();
        Double windowStartY();
        List<Defect> defects();
        List<SchedulingScheme.PlacementItem> placements();
        List<? extends DemandLineView> demands();
    }

    /** 确认排程方案命令只读视图。 */
    public interface ConfirmSchemeInput {
        String idempotencyKey();
        String title();
        String dimension();
        String scenarioId();
        String strategyId();
        String strategyName();
        String taskId();
        String taskName();
        String externalOrderNo();
        String materialMode();
        String rollId();
        String remnantId();
        String materialModel();
        double widthMm();
        double canvasLengthMm();
        Double windowStartY();
        double occupiedLengthMm();
        double trimStartMm();
        double pieceGapMm();
        double utilizationPct();
        double pieceAreaM2();
        Boolean avoidDefects();
        List<? extends DemandLineView> demands();
        SchedulingScheme.Layout2DPayload layout2D();
        SchedulingScheme.Slitting1DPayload slitting1D();
        List<SchedulingScheme.TaskDemandAllocation> sourceAllocations();
        String draftId();
    }

    /** 虚拟母卷方案绑定实卷命令只读视图。 */
    public interface BindRollInput {
        String rollId();
        Boolean autoCreateRoll();
        Double newRollLengthMm();
        String storageLocation();
        Double windowStartY();
        String inspectionStatus();
        String inspector();
    }

    /** 排程方案一键完工记账命令只读视图。 */
    public interface CompleteSchemeInput {
        Double actualCutLenMm();
        List<Integer> rejectedPieceIds();
        Boolean recoverRemnants();
        String remnantLocation();
        String operator();
    }

    /** 基于源方案创建同缸补片任务命令只读视图。 */
    public interface ReplenishTaskInput {
        String idempotencyKey();
        String operator();
        String reason();
    }

    /** MES 工单同步命令只读视图。 */
    public interface MesOrderSyncInput {
        String mesWorkOrderNo();
        String name();
        String materialModel();
        String dimension();
        Double widthMm();
        List<? extends DemandLineView> demands();
    }

    /** MES 实切完工回传命令只读视图。 */
    public interface MesFeedbackInput {
        String schemeId();
        String mesReceiptNo();
        String scannedRollId();
        Double actualCutLenMm();
        List<Integer> rejectedPieceIds();
        Boolean recoverRemnants();
        String remnantLocation();
    }

    record SimpleSaveDemandFamilyInput(
            String id,
            String mergeIntoTaskId,
            String name,
            String materialModel,
            String externalRef,
            String dimension,
            Double bedLengthMm,
            Double trimStartMm,
            Double pieceGapMm,
            Integer leftTrimMm,
            Integer rightTrimMm,
            Integer minWidthMm,
            Integer maxWidthMm,
            Integer widthStepMm,
            Integer totalOverCap,
            List<? extends DemandLineView> demands,
            String dueDate,
            String priority,
            String customerName,
            String kittingGroup,
            String requiredBatchNo,
            String requiredColor,
            Boolean strictBatchMatch,
            String machineId,
            String shiftTeam
    ) implements SaveDemandFamilyInput {
        SimpleSaveDemandFamilyInput(
                String id, String mergeIntoTaskId, String name, String materialModel, String externalRef,
                String dimension, Double bedLengthMm, Double trimStartMm, Double pieceGapMm,
                Integer leftTrimMm, Integer rightTrimMm, Integer minWidthMm, Integer maxWidthMm,
                Integer widthStepMm, Integer totalOverCap, List<? extends DemandLineView> demands
        ) {
            this(id, mergeIntoTaskId, name, materialModel, externalRef, dimension, bedLengthMm, trimStartMm,
                    pieceGapMm, leftTrimMm, rightTrimMm, minWidthMm, maxWidthMm, widthStepMm, totalOverCap, demands,
                    null, null, null, null, null, null, null, null, null);
        }
    }

    record SimpleBindRollInput(
            String rollId,
            Boolean autoCreateRoll,
            Double newRollLengthMm,
            String storageLocation,
            Double windowStartY,
            String inspectionStatus,
            String inspector
    ) implements BindRollInput {}

    record SimpleCompleteSchemeInput(
            Double actualCutLenMm,
            List<Integer> rejectedPieceIds,
            Boolean recoverRemnants,
            String remnantLocation,
            String operator
    ) implements CompleteSchemeInput {}
}
