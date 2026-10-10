package com.example.cutdemotwo;

import com.example.cutdemotwo.model.nesting.*;
import com.example.cutdemotwo.service.RemnantService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.*;
import java.nio.file.*;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class NestingApiTests {
    @TempDir static Path temp;
    @DynamicPropertySource static void properties(DynamicPropertyRegistry r) {
        r.add("cutdemo.state.path", () -> temp.resolve("empty.json").toString());
        r.add("cutdemo.seed-demo-data", () -> false);
    }
    @Value("${local.server.port}") int port;
    @Autowired RemnantService inventory;
    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newHttpClient();

    private HttpResponse<String> post(String body) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/v1/nesting/solve"))
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body)).build(),
                HttpResponse.BodyHandlers.ofString());
    }

    @Test void standardHttpSolveNeedsNoInventoryAndWritesNoTaskPlanOrStock() throws Exception {
        Path state = temp.resolve("empty.json");
        byte[] before = Files.exists(state) ? Files.readAllBytes(state) : null;
        var response = post(json.writeValueAsString(NestingKernelTests.problem()));
        assertEquals(200, response.statusCode(), response.body());
        var result = json.readValue(response.body(), NestingResult.class);
        assertEquals("FEASIBLE", result.status());
        assertEquals(2, result.placements().size());
        assertTrue(inventory.getMotherRolls().isEmpty());
        assertTrue(inventory.listTasks().isEmpty());
        assertArrayEquals(before, Files.exists(state) ? Files.readAllBytes(state) : null);
        assertFalse(response.body().contains("planId"));
        assertFalse(response.body().contains("rollId"));
    }

    @Test void unknownJsonConstraintsAreRejectedInsteadOfIgnored() throws Exception {
        String body = json.writeValueAsString(NestingKernelTests.problem());
        var response = post(body.replace("\"kerf\":0.0", "\"kerf\":0.0,\"unsupportedConstraint\":true"));
        assertEquals(400, response.statusCode(), response.body());
        assertEquals("INVALID_INPUT", json.readValue(response.body(), NestingResult.class).status());
    }

    @Test void engineDiscoveryListsCapabilitiesAndExcludesPresetAnswers() throws Exception {
        var response = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/v1/nesting/engines")).GET().build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(200, response.statusCode());
        assertTrue(response.body().contains("crosscut"));
        assertTrue(response.body().contains("packingsolver"));
        assertFalse(response.body().contains("preset"));
    }

    @Test void fractionalQuantityAndTrailingJsonAreRejected() throws Exception {
        String body = json.writeValueAsString(NestingKernelTests.problem());
        assertEquals(400, post(body.replace("\"quantity\":3", "\"quantity\":3.9")).statusCode());
        assertEquals(400, post(body + " {}").statusCode());
    }

    @Test void nativeRectangleEngineHonorsPerPartRotationAndReturnsStableDemandIds() throws Exception {
        var p = NestingKernelTests.problem();
        var material = new NestingProblem.Material("sheet", NestingProblem.Shape.rectangle(1000, 600), List.of(), false);
        var process = new NestingProblem.Process("GUILLOTINE", "SHEET", "left-top", "horizontal", 0, 200, 300, 0, "MAXIMIZE_PIECE_AREA");
        var problem = NestingKernelTests.change(p, material,
                List.of(new NestingProblem.Part(77, "rotate-required", NestingProblem.Shape.rectangle(600, 1000), 1, true)), process, "packingsolver");
        var response = post(json.writeValueAsString(problem));
        assertEquals(200, response.statusCode(), response.body());
        var result = json.readValue(response.body(), NestingResult.class);
        assertEquals("FEASIBLE", result.status(), result.message());
        assertEquals(77, result.placements().get(0).demandId());
        assertEquals(90, result.placements().get(0).rotationDegrees());
        assertEquals(1000, result.placements().get(0).shape().width());
        assertEquals(600, result.placements().get(0).shape().height());
        var forbidden = NestingKernelTests.change(problem, material,
                List.of(new NestingProblem.Part(77, "rotation-forbidden", NestingProblem.Shape.rectangle(600, 1000), 1, false)), process, "packingsolver");
        var noRotation = post(json.writeValueAsString(forbidden));
        assertEquals(200, noRotation.statusCode(), noRotation.body());
        var notPlaced = json.readValue(noRotation.body(), NestingResult.class);
        assertEquals("NO_SOLUTION_FOUND", notPlaced.status());
        assertEquals(1, notPlaced.fulfillment().get(0).unplaced());
    }
}
