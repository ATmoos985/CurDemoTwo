package com.example.cutdemotwo;

import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.cutting.WorkbenchJobContextService.Context;
import com.example.cutdemotwo.business.cutting.WorkbenchJobContextService.Submission;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.optimization.OptimizationService;
import com.example.cutdemotwo.contracts.jobs.OptimizationRequest;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.json.JsonMapper;

import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class WorkbenchJobSourceApiTests {
    @TempDir static Path temp;
    @DynamicPropertySource static void properties(DynamicPropertyRegistry r) {
        r.add("cutdemo.state.path", () -> temp.resolve("inventory.json").toString());
        r.add("cutdemo.seed-demo-data", () -> false);
    }
    @Value("${local.server.port}") int port;
    @Autowired RemnantService inventory;
    @Autowired OptimizationService jobs;
    final JsonMapper json = JsonMapper.builder().build();

    HttpClient browser() { return HttpClient.newBuilder().cookieHandler(new CookieManager(null, CookiePolicy.ACCEPT_ALL)).build(); }

    OptimizationRequest input() {
        return new OptimizationRequest("2.0", "NESTING_2D", "source-check", new NestingProblem("1", "mm",
                new NestingProblem.Material("test", NestingProblem.Shape.rectangle(200, 300), List.of(), false),
                List.of(new NestingProblem.Part(1, "panel", NestingProblem.Shape.rectangle(200, 100), 2, false)),
                new NestingProblem.Process("CROSSCUT", "SHEET", "left-top", "horizontal", 0, 0, 0, 0, "INPUT_ORDER"),
                "auto", 2), true, true);
    }

    HttpResponse<String> call(HttpClient client, String path, String body, String key) throws Exception {
        var req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/v2/" + path));
        if (body != null) req.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body));
        if (key != null) req.header("Idempotency-Key", key);
        return client.send(req.build(), HttpResponse.BodyHandlers.ofString());
    }

    void waitForCompletion(String id) throws Exception {
        long deadline = System.nanoTime() + 10_000_000_000L;
        while (!jobs.get(id).terminal() && System.nanoTime() < deadline) Thread.sleep(25);
        assertEquals("SUCCEEDED", jobs.get(id).state());
    }

    @Test void taskSourceSurvivesCompletionAndIsPrivateThroughEveryJobRead() throws Exception {
        var task = inventory.saveTask(new CuttingTask(null, "source test", "VIRTUAL", null, 0,
                List.of(new CuttingTask.Line(42, "panel", 200, 100, 2, false))));
        byte[] before = Files.readAllBytes(temp.resolve("inventory.json"));
        var a = browser();
        var b = browser();
        var path = "workbench/tasks/" + task.id() + "/optimization-jobs";
        String body = json.writeValueAsString(new Submission(input(), new Context("FREE_CANVAS", "cotton", 0, 200, 300, 0, Map.of(1, 42))));
        String key = UUID.randomUUID().toString();
        var accepted = call(a, path, body, key);
        assertEquals(202, accepted.statusCode(), accepted.body());
        String id = json.readTree(accepted.body()).at("/job/id").asString();
        var replay = call(a, path, body, key);
        assertEquals(id, json.readTree(replay.body()).at("/job/id").asString());
        assertEquals(409, call(b, path, body, key).statusCode());
        assertEquals(409, call(b, "optimization-jobs", json.writeValueAsString(input()), key).statusCode());
        for (String route : List.of("optimization-jobs/" + id, "optimization-jobs/" + id + "/input",
                "optimization-jobs/" + id + "/events", "optimization-results/" + id,
                "result-comparisons?leftId=" + id + "&rightId=" + id,
                "workbench/tasks/" + task.id() + "/results/" + id)) {
            assertEquals(404, call(b, route, null, null).statusCode(), route);
        }
        assertEquals(404, call(b, "optimization-jobs/" + id + "/cancellations", "{}", null).statusCode());
        assertEquals(404, call(a, "workbench/tasks/another-task/results/" + id, null, null).statusCode());
        waitForCompletion(id);
        assertEquals(task.id(), jobs.workbenchSource(id).taskId());
        assertEquals(Map.of(1, 42), jobs.workbenchSource(id).sourceLines());
        assertEquals(200, call(a, "workbench/tasks/" + task.id() + "/results/" + id, null, null).statusCode());
        var second = call(a, path, body, UUID.randomUUID().toString());
        assertEquals(202, second.statusCode(), second.body());
        String right = json.readTree(second.body()).at("/job/id").asString();
        waitForCompletion(right);
        String compare = "workbench/tasks/" + task.id() + "/result-comparison?leftId=" + id + "&rightId=" + right;
        var compared = call(a, compare, null, null);
        assertEquals(200, compared.statusCode(), compared.body());
        assertTrue(json.readTree(compared.body()).get("sameConstraints").asBoolean());
        assertEquals(404, call(b, compare, null, null).statusCode());
        String scratchId = "scratch:" + UUID.randomUUID();
        var changed = new Context("FREE_CANVAS", "cotton", 0, 200, 300, 0, Map.of(1, 42), scratchId);
        var renamed = json.writeValueAsString(new Submission(input(), changed)).replace("\"panel\"", "\"edited-panel\"");
        var detached = call(a, path, renamed, UUID.randomUUID().toString());
        assertEquals(202, detached.statusCode(), detached.body());
        assertEquals(scratchId, json.readTree(detached.body()).get("comparisonTaskId").asString());
        String draftResult = json.readTree(detached.body()).at("/job/id").asString();
        waitForCompletion(draftResult);
        assertEquals(404, call(a, "workbench/tasks/" + task.id() + "/results/" + draftResult, null, null).statusCode());
        assertArrayEquals(before, Files.readAllBytes(temp.resolve("inventory.json")));
    }

    @Test void privateDraftCannotClaimRealRowsAndMismatchedPhysicalWidthIsRejected() throws Exception {
        var a = browser();
        var path = "workbench/tasks/scratch:" + UUID.randomUUID() + "/optimization-jobs";
        var valid = new Context("FREE_CANVAS", "linen", 0, 200, 300, 0, Map.of());
        var accepted = call(a, path, json.writeValueAsString(new Submission(input(), valid)), UUID.randomUUID().toString());
        assertEquals(202, accepted.statusCode(), accepted.body());
        var id = json.readTree(accepted.body()).at("/job/id").asString();
        waitForCompletion(id);
        assertEquals("linen", jobs.workbenchSource(id).materialId());
        for (var invalid : List.of(new Context("FREE_CANVAS", "linen", 0, 200, 300, 0, Map.of(1, 42)),
                new Context("FREE_CANVAS", "linen", 0, 170, 300, 0, Map.of()))) {
            var response = call(a, path, json.writeValueAsString(new Submission(input(), invalid)), UUID.randomUUID().toString());
            assertEquals(422, response.statusCode(), response.body());
        }
    }
}
