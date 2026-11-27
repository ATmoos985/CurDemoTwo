package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.persistence.InventoryConflictException;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;

/**
 * MES 协同单事务接口协作者：
 * 负责 MES 工单幂等同步、派工包构建与下发、实切完工回传的原子绑卷与核销。
 */
final class StudioMesSyncSupport {
    private static final DateTimeFormatter TS_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private final CuttingStatePort statePort;
    private final StudioDemandPoolService demandPoolService;
    private final StudioSchemeViewSupport viewSupport;
    private final StudioSchemeLifecycleSupport lifecycleSupport;

    StudioMesSyncSupport(
            CuttingStatePort statePort,
            StudioDemandPoolService demandPoolService,
            StudioSchemeViewSupport viewSupport,
            StudioSchemeLifecycleSupport lifecycleSupport
    ) {
        this.statePort = statePort;
        this.demandPoolService = demandPoolService;
        this.viewSupport = viewSupport;
        this.lifecycleSupport = lifecycleSupport;
    }

    /**
     * MES 工单同步：收敛至单一写事务内原子查重 + 建单，彻底消除并发 TOCTOU 建重单风险。
     */
    Map<String, Object> syncMesOrder(StudioCommandContracts.MesOrderSyncInput cmd) {
        if (cmd == null || cmd.mesWorkOrderNo() == null || cmd.mesWorkOrderNo().isBlank()) {
            throw new IllegalArgumentException("MES 工单号 (mesWorkOrderNo) 不能为空");
        }
        if (cmd.demands() == null || cmd.demands().isEmpty()) {
            throw new IllegalArgumentException("请至少提供 1 项有效需求明细");
        }
        String wo = cmd.mesWorkOrderNo().trim();
        return statePort.inWrite(
                "DEMAND_ADJUSTMENT",
                wo,
                "MES_SYNC",
                tx -> tx.findTaskByExternalRef(wo).map(existing -> demandPoolService.buildDemandFamilyView(tx, existing)).orElse(null),
                tx -> {
                    CuttingTask saved = demandPoolService.saveOrMergeTask(tx, new StudioCommandContracts.SimpleSaveDemandFamilyInput(
                            null,
                            null,
                            cmd.name() == null || cmd.name().isBlank() ? ("MES工单 · " + wo) : cmd.name().trim(),
                            cmd.materialModel() == null || cmd.materialModel().isBlank() ? "MES-STD" : cmd.materialModel().trim(),
                            wo,
                            cmd.dimension(),
                            null, 0.0, 0.0, 10, 10, null,
                            cmd.widthMm() != null ? cmd.widthMm().intValue() : null,
                            10, 20,
                            cmd.demands()
                    ));
                    return demandPoolService.buildDemandFamilyView(tx, saved);
                }
        );
    }

    Map<String, Object> dispatchSchemeToMes(String schemeId, String mesWorkOrderNo) {
        return statePort.inWrite("SYSTEM_UPDATE", schemeId, "MES_DISPATCHER", tx -> {
            SchedulingScheme s = tx.findScheme(schemeId)
                    .orElseThrow(() -> new IllegalArgumentException("排程方案不存在: " + schemeId));
            if (SchedulingScheme.STATE_CANCELLED.equals(s.state()) || SchedulingScheme.STATE_REVERSED.equals(s.state())) {
                throw new InventoryConflictException("已作废或已冲销方案不能下发 MES");
            }
            String wo = (mesWorkOrderNo != null && !mesWorkOrderNo.isBlank())
                    ? mesWorkOrderNo.trim()
                    : (s.externalOrderNo() != null && !s.externalOrderNo().isBlank() ? s.externalOrderNo() : "WO-" + s.id());
            SchedulingScheme next = SchedulingScheme.STATE_COMPLETED.equals(s.state())
                    ? s
                    : s.withDispatched(wo, LocalDateTime.now().format(TS_FMT));
            tx.putScheme(next);
            return buildMesDispatchPackage(next);
        });
    }

    Map<String, Object> getMesDispatchPackage(String schemeId) {
        return statePort.inRead(tx -> {
            SchedulingScheme s = tx.findScheme(schemeId)
                    .orElseThrow(() -> new IllegalArgumentException("排程方案不存在: " + schemeId));
            return buildMesDispatchPackage(s);
        });
    }

    /**
     * MES 实切完工回传：在单一原子写事务内完成「mesReceiptNo 幂等防重校验 → 绑卷（若未绑定）→ 完工扣库与持久化 mesReceiptNo」。
     * 任一步校验失败均原子回滚，绝不留下半提交的绑卷脏态。
     */
    Map<String, Object> receiveMesFeedback(StudioCommandContracts.MesFeedbackInput cmd) {
        if (cmd == null || cmd.schemeId() == null || cmd.schemeId().isBlank()) {
            throw new IllegalArgumentException("请提供回传的排程方案号 schemeId");
        }
        String schemeId = cmd.schemeId().trim();
        String receiptNo = (cmd.mesReceiptNo() == null || cmd.mesReceiptNo().isBlank()) ? null : cmd.mesReceiptNo().trim();
        String actor = "MES:" + (receiptNo != null ? receiptNo : "CALLBACK");

        return statePort.inWrite(
                "CUT_REPORT",
                schemeId,
                actor,
                tx -> {
                    if (receiptNo != null) {
                        Optional<SchedulingScheme> byReceipt = tx.findSchemeByMesReceiptNo(receiptNo);
                        if (byReceipt.isPresent()) {
                            SchedulingScheme hit = byReceipt.get();
                            if (!hit.id().equals(schemeId)) {
                                throw new InventoryConflictException("MES 回执号 " + receiptNo + " 已用于其他排程方案: " + hit.id());
                            }
                            if (SchedulingScheme.STATE_COMPLETED.equals(hit.state())) {
                                return viewSupport.enrichWithDemandFamilies(tx, hit);
                            }
                        }
                    }
                    SchedulingScheme existing = tx.findScheme(schemeId).orElse(null);
                    if (existing != null && SchedulingScheme.STATE_COMPLETED.equals(existing.state())) {
                        if (receiptNo != null && existing.mesReceiptNo() != null && !receiptNo.equals(existing.mesReceiptNo())) {
                            throw new InventoryConflictException("排程方案 " + schemeId + " 已由 MES 回执号 " + existing.mesReceiptNo() + " 核销，不能重复提交不同回执号");
                        }
                        return viewSupport.enrichWithDemandFamilies(tx, existing);
                    }
                    return null;
                },
                tx -> {
                    SchedulingScheme current = tx.findScheme(schemeId)
                            .orElseThrow(() -> new IllegalArgumentException("排程方案不存在: " + schemeId));
                    if (SchedulingScheme.STATE_CANCELLED.equals(current.state()) || SchedulingScheme.STATE_REVERSED.equals(current.state())) {
                        throw new InventoryConflictException("排程方案状态为 " + current.state() + "，拒绝 MES 完工回传");
                    }
                    if (SchedulingScheme.STATE_AWAITING_ROLL.equals(current.state()) || current.linkedPlanIds().isEmpty()) {
                        if (cmd.scannedRollId() == null || cmd.scannedRollId().isBlank()) {
                            throw new IllegalArgumentException("虚拟母卷方案在 MES 完工回传时必须携带机台实扫母卷条码 scannedRollId");
                        }
                        lifecycleSupport.bindRollInTx(tx, current, new StudioCommandContracts.SimpleBindRollInput(
                                cmd.scannedRollId().trim(), false, null, null, null, null, null));
                        current = tx.findScheme(schemeId).orElseThrow();
                    }
                    return lifecycleSupport.completeSchemeInTx(tx, current, new StudioCommandContracts.SimpleCompleteSchemeInput(
                            cmd.actualCutLenMm(),
                            cmd.rejectedPieceIds(),
                            cmd.recoverRemnants(),
                            cmd.remnantLocation(),
                            actor
                    ), receiptNo);
                }
        );
    }

    private Map<String, Object> buildMesDispatchPackage(SchedulingScheme s) {
        Map<String, Object> pkg = new LinkedHashMap<>();
        pkg.put("packageVersion", "2.0");
        pkg.put("schemeId", s.id());
        pkg.put("mesWorkOrderNo", s.mesWorkOrderNo() != null ? s.mesWorkOrderNo() : s.externalOrderNo());
        pkg.put("state", s.state());
        pkg.put("dimension", s.dimension());
        pkg.put("strategyName", s.strategyName());
        pkg.put("taskId", s.taskId());
        pkg.put("taskName", s.taskName());
        if (s.sourceAllocations() != null && !s.sourceAllocations().isEmpty()) {
            pkg.put("sourceAllocations", s.sourceAllocations());
        }
        pkg.put("materialBinding", Map.of(
                "mode", s.materialMode(),
                "materialModel", s.materialModel(),
                "rollId", Objects.toString(s.rollId(), ""),
                "remnantId", Objects.toString(s.remnantId(), ""),
                "widthMm", s.widthMm(),
                "windowStartY", s.windowStartY(),
                "occupiedLengthMm", s.occupiedLengthMm(),
                "suggestedRoll", s.suggestedRoll() != null ? s.suggestedRoll() : Map.of()
        ));
        pkg.put("metrics", Map.of(
                "utilizationPct", s.utilizationPct(),
                "pieceAreaM2", s.pieceAreaM2(),
                "placedCount", s.placedCount(),
                "requestedCount", s.requestedCount()
        ));
        pkg.put("allocatedDemands", s.allocatedDemands());
        pkg.put("layout2D", s.layout2D());
        pkg.put("slitting1D", s.slitting1D());
        pkg.put("linkedPlanIds", s.linkedPlanIds());
        return pkg;
    }
}
