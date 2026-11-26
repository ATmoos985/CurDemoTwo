package com.example.cutdemotwo.config;

import com.example.cutdemotwo.controller.AuthController;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 企业轻量认证、RBAC 5 角色鉴权、AuthContext 清理、全局请求体 413 限制与轻量写限流单元测试。
 */
class AuthSecurityFilterTests {
    private static final String TEST_SECRET = "cutdemo-unit-test-hmac-secret-key-2026";
    private static final JsonMapper JSON = JsonMapper.builder().build();

    @AfterEach
    void cleanup() {
        AuthContext.clear();
        MDC.clear();
    }

    private static final class MutableClock extends Clock {
        private Instant current;

        MutableClock(Instant initial) {
            this.current = initial;
        }

        void advanceSeconds(long seconds) {
            this.current = this.current.plusSeconds(seconds);
        }

        @Override
        public ZoneOffset getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return current;
        }
    }

    @Test
    void disabledAuthAllowsRequestsSmoothlyAndReturnsLocalAdminMe() throws Exception {
        AuthService service = new AuthService(false, TEST_SECRET, "", 12, Clock.systemUTC());
        AuthSecurityFilter filter = new AuthSecurityFilter(service, 2_097_152L, 600, Clock.systemUTC());
        AuthController controller = new AuthController(service);

        AuthService.MeResponse me = controller.me(null);
        assertFalse(me.enabled());
        assertFalse(me.authenticated());
        assertEquals("LOCAL", me.username());
        assertEquals("ADMIN", me.role());
        assertEquals(List.of("ADMIN"), me.roles());

        var req = new MockHttpServletRequest("POST", "/api/demo/inventory");
        var res = new MockHttpServletResponse();
        var seenUser = new AtomicReference<String>();
        var seenRole = new AtomicReference<String>();

        filter.doFilter(req, res, (r, s) -> {
            seenUser.set(AuthContext.username());
            seenRole.set(AuthContext.role());
        });

        assertEquals(200, res.getStatus());
        assertEquals("LOCAL", seenUser.get());
        assertEquals("ADMIN", seenRole.get());
        assertNull(AuthContext.current(), "请求结束后必须清理 AuthContext");
    }

    @Test
    void enabledAuthWhitelistsPublicAndDedicatedBearerEndpoints() throws Exception {
        AuthService service = new AuthService(true, TEST_SECRET, "", 12, Clock.systemUTC());
        AuthSecurityFilter filter = new AuthSecurityFilter(service, 2_097_152L, 600, Clock.systemUTC());

        List<String[]> whitelisted = List.of(
                new String[]{"GET", "/"},
                new String[]{"GET", "/app/"},
                new String[]{"GET", "/app/index.html"},
                new String[]{"GET", "/app/assets/index.js"},
                new String[]{"GET", "/styles/main.css"},
                new String[]{"GET", "/logo.svg"},
                new String[]{"GET", "/icon.png"},
                new String[]{"GET", "/api-v2/openapi.json"},
                new String[]{"GET", "/api/health"},
                new String[]{"GET", "/actuator/health"},
                new String[]{"GET", "/actuator/health/readiness"},
                new String[]{"GET", "/api/v2/auth/me"},
                new String[]{"POST", "/api/v2/auth/login"},
                new String[]{"GET", "/api/v2/integration-deliveries"},
                new String[]{"POST", "/api/v2/integration-deliveries/claims"},
                new String[]{"POST", "/api/v2/mes/orders"},
                new String[]{"POST", "/api/v2/mes/execution-feedback"}
        );

        for (String[] pair : whitelisted) {
            var req = new MockHttpServletRequest(pair[0], pair[1]);
            var res = new MockHttpServletResponse();
            var reached = new AtomicBoolean(false);
            filter.doFilter(req, res, (r, s) -> reached.set(true));
            assertTrue(reached.get(), "白名单路径应当放行：" + pair[0] + " " + pair[1]);
            assertEquals(200, res.getStatus(), "白名单状态应为 200：" + pair[1]);
        }
    }

    @Test
    void enabledAuthRejectsMissingTamperedAndExpiredTokens() throws Exception {
        MutableClock clock = new MutableClock(Instant.parse("2026-11-25T00:00:00Z"));
        AuthService service = new AuthService(true, TEST_SECRET, "", 1, clock);
        AuthSecurityFilter filter = new AuthSecurityFilter(service, 2_097_152L, 600, clock);
        AuthController controller = new AuthController(service);

        // 1. 错误口令登录返回 401
        var badLogin = controller.login(new AuthController.LoginRequest("admin", "wrong-pass"));
        assertEquals(401, badLogin.getStatusCode().value());

        // 2. 正确登录并校验 /me
        var goodLogin = controller.login(new AuthController.LoginRequest("planner", "planner123"));
        assertEquals(200, goodLogin.getStatusCode().value());
        var loginResult = assertInstanceOf(AuthService.LoginResult.class, goodLogin.getBody());
        assertEquals("planner", loginResult.username());
        assertEquals("PLANNER", loginResult.role());
        assertNotNull(loginResult.expiresAt());

        AuthService.MeResponse unauthMe = controller.me(null);
        assertTrue(unauthMe.enabled());
        assertFalse(unauthMe.authenticated());

        AuthService.MeResponse authMe = controller.me("Bearer " + loginResult.token());
        assertTrue(authMe.enabled());
        assertTrue(authMe.authenticated());
        assertEquals("planner", authMe.username());
        assertEquals("PLANNER", authMe.role());

        // 3. 无令牌访问业务接口返回 401
        MDC.put(TraceIdFilter.MDC_KEY, "trace-auth-401");
        var noTokenRes = invoke(filter, "GET", "/api/rolls", null);
        assertEquals(401, noTokenRes.getStatus());
        JsonNode body401 = JSON.readTree(noTokenRes.getContentAsByteArray());
        assertEquals("UNAUTHORIZED", body401.get("code").asString());
        assertEquals("trace-auth-401", body401.get("traceId").asString());
        assertFalse(body401.get("retryable").asBoolean());

        // 4. 篡改签名段返回 401
        String token = loginResult.token();
        String tampered = token.substring(0, token.length() - 2) + (token.endsWith("AA") ? "BB" : "AA");
        assertEquals(401, invoke(filter, "GET", "/api/rolls", "Bearer " + tampered).getStatus());

        // 5. 篡改载荷（尝试把 PLANNER 提权为 ADMIN）返回 401
        String[] parts = token.split("\\.");
        String forgedPayload = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                "{\"sub\":\"planner\",\"name\":\"排程计划员\",\"role\":\"ADMIN\",\"iat\":1795478400,\"exp\":1795482000}"
                        .getBytes(StandardCharsets.UTF_8));
        assertEquals(401, invoke(filter, "GET", "/api/rolls", "Bearer " + parts[0] + "." + forgedPayload + "." + parts[2]).getStatus());

        // 6. 有效期内正常放行
        assertEquals(200, invoke(filter, "GET", "/api/rolls", "Bearer " + token).getStatus());

        // 7. 超过 TTL 1 小时后过期，返回 401
        clock.advanceSeconds(3601);
        assertEquals(401, invoke(filter, "GET", "/api/rolls", "Bearer " + token).getStatus());
    }

    @Test
    void enforcesFiveRoleRbacMatrixAndCleansContextOnDownstreamException() throws Exception {
        AuthService service = new AuthService(true, TEST_SECRET, "", 12, Clock.systemUTC());
        AuthSecurityFilter filter = new AuthSecurityFilter(service, 2_097_152L, 600, Clock.systemUTC());

        String adminToken = "Bearer " + service.authenticate("admin", "admin123").orElseThrow().token();
        String plannerToken = "Bearer " + service.authenticate("planner", "planner123").orElseThrow().token();
        String operatorToken = "Bearer " + service.authenticate("operator", "operator123").orElseThrow().token();
        String inspectorToken = "Bearer " + service.authenticate("inspector", "inspector123").orElseThrow().token();
        String warehouseToken = "Bearer " + service.authenticate("warehouse", "warehouse123").orElseThrow().token();

        // ADMIN 全部放行
        assertEquals(200, invoke(filter, "POST", "/api/demo/inventory", adminToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/inventory-receipts", adminToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/quality/remnants/REM-1/release", adminToken).getStatus());
        assertEquals(200, invoke(filter, "GET", "/actuator/prometheus", adminToken).getStatus());

        // OPERATOR：允许报工/方案完工/只读查询，严禁采购入库、演示重置、质检放行、排程确认
        assertEquals(200, invoke(filter, "GET", "/api/rolls", operatorToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/schemes/SCH-1/complete", operatorToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/cutting/report-confirm", operatorToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/inventory-receipts", operatorToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/demo/inventory", operatorToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/quality/remnants/REM-1/release", operatorToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/schemes/confirm", operatorToken).getStatus());

        // WAREHOUSE：允许入库/领退料/移库/盘点/报废，严禁质检放行、排程确认、演示重置
        assertEquals(200, invoke(filter, "POST", "/api/v2/inventory-receipts", warehouseToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/material-issues", warehouseToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/rolls/R-1/scrap", warehouseToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/quality/remnants/REM-1/release", warehouseToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/schemes/confirm", warehouseToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/demo/inventory", warehouseToken).getStatus());

        // INSPECTOR：允许质检放行、跑布验疵、复检撤销，严禁采购入库、排程确认
        assertEquals(200, invoke(filter, "POST", "/api/v2/quality/remnants/REM-1/release", inspectorToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/inspection/rolls", inspectorToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/cutting/reports/RP-1/dispositions/D-1/revoke", inspectorToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/inventory-receipts", inspectorToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/schemes/confirm", inspectorToken).getStatus());

        // PLANNER：允许需求池、模板、联合排产/自动分床、方案确认、同缸补片、计算作业与只读分析/SSE，严禁采购入库、质检放行、演示重置
        assertEquals(200, invoke(filter, "POST", "/api/v2/demand-pool", plannerToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/planning/multi-material", plannerToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/planning/cut-plan", plannerToken).getStatus());
        assertEquals(200, invoke(filter, "GET", "/api/v2/analytics/cost-summary", plannerToken).getStatus());
        assertEquals(200, invoke(filter, "GET", "/api/v2/analytics/procurement-suggestions", plannerToken).getStatus());
        assertEquals(200, invoke(filter, "GET", "/api/v2/optimization-jobs/JOB-1/events", plannerToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/schemes/confirm", plannerToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/schemes/SCH-1/replenish-task", plannerToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/inventory-receipts", plannerToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/quality/remnants/REM-1/release", plannerToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/demo/inventory", plannerToken).getStatus());

        // 阶段四只读分析与 SSE 对已认证其他角色开放，而联合排产/分床 POST 仅限 ADMIN / PLANNER
        assertEquals(200, invoke(filter, "POST", "/api/v2/planning/multi-material", adminToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/planning/cut-plan", adminToken).getStatus());
        assertEquals(200, invoke(filter, "GET", "/api/v2/analytics/cost-summary", operatorToken).getStatus());
        assertEquals(200, invoke(filter, "GET", "/api/v2/optimization-jobs/JOB-1/events", operatorToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/planning/multi-material", operatorToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/planning/cut-plan", warehouseToken).getStatus());

        // 下游抛异常时也必须写入并在 finally 清理 AuthContext
        var req = new MockHttpServletRequest("POST", "/api/v2/schemes/confirm");
        req.addHeader("Authorization", plannerToken);
        var res = new MockHttpServletResponse();
        var observedRole = new AtomicReference<String>();
        assertThrows(IllegalStateException.class, () -> filter.doFilter(req, res, (r, s) -> {
            observedRole.set(AuthContext.role());
            throw new IllegalStateException("下游模拟故障");
        }));
        assertEquals("PLANNER", observedRole.get());
        assertNull(AuthContext.current(), "下游异常后必须清理 AuthContext 防止线程串号");
    }

    @Test
    void enforcesMaxRequestBodyBytesForBothContentLengthAndChunkedStreams() throws Exception {
        AuthService service = new AuthService(false, TEST_SECRET, "", 12, Clock.systemUTC());
        AuthSecurityFilter filter = new AuthSecurityFilter(service, 1024L, 600, Clock.systemUTC());

        // 1. Content-Length 明确超限时直接短路返回 413
        var bigReq = new MockHttpServletRequest("POST", "/api/v2/schemes/confirm");
        bigReq.setContent("x".repeat(1025).getBytes(StandardCharsets.UTF_8));
        var bigRes = new MockHttpServletResponse();
        var reached = new AtomicBoolean(false);
        filter.doFilter(bigReq, bigRes, (r, s) -> reached.set(true));

        assertFalse(reached.get());
        assertEquals(413, bigRes.getStatus());
        JsonNode body = JSON.readTree(bigRes.getContentAsByteArray());
        assertEquals("PAYLOAD_TOO_LARGE", body.get("code").asString());
        assertFalse(body.get("retryable").asBoolean());

        // 2. 无 Content-Length（chunked 流）读取超过上限时同样返回 413
        byte[] chunkedPayload = "a".repeat(2048).getBytes(StandardCharsets.UTF_8);
        var chunkedReq = new MockHttpServletRequest("POST", "/api/v2/schemes/confirm") {
            @Override
            public long getContentLengthLong() {
                return -1L;
            }
        };
        chunkedReq.setContent(chunkedPayload);
        var chunkedRes = new MockHttpServletResponse();
        filter.doFilter(chunkedReq, chunkedRes, (r, s) -> {
            try {
                r.getInputStream().readAllBytes();
            } catch (IOException e) {
                throw new jakarta.servlet.ServletException("wrapped", e);
            }
        });
        assertEquals(413, chunkedRes.getStatus());
        assertEquals("PAYLOAD_TOO_LARGE", JSON.readTree(chunkedRes.getContentAsByteArray()).get("code").asString());

        // 3. 恰好等于上限 1024 字节时正常通过
        var okReq = new MockHttpServletRequest("POST", "/api/v2/schemes/confirm");
        okReq.setContent("b".repeat(1024).getBytes(StandardCharsets.UTF_8));
        var okRes = new MockHttpServletResponse();
        filter.doFilter(okReq, okRes, (r, s) -> assertEquals(1024, r.getInputStream().readAllBytes().length));
        assertEquals(200, okRes.getStatus());
    }

    @Test
    void writeRateLimiterProtectsAgainstBurstAbuseAndResetsNextMinute() throws Exception {
        MutableClock clock = new MutableClock(Instant.parse("2026-11-25T01:00:00Z"));
        AuthService service = new AuthService(false, TEST_SECRET, "", 12, clock);
        AuthSecurityFilter filter = new AuthSecurityFilter(service, 2_097_152L, 3, clock);

        for (int i = 0; i < 3; i++) {
            assertEquals(200, invoke(filter, "POST", "/api/v2/schemes/confirm", null).getStatus());
        }
        var limited = invoke(filter, "POST", "/api/v2/schemes/confirm", null);
        assertEquals(429, limited.getStatus());
        assertEquals("10", limited.getHeader("Retry-After"));
        assertEquals("RATE_LIMIT_EXCEEDED", JSON.readTree(limited.getContentAsByteArray()).get("code").asString());
        assertTrue(JSON.readTree(limited.getContentAsByteArray()).get("retryable").asBoolean());

        // GET 请求不受写限流影响
        assertEquals(200, invoke(filter, "GET", "/api/rolls", null).getStatus());

        // 下一分钟窗口恢复放行
        clock.advanceSeconds(61);
        assertEquals(200, invoke(filter, "POST", "/api/v2/schemes/confirm", null).getStatus());
    }

    private MockHttpServletResponse invoke(AuthSecurityFilter filter, String method, String uri, String authHeader) throws Exception {
        var req = new MockHttpServletRequest(method, uri);
        if (authHeader != null) {
            req.addHeader("Authorization", authHeader);
        }
        var res = new MockHttpServletResponse();
        filter.doFilter(req, res, (r, s) -> {
            // 放行时校验 AuthContext 与授权一致
            if (authHeader != null && res.getStatus() == 200) {
                assertNotNull(AuthContext.current());
            }
        });
        assertNull(AuthContext.current());
        return res;
    }
}
