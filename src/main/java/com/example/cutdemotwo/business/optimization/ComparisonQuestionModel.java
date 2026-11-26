package com.example.cutdemotwo.business.optimization;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Semaphore;

import static com.example.cutdemotwo.business.optimization.ComparisonQuestions.Topic;

/** Optional on-device Ollama intent selection. Only the operator's question leaves this process. */
@Component
public class ComparisonQuestionModel {
    private final String model;
    private final URI endpoint;
    private final Duration requestTimeout;
    private final JsonMapper json = JsonMapper.builder().build();
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
    private final Semaphore permits = new Semaphore(2);

    @Autowired
    public ComparisonQuestionModel(@Value("${cutdemo.comparison.model:}") String model,
                                  @Value("${cutdemo.comparison.timeout-seconds:8}") int timeoutSeconds) {
        this(model, URI.create("http://127.0.0.1:11434/api/chat"), timeoutSeconds);
    }

    ComparisonQuestionModel(String model, URI endpoint, int timeoutSeconds) {
        this.model = model;
        this.endpoint = endpoint;
        if (timeoutSeconds < 1 || timeoutSeconds > 120)
            throw new IllegalArgumentException("本机模型超时须介于 1 至 120 秒。");
        this.requestTimeout = Duration.ofSeconds(timeoutSeconds);
    }

    Optional<Topic> classify(String question) {
        if (model.isBlank() || !permits.tryAcquire()) return Optional.empty();
        try {
            var schema = Map.of("type", "object", "properties", Map.of("topic", Map.of(
                    "type", "string", "enum", List.of("SHORTAGE", "SAVING", "SUMMARY", "OTHER"))),
                    "required", List.of("topic"), "additionalProperties", false);
            var messages = List.of(Map.of("role", "system", "content",
                    "判断排程员比较两份排料方案时想查看的事实。缺件、齐套选 SHORTAGE；省布或占长可比性选 SAVING；"
                    + "如何选择、多项比较选 SUMMARY；无关问题选 OTHER。只返回 topic。"),
                    Map.of("role", "user", "content", question));
            var payload = Map.of("model", model, "messages", messages, "format", schema,
                    "stream", false, "think", false, "options", Map.of("temperature", 0, "num_predict", 48));
            var request = HttpRequest.newBuilder(endpoint).timeout(requestTimeout)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(payload))).build();
            var response = client.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) return Optional.empty();
            String content = json.readTree(response.body()).path("message").path("content").asString("");
            return Optional.of(Topic.valueOf(json.readTree(content).path("topic").asString("")));
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return Optional.empty();
        } catch (IOException | RuntimeException unavailable) {
            return Optional.empty();
        } finally {
            permits.release();
        }
    }
}
