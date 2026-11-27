package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.config.AuthContext;
import com.example.cutdemotwo.config.AuthService;
import com.example.cutdemotwo.config.OperationAuditService;
import com.example.cutdemotwo.config.TraceIdFilter;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * 企业认证接口控制器：提供登录态探测（/me）、口令签发令牌（/login）、主动登出吊销（/logout）与自助改密（/password）。
 */
@RestController
@RequestMapping("/api/v2/auth")
public class AuthController {
    private final AuthService authService;
    private final OperationAuditService auditService;

    public record LoginRequest(String username, String password) {}

    public record PasswordChangeRequest(String currentPassword, String newPassword) {}

    public AuthController(AuthService authService) {
        this(authService, null);
    }

    @Autowired
    public AuthController(AuthService authService, OperationAuditService auditService) {
        this.authService = authService;
        this.auditService = auditService;
    }

    @GetMapping("/me")
    public AuthService.MeResponse me(@RequestHeader(value = "Authorization", required = false) String authorization) {
        return authService.me(authorization);
    }

    public ResponseEntity<?> login(LoginRequest request) {
        return login(request, null);
    }

    @PostMapping("/login")
    public ResponseEntity<?> login(@RequestBody(required = false) LoginRequest request, HttpServletRequest httpRequest) {
        String ip = httpRequest == null ? null : httpRequest.getRemoteAddr();
        if (request == null || request.username() == null || request.password() == null) {
            return unauthorized("请输入用户名与密码");
        }
        String attemptedUser = request.username().trim();
        Optional<AuthService.LoginResult> result = authService.authenticate(attemptedUser, request.password());
        if (result.isEmpty()) {
            if (auditService != null) {
                auditService.recordRaw(
                        attemptedUser.isEmpty() ? "ANONYMOUS" : attemptedUser,
                        AuthContext.ACTOR_USER,
                        null,
                        null,
                        "AUTH_LOGIN",
                        "USER",
                        attemptedUser,
                        "POST",
                        "/api/v2/auth/login",
                        "FAILED",
                        401,
                        ip,
                        Map.of("reason", "INVALID_CREDENTIALS_OR_DISABLED")
                );
            }
            return unauthorized("用户名、密码错误或账号已禁用");
        }
        AuthService.LoginResult login = result.get();
        if (auditService != null) {
            auditService.recordRaw(
                    login.username(),
                    AuthContext.ACTOR_USER,
                    login.role(),
                    null,
                    "AUTH_LOGIN",
                    "USER",
                    login.username(),
                    "POST",
                    "/api/v2/auth/login",
                    "SUCCESS",
                    200,
                    ip,
                    Map.of("role", login.role())
            );
        }
        return ResponseEntity.ok(login);
    }

    @PostMapping("/logout")
    public ResponseEntity<Map<String, Object>> logout(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            HttpServletRequest httpRequest
    ) {
        Optional<AuthContext.Principal> revoked = authService.revokeTokenByHeader(authorization, "LOGOUT");
        AuthContext.Principal actor = revoked.orElse(AuthContext.current());
        if (auditService != null) {
            auditService.record(
                    actor,
                    "AUTH_LOGOUT",
                    "USER",
                    actor != null ? actor.username() : null,
                    "POST",
                    "/api/v2/auth/logout",
                    "SUCCESS",
                    200,
                    httpRequest == null ? null : httpRequest.getRemoteAddr(),
                    Map.of("revoked", true)
            );
        }
        return ResponseEntity.ok(Map.of("revoked", true));
    }

    @PutMapping("/password")
    public ResponseEntity<Map<String, Object>> changePassword(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @RequestBody(required = false) PasswordChangeRequest request,
            HttpServletRequest httpRequest
    ) {
        AuthContext.Principal principal = AuthContext.current();
        if ((principal == null || !principal.authenticated()) && authorization != null) {
            principal = authService.verifyAuthorizationHeader(authorization).orElse(principal);
        }
        if (principal == null || !principal.authenticated() || principal.isAgent()) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(Map.of(
                            "code", "INVALID_INPUT",
                            "message", "仅已登录用户主体可自助修改密码",
                            "traceId", currentTraceId(),
                            "retryable", false
                    ));
        }
        if (request == null) {
            throw new IllegalArgumentException("请求正文不能为空");
        }
        String ip = httpRequest == null ? null : httpRequest.getRemoteAddr();
        try {
            authService.changePassword(principal.username(), request.currentPassword(), request.newPassword());
            authService.revokeTokenByHeader(authorization, "PASSWORD_CHANGED");
            if (auditService != null) {
                auditService.record(
                        principal,
                        "AUTH_PASSWORD_CHANGE",
                        "USER",
                        principal.username(),
                        "PUT",
                        "/api/v2/auth/password",
                        "SUCCESS",
                        200,
                        ip,
                        Map.of("username", principal.username())
                );
            }
            return ResponseEntity.ok(Map.of("updated", true));
        } catch (RuntimeException error) {
            if (auditService != null) {
                auditService.record(
                        principal,
                        "AUTH_PASSWORD_CHANGE",
                        "USER",
                        principal.username(),
                        "PUT",
                        "/api/v2/auth/password",
                        "FAILED",
                        400,
                        ip,
                        Map.of("reason", error.getMessage() == null ? "FAILED" : error.getMessage())
                );
            }
            throw error;
        }
    }

    private static ResponseEntity<Map<String, Object>> unauthorized(String message) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", "UNAUTHORIZED");
        body.put("message", message);
        body.put("traceId", currentTraceId());
        body.put("retryable", false);
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                .header("WWW-Authenticate", "Bearer realm=\"cutdemo\"")
                .body(body);
    }

    private static String currentTraceId() {
        String traceId = MDC.get(TraceIdFilter.MDC_KEY);
        if (traceId != null && !traceId.isBlank()) {
            return traceId;
        }
        return UUID.randomUUID().toString().replace("-", "");
    }
}
