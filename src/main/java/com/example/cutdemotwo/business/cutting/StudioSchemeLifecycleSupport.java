package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.CutReport;
import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.QualityDisposition;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.contracts.geometry.RemnantPiece;
import com.example.cutdemotwo.persistence.InventoryConflictException;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;

/**
 * 排程方案生命周期管理协作者：
 * 负责虚拟方案绑卷物化、一键完工记账、同缸补片创建及方案作废释放需求。
 */
final class StudioSchemeLifecycleSupport {
    private static final DateTimeFormatter TS_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private final CuttingStatePort statePort;
    private final StudioDemandPoolService demandPoolService;
    private final StudioMaterializer materializer;
    private final StudioSchemeViewSupport viewSupport;

    StudioSchemeLifecycleSupport(
            CuttingStatePort statePort,
            StudioDemandPoolService demandPoolService,
            StudioMaterializer materializer,
            StudioSchemeViewSupport viewSupport
    ) {
        this.statePort = statePort;
        this.demandPoolService = demandPoolService;
        this.materializer = materializer;
        this.viewSupport = viewSupport;
    }

    /**
     * 将虚拟新母卷方案（AWAITING_ROLL）绑定到真实在库母卷（或按建议规格入库待检新母卷）：
     * - 自动建卷默认 inspectionStatus="PENDING"、inspector=""（严禁硬编码直通 PASSED）；
     * - 新建母卷处于 PENDING 时仅落库母卷、方案保持 AWAITING_ROLL 等待质检放行后再锁卷；
     * - 仅对已验布合格（PASSED）母卷执行物理物化与锁卷，进入 READY_TO_CUT。
     */
    Map<String, Object> bindRollToScheme(String schemeId, StudioCommandContracts.BindRollInput cmd) {
        if (schemeId == null || schemeId.isBlank()) throw new IllegalArgumentException("请指定排程方案编号");
        return statePort.inWrite("ROLL_RECEIPT_OR_UPDATE", schemeId, "UNAUTHENTICATED_LOCAL", tx -> {
            SchedulingScheme scheme = tx.findScheme(schemeId)
                    .orElseThrow(() -> new IllegalArgumentException("排程方案不存在: " + schemeId));
            return bindRollInTx(tx, scheme, cmd);
        });
    }

    Map<String, Object> bindRollInTx(CuttingStatePort.WriteTx tx, SchedulingScheme scheme, StudioCommandContracts.BindRollInput cmd) {
        if (SchedulingScheme.STATE_READY_TO_CUT.equals(scheme.state()) && Objects.equals(scheme.rollId(), cmd != null ? cmd.rollId() : null)) {
            return viewSupport.enrichSchemeView(tx, scheme);
        }
        if (!SchedulingScheme.STATE_AWAITING_ROLL.equals(scheme.state())
                && !(SchedulingScheme.STATE_DISPATCHED_MES.equals(scheme.state()) && scheme.linkedPlanIds().isEmpty())) {
            throw new InventoryConflictException("仅未绑定实卷的虚拟母卷方案可执行绑卷，当前状态：" + scheme.state());
        }

        Map<String, CuttingTask> sourceTasks = viewSupport.loadSourceTasksForScheme(tx, scheme);
        boolean multiTask = scheme.isMultiTaskMerged();
        CuttingTask primaryTask = sourceTasks.get(scheme.taskId());
        if (primaryTask == null) {
            throw new IllegalArgumentException("方案关联的需求族不存在");
        }

        MotherRollInfo roll;
        boolean newlyCreated = false;
        if (cmd != null && Boolean.TRUE.equals(cmd.autoCreateRoll())) {
            String newRollId = (cmd.rollId() == null || cmd.rollId().isBlank())
                    ? "ROLL-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("MMddHHmm")) + "-" + UUID.randomUUID().toString().substring(0, 3).toUpperCase()
                    : cmd.rollId().trim();
            double minReqLen = Math.max(5000, Math.ceil(scheme.occupiedLengthMm() + scheme.trimStartMm()));
            double totalLen = (cmd.newRollLengthMm() != null && cmd.newRollLengthMm() >= minReqLen)
                    ? cmd.newRollLengthMm()
                    : Math.max(minReqLen, Math.ceil(minReqLen / 1000.0) * 1000.0 + 10000);
            String defaultBatch = (primaryTask.requiredBatchNo() != null && !primaryTask.requiredBatchNo().isBlank())
                    ? primaryTask.requiredBatchNo()
                    : "BAT-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd"));
            String defaultColor = (primaryTask.requiredColor() != null && !primaryTask.requiredColor().isBlank())
                    ? primaryTask.requiredColor()
                    : "标准色";
            MotherRollInfo fresh = new MotherRollInfo(
                    newRollId,
                    scheme.materialModel(),
                    defaultBatch,
                    "按方案备料入库",
                    scheme.materialModel(),
                    defaultColor,
                    220.0,
                    "标准材质",
                    scheme.widthMm(),
                    totalLen,
                    (cmd.storageLocation() == null || cmd.storageLocation().isBlank()) ? "裁床线边备料区 L-01" : cmd.storageLocation().trim()
            );
            // 默认待检（PENDING），禁止硬编码直通 PASSED；仅允许显式传入已核验的 PASSED 与真实检验员
            if ("PASSED".equalsIgnoreCase(cmd.inspectionStatus()) && cmd.inspector() != null && !cmd.inspector().isBlank()) {
                fresh.setInspectionStatus("PASSED");
                fresh.setInspector(cmd.inspector().trim());
                fresh.setInspectionDate(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd")));
            } else {
                fresh.setInspectionStatus("PENDING");
                fresh.setInspector("");
                fresh.setInspectionDate(null);
            }
            roll = tx.saveRoll(fresh);
            newlyCreated = true;
        } else {
            if (cmd == null || cmd.rollId() == null || cmd.rollId().isBlank()) {
                throw new IllegalArgumentException("请选择要绑定的在库母卷编号，或勾选按建议规格自动建卷");
            }
            roll = tx.findRoll(cmd.rollId().trim())
                    .orElseThrow(() -> new IllegalArgumentException("在库母卷不存在: " + cmd.rollId()));
            if (!"PASSED".equals(roll.getInspectionStatus())) {
                throw new IllegalArgumentException("母卷 " + roll.getRollId() + " 尚未验布合格，不能直接锁卷切割");
            }
            if (Math.abs(roll.getWidth() - scheme.widthMm()) > 1.0) {
                throw new IllegalArgumentException("所选母卷幅宽 (" + roll.getWidth() + "mm) 与方案设定门幅 (" + scheme.widthMm() + "mm) 不一致");
            }
            for (CuttingTask t : sourceTasks.values()) {
                tx.validateBatchAndColorForTask(t, roll, null);
            }
            if (!multiTask && !Objects.equals(primaryTask.materialModel(), roll.getRollModel())
                    && tx.completedQuantities(primaryTask.id()).isEmpty()) {
                CuttingTask aligned = primaryTask.withMaterialModel(roll.getRollModel());
                primaryTask = tx.saveTaskForScheme(aligned, scheme.id());
                sourceTasks.put(primaryTask.id(), primaryTask);
            }
        }

        // 若自动建卷为待检状态（PENDING），落库母卷但绝不跳过质检直接进入 READY_TO_CUT
        if (newlyCreated && !"PASSED".equals(roll.getInspectionStatus())) {
            Map<String, Object> pendingOut = new LinkedHashMap<>(viewSupport.enrichSchemeView(tx, scheme));
            pendingOut.put("createdRoll", roll);
            pendingOut.put("rollInfo", viewSupport.rollSummaryMap(roll));
            pendingOut.put("awaitingInspection", true);
            pendingOut.put("message", "已按建议规格创建待检母卷 " + roll.getRollId() + "（当前状态 PENDING），请完成跑布验疵并质检放行后再执行锁卷绑定");
            return pendingOut;
        }

        if (tx.isMaterialReservedByExecution("roll", roll.getRollId(), null)) {
            throw new InventoryConflictException("母卷 " + roll.getRollId() + " 已被执行单预约或正在加工，不能重复锁卷");
        }

        boolean isSlit = "SLITTING_1D".equals(scheme.dimension());
        if (!isSlit && !multiTask && scheme.gapFillCount() > 0 && tx.completedQuantities(primaryTask.id()).isEmpty()) {
            primaryTask = materializer.appendGapFillLinesIfNeeded(tx, primaryTask, scheme.layout2D(), scheme.id());
            sourceTasks.put(primaryTask.id(), primaryTask);
        }

        StudioMaterializer.MaterializationResult mat = isSlit
                ? materializer.materialize1DPlansOnRoll(tx, primaryTask, sourceTasks, multiTask, roll, scheme.slitting1D(), scheme.effectiveAllocations(), true, cmd != null ? cmd.windowStartY() : null, scheme.id())
                : materializer.materialize2DPlanOnMaterial(tx, primaryTask, sourceTasks, scheme.effectiveAllocations(), multiTask, roll, null, scheme.layout2D(), roll.getWidth(), scheme.occupiedLengthMm(), scheme.trimStartMm(), scheme.pieceGapMm(), cmd != null ? cmd.windowStartY() : null, scheme.id());

        SchedulingScheme updated = new SchedulingScheme(
                scheme.id(), scheme.idempotencyKey(), scheme.title(), scheme.dimension(),
                scheme.scenarioId(), scheme.strategyId(), scheme.strategyName(),
                primaryTask.id(), scheme.taskName(), scheme.externalOrderNo(),
                "STOCK_ROLL", roll.getRollId(), null, multiTask ? roll.getRollModel() : primaryTask.materialModel(),
                roll.getWidth(), scheme.canvasLengthMm(), mat.startY(), mat.occupiedLengthMm(),
                scheme.trimStartMm(), scheme.pieceGapMm(), scheme.utilizationPct(), scheme.pieceAreaM2(),
                scheme.placedCount(), scheme.requestedCount(), scheme.gapFillCount(), scheme.complete(),
                scheme.allocatedDemands(), mat.planIds(), null,
                SchedulingScheme.STATE_DISPATCHED_MES.equals(scheme.state())
                        ? SchedulingScheme.STATE_DISPATCHED_MES
                        : SchedulingScheme.STATE_READY_TO_CUT,
                scheme.suggestedRoll(),
                scheme.layout2D(), scheme.slitting1D(), scheme.mesWorkOrderNo(),
                scheme.createdAt(), scheme.dispatchedAt(), scheme.completedAt(), scheme.cancelledAt(), scheme.cancelReason(),
                scheme.sourceAllocations(), scheme.mesReceiptNo()
        );
        tx.putScheme(updated);
        return viewSupport.enrichSchemeView(tx, updated);
    }

    /**
     * 一键完工记账（或 MES 实切完工核销）：
     * 原子执行底层 CuttingPlan 报工，扣减实卷长度、登记派生余料入库、将 plannedQty 结转为 completedQty，
     * 并真实透传操作人（DECLARED:<op> / MES:<op>）至审计流水。
     */
    Map<String, Object> completeScheme(String schemeId, StudioCommandContracts.CompleteSchemeInput cmd) {
        if (schemeId == null || schemeId.isBlank()) throw new IllegalArgumentException("请指定排程方案编号");
        String actor = StudioSchemeViewSupport.resolveActor(cmd != null ? cmd.operator() : null, "UNAUTHENTICATED_LOCAL");
        return statePort.inWrite(
                "CUT_REPORT",
                schemeId,
                actor,
                tx -> tx.findScheme(schemeId)
                        .filter(s -> SchedulingScheme.STATE_COMPLETED.equals(s.state()))
                        .map(s -> viewSupport.enrichWithDemandFamilies(tx, s))
                        .orElse(null),
                tx -> {
                    SchedulingScheme scheme = tx.findScheme(schemeId)
                            .orElseThrow(() -> new IllegalArgumentException("排程方案不存在: " + schemeId));
                    return completeSchemeInTx(tx, scheme, cmd, null);
                }
        );
    }

    Map<String, Object> completeSchemeInTx(
            CuttingStatePort.WriteTx tx,
            SchedulingScheme scheme,
            StudioCommandContracts.CompleteSchemeInput cmd,
            String mesReceiptNo
    ) {
        if (SchedulingScheme.STATE_COMPLETED.equals(scheme.state())) {
            return viewSupport.enrichWithDemandFamilies(tx, scheme);
        }
        if (SchedulingScheme.STATE_AWAITING_ROLL.equals(scheme.state())) {
            throw new IllegalArgumentException("该方案使用的是虚拟新母卷，请先绑定在库实卷（或建卷质检放行后绑定）再执行完工过账");
        }
        if (SchedulingScheme.STATE_CANCELLED.equals(scheme.state())) {
            throw new InventoryConflictException("已作废方案不能执行完工过账");
        }
        if (SchedulingScheme.STATE_REVERSED.equals(scheme.state())) {
            throw new InventoryConflictException("已冲销方案不能再次执行完工过账，请重新排程确认");
        }
        if (scheme.linkedPlanIds().isEmpty()) {
            throw new IllegalArgumentException("方案缺少已锁定的机台切割计划明细");
        }
        if ("STOCK_ROLL".equals(scheme.materialMode()) && scheme.rollId() != null) {
            MotherRollInfo roll = tx.findRoll(scheme.rollId())
                    .orElseThrow(() -> new IllegalArgumentException("方案绑定母卷不存在: " + scheme.rollId()));
            if (!"PASSED".equals(roll.getInspectionStatus())) {
                throw new InventoryConflictException("母卷 " + roll.getRollId() + " 未通过质检验布，禁止完工过账");
            }
        }

        Set<Integer> rejectedIds = (cmd != null && cmd.rejectedPieceIds() != null)
                ? new HashSet<>(cmd.rejectedPieceIds())
                : Set.of();
        boolean recoverRems = cmd == null || cmd.recoverRemnants() == null || cmd.recoverRemnants();
        String remLoc = (cmd != null && cmd.remnantLocation() != null && !cmd.remnantLocation().isBlank())
                ? cmd.remnantLocation().trim()
                : "裁床余料架 A-01";
        boolean multiTask = scheme.isMultiTaskMerged();
        List<SchedulingScheme.TaskDemandAllocation> sourceAllocs = scheme.sourceAllocations();

        Set<String> batchReported = new HashSet<>();
        List<Map<String, Object>> receiptsOut = new ArrayList<>();

        for (String planId : scheme.linkedPlanIds()) {
            CuttingPlan plan = tx.findPlan(planId)
                    .orElseThrow(() -> new IllegalArgumentException("底层切割计划缺失: " + planId));
            Optional<Map<String, Object>> existingReceipt = tx.findReceipt(planId);
            if ("CONFIRMED".equals(plan.status()) && existingReceipt.isPresent()) {
                receiptsOut.add(tx.projectQuality(existingReceipt.get()));
                batchReported.add(planId);
                continue;
            }

            boolean remnantFeed = "remnant".equalsIgnoreCase(plan.request().getFeedPortType());
            double defaultCutLen = remnantFeed ? 0 : (plan.result().getDeductLen() > 0 ? plan.result().getDeductLen() : plan.request().getRollL());
            double actualCutLen = (!remnantFeed && cmd != null && cmd.actualCutLenMm() != null && scheme.linkedPlanIds().size() == 1)
                    ? cmd.actualCutLenMm()
                    : defaultCutLen;

            List<CutReport.PieceResult> pieceResults = new ArrayList<>();
            int qualifiedCount = 0;
            Map<String, Map<String, Integer>> taskDemandQuantities = multiTask ? new LinkedHashMap<>() : null;
            Map<Integer, SchedulingScheme.TaskDemandAllocation> pieceSources = multiTask ? new LinkedHashMap<>() : null;

            for (PlacedPiece pc : plan.result().getPieces()) {
                boolean isRejected = rejectedIds.contains(pc.getId());
                pieceResults.add(new CutReport.PieceResult(
                        pc.getId(),
                        isRejected ? "REJECTED" : "QUALIFIED",
                        isRejected ? "实切异常判废" : ""
                ));
                if (!isRejected) qualifiedCount++;

                if (multiTask) {
                    int idx = pc.getDemandId() != null ? pc.getDemandId() - 1 : -1;
                    if (idx < 0 || idx >= sourceAllocs.size()) {
                        throw new IllegalStateException("跨任务合排裁片 #" + pc.getId() + " 缺少有效的源任务归属索引");
                    }
                    SchedulingScheme.TaskDemandAllocation src = sourceAllocs.get(idx);
                    pieceSources.put(pc.getId(), new SchedulingScheme.TaskDemandAllocation(src.taskId(), src.lineId(), 1));
                    if (!isRejected) {
                        taskDemandQuantities
                                .computeIfAbsent(src.taskId(), k -> new LinkedHashMap<>())
                                .merge(String.valueOf(src.lineId()), 1, Integer::sum);
                    }
                }
            }

            List<RemnantPiece> actualRemnants = new ArrayList<>();
            if (!remnantFeed && recoverRems && plan.result().getRemnants() != null) {
                double minW = Math.max(150, plan.request().getMinRemnantWidth());
                double minL = Math.max(150, plan.request().getMinRemnantLength());
                for (RemnantPiece rp : plan.result().getRemnants()) {
                    if (rp.getW() >= minW && rp.getL() >= minL && rp.getY() + rp.getL() <= actualCutLen + 0.001) {
                        actualRemnants.add(new RemnantPiece(
                                rp.getId(), rp.getStatus(), rp.getX(), rp.getY(),
                                rp.getW(), rp.getL(), (rp.getW() * rp.getL()) / 1_000_000.0, rp.isHasDefect()
                        ));
                    }
                }
            }

            CutReport report = new CutReport(planId, actualCutLen, qualifiedCount, actualRemnants, remLoc, pieceResults);
            Map<String, Object> confirmed = multiTask
                    ? tx.confirmPlan(report, batchReported, taskDemandQuantities, pieceSources)
                    : tx.confirmPlan(report, batchReported);
            receiptsOut.add(confirmed);
            batchReported.add(planId);
        }

        SchedulingScheme completedScheme = scheme.withCompleted(LocalDateTime.now().format(TS_FMT), mesReceiptNo);
        tx.putScheme(completedScheme);

        Map<String, Object> out = new LinkedHashMap<>(viewSupport.enrichWithDemandFamilies(tx, completedScheme));
        out.put("receipts", receiptsOut);
        return out;
    }

    /**
     * 基于源方案报工/复检判废或未满足缺口，一键创建高优先级（URGENT）、强制同缸匹配（strictBatchMatch=true）的同缸补片任务。
     */
    Map<String, Object> createReplenishTaskFromScheme(String schemeId, StudioCommandContracts.ReplenishTaskInput cmd) {
        if (schemeId == null || schemeId.isBlank()) throw new IllegalArgumentException("请指定源排程方案编号");
        if (cmd == null || cmd.idempotencyKey() == null || cmd.idempotencyKey().isBlank() || cmd.idempotencyKey().trim().length() > 128) {
            throw new IllegalArgumentException("请提供 1–128 字符的有效幂等键 idempotencyKey");
        }
        String cleanSchemeId = schemeId.trim();
        String key = cmd.idempotencyKey().trim();
        String reason = cmd.reason() == null ? "" : cmd.reason().trim();
        if (reason.length() > 500) throw new IllegalArgumentException("补片原因不能超过 500 字");
        String actor = StudioSchemeViewSupport.resolveActor(cmd.operator(), "UNAUTHENTICATED_LOCAL");

        return statePort.inWrite(
                "REPLENISH_TASK",
                cleanSchemeId,
                actor,
                tx -> {
                    Optional<CuttingTask> existing = tx.findTaskByReplenishIdempotencyKey(key);
                    if (existing.isPresent()) {
                        CuttingTask hit = existing.get();
                        if (!cleanSchemeId.equals(hit.sourceSchemeId())) {
                            throw new InventoryConflictException("同一幂等键已用于其他排程方案的补片任务: " + hit.sourceSchemeId());
                        }
                        Map<String, Object> replayOut = new LinkedHashMap<>();
                        replayOut.put("task", hit);
                        replayOut.put("sourceSchemeId", cleanSchemeId);
                        replayOut.put("revision", tx.currentRevision());
                        return replayOut;
                    }
                    return null;
                },
                tx -> {
                    SchedulingScheme source = tx.findScheme(cleanSchemeId)
                            .orElseThrow(() -> new IllegalArgumentException("排程方案不存在: " + cleanSchemeId));
                    if (SchedulingScheme.STATE_CANCELLED.equals(source.state()) || SchedulingScheme.STATE_REVERSED.equals(source.state())) {
                        throw new InventoryConflictException("已作废或已冲销方案不能发起同缸补片");
                    }

                    Map<String, CuttingTask> sourceTasks = viewSupport.loadSourceTasksForScheme(tx, source);
                    CuttingTask primaryTask = sourceTasks.get(source.taskId());
                    if (primaryTask == null && !sourceTasks.isEmpty()) {
                        primaryTask = sourceTasks.values().iterator().next();
                    }

                    // 1. 优先精确汇总源方案关联有效报工中的判废、未切与复检淘汰缺口
                    Map<String, Integer> shortageQty = new LinkedHashMap<>();
                    Map<String, CuttingTask.Line> shortageLineDef = new LinkedHashMap<>();

                    for (String pid : source.linkedPlanIds()) {
                        Map<String, Object> rawReceipt = tx.findReceipt(pid).orElse(null);
                        if (rawReceipt == null || "REVERSED".equals(rawReceipt.get("status"))) continue;
                        Map<String, Object> projected = tx.projectQuality(rawReceipt);
                        Map<?, ?> pieceSources = rawReceipt.get("pieceSources") instanceof Map<?, ?> ps ? ps : null;
                        String receiptTaskId = rawReceipt.get("taskId") != null ? rawReceipt.get("taskId").toString() : source.taskId();

                        Set<Integer> activeDisposedGoodPieceIds = new HashSet<>();
                        if (projected.get("qualityDispositions") instanceof List<?> qList) {
                            for (Object qObj : qList) {
                                if (qObj instanceof QualityDisposition qd
                                        && !qd.hasRevocation()
                                        && "QUALIFIED".equals(qd.originalOutcome())) {
                                    activeDisposedGoodPieceIds.add(qd.command().pieceId());
                                }
                            }
                        }

                        if (rawReceipt.get("pieceResults") instanceof List<?> pieces) {
                            for (Object pObj : pieces) {
                                int pieceId;
                                Integer demandId;
                                String outcome;
                                if (pObj instanceof ReportOutput.ReportedPiece rp) {
                                    pieceId = rp.pieceId();
                                    demandId = rp.demandId();
                                    outcome = rp.outcome();
                                } else if (pObj instanceof Map<?, ?> pm) {
                                    pieceId = pm.get("pieceId") instanceof Number n ? n.intValue() : -1;
                                    demandId = pm.get("demandId") instanceof Number n ? n.intValue() : null;
                                    outcome = Objects.toString(pm.get("outcome"), "");
                                } else {
                                    continue;
                                }
                                boolean needsReplenish = "REJECTED".equals(outcome)
                                        || "UNCUT".equals(outcome)
                                        || ("QUALIFIED".equals(outcome) && activeDisposedGoodPieceIds.contains(pieceId));
                                if (!needsReplenish) continue;

                                String targetTaskId = receiptTaskId;
                                Integer targetLineId = demandId;
                                if (pieceSources != null) {
                                    Object srcObj = pieceSources.get(String.valueOf(pieceId));
                                    if (srcObj == null) srcObj = pieceSources.get(pieceId);
                                    if (srcObj instanceof Map<?, ?> sm && sm.get("taskId") != null && sm.get("lineId") instanceof Number ln) {
                                        targetTaskId = sm.get("taskId").toString();
                                        targetLineId = ln.intValue();
                                    }
                                }
                                if (targetTaskId == null || targetLineId == null) continue;
                                CuttingTask srcTask = sourceTasks.computeIfAbsent(targetTaskId, id -> tx.findTask(id).orElse(null));
                                if (srcTask == null) continue;
                                int finalLineId = targetLineId;
                                CuttingTask.Line srcLine = srcTask.demands().stream().filter(l -> l.id() == finalLineId).findFirst().orElse(null);
                                if (srcLine == null) continue;
                                String lineKey = targetTaskId + ":" + finalLineId;
                                shortageQty.merge(lineKey, 1, Integer::sum);
                                shortageLineDef.putIfAbsent(lineKey, srcLine);
                            }
                        }
                    }

                    // 2. 若报工/复检无判废缺口，则检查源方案关联任务的未满足缺口（openQty > 0）
                    if (shortageQty.isEmpty()) {
                        for (CuttingTask t : sourceTasks.values()) {
                            if (t == null) continue;
                            Map<String, Integer> completedMap = tx.completedQuantities(t.id());
                            Map<String, Integer> plannedMap = demandPoolService.plannedQuantitiesForTask(tx, t.id(), null);
                            for (CuttingTask.Line line : t.demands()) {
                                String k = String.valueOf(line.id());
                                int open = Math.max(0, line.quantity() - completedMap.getOrDefault(k, 0) - plannedMap.getOrDefault(k, 0));
                                if (open > 0) {
                                    String lineKey = t.id() + ":" + line.id();
                                    shortageQty.merge(lineKey, open, Integer::sum);
                                    shortageLineDef.putIfAbsent(lineKey, line);
                                }
                            }
                        }
                    }

                    if (shortageQty.isEmpty()) {
                        throw new IllegalArgumentException("源方案暂无判废或未满足缺口，无需创建补片任务");
                    }

                    MotherRollInfo roll = source.rollId() != null ? tx.findRoll(source.rollId()).orElse(null) : null;
                    RemnantStock rem = source.remnantId() != null ? tx.findRemnant(source.remnantId()).orElse(null) : null;
                    String inheritedBatch = (rem != null && rem.getBatchNo() != null && !rem.getBatchNo().isBlank())
                            ? rem.getBatchNo().trim()
                            : (roll != null && roll.getBatchNo() != null && !roll.getBatchNo().isBlank())
                            ? roll.getBatchNo().trim()
                            : (primaryTask != null ? primaryTask.requiredBatchNo() : null);
                    String inheritedColor = (rem != null && rem.getColor() != null && !rem.getColor().isBlank())
                            ? rem.getColor().trim()
                            : (roll != null && roll.getColor() != null && !roll.getColor().isBlank())
                            ? roll.getColor().trim()
                            : (primaryTask != null ? primaryTask.requiredColor() : null);
                    String inheritedModel = (roll != null && roll.getRollModel() != null && !roll.getRollModel().isBlank())
                            ? roll.getRollModel().trim()
                            : source.materialModel();

                    List<CuttingTask.Line> replenishLines = new ArrayList<>();
                    int nextId = 1;
                    for (Map.Entry<String, Integer> e : shortageQty.entrySet()) {
                        CuttingTask.Line orig = shortageLineDef.get(e.getKey());
                        replenishLines.add(new CuttingTask.Line(
                                nextId++,
                                orig.name(),
                                orig.width(),
                                orig.length(),
                                e.getValue(),
                                orig.allowRotation(),
                                orig.shape(),
                                orig.allowHalfTurn(),
                                orig.sizeLabel(),
                                orig.sourceTemplateId(),
                                orig.surfaceTreatment()
                        ));
                    }

                    String titleSuffix = reason.isEmpty() ? "" : ("（" + (reason.length() > 30 ? reason.substring(0, 30) : reason) + "）");
                    String taskName = "同缸补片 · " + source.title() + titleSuffix;
                    String kittingGroup = (primaryTask != null && primaryTask.kittingGroup() != null && !primaryTask.kittingGroup().isBlank())
                            ? primaryTask.kittingGroup()
                            : ("补片-" + source.id());

                    CuttingTask payload = new CuttingTask(
                            null,
                            taskName,
                            inheritedModel,
                            "REPLENISH-" + source.id(),
                            0,
                            replenishLines,
                            primaryTask != null ? primaryTask.process() : null,
                            primaryTask != null ? primaryTask.problemType() : null,
                            primaryTask != null ? primaryTask.slitting() : null,
                            primaryTask != null ? primaryTask.dueDate() : null,
                            CuttingTask.PRIORITY_URGENT,
                            primaryTask != null ? primaryTask.customerName() : null,
                            kittingGroup,
                            inheritedBatch,
                            inheritedColor,
                            Boolean.TRUE,
                            primaryTask != null ? primaryTask.machineId() : null,
                            primaryTask != null ? primaryTask.shiftTeam() : null,
                            source.id(),
                            key
                    );

                    CuttingTask created = tx.saveTask(payload);
                    Map<String, Object> out = new LinkedHashMap<>();
                    out.put("task", created);
                    out.put("sourceSchemeId", cleanSchemeId);
                    out.put("revision", tx.currentRevision() + 1);
                    return out;
                }
        );
    }

    /**
     * 作废未实切的排程方案：自动取消底层未报工计划，释放实卷/料头预占，并将占用的 plannedQty 退回各源任务待排需求池 openQty。
     */
    Map<String, Object> cancelScheme(String schemeId, String reason) {
        if (schemeId == null || schemeId.isBlank()) throw new IllegalArgumentException("请指定排程方案编号");
        String why = (reason == null || reason.isBlank()) ? "排料员手动取消方案重排" : reason.trim();
        return statePort.inWrite(
                "DEMAND_ADJUSTMENT",
                schemeId,
                "UNAUTHENTICATED_LOCAL",
                tx -> tx.findScheme(schemeId)
                        .filter(s -> SchedulingScheme.STATE_CANCELLED.equals(s.state()))
                        .map(s -> viewSupport.enrichWithDemandFamilies(tx, s))
                        .orElse(null),
                tx -> {
                    SchedulingScheme scheme = tx.findScheme(schemeId)
                            .orElseThrow(() -> new IllegalArgumentException("排程方案不存在: " + schemeId));
                    if (SchedulingScheme.STATE_COMPLETED.equals(scheme.state())) {
                        throw new InventoryConflictException("已完工记账方案不可直接作废；若发现裁片不良请使用「复检补排」或报工冲销");
                    }
                    if (SchedulingScheme.STATE_REVERSED.equals(scheme.state())) {
                        throw new InventoryConflictException("已冲销方案已释放需求，无需再次作废");
                    }
                    for (String pid : scheme.linkedPlanIds()) {
                        tx.cancelPendingPlan(pid);
                    }
                    SchedulingScheme cancelled = scheme.withCancelled(LocalDateTime.now().format(TS_FMT), why);
                    tx.putScheme(cancelled);
                    return viewSupport.enrichWithDemandFamilies(tx, cancelled);
                }
        );
    }
}
