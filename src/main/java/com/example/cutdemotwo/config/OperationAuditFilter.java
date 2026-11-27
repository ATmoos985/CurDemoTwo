package com.example.cutdemotwo.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.ContentCachingResponseWrapper;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 全站业务写操作无侵入审计过滤器：
 * <ul>
 *   <li>仅包裹受审计的写请求（绝不包裹 GET / HEAD / 静态资源 / SSE 流）；</li>
 *   <li>在下游业务锁与事务完全提交/返回后记录审计条目，不干涉任何业务事务或锁顺序；</li>
 *   <li>认证与账号/Agent 管理端点由对应 Controller 显式记录高精度审计，避免重复。</li>
 * </ul>
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 15)
public class OperationAuditFilter extends OncePerRequestFilter {
    private static final Set<String> WRITE_METHODS = Set.of("POST", "PUT", "PATCH", "DELETE");
    private static final int MAX_RESPONSE_SNIPPET_BYTES = 32 * 1024;
    private static final JsonMapper JSON = JsonMapper.builder().build();

    private static final Pattern P_TEMPLATE_DEL = Pattern.compile("^/api/v2/demand-templates/([^/]+)$");
    private static final Pattern P_DRAFT_CONFIRM = Pattern.compile("^/api/v2/workbench/drafts/([^/]+)/confirm$");
    private static final Pattern P_DRAFT_DISCARD = Pattern.compile("^/api/v2/workbench/drafts/([^/]+)/discard$");
    private static final Pattern P_SCHEME_ACTION = Pattern.compile("^/api/v2/schemes/([^/]+)/(bind-roll|complete|cancel|replenish-task)$");
    private static final Pattern P_PLAN_ACTION = Pattern.compile("^/api/cutting/plans/([^/]+)/(cancel|restore|adjust)$");
    private static final Pattern P_EXEC_ACTION = Pattern.compile("^/api/v2/execution-orders/([^/]+)/(release|start|cancel|reports)$");
    private static final Pattern P_REPORT_REVERSE = Pattern.compile("^/api/cutting/reports/([^/]+)/reverse$");
    private static final Pattern P_QUALITY_RELEASE = Pattern.compile("^/api/v2/quality/remnants/([^/]+)/release$");
    private static final Pattern P_QUALITY_ROLL = Pattern.compile("^/api/v2/quality/rolls/([^/]+)/inspect-complete$");
    private static final Pattern P_ROLL_DEFECT = Pattern.compile("^/api/rolls/([^/]+)/(?:defects|inspection-defects)$");
    private static final Pattern P_ROLL_DEFECT_VOID = Pattern.compile("^/api/rolls/([^/]+)/defects/([^/]+)/void$");
    private static final Pattern P_QUALITY_DISP = Pattern.compile("^/api/cutting/reports/([^/]+)/quality-dispositions$");
    private static final Pattern P_QUALITY_DISP_REVOKE = Pattern.compile("^/api/cutting/reports/([^/]+)/dispositions/([^/]+)/revoke$");
    private static final Pattern P_ROLL_SCRAP = Pattern.compile("^/api/v2/rolls/([^/]+)/scrap$");
    private static final Pattern P_REMNANT_SCRAP = Pattern.compile("^/api/remnants/([^/]+)/scrap$");
    private static final Pattern P_ROLL_RESET = Pattern.compile("^/api/rolls/([^/]+)/reset$");
    private static final Pattern P_MES_DISPATCH = Pattern.compile("^/api/v2/mes/schemes/([^/]+)/dispatch$");

    private record AuditTargetSpec(String action, String targetType, String pathTargetId) {}

    private final OperationAuditService auditService;

    public OperationAuditFilter(OperationAuditService auditService) {
        this.auditService = auditService;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String method = request.getMethod() == null ? "GET" : request.getMethod().toUpperCase(Locale.ROOT);
        if (!WRITE_METHODS.contains(method)) {
            return true;
        }
        var normalized = AuthSecurityFilter.tryNormalizePath(request);
        if (normalized.isEmpty()) {
            return true;
        }
        String path = normalized.get();
        if ("/api/cutting/report-batch".equals(path) && "true".equalsIgnoreCase(request.getParameter("preview"))) {
            return true;
        }
        return resolveSpec(method, path) == null;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String method = request.getMethod() == null ? "POST" : request.getMethod().toUpperCase(Locale.ROOT);
        var normalized = AuthSecurityFilter.tryNormalizePath(request);
        if (normalized.isEmpty()) {
            filterChain.doFilter(request, response);
            return;
        }
        String path = normalized.get();
        AuditTargetSpec spec = resolveSpec(method, path);
        if (spec == null) {
            filterChain.doFilter(request, response);
            return;
        }

        ContentCachingResponseWrapper wrapped = new ContentCachingResponseWrapper(response);
        int status = 500;
        try {
            filterChain.doFilter(request, wrapped);
            status = wrapped.getStatus();
        } finally {
            byte[] bodyBytes = wrapped.getContentAsByteArray();
            String targetId = resolveTargetId(spec, bodyBytes);
            String outcome = (status >= 200 && status < 400) ? "SUCCESS" : "FAILED";
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("status", status);
            if (targetId != null) {
                detail.put("targetId", targetId);
            }
            auditService.record(
                    AuthContext.current(),
                    spec.action(),
                    spec.targetType(),
                    targetId,
                    method,
                    path,
                    outcome,
                    status,
                    request.getRemoteAddr(),
                    detail
            );
            wrapped.copyBodyToResponse();
        }
    }

    private static AuditTargetSpec resolveSpec(String method, String path) {
        if ("DELETE".equals(method)) {
            Matcher m = P_TEMPLATE_DEL.matcher(path);
            if (m.matches()) {
                return new AuditTargetSpec("DEMAND_TEMPLATE_DELETE", "DEMAND_TEMPLATE", m.group(1));
            }
            return null;
        }
        if (!"POST".equals(method) && !"PUT".equals(method) && !"PATCH".equals(method)) {
            return null;
        }
        return switch (path) {
            case "/api/v2/demand-templates" -> new AuditTargetSpec("DEMAND_TEMPLATE_SAVE", "DEMAND_TEMPLATE", null);
            case "/api/v2/demand-pool" -> new AuditTargetSpec("DEMAND_POOL_SAVE", "DEMAND_TASK", null);
            case "/api/cutting/tasks" -> new AuditTargetSpec("TASK_SAVE", "DEMAND_TASK", null);
            case "/api/v2/workbench/drafts" -> new AuditTargetSpec("DRAFT_CREATE", "WORKBENCH_DRAFT", null);
            case "/api/v2/workbench/multi-material-drafts" -> new AuditTargetSpec("DRAFT_BATCH_CREATE", "WORKBENCH_DRAFT_BATCH", null);
            case "/api/v2/schemes/confirm" -> new AuditTargetSpec("SCHEME_CONFIRM", "SCHEDULING_SCHEME", null);
            case "/api/v2/execution-orders" -> new AuditTargetSpec("EXECUTION_ORDER_CREATE", "EXECUTION_ORDER", null);
            case "/api/cutting/report-confirm" -> new AuditTargetSpec("CUT_REPORT_CONFIRM", "CUT_REPORT", null);
            case "/api/cutting/report-batch" -> new AuditTargetSpec("CUT_REPORT_BATCH", "CUT_REPORT", null);
            case "/api/v2/mes/orders" -> new AuditTargetSpec("MES_ORDER_SYNC", "MES_ORDER", null);
            case "/api/v2/mes/execution-feedback" -> new AuditTargetSpec("MES_FEEDBACK", "EXECUTION_ORDER", null);
            case "/api/inspection/rolls" -> new AuditTargetSpec("INSPECTION_ROLL_CREATE", "MOTHER_ROLL", null);
            case "/api/v2/inventory-receipts" -> new AuditTargetSpec("INVENTORY_RECEIPT", "INVENTORY_RECEIPT", null);
            case "/api/v2/material-issues" -> new AuditTargetSpec("MATERIAL_ISSUE", "MATERIAL_ISSUE", null);
            case "/api/v2/inventory-transfers" -> new AuditTargetSpec("INVENTORY_TRANSFER", "INVENTORY_TRANSFER", null);
            case "/api/v2/inventory-counts" -> new AuditTargetSpec("INVENTORY_COUNT", "INVENTORY_COUNT", null);
            case "/api/rolls" -> new AuditTargetSpec("ROLL_SAVE", "MOTHER_ROLL", null);
            case "/api/remnants/register" -> new AuditTargetSpec("REMNANT_REGISTER", "REMNANT", null);
            case "/api/demo/inventory" -> new AuditTargetSpec("SYSTEM_DEMO_INIT", "SYSTEM", "DEMO_INVENTORY");
            default -> matchPatternSpec(path);
        };
    }

    private static AuditTargetSpec matchPatternSpec(String path) {
        Matcher m;
        if ((m = P_DRAFT_CONFIRM.matcher(path)).matches()) {
            return new AuditTargetSpec("DRAFT_CONFIRM", "WORKBENCH_DRAFT", m.group(1));
        }
        if ((m = P_DRAFT_DISCARD.matcher(path)).matches()) {
            return new AuditTargetSpec("DRAFT_DISCARD", "WORKBENCH_DRAFT", m.group(1));
        }
        if ((m = P_SCHEME_ACTION.matcher(path)).matches()) {
            String op = m.group(2);
            return switch (op) {
                case "bind-roll" -> new AuditTargetSpec("SCHEME_BIND_ROLL", "SCHEDULING_SCHEME", m.group(1));
                case "complete" -> new AuditTargetSpec("SCHEME_COMPLETE", "SCHEDULING_SCHEME", m.group(1));
                case "cancel" -> new AuditTargetSpec("SCHEME_CANCEL", "SCHEDULING_SCHEME", m.group(1));
                case "replenish-task" -> new AuditTargetSpec("SCHEME_REPLENISH_TASK", "DEMAND_TASK", m.group(1));
                default -> null;
            };
        }
        if ((m = P_PLAN_ACTION.matcher(path)).matches()) {
            String op = m.group(2).toUpperCase(Locale.ROOT);
            return new AuditTargetSpec("PLAN_" + op, "CUTTING_PLAN", m.group(1));
        }
        if ((m = P_EXEC_ACTION.matcher(path)).matches()) {
            String op = m.group(2).toUpperCase(Locale.ROOT);
            return new AuditTargetSpec("EXECUTION_" + op, "EXECUTION_ORDER", m.group(1));
        }
        if ((m = P_REPORT_REVERSE.matcher(path)).matches()) {
            return new AuditTargetSpec("CUT_REPORT_REVERSE", "CUT_REPORT", m.group(1));
        }
        if ((m = P_QUALITY_RELEASE.matcher(path)).matches()) {
            return new AuditTargetSpec("QUALITY_REMNANT_RELEASE", "REMNANT", m.group(1));
        }
        if ((m = P_QUALITY_ROLL.matcher(path)).matches()) {
            return new AuditTargetSpec("QUALITY_ROLL_INSPECT_COMPLETE", "MOTHER_ROLL", m.group(1));
        }
        if ((m = P_ROLL_DEFECT.matcher(path)).matches()) {
            return new AuditTargetSpec("ROLL_DEFECT_ADD", "MOTHER_ROLL", m.group(1));
        }
        if ((m = P_ROLL_DEFECT_VOID.matcher(path)).matches()) {
            return new AuditTargetSpec("ROLL_DEFECT_VOID", "MOTHER_ROLL", m.group(1));
        }
        if ((m = P_QUALITY_DISP.matcher(path)).matches()) {
            return new AuditTargetSpec("QUALITY_DISPOSITION_CREATE", "CUT_REPORT", m.group(1));
        }
        if ((m = P_QUALITY_DISP_REVOKE.matcher(path)).matches()) {
            return new AuditTargetSpec("QUALITY_DISPOSITION_REVOKE", "CUT_REPORT", m.group(1));
        }
        if ((m = P_ROLL_SCRAP.matcher(path)).matches()) {
            return new AuditTargetSpec("ROLL_SCRAP", "MOTHER_ROLL", m.group(1));
        }
        if ((m = P_REMNANT_SCRAP.matcher(path)).matches()) {
            return new AuditTargetSpec("REMNANT_SCRAP", "REMNANT", m.group(1));
        }
        if ((m = P_ROLL_RESET.matcher(path)).matches()) {
            return new AuditTargetSpec("ROLL_RESET", "MOTHER_ROLL", m.group(1));
        }
        if ((m = P_MES_DISPATCH.matcher(path)).matches()) {
            return new AuditTargetSpec("MES_DISPATCH", "SCHEDULING_SCHEME", m.group(1));
        }
        return null;
    }

    private static String resolveTargetId(AuditTargetSpec spec, byte[] bodyBytes) {
        if (bodyBytes != null && bodyBytes.length > 0 && bodyBytes.length <= MAX_RESPONSE_SNIPPET_BYTES) {
            try {
                String text = new String(bodyBytes, StandardCharsets.UTF_8).trim();
                if (text.startsWith("{")) {
                    JsonNode root = JSON.readTree(text);
                    String extracted = switch (spec.action()) {
                        case "SCHEME_CONFIRM" -> firstNonBlank(root.path("scheme").path("id").asString(""), root.path("id").asString(""));
                        case "SCHEME_REPLENISH_TASK" -> firstNonBlank(root.path("task").path("id").asString(""), root.path("id").asString(""));
                        case "CUT_REPORT_CONFIRM" -> firstNonBlank(root.path("report").path("planId").asString(""), root.path("planId").asString(""));
                        case "INVENTORY_RECEIPT", "MATERIAL_ISSUE" -> firstNonBlank(root.path("document").path("id").asString(""), root.path("id").asString(""));
                        case "DRAFT_CREATE" -> firstNonBlank(root.path("draftId").asString(""), root.path("id").asString(""));
                        case "DRAFT_BATCH_CREATE" -> firstNonBlank(root.path("batchGroupId").asString(""), root.path("id").asString(""));
                        case "ROLL_SAVE", "INSPECTION_ROLL_CREATE" -> firstNonBlank(root.path("rollId").asString(""), root.path("id").asString(""));
                        default -> firstNonBlank(root.path("id").asString(""), root.path("rollId").asString(""));
                    };
                    if (extracted != null) {
                        return extracted;
                    }
                }
            } catch (RuntimeException ignored) {
                // 忽略非 JSON 响应提取异常
            }
        }
        return spec.pathTargetId();
    }

    private static String firstNonBlank(String a, String b) {
        if (a != null && !a.isBlank()) return a.trim();
        if (b != null && !b.isBlank()) return b.trim();
        return null;
    }
}
