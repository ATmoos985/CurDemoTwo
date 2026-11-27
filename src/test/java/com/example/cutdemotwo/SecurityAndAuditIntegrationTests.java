package com.example.cutdemotwo;

import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.config.AuthContext;
import com.example.cutdemotwo.config.AuthService;
import com.example.cutdemotwo.config.FileOperationAuditStore;
import com.example.cutdemotwo.config.FileSecurityCredentialStore;
import com.example.cutdemotwo.config.JdbcOperationAuditStore;
import com.example.cutdemotwo.config.JdbcSecurityCredentialStore;
import com.example.cutdemotwo.config.OperationAuditStore;
import com.example.cutdemotwo.config.PasswordHasher;
import com.example.cutdemotwo.config.SecurityAdminService;
import com.example.cutdemotwo.config.SecurityCredentialStore;
import com.example.cutdemotwo.persistence.FileInventoryStore;
import com.example.cutdemotwo.persistence.OptimizationTestDatabase;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/**
 * M3 路线 B 安全认证、AI Agent 细粒度隔离、全站持久化操作审计与母卷长度守恒集成测试。
 */
@Tag("mysql-integration")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class SecurityAndAuditIntegrationTests {
    private static final String TEST_SECRET = "m3-security-audit-integration-secret-2026";
    private static final DriverManagerDataSource DB = OptimizationTestDatabase.create();

    @TempDir
    static Path temp;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        Flyway.configure().dataSource(DB).cleanDisabled(true).load().migrate();
        registry.add("cutdemo.storage", () -> "mysql");
        registry.add("cutdemo.database.url", DB::getUrl);
        registry.add("cutdemo.database.username", DB::getUsername);
        registry.add("cutdemo.database.password", DB::getPassword);
        registry.add("cutdemo.state.path", () -> temp.resolve("m3-state.json").toString());
        registry.add("cutdemo.seed-demo-data", () -> false);
        registry.add("cutdemo.auth.enabled", () -> true);
        registry.add("cutdemo.auth.secret", () -> TEST_SECRET);
        registry.add("cutdemo.auth.token-ttl-hours", () -> 4);
    }

    @Value("${local.server.port}")
    int port;

    @Autowired
    SecurityCredentialStore credentialStore;

    @Autowired
    OperationAuditStore auditStore;

    @Autowired
    SecurityAdminService securityAdminService;

    private final HttpClient http = HttpClient.newHttpClient();
    private final JsonMapper json = JsonMapper.builder().build();

    private HttpResponse<String> send(String method, String path, Object body, String token) throws Exception {
        var builder = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .header("Accept", "application/json");
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        if (body == null) {
            builder.method(method, HttpRequest.BodyPublishers.noBody());
        } else {
            builder.header("Content-Type", "application/json");
            builder.method(method, HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        }
        return http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    private String loginToken(String username, String password) throws Exception {
        var res = send("POST", "/api/v2/auth/login", Map.of("username", username, "password", password), null);
        assertEquals(200, res.statusCode(), res.body());
        return json.readTree(res.body()).get("token").asString();
    }

    private long countActiveAdmins() {
        return credentialStore.listUsers().stream()
                .filter(u -> AuthContext.ROLE_ADMIN.equals(u.role()) && u.enabled())
                .count();
    }

    private String invokeDisableForResult(CyclicBarrier barrier, String targetUsername) throws Exception {
        barrier.await(10, TimeUnit.SECONDS);
        try {
            securityAdminService.updateUserStatus(targetUsername, false);
            return "SUCCESS";
        } catch (IllegalStateException ex) {
            if (ex.getMessage() != null && ex.getMessage().contains("不能禁用最后一个活跃管理员账号")) {
                return "CONFLICT_LAST_ADMIN";
            }
            throw ex;
        }
    }

    @Test
    void jdbcPbkdf2SeedLogoutPasswordChangeUserAdminAgentIsolationAndAuditWorkEndToEnd() throws Exception {
        // 1. 校验 DB 种子用户全部为 PBKDF2WithHmacSHA256 哈希，绝不存明文
        var storedAdmin = credentialStore.findUser("admin").orElseThrow();
        assertTrue(storedAdmin.passwordHash().startsWith("pbkdf2_sha256$"));
        assertTrue(PasswordHasher.matches("admin123", storedAdmin.passwordHash()));
        assertFalse(storedAdmin.passwordHash().contains("admin123"));

        // 2. 错误登录返回 401 且写失败审计
        var badLogin = send("POST", "/api/v2/auth/login", Map.of("username", "planner", "password", "wrong-pass"), null);
        assertEquals(401, badLogin.statusCode());

        String adminToken = loginToken("admin", "admin123");
        String plannerToken = loginToken("planner", "planner123");

        // 3. 校验 /auth/me 与非管理员访问安全管理/审计日志（含 GET）返回 403
        var meRes = send("GET", "/api/v2/auth/me", null, plannerToken);
        assertEquals(200, meRes.statusCode());
        JsonNode meJson = json.readTree(meRes.body());
        assertEquals("USER", meJson.get("actorType").asString());
        assertEquals("PLANNER", meJson.get("role").asString());

        assertEquals(403, send("GET", "/api/v2/users", null, plannerToken).statusCode());
        assertEquals(403, send("GET", "/api/v2/agents", null, plannerToken).statusCode());
        assertEquals(403, send("GET", "/api/v2/audit-logs", null, plannerToken).statusCode());
        assertEquals(401, send("GET", "/api/v2/optimization-jobs/JOB-MISSING/events", null, null).statusCode());

        // 4. 管理员创建用户、更新角色、重置密码、禁用用户（tokenVersion 递增使旧令牌 401）及禁最后一个 ADMIN 保护
        var createUserRes = send("POST", "/api/v2/users", Map.of(
                "username", "qa_user",
                "displayName", "质量专员",
                "role", "INSPECTOR",
                "password", "initPass123"
        ), adminToken);
        assertEquals(201, createUserRes.statusCode(), createUserRes.body());
        String qaToken1 = loginToken("qa_user", "initPass123");
        assertEquals(200, send("GET", "/api/v2/rolls", null, qaToken1).statusCode());

        // 自主改密：旧密码不变拦截，改密成功旧 token 立即 401
        assertEquals(400, send("PUT", "/api/v2/auth/password",
                Map.of("currentPassword", "wrong", "newPassword", "newPass456"), qaToken1).statusCode());
        var changePwdRes = send("PUT", "/api/v2/auth/password",
                Map.of("currentPassword", "initPass123", "newPassword", "newPass456"), qaToken1);
        assertEquals(200, changePwdRes.statusCode(), changePwdRes.body());
        assertEquals(401, send("GET", "/api/v2/rolls", null, qaToken1).statusCode(), "改密后原 Token 必须立即失效");

        // 重建 AuthService 模拟重启：DB 密码应保持新密码，绝不被 DEFAULT_USERS 覆盖
        AuthService restartedAuth = new AuthService(true, TEST_SECRET, "", 4, Clock.systemUTC(), credentialStore);
        assertTrue(restartedAuth.authenticate("qa_user", "initPass123").isEmpty());
        assertTrue(restartedAuth.authenticate("qa_user", "newPass456").isPresent());

        // 登出吊销 jti
        String qaToken2 = loginToken("qa_user", "newPass456");
        assertEquals(200, send("POST", "/api/v2/auth/logout", null, qaToken2).statusCode());
        assertEquals(401, send("GET", "/api/v2/rolls", null, qaToken2).statusCode(), "登出后原 jti 必须立即失效");

        // 管理员禁用账号 + 重置密码 + 最后一个 ADMIN 保护
        String qaToken3 = loginToken("qa_user", "newPass456");
        var disableRes = send("POST", "/api/v2/users/qa_user/status", Map.of("enabled", false), adminToken);
        assertEquals(200, disableRes.statusCode());
        assertEquals(401, send("GET", "/api/v2/rolls", null, qaToken3).statusCode(), "禁用账号后存量 Token 必须 401");
        assertEquals(401, send("POST", "/api/v2/auth/login",
                Map.of("username", "qa_user", "password", "newPass456"), null).statusCode());
        assertEquals(409, send("POST", "/api/v2/users/admin/status",
                Map.of("enabled", false), adminToken).statusCode(), "禁止禁用最后一个活跃 ADMIN");

        // 5. AI Agent 凭证签发、作用域隔离、不可确认落库、吊销 401
        var issueAgentRes = send("POST", "/api/v2/agents", Map.of(
                "name", "排产助理Agent",
                "scopes", List.of("DEMAND_READ", "PLAN_COMPUTE", "DRAFT_WRITE"),
                "description", "仅允许读需求/计算试排/写草案"
        ), adminToken);
        assertEquals(201, issueAgentRes.statusCode(), issueAgentRes.body());
        JsonNode issuedBody = json.readTree(issueAgentRes.body());
        String agentId = issuedBody.get("agent").get("agentId").asString();
        String agentToken = issuedBody.get("token").asString();
        assertFalse(agentToken.isBlank());

        // 列表查询不暴露明文 Token
        var agentsListRes = send("GET", "/api/v2/agents", null, adminToken);
        assertEquals(200, agentsListRes.statusCode());
        assertFalse(agentsListRes.body().contains(agentToken));

        // Agent /me 验证
        var agentMeRes = send("GET", "/api/v2/auth/me", null, agentToken);
        assertEquals(200, agentMeRes.statusCode());
        JsonNode agentMe = json.readTree(agentMeRes.body());
        assertEquals("AGENT", agentMe.get("actorType").asString());
        assertEquals(agentId, agentMe.get("agentId").asString());

        // Agent 权限范围内接口允许通过
        assertEquals(200, send("GET", "/api/v2/demand-pool", null, agentToken).statusCode());
        assertEquals(200, send("GET", "/api/v2/capabilities", null, agentToken).statusCode());
        assertEquals(200, send("GET", "/api/v2/workbench/drafts", null, agentToken).statusCode());

        // Agent 越权（缺乏 DEMAND_WRITE、确认落库、入库、用户管理、登出）一律返回 403
        assertEquals(403, send("POST", "/api/v2/demand-pool", Map.of("name", "越权建单"), agentToken).statusCode());
        assertEquals(403, send("POST", "/api/v2/schemes/confirm", Map.of(), agentToken).statusCode());
        assertEquals(403, send("POST", "/api/v2/workbench/drafts/DFT-1/confirm", Map.of(), agentToken).statusCode());
        assertEquals(403, send("POST", "/api/v2/inventory-receipts", Map.of(), agentToken).statusCode());
        assertEquals(403, send("GET", "/api/v2/users", null, agentToken).statusCode());
        assertEquals(403, send("POST", "/api/v2/auth/logout", null, agentToken).statusCode());

        // 吊销 Agent 后立即返回 401（含 SSE 路径）
        assertEquals(200, send("POST", "/api/v2/agents/" + agentId + "/revoke", Map.of("reason", "测试吊销"), adminToken).statusCode());
        assertEquals(401, send("GET", "/api/v2/demand-pool", null, agentToken).statusCode());
        assertEquals(401, send("GET", "/api/v2/optimization-jobs/JOB-1/events", null, agentToken).statusCode());

        // 6. 业务写操作经 OperationAuditFilter 落库审计 + ROLL_LENGTH_MISMATCH 修复验证
        var rollSaveRes = send("POST", "/api/v2/rolls", Map.of(
                "rollId", "ROLL-M3-PARTIAL-01",
                "rollModel", "M3-TC",
                "width", 1500.0,
                "totalLength", 50000.0,
                "usedLength", 12000.0,
                "currentRemainingLength", 0.0,
                "inspectionStatus", "PASSED"
        ), adminToken);
        assertEquals(200, rollSaveRes.statusCode(), rollSaveRes.body());
        JsonNode savedRoll = json.readTree(rollSaveRes.body());
        assertEquals(38000.0, savedRoll.get("currentRemainingLength").asDouble(), 0.001);

        var reconcileRes = send("GET", "/api/v2/inventory-ledger/reconciliation", null, adminToken);
        assertEquals(200, reconcileRes.statusCode());
        assertEquals("BALANCED", json.readTree(reconcileRes.body()).get("status").asString());

        // 7. 审计日志分页检索校验（按单据、操作人、动作与脱敏校验）
        var rollAuditRes = send("GET", "/api/v2/audit-logs?targetId=ROLL-M3-PARTIAL-01&action=ROLL_SAVE", null, adminToken);
        assertEquals(200, rollAuditRes.statusCode(), rollAuditRes.body());
        JsonNode rollAuditPage = json.readTree(rollAuditRes.body());
        assertTrue(rollAuditPage.get("total").asLong() >= 1);
        assertEquals("ROLL_SAVE", rollAuditPage.get("items").get(0).get("action").asString());

        var deniedAuditRes = send("GET", "/api/v2/audit-logs?actorType=AGENT&action=ACCESS_DENIED", null, adminToken);
        assertEquals(200, deniedAuditRes.statusCode());
        assertTrue(json.readTree(deniedAuditRes.body()).get("total").asLong() >= 5);

        // 8. 矩阵参数、编码分号与路径穿越对抗回归（真实 Spring Boot HTTP 端口 + MVC 路由）
        for (String bypassPath : List.of(
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
                "/api/v2/./users"
        )) {
            var bypassRes = send("GET", bypassPath, null, plannerToken);
            assertEquals(403, bypassRes.statusCode(), "普通角色禁止通过路径变体越权读取: " + bypassPath + " body=" + bypassRes.body());
        }
        assertEquals(200, send("GET", "/api/v2/users;foo=bar", null, adminToken).statusCode());

        // 携带矩阵参数的已认证写请求放行且完整记录审计，随后验证更新已有母卷为 SCRAPPED 必被拒绝且账本保持 BALANCED
        var matrixRollSaveRes = send("POST", "/api/v2/rolls;foo=bar", Map.of(
                "rollId", "ROLL-M3-MATRIX-01",
                "rollModel", "M3-TC",
                "width", 1500.0,
                "totalLength", 50000.0,
                "usedLength", 0.0,
                "currentRemainingLength", 50000.0,
                "inspectionStatus", "PASSED"
        ), adminToken);
        assertEquals(200, matrixRollSaveRes.statusCode(), matrixRollSaveRes.body());
        var matrixAuditRes = send("GET", "/api/v2/audit-logs?targetId=ROLL-M3-MATRIX-01&action=ROLL_SAVE", null, adminToken);
        assertEquals(200, matrixAuditRes.statusCode());
        JsonNode matrixAuditPage = json.readTree(matrixAuditRes.body());
        assertTrue(matrixAuditPage.get("total").asLong() >= 1, "携带矩阵参数的写操作必须落盘审计");

        for (String illegalScrapStatus : List.of("SCRAPPED", " scrapped ")) {
            var scrapViaSaveRes = send("POST", "/api/v2/rolls", Map.of(
                    "rollId", "ROLL-M3-MATRIX-01",
                    "rollModel", "M3-TC",
                    "width", 1500.0,
                    "totalLength", 50000.0,
                    "usedLength", 0.0,
                    "currentRemainingLength", 50000.0,
                    "inspectionStatus", illegalScrapStatus
            ), adminToken);
            assertEquals(400, scrapViaSaveRes.statusCode(), "禁止通过档案保存将已有母卷改写为 SCRAPPED: " + scrapViaSaveRes.body());
        }
        var rollAfterRejectedScrap = send("GET", "/api/v2/rolls/ROLL-M3-MATRIX-01", null, adminToken);
        assertEquals(200, rollAfterRejectedScrap.statusCode());
        assertEquals("PASSED", json.readTree(rollAfterRejectedScrap.body()).get("inspectionStatus").asString());

        var reconcileAfterRejectedScrap = send("GET", "/api/v2/inventory-ledger/reconciliation", null, adminToken);
        assertEquals(200, reconcileAfterRejectedScrap.statusCode());
        assertEquals("BALANCED", json.readTree(reconcileAfterRejectedScrap.body()).get("status").asString());

        // 确认全量审计表绝不泄露密码明文或签名 Token
        var allAudits = auditStore.query(new OperationAuditStore.AuditQuery(null, null, null, null, null, null, null, null, 0, 200));
        String serializedAll = json.writeValueAsString(allAudits);
        assertFalse(serializedAll.contains("initPass123"));
        assertFalse(serializedAll.contains("newPass456"));
        assertFalse(serializedAll.contains(agentToken));
    }

    @Test
    void fileStorageStoresSecurityCredentialsAuditsAndEnforcesRollLengthConservation() {
        Path fileDir = temp.resolve("file-sec-unit");
        FileSecurityCredentialStore fileSec = new FileSecurityCredentialStore(fileDir.resolve("sec").toString());
        FileOperationAuditStore fileAudit = new FileOperationAuditStore(fileDir.resolve("aud").toString());
        AuthService auth = new AuthService(true, TEST_SECRET, "", 2, Clock.systemUTC(), fileSec);

        // 重建实例验证 File 持久化与 PBKDF2 校验
        var token = auth.authenticate("planner", "planner123").orElseThrow().token();
        assertTrue(auth.verifyToken(token).isPresent());
        auth.changePassword("planner", "planner123", "plannerNew999");

        FileSecurityCredentialStore reloadedSec = new FileSecurityCredentialStore(fileDir.resolve("sec").toString());
        AuthService reloadedAuth = new AuthService(true, TEST_SECRET, "", 2, Clock.systemUTC(), reloadedSec);
        assertTrue(reloadedAuth.verifyToken(token).isEmpty());
        assertTrue(reloadedAuth.authenticate("planner", "plannerNew999").isPresent());

        fileAudit.append(new OperationAuditStore.AuditRecord(
                "AUD-FILE-1", System.currentTimeMillis(), "planner", AuthContext.ACTOR_USER, "PLANNER",
                null, "AUTH_PASSWORD_CHANGE", "USER", "planner", "PUT", "/api/v2/auth/password",
                "SUCCESS", 200, "trace-1", "127.0.0.1", "{}"
        ));
        assertEquals(1L, fileAudit.query(new OperationAuditStore.AuditQuery(
                "planner", null, "AUTH_PASSWORD_CHANGE", null, null, null, null, null, 0, 10)).total());

        // File 模式下验证 ROLL_LENGTH_MISMATCH 修复与守恒前置拦截
        RemnantService svc = new RemnantService(new FileInventoryStore(fileDir.resolve("inv.json").toString()), false);
        MotherRollInfo partial = new MotherRollInfo("ROLL-CONSERVE-1", "M-1", 1500, 50000, 0, 0);
        partial.setUsedLength(10000);
        partial.setCurrentRemainingLength(0);
        MotherRollInfo saved = svc.saveOrUpdateMotherRoll(partial);
        assertEquals(40000.0, saved.getCurrentRemainingLength(), 0.001);
        assertEquals("BALANCED", svc.reconcileInventory().get("status"));

        MotherRollInfo invalid = new MotherRollInfo("ROLL-BAD-1", "M-1", 1500, 50000, 0, 0);
        invalid.setUsedLength(10000);
        invalid.setCurrentRemainingLength(45000);
        assertThrows(IllegalArgumentException.class, () -> svc.saveOrUpdateMotherRoll(invalid));
    }

    @Test
    void percentEncodedPathsNewRollConservationAndConcurrentAdminDisableAreHardened() throws Exception {
        String adminToken = loginToken("admin", "admin123");
        String plannerToken = loginToken("planner", "planner123");
        String warehouseToken = loginToken("warehouse", "warehouse123");

        // 1. 百分比编码路径段绕过对抗（真实 Spring Boot HTTP 端口 + MVC 路由）
        for (String encodedBypass : List.of(
                "/api/v2/%75sers",
                "/api/v2/u%73ers",
                "/api/v2/%55sers",
                "/api/v2/%61gents",
                "/api/v2/audit%2dlogs",
                "/api/v2/%75sers;foo=bar"
        )) {
            var res = send("GET", encodedBypass, null, plannerToken);
            assertEquals(403, res.statusCode(), "普通角色禁止通过百分比编码绕过管理端点: " + encodedBypass + " body=" + res.body());
        }

        // 百分比编码写操作不逃逸 OperationAuditFilter 审计
        long beforeConfirmAudit = json.readTree(
                send("GET", "/api/v2/audit-logs?actor=planner&action=SCHEME_CONFIRM", null, adminToken).body()
        ).get("total").asLong();
        var encodedConfirmRes = send("POST", "/api/v2/schemes/%63onfirm", Map.of(), plannerToken);
        assertEquals(400, encodedConfirmRes.statusCode(), "百分比编码confirm应路由至控制器而非被误拦: " + encodedConfirmRes.body());
        long afterConfirmAudit = json.readTree(
                send("GET", "/api/v2/audit-logs?actor=planner&action=SCHEME_CONFIRM", null, adminToken).body()
        ).get("total").asLong();
        assertTrue(afterConfirmAudit > beforeConfirmAudit, "POST /api/v2/schemes/%63onfirm 必须写入 SCHEME_CONFIRM 审计");

        // 含 %20 与 UTF-8 中文编码的合法业务路径正常 200
        assertEquals(200, send("POST", "/api/v2/rolls", Map.of(
                "rollId", "ROLL 01",
                "rollModel", "M3-TC",
                "width", 1500.0,
                "totalLength", 50000.0,
                "usedLength", 0.0,
                "currentRemainingLength", 50000.0,
                "inspectionStatus", "PASSED"
        ), warehouseToken).statusCode());
        assertEquals(200, send("GET", "/api/v2/rolls/ROLL%2001", null, plannerToken).statusCode());
        var scrapRoll01Res = send("POST", "/api/v2/rolls/ROLL%2001/scrap",
                Map.of("idempotencyKey", "scrap-roll-01-pct20", "reason", "编码路径报废"), warehouseToken);
        assertEquals(200, scrapRoll01Res.statusCode(), scrapRoll01Res.body());

        assertEquals(200, send("POST", "/api/v2/rolls", Map.of(
                "rollId", "ROLL-布料",
                "rollModel", "M3-TC",
                "width", 1500.0,
                "totalLength", 50000.0,
                "usedLength", 0.0,
                "currentRemainingLength", 50000.0,
                "inspectionStatus", "PASSED"
        ), warehouseToken).statusCode());
        assertEquals(200, send("GET", "/api/v2/rolls/ROLL-%E5%B8%83%E6%96%99", null, plannerToken).statusCode());

        // 2. 新建母卷不守恒必须被 400 拒绝且全库对账保持 BALANCED
        var newScrapBad = send("POST", "/api/v2/rolls", Map.of(
                "rollId", "ROLL-NEW-SCRAP-BAD-HTTP",
                "rollModel", "M3-TC",
                "width", 1500.0,
                "totalLength", 50000.0,
                "usedLength", 0.0,
                "currentRemainingLength", 50000.0,
                "inspectionStatus", "SCRAPPED"
        ), warehouseToken);
        assertEquals(400, newScrapBad.statusCode(), "新建 SCRAPPED 母卷但余长 > 0 必须返回 400: " + newScrapBad.body());

        var newPassedWithScrapBad = send("POST", "/api/v2/rolls", Map.of(
                "rollId", "ROLL-NEW-PASSED-SCRAP-BAD-HTTP",
                "rollModel", "M3-TC",
                "width", 1500.0,
                "totalLength", 50000.0,
                "usedLength", 0.0,
                "currentRemainingLength", 45000.0,
                "scrappedLengthMm", 5000.0,
                "inspectionStatus", "PASSED"
        ), warehouseToken);
        assertEquals(400, newPassedWithScrapBad.statusCode(), "新建 PASSED 母卷但报废长度 > 0 必须返回 400: " + newPassedWithScrapBad.body());

        var reconRes = send("GET", "/api/v2/inventory-ledger/reconciliation", null, adminToken);
        assertEquals(200, reconRes.statusCode());
        assertEquals("BALANCED", json.readTree(reconRes.body()).get("status").asString());

        // 3. 方案 A（HTTP 全链并发互相禁用 10 轮 CyclicBarrier）：允许合法集合 {200+401, 200+409}，禁双 200 与 500/503，并验证旧 Token 即时 401 失效
        if (credentialStore.findUser("admin2").isEmpty()) {
            var createAdmin2 = send("POST", "/api/v2/users", Map.of(
                    "username", "admin2",
                    "displayName", "第二管理员",
                    "role", "ADMIN",
                    "password", "admin2Pass123"
            ), adminToken);
            assertEquals(201, createAdmin2.statusCode(), createAdmin2.body());
        } else {
            assertEquals(200, send("POST", "/api/v2/users/admin2/status", Map.of("enabled", true), adminToken).statusCode());
        }
        assertEquals(2L, countActiveAdmins(), "并发回归前活跃 ADMIN 必须严格为 2（admin 与 admin2）");

        try {
            var pool = Executors.newFixedThreadPool(2);
            try {
                for (int round = 1; round <= 10; round++) {
                    String tAdmin1 = loginToken("admin", "admin123");
                    String tAdmin2 = loginToken("admin2", "admin2Pass123");
                    CyclicBarrier barrier = new CyclicBarrier(2);
                    Future<Integer> f1 = pool.submit(() -> {
                        barrier.await(10, TimeUnit.SECONDS);
                        return send("POST", "/api/v2/users/admin2/status", Map.of("enabled", false), tAdmin1).statusCode();
                    });
                    Future<Integer> f2 = pool.submit(() -> {
                        barrier.await(10, TimeUnit.SECONDS);
                        return send("POST", "/api/v2/users/admin/status", Map.of("enabled", false), tAdmin2).statusCode();
                    });
                    int s1 = f1.get(15, TimeUnit.SECONDS);
                    int s2 = f2.get(15, TimeUnit.SECONDS);
                    assertNotEquals(503, s1, "第 " + round + " 轮触发并发死锁/存储不可用 503 (f1)");
                    assertNotEquals(503, s2, "第 " + round + " 轮触发并发死锁/存储不可用 503 (f2)");
                    assertNotEquals(500, s1, "第 " + round + " 轮触发服务端异常 500 (f1)");
                    assertNotEquals(500, s2, "第 " + round + " 轮触发服务端异常 500 (f2)");

                    boolean admin1Won = (s1 == 200) && (s2 == 409 || s2 == 401);
                    boolean admin2Won = (s2 == 200) && (s1 == 409 || s1 == 401);
                    assertTrue(admin1Won ^ admin2Won,
                            "第 " + round + " 轮必须严格为 1 个 200 + 1 个 ∈ {401, 409}，实际: s1=" + s1 + ", s2=" + s2);

                    assertEquals(1L, countActiveAdmins(), "第 " + round + " 轮并发后活跃 ADMIN 必须严格等于 1");
                    boolean admin1Enabled = credentialStore.findUser("admin").orElseThrow().enabled();
                    boolean admin2Enabled = credentialStore.findUser("admin2").orElseThrow().enabled();
                    assertEquals(admin1Won, admin1Enabled, "第 " + round + " 轮 admin 启用状态应与胜负一致");
                    assertEquals(admin2Won, admin2Enabled, "第 " + round + " 轮 admin2 启用状态应与胜负一致");

                    String loserOldToken = admin1Won ? tAdmin2 : tAdmin1;
                    assertEquals(401, send("GET", "/api/v2/users", null, loserOldToken).statusCode(),
                            "第 " + round + " 轮被禁用管理员的存量令牌必须立即返回 401");

                    // 使用实际 200 胜方重新登录获取有效令牌并复位败方，恢复双活跃 ADMIN
                    if (admin1Won) {
                        String freshAdmin1 = loginToken("admin", "admin123");
                        assertEquals(200, send("POST", "/api/v2/users/admin2/status", Map.of("enabled", true), freshAdmin1).statusCode());
                    } else {
                        String freshAdmin2 = loginToken("admin2", "admin2Pass123");
                        assertEquals(200, send("POST", "/api/v2/users/admin/status", Map.of("enabled", true), freshAdmin2).statusCode());
                    }
                    assertEquals(2L, countActiveAdmins(), "第 " + round + " 轮复位后活跃 ADMIN 必须恢复为 2");
                }

                // 4. 方案 B（Service/DB 事务层确定性并发回归，绕过 HTTP Filter 抢跑，直接压测 JdbcSecurityCredentialStore 锁序）：
                // 10/10 轮必须严格产生 1×SUCCESS + 1×CONFLICT_LAST_ADMIN（对应 HTTP 409），零死锁/DataAccessException
                assertEquals(2L, countActiveAdmins(), "Service/DB 并发回归前活跃 ADMIN 必须严格为 2");
                for (int round = 1; round <= 10; round++) {
                    CyclicBarrier dbBarrier = new CyclicBarrier(2);
                    Future<String> r1 = pool.submit(() -> invokeDisableForResult(dbBarrier, "admin2"));
                    Future<String> r2 = pool.submit(() -> invokeDisableForResult(dbBarrier, "admin"));
                    String o1 = r1.get(15, TimeUnit.SECONDS);
                    String o2 = r2.get(15, TimeUnit.SECONDS);

                    boolean firstWon = "SUCCESS".equals(o1) && "CONFLICT_LAST_ADMIN".equals(o2);
                    boolean secondWon = "SUCCESS".equals(o2) && "CONFLICT_LAST_ADMIN".equals(o1);
                    assertTrue(firstWon ^ secondWon,
                            "Service/DB 并发第 " + round + " 轮必须严格为 1×SUCCESS + 1×CONFLICT_LAST_ADMIN，实际: o1=" + o1 + ", o2=" + o2);
                    assertEquals(1L, countActiveAdmins(), "Service/DB 并发第 " + round + " 轮后活跃 ADMIN 必须严格等于 1");

                    // 第 10 轮验证仅剩唯一活跃管理员时，通过 HTTP 接口禁用自己确定性返回 409
                    if (round == 10) {
                        String soleWinner = firstWon ? "admin" : "admin2";
                        String soleWinnerPass = firstWon ? "admin123" : "admin2Pass123";
                        String soleToken = loginToken(soleWinner, soleWinnerPass);
                        assertEquals(409,
                                send("POST", "/api/v2/users/" + soleWinner + "/status", Map.of("enabled", false), soleToken).statusCode(),
                                "仅剩唯一活跃 ADMIN 时通过 HTTP 禁用自己必须确定性返回 409");
                    }

                    String disabledUser = firstWon ? "admin2" : "admin";
                    assertTrue(securityAdminService.updateUserStatus(disabledUser, true).enabled());
                    assertEquals(2L, countActiveAdmins(), "Service/DB 并发第 " + round + " 轮复位后活跃 ADMIN 必须恢复为 2");
                }
            } finally {
                pool.shutdownNow();
            }
        } finally {
            // 恢复仅剩 admin 一个活跃管理员，确保与现有单测完全隔离互不干扰（不抛出覆盖 try 块真实断言失败的异常）
            try {
                if (credentialStore.findUser("admin").map(u -> !u.enabled()).orElse(false)) {
                    credentialStore.updateUserStatus("admin", true, System.currentTimeMillis());
                }
                if (credentialStore.findUser("admin2").map(SecurityCredentialStore.UserRecord::enabled).orElse(false)) {
                    credentialStore.updateUserStatus("admin2", false, System.currentTimeMillis());
                }
            } catch (RuntimeException ignored) {
                // ignore cleanup failure
            }
        }
    }
}
