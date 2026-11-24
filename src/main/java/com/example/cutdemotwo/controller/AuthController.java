package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.config.AuthService;
import com.example.cutdemotwo.config.TraceIdFilter;
import org.slf4j.MDC;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * 轻量企业认证接口控制器：提供登录态探测（/me）与口令签发令牌（/login）。
 */
@RestController
@RequestMapping("/api/v2/auth")
public class AuthController {
    private final AuthService authService;

    public record LoginRequest(String username, String password) {}

    public AuthController(AuthService authService) {
        this.authService = authService;
    }

    @GetMapping("/me")
    public AuthService.MeResponse me(@RequestHeader(value = "Authorization", required = false) String authorization) {
        return authService.me(authorization);
    }

    @PostMapping("/login")
    public ResponseEntity<?> login(@RequestBody(required = false) LoginRequest request) {
        if (request == null || request.username() == null || request.password() == null) {
            return unauthorized("请输入用户名与密码");
        }
        Optional<AuthService.LoginResult> result = authService.authenticate(request.username(), request.password());
        if (result.isEmpty()) {
            return unauthorized("用户名或密码错误");
        }
        return ResponseEntity.ok(result.get());
    }

    private static ResponseEntity<Map<String, Object>> unauthorized(String message) {
        String traceId = MDC.get(TraceIdFilter.MDC_KEY);
        if (traceId == null || traceId.isBlank()) {
            traceId = UUID.randomUUID().toString().replace("-", "");
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", "UNAUTHORIZED");
        body.put("message", message);
        body.put("traceId", traceId);
        body.put("retryable", false);
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                .header("WWW-Authenticate", "Bearer realm=\"cutdemo\"")
                .body(body);
    }
}
