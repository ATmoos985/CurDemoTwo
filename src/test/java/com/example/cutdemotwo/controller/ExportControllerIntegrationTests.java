package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.config.AuthService;
import com.example.cutdemotwo.config.OperationAuditStore;
import com.example.cutdemotwo.config.SecurityAdminService;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipInputStream;

import static org.junit.jupiter.api.Assertions.*;

/**
 * M4-2 导出控制器端到端 HTTP 集成测试（File 模式 + Auth + 防 OOM 审计）。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ExportControllerIntegrationTests {
    private static final String SECRET = "m4-2-export-integration-secret-key-2026";

    @TempDir
    static Path tempDir;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("cutdemo.storage", () -> "file");
        registry.add("cutdemo.state.path", () -> tempDir.resolve("export-state.json").toString());
        registry.add("cutdemo.seed-demo-data", () -> false);
        registry.add("cutdemo.auth.enabled", () -> true);
        registry.add("cutdemo.auth.secret", () -> SECRET);
        registry.add("cutdemo.auth.token-ttl-hours", () -> 4);
    }

    @Value("${local.server.port}")
    int port;

    @Autowired
    RemnantService remnantService;

    @Autowired
    OperationAuditStore auditStore;

    private final HttpClient http = HttpClient.newHttpClient();
    private final JsonMapper json = JsonMapper.builder().build();

    private String login(String user, String pass) throws Exception {
        var req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/v2/auth/login"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(Map.of("username", user, "password", pass))))
                .build();
        var res = http.send(req, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, res.statusCode(), res.body());
        return json.readTree(res.body()).get("token").asString();
    }

    private HttpResponse<byte[]> sendBytes(String method, String path, Object body, String token) throws Exception {
        var builder = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path));
        if (token != null) builder.header("Authorization", "Bearer " + token);
        if (body == null) {
            builder.method(method, HttpRequest.BodyPublishers.noBody());
        } else {
            builder.header("Content-Type", "application/json");
            builder.method(method, HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        }
        return http.send(builder.build(), HttpResponse.BodyHandlers.ofByteArray());
    }

    @Test
    void exportsAllFiveEndpointsWithRbacAgentIsolationAndStreamingAudit() throws Exception {
        remnantService.inWrite("SEED_EXPORT_IT", "SEED", "TEST", tx -> {
            tx.putScheme(new SchedulingScheme(
                    "SCH-IT-2D", "k-it-2d", "集成2D", "NESTING_2D",
                    "SC-1", "STR-1", "2D", "TASK-IT", "集成任务", "EXT-IT",
                    "VIRTUAL_ROLL", null, null, "TC-IT",
                    1500.0, 2000.0, 0.0, 800.0, 0.0, 0.0, 75.0, 0.5,
                    1, 1, 0, true, Map.of("1", 1), List.of(), null,
                    SchedulingScheme.STATE_READY_TO_CUT, null,
                    new SchedulingScheme.Layout2DPayload(
                            List.of(new SchedulingScheme.PlacementItem(1, 1, "P1", 10, 10, 200, 300, 0, false, Shape.rectangle(200, 300))),
                            List.of(), List.of()
                    ),
                    null, null, "2026-11-27 11:00:00", null, null, null, null
            ));
            tx.putScheme(new SchedulingScheme(
                    "SCH-IT-1D", "k-it-1d", "集成1D", "SLITTING_1D",
                    "SC-1", "STR-1D", "1D", "TASK-IT-1D", "分切集成", "EXT-IT-1D",
                    "VIRTUAL_ROLL", null, null, "TC-IT",
                    1600.0, 0.0, 0.0, 0.0, 0.0, 0.0, 95.0, 10.0,
                    2, 2, 0, true, Map.of(), List.of(), null,
                    SchedulingScheme.STATE_AWAITING_ROLL, null, null,
                    new SchedulingScheme.Slitting1DPayload(
                            10, 10, 100, 1600, 1, 0, 1000, 1, 0, 0,
                            List.of(new SchedulingScheme.SlittingPatternItem("PAT-IT", 1000, 1, 1580, 20, List.of())),
                            List.of()
                    ),
                    null, "2026-11-27 11:05:00", null, null, null, null
            ));
            return null;
        });

        String adminToken = login("admin", "admin123");
        String operatorToken = login("operator", "operator123");

        // 1. 未登录返回 401
        assertEquals(401, sendBytes("GET", "/api/v2/exports/schemes/SCH-IT-2D/ticket.pdf", null, null).statusCode());

        // 2. 操作员访问全部 5 个导出端点均放行
        var camRes = sendBytes("GET", "/api/v2/exports/schemes/SCH-IT-2D/cam?format=nc&overcutMm=1.5", null, operatorToken);
        assertEquals(200, camRes.statusCode());
        assertTrue(new String(camRes.body(), StandardCharsets.UTF_8).contains("M06 T01"));

        var slitRes = sendBytes("GET", "/api/v2/exports/schemes/SCH-IT-1D/slitting?format=csv", null, operatorToken);
        assertEquals(200, slitRes.statusCode());
        assertTrue(new String(slitRes.body(), StandardCharsets.UTF_8).contains("PAT-IT"));

        var pdfRes = sendBytes("GET", "/api/v2/exports/schemes/SCH-IT-2D/ticket.pdf", null, operatorToken);
        assertEquals(200, pdfRes.statusCode());
        assertTrue(new String(pdfRes.body(), StandardCharsets.ISO_8859_1).startsWith("%PDF-1.4\n"));

        var sumRes = sendBytes("GET", "/api/v2/exports/production-summary?format=xlsx", null, operatorToken);
        assertEquals(200, sumRes.statusCode());
        assertEquals("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                sumRes.headers().firstValue("Content-Type").orElse(""));

        var zipRes = sendBytes("POST", "/api/v2/exports/batch-zip", Map.of(
                "schemeIds", List.of("SCH-IT-2D"),
                "formats", List.of("dxf_lwpolyline", "ticket_pdf")
        ), operatorToken);
        assertEquals(200, zipRes.statusCode());
        try (ZipInputStream zis = new ZipInputStream(new ByteArrayInputStream(zipRes.body()), StandardCharsets.UTF_8)) {
            assertNotNull(zis.getNextEntry());
        }

        // 3. 404 与 400 映射
        var notFoundRes = sendBytes("GET", "/api/v2/exports/schemes/SCH-NO-SUCH/cam?format=plt", null, operatorToken);
        assertEquals(404, notFoundRes.statusCode());
        assertEquals("NOT_FOUND", json.readTree(notFoundRes.body()).get("code").asString());

        var badSlit = sendBytes("GET", "/api/v2/exports/schemes/SCH-IT-2D/slitting?format=json", null, operatorToken);
        assertEquals(400, badSlit.statusCode());
        assertEquals("INVALID_INPUT", json.readTree(badSlit.body()).get("code").asString());

        // 4. AI Agent 权限边界：INVENTORY_READ 允许 GET 导出，但严禁 POST /batch-zip (403)；无该 scope 连 GET 也 403
        var agentReadRes = sendBytes("POST", "/api/v2/agents", Map.of(
                "name", "ExportReadAgent",
                "scopes", List.of("INVENTORY_READ")
        ), adminToken);
        assertEquals(201, agentReadRes.statusCode());
        String agentReadToken = json.readTree(agentReadRes.body()).get("token").asString();

        var agentNoScopeRes = sendBytes("POST", "/api/v2/agents", Map.of(
                "name", "NoExportAgent",
                "scopes", List.of("DEMAND_READ")
        ), adminToken);
        assertEquals(201, agentNoScopeRes.statusCode());
        String agentNoScopeToken = json.readTree(agentNoScopeRes.body()).get("token").asString();

        assertEquals(200, sendBytes("GET", "/api/v2/exports/schemes/SCH-IT-2D/cam?format=plt", null, agentReadToken).statusCode());
        assertEquals(403, sendBytes("POST", "/api/v2/exports/batch-zip", Map.of("schemeIds", List.of("SCH-IT-2D")), agentReadToken).statusCode());
        assertEquals(403, sendBytes("GET", "/api/v2/exports/schemes/SCH-IT-2D/cam?format=plt", null, agentNoScopeToken).statusCode());

        // 5. 校验全部 5 个导出审计动作均已落库
        var logs = auditStore.query(new OperationAuditStore.AuditQuery(null, null, null, null, null, null, null, null, 0, 100)).items();
        List<String> actions = logs.stream().map(OperationAuditStore.AuditRecord::action).toList();
        assertTrue(actions.contains("EXPORT_CAM"));
        assertTrue(actions.contains("EXPORT_SLITTING"));
        assertTrue(actions.contains("EXPORT_TICKET_PDF"));
        assertTrue(actions.contains("EXPORT_PRODUCTION_SUMMARY"));
        assertTrue(actions.contains("EXPORT_BATCH_ZIP"));
    }
}
