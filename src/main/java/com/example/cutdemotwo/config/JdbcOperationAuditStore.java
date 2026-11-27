package com.example.cutdemotwo.config;

import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;

/**
 * JDBC 模式全站操作审计存储：严格使用 SQL WHERE + LIMIT/OFFSET 分页，绝不全量载入历史审计记录。
 */
public final class JdbcOperationAuditStore implements OperationAuditStore {
    private final JdbcTemplate jdbc;

    public JdbcOperationAuditStore(DataSource source) {
        Objects.requireNonNull(source, "数据源不能为空");
        this.jdbc = new JdbcTemplate(source);
    }

    @Override
    public void append(AuditRecord record) {
        if (record == null) return;
        jdbc.update(
                "INSERT INTO operation_audit_log(id, occurred_at, actor, actor_type, actor_role, agent_id, action, target_type, target_id, http_method, request_path, outcome, http_status, trace_id, client_ip, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                record.id(),
                record.occurredAt(),
                record.actor(),
                record.actorType(),
                record.actorRole(),
                record.agentId(),
                record.action(),
                record.targetType(),
                record.targetId(),
                record.httpMethod(),
                record.requestPath(),
                record.outcome(),
                record.httpStatus(),
                record.traceId(),
                record.clientIp(),
                record.detailJson()
        );
    }

    @Override
    public AuditPage query(AuditQuery query) {
        int page = Math.max(0, query.page());
        int size = Math.min(200, Math.max(1, query.size()));

        StringBuilder where = new StringBuilder(" WHERE 1=1");
        List<Object> args = new ArrayList<>();
        if (hasText(query.actor())) {
            where.append(" AND actor = ?");
            args.add(query.actor().trim());
        }
        if (hasText(query.actorType())) {
            where.append(" AND actor_type = ?");
            args.add(query.actorType().trim().toUpperCase(Locale.ROOT));
        }
        if (hasText(query.action())) {
            where.append(" AND action = ?");
            args.add(query.action().trim().toUpperCase(Locale.ROOT));
        }
        if (hasText(query.targetType())) {
            where.append(" AND target_type = ?");
            args.add(query.targetType().trim().toUpperCase(Locale.ROOT));
        }
        if (hasText(query.targetId())) {
            where.append(" AND target_id = ?");
            args.add(query.targetId().trim());
        }
        if (hasText(query.outcome())) {
            where.append(" AND outcome = ?");
            args.add(query.outcome().trim().toUpperCase(Locale.ROOT));
        }
        if (query.from() != null) {
            where.append(" AND occurred_at >= ?");
            args.add(query.from());
        }
        if (query.to() != null) {
            where.append(" AND occurred_at <= ?");
            args.add(query.to());
        }

        Long total = jdbc.queryForObject("SELECT COUNT(*) FROM operation_audit_log" + where, Long.class, args.toArray());
        long totalCount = total == null ? 0L : total;

        List<Object> pageArgs = new ArrayList<>(args);
        pageArgs.add(size);
        pageArgs.add((long) page * size);

        List<AuditRecord> items = jdbc.query(
                "SELECT id, occurred_at, actor, actor_type, actor_role, agent_id, action, target_type, target_id, http_method, request_path, outcome, http_status, trace_id, client_ip, detail_json FROM operation_audit_log"
                        + where + " ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?",
                (rs, idx) -> mapRecord(rs),
                pageArgs.toArray()
        );
        return new AuditPage(items, totalCount, page, size);
    }

    private static AuditRecord mapRecord(ResultSet rs) throws SQLException {
        return new AuditRecord(
                rs.getString("id"),
                rs.getLong("occurred_at"),
                rs.getString("actor"),
                rs.getString("actor_type"),
                rs.getString("actor_role"),
                rs.getString("agent_id"),
                rs.getString("action"),
                rs.getString("target_type"),
                rs.getString("target_id"),
                rs.getString("http_method"),
                rs.getString("request_path"),
                rs.getString("outcome"),
                rs.getObject("http_status") == null ? null : rs.getInt("http_status"),
                rs.getString("trace_id"),
                rs.getString("client_ip"),
                rs.getString("detail_json")
        );
    }

    private static boolean hasText(String value) {
        return value != null && !value.isBlank();
    }
}
