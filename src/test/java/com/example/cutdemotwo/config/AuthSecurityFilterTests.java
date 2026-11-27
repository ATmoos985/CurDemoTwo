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

        var req = new MockHttpServletRequest("POST", "/api/v2/demo/inventory");
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
                new String[]{"GET", "/api/v2/health"},
                new String[]{"GET", "/actuator/health"},
                new String[]{"GET", "/actuator/health/readiness"},
                new String[]{"GET", "/api/v2/auth/me"},
                new String[]{"POST", "/api/v2/auth/login"},
                new String[]{"GET", "/api/v2/integration-deliveries"},
                new String[]{"POST", "/api/v2/integration-deliveries/claims"}
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
        var noTokenRes = invoke(filter, "GET", "/api/v2/rolls", null);
        assertEquals(401, noTokenRes.getStatus());
        JsonNode body401 = JSON.readTree(noTokenRes.getContentAsByteArray());
        assertEquals("UNAUTHORIZED", body401.get("code").asString());
        assertEquals("trace-auth-401", body401.get("traceId").asString());
        assertFalse(body401.get("retryable").asBoolean());

        // 4. 篡改签名段返回 401
        String token = loginResult.token();
        String tampered = token.substring(0, token.length() - 2) + (token.endsWith("AA") ? "BB" : "AA");
        assertEquals(401, invoke(filter, "GET", "/api/v2/rolls", "Bearer " + tampered).getStatus());

        // 5. 篡改载荷（尝试把 PLANNER 提权为 ADMIN）返回 401
        String[] parts = token.split("\\.");
        String forgedPayload = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                "{\"sub\":\"planner\",\"name\":\"排程计划员\",\"role\":\"ADMIN\",\"iat\":1795478400,\"exp\":1795482000}"
                        .getBytes(StandardCharsets.UTF_8));
        assertEquals(401, invoke(filter, "GET", "/api/v2/rolls", "Bearer " + parts[0] + "." + forgedPayload + "." + parts[2]).getStatus());

        // 6. 有效期内正常放行
        assertEquals(200, invoke(filter, "GET", "/api/v2/rolls", "Bearer " + token).getStatus());

        // 7. 超过 TTL 1 小时后过期，返回 401
        clock.advanceSeconds(3601);
        assertEquals(401, invoke(filter, "GET", "/api/v2/rolls", "Bearer " + token).getStatus());
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
        assertEquals(200, invoke(filter, "POST", "/api/v2/demo/inventory", adminToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/inventory-receipts", adminToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/quality/remnants/REM-1/release", adminToken).getStatus());
        assertEquals(200, invoke(filter, "GET", "/actuator/prometheus", adminToken).getStatus());

        // OPERATOR：允许报工/方案完工/只读查询，严禁采购入库、演示重置、质检放行、排程确认
        assertEquals(200, invoke(filter, "GET", "/api/v2/rolls", operatorToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/schemes/SCH-1/complete", operatorToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/cutting/report-confirm", operatorToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/inventory-receipts", operatorToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/demo/inventory", operatorToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/quality/remnants/REM-1/release", operatorToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/schemes/confirm", operatorToken).getStatus());

        // WAREHOUSE：允许入库/领退料/移库/盘点/母卷建档/报废，严禁质检放行、排程确认、演示重置、越权验布
        assertEquals(200, invoke(filter, "POST", "/api/v2/inventory-receipts", warehouseToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/material-issues", warehouseToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/rolls", warehouseToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/rolls/R-1/scrap", warehouseToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/rolls/R-1/reset", warehouseToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/rolls/R-1/inspection-defects", warehouseToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/quality/remnants/REM-1/release", warehouseToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/schemes/confirm", warehouseToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/demo/inventory", warehouseToken).getStatus());

        // INSPECTOR：允许质检放行、跑布验疵、复检撤销，严禁采购入库、排程确认
        assertEquals(200, invoke(filter, "POST", "/api/v2/quality/remnants/REM-1/release", inspectorToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/inspection/rolls", inspectorToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/cutting/reports/RP-1/dispositions/D-1/revoke", inspectorToken).getStatus());
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
        assertEquals(403, invoke(filter, "POST", "/api/v2/demo/inventory", plannerToken).getStatus());

        // 阶段四只读分析与 SSE 对已认证其他角色开放，而联合排产/分床与工作台编排/草案 POST 仅限 ADMIN / PLANNER
        assertEquals(200, invoke(filter, "POST", "/api/v2/planning/multi-material", adminToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/planning/cut-plan", adminToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/workbench/tasks/T-1/plan-jobs", adminToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/workbench/drafts", adminToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/workbench/drafts/DFT-1/confirm", plannerToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/workbench/drafts/DFT-1/discard", plannerToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/workbench/multi-material-drafts", plannerToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/workbench/tasks/T-1/plan-jobs", plannerToken).getStatus());
        assertEquals(200, invoke(filter, "POST", "/api/v2/workbench/drafts", plannerToken).getStatus());
        assertEquals(200, invoke(filter, "GET", "/api/v2/workbench/drafts", operatorToken).getStatus());
        assertEquals(200, invoke(filter, "GET", "/api/v2/workbench/drafts/DFT-1", operatorToken).getStatus());
        assertEquals(200, invoke(filter, "GET", "/api/v2/workbench/results/RES-1/context", operatorToken).getStatus());
        assertEquals(200, invoke(filter, "GET", "/api/v2/analytics/cost-summary", operatorToken).getStatus());
        assertEquals(200, invoke(filter, "GET", "/api/v2/optimization-jobs/JOB-1/events", operatorToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/planning/multi-material", operatorToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/planning/cut-plan", warehouseToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/workbench/tasks/T-1/plan-jobs", operatorToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/workbench/drafts", warehouseToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/workbench/drafts", inspectorToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/workbench/drafts/DFT-1/discard", operatorToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/workbench/drafts/DFT-1/confirm", warehouseToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/workbench/multi-material-drafts", inspectorToken).getStatus());

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
        assertEquals(200, invoke(filter, "GET", "/api/v2/rolls", null).getStatus());

        // 下一分钟窗口恢复放行
        clock.advanceSeconds(61);
        assertEquals(200, invoke(filter, "POST", "/api/v2/schemes/confirm", null).getStatus());
    }

    @Test
    void rejectsMatrixParametersEncodedSemicolonsDoubleSlashesAndTraversalPaths() throws Exception {
        AuthService service = new AuthService(true, TEST_SECRET, "", 12, Clock.systemUTC());
        InMemoryOperationAuditStore auditStore = new InMemoryOperationAuditStore();
        OperationAuditService auditService = new OperationAuditService(auditStore);
        AuthSecurityFilter authFilter = new AuthSecurityFilter(service, 2_097_152L, 600, Clock.systemUTC(), auditService);
        OperationAuditFilter auditFilter = new OperationAuditFilter(auditService);

        assertEquals("/api/v2/users", AuthSecurityFilter.normalizePathString("/api/v2/users;foo=bar", ""));
        assertEquals("/api/v2/users/", AuthSecurityFilter.normalizePathString("/api/v2/users;foo=bar/", ""));
        assertEquals("/api/v2/users/", AuthSecurityFilter.normalizePathString("/api/v2/users/;foo=bar", ""));
        assertEquals("/api/v2/users", AuthSecurityFilter.normalizePathString("/api/v2/;x=1/users", ""));
        assertEquals("/api/v2/users", AuthSecurityFilter.normalizePathString("/api/v2/users%3Bfoo=bar", ""));
        assertEquals("/api/v2/users/", AuthSecurityFilter.normalizePathString("/api/v2/users%3bfoo=bar/", ""));
        assertEquals("/api/v2/users", AuthSecurityFilter.normalizePathString("//api//v2///users;x=1", ""));
        assertEquals("/api/v2/users", AuthSecurityFilter.normalizePathString("/app/../api/v2/users", ""));
        assertEquals("/api/v2/users", AuthSecurityFilter.normalizePathString("/api/v2/foo/..;/users", ""));
        assertEquals("/api/v2/users", AuthSecurityFilter.normalizePathString("/api/v2/./users", ""));
        assertEquals("/api/v2/rolls/ROLL 01/scrap", AuthSecurityFilter.normalizePathString("/api/v2/rolls/ROLL%2001/scrap", ""));
        assertEquals("/api/v2/rolls/ROLL+01/scrap", AuthSecurityFilter.normalizePathString("/api/v2/rolls/ROLL+01/scrap", ""));
        assertEquals("/api/v2/rolls/ROLL+01/scrap", AuthSecurityFilter.normalizePathString("/api/v2/rolls/ROLL%2B01/scrap", ""));
        assertEquals("/api/v2/rolls/ROLL-布料", AuthSecurityFilter.normalizePathString("/api/v2/rolls/ROLL-%E5%B8%83%E6%96%99", ""));
        assertTrue(AuthSecurityFilter.tryNormalizePathString("/api/v2/%2fusers", "").isEmpty());
        assertTrue(AuthSecurityFilter.tryNormalizePathString("/api/v2/%5cusers", "").isEmpty());
        assertTrue(AuthSecurityFilter.tryNormalizePathString("/api/v2/users%00", "").isEmpty());
        assertTrue(AuthSecurityFilter.tryNormalizePathString("/api/v2/users%zz", "").isEmpty());
        assertTrue(AuthSecurityFilter.tryNormalizePathString("/api/v2/users%2", "").isEmpty());
        assertTrue(AuthSecurityFilter.tryNormalizePathString("/api/v2/users%FF", "").isEmpty());

        String adminToken = "Bearer " + service.authenticate("admin", "admin123").orElseThrow().token();
        String plannerToken = "Bearer " + service.authenticate("planner", "planner123").orElseThrow().token();
        String operatorToken = "Bearer " + service.authenticate("operator", "operator123").orElseThrow().token();
        String warehouseToken = "Bearer " + service.authenticate("warehouse", "warehouse123").orElseThrow().token();

        List<String> bypassedVariants = List.of(
                "/api/v2/users;foo=bar",
                "/api/v2/agents;foo=bar",
                "/api/v2/audit-logs;foo=bar",
                "/api/v2/users;x=1/",
                "/api/v2/users/;x=1",
                "/api/v2/;x=1/users",
                "/api/v2/users%3Bfoo=bar",
                "/api/v2/users%3bfoo=bar",
                "//api/v2/users;x=1",
                "/app/../api/v2/users",
                "/api/v2/./users",
                "/api/v2/foo/..;/users",
                "/api/v2/%75sers",
                "/api/v2/u%73ers",
                "/api/v2/%55sers",
                "/api/v2/%61gents",
                "/api/v2/audit%2dlogs",
                "/api/v2/%75sers;foo=bar"
        );
        for (String variant : bypassedVariants) {
            assertEquals(403, invoke(authFilter, "GET", variant, plannerToken).getStatus(), "PLANNER 必须被拒绝: " + variant);
            assertEquals(403, invoke(authFilter, "GET", variant, operatorToken).getStatus(), "OPERATOR 必须被拒绝: " + variant);
            assertEquals(401, invoke(authFilter, "GET", variant, null).getStatus(), "未登录请求绝不可绕过白名单: " + variant);
            assertEquals(200, invoke(authFilter, "GET", variant, adminToken).getStatus(), "ADMIN 正常访问应当放行: " + variant);
        }

        // 非法百分比编码或解码出路径分隔/控制字符的路径必须 fail-closed 返回 400
        for (String malformedUri : List.of(
                "/api/v2/%2fusers",
                "/api/v2/users%5Ctest",
                "/api/v2/users%00",
                "/api/v2/users%zz",
                "/api/v2/users%2",
                "/api/v2/users%FF"
        )) {
            assertEquals(400, invoke(authFilter, "GET", malformedUri, plannerToken).getStatus(), "非法路径编码必须返回 400: " + malformedUri);
            assertEquals(400, invoke(authFilter, "GET", malformedUri, null).getStatus(), "匿名非法路径编码必须返回 400: " + malformedUri);
        }

        // 含 URL 编码空格、+ 与中文 UTF-8 编码等合法路径段不被破坏
        assertEquals(200, invoke(authFilter, "POST", "/api/v2/rolls/ROLL%2001/scrap", warehouseToken).getStatus());
        assertEquals(200, invoke(authFilter, "POST", "/api/v2/rolls/ROLL+01/scrap", warehouseToken).getStatus());
        assertEquals(200, invoke(authFilter, "POST", "/api/v2/rolls/ROLL-%E5%B8%83%E6%96%99/scrap", warehouseToken).getStatus());

        // 携带矩阵参数或百分比编码的写请求通过 OperationAuditFilter 时仍准确匹配并落盘审计
        for (String confirmUri : List.of("/api/v2/schemes/confirm;trace=1", "/api/v2/schemes/%63onfirm")) {
            String schemeId = confirmUri.contains("%63") ? "SCH-PCT-1" : "SCH-MATRIX-1";
            var auditReq = new MockHttpServletRequest("POST", confirmUri);
            auditReq.addHeader("Authorization", plannerToken);
            var auditRes = new MockHttpServletResponse();
            authFilter.doFilter(auditReq, auditRes, (r1, s1) ->
                    auditFilter.doFilter(r1, s1, (r2, s2) -> {
                        var httpRes = (jakarta.servlet.http.HttpServletResponse) s2;
                        httpRes.setStatus(200);
                        httpRes.getWriter().write("{\"id\":\"" + schemeId + "\"}");
                    })
            );
            assertEquals(200, auditRes.getStatus());
            var page = auditStore.query(new OperationAuditStore.AuditQuery(
                    "planner", null, "SCHEME_CONFIRM", null, schemeId, null, null, null, 0, 10
            ));
            assertEquals(1L, page.total(), "路径变形写请求绝不可逃逸 OperationAuditFilter 审计: " + confirmUri);
            assertEquals("/api/v2/schemes/confirm", page.items().get(0).requestPath());
        }
    }

    @Test
    void agentRootPathsScopeIsolationAndForbiddenWriteEndpoints() throws Exception {
        InMemorySecurityCredentialStore store = new InMemorySecurityCredentialStore();
        AuthService service = new AuthService(true, TEST_SECRET, "", 12, Clock.systemUTC(), store);
        AuthSecurityFilter filter = new AuthSecurityFilter(service, 2_097_152L, 600, Clock.systemUTC());

        long now = System.currentTimeMillis();
        var fullAgent = store.createAgent(new SecurityCredentialStore.AgentRecord(
                "ag-full", "全业务可读与算排代理", "admin",
                List.of(
                        AuthContext.SCOPE_DEMAND_READ,
                        AuthContext.SCOPE_DEMAND_WRITE,
                        AuthContext.SCOPE_INVENTORY_READ,
                        AuthContext.SCOPE_PLAN_COMPUTE,
                        AuthContext.SCOPE_DRAFT_WRITE
                ),
                true, 1L, "回归测试代理", now, now, now + 3_600_000L, null, null
        ));
        var demandOnlyAgent = store.createAgent(new SecurityCredentialStore.AgentRecord(
                "ag-demand-only", "仅需求只读代理", "admin",
                List.of(AuthContext.SCOPE_DEMAND_READ),
                true, 1L, "缺库存读取权限测试", now, now, now + 3_600_000L, null, null
        ));

        String fullToken = "Bearer " + service.issueAgentToken(fullAgent, 3600L);
        String demandOnlyToken = "Bearer " + service.issueAgentToken(demandOnlyAgent, 3600L);

        // 1. SCOPE_INVENTORY_READ 根路径与子路径全覆盖（含 E2E-M3 inventory-ledger 根路径及查询参数、/options）
        var ledgerQueryReq = new MockHttpServletRequest("GET", "/api/v2/inventory-ledger");
        ledgerQueryReq.setQueryString("after=0&limit=1");
        ledgerQueryReq.addHeader("Authorization", fullToken);
        var ledgerQueryRes = new MockHttpServletResponse();
        filter.doFilter(ledgerQueryReq, ledgerQueryRes, (r, s) -> {});
        assertEquals(200, ledgerQueryRes.getStatus(), "Agent 携带 query 访问 GET /api/v2/inventory-ledger 必须 200");

        for (String path : List.of(
                "/api/v2/inventory-ledger",
                "/api/v2/inventory-ledger/reconciliation",
                "/api/v2/rolls",
                "/api/v2/rolls/R-1",
                "/api/v2/rolls/R-1/spatial-map",
                "/api/v2/remnants",
                "/api/v2/schemes",
                "/api/v2/schemes/SCH-1",
                "/api/v2/execution-orders",
                "/api/v2/execution-orders/EXO-1",
                "/api/v2/reconciliation/reports",
                "/api/v2/quality/releases",
                "/api/v2/inventory-receipts",
                "/api/v2/material-issues",
                "/api/v2/inventory-transfers",
                "/api/v2/inventory-transfers/options",
                "/api/v2/inventory-counts",
                "/api/v2/inventory-counts/options",
                "/api/v2/cutting/reports/RP-1/quality-dispositions"
        )) {
            assertEquals(200, invoke(filter, "GET", path, fullToken).getStatus(), "INVENTORY_READ 应放行: " + path);
        }

        // 2. SCOPE_DEMAND_READ / SCOPE_PLAN_COMPUTE / SCOPE_DRAFT_WRITE
        for (String path : List.of(
                "/api/v2/demand-pool",
                "/api/v2/demand-pool/TASK-1",
                "/api/v2/demand-templates",
                "/api/v2/cutting/tasks/TASK-1",
                "/api/v2/cutting/tasks/TASK-1/plans",
                "/api/v2/workbench/drafts",
                "/api/v2/workbench/drafts/DFT-1",
                "/api/v2/capabilities",
                "/api/v2/nesting/engines"
        )) {
            assertEquals(200, invoke(filter, "GET", path, fullToken).getStatus(), "Agent GET 应放行: " + path);
        }
        for (String path : List.of(
                "/api/v2/demand-pool",
                "/api/v2/nesting/solve",
                "/api/v2/cutting/remnant-recommendations",
                "/api/v2/workbench/drafts",
                "/api/v2/workbench/drafts/DFT-1/discard",
                "/api/v2/workbench/multi-material-drafts"
        )) {
            assertEquals(200, invoke(filter, "POST", path, fullToken).getStatus(), "Agent POST 应放行: " + path);
        }

        // 3. 缺 scope 负例：仅 DEMAND_READ 不得访问 inventory-ledger / transfers/options / counts/options / rolls
        for (String path : List.of(
                "/api/v2/inventory-ledger",
                "/api/v2/inventory-ledger/reconciliation",
                "/api/v2/inventory-transfers/options",
                "/api/v2/inventory-counts/options",
                "/api/v2/rolls"
        )) {
            assertEquals(403, invoke(filter, "GET", path, demandOnlyToken).getStatus(), "缺 INVENTORY_READ 必须返回 403: " + path);
        }

        // 4. 越权写与管理端点隔离（持全部业务 scope 仍返回 403）
        for (String getForbidden : List.of("/api/v2/users", "/api/v2/agents", "/api/v2/audit-logs")) {
            assertEquals(403, invoke(filter, "GET", getForbidden, fullToken).getStatus(), "Agent 禁止访问管理接口: " + getForbidden);
        }
        for (String postForbidden : List.of(
                "/api/v2/cutting/tasks",
                "/api/v2/cutting/report-confirm",
                "/api/v2/rolls",
                "/api/v2/rolls/R-1/scrap",
                "/api/v2/rolls/R-1/reset",
                "/api/v2/demo/inventory",
                "/api/v2/schemes/confirm",
                "/api/v2/workbench/drafts/DFT-1/confirm",
                "/api/v2/inventory-receipts",
                "/api/v2/quality/remnants/REM-1/release"
        )) {
            assertEquals(403, invoke(filter, "POST", postForbidden, fullToken).getStatus(), "Agent 禁止访问业务落库/管理写接口: " + postForbidden);
        }

        // 5. Principal 静态授权校验与下线死路由拦截
        var principal = new AuthContext.Principal(
                "agent:ag-full", "助理", AuthContext.ROLE_AGENT, List.of(AuthContext.ROLE_AGENT), true,
                AuthContext.ACTOR_AGENT, "ag-full", List.of(AuthContext.SCOPE_INVENTORY_READ), null, 1L
        );
        assertTrue(AuthSecurityFilter.isAuthorized(principal, "GET", "/api/v2/inventory-ledger"));
        assertTrue(AuthSecurityFilter.isAuthorized(principal, "GET", "/api/v2/inventory-transfers/options"));
        assertTrue(AuthSecurityFilter.isAuthorized(principal, "GET", "/api/v2/inventory-counts/options"));
        assertTrue(AuthSecurityFilter.isAuthorized(principal, "GET", "/api/v2/exports/schemes/SCH-1/cam"));
        assertTrue(AuthSecurityFilter.isAuthorized(principal, "GET", "/api/v2/exports/production-summary"));
        assertFalse(AuthSecurityFilter.isAuthorized(principal, "POST", "/api/v2/exports/batch-zip"));
        assertFalse(AuthSecurityFilter.isAuthorized(principal, "POST", "/api/v2/inventory/import/rolls"));
        assertFalse(AuthSecurityFilter.isAuthorized(principal, "POST", "/api/v2/inventory/import/defects"));
        assertFalse(AuthSecurityFilter.isAuthorized(principal, "GET", "/api/cutting/tasks"));
        assertFalse(AuthSecurityFilter.isAuthorized(principal, "POST", "/api/remnants/scan"));

        // 6. M4-2 导入导出 RBAC 矩阵验证
        for (String r : List.of("ADMIN", "PLANNER", "OPERATOR", "INSPECTOR", "WAREHOUSE")) {
            assertTrue(AuthSecurityFilter.isAuthorized(r, "GET", "/api/v2/exports/schemes/SCH-1/ticket.pdf"), "全角色应放行 GET 导出: " + r);
            assertTrue(AuthSecurityFilter.isAuthorized(r, "POST", "/api/v2/exports/batch-zip"), "全角色应放行 batch-zip: " + r);
        }
        assertTrue(AuthSecurityFilter.isAuthorized("WAREHOUSE", "POST", "/api/v2/inventory/import/rolls"));
        assertTrue(AuthSecurityFilter.isAuthorized("WAREHOUSE", "POST", "/api/v2/inventory/import/remnants/preview"));
        assertFalse(AuthSecurityFilter.isAuthorized("WAREHOUSE", "POST", "/api/v2/inventory/import/defects"));
        assertTrue(AuthSecurityFilter.isAuthorized("INSPECTOR", "POST", "/api/v2/inventory/import/defects/preview"));
        assertFalse(AuthSecurityFilter.isAuthorized("INSPECTOR", "POST", "/api/v2/inventory/import/rolls"));
        assertFalse(AuthSecurityFilter.isAuthorized("OPERATOR", "POST", "/api/v2/inventory/import/rolls"));
        assertFalse(AuthSecurityFilter.isAuthorized("PLANNER", "POST", "/api/v2/inventory/import/defects"));
        assertEquals(403, invoke(filter, "GET", "/api/v2/exports/schemes/SCH-1/cam", demandOnlyToken).getStatus());
        assertEquals(200, invoke(filter, "GET", "/api/v2/exports/schemes/SCH-1/cam", fullToken).getStatus());
        assertEquals(403, invoke(filter, "POST", "/api/v2/exports/batch-zip", fullToken).getStatus());
    }

    @Test
    void mesEndpointsRequireAuthenticationRespectRbacAgentAndMesToken() throws Exception {
        InMemorySecurityCredentialStore store = new InMemorySecurityCredentialStore();
        AuthService service = new AuthService(true, TEST_SECRET, "", 12, Clock.systemUTC(), store);
        AuthSecurityFilter filterNoMesToken = new AuthSecurityFilter(service, 2_097_152L, 600, Clock.systemUTC(), null, "");
        AuthSecurityFilter filterWithMesToken = new AuthSecurityFilter(service, 2_097_152L, 600, Clock.systemUTC(), null, "mes-secret-2026");

        String adminToken = "Bearer " + service.authenticate("admin", "admin123").orElseThrow().token();
        String plannerToken = "Bearer " + service.authenticate("planner", "planner123").orElseThrow().token();
        String operatorToken = "Bearer " + service.authenticate("operator", "operator123").orElseThrow().token();
        String warehouseToken = "Bearer " + service.authenticate("warehouse", "warehouse123").orElseThrow().token();
        String inspectorToken = "Bearer " + service.authenticate("inspector", "inspector123").orElseThrow().token();

        long now = System.currentTimeMillis();
        var demandOnlyAgent = store.createAgent(new SecurityCredentialStore.AgentRecord(
                "ag-mes-demand", "仅需求可读", "admin",
                List.of(AuthContext.SCOPE_DEMAND_READ),
                true, 1L, "MES越权阻断", now, now, now + 3_600_000L, null, null
        ));
        var fullAgent = store.createAgent(new SecurityCredentialStore.AgentRecord(
                "ag-mes-full", "全业务可读", "admin",
                List.of(AuthContext.SCOPE_DEMAND_READ, AuthContext.SCOPE_INVENTORY_READ, AuthContext.SCOPE_PLAN_COMPUTE),
                true, 1L, "MES写拦截", now, now + 3_600_000L, now + 3_600_000L, null, null
        ));
        String demandOnlyToken = "Bearer " + service.issueAgentToken(demandOnlyAgent, 3600L);
        String fullAgentToken = "Bearer " + service.issueAgentToken(fullAgent, 3600L);

        // 1. 开启 auth.enabled=true 后（无论是否配置 mes.token），匿名请求一律 401
        for (AuthSecurityFilter f : List.of(filterNoMesToken, filterWithMesToken)) {
            assertEquals(401, invoke(f, "POST", "/api/v2/mes/orders", null).getStatus());
            assertEquals(401, invoke(f, "POST", "/api/v2/mes/execution-feedback", null).getStatus());
            assertEquals(401, invoke(f, "POST", "/api/v2/mes/schemes/SCH-1/dispatch", null).getStatus());
            assertEquals(401, invoke(f, "GET", "/api/v2/mes/dispatch-packages/SCH-1", null).getStatus());
            assertEquals(401, invoke(f, "POST", "/api/v2/mes/orders", "Bearer wrong-mes-token").getStatus());
        }

        // 2. 仅 DEMAND_READ Agent 全部拒绝（403）；全 scope Agent 仅允许 GET，绝不允许 POST 写 MES
        for (AuthSecurityFilter f : List.of(filterNoMesToken, filterWithMesToken)) {
            assertEquals(403, invoke(f, "GET", "/api/v2/mes/dispatch-packages/SCH-1", demandOnlyToken).getStatus());
            assertEquals(403, invoke(f, "POST", "/api/v2/mes/schemes/SCH-1/dispatch", demandOnlyToken).getStatus());
            assertEquals(403, invoke(f, "POST", "/api/v2/mes/orders", demandOnlyToken).getStatus());
            assertEquals(403, invoke(f, "POST", "/api/v2/mes/execution-feedback", demandOnlyToken).getStatus());

            assertEquals(200, invoke(f, "GET", "/api/v2/mes/dispatch-packages/SCH-1", fullAgentToken).getStatus());
            assertEquals(403, invoke(f, "POST", "/api/v2/mes/schemes/SCH-1/dispatch", fullAgentToken).getStatus());
            assertEquals(403, invoke(f, "POST", "/api/v2/mes/orders", fullAgentToken).getStatus());
            assertEquals(403, invoke(f, "POST", "/api/v2/mes/execution-feedback", fullAgentToken).getStatus());
        }

        // 3. 用户 RBAC 隔离与双认证共存
        assertEquals(200, invoke(filterWithMesToken, "POST", "/api/v2/mes/orders", plannerToken).getStatus());
        assertEquals(200, invoke(filterWithMesToken, "POST", "/api/v2/mes/schemes/SCH-1/dispatch", plannerToken).getStatus());
        assertEquals(200, invoke(filterWithMesToken, "POST", "/api/v2/mes/execution-feedback", operatorToken).getStatus());
        assertEquals(200, invoke(filterWithMesToken, "POST", "/api/v2/mes/schemes/SCH-1/dispatch", operatorToken).getStatus());
        assertEquals(403, invoke(filterWithMesToken, "POST", "/api/v2/mes/orders", operatorToken).getStatus());
        assertEquals(403, invoke(filterWithMesToken, "POST", "/api/v2/mes/schemes/SCH-1/dispatch", warehouseToken).getStatus());
        assertEquals(403, invoke(filterWithMesToken, "POST", "/api/v2/mes/execution-feedback", inspectorToken).getStatus());
        assertEquals(200, invoke(filterWithMesToken, "GET", "/api/v2/mes/dispatch-packages/SCH-1", warehouseToken).getStatus());
        assertEquals(200, invoke(filterWithMesToken, "POST", "/api/v2/mes/orders", adminToken).getStatus());

        // 4. 正确配置的外部 MES Bearer Token 机器调用放行，且错误 Token 返回 401
        assertEquals(200, invoke(filterWithMesToken, "POST", "/api/v2/mes/orders", "Bearer mes-secret-2026").getStatus());
        assertEquals(200, invoke(filterWithMesToken, "POST", "/api/v2/mes/execution-feedback", "Bearer mes-secret-2026").getStatus());
        assertEquals(200, invoke(filterWithMesToken, "GET", "/api/v2/mes/dispatch-packages/SCH-1", "Bearer mes-secret-2026").getStatus());
        assertEquals(401, invoke(filterWithMesToken, "POST", "/api/v2/mes/orders", "Bearer wrong-token").getStatus());
    }

    @Test
    void rejectsNonCanonicalBase64UrlJwtVariantsAndPaddingTampering() throws Exception {
        MutableClock clock = new MutableClock(Instant.parse("2026-11-27T19:00:00Z"));
        AuthService service = new AuthService(true, TEST_SECRET, "", 12, clock);
        AuthSecurityFilter filter = new AuthSecurityFilter(service, 2_097_152L, 600, clock);
        String b64Url = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

        // 1. 寻找一个签名末位为 'Y' 的真实令牌，明确复现并拦截 'Y' -> 'a' padding-bit 碰撞
        String yEndedToken = null;
        for (int i = 0; i < 512; i++) {
            String candidate = service.authenticate("planner", "planner123").orElseThrow().token();
            if (candidate.endsWith("Y")) {
                yEndedToken = candidate;
                break;
            }
            clock.advanceSeconds(1);
        }
        assertNotNull(yEndedToken, "512 次签发内应可命中末位为 'Y' 的 JWT 样本");
        String yToA = yEndedToken.substring(0, yEndedToken.length() - 1) + "a";
        assertEquals(401, invoke(filter, "GET", "/api/v2/rolls", "Bearer " + yToA).getStatus(),
                "末位 padding-bit 篡改 'Y'->'a' 必须被严格拒收 (401)");

        // 2. 对任意合法 JWT，遍历其第 43 位同高 4-bit 组的全部 3 个非规范低 2-bit 变体，均须返回 401
        String validToken = service.authenticate("planner", "planner123").orElseThrow().token();
        String[] parts = validToken.split("\\.", -1);
        assertEquals(3, parts.length);
        assertEquals(43, parts[2].length());
        int lastIdx = b64Url.indexOf(parts[2].charAt(parts[2].length() - 1));
        assertTrue(lastIdx >= 0);
        assertEquals(0, lastIdx & 3, "合法 32 字节 HMAC-SHA256 无填充签名末位低 2 bit 必为 0");
        int groupBase = lastIdx & ~3;
        for (int offset = 0; offset < 4; offset++) {
            int variantIdx = groupBase + offset;
            if (variantIdx == lastIdx) continue;
            String variantToken = validToken.substring(0, validToken.length() - 1) + b64Url.charAt(variantIdx);
            assertEquals(401, invoke(filter, "GET", "/api/v2/rolls", "Bearer " + variantToken).getStatus(),
                    "非规范末位变体必须返回 401: " + b64Url.charAt(variantIdx));
        }

        // 3. 带 '=' 填充的签名、带 '=' 填充/非规范的 header 或 payload、多余点分段均须返回 401
        assertEquals(401, invoke(filter, "GET", "/api/v2/rolls", "Bearer " + validToken + "=").getStatus());
        assertEquals(401, invoke(filter, "GET", "/api/v2/rolls", "Bearer " + parts[0] + "=." + parts[1] + "." + parts[2]).getStatus());
        assertEquals(401, invoke(filter, "GET", "/api/v2/rolls", "Bearer " + parts[0] + "." + parts[1] + "=." + parts[2]).getStatus());
        assertEquals(401, invoke(filter, "GET", "/api/v2/rolls", "Bearer " + validToken + ".").getStatus());

        // 4. 使用相同密钥对含非规范低 2 bit payload 签名构造出的 Token，验签也必须拒收
        javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
        mac.init(new javax.crypto.spec.SecretKeySpec(TEST_SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        int pLastIdx = b64Url.indexOf(parts[1].charAt(parts[1].length() - 1));
        int pAltIdx = (pLastIdx & ~3) + (((pLastIdx & 3) + 1) & 3);
        String nonCanonicalPayload = parts[1].substring(0, parts[1].length() - 1) + b64Url.charAt(pAltIdx);
        String forgedSigningInput = parts[0] + "." + nonCanonicalPayload;
        String forgedSig = java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(forgedSigningInput.getBytes(StandardCharsets.UTF_8)));
        assertEquals(401, invoke(filter, "GET", "/api/v2/rolls", "Bearer " + forgedSigningInput + "." + forgedSig).getStatus(),
                "非规范 Base64URL payload 即使签名匹配密钥也必须被拒收 (401)");
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
