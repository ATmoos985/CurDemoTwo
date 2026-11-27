package com.example.cutdemotwo;

import com.example.cutdemotwo.contracts.jobs.OptimizationJob;
import com.example.cutdemotwo.contracts.jobs.OptimizationRequest;
import com.example.cutdemotwo.contracts.jobs.OptimizationResult;
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
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

/** A server without the native rectangle executable must say so and label every layout with the Java engine. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class NativeSolverFallbackApiTests {
    @TempDir static Path temp;
    @DynamicPropertySource static void properties(DynamicPropertyRegistry r) {
        r.add("cutdemo.state.path", () -> temp.resolve("state.json").toString());
        r.add("cutdemo.seed-demo-data", () -> false);
        r.add("packingsolver.executable.path", () -> temp.resolve("missing-packingsolver.exe").toString());
        r.add("packingsolver.irregular.executable.path", () -> temp.resolve("missing-packingsolver-irregular.exe").toString());
    }
    @Value("${local.server.port}") int port;
    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newHttpClient();

    private HttpResponse<String> send(String path, String body) throws Exception {
        return send(path, body, null);
    }

    private HttpResponse<String> send(String path, String body, String idempotencyKey) throws Exception {
        var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path));
        if (body != null) request.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body));
        if (idempotencyKey != null) request.header("Idempotency-Key", idempotencyKey);
        return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test void healthReportsTheMissingNativeEngineAndTheFallbackThatWillRun() throws Exception {
        for (String healthPath : java.util.List.of("/api/health", "/api/v2/health")) {
            var response = send(healthPath, null);
            assertEquals(200, response.statusCode(), response.body());
            var health = json.readTree(response.body());
            assertFalse(health.get("packingsolverAvailable").asBoolean(), response.body());
            assertEquals("javaguillotine", health.get("packingsolverFallback").asText(), response.body());
            assertFalse(health.get("packingsolverIrregularAvailable").asBoolean(), response.body());
            assertEquals("deepnest", health.get("packingsolverIrregularFallback").asText(), response.body());
        }

        var engines = json.readTree(send("/api/v2/nesting/engines", null).body());
        for (var engine : engines) if ("packingsolver".equals(engine.get("id").asText()))
            assertFalse(engine.get("available").asBoolean(), "engine discovery must not claim the native engine");
    }

    @Test void standardSolveNamesTheJavaEngineAndExplainsTheFallback() throws Exception {
        var response = send("/api/v2/nesting/solve", json.writeValueAsString(NativeSolverFallbackTests.guillotine("packingsolver")));
        assertEquals(200, response.statusCode(), response.body());
        var result = json.readValue(response.body(), NestingResult.class);
        assertEquals("FEASIBLE", result.status(), result.message());
        assertEquals("javaguillotine", result.engine());
        assertEquals("packingsolver", result.requestedEngine());
        assertNotNull(result.fallbackReason());
    }

    @Test void optimizationJobAndArchivedResultKeepTheActualEngineAndFallbackReason() throws Exception {
        var request = new OptimizationRequest(
                "2.0",
                "NESTING_2D",
                "FALLBACK-API-TEST",
                NativeSolverFallbackTests.guillotine("packingsolver"),
                true,
                false
        );
        var accepted = send("/api/v2/optimization-jobs", json.writeValueAsString(request), UUID.randomUUID().toString());
        assertEquals(202, accepted.statusCode(), accepted.body());
        var job = json.readValue(accepted.body(), OptimizationJob.class);

        OptimizationJob current = job;
        for (int i = 0; i < 100 && !current.terminal(); i++) {
            var poll = send("/api/v2/optimization-jobs/" + job.id(), null);
            assertEquals(200, poll.statusCode(), poll.body());
            current = json.readValue(poll.body(), OptimizationJob.class);
            if (!current.terminal()) Thread.sleep(20);
        }
        assertEquals("SUCCEEDED", current.state(), current.message());

        var resultResponse = send("/api/v2/optimization-results/" + job.id(), null);
        assertEquals(200, resultResponse.statusCode(), resultResponse.body());
        var archived = json.readValue(resultResponse.body(), OptimizationResult.class);
        assertNotNull(archived.layout(), resultResponse.body());
        assertEquals("FEASIBLE", archived.layout().status(), archived.layout().message());
        assertEquals("javaguillotine", archived.layout().engine());
        assertEquals("packingsolver", archived.layout().requestedEngine());
        assertNotNull(archived.layout().fallbackReason());
        assertFalse(archived.layout().fallbackReason().isBlank());
        assertTrue(archived.layout().fallbackReason().contains("javaguillotine"), archived.layout().fallbackReason());
    }

    @Test void contourAutoUsesDeepnestDirectlyAndExplicitNativeFallsBackToDeepnest() throws Exception {
        var autoResponse = send("/api/v2/nesting/solve", json.writeValueAsString(NativeSolverFallbackTests.contour("auto")));
        assertEquals(200, autoResponse.statusCode(), autoResponse.body());
        var autoResult = json.readValue(autoResponse.body(), NestingResult.class);
        assertEquals("FEASIBLE", autoResult.status(), autoResult.message());
        assertEquals("deepnest", autoResult.engine());
        assertEquals("deepnest", autoResult.requestedEngine());
        assertNull(autoResult.fallbackReason());

        var nativeResponse = send("/api/v2/nesting/solve", json.writeValueAsString(NativeSolverFallbackTests.contour("packingsolver-irregular")));
        assertEquals(200, nativeResponse.statusCode(), nativeResponse.body());
        var nativeResult = json.readValue(nativeResponse.body(), NestingResult.class);
        assertEquals("FEASIBLE", nativeResult.status(), nativeResult.message());
        assertEquals("deepnest", nativeResult.engine());
        assertEquals("packingsolver-irregular", nativeResult.requestedEngine());
        assertNotNull(nativeResult.fallbackReason());
        assertTrue(nativeResult.fallbackReason().contains("deepnest"), nativeResult.fallbackReason());
    }
}
