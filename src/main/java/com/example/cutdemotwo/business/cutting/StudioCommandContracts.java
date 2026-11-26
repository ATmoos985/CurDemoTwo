package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;

import java.util.List;

/**
 * 排程工作室命令输入协议接口：
 * 供 {@link SchedulingStudioService} 的公开嵌套 Record 实现，使底层协作者
 * {@link StudioDemandPoolService} 与 {@link StudioMaterializer} 面向抽象契约编程，
 * 彻底消除对上层门面 {@link SchedulingStudioService} 的反向循环依赖，同时保持既有构造器与 JSON 契约零破坏。
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
}
