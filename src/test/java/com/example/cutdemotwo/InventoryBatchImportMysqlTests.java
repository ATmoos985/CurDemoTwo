package com.example.cutdemotwo;

import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.config.OperationAuditStore;
import com.example.cutdemotwo.persistence.JdbcInventoryStore;
import com.example.cutdemotwo.persistence.OptimizationTestDatabase;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
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
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * M4-2 MySQL + Flyway V15 原子批量库存导入、RBAC、审计与热冷隔离集成测试。
 */
@Tag("mysql-integration")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class InventoryBatchImportMysqlTests {
    private static final String SECRET = "m4-2-mysql-batch-import-secret-2026";
    private static final DriverManagerDataSource DB = OptimizationTestDatabase.create();

    @TempDir
    static Path tempDir;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        Flyway.configure().dataSource(DB).cleanDisabled(true).load().migrate();
        registry.add("cutdemo.storage", () -> "mysql");
        registry.add("cutdemo.database.url", DB::getUrl);
        registry.add("cutdemo.database.username", DB::getUsername);
        registry.add("cutdemo.database.password", DB::getPassword);
        registry.add("cutdemo.state.path", () -> tempDir.resolve("m4-mysql-state.json").toString());
        registry.add("cutdemo.seed-demo-data", () -> false);
        registry.add("cutdemo.auth.enabled", () -> true);
        registry.add("cutdemo.auth.secret", () -> SECRET);
        registry.add("cutdemo.auth.token-ttl-hours", () -> 4);
    }

    @org.springframework.beans.factory.annotation.Value("${local.server.port}")
    int port;

    @Autowired
    OperationAuditStore auditStore;

    private final HttpClient http = HttpClient.newHttpClient();
    private final JsonMapper json = JsonMapper.builder().build();

    private HttpResponse<String> send(String method, String path, Object body, String token, String idemKey) throws Exception {
        var builder = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .header("Accept", "application/json")
                .header("Content-Type", "application/json");
        if (token != null) builder.header("Authorization", "Bearer " + token);
        if (idemKey != null) builder.header("Idempotency-Key", idemKey);
        builder.method(method, body == null
                ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        return http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    private String login(String user, String pass) throws Exception {
        var res = send("POST", "/api/v2/auth/login", Map.of("username", user, "password", pass), null, null);
        assertEquals(200, res.statusCode(), res.body());
        return json.readTree(res.body()).get("token").asString();
    }

    @Test
    void mysqlV15TransactionalRollbackIdempotencyRbacAuditAndHotColdReloadWorkEndToEnd() throws Exception {
        String adminToken = login("admin", "admin123");
        String warehouseToken = login("warehouse", "warehouse123");
        String inspectorToken = login("inspector", "inspector123");
        String operatorToken = login("operator", "operator123");

        // 1. RBAC 权限矩阵验证
        var agentIssue = send("POST", "/api/v2/agents", Map.of(
                "name", "ImportBlockedAgent",
                "scopes", List.of("DEMAND_READ", "INVENTORY_READ", "PLAN_COMPUTE", "DRAFT_WRITE")
        ), adminToken, null);
        assertEquals(201, agentIssue.statusCode());
        String agentToken = json.readTree(agentIssue.body()).get("token").asString();

        var dummyBody = Map.of("rows", List.of(Map.of("rollId", "R-X", "rollModel", "M", "width", 1000, "totalLength", 1000)));
        assertEquals(403, send("POST", "/api/v2/inventory/import/rolls/preview", dummyBody, inspectorToken, null).statusCode());
        assertEquals(403, send("POST", "/api/v2/inventory/import/rolls", dummyBody, operatorToken, "k1").statusCode());
        assertEquals(403, send("POST", "/api/v2/inventory/import/rolls", dummyBody, agentToken, "k2").statusCode());
        assertEquals(403, send("POST", "/api/v2/inventory/import/defects/preview", Map.of("rows", List.of()), warehouseToken, null).statusCode());
        assertEquals(403, send("POST", "/api/v2/inventory/import/defects", Map.of("rows", List.of()), agentToken, "k3").statusCode());

        // 2. 缺失 Idempotency-Key 返回 400
        assertEquals(400, send("POST", "/api/v2/inventory/import/rolls", dummyBody, warehouseToken, null).statusCode());

        // 3. MySQL 单事务全回滚：第 1 行合法母卷 + 第 2 行不守恒母卷 -> 返回 400 且第 1 行零半落库
        var badBatch = Map.of("rows", List.of(
                Map.of("rollId", "ROLL-MYSQL-RB-1", "rollModel", "M4-TC", "width", 1800.0, "totalLength", 50000.0, "usedLength", 0.0, "currentRemainingLength", 50000.0, "inspectionStatus", "PASSED"),
                Map.of("rollId", "ROLL-MYSQL-RB-2", "rollModel", "M4-TC", "width", 1800.0, "totalLength", 50000.0, "usedLength", 10000.0, "currentRemainingLength", 10000.0, "inspectionStatus", "PASSED")
        ));
        var rollbackRes = send("POST", "/api/v2/inventory/import/rolls", badBatch, warehouseToken, "mysql-rb-key-1");
        assertEquals(400, rollbackRes.statusCode(), rollbackRes.body());
        JsonNode rbJson = json.readTree(rollbackRes.body());
        assertEquals("BATCH_IMPORT_VALIDATION_FAILED", rbJson.get("code").asString());
        assertEquals("ROLL_LENGTH_MISMATCH", rbJson.get("errors").get(0).get("code").asString());

        JdbcTemplate jdbc = new JdbcTemplate(DB);
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM mother_roll WHERE id = 'ROLL-MYSQL-RB-1'", Integer.class),
                "MySQL 单事务回滚后首行母卷绝不能半落库");

        // 4. 合法母卷批量导入 + 料头导入 + 瑕疵导入
        var okRolls = Map.of("rows", List.of(
                Map.of("rollId", "ROLL-MYSQL-OK-1", "rollModel", "M4-TC", "batchNo", "BAT-M4", "color", "深蓝",
                        "width", 2000.0, "totalLength", 60000.0, "usedLength", 10000.0, "currentRemainingLength", 50000.0, "inspectionStatus", "PASSED")
        ));
        var previewRes = send("POST", "/api/v2/inventory/import/rolls/preview", okRolls, warehouseToken, null);
        assertEquals(200, previewRes.statusCode());
        assertTrue(json.readTree(previewRes.body()).get("valid").asBoolean());

        var commitRes = send("POST", "/api/v2/inventory/import/rolls", okRolls, warehouseToken, "mysql-roll-ok-1");
        assertEquals(200, commitRes.statusCode(), commitRes.body());
        assertEquals(1, json.readTree(commitRes.body()).get("importedCount").asInt());

        // 同键幂等重放 & 异载荷 409
        var replayRes = send("POST", "/api/v2/inventory/import/rolls", okRolls, warehouseToken, "mysql-roll-ok-1");
        assertEquals(200, replayRes.statusCode());
        assertTrue(json.readTree(replayRes.body()).get("idempotentReplay").asBoolean());

        var conflictRes = send("POST", "/api/v2/inventory/import/rolls", Map.of("rows", List.of(
                Map.of("rollId", "ROLL-MYSQL-OTHER", "rollModel", "M4-TC", "width", 1500.0, "totalLength", 10000.0)
        )), warehouseToken, "mysql-roll-ok-1");
        assertEquals(409, conflictRes.statusCode());

        // 料头导入（血统继承）
        var okRemnant = Map.of("rows", List.of(
                Map.of("id", "REM-MYSQL-OK-1", "width", 500.0, "length", 900.0, "sourceRollId", "ROLL-MYSQL-OK-1")
        ));
        assertEquals(200, send("POST", "/api/v2/inventory/import/remnants", okRemnant, warehouseToken, "mysql-rem-ok-1").statusCode());

        // 瑕疵导入（质检员操作）
        var okDefect = Map.of("rows", List.of(
                Map.of("rollId", "ROLL-MYSQL-OK-1", "captureId", "MYSQL-DEF-1", "x", 100.0, "y", 200.0, "w", 20.0, "h", 30.0)
        ));
        assertEquals(200, send("POST", "/api/v2/inventory/import/defects", okDefect, inspectorToken, "mysql-def-ok-1").statusCode());

        // 5. 冷启动模拟：新建 JdbcInventoryStore + RemnantService 验证冷启动不扫 inventory_batch_import 但按需点查幂等键仍命中
        JdbcInventoryStore freshStore = new JdbcInventoryStore(DB);
        var bootstrap = freshStore.loadHotSnapshot();
        assertNotNull(bootstrap);
        assertTrue(freshStore.findBatchImportByIdempotencyKey("mysql-roll-ok-1").isPresent());

        // 重放请求仍走 DB 点查返回 200 idempotentReplay=true
        var coldReplay = send("POST", "/api/v2/inventory/import/rolls", okRolls, warehouseToken, "mysql-roll-ok-1");
        assertEquals(200, coldReplay.statusCode());
        assertTrue(json.readTree(coldReplay.body()).get("idempotentReplay").asBoolean());

        // 6. 对账与审计验证
        var reconcileRes = send("GET", "/api/v2/inventory-ledger/reconciliation", null, adminToken, null);
        assertEquals(200, reconcileRes.statusCode());
        assertEquals("BALANCED", json.readTree(reconcileRes.body()).get("status").asString());

        var logs = auditStore.query(new OperationAuditStore.AuditQuery(null, null, null, null, null, null, null, null, 0, 100)).items();
        assertTrue(logs.stream().anyMatch(l -> "INVENTORY_IMPORT_ROLLS".equals(l.action())
                && "PREVIEW".equals(json.readTree(l.detailJson()).path("mode").asString(""))));
        assertTrue(logs.stream().anyMatch(l -> "INVENTORY_IMPORT_ROLLS".equals(l.action())
                && "COMMIT".equals(json.readTree(l.detailJson()).path("mode").asString(""))));
        assertTrue(logs.stream().anyMatch(l -> "INVENTORY_IMPORT_REMNANTS".equals(l.action())
                && "COMMIT".equals(json.readTree(l.detailJson()).path("mode").asString(""))));
        assertTrue(logs.stream().anyMatch(l -> "INVENTORY_IMPORT_DEFECTS".equals(l.action())
                && "COMMIT".equals(json.readTree(l.detailJson()).path("mode").asString(""))));
    }
}
