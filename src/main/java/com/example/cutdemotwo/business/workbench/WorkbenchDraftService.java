package com.example.cutdemotwo.business.workbench;

import com.example.cutdemotwo.business.cutting.CuttingStatePort;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.optimization.OptimizationService;
import com.example.cutdemotwo.contracts.jobs.OptimizationFailure;
import com.example.cutdemotwo.contracts.jobs.OptimizationResult;
import com.example.cutdemotwo.contracts.jobs.StoredOptimizationJob;
import com.example.cutdemotwo.contracts.jobs.WorkbenchJobSource;
import com.example.cutdemotwo.contracts.jobs.WorkbenchSchemeDraft;
import com.example.cutdemotwo.persistence.WorkbenchDraftStore;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * 工作台待人工确认草案服务：
 * <ul>
 *   <li>创建并持久化草案至独立 {@link WorkbenchDraftStore}，绝不写或扣任何实物库存，亦不提升库存 revision；</li>
 *   <li>计算防篡改 SHA-256 {@code contentHash}、审批令牌 {@code approvalToken} 与工业风险预检 {@code riskChecks}；</li>
 *   <li>查询时按当前时钟动态判定 {@code EXPIRED}，并只读核对当前任务与库存 revision 及材料状态输出 {@code stale} / {@code staleReasons}。</li>
 * </ul>
 */
@Service
public class WorkbenchDraftService {
    public static final long DEFAULT_TTL_SECONDS = 1800L;
    public static final long MIN_TTL_SECONDS = 1L;
    public static final long MAX_TTL_SECONDS = 86_400L;
    private static final Set<String> VALID_MATERIAL_TYPES = Set.of("STOCK_ROLL", "REMNANT", "FREE_CANVAS");
    private static final SecureRandom RANDOM = new SecureRandom();

    private final CuttingStatePort cuttingStatePort;
    private final OptimizationService optimizationService;
    private final WorkbenchDraftStore draftStore;
    private final Clock clock;

    @Autowired
    public WorkbenchDraftService(
            CuttingStatePort cuttingStatePort,
            OptimizationService optimizationService,
            WorkbenchDraftStore draftStore
    ) {
        this(cuttingStatePort, optimizationService, draftStore, Clock.systemUTC());
    }

    public WorkbenchDraftService(
            CuttingStatePort cuttingStatePort,
            OptimizationService optimizationService,
            WorkbenchDraftStore draftStore,
            Clock clock
    ) {
        this.cuttingStatePort = Objects.requireNonNull(cuttingStatePort, "cuttingStatePort");
        this.optimizationService = Objects.requireNonNull(optimizationService, "optimizationService");
        this.draftStore = Objects.requireNonNull(draftStore, "draftStore");
        this.clock = clock == null ? Clock.systemUTC() : clock;
    }

    public record CreateDraftRequest(
            String resultId,
            String taskId,
            String materialId,
            String materialType,
            String note,
            Long ttlSeconds
    ) {}

    private record SnapshotCheck(
            Long snapshotTaskRevision,
            Long snapshotMaterialRevision,
            List<WorkbenchSchemeDraft.RiskCheck> riskChecks,
            List<String> staleReasons
    ) {}

    /** 创建持久化待人工确认草案（绝不修改或锁扣实物库存）。 */
    public WorkbenchSchemeDraft createDraft(CreateDraftRequest req) {
        if (req == null || req.resultId() == null || req.resultId().isBlank()) {
            throw failure("INVALID_INPUT", "创建草案必须提供 resultId", 400);
        }
        String resultId = req.resultId().trim();
        long ttlSeconds = req.ttlSeconds() == null ? DEFAULT_TTL_SECONDS : req.ttlSeconds();
        if (ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) {
            throw failure("INVALID_INPUT", "草案有效期 ttlSeconds 须在 1–86400 秒之间", 400);
        }
        String note = (req.note() == null || req.note().isBlank()) ? null : req.note().trim();
        if (note != null && note.length() > 500) {
            throw failure("INVALID_INPUT", "草案备注长度不能超过 500 字符", 400);
        }

        StoredOptimizationJob doc = optimizationService.findJobWithSource(resultId);
        if (doc == null) {
            throw failure("NOT_FOUND", "排料结果不存在: " + resultId, 404);
        }
        if (doc.result() == null) {
            throw new OptimizationFailure("RESULT_NOT_AVAILABLE", "计算作业尚未生成已验证结果，暂不可生成草案", 409, !doc.job().terminal());
        }

        WorkbenchJobSource source = doc.workbenchSource();
        String taskId = resolveAndCheckField("taskId", req.taskId(), source == null ? null : source.taskId(), "TASK_MISMATCH", "草案任务编号与结果归档来源不一致");
        String materialType = resolveMaterialType(req.materialType(), source == null ? null : source.materialType());
        String materialId = resolveAndCheckField("materialId", req.materialId(), source == null ? null : source.materialId(), "MATERIAL_MISMATCH", "草案材料编号与结果归档来源不一致");

        SnapshotCheck check = cuttingStatePort.inRead(tx ->
                evaluateCreateChecks(tx, doc.result(), source, taskId, materialType, materialId)
        );

        Instant now = clock.instant();
        Instant expires = now.plusSeconds(ttlSeconds);
        String issuedAt = now.toString();
        String expiresAt = expires.toString();
        String draftId = "DFT-" + UUID.randomUUID().toString().replace("-", "").substring(0, 12).toUpperCase(Locale.ROOT);
        String approvalToken = "APR-" + randomHex(16);
        String contentHash = sha256Hex(String.join("|",
                "v1",
                resultId,
                Objects.toString(doc.result().inputHash(), ""),
                Objects.toString(taskId, ""),
                Objects.toString(materialType, ""),
                Objects.toString(materialId, ""),
                Objects.toString(note, ""),
                issuedAt
        ));

        WorkbenchSchemeDraft.Target target = new WorkbenchSchemeDraft.Target(resultId, taskId, materialId, materialType);
        String workbenchUrl = WorkbenchTaskViewSupport.buildWorkbenchUrl(taskId, resultId, draftId);
        String nextStep = "请点击 workbenchUrl 在搭切工作台画布核对排料图、疵点避让与余料，确认无误后使用工作台「选定此方案」按钮完成正式锁料落库；本草案未修改任何实物库存。";

        WorkbenchSchemeDraft draft = new WorkbenchSchemeDraft(
                draftId,
                draftId,
                WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION,
                approvalToken,
                contentHash,
                issuedAt,
                expiresAt,
                ttlSeconds,
                true,
                false,
                !check.staleReasons().isEmpty(),
                check.staleReasons(),
                target,
                check.riskChecks(),
                workbenchUrl,
                nextStep,
                note,
                check.snapshotTaskRevision(),
                check.snapshotMaterialRevision()
        );
        return draftStore.save(draft);
    }

    /** 查询持久化草案并按最新时间、任务与库存版本动态重算过期与漂移状态（纯只读）。 */
    public WorkbenchSchemeDraft getDraft(String draftId) {
        if (draftId == null || draftId.isBlank()) {
            throw failure("INVALID_INPUT", "草案编号 draftId 不能为空", 400);
        }
        WorkbenchSchemeDraft stored = draftStore.find(draftId.trim())
                .orElseThrow(() -> failure("NOT_FOUND", "工作台草案不存在: " + draftId.trim(), 404));

        boolean expired = isExpired(stored.expiresAt(), clock.instant());
        String status = expired ? WorkbenchSchemeDraft.STATUS_EXPIRED : WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION;

        StoredOptimizationJob doc = stored.target() == null
                ? null
                : optimizationService.findJobWithSource(stored.target().resultId());
        WorkbenchJobSource source = doc == null ? null : doc.workbenchSource();

        List<String> staleReasons = cuttingStatePort.inRead(tx -> evaluateLiveStaleReasons(tx, stored, source));
        return stored.withEvaluatedState(status, !staleReasons.isEmpty(), staleReasons);
    }

    private SnapshotCheck evaluateCreateChecks(
            CuttingStatePort.ReadView tx,
            OptimizationResult result,
            WorkbenchJobSource source,
            String taskId,
            String materialType,
            String materialId
    ) {
        List<WorkbenchSchemeDraft.RiskCheck> checks = new ArrayList<>();
        List<String> staleReasons = new ArrayList<>();

        boolean validated = "PASSED".equals(result.validationStatus());
        checks.add(new WorkbenchSchemeDraft.RiskCheck(
                "RESULT_VALIDATED",
                validated,
                validated ? "结果已通过后端独立几何与约束校验" : "结果未通过独立验证（" + result.validationStatus() + "）"
        ));

        boolean complete = "COMPLETE".equals(result.fulfillmentStatus());
        checks.add(new WorkbenchSchemeDraft.RiskCheck(
                "FULFILLMENT_COMPLETE",
                complete,
                complete ? "本次提交需求已全部齐套排入" : "当前方案未完全齐套（状态：" + result.fulfillmentStatus() + "），确认前请核对缺件明细"
        ));

        CuttingTask task = (taskId != null && !taskId.isBlank()) ? tx.findTask(taskId).orElse(null) : null;
        Long snapshotTaskRevision = null;
        if (taskId != null && !taskId.isBlank()) {
            if (task == null) {
                staleReasons.add("关联需求任务已不存在: " + taskId);
                checks.add(new WorkbenchSchemeDraft.RiskCheck("TASK_EXISTS", false, "关联需求任务不存在: " + taskId));
            } else {
                snapshotTaskRevision = (source != null && source.taskRevision() > 0) ? source.taskRevision() : task.revision();
                if (source != null && source.taskRevision() > 0 && task.revision() != source.taskRevision()) {
                    staleReasons.add("需求任务版本已变更（试排时 v" + source.taskRevision() + "，当前 v" + task.revision() + "）");
                }
                Map<Integer, Integer> openMap = WorkbenchTaskViewSupport.openQuantitiesByLineId(tx, task);
                int openTotal = openMap.values().stream().mapToInt(Integer::intValue).sum();
                if (openTotal <= 0) {
                    staleReasons.add("需求任务当前已无剩余待排量（openTotal=0）");
                }
            }
        }

        MotherRollInfo roll = null;
        RemnantStock remnant = null;
        Long snapshotMaterialRevision = null;

        if ("STOCK_ROLL".equals(materialType)) {
            roll = (materialId != null && !materialId.isBlank()) ? tx.findRoll(materialId).orElse(null) : null;
            snapshotMaterialRevision = (source != null && source.materialRevision() > 0)
                    ? source.materialRevision()
                    : tx.currentRevision();
            if (roll == null) {
                staleReasons.add("关联母卷已不存在: " + materialId);
                checks.add(new WorkbenchSchemeDraft.RiskCheck("MATERIAL_READY", false, "母卷不存在: " + materialId));
            } else {
                boolean ready = "PASSED".equalsIgnoreCase(roll.getInspectionStatus())
                        && roll.getScrappedAt() == null
                        && roll.getCurrentRemainingLength() > 0.1;
                checks.add(new WorkbenchSchemeDraft.RiskCheck(
                        "MATERIAL_READY",
                        ready,
                        ready ? "母卷 " + roll.getRollId() + " 质检合格且余长充足（余 " + Math.round(roll.getCurrentRemainingLength()) + "mm）"
                                : "母卷 " + roll.getRollId() + " 当前不可投产（质检状态=" + roll.getInspectionStatus()
                                + "，余长=" + Math.round(roll.getCurrentRemainingLength()) + "mm）"
                ));
                if (!ready) {
                    staleReasons.add("母卷 " + roll.getRollId() + " 当前状态不再适合投产（" + roll.getInspectionStatus() + "）");
                }
                if (source != null && source.materialRevision() > 0 && tx.currentRevision() != source.materialRevision()) {
                    staleReasons.add("库存版本已变更（试排时 r" + source.materialRevision() + "，当前 r" + tx.currentRevision() + "）");
                }
                if (source != null && roll.getUsedLength() > source.windowStartMm() + 0.05) {
                    staleReasons.add("母卷已切割进度超过试排工位起点（当前已用 " + Math.round(roll.getUsedLength())
                            + "mm > 试排起点 " + Math.round(source.windowStartMm()) + "mm）");
                }
                boolean reserved = tx.isMaterialReservedByExecution("roll", roll.getRollId(), null);
                checks.add(new WorkbenchSchemeDraft.RiskCheck(
                        "NO_EXECUTION_RESERVATION",
                        !reserved,
                        reserved ? "母卷 " + roll.getRollId() + " 正被其他活跃执行单预约或加工中" : "母卷当前无冲突执行单预约"
                ));
                boolean defectAvoidOk = roll.getDefects() == null || roll.getDefects().isEmpty()
                        || source == null || !Boolean.FALSE.equals(source.avoidDefects());
                checks.add(new WorkbenchSchemeDraft.RiskCheck(
                        "DEFECT_AVOIDANCE",
                        defectAvoidOk,
                        defectAvoidOk ? "母卷疵点避让策略已生效（或无疵点）" : "母卷含 " + roll.getDefects().size() + " 处疵点但试排关闭了避疵开关"
                ));
            }
        } else if ("REMNANT".equals(materialType)) {
            remnant = (materialId != null && !materialId.isBlank()) ? tx.findRemnant(materialId).orElse(null) : null;
            snapshotMaterialRevision = (source != null && source.materialRevision() > 0)
                    ? source.materialRevision()
                    : tx.currentRevision();
            if (remnant == null) {
                staleReasons.add("关联料头已不存在: " + materialId);
                checks.add(new WorkbenchSchemeDraft.RiskCheck("MATERIAL_READY", false, "料头不存在: " + materialId));
            } else {
                boolean ready = "AVAILABLE".equalsIgnoreCase(remnant.getStatus());
                checks.add(new WorkbenchSchemeDraft.RiskCheck(
                        "MATERIAL_READY",
                        ready,
                        ready ? "料头 " + remnant.getId() + " 在库可用（" + Math.round(remnant.getWidth()) + "×" + Math.round(remnant.getLength()) + "mm）"
                                : "料头 " + remnant.getId() + " 当前状态为 " + remnant.getStatus() + "，已不可领用"
                ));
                if (!ready) {
                    staleReasons.add("料头 " + remnant.getId() + " 状态已变更为 " + remnant.getStatus());
                }
                if (source != null && source.materialRevision() > 0 && tx.currentRevision() != source.materialRevision()) {
                    staleReasons.add("库存版本已变更（试排时 r" + source.materialRevision() + "，当前 r" + tx.currentRevision() + "）");
                }
                boolean reserved = tx.isMaterialReservedByExecution("remnant", remnant.getId(), null);
                checks.add(new WorkbenchSchemeDraft.RiskCheck(
                        "NO_EXECUTION_RESERVATION",
                        !reserved,
                        reserved ? "料头 " + remnant.getId() + " 正被其他活跃执行单预约" : "料头当前无冲突执行单预约"
                ));
            }
        } else {
            snapshotMaterialRevision = 0L;
            checks.add(new WorkbenchSchemeDraft.RiskCheck(
                    "MATERIAL_READY",
                    true,
                    "自由画布虚拟方案（确认落库后将在结果中心等待绑定实体母卷）"
            ));
        }

        if (task != null && (roll != null || remnant != null)) {
            try {
                tx.validateBatchAndColorForTask(task, roll, remnant);
                checks.add(new WorkbenchSchemeDraft.RiskCheck("BATCH_AND_COLOR_MATCH", true, "材料缸号/色号满足任务防色差约束"));
            } catch (IllegalArgumentException mismatch) {
                checks.add(new WorkbenchSchemeDraft.RiskCheck("BATCH_AND_COLOR_MATCH", false, mismatch.getMessage()));
            }
        }

        boolean revisionCurrent = staleReasons.isEmpty();
        checks.add(new WorkbenchSchemeDraft.RiskCheck(
                "REVISION_CURRENT",
                revisionCurrent,
                revisionCurrent ? "任务与库存版本与试排快照一致" : String.join("；", staleReasons)
        ));

        return new SnapshotCheck(snapshotTaskRevision, snapshotMaterialRevision, List.copyOf(checks), List.copyOf(staleReasons));
    }

    private List<String> evaluateLiveStaleReasons(
            CuttingStatePort.ReadView tx,
            WorkbenchSchemeDraft stored,
            WorkbenchJobSource source
    ) {
        List<String> reasons = new ArrayList<>();
        WorkbenchSchemeDraft.Target target = stored.target();
        if (target == null) {
            return reasons;
        }
        if (target.taskId() != null && !target.taskId().isBlank()) {
            CuttingTask task = tx.findTask(target.taskId()).orElse(null);
            if (task == null) {
                reasons.add("关联需求任务已不存在: " + target.taskId());
            } else {
                if (stored.snapshotTaskRevision() != null && task.revision() != stored.snapshotTaskRevision()) {
                    reasons.add("需求任务版本已变更（草案快照 v" + stored.snapshotTaskRevision() + "，当前 v" + task.revision() + "）");
                }
                int openTotal = WorkbenchTaskViewSupport.openQuantitiesByLineId(tx, task).values()
                        .stream().mapToInt(Integer::intValue).sum();
                if (openTotal <= 0) {
                    reasons.add("需求任务剩余待排量已清零，建议核对是否已被其他方案占用");
                }
            }
        }
        if ("STOCK_ROLL".equals(target.materialType()) && target.materialId() != null && !target.materialId().isBlank()) {
            MotherRollInfo roll = tx.findRoll(target.materialId()).orElse(null);
            if (roll == null) {
                reasons.add("关联母卷已不存在: " + target.materialId());
            } else {
                if (stored.snapshotMaterialRevision() != null
                        && stored.snapshotMaterialRevision() > 0
                        && tx.currentRevision() != stored.snapshotMaterialRevision()) {
                    reasons.add("库存版本已变更（草案快照 r" + stored.snapshotMaterialRevision() + "，当前 r" + tx.currentRevision() + "）");
                }
                if (!"PASSED".equalsIgnoreCase(roll.getInspectionStatus()) || roll.getScrappedAt() != null) {
                    reasons.add("母卷 " + roll.getRollId() + " 质检/报废状态已变更（当前: " + roll.getInspectionStatus() + "）");
                } else if (roll.getCurrentRemainingLength() <= 0.1) {
                    reasons.add("母卷 " + roll.getRollId() + " 已消耗完毕");
                }
                if (source != null && roll.getUsedLength() > source.windowStartMm() + 0.05) {
                    reasons.add("母卷已切割长度已超过草案工位起点（已切 " + Math.round(roll.getUsedLength())
                            + "mm > 起点 " + Math.round(source.windowStartMm()) + "mm）");
                }
            }
        } else if ("REMNANT".equals(target.materialType()) && target.materialId() != null && !target.materialId().isBlank()) {
            RemnantStock remnant = tx.findRemnant(target.materialId()).orElse(null);
            if (remnant == null) {
                reasons.add("关联料头已不存在: " + target.materialId());
            } else {
                if (stored.snapshotMaterialRevision() != null
                        && stored.snapshotMaterialRevision() > 0
                        && tx.currentRevision() != stored.snapshotMaterialRevision()) {
                    reasons.add("库存版本已变更（草案快照 r" + stored.snapshotMaterialRevision() + "，当前 r" + tx.currentRevision() + "）");
                }
                if (!"AVAILABLE".equalsIgnoreCase(remnant.getStatus())) {
                    reasons.add("料头 " + remnant.getId() + " 状态已变更为 " + remnant.getStatus());
                }
            }
        }
        return List.copyOf(reasons);
    }

    private static String resolveAndCheckField(String name, String requested, String fromSource, String conflictCode, String conflictMsg) {
        String cleanReq = (requested == null || requested.isBlank()) ? null : requested.trim();
        String cleanSrc = (fromSource == null || fromSource.isBlank()) ? null : fromSource.trim();
        if (cleanReq != null && cleanSrc != null && !cleanReq.equals(cleanSrc)) {
            throw failure(conflictCode, conflictMsg + "（传入 " + cleanReq + "，结果归档为 " + cleanSrc + "）", 422);
        }
        return cleanReq != null ? cleanReq : cleanSrc;
    }

    private static String resolveMaterialType(String requested, String fromSource) {
        String cleanReq = (requested == null || requested.isBlank()) ? null : requested.trim().toUpperCase(Locale.ROOT);
        if (cleanReq != null && !VALID_MATERIAL_TYPES.contains(cleanReq)) {
            throw failure("INVALID_INPUT", "不支持的 materialType: " + requested, 400);
        }
        String cleanSrc = (fromSource == null || fromSource.isBlank()) ? null : fromSource.trim().toUpperCase(Locale.ROOT);
        if (cleanReq != null && cleanSrc != null && !cleanReq.equals(cleanSrc)) {
            throw failure("MATERIAL_MISMATCH", "草案材料类型与结果归档来源不一致", 422);
        }
        return cleanReq != null ? cleanReq : (cleanSrc != null ? cleanSrc : "FREE_CANVAS");
    }

    private static boolean isExpired(String expiresAt, Instant now) {
        if (expiresAt == null || expiresAt.isBlank()) {
            return false;
        }
        try {
            return now.isAfter(Instant.parse(expiresAt));
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private static String randomHex(int byteCount) {
        byte[] bytes = new byte[byteCount];
        RANDOM.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }

    private static String sha256Hex(String input) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static OptimizationFailure failure(String code, String message, int status) {
        return new OptimizationFailure(code, message, status, false);
    }
}
