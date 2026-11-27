package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.contracts.jobs.WorkbenchSchemeDraft;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

import javax.sql.DataSource;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.function.UnaryOperator;

/**
 * JDBC 模式工作台草案持久化存储（MySQL 8.4 与 H2 双兼容）：
 * 仅读写 {@code workbench_scheme_draft} 独立表，绝不读写库存表或修改库存 revision。
 */
public final class JdbcWorkbenchDraftStore implements WorkbenchDraftStore {
    private static final String VALID_ID_PATTERN = "[A-Za-z0-9._-]{1,128}";

    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final JsonMapper json = JsonMapper.builder().build();

    public JdbcWorkbenchDraftStore(DataSource source) {
        Objects.requireNonNull(source, "数据源不能为空");
        this.jdbc = new JdbcTemplate(source);
        String product = jdbc.execute(
                (org.springframework.jdbc.core.ConnectionCallback<String>) conn -> conn.getMetaData().getDatabaseProductName()
        );
        if (!"MySQL".equals(product) && !"H2".equals(product)) {
            throw new IllegalArgumentException("工作台草案数据库存储仅支持 MySQL 与兼容测试 H2，当前驱动：" + product);
        }
        this.transaction = new TransactionTemplate(new DataSourceTransactionManager(source));
        this.transaction.setTimeout(5);
    }

    @Override
    public WorkbenchSchemeDraft save(WorkbenchSchemeDraft draft) {
        validateDraft(draft);
        return transaction.execute(status -> upsertLocked(draft));
    }

    @Override
    public List<WorkbenchSchemeDraft> saveAll(List<WorkbenchSchemeDraft> drafts) {
        if (drafts == null || drafts.isEmpty()) {
            return List.of();
        }
        for (WorkbenchSchemeDraft draft : drafts) {
            validateDraft(draft);
        }
        return transaction.execute(status -> {
            List<WorkbenchSchemeDraft> saved = new ArrayList<>(drafts.size());
            for (WorkbenchSchemeDraft draft : drafts) {
                saved.add(upsertLocked(draft));
            }
            return List.copyOf(saved);
        });
    }

    private WorkbenchSchemeDraft upsertLocked(WorkbenchSchemeDraft draft) {
        String payload = json.writeValueAsString(draft);
        long issuedMs = parseEpochMillis(draft.issuedAt(), System.currentTimeMillis());
        long expiresMs = parseEpochMillis(draft.expiresAt(), issuedMs + Math.max(0L, draft.ttlSeconds()) * 1000L);
        long updatedMs = resolveUpdatedMillis(draft, issuedMs);
        String resultId = draft.target() == null ? "" : Objects.toString(draft.target().resultId(), "");
        String taskId = draft.target() == null ? null : draft.target().taskId();
        String materialType = draft.target() == null ? null : draft.target().materialType();
        String materialId = draft.target() == null ? null : draft.target().materialId();
        Long confirmedAtMs = parseOptionalEpochMillis(draft.confirmedAt());
        Long discardedAtMs = parseOptionalEpochMillis(draft.discardedAt());

        int updated = jdbc.update(
                "UPDATE workbench_scheme_draft SET result_id=?, task_id=?, material_type=?, material_id=?, "
                        + "status=?, issued_at=?, expires_at=?, batch_group_id=?, sequence_index=?, "
                        + "confirmed_scheme_id=?, confirmed_by=?, confirmed_at=?, discarded_by=?, discarded_at=?, "
                        + "discard_reason=?, updated_at=?, data_json=? WHERE id=?",
                resultId, taskId, materialType, materialId,
                draft.status(), issuedMs, expiresMs, draft.batchGroupId(), draft.batchIndex(),
                draft.confirmedSchemeId(), draft.confirmedBy(), confirmedAtMs, draft.discardedBy(), discardedAtMs,
                draft.discardReason(), updatedMs, payload, draft.draftId()
        );
        if (updated == 0) {
            jdbc.update(
                    "INSERT INTO workbench_scheme_draft(id, result_id, task_id, material_type, material_id, "
                            + "status, issued_at, expires_at, batch_group_id, sequence_index, "
                            + "confirmed_scheme_id, confirmed_by, confirmed_at, discarded_by, discarded_at, "
                            + "discard_reason, updated_at, data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    draft.draftId(), resultId, taskId, materialType, materialId,
                    draft.status(), issuedMs, expiresMs, draft.batchGroupId(), draft.batchIndex(),
                    draft.confirmedSchemeId(), draft.confirmedBy(), confirmedAtMs, draft.discardedBy(), discardedAtMs,
                    draft.discardReason(), updatedMs, payload
            );
        }
        return draft;
    }

    @Override
    public Optional<WorkbenchSchemeDraft> find(String draftId) {
        if (draftId == null || !draftId.matches(VALID_ID_PATTERN)) {
            return Optional.empty();
        }
        List<WorkbenchSchemeDraft> rows = jdbc.query(
                "SELECT data_json FROM workbench_scheme_draft WHERE id=?",
                (rs, idx) -> json.readValue(rs.getString(1), WorkbenchSchemeDraft.class),
                draftId
        );
        return rows.isEmpty() ? Optional.empty() : Optional.ofNullable(rows.get(0));
    }

    @Override
    public List<WorkbenchSchemeDraft> listByTask(String taskId) {
        if (taskId == null || taskId.isBlank()) {
            return List.of();
        }
        return List.copyOf(jdbc.query(
                "SELECT data_json FROM workbench_scheme_draft WHERE task_id=? ORDER BY issued_at DESC, id DESC",
                (rs, idx) -> json.readValue(rs.getString(1), WorkbenchSchemeDraft.class),
                taskId
        ));
    }

    @Override
    public DraftPage query(DraftQuery query, long nowMs) {
        int safePage = query == null ? 0 : Math.max(0, query.page());
        int safeSize = query == null ? 20 : Math.max(1, Math.min(100, query.size()));

        StringBuilder where = new StringBuilder(" WHERE 1=1");
        List<Object> params = new ArrayList<>();

        if (query != null) {
            if (query.taskId() != null && !query.taskId().isBlank()) {
                where.append(" AND task_id=?");
                params.add(query.taskId().trim());
            }
            if (query.batchGroupId() != null && !query.batchGroupId().isBlank()) {
                where.append(" AND batch_group_id=?");
                params.add(query.batchGroupId().trim());
            }
            String st = query.status() == null ? null : query.status().trim().toUpperCase();
            if (st != null && !st.isBlank() && !"ALL".equals(st)) {
                if (WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION.equals(st)) {
                    where.append(" AND status=? AND expires_at >= ?");
                    params.add(WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION);
                    params.add(nowMs);
                } else if (WorkbenchSchemeDraft.STATUS_EXPIRED.equals(st)) {
                    where.append(" AND (status=? OR (status=? AND expires_at < ?))");
                    params.add(WorkbenchSchemeDraft.STATUS_EXPIRED);
                    params.add(WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION);
                    params.add(nowMs);
                } else {
                    where.append(" AND status=?");
                    params.add(st);
                }
            }
        }

        Long totalBox = jdbc.queryForObject(
                "SELECT COUNT(*) FROM workbench_scheme_draft" + where,
                Long.class,
                params.toArray()
        );
        long total = totalBox == null ? 0L : totalBox;

        Long pendingBox = jdbc.queryForObject(
                "SELECT COUNT(*) FROM workbench_scheme_draft WHERE status=? AND expires_at >= ?",
                Long.class,
                WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION,
                nowMs
        );
        long pendingCount = pendingBox == null ? 0L : pendingBox;

        long offsetLong = (long) safePage * safeSize;
        if (offsetLong >= total && total > 0) {
            return new DraftPage(List.of(), total, safePage, safeSize, pendingCount);
        }

        List<Object> dataParams = new ArrayList<>(params);
        dataParams.add(safeSize);
        dataParams.add((int) Math.min(Integer.MAX_VALUE, offsetLong));

        List<WorkbenchSchemeDraft> items = jdbc.query(
                "SELECT data_json FROM workbench_scheme_draft" + where
                        + " ORDER BY issued_at DESC, id DESC LIMIT ? OFFSET ?",
                (rs, idx) -> {
                    WorkbenchSchemeDraft d = json.readValue(rs.getString(1), WorkbenchSchemeDraft.class);
                    return normalizeClockStatus(d, nowMs);
                },
                dataParams.toArray()
        );
        return new DraftPage(List.copyOf(items), total, safePage, safeSize, pendingCount);
    }

    @Override
    public TransitionResult transitionFromPending(
            String draftId,
            long nowMs,
            UnaryOperator<WorkbenchSchemeDraft> updater
    ) {
        if (draftId == null || !draftId.matches(VALID_ID_PATTERN)) {
            return new TransitionResult(TransitionOutcome.NOT_FOUND, null);
        }
        Objects.requireNonNull(updater, "updater");
        return transaction.execute(status -> {
            record RowSnapshot(String dbStatus, long expiresAt, WorkbenchSchemeDraft draft) {}
            List<RowSnapshot> rows = jdbc.query(
                    "SELECT status, expires_at, data_json FROM workbench_scheme_draft WHERE id=?",
                    (rs, idx) -> new RowSnapshot(
                            rs.getString(1),
                            rs.getLong(2),
                            json.readValue(rs.getString(3), WorkbenchSchemeDraft.class)
                    ),
                    draftId
            );
            if (rows.isEmpty()) {
                return new TransitionResult(TransitionOutcome.NOT_FOUND, null);
            }
            RowSnapshot row = rows.get(0);
            WorkbenchSchemeDraft current = row.draft();
            if (!WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION.equals(row.dbStatus())) {
                return new TransitionResult(TransitionOutcome.CONFLICT_STATE, current);
            }
            if (row.expiresAt() < nowMs) {
                WorkbenchSchemeDraft expired = current.withEvaluatedState(
                        WorkbenchSchemeDraft.STATUS_EXPIRED, current.stale(), current.staleReasons()
                );
                return new TransitionResult(TransitionOutcome.EXPIRED, expired);
            }
            WorkbenchSchemeDraft next = updater.apply(current);
            if (next == null) {
                throw new IllegalStateException("草案状态更新器返回 null");
            }
            String payload = json.writeValueAsString(next);
            Long confirmedAtMs = parseOptionalEpochMillis(next.confirmedAt());
            Long discardedAtMs = parseOptionalEpochMillis(next.discardedAt());
            int updated = jdbc.update(
                    "UPDATE workbench_scheme_draft SET status=?, confirmed_scheme_id=?, confirmed_by=?, "
                            + "confirmed_at=?, discarded_by=?, discarded_at=?, discard_reason=?, updated_at=?, "
                            + "data_json=? WHERE id=? AND status=?",
                    next.status(),
                    next.confirmedSchemeId(),
                    next.confirmedBy(),
                    confirmedAtMs,
                    next.discardedBy(),
                    discardedAtMs,
                    next.discardReason(),
                    nowMs,
                    payload,
                    draftId,
                    WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION
            );
            if (updated == 0) {
                WorkbenchSchemeDraft latest = find(draftId).orElse(current);
                return new TransitionResult(TransitionOutcome.CONFLICT_STATE, latest);
            }
            return new TransitionResult(TransitionOutcome.UPDATED, next);
        });
    }

    @Override
    public int expireAndPurge(long nowMs, long purgeBeforeMs) {
        return transaction.execute(status -> {
            record PendingExpiredRow(String id, long expiresAt, WorkbenchSchemeDraft draft) {}
            List<PendingExpiredRow> expiredRows = jdbc.query(
                    "SELECT id, expires_at, data_json FROM workbench_scheme_draft WHERE status=? AND expires_at < ?",
                    (rs, idx) -> new PendingExpiredRow(
                            rs.getString(1),
                            rs.getLong(2),
                            json.readValue(rs.getString(3), WorkbenchSchemeDraft.class)
                    ),
                    WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION,
                    nowMs
            );
            int affected = 0;
            for (PendingExpiredRow row : expiredRows) {
                WorkbenchSchemeDraft expiredDraft = row.draft().withEvaluatedState(
                        WorkbenchSchemeDraft.STATUS_EXPIRED,
                        row.draft().stale(),
                        row.draft().staleReasons()
                );
                String payload = json.writeValueAsString(expiredDraft);
                affected += jdbc.update(
                        "UPDATE workbench_scheme_draft SET status=?, updated_at=?, data_json=? WHERE id=? AND status=?",
                        WorkbenchSchemeDraft.STATUS_EXPIRED,
                        row.expiresAt(),
                        payload,
                        row.id(),
                        WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION
                );
            }
            affected += jdbc.update(
                    "DELETE FROM workbench_scheme_draft WHERE status IN (?,?,?) "
                            + "AND (CASE "
                            + "WHEN status = ? THEN COALESCE(expires_at, updated_at, issued_at) "
                            + "WHEN status = ? THEN COALESCE(confirmed_at, updated_at, expires_at, issued_at) "
                            + "WHEN status = ? THEN COALESCE(discarded_at, updated_at, expires_at, issued_at) "
                            + "ELSE COALESCE(updated_at, expires_at, issued_at) END) < ?",
                    WorkbenchSchemeDraft.STATUS_EXPIRED,
                    WorkbenchSchemeDraft.STATUS_CONFIRMED,
                    WorkbenchSchemeDraft.STATUS_DISCARDED,
                    WorkbenchSchemeDraft.STATUS_EXPIRED,
                    WorkbenchSchemeDraft.STATUS_CONFIRMED,
                    WorkbenchSchemeDraft.STATUS_DISCARDED,
                    purgeBeforeMs
            );
            return affected;
        });
    }

    @Override
    public List<String> listCleanupCandidateIds(long nowMs, long purgeBeforeMs) {
        return List.copyOf(jdbc.queryForList(
                "SELECT id FROM workbench_scheme_draft "
                        + "WHERE (status=? AND expires_at < ?) "
                        + "OR (status IN (?,?,?) AND (CASE "
                        + "WHEN status = ? THEN COALESCE(expires_at, updated_at, issued_at) "
                        + "WHEN status = ? THEN COALESCE(confirmed_at, updated_at, expires_at, issued_at) "
                        + "WHEN status = ? THEN COALESCE(discarded_at, updated_at, expires_at, issued_at) "
                        + "ELSE COALESCE(updated_at, expires_at, issued_at) END) < ?) "
                        + "ORDER BY issued_at ASC, id ASC",
                String.class,
                WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION,
                nowMs,
                WorkbenchSchemeDraft.STATUS_EXPIRED,
                WorkbenchSchemeDraft.STATUS_CONFIRMED,
                WorkbenchSchemeDraft.STATUS_DISCARDED,
                WorkbenchSchemeDraft.STATUS_EXPIRED,
                WorkbenchSchemeDraft.STATUS_CONFIRMED,
                WorkbenchSchemeDraft.STATUS_DISCARDED,
                purgeBeforeMs
        ));
    }

    @Override
    public int expireOrPurgeSingle(String draftId, long nowMs, long purgeBeforeMs) {
        if (draftId == null || !draftId.matches(VALID_ID_PATTERN)) {
            return 0;
        }
        return transaction.execute(status -> {
            record CleanupRow(
                    String status,
                    Long expiresAt,
                    Long updatedAt,
                    Long issuedAt,
                    Long confirmedAt,
                    Long discardedAt,
                    WorkbenchSchemeDraft draft
            ) {}
            List<CleanupRow> rows = jdbc.query(
                    "SELECT status, expires_at, updated_at, issued_at, confirmed_at, discarded_at, data_json "
                            + "FROM workbench_scheme_draft WHERE id=?",
                    (rs, idx) -> new CleanupRow(
                            rs.getString(1),
                            rs.getObject(2) == null ? null : ((Number) rs.getObject(2)).longValue(),
                            rs.getObject(3) == null ? null : ((Number) rs.getObject(3)).longValue(),
                            rs.getObject(4) == null ? null : ((Number) rs.getObject(4)).longValue(),
                            rs.getObject(5) == null ? null : ((Number) rs.getObject(5)).longValue(),
                            rs.getObject(6) == null ? null : ((Number) rs.getObject(6)).longValue(),
                            json.readValue(rs.getString(7), WorkbenchSchemeDraft.class)
                    ),
                    draftId
            );
            if (rows.isEmpty()) {
                return 0;
            }
            CleanupRow row = rows.get(0);
            String effectiveStatus = row.status();
            int affected = 0;
            if (WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION.equals(effectiveStatus)
                    && row.expiresAt() != null
                    && row.expiresAt() < nowMs) {
                WorkbenchSchemeDraft expiredDraft = row.draft().withEvaluatedState(
                        WorkbenchSchemeDraft.STATUS_EXPIRED,
                        row.draft().stale(),
                        row.draft().staleReasons()
                );
                String payload = json.writeValueAsString(expiredDraft);
                int updated = jdbc.update(
                        "UPDATE workbench_scheme_draft SET status=?, updated_at=?, data_json=? WHERE id=? AND status=?",
                        WorkbenchSchemeDraft.STATUS_EXPIRED,
                        row.expiresAt(),
                        payload,
                        draftId,
                        WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION
                );
                if (updated > 0) {
                    affected += updated;
                    effectiveStatus = WorkbenchSchemeDraft.STATUS_EXPIRED;
                }
            }
            if (WorkbenchSchemeDraft.STATUS_EXPIRED.equals(effectiveStatus)
                    || WorkbenchSchemeDraft.STATUS_CONFIRMED.equals(effectiveStatus)
                    || WorkbenchSchemeDraft.STATUS_DISCARDED.equals(effectiveStatus)) {
                Long terminalTs = switch (effectiveStatus) {
                    case WorkbenchSchemeDraft.STATUS_EXPIRED ->
                            firstNonNull(row.expiresAt(), row.updatedAt(), row.issuedAt(), null);
                    case WorkbenchSchemeDraft.STATUS_CONFIRMED ->
                            firstNonNull(row.confirmedAt(), row.updatedAt(), row.expiresAt(), row.issuedAt());
                    case WorkbenchSchemeDraft.STATUS_DISCARDED ->
                            firstNonNull(row.discardedAt(), row.updatedAt(), row.expiresAt(), row.issuedAt());
                    default -> firstNonNull(row.updatedAt(), row.expiresAt(), row.issuedAt(), null);
                };
                if (terminalTs != null && terminalTs < purgeBeforeMs) {
                    affected += jdbc.update(
                            "DELETE FROM workbench_scheme_draft WHERE id=? AND status=?",
                            draftId,
                            effectiveStatus
                    );
                }
            }
            return affected;
        });
    }

    private static Long firstNonNull(Long a, Long b, Long c, Long d) {
        if (a != null) return a;
        if (b != null) return b;
        if (c != null) return c;
        return d;
    }

    private static WorkbenchSchemeDraft normalizeClockStatus(WorkbenchSchemeDraft draft, long nowMs) {
        if (draft == null || draft.isFinalized()) {
            return draft;
        }
        long expiresMs = parseEpochMillis(draft.expiresAt(), Long.MAX_VALUE);
        if (expiresMs < nowMs && !WorkbenchSchemeDraft.STATUS_EXPIRED.equals(draft.status())) {
            return draft.withEvaluatedState(WorkbenchSchemeDraft.STATUS_EXPIRED, draft.stale(), draft.staleReasons());
        }
        return draft;
    }

    private static void validateDraft(WorkbenchSchemeDraft draft) {
        if (draft == null || draft.draftId() == null || !draft.draftId().matches(VALID_ID_PATTERN)) {
            throw new IllegalArgumentException("工作台草案编号无效");
        }
    }

    private static long resolveUpdatedMillis(WorkbenchSchemeDraft draft, long issuedMs) {
        Long confirmed = parseOptionalEpochMillis(draft.confirmedAt());
        if (confirmed != null) return confirmed;
        Long discarded = parseOptionalEpochMillis(draft.discardedAt());
        if (discarded != null) return discarded;
        return issuedMs;
    }

    private static Long parseOptionalEpochMillis(String iso) {
        if (iso == null || iso.isBlank()) {
            return null;
        }
        try {
            return Instant.parse(iso).toEpochMilli();
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private static long parseEpochMillis(String iso, long fallback) {
        if (iso == null || iso.isBlank()) {
            return fallback;
        }
        try {
            return Instant.parse(iso).toEpochMilli();
        } catch (RuntimeException ignored) {
            return fallback;
        }
    }
}
