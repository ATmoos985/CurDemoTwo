package com.example.cutdemotwo.linear;

import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;
import java.util.Map;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;

@RestController
@RequestMapping("/api/linear")
public class LinearCutController {
    private final LinearCutService service;
    private final JsonMapper json = JsonMapper.builder()
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT).build();
    public LinearCutController(LinearCutService service) { this.service = service; }

    @PostMapping(value = "/tasks", consumes = "application/json") public Map<String, Object> create(@RequestBody String body) {
        LinearCutRequest request;
        try { request = json.readValue(body, LinearCutRequest.class); }
        catch (RuntimeException e) { throw new IllegalArgumentException("输入格式无效、含未知字段或小数；一维模块的幅宽和数量须为整数。"); }
        if (request == null) throw new IllegalArgumentException("请提供分切需求。");
        return service.create(request);
    }
    @GetMapping("/tasks/{id}") public Map<String, Object> get(@PathVariable String id) { return service.get(id); }
    @PostMapping("/tasks/{id}/{action}") public Map<String, Object> change(@PathVariable String id,
            @PathVariable String action, @RequestBody Map<String, Object> request) { return service.change(id, action, request); }
    @PostMapping(value = "/import", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<Map<String, Object>> parse(@RequestParam("file") MultipartFile file) { return service.parse(file); }
    @GetMapping("/tasks/{id}/export") public ResponseEntity<byte[]> export(@PathVariable String id) throws java.io.IOException {
        return ResponseEntity.ok().header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=linear-cutting.xlsx")
                .contentType(MediaType.parseMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
                .body(service.export(id));
    }

    @ExceptionHandler(IllegalArgumentException.class) ResponseEntity<?> invalid(IllegalArgumentException e) {
        return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
    }
    @ExceptionHandler(ResponseStatusException.class) ResponseEntity<?> status(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(Map.of("message", e.getReason() == null ? "请求失败。" : e.getReason()));
    }
}
