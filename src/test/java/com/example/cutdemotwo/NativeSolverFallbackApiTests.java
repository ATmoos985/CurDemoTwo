package com.example.cutdemotwo;

import com.example.cutdemotwo.business.model.PieceDemand;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** A server without the native rectangle executable must say so and label every layout with the Java engine. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class NativeSolverFallbackApiTests {
    @TempDir static Path temp;
    @DynamicPropertySource static void properties(DynamicPropertyRegistry r) {
        r.add("cutdemo.state.path", () -> temp.resolve("state.json").toString());
        r.add("cutdemo.seed-demo-data", () -> false);
        r.add("packingsolver.executable.path", () -> temp.resolve("missing-packingsolver.exe").toString());
    }
    @Value("${local.server.port}") int port;
    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newHttpClient();

    private HttpResponse<String> send(String path, String body) throws Exception {
        var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path));
        if (body != null) request.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body));
        return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test void healthReportsTheMissingNativeEngineAndTheFallbackThatWillRun() throws Exception {
        var response = send("/api/health", null);
        assertEquals(200, response.statusCode(), response.body());
        var health = json.readTree(response.body());
        assertFalse(health.get("packingsolverAvailable").asBoolean(), response.body());
        assertEquals("javaguillotine", health.get("packingsolverFallback").asText(), response.body());

        var engines = json.readTree(send("/api/v1/nesting/engines", null).body());
        for (var engine : engines) if ("packingsolver".equals(engine.get("id").asText()))
            assertFalse(engine.get("available").asBoolean(), "engine discovery must not claim the native engine");
    }

    @Test void standardSolveNamesTheJavaEngineAndExplainsTheFallback() throws Exception {
        var response = send("/api/v1/nesting/solve", json.writeValueAsString(NativeSolverFallbackTests.guillotine("packingsolver")));
        assertEquals(200, response.statusCode(), response.body());
        var result = json.readValue(response.body(), NestingResult.class);
        assertEquals("FEASIBLE", result.status(), result.message());
        assertEquals("javaguillotine", result.engine());
        assertEquals("packingsolver", result.requestedEngine());
        assertNotNull(result.fallbackReason());
    }

    @Test void legacySolveAndItsSavedPlanKeepTheActualEngineAndFallbackReason() throws Exception {
        assertEquals(200, send("/api/rolls", "{\"rollId\":\"ROLL-FALLBACK\",\"rollModel\":\"MODEL\",\"width\":1000,\"totalLength\":10000}").statusCode());
        var request = new SolveRequest();
        request.setRollId("ROLL-FALLBACK");
        request.setRollW(1000); request.setRollL(2000); request.setTotalRollL(10000);
        request.setCutOrigin("left-top"); request.setTimeLimitSeconds(1); request.setSolver("packingsolver");
        request.setDemands(List.of(new PieceDemand(1, "裁片", 400, 600, 2, false)));
        var response = send("/api/solve", json.writeValueAsString(request));
        assertEquals(200, response.statusCode(), response.body());
        var body = json.readTree(response.body());
        assertTrue(body.get("success").asBoolean(), response.body());
        assertEquals("javaguillotine", body.get("engine").asText());
        assertEquals("packingsolver", body.get("requestedEngine").asText());
        String reason = body.get("fallbackReason").asText();
        assertFalse(reason.isBlank());

        var plan = json.readTree(send("/api/cutting/plans/" + body.get("planId").asText(), null).body());
        assertEquals("javaguillotine", plan.get("result").get("engine").asText());
        assertEquals(reason, plan.get("result").get("fallbackReason").asText());
    }
}
