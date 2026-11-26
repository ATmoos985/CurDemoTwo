package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.contracts.jobs.WorkbenchComparison;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ComparisonQuestionsTests {
    @Test void preservesMissingDemandIdsAndCountsWithoutAModel() {
        var left = mock(WorkbenchComparison.Side.class);
        when(left.unplaced()).thenReturn(2);
        when(left.demands()).thenReturn(List.of(new WorkbenchComparison.Demand(1, 10, "前片", 3, 1, 2)));
        var right = mock(WorkbenchComparison.Side.class);
        when(right.fulfillmentStatus()).thenReturn("COMPLETE");
        when(right.requested()).thenReturn(3);
        var comparison = mock(WorkbenchComparison.class);
        when(comparison.left()).thenReturn(left);
        when(comparison.right()).thenReturn(right);
        var answer = new ComparisonQuestions(new ComparisonQuestionModel("")).answer(comparison, "还缺哪些？");
        assertEquals("RULES", answer.source());
        assertEquals(List.of("方案 A 共缺 2 片，前片（#1）缺 2 片。", "方案 B 本次应排裁片已齐套。"), answer.lines());
    }

    @Test void partialKitOnlyShowsServerReasonForLength() {
        var comparison = mock(WorkbenchComparison.class);
        when(comparison.lengthComparison()).thenReturn(new WorkbenchComparison.LengthComparison(
                "INCOMPLETE", null, null, null, "方案 A 尚有缺件。"));
        var answer = new ComparisonQuestions(new ComparisonQuestionModel("")).answer(comparison, "能省多少布？");
        assertEquals(List.of("当前无法判定哪套更省布。方案 A 尚有缺件。"), answer.lines());
    }

    @Test void classifiesUsingOnlyTheQuestionAndRejectsUnrecognisedModelText() throws Exception {
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var json = JsonMapper.builder().build();
        var reply = new java.util.concurrent.atomic.AtomicReference<>("{\"topic\":\"SHORTAGE\"}");
        var received = new java.util.concurrent.atomic.AtomicReference<>("");
        server.createContext("/api/chat", exchange -> {
            received.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] body = json.writeValueAsBytes(java.util.Map.of("message", java.util.Map.of("content", reply.get())));
            exchange.sendResponseHeaders(200, body.length);
            try (var out = exchange.getResponseBody()) { out.write(body); }
        });
        server.start();
        try {
            var endpoint = URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/api/chat");
            var model = new ComparisonQuestionModel("local-test", endpoint);
            assertEquals(ComparisonQuestions.Topic.SHORTAGE, model.classify("齐了吗").orElseThrow());
            var request = json.readTree(received.get());
            assertEquals("齐了吗", request.path("messages").get(1).path("content").asString());
            assertFalse(request.has("comparison"));
            reply.set("{\"topic\":\"省500米\"}");
            assertTrue(model.classify("省布吗").isEmpty());
        } finally {
            server.stop(0);
        }
    }
}
