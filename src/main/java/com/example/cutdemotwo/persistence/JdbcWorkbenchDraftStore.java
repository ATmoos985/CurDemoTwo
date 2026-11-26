package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.contracts.jobs.WorkbenchSchemeDraft;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

import javax.sql.DataSource;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

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
        if (draft == null || draft.draftId() == null || !draft.draftId().matches(VALID_ID_PATTERN)) {
            throw new IllegalArgumentException("工作台草案编号无效");
        }
        String payload = json.writeValueAsString(draft);
        long issuedMs = parseEpochMillis(draft.issuedAt(), System.currentTimeMillis());
        long expiresMs = parseEpochMillis(draft.expiresAt(), issuedMs + Math.max(0L, draft.ttlSeconds()) * 1000L);
        String resultId = draft.target() == null ? "" : Objects.toString(draft.target().resultId(), "");
        String taskId = draft.target() == null ? null : draft.target().taskId();
        String materialType = draft.target() == null ? null : draft.target().materialType();
        String materialId = draft.target() == null ? null : draft.target().materialId();

        return transaction.execute(status -> {
            int updated = jdbc.update(
                    "UPDATE workbench_scheme_draft SET result_id=?, task_id=?, material_type=?, material_id=?, "
                            + "status=?, issued_at=?, expires_at=?, data_json=? WHERE id=?",
                    resultId, taskId, materialType, materialId, draft.status(), issuedMs, expiresMs, payload, draft.draftId()
            );
            if (updated == 0) {
                jdbc.update(
                        "INSERT INTO workbench_scheme_draft(id, result_id, task_id, material_type, material_id, "
                                + "status, issued_at, expires_at, data_json) VALUES (?,?,?,?,?,?,?,?,?)",
                        draft.draftId(), resultId, taskId, materialType, materialId, draft.status(), issuedMs, expiresMs, payload
                );
            }
            return draft;
        });
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
