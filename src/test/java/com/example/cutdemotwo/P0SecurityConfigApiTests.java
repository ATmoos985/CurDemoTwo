package com.example.cutdemotwo;

import com.example.cutdemotwo.business.cutting.SchedulingStudioService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
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
 * 验证 P0-5 生产安全硬开关：
 * 1. cutdemo.demo.endpoints-enabled=false 时 /api/demo/inventory 与 /api/rolls/{id}/reset 返回 403；
 * 2. cutdemo.mes.auth-required=true 与 cutdemo.mes.token 非空时，/api/v2/mes/* 强制校验 Bearer Token（缺/错返回 401，正确返回 200）。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class P0SecurityConfigApiTests {
    private static final String TEST_TOKEN = "prod-mes-bearer-token-2026";

    @TempDir
    static Path temp;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("cutdemo.state.path", () -> temp.resolve("security-state.json").toString());
        registry.add("cutdemo.seed-demo-data", () -> false);
        registry.add("cutdemo.demo.endpoints-enabled", () -> false);
        registry.add("cutdemo.mes.auth-required", () -> true);
        registry.add("cutdemo.mes.token", () -> TEST_TOKEN);
    }

    @Value("${local.server.port}")
    int port;

    private final HttpClient http = HttpClient.newHttpClient();
    private final JsonMapper json = JsonMapper.builder().build();

    private HttpResponse<String> post(String path, Object body, String authHeader) throws Exception {
        var req = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        if (authHeader != null) req.header("Authorization", authHeader);
        return http.send(req.build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> get(String path, String authHeader) throws Exception {
        var req = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).GET();
        if (authHeader != null) req.header("Authorization", authHeader);
        return http.send(req.build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void demoEndpointsReturn403WhenDisabled() throws Exception {
        var initRes = post("/api/demo/inventory", Map.of("confirmed", true), null);
        assertEquals(403, initRes.statusCode(), initRes.body());

        var resetRes = post("/api/rolls/ROLL-2026-0920/reset", Map.of("force", true), null);
        assertEquals(403, resetRes.statusCode(), resetRes.body());
    }

    @Test
    void mesEndpointsEnforceBearerAuthentication() throws Exception {
        var orderCmd = new SchedulingStudioService.MesOrderSyncCommand(
                "MES-AUTH-WO-1", "受保护工单", "MAT-SEC", "RECT_2D", 2000.0,
                List.of(new SchedulingStudioService.DemandLineInput(1, "片1", 500, 600, 2, false, null, null, null, null, null))
        );

        // 无 Authorization 头 -> 401
        assertEquals(401, post("/api/v2/mes/orders", orderCmd, null).statusCode());
        // 错误 Token -> 401
        assertEquals(401, post("/api/v2/mes/orders", orderCmd, "Bearer wrong-token").statusCode());
        assertEquals(401, post("/api/v2/mes/schemes/SCH-NONE/dispatch", Map.of(), null).statusCode());
        assertEquals(401, get("/api/v2/mes/dispatch-packages/SCH-NONE", "Basic abc").statusCode());
        assertEquals(401, post("/api/v2/mes/execution-feedback",
                new SchedulingStudioService.MesFeedbackCommand("SCH-NONE", "R1", null, null, null, null, null), null).statusCode());

        // 正确 Bearer Token -> 200
        var okRes = post("/api/v2/mes/orders", orderCmd, "Bearer " + TEST_TOKEN);
        assertEquals(200, okRes.statusCode(), okRes.body());
    }
}
