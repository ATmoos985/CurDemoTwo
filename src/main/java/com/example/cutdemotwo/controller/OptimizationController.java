package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.business.optimization.OptimizationService;
import com.example.cutdemotwo.contracts.jobs.*;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import tools.jackson.databind.*;
import tools.jackson.databind.json.JsonMapper;
import java.io.*;
import java.net.URI;
import java.util.*;

@RestController
@RequestMapping("/api/v2")
public class OptimizationController {
    private final OptimizationService jobs;
    private static final JsonMapper JSON = JsonMapper.builder().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES,
            DeserializationFeature.FAIL_ON_TRAILING_TOKENS, DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES)
            .enable(tools.jackson.core.StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT).disable(MapperFeature.ALLOW_COERCION_OF_SCALARS).build();

    public OptimizationController(OptimizationService jobs) { this.jobs = jobs; }

    @GetMapping("/capabilities")
    public Object capabilities() { return jobs.capabilities(); }

    @PostMapping(value = "/problem-validations", consumes = "application/json")
    public Object validate(InputStream input) { return jobs.validate(decode(input, OptimizationRequest.class)); }

    @PostMapping(value = "/optimization-jobs", consumes = "application/json")
    public ResponseEntity<OptimizationJob> submit(@RequestHeader(value = "Idempotency-Key", required = false) String key, InputStream input) {
        var job = jobs.submit(key, decode(input, OptimizationRequest.class));
        return ResponseEntity.accepted().location(URI.create("/api/v2/optimization-jobs/" + job.id())).header("Retry-After", "1").body(job);
    }

    @GetMapping("/optimization-jobs/{id}")
    public OptimizationJob job(@PathVariable String id, HttpServletRequest request) {
        checkOwner(id, request);
        return jobs.get(id);
    }

    @GetMapping(value = "/optimization-jobs/{jobId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@PathVariable String jobId, HttpServletRequest request) {
        checkOwner(jobId, request);
        return jobs.subscribeEvents(jobId);
    }

    @GetMapping("/optimization-jobs/{id}/input")
    public OptimizationRequest input(@PathVariable String id, HttpServletRequest request) {
        checkOwner(id, request);
        return jobs.input(id);
    }

    @GetMapping("/optimization-results/{id}")
    public OptimizationResult result(@PathVariable String id, HttpServletRequest request) {
        checkOwner(id, request);
        return jobs.result(id);
    }

    @GetMapping("/result-comparisons")
    public ResultComparison compare(@RequestParam(defaultValue = "") String leftId, @RequestParam(defaultValue = "") String rightId,
                                    HttpServletRequest request) {
        if (!leftId.isBlank() && !rightId.isBlank()) {
            checkOwner(leftId, request);
            checkOwner(rightId, request);
        }
        return jobs.compare(leftId, rightId);
    }

    @PostMapping("/optimization-jobs/{id}/cancellations")
    public OptimizationJob cancel(@PathVariable String id, HttpServletRequest request) {
        checkOwner(id, request);
        return jobs.cancel(id);
    }

    private void checkOwner(String id, HttpServletRequest request) {
        var source = jobs.workbenchSource(id);
        if (source != null && !source.actor().equals(WorkbenchJobController.actor(request))) {
            throw new OptimizationService.Failure("NOT_FOUND", "计算作业或结果不存在", 404, false);
        }
    }

    static <T> T decode(InputStream input, Class<T> type) {
        try {
            byte[] bytes = input.readNBytes(262145);
            if (bytes.length > 262144) throw new OptimizationService.Failure("PAYLOAD_TOO_LARGE", "请求正文最多 262144 字节", 413, false);
            return JSON.readValue(bytes, type);
        } catch (OptimizationService.Failure error) {
            throw error;
        } catch (IOException | RuntimeException error) {
            throw new OptimizationService.Failure("INVALID_INPUT", "JSON 格式、字段或类型错误；请核对 v2 作业契约", 400, false);
        }
    }

    @ExceptionHandler(OptimizationService.Failure.class)
    public ResponseEntity<?> failed(OptimizationService.Failure error) {
        var response = ResponseEntity.status(error.status)
                .contentType(MediaType.APPLICATION_JSON)
                .header("Cache-Control", "no-store");
        if (error.retryable) response.header("Retry-After", "1");
        return response.body(Map.of("code", error.code, "message", error.getMessage(), "fieldErrors", List.of(),
                "traceId", UUID.randomUUID().toString(), "retryable", error.retryable, "details", Map.of()));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<?> unexpected(Exception error) {
        String trace = UUID.randomUUID().toString();
        org.slf4j.LoggerFactory.getLogger(getClass()).error("Optimization API failed, traceId={}", trace, error);
        return ResponseEntity.status(503)
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("code", "SERVICE_UNAVAILABLE", "message", "作业服务暂不可用，请凭 traceId 查询日志",
                        "fieldErrors", List.of(), "traceId", trace, "retryable", true, "details", Map.of()));
    }
}
