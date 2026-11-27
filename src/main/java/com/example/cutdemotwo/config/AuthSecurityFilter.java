package com.example.cutdemotwo.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.json.JsonMapper;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 企业级安全网关过滤器：
 * <ol>
 *   <li>全局请求体字节上限保护（默认 2MB，超限返回 413）；</li>
 *   <li>支持 USER（5 角色 RBAC + 管理员专属用户/Agent/审计端点）与 AI AGENT（作用域严格隔离 + 禁确认/落库/仓储/质检）双主体鉴权；</li>
 *   <li>已认证主体越权（403）同步写入持久化操作审计；</li>
 *   <li>写入 {@link AuthContext} 并在 {@code finally} 中严格清理。</li>
 * </ol>
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class AuthSecurityFilter extends OncePerRequestFilter {
    public static final long DEFAULT_MAX_REQUEST_BODY_BYTES = 2_097_152L;
    public static final int DEFAULT_WRITE_RATE_LIMIT_PER_MINUTE = 600;

    private static final int MAX_RATE_KEYS = 4096;
    private static final Set<String> WRITE_METHODS = Set.of("POST", "PUT", "PATCH", "DELETE");
    private static final List<String> STATIC_SUFFIXES = List.of(
            ".html", ".js", ".mjs", ".css", ".svg", ".png", ".jpg", ".jpeg",
            ".gif", ".ico", ".webp", ".woff", ".woff2", ".ttf", ".json", ".map"
    );
    private static final JsonMapper JSON = JsonMapper.builder().build();

    private final AuthService authService;
    private final OperationAuditService auditService;
    private final long maxRequestBodyBytes;
    private final int writeRateLimitPerMinute;
    private final Clock clock;
    private final ConcurrentHashMap<String, RateWindow> writeRateWindows = new ConcurrentHashMap<>();

    @Autowired
    public AuthSecurityFilter(
            AuthService authService,
            @Value("${cutdemo.security.max-request-body-bytes:2097152}") long maxRequestBodyBytes,
            @Value("${cutdemo.security.write-rate-limit-per-minute:600}") int writeRateLimitPerMinute,
            OperationAuditService auditService
    ) {
        this(authService, maxRequestBodyBytes, writeRateLimitPerMinute, Clock.systemUTC(), auditService);
    }

    public AuthSecurityFilter(AuthService authService, long maxRequestBodyBytes, int writeRateLimitPerMinute, Clock clock) {
        this(authService, maxRequestBodyBytes, writeRateLimitPerMinute, clock, null);
    }

    public AuthSecurityFilter(
            AuthService authService,
            long maxRequestBodyBytes,
            int writeRateLimitPerMinute,
            Clock clock,
            OperationAuditService auditService
    ) {
        this.authService = authService;
        this.auditService = auditService;
        this.maxRequestBodyBytes = maxRequestBodyBytes > 0 ? maxRequestBodyBytes : DEFAULT_MAX_REQUEST_BODY_BYTES;
        this.writeRateLimitPerMinute = writeRateLimitPerMinute;
        this.clock = clock == null ? Clock.systemUTC() : clock;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String method = request.getMethod() == null ? "GET" : request.getMethod().toUpperCase(Locale.ROOT);
        Optional<String> normalizedPath = tryNormalizePath(request);
        if (normalizedPath.isEmpty()) {
            writeError(response, 400, "INVALID_REQUEST_PATH", "非法的请求路径编码", false);
            return;
        }
        String path = normalizedPath.get();
        boolean writeRequest = WRITE_METHODS.contains(method);

        if (writeRequest && request.getContentLengthLong() > maxRequestBodyBytes) {
            writeError(response, 413, "PAYLOAD_TOO_LARGE",
                    "请求正文超过服务端限制（最大 " + maxRequestBodyBytes + " 字节）", false);
            return;
        }

        AuthContext.Principal principal;
        if (!authService.isEnabled()) {
            principal = AuthContext.LOCAL_PRINCIPAL;
        } else if (isWhitelisted(method, path)) {
            principal = authService.verifyAuthorizationHeader(request.getHeader("Authorization")).orElse(null);
        } else {
            Optional<AuthContext.Principal> verified = authService.verifyAuthorizationHeader(request.getHeader("Authorization"));
            if (verified.isEmpty()) {
                response.setHeader("WWW-Authenticate", "Bearer realm=\"cutdemo\"");
                writeError(response, 401, "UNAUTHORIZED", "未登录或访问令牌已失效，请先登录", false);
                return;
            }
            principal = verified.get();
            if (!isAuthorized(principal, method, path)) {
                if (auditService != null) {
                    auditService.record(
                            principal,
                            "ACCESS_DENIED",
                            "ENDPOINT",
                            path,
                            method,
                            path,
                            "DENIED",
                            403,
                            request.getRemoteAddr(),
                            Map.of("reason", principal.isAgent() ? "AGENT_SCOPE_FORBIDDEN" : "ROLE_FORBIDDEN")
                    );
                }
                String subjectLabel = principal.isAgent()
                        ? "Agent(" + principal.agentId() + ")"
                        : "角色 " + principal.role();
                writeError(response, 403, "FORBIDDEN",
                        subjectLabel + " 无权执行该操作：" + method + " " + path, false);
                return;
            }
        }

        if (writeRequest && writeRateLimitPerMinute > 0 && path.startsWith("/api/")
                && !"/api/health".equals(path) && !"/api/v2/health".equals(path)) {
            String rateKey = (principal != null && principal.authenticated())
                    ? "user:" + principal.username()
                    : "ip:" + (request.getRemoteAddr() == null ? "unknown" : request.getRemoteAddr());
            if (!tryAcquireWritePermit(rateKey)) {
                response.setHeader("Retry-After", "10");
                writeError(response, 429, "RATE_LIMIT_EXCEEDED", "写操作请求过于频繁，请稍后重试", true);
                return;
            }
        }

        HttpServletRequest downstreamRequest = writeRequest
                ? new BoundedBodyRequestWrapper(request, maxRequestBodyBytes)
                : request;

        AuthContext.set(principal);
        try {
            filterChain.doFilter(downstreamRequest, response);
        } catch (Throwable error) {
            if (containsPayloadTooLarge(error) && !response.isCommitted()) {
                writeError(response, 413, "PAYLOAD_TOO_LARGE",
                        "请求正文超过服务端限制（最大 " + maxRequestBodyBytes + " 字节）", false);
                return;
            }
            if (error instanceof ServletException se) throw se;
            if (error instanceof IOException ioe) throw ioe;
            if (error instanceof RuntimeException re) throw re;
            throw new ServletException(error);
        } finally {
            AuthContext.clear();
        }
    }

    static boolean isWhitelisted(String method, String path) {
        if ("OPTIONS".equals(method)) {
            return true;
        }
        if ("/".equals(path) || "/app".equals(path) || path.startsWith("/app/")) {
            return true;
        }
        if ("/api/health".equals(path)
                || "/api/v2/health".equals(path)
                || "/actuator/health".equals(path)
                || path.startsWith("/actuator/health/")) {
            return true;
        }
        if ("/api/v2/auth/login".equals(path) || "/api/v2/auth/me".equals(path)) {
            return true;
        }
        if ("/api/v2/integration-deliveries".equals(path) || path.startsWith("/api/v2/integration-deliveries/")) {
            return true;
        }
        if (path.startsWith("/api/v2/mes/")) {
            return true;
        }
        if (path.startsWith("/api-v2/")) {
            return true;
        }
        if (!path.startsWith("/api/") && !path.startsWith("/actuator/")) {
            String lower = path.toLowerCase(Locale.ROOT);
            for (String suffix : STATIC_SUFFIXES) {
                if (lower.endsWith(suffix)) {
                    return true;
                }
            }
        }
        return false;
    }

    static boolean isAuthorized(String role, String method, String path) {
        return isAuthorized(new AuthContext.Principal("test", "test", role, List.of(role), true), method, path);
    }

    static boolean isAuthorized(AuthContext.Principal principal, String method, String path) {
        if (principal == null) {
            return false;
        }
        if (principal.isAgent()) {
            return isAgentAuthorized(principal.scopes(), method, path);
        }
        String role = principal.role();
        if (AuthContext.ROLE_ADMIN.equals(role)) {
            return true;
        }
        if (path.toLowerCase(Locale.ROOT).startsWith("/actuator/")) {
            return false;
        }
        if (isAdminOnlySecurityPath(path)) {
            return false;
        }
        if (("/api/v2/auth/logout".equals(path) && "POST".equals(method))
                || ("/api/v2/auth/password".equals(path) && "PUT".equals(method))) {
            return AuthContext.ALL_ROLES.contains(role);
        }
        if ("GET".equals(method) || "HEAD".equals(method)) {
            return true;
        }

        if (path.startsWith("/api/v2/demo/") || path.matches("^/api/v2/rolls/[^/]+/reset$")) {
            return false;
        }

        if ("POST".equals(method) && "/api/v2/exports/batch-zip".equals(path)) {
            return AuthContext.ALL_ROLES.contains(role);
        }

        if (path.startsWith("/api/v2/quality/")
                || path.startsWith("/api/v2/inspection/")
                || "/api/v2/inventory/import/defects".equals(path)
                || "/api/v2/inventory/import/defects/preview".equals(path)
                || path.matches("^/api/v2/rolls/[^/]+/defects/[^/]+/void$")
                || path.matches("^/api/v2/rolls/[^/]+/inspection-defects$")
                || path.matches("^/api/v2/cutting/reports/[^/]+/quality-dispositions$")
                || path.matches("^/api/v2/cutting/reports/[^/]+/dispositions/[^/]+/revoke$")) {
            return AuthContext.ROLE_INSPECTOR.equals(role);
        }

        if (path.equals("/api/v2/inventory-receipts") || path.startsWith("/api/v2/inventory-receipts/")
                || path.equals("/api/v2/material-issues") || path.startsWith("/api/v2/material-issues/")
                || path.equals("/api/v2/inventory-transfers") || path.startsWith("/api/v2/inventory-transfers/")
                || path.equals("/api/v2/inventory-counts") || path.startsWith("/api/v2/inventory-counts/")
                || path.equals("/api/v2/inventory/import/rolls") || path.equals("/api/v2/inventory/import/rolls/preview")
                || path.equals("/api/v2/inventory/import/remnants") || path.equals("/api/v2/inventory/import/remnants/preview")
                || path.matches("^/api/v2/rolls/[^/]+/scrap$")
                || path.equals("/api/v2/rolls")
                || path.equals("/api/v2/remnants/register")
                || path.matches("^/api/v2/remnants/[^/]+/scrap$")) {
            return AuthContext.ROLE_WAREHOUSE.equals(role);
        }

        if (path.equals("/api/v2/execution-orders") || path.startsWith("/api/v2/execution-orders/")
                || path.matches("^/api/v2/schemes/[^/]+/complete$")
                || path.equals("/api/v2/cutting/report-confirm")) {
            return AuthContext.ROLE_OPERATOR.equals(role) || AuthContext.ROLE_PLANNER.equals(role);
        }

        if (path.equals("/api/v2/demand-templates") || path.startsWith("/api/v2/demand-templates/")
                || path.equals("/api/v2/demand-pool") || path.startsWith("/api/v2/demand-pool/")
                || path.equals("/api/v2/planning") || path.startsWith("/api/v2/planning/")
                || path.equals("/api/v2/workbench") || path.startsWith("/api/v2/workbench/")
                || path.startsWith("/api/v2/schemes/")
                || path.equals("/api/v2/problem-validations")
                || path.equals("/api/v2/optimization-jobs") || path.startsWith("/api/v2/optimization-jobs/")
                || path.equals("/api/v2/nesting/solve")
                || path.equals("/api/v2/cutting/tasks")
                || path.matches("^/api/v2/cutting/reports/[^/]+/reverse$")
                || path.equals("/api/v2/cutting/remnant-recommendations")) {
            return AuthContext.ROLE_PLANNER.equals(role);
        }

        return false;
    }

    private static boolean isAdminOnlySecurityPath(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        return lower.equals("/api/v2/users") || lower.startsWith("/api/v2/users/")
                || lower.equals("/api/v2/agents") || lower.startsWith("/api/v2/agents/")
                || lower.equals("/api/v2/audit-logs") || lower.startsWith("/api/v2/audit-logs/");
    }

    private static boolean isAgentAuthorized(List<String> scopes, String method, String path) {
        if (scopes == null || scopes.isEmpty()) {
            return false;
        }
        String requiredScope = resolveAgentRequiredScope(method, path);
        return requiredScope != null && scopes.contains(requiredScope);
    }

    private static String resolveAgentRequiredScope(String method, String path) {
        boolean read = "GET".equals(method) || "HEAD".equals(method);
        boolean post = "POST".equals(method);

        if (read) {
            if (path.equals("/api/v2/demand-pool") || path.startsWith("/api/v2/demand-pool/")
                    || path.equals("/api/v2/demand-templates") || path.startsWith("/api/v2/demand-templates/")
                    || path.matches("^/api/v2/cutting/tasks/[^/]+(?:/plans)?$")) {
                return AuthContext.SCOPE_DEMAND_READ;
            }
            if (path.equals("/api/v2/rolls") || path.startsWith("/api/v2/rolls/")
                    || path.equals("/api/v2/remnants") || path.startsWith("/api/v2/remnants/")
                    || path.equals("/api/v2/inventory-ledger") || path.startsWith("/api/v2/inventory-ledger/")
                    || path.startsWith("/api/v2/analytics/")
                    || path.startsWith("/api/v2/reconciliation/")
                    || path.equals("/api/v2/schemes") || path.startsWith("/api/v2/schemes/")
                    || path.equals("/api/v2/execution-orders") || path.startsWith("/api/v2/execution-orders/")
                    || path.equals("/api/v2/quality/releases")
                    || path.equals("/api/v2/inventory-receipts")
                    || path.equals("/api/v2/material-issues")
                    || path.equals("/api/v2/inventory-transfers") || path.equals("/api/v2/inventory-transfers/options")
                    || path.equals("/api/v2/inventory-counts") || path.equals("/api/v2/inventory-counts/options")
                    || path.startsWith("/api/v2/exports/")
                    || path.matches("^/api/v2/cutting/reports/[^/]+/quality-dispositions$")) {
                return AuthContext.SCOPE_INVENTORY_READ;
            }
            if (path.equals("/api/v2/capabilities")
                    || path.equals("/api/v2/nesting/engines")
                    || path.startsWith("/api/v2/optimization-jobs/")
                    || path.startsWith("/api/v2/optimization-results/")
                    || path.equals("/api/v2/result-comparisons")
                    || path.matches("^/api/v2/workbench/tasks/[^/]+/result-comparison$")
                    || path.matches("^/api/v2/workbench/results/[^/]+/context$")) {
                return AuthContext.SCOPE_PLAN_COMPUTE;
            }
            if (path.equals("/api/v2/workbench/drafts") || path.startsWith("/api/v2/workbench/drafts/")) {
                return AuthContext.SCOPE_DRAFT_WRITE;
            }
            return null;
        }

        if (post) {
            if (path.equals("/api/v2/demand-pool")) {
                return AuthContext.SCOPE_DEMAND_WRITE;
            }
            if (path.equals("/api/v2/problem-validations")
                    || path.equals("/api/v2/optimization-jobs")
                    || path.matches("^/api/v2/optimization-jobs/[^/]+/cancellations$")
                    || path.equals("/api/v2/nesting/solve")
                    || path.startsWith("/api/v2/planning/")
                    || path.equals("/api/v2/cutting/remnant-recommendations")
                    || path.equals("/api/v2/schemes/validate-layout")
                    || path.matches("^/api/v2/workbench/tasks/[^/]+/plan-jobs$")) {
                return AuthContext.SCOPE_PLAN_COMPUTE;
            }
            if (path.equals("/api/v2/workbench/drafts")
                    || path.matches("^/api/v2/workbench/drafts/[^/]+/discard$")
                    || path.equals("/api/v2/workbench/multi-material-drafts")) {
                return AuthContext.SCOPE_DRAFT_WRITE;
            }
        }
        return null;
    }

    private boolean tryAcquireWritePermit(String key) {
        long currentMinute = clock.instant().getEpochSecond() / 60L;
        if (writeRateWindows.size() > MAX_RATE_KEYS) {
            writeRateWindows.entrySet().removeIf(entry -> entry.getValue().minuteBucket < currentMinute);
        }
        RateWindow window = writeRateWindows.compute(key, (k, existing) -> {
            if (existing == null || existing.minuteBucket != currentMinute) {
                return new RateWindow(currentMinute, 1);
            }
            return new RateWindow(currentMinute, existing.count + 1);
        });
        return window.count <= writeRateLimitPerMinute;
    }

    private static final String INVALID_PATH_SENTINEL = "/__invalid_path__";

    static String normalizePath(HttpServletRequest request) {
        return tryNormalizePath(request).orElse(INVALID_PATH_SENTINEL);
    }

    static Optional<String> tryNormalizePath(HttpServletRequest request) {
        if (request == null) {
            return Optional.of("/");
        }
        return tryNormalizePathString(request.getRequestURI(), request.getContextPath());
    }

    static String normalizePathString(String rawUri, String contextPath) {
        return tryNormalizePathString(rawUri, contextPath).orElse(INVALID_PATH_SENTINEL);
    }

    static Optional<String> tryNormalizePathString(String rawUri, String contextPath) {
        if (rawUri == null || rawUri.isEmpty()) {
            return Optional.of("/");
        }
        String uri = rawUri;
        int queryIdx = uri.indexOf('?');
        if (queryIdx >= 0) {
            uri = uri.substring(0, queryIdx);
        }
        if (contextPath != null && !contextPath.isEmpty() && uri.startsWith(contextPath)) {
            uri = uri.substring(contextPath.length());
        }
        if (uri.isEmpty()) {
            return Optional.of("/");
        }
        uri = uri.replace('\\', '/');
        String[] rawSegments = uri.split("/", -1);
        java.util.ArrayDeque<String> segments = new java.util.ArrayDeque<>(rawSegments.length);
        boolean preserveTrailingSlash = false;
        for (int i = 0; i < rawSegments.length; i++) {
            String stripped = stripMatrixParameters(rawSegments[i]);
            String segment = decodePercentEncodedSegment(stripped);
            if (segment == null) {
                return Optional.empty();
            }
            boolean isLast = (i == rawSegments.length - 1);
            if (segment.isEmpty()) {
                if (isLast && i > 0) {
                    preserveTrailingSlash = true;
                }
                continue;
            }
            if (".".equals(segment)) {
                preserveTrailingSlash = false;
                continue;
            }
            if ("..".equals(segment)) {
                if (!segments.isEmpty()) {
                    segments.removeLast();
                }
                preserveTrailingSlash = false;
                continue;
            }
            segments.addLast(segment);
            preserveTrailingSlash = false;
        }
        if (segments.isEmpty()) {
            return Optional.of("/");
        }
        StringBuilder normalized = new StringBuilder();
        for (String segment : segments) {
            normalized.append('/').append(segment);
        }
        if (preserveTrailingSlash) {
            normalized.append('/');
        }
        return Optional.of(normalized.toString());
    }

    private static String stripMatrixParameters(String segment) {
        if (segment == null || segment.isEmpty()) {
            return "";
        }
        int cut = segment.indexOf(';');
        String lower = segment.toLowerCase(Locale.ROOT);
        int encodedCut = lower.indexOf("%3b");
        if (encodedCut >= 0 && (cut < 0 || encodedCut < cut)) {
            cut = encodedCut;
        }
        return cut >= 0 ? segment.substring(0, cut) : segment;
    }

    private static String decodePercentEncodedSegment(String segment) {
        if (segment == null || segment.isEmpty()) {
            return "";
        }
        if (segment.indexOf('%') < 0) {
            for (int i = 0; i < segment.length(); i++) {
                if (isForbiddenDecodedChar(segment.charAt(i))) {
                    return null;
                }
            }
            return segment;
        }
        StringBuilder out = new StringBuilder(segment.length());
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        for (int i = 0; i < segment.length(); i++) {
            char ch = segment.charAt(i);
            if (ch == '%') {
                if (i + 2 >= segment.length()) {
                    return null;
                }
                int hi = Character.digit(segment.charAt(i + 1), 16);
                int lo = Character.digit(segment.charAt(i + 2), 16);
                if (hi < 0 || lo < 0) {
                    return null;
                }
                bytes.write((hi << 4) | lo);
                i += 2;
            } else {
                if (!flushDecodedUtf8Bytes(bytes, out)) {
                    return null;
                }
                if (isForbiddenDecodedChar(ch)) {
                    return null;
                }
                out.append(ch);
            }
        }
        if (!flushDecodedUtf8Bytes(bytes, out)) {
            return null;
        }
        return out.toString();
    }

    private static boolean flushDecodedUtf8Bytes(ByteArrayOutputStream bytes, StringBuilder out) {
        if (bytes.size() == 0) {
            return true;
        }
        byte[] raw = bytes.toByteArray();
        bytes.reset();
        try {
            String decoded = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(raw))
                    .toString();
            for (int i = 0; i < decoded.length(); i++) {
                if (isForbiddenDecodedChar(decoded.charAt(i))) {
                    return false;
                }
            }
            out.append(decoded);
            return true;
        } catch (CharacterCodingException e) {
            return false;
        }
    }

    private static boolean isForbiddenDecodedChar(char ch) {
        return ch == '/' || ch == '\\' || ch == ';' || ch <= 0x1F || ch == 0x7F;
    }

    private static void writeError(HttpServletResponse response,
                                   int status,
                                   String code,
                                   String message,
                                   boolean retryable) throws IOException {
        String traceId = MDC.get(TraceIdFilter.MDC_KEY);
        if (traceId == null || traceId.isBlank()) {
            traceId = UUID.randomUUID().toString().replace("-", "");
        }
        response.setStatus(status);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.setContentType("application/json;charset=UTF-8");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", code);
        body.put("message", message);
        body.put("traceId", traceId);
        body.put("retryable", retryable);
        response.getOutputStream().write(JSON.writeValueAsBytes(body));
    }

    public static boolean containsPayloadTooLarge(Throwable error) {
        Throwable cursor = error;
        while (cursor != null) {
            if (cursor instanceof PayloadTooLargeException) {
                return true;
            }
            cursor = cursor.getCause();
        }
        return false;
    }

    public static final class PayloadTooLargeException extends IOException {
        public PayloadTooLargeException(long maxBytes) {
            super("请求正文超过服务端限制（最大 " + maxBytes + " 字节）");
        }
    }

    private record RateWindow(long minuteBucket, int count) {}

    private static final class BoundedBodyRequestWrapper extends HttpServletRequestWrapper {
        private final long maxBytes;
        private ServletInputStream wrappedStream;
        private BufferedReader wrappedReader;

        BoundedBodyRequestWrapper(HttpServletRequest request, long maxBytes) {
            super(request);
            this.maxBytes = maxBytes;
        }

        @Override
        public ServletInputStream getInputStream() throws IOException {
            if (wrappedStream == null) {
                wrappedStream = new BoundedServletInputStream(super.getInputStream(), maxBytes);
            }
            return wrappedStream;
        }

        @Override
        public BufferedReader getReader() throws IOException {
            if (wrappedReader == null) {
                String encoding = getCharacterEncoding();
                wrappedReader = new BufferedReader(new InputStreamReader(
                        getInputStream(),
                        encoding == null || encoding.isBlank() ? StandardCharsets.UTF_8.name() : encoding
                ));
            }
            return wrappedReader;
        }
    }

    private static final class BoundedServletInputStream extends ServletInputStream {
        private final ServletInputStream delegate;
        private final long maxBytes;
        private long readBytes;

        BoundedServletInputStream(ServletInputStream delegate, long maxBytes) {
            this.delegate = delegate;
            this.maxBytes = maxBytes;
        }

        @Override
        public int read() throws IOException {
            int value = delegate.read();
            if (value != -1) {
                readBytes++;
                if (readBytes > maxBytes) {
                    throw new PayloadTooLargeException(maxBytes);
                }
            }
            return value;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            int count = delegate.read(b, off, len);
            if (count > 0) {
                readBytes += count;
                if (readBytes > maxBytes) {
                    throw new PayloadTooLargeException(maxBytes);
                }
            }
            return count;
        }

        @Override
        public boolean isFinished() {
            return delegate.isFinished();
        }

        @Override
        public boolean isReady() {
            return delegate.isReady();
        }

        @Override
        public void setReadListener(ReadListener readListener) {
            delegate.setReadListener(readListener);
        }
    }
}
