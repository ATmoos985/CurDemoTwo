package com.example.cutdemotwo.config;

import java.util.List;

/**
 * 全站操作审计日志存储接口（支持 JDBC SQL 分页、File JSONL 与内存三种实现）。
 */
public interface OperationAuditStore {

    record AuditRecord(
            String id,
            long occurredAt,
            String actor,
            String actorType,
            String actorRole,
            String agentId,
            String action,
            String targetType,
            String targetId,
            String httpMethod,
            String requestPath,
            String outcome,
            Integer httpStatus,
            String traceId,
            String clientIp,
            String detailJson
    ) {}

    record AuditQuery(
            String actor,
            String actorType,
            String action,
            String targetType,
            String targetId,
            String outcome,
            Long from,
            Long to,
            int page,
            int size
    ) {}

    record AuditPage(
            List<AuditRecord> items,
            long total,
            int page,
            int size
    ) {}

    void append(AuditRecord record);

    AuditPage query(AuditQuery query);
}
