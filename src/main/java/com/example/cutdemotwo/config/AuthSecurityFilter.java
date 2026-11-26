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
import java.io.IOException;
import java.io.InputStreamReader;
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
 * 企业级轻量安全网关过滤器：
 * <ol>
 *   <li>全局请求体字节上限保护（{@code cutdemo.security.max-request-body-bytes}，默认 2MB，超限返回 413）；</li>
 *   <li>可选企业认证与 5 角色 RBAC 鉴权（{@code cutdemo.auth.enabled}，默认关闭，开启后白名单放行、未登录 401、越权 403）；</li>
 *   <li>轻量写操作速率防刷保护（默认每分钟 600 次，不影响正常批量操作与自动化测试）；</li>
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
    private final long maxRequestBodyBytes;
    private final int writeRateLimitPerMinute;
    private final Clock clock;
    private final ConcurrentHashMap<String, RateWindow> writeRateWindows = new ConcurrentHashMap<>();

    @Autowired
    public AuthSecurityFilter(
            AuthService authService,
            @Value("${cutdemo.security.max-request-body-bytes:2097152}") long maxRequestBodyBytes,
            @Value("${cutdemo.security.write-rate-limit-per-minute:600}") int writeRateLimitPerMinute
    ) {
        this(authService, maxRequestBodyBytes, writeRateLimitPerMinute, Clock.systemUTC());
    }

    public AuthSecurityFilter(AuthService authService, long maxRequestBodyBytes, int writeRateLimitPerMinute, Clock clock) {
        this.authService = authService;
        this.maxRequestBodyBytes = maxRequestBodyBytes > 0 ? maxRequestBodyBytes : DEFAULT_MAX_REQUEST_BODY_BYTES;
        this.writeRateLimitPerMinute = writeRateLimitPerMinute;
        this.clock = clock == null ? Clock.systemUTC() : clock;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String method = request.getMethod() == null ? "GET" : request.getMethod().toUpperCase(Locale.ROOT);
        String path = normalizePath(request);
        boolean writeRequest = WRITE_METHODS.contains(method);

        // 1. 全局请求体字节上限预检（无论认证是否开启均生效）
        if (writeRequest && request.getContentLengthLong() > maxRequestBodyBytes) {
            writeError(response, 413, "PAYLOAD_TOO_LARGE",
                    "请求正文超过服务端限制（最大 " + maxRequestBodyBytes + " 字节）", false);
            return;
        }

        // 2. 认证与 RBAC 鉴权
        AuthContext.Principal principal;
        if (!authService.isEnabled()) {
            principal = AuthContext.LOCAL_PRINCIPAL;
            // Establish one cookie before the workbench submits its strategies in parallel.
            if ("GET".equals(method) && "/api/v2/auth/me".equals(path)) request.getSession();
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
            if (!isAuthorized(principal.role(), method, path)) {
                writeError(response, 403, "FORBIDDEN",
                        "角色 " + principal.role() + " 无权执行该操作：" + method + " " + path, false);
                return;
            }
        }

        // 3. 轻量写操作防刷保护（仅作用于业务写接口，阈值宽松避免影响正常批量）
        if (writeRequest && writeRateLimitPerMinute > 0 && path.startsWith("/api/") && !"/api/health".equals(path)) {
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
        if (AuthContext.ROLE_ADMIN.equals(role)) {
            return true;
        }
        // 非健康类运维端点（如 /actuator/prometheus）仅允许 ADMIN
        if (path.startsWith("/actuator/")) {
            return false;
        }
        if (path.matches("^/api/v2/workbench/tasks/[^/]+/(optimization-jobs|comparison-questions|result-comparison|results/[^/]+)$")) {
            return AuthContext.ROLE_PLANNER.equals(role);
        }
        // 业务只读接口：5 个已认证角色均可查阅台账、需求、方案、库存与报表
        if ("GET".equals(method) || "HEAD".equals(method)) {
            return true;
        }

        // 1. 演示重置与母卷强制重置：仅 ADMIN
        if (path.startsWith("/api/demo/") || path.matches("^/api/rolls/[^/]+/reset$")) {
            return false;
        }

        // 2. 质检、跑布验疵、隔离料头放行、复检处置与撤销：ADMIN / INSPECTOR
        if (path.startsWith("/api/v2/quality/")
                || path.startsWith("/api/inspection/")
                || path.matches("^/api/rolls/[^/]+/defects(?:/.*)?$")
                || path.matches("^/api/rolls/[^/]+/inspection-defects$")
                || path.matches("^/api/cutting/reports/[^/]+/quality-dispositions$")
                || path.matches("^/api/cutting/reports/[^/]+/dispositions/[^/]+/revoke$")) {
            return AuthContext.ROLE_INSPECTOR.equals(role);
        }

        // 3. 仓储入出库、移库、盘点、母卷建档与报废、料头登记与报废：ADMIN / WAREHOUSE
        if (path.equals("/api/v2/inventory-receipts") || path.startsWith("/api/v2/inventory-receipts/")
                || path.equals("/api/v2/material-issues") || path.startsWith("/api/v2/material-issues/")
                || path.equals("/api/v2/inventory-transfers") || path.startsWith("/api/v2/inventory-transfers/")
                || path.equals("/api/v2/inventory-counts") || path.startsWith("/api/v2/inventory-counts/")
                || path.matches("^/api/v2/rolls/[^/]+/scrap$")
                || path.equals("/api/rolls")
                || path.equals("/api/remnants/register")
                || path.equals("/api/remnants/scan")
                || path.matches("^/api/remnants/[^/]+/scrap$")) {
            return AuthContext.ROLE_WAREHOUSE.equals(role);
        }

        // 4. 车间现场执行、方案完工与裁切报工：ADMIN / OPERATOR / PLANNER
        if (path.equals("/api/v2/execution-orders") || path.startsWith("/api/v2/execution-orders/")
                || path.matches("^/api/v2/schemes/[^/]+/complete$")
                || path.equals("/api/cutting/report-confirm")
                || path.equals("/api/cutting/report-batch")) {
            return AuthContext.ROLE_OPERATOR.equals(role) || AuthContext.ROLE_PLANNER.equals(role);
        }

        // 5. 排程计划、需求池、模板、联合排产/自动分床、方案确认/绑卷/手调/取消/补片与算法求解作业：ADMIN / PLANNER
        if (path.equals("/api/v2/demand-templates") || path.startsWith("/api/v2/demand-templates/")
                || path.equals("/api/v2/demand-pool") || path.startsWith("/api/v2/demand-pool/")
                || path.equals("/api/v2/planning") || path.startsWith("/api/v2/planning/")
                || path.startsWith("/api/v2/schemes/")
                || path.equals("/api/v2/problem-validations")
                || path.equals("/api/v2/optimization-jobs") || path.startsWith("/api/v2/optimization-jobs/")
                || path.startsWith("/api/v1/nesting/")
                || path.startsWith("/api/cutting/tasks")
                || path.startsWith("/api/cutting/plans/")
                || path.matches("^/api/cutting/reports/[^/]+/reverse$")
                || path.equals("/api/cutting/material-candidates")
                || path.equals("/api/cutting/remnant-recommendations")
                || path.equals("/api/remnants/match")) {
            return AuthContext.ROLE_PLANNER.equals(role);
        }

        // 未显式授权的其余写路径默认仅允许 ADMIN（最小权限原则）
        return false;
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

    private static String normalizePath(HttpServletRequest request) {
        String uri = request.getRequestURI();
        if (uri == null || uri.isEmpty()) {
            return "/";
        }
        String contextPath = request.getContextPath();
        if (contextPath != null && !contextPath.isEmpty() && uri.startsWith(contextPath)) {
            uri = uri.substring(contextPath.length());
        }
        return uri.isEmpty() ? "/" : uri;
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

    /** 流式读取请求体超过全局字节上限时抛出的受检边界异常。 */
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
