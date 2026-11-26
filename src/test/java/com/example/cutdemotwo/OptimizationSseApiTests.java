package com.example.cutdemotwo;

import com.example.cutdemotwo.contracts.jobs.OptimizationJob;
import com.example.cutdemotwo.contracts.jobs.OptimizationRequest;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 真实 HTTP 端到端 SSE 实时进度流契约验证（GET /api/v2/optimization-jobs/{jobId}/events）。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Timeout(30)
class OptimizationSseApiTests {

    @TempDir static Path temp;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("cutdemo.state.path", () -> temp.resolve("sse-inventory.json").toString());
        r.add("cutdemo.seed-demo-data", () -> false);
    }

    @Value("${local.server.port}") int port;
    private final JsonMapper json = JsonMapper.builder().build();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    private OptimizationRequest sampleNestingRequest() {
        return new OptimizationRequest("2.0", "NESTING_2D", "SSE-TEST-001", new NestingProblem(
                "1", "mm",
                new NestingProblem.Material("fabric", NestingProblem.Shape.rectangle(2000, 3000), List.of(), false),
                List.of(new NestingProblem.Part(1, "piece", NestingProblem.Shape.rectangle(2000, 1000), 2, false)),
                new NestingProblem.Process("CROSSCUT", "SHEET", "left-top", "horizontal", 0, 200, 300, 0, "INPUT_ORDER"),
                "crosscut", 5
        ), false, true);
    }

    private record SseFrame(String event, JsonNode data) {}

    private List<SseFrame> parseSseFrames(String body) {
        List<SseFrame> frames = new ArrayList<>();
        String currentEvent = null;
        StringBuilder dataBuilder = new StringBuilder();
        for (String rawLine : body.split("\\r?\\n")) {
            if (rawLine.isEmpty()) {
                if (currentEvent != null && !dataBuilder.isEmpty()) {
                    frames.add(new SseFrame(currentEvent, json.readTree(dataBuilder.toString())));
                }
                currentEvent = null;
                dataBuilder.setLength(0);
            } else if (rawLine.startsWith("event:")) {
                currentEvent = rawLine.substring("event:".length()).trim();
            } else if (rawLine.startsWith("data:")) {
                if (!dataBuilder.isEmpty()) dataBuilder.append('\n');
                dataBuilder.append(rawLine.substring("data:".length()).trim());
            }
        }
        if (currentEvent != null && !dataBuilder.isEmpty()) {
            frames.add(new SseFrame(currentEvent, json.readTree(dataBuilder.toString())));
        }
        return frames;
    }

    @Test
    void sseEndpointStreamsDoneEventReturns404ForMissingJobAndUpdatesCapabilities() throws Exception {
        // 1. capabilities 准确上报 sse=true 与 progress=sse-and-poll
        var capResp = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/v2/capabilities"))
                .GET().build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(200, capResp.statusCode());
        var cap = json.readTree(capResp.body());
        assertTrue(cap.path("features").path("sse").asBoolean(), "capabilities.features.sse 必须为 true");
        assertEquals("sse-and-poll", cap.path("features").path("progress").asText());

        // 2. 作业不存在必须返回 HTTP 404（即便携带 Accept: text/event-stream）
        var notFoundResp = http.send(HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + port + "/api/v2/optimization-jobs/does-not-exist/events"))
                .header("Accept", "text/event-stream")
                .GET().build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(404, notFoundResp.statusCode(), notFoundResp.body());
        assertEquals("NOT_FOUND", json.readTree(notFoundResp.body()).path("code").asText());

        // 3. 提交作业并立即订阅 SSE，接收终态 event: done 并优雅关闭流
        var submitResp = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/v2/optimization-jobs"))
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(sampleNestingRequest())))
                .build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(202, submitResp.statusCode(), submitResp.body());
        OptimizationJob submitted = json.readValue(submitResp.body(), OptimizationJob.class);

        var sseResp = http.send(HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + port + "/api/v2/optimization-jobs/" + submitted.id() + "/events"))
                .header("Accept", "text/event-stream")
                .timeout(Duration.ofSeconds(10))
                .GET().build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(200, sseResp.statusCode());
        assertTrue(sseResp.headers().firstValue("Content-Type").orElse("").contains("text/event-stream"));

        List<SseFrame> frames = parseSseFrames(sseResp.body());
        assertFalse(frames.isEmpty(), "SSE 响应体至少应包含终态 done 事件，实际=" + sseResp.body());
        SseFrame last = frames.get(frames.size() - 1);
        assertEquals("done", last.event(), "最后一个事件必须为 done，实际=" + sseResp.body());
        assertEquals(submitted.id(), last.data().path("jobId").asText());
        assertEquals("SUCCEEDED", last.data().path("status").asText());
        assertEquals("STOPPED", last.data().path("phase").asText());
        assertTrue(last.data().path("elapsedMs").asLong(-1) >= 0);
        assertFalse(last.data().path("finishedAt").asText().isBlank());

        for (int i = 0; i < frames.size() - 1; i++) {
            SseFrame progress = frames.get(i);
            assertEquals("progress", progress.event());
            assertEquals(submitted.id(), progress.data().path("jobId").asText());
            assertFalse(progress.data().path("status").asText().isBlank());
            assertFalse(progress.data().path("phase").asText().isBlank());
            assertTrue(progress.data().path("elapsedMs").asLong(-1) >= 0);
            assertTrue(progress.data().path("attempt").asInt(0) >= 1);
        }

        // 4. 对已终态作业重复订阅 SSE：立即推送一次 done 并优雅关闭
        var replaySse = http.send(HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + port + "/api/v2/optimization-jobs/" + submitted.id() + "/events"))
                .header("Accept", "text/event-stream")
                .timeout(Duration.ofSeconds(5))
                .GET().build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(200, replaySse.statusCode());
        List<SseFrame> replayFrames = parseSseFrames(replaySse.body());
        assertEquals(1, replayFrames.size(), "已终态作业应仅推送一次 done 后关闭，实际=" + replaySse.body());
        assertEquals("done", replayFrames.get(0).event());
        assertEquals("SUCCEEDED", replayFrames.get(0).data().path("status").asText());
        assertFalse(replayFrames.get(0).data().path("finishedAt").asText().isBlank());

        // 5. 提交一维分切作业并立刻订阅 SSE，实测捕获 progress -> done 实时事件流
        String slittingBody = http.send(HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + port + "/api-v2/example-slitting-request.json"))
                .GET().build(), HttpResponse.BodyHandlers.ofString()).body();
        var slittingSubmit = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/v2/optimization-jobs"))
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(slittingBody))
                .build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(202, slittingSubmit.statusCode(), slittingSubmit.body());
        String slittingId = json.readTree(slittingSubmit.body()).path("id").asText();

        var slittingSse = http.send(HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + port + "/api/v2/optimization-jobs/" + slittingId + "/events"))
                .header("Accept", "text/event-stream")
                .timeout(Duration.ofSeconds(15))
                .GET().build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(200, slittingSse.statusCode());
        List<SseFrame> slittingFrames = parseSseFrames(slittingSse.body());
        assertTrue(slittingFrames.size() >= 2, "一维求解过程应至少推送 progress 与 done 帧，实际=" + slittingSse.body());
        assertEquals("progress", slittingFrames.get(0).event());
        assertEquals(slittingId, slittingFrames.get(0).data().path("jobId").asText());
        assertTrue(slittingFrames.get(0).data().path("attempt").asInt(0) >= 1);
        SseFrame slittingDone = slittingFrames.get(slittingFrames.size() - 1);
        assertEquals("done", slittingDone.event());
        assertEquals("SUCCEEDED", slittingDone.data().path("status").asText());
        assertFalse(slittingDone.data().path("finishedAt").asText().isBlank());
    }
}
