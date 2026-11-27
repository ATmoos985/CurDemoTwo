package com.example.cutdemotwo.business.workbench;

import com.example.cutdemotwo.business.cutting.CuttingStatePort;
import com.example.cutdemotwo.business.cutting.SchedulingStudioService;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.business.optimization.OptimizationService;
import com.example.cutdemotwo.contracts.jobs.OptimizationFailure;
import com.example.cutdemotwo.contracts.jobs.OptimizationResult;
import com.example.cutdemotwo.contracts.jobs.StoredOptimizationJob;
import com.example.cutdemotwo.contracts.jobs.WorkbenchJobSource;
import com.example.cutdemotwo.contracts.jobs.WorkbenchSchemeDraft;
import com.example.cutdemotwo.persistence.WorkbenchDraftStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;

/**
 * 工作台待人工确认草案服务：
 * <ul>
 *   <li>创建并持久化草案至独立 {@link WorkbenchDraftStore}，绝不写或扣任何实物库存，亦不提升库存 revision；</li>
 *   <li>支持列表倒序分页、批组聚合、CAS 原子确认/作废、与正式落库联动回写及定时过期滚动清理；</li>
 *   <li>查询时按当前时钟动态判定 {@code EXPIRED}，并只读核对任务与库存 revision（已终态草案永不被覆盖为 EXPIRED）。</li>
 * </ul>
 */
@Service
public class WorkbenchDraftService {
    private static final Logger log = LoggerFactory.getLogger(WorkbenchDraftService.class);

    public static final long DEFAULT_TTL_SECONDS = 1800L;
    public static final long MIN_TTL_SECONDS = 1L;
    public static final long MAX_TTL_SECONDS = 86_400L;
    public static final long DEFAULT_RETENTION_HOURS = 168L;
    private static final Set<String> VALID_MATERIAL_TYPES = Set.of("STOCK_ROLL", "REMNANT", "FREE_CANVAS");
    private static final Set<String> VALID_QUERY_STATUSES = Set.of(
            "ALL",
            WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION,
            WorkbenchSchemeDraft.STATUS_CONFIRMED,
            WorkbenchSchemeDraft.STATUS_DISCARDED,
            WorkbenchSchemeDraft.STATUS_EXPIRED
    );
    private static final SecureRandom RANDOM = new SecureRandom();

    private final CuttingStatePort cuttingStatePort;
    private final OptimizationService optimizationService;
    private final WorkbenchDraftStore draftStore;
    private final Clock clock;
    private final ConcurrentHashMap<String, DraftLockEntry> draftLocks = new ConcurrentHashMap<>();

    private static final class DraftLockEntry {
        final ReentrantLock lock = new ReentrantLock();
        int refs = 0;
    }

    @Value("${cutdemo.workbench.drafts.retention-hours:168}")
    private long retentionHours = DEFAULT_RETENTION_HOURS;

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

    public record DraftListPage(
            List<WorkbenchSchemeDraft> items,
            long total,
            int page,
            int size,
            long pendingCount
    ) {}

    public record ConfirmDraftRequest(
            String schemeId,
            String operator
    ) {}

    public record DiscardDraftRequest(
            String reason,
            String operator
    ) {}

    private record PreparedDraftInput(
            StoredOptimizationJob doc,
            String resultId,
            String taskId,
            String materialType,
            String materialId,
            String note,
            long ttlSeconds
    ) {}

    private record SnapshotCheck(
            Long snapshotTaskRevision,
            Long snapshotMaterialRevision,
            List<WorkbenchSchemeDraft.RiskCheck> riskChecks,
            List<String> staleReasons
    ) {}

    /** 创建持久化待人工确认草案（绝不修改或锁扣实物库存）。 */
    public WorkbenchSchemeDraft createDraft(CreateDraftRequest req) {
        PreparedDraftInput prepared = prepareCreateInput(req);
        SnapshotCheck check = cuttingStatePort.inRead(tx ->
                evaluateCreateChecks(tx, prepared.doc().result(), prepared.doc().workbenchSource(),
                        prepared.taskId(), prepared.materialType(), prepared.materialId())
        );
        WorkbenchSchemeDraft draft = assembleDraft(prepared, check, null, null, null);
        return draftStore.save(draft);
    }

    /** 批量创建共享同一 {@code batchGroupId} 的一组待人工确认草案（绝不修改或锁扣实物库存）。 */
    public List<WorkbenchSchemeDraft> createBatchDrafts(String batchGroupId, List<CreateDraftRequest> requests) {
        if (batchGroupId == null || batchGroupId.isBlank()) {
            throw failure("INVALID_INPUT", "批量草案组编号 batchGroupId 不能为空", 400);
        }
        if (requests == null || requests.isEmpty()) {
            return List.of();
        }
        String cleanGroupId = batchGroupId.trim();
        List<PreparedDraftInput> preparedList = new ArrayList<>(requests.size());
        for (CreateDraftRequest req : requests) {
            preparedList.add(prepareCreateInput(req));
        }
        List<SnapshotCheck> checks = cuttingStatePort.inRead(tx -> {
            List<SnapshotCheck> out = new ArrayList<>(preparedList.size());
            for (PreparedDraftInput p : preparedList) {
                out.add(evaluateCreateChecks(
                        tx, p.doc().result(), p.doc().workbenchSource(),
                        p.taskId(), p.materialType(), p.materialId()
                ));
            }
            return out;
        });

        int total = preparedList.size();
        List<WorkbenchSchemeDraft> drafts = new ArrayList<>(total);
        for (int i = 0; i < total; i++) {
            drafts.add(assembleDraft(preparedList.get(i), checks.get(i), cleanGroupId, i + 1, total));
        }
        return draftStore.saveAll(drafts);
    }

    private PreparedDraftInput prepareCreateInput(CreateDraftRequest req) {
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
        String taskId = resolveAndCheckField("taskId", req.taskId(), source == null ? null : source.taskId(),
                "TASK_MISMATCH", "草案任务编号与结果归档来源不一致");
        String materialType = resolveMaterialType(req.materialType(), source == null ? null : source.materialType());
        String materialId = resolveAndCheckField("materialId", req.materialId(), source == null ? null : source.materialId(),
                "MATERIAL_MISMATCH", "草案材料编号与结果归档来源不一致");
        return new PreparedDraftInput(doc, resultId, taskId, materialType, materialId, note, ttlSeconds);
    }

    private WorkbenchSchemeDraft assembleDraft(
            PreparedDraftInput p,
            SnapshotCheck check,
            String batchGroupId,
            Integer batchIndex,
            Integer batchTotal
    ) {
        Instant now = clock.instant();
        Instant expires = now.plusSeconds(p.ttlSeconds());
        String issuedAt = now.toString();
        String expiresAt = expires.toString();
        String draftId = "DFT-" + UUID.randomUUID().toString().replace("-", "").substring(0, 12).toUpperCase(Locale.ROOT);
        String approvalToken = "APR-" + randomHex(16);
        String contentHash = sha256Hex(String.join("|",
                "v1",
                p.resultId(),
                Objects.toString(p.doc().result().inputHash(), ""),
                Objects.toString(p.taskId(), ""),
                Objects.toString(p.materialType(), ""),
                Objects.toString(p.materialId(), ""),
                Objects.toString(p.note(), ""),
                Objects.toString(batchGroupId, ""),
                issuedAt
        ));

        WorkbenchSchemeDraft.Target target = new WorkbenchSchemeDraft.Target(
                p.resultId(), p.taskId(), p.materialId(), p.materialType()
        );
        String workbenchUrl = WorkbenchTaskViewSupport.buildWorkbenchUrl(p.taskId(), p.resultId(), draftId);
        String nextStep = "请点击 workbenchUrl 在搭切工作台画布核对排料图、疵点避让与余料，确认无误后使用工作台「选定此方案」按钮完成正式锁料落库；本草案未修改任何实物库存。";

        return new WorkbenchSchemeDraft(
                draftId,
                draftId,
                WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION,
                approvalToken,
                contentHash,
                issuedAt,
                expiresAt,
                p.ttlSeconds(),
                true,
                false,
                !check.staleReasons().isEmpty(),
                check.staleReasons(),
                target,
                check.riskChecks(),
                workbenchUrl,
                nextStep,
                p.note(),
                check.snapshotTaskRevision(),
                check.snapshotMaterialRevision(),
                batchGroupId,
                batchIndex,
                batchTotal,
                null,
                null,
                null,
                null,
                null,
                null
        );
    }

    /** 查询持久化草案并按最新时间、任务与库存版本动态重算过期与漂移状态（纯只读）。 */
    public WorkbenchSchemeDraft getDraft(String draftId) {
        if (draftId == null || draftId.isBlank()) {
            throw failure("INVALID_INPUT", "草案编号 draftId 不能为空", 400);
        }
        WorkbenchSchemeDraft stored = draftStore.find(draftId.trim())
                .orElseThrow(() -> failure("NOT_FOUND", "工作台草案不存在: " + draftId.trim(), 404));

        if (stored.isFinalized()) {
            return stored.withEvaluatedState(stored.status(), false, List.of());
        }

        boolean expired = isExpired(stored.expiresAt(), clock.instant());
        String status = expired ? WorkbenchSchemeDraft.STATUS_EXPIRED : WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION;

        StoredOptimizationJob doc = stored.target() == null
                ? null
                : optimizationService.findJobWithSource(stored.target().resultId());
        WorkbenchJobSource source = doc == null ? null : doc.workbenchSource();

        List<String> staleReasons = cuttingStatePort.inRead(tx -> evaluateLiveStaleReasons(tx, stored, source));
        return stored.withEvaluatedState(status, !staleReasons.isEmpty(), staleReasons);
    }

    /** 按状态/任务/批组分页倒序查询草案列表（仅对非终态条目实时重算版本漂移）。 */
    public DraftListPage listDrafts(String status, String taskId, String batchGroupId, int page, int size) {
        if (page < 0) {
            throw failure("INVALID_INPUT", "页码 page 不能为负数", 400);
        }
        if (size < 1 || size > 100) {
            throw failure("INVALID_INPUT", "分页大小 size 须在 1–100 之间", 400);
        }
        String normStatus = (status == null || status.isBlank()) ? null : status.trim().toUpperCase(Locale.ROOT);
        if (normStatus != null && !VALID_QUERY_STATUSES.contains(normStatus)) {
            throw failure("INVALID_INPUT", "不支持的草案状态过滤条件: " + status, 400);
        }
        String cleanTaskId = (taskId == null || taskId.isBlank()) ? null : taskId.trim();
        String cleanBatchGroupId = (batchGroupId == null || batchGroupId.isBlank()) ? null : batchGroupId.trim();

        WorkbenchDraftStore.DraftPage rawPage = draftStore.query(
                new WorkbenchDraftStore.DraftQuery(normStatus, cleanTaskId, cleanBatchGroupId, page, size),
                clock.millis()
        );
        if (rawPage.items().isEmpty()) {
            return new DraftListPage(List.of(), rawPage.total(), rawPage.page(), rawPage.size(), rawPage.pendingCount());
        }

        Map<String, WorkbenchJobSource> sourcesByDraft = new LinkedHashMap<>();
        boolean hasLivePending = false;
        for (WorkbenchSchemeDraft d : rawPage.items()) {
            if (!d.isFinalized() && WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION.equals(d.status())) {
                hasLivePending = true;
                String rid = d.target() == null ? null : d.target().resultId();
                if (rid != null && !rid.isBlank()) {
                    StoredOptimizationJob doc = optimizationService.findJobWithSource(rid);
                    if (doc != null && doc.workbenchSource() != null) {
                        sourcesByDraft.put(d.draftId(), doc.workbenchSource());
                    }
                }
            }
        }

        List<WorkbenchSchemeDraft> evaluated = new ArrayList<>(rawPage.items().size());
        if (hasLivePending) {
            cuttingStatePort.inRead(tx -> {
                for (WorkbenchSchemeDraft d : rawPage.items()) {
                    if (d.isFinalized() || !WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION.equals(d.status())) {
                        evaluated.add(d.isFinalized() ? d.withEvaluatedState(d.status(), false, List.of()) : d);
                    } else {
                        List<String> reasons = evaluateLiveStaleReasons(tx, d, sourcesByDraft.get(d.draftId()));
                        evaluated.add(d.withEvaluatedState(d.status(), !reasons.isEmpty(), reasons));
                    }
                }
                return null;
            });
        } else {
            for (WorkbenchSchemeDraft d : rawPage.items()) {
                evaluated.add(d.isFinalized() ? d.withEvaluatedState(d.status(), false, List.of()) : d);
            }
        }

        return new DraftListPage(List.copyOf(evaluated), rawPage.total(), rawPage.page(), rawPage.size(), rawPage.pendingCount());
    }

    /** 原子将待确认草案流转为 CONFIRMED（已确认/已作废/已过期返回 409，不存在返回 404）。 */
    public WorkbenchSchemeDraft confirmDraft(String draftId, ConfirmDraftRequest req, String actor) {
        String cleanId = requireDraftId(draftId);
        String schemeId = (req == null || req.schemeId() == null || req.schemeId().isBlank()) ? null : req.schemeId().trim();
        String operator = resolveOperator(req == null ? null : req.operator(), actor);

        return withDraftLock(cleanId, () -> {
            Instant now = clock.instant();
            WorkbenchDraftStore.TransitionResult result = draftStore.transitionFromPending(
                    cleanId,
                    now.toEpochMilli(),
                    current -> current.withConfirmed(schemeId, operator, now.toString())
            );
            return unwrapTransitionOrThrow(cleanId, result);
        });
    }

    /** 原子将待确认草案流转为 DISCARDED 并记录作废原因（绝不修改或恢复实物库存）。 */
    public WorkbenchSchemeDraft discardDraft(String draftId, DiscardDraftRequest req, String actor) {
        String cleanId = requireDraftId(draftId);
        String rawReason = req == null ? null : req.reason();
        String cleanReason = (rawReason == null || rawReason.isBlank()) ? null : rawReason.trim();
        if (cleanReason != null && cleanReason.length() > 500) {
            throw failure("INVALID_INPUT", "草案作废原因长度不能超过 500 字符", 400);
        }
        String operator = resolveOperator(req == null ? null : req.operator(), actor);

        return withDraftLock(cleanId, () -> {
            Instant now = clock.instant();
            WorkbenchDraftStore.TransitionResult result = draftStore.transitionFromPending(
                    cleanId,
                    now.toEpochMilli(),
                    current -> current.withDiscarded(operator, now.toString(), cleanReason)
            );
            return unwrapTransitionOrThrow(cleanId, result);
        });
    }

    /**
     * 无环联动协调入口（由 {@code StudioWorkflowController} 调用，严禁 {@code business.cutting} 反向引用本包）：
     * 1) 按 {@code draftId} 粒度互斥加锁，彻底消除“预检→落库→CAS回写”期间与作废/重复确认的竞态窗口；
     * 2) 预检关联草案必须处于 {@code PENDING_CONFIRMATION} 且未过期（已确认时仅当幂等键命中同方案才放行重放）；
     * 3) 调用 {@link SchedulingStudioService#confirmScheme} 完成正式锁料落库；
     * 4) 原子 CAS 回写草案状态为 {@code CONFIRMED} 并绑定正式 {@code schemeId}。
     */
    public Map<String, Object> confirmSchemeWithDraft(
            SchedulingStudioService.ConfirmSchemeCommand cmd,
            SchedulingStudioService studioService,
            String actor
    ) {
        if (cmd == null || cmd.draftId() == null || cmd.draftId().isBlank()) {
            return studioService.confirmScheme(cmd);
        }
        String cleanDraftId = requireDraftId(cmd.draftId());
        String cleanIdemKey = (cmd.idempotencyKey() == null || cmd.idempotencyKey().isBlank())
                ? null : cmd.idempotencyKey().trim();

        return withDraftLock(cleanDraftId, () -> {
            WorkbenchSchemeDraft stored = draftStore.find(cleanDraftId)
                    .orElseThrow(() -> failure("NOT_FOUND", "关联工作台草案不存在: " + cleanDraftId, 404));

            if (WorkbenchSchemeDraft.STATUS_DISCARDED.equals(stored.status())) {
                throw failure("DRAFT_DISCARDED", "关联草案 " + cleanDraftId + " 已作废，不可再确认落库", 409);
            }
            if (WorkbenchSchemeDraft.STATUS_CONFIRMED.equals(stored.status())) {
                if (isIdempotentConfirmedReplay(stored, cleanIdemKey)) {
                    Map<String, Object> replay = new LinkedHashMap<>(studioService.confirmScheme(cmd));
                    replay.put("draft", stored.withEvaluatedState(stored.status(), false, List.of()));
                    return replay;
                }
                throw failure("DRAFT_ALREADY_CONFIRMED",
                        "关联草案 " + cleanDraftId + " 已被确认绑定至方案 " + Objects.toString(stored.confirmedSchemeId(), ""),
                        409);
            }
            Instant checkInstant = clock.instant();
            if (WorkbenchSchemeDraft.STATUS_EXPIRED.equals(stored.status())
                    || isExpired(stored.expiresAt(), checkInstant)) {
                throw failure("DRAFT_EXPIRED", "关联草案 " + cleanDraftId + " 已过期，请重新试排后再确认落库", 409);
            }

            Map<String, Object> confirmedResult = studioService.confirmScheme(cmd);
            String schemeId = extractConfirmedSchemeId(confirmedResult);
            String operator = resolveOperator(null, actor);
            String nowIso = clock.instant().toString();

            // 沿用锁内预检时刻判定有效期，避免确认落库执行耗时跨越 expiresAt 造成“方案已落库但草案报过期”的账实撕裂
            WorkbenchDraftStore.TransitionResult transition = draftStore.transitionFromPending(
                    cleanDraftId,
                    checkInstant.toEpochMilli(),
                    current -> current.withConfirmed(schemeId, operator, nowIso)
            );

            WorkbenchSchemeDraft finalDraft;
            if (transition.outcome() == WorkbenchDraftStore.TransitionOutcome.UPDATED) {
                finalDraft = transition.draft();
            } else if (transition.outcome() == WorkbenchDraftStore.TransitionOutcome.CONFLICT_STATE
                    && transition.draft() != null
                    && WorkbenchSchemeDraft.STATUS_CONFIRMED.equals(transition.draft().status())
                    && Objects.equals(schemeId, transition.draft().confirmedSchemeId())) {
                finalDraft = transition.draft();
            } else {
                log.error("草案 {} 联动方案 {} 落库后 CAS 回写异常: outcome={}", cleanDraftId, schemeId, transition.outcome());
                finalDraft = unwrapTransitionOrThrow(cleanDraftId, transition);
            }

            Map<String, Object> out = new LinkedHashMap<>(confirmedResult);
            out.put("draft", finalDraft);
            return out;
        });
    }

    private <T> T withDraftLock(String draftId, Supplier<T> action) {
        DraftLockEntry entry = draftLocks.compute(draftId, (k, existing) -> {
            DraftLockEntry target = existing == null ? new DraftLockEntry() : existing;
            target.refs++;
            return target;
        });
        entry.lock.lock();
        try {
            return action.get();
        } finally {
            entry.lock.unlock();
            draftLocks.computeIfPresent(draftId, (k, existing) -> {
                if (existing == entry) {
                    existing.refs--;
                    if (existing.refs <= 0) {
                        return null;
                    }
                }
                return existing;
            });
        }
    }

    private int tryWithDraftLock(String draftId, java.util.function.IntSupplier action) {
        DraftLockEntry entry = draftLocks.compute(draftId, (k, existing) -> {
            DraftLockEntry target = existing == null ? new DraftLockEntry() : existing;
            target.refs++;
            return target;
        });
        boolean acquired = false;
        try {
            // 若当前线程已持外层业务锁（如 confirmSchemeWithDraft 内钩子同步触发）或其它线程正持锁确认/作废，直接跳过本条
            if (!entry.lock.isHeldByCurrentThread() && entry.lock.tryLock()) {
                acquired = true;
                return action.getAsInt();
            }
            return 0;
        } finally {
            if (acquired) {
                entry.lock.unlock();
            }
            draftLocks.computeIfPresent(draftId, (k, existing) -> {
                if (existing == entry) {
                    existing.refs--;
                    if (existing.refs <= 0) {
                        return null;
                    }
                }
                return existing;
            });
        }
    }

    /** Spring 定时滚动清理：按 draftId 粒度加锁将过期草案标态为 EXPIRED，并清除超过保留期的终态/过期条目。 */
    @Scheduled(fixedDelayString = "${cutdemo.workbench.drafts.cleanup-interval-ms:300000}")
    public void scheduledCleanupExpiredDrafts() {
        try {
            cleanupExpiredDrafts(retentionHours);
        } catch (RuntimeException error) {
            log.warn("定时清理过期工作台草案失败", error);
        }
    }

    public int cleanupExpiredDrafts() {
        return cleanupExpiredDrafts(retentionHours);
    }

    public int cleanupExpiredDrafts(long customRetentionHours) {
        long safeHours = Math.max(0L, customRetentionHours);
        long nowMs = clock.millis();
        long purgeBeforeMs = nowMs - safeHours * 3_600_000L;
        List<String> candidateIds = draftStore.listCleanupCandidateIds(nowMs, purgeBeforeMs);
        int affected = 0;
        for (String candidateId : candidateIds) {
            affected += tryWithDraftLock(candidateId,
                    () -> draftStore.expireOrPurgeSingle(candidateId, nowMs, purgeBeforeMs));
        }
        return affected;
    }

    private boolean isIdempotentConfirmedReplay(WorkbenchSchemeDraft stored, String idemKey) {
        if (idemKey == null || stored.confirmedSchemeId() == null || stored.confirmedSchemeId().isBlank()) {
            return false;
        }
        return Boolean.TRUE.equals(cuttingStatePort.inRead(tx ->
                tx.findScheme(stored.confirmedSchemeId())
                        .map(s -> idemKey.equals(s.idempotencyKey()))
                        .orElse(false)
        ));
    }

    private static String extractConfirmedSchemeId(Map<String, Object> result) {
        if (result == null) return null;
        Object schemeObj = result.get("scheme");
        if (schemeObj instanceof SchedulingScheme scheme) {
            return scheme.id();
        }
        if (schemeObj instanceof Map<?, ?> map && map.get("id") != null) {
            return String.valueOf(map.get("id"));
        }
        return null;
    }

    private static WorkbenchSchemeDraft unwrapTransitionOrThrow(
            String draftId,
            WorkbenchDraftStore.TransitionResult result
    ) {
        return switch (result.outcome()) {
            case UPDATED -> result.draft();
            case NOT_FOUND -> throw failure("NOT_FOUND", "工作台草案不存在: " + draftId, 404);
            case EXPIRED -> throw failure("DRAFT_EXPIRED", "草案 " + draftId + " 已过期，当前状态不允许该操作", 409);
            case CONFLICT_STATE -> {
                String st = result.draft() == null ? "UNKNOWN" : result.draft().status();
                if (WorkbenchSchemeDraft.STATUS_CONFIRMED.equals(st)) {
                    throw failure("DRAFT_ALREADY_CONFIRMED", "草案 " + draftId + " 已确认落库，不可重复操作", 409);
                }
                if (WorkbenchSchemeDraft.STATUS_DISCARDED.equals(st)) {
                    throw failure("DRAFT_ALREADY_DISCARDED", "草案 " + draftId + " 已作废，不可再确认或重复作废", 409);
                }
                if (WorkbenchSchemeDraft.STATUS_EXPIRED.equals(st)) {
                    throw failure("DRAFT_EXPIRED", "草案 " + draftId + " 已过期，当前状态不允许该操作", 409);
                }
                throw failure("DRAFT_CONFLICT", "草案 " + draftId + " 当前状态(" + st + ")不允许此状态跃迁", 409);
            }
        };
    }

    private static String requireDraftId(String draftId) {
        if (draftId == null || draftId.isBlank()) {
            throw failure("INVALID_INPUT", "草案编号 draftId 不能为空", 400);
        }
        return draftId.trim();
    }

    private static String resolveOperator(String explicit, String fallbackActor) {
        if (explicit != null && !explicit.isBlank()) {
            String clean = explicit.trim();
            return clean.length() > 120 ? clean.substring(0, 120) : clean;
        }
        if (fallbackActor != null && !fallbackActor.isBlank()) {
            String clean = fallbackActor.trim();
            return clean.length() > 120 ? clean.substring(0, 120) : clean;
        }
        return "LOCAL";
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
