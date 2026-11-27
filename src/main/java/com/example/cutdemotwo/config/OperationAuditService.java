package com.example.cutdemotwo.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;

import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * 全站操作审计服务：负责脱敏记录安全与业务关键写操作，并委托 {@link OperationAuditStore} 执行只读分页检索。
 * 审计写失败仅告警记录，绝不阻塞或回滚业务主事务。
 */
@Service
public class OperationAuditService {
    private static final Logger log = LoggerFactory.getLogger(OperationAuditService.class);
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final Set<String> SENSITIVE_KEYS = Set.of(
            "password", "currentpassword", "newpassword", "token", "secret", "authorization", "passwordhash"
    );

    private final OperationAuditStore store;
    private final Clock clock;

    @Autowired
    public OperationAuditService(OperationAuditStore store) {
        this(store, Clock.systemUTC());
    }

    public OperationAuditService(OperationAuditStore store, Clock clock) {
        this.store = store == null ? new InMemoryOperationAuditStore() : store;
        this.clock = clock == null ? Clock.systemUTC() : clock;
    }

    public void record(
            AuthContext.Principal principal,
            String action,
            String targetType,
            String targetId,
            String httpMethod,
            String requestPath,
            String outcome,
            Integer httpStatus,
            String clientIp,
            Map<String, Object> detail
    ) {
        AuthContext.Principal effective = principal != null ? principal : AuthContext.LOCAL_PRINCIPAL;
        recordRaw(
                effective.username(),
                effective.actorType(),
                effective.role(),
                effective.agentId(),
                action,
                targetType,
                targetId,
                httpMethod,
                requestPath,
                outcome,
                httpStatus,
                clientIp,
                detail
        );
    }

    public void recordRaw(
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
            String clientIp,
            Map<String, Object> detail
    ) {
        try {
            String safeActor = hasText(actor) ? actor.trim() : "ANONYMOUS";
            String safeActorType = hasText(actorType) ? actorType.trim().toUpperCase(Locale.ROOT) : AuthContext.ACTOR_USER;
            String safeAction = hasText(action) ? action.trim().toUpperCase(Locale.ROOT) : "UNKNOWN";
            String safeOutcome = hasText(outcome) ? outcome.trim().toUpperCase(Locale.ROOT) : "SUCCESS";
            String traceId = MDC.get(TraceIdFilter.MDC_KEY);
            String detailJson = serializeSanitizedDetail(detail);

            store.append(new OperationAuditStore.AuditRecord(
                    "AUD-" + UUID.randomUUID().toString().replace("-", ""),
                    clock.millis(),
                    safeActor,
                    safeActorType,
                    actorRole,
                    agentId,
                    safeAction,
                    targetType,
                    truncate(targetId, 128),
                    httpMethod,
                    truncate(requestPath, 256),
                    safeOutcome,
                    httpStatus,
                    truncate(traceId, 64),
                    truncate(clientIp, 64),
                    detailJson
            ));
        } catch (RuntimeException error) {
            log.warn("全站操作审计落库失败（不影响业务主链路）: action={}, targetType={}, targetId={}",
                    action, targetType, targetId, error);
        }
    }

    public OperationAuditStore.AuditPage query(OperationAuditStore.AuditQuery query) {
        return store.query(query);
    }

    private static String serializeSanitizedDetail(Map<String, Object> detail) {
        if (detail == null || detail.isEmpty()) {
            return null;
        }
        Map<String, Object> sanitized = sanitizeMap(detail);
        if (sanitized.isEmpty()) {
            return null;
        }
        String json = JSON.writeValueAsString(sanitized);
        return json.length() > 8192 ? json.substring(0, 8192) : json;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> sanitizeMap(Map<String, Object> input) {
        Map<String, Object> clean = new LinkedHashMap<>();
        for (var entry : input.entrySet()) {
            String key = entry.getKey();
            if (key == null) continue;
            if (SENSITIVE_KEYS.contains(key.toLowerCase(Locale.ROOT))) {
                clean.put(key, "***");
                continue;
            }
            Object val = entry.getValue();
            if (val instanceof Map<?, ?> nested) {
                clean.put(key, sanitizeMap((Map<String, Object>) nested));
            } else {
                clean.put(key, val);
            }
        }
        return clean;
    }

    private static boolean hasText(String value) {
        return value != null && !value.isBlank();
    }

    private static String truncate(String value, int maxLen) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.length() <= maxLen ? trimmed : trimmed.substring(0, maxLen);
    }
}
