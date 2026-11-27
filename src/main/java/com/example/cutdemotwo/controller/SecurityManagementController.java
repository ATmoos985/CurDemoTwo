package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.config.AuthContext;
import com.example.cutdemotwo.config.OperationAuditService;
import com.example.cutdemotwo.config.SecurityAdminService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 管理员安全管理控制器：提供用户账户（/api/v2/users/**）与 AI Agent 凭证（/api/v2/agents/**）全生命周期管理。
 */
@RestController
@RequestMapping("/api/v2")
public class SecurityManagementController {
    private final SecurityAdminService adminService;
    private final OperationAuditService auditService;

    public record CreateUserRequest(String username, String displayName, String role, String password) {}

    public record UpdateUserRequest(String displayName, String role) {}

    public record UserStatusRequest(Boolean enabled) {}

    public record ResetPasswordRequest(String newPassword) {}

    public record CreateAgentRequest(String name, List<String> scopes, String description, Long ttlHours) {}

    public record RevokeAgentRequest(String reason) {}

    public SecurityManagementController(SecurityAdminService adminService, OperationAuditService auditService) {
        this.adminService = adminService;
        this.auditService = auditService;
    }

    @GetMapping("/users")
    public Map<String, Object> listUsers() {
        return Map.of("items", adminService.listUsers());
    }

    @PostMapping("/users")
    public ResponseEntity<SecurityAdminService.UserAccountView> createUser(
            @RequestBody(required = false) CreateUserRequest request,
            HttpServletRequest httpRequest
    ) {
        if (request == null) {
            throw new IllegalArgumentException("请求正文不能为空");
        }
        SecurityAdminService.UserAccountView created = adminService.createUser(
                request.username(), request.displayName(), request.role(), request.password()
        );
        auditService.record(
                AuthContext.current(),
                "USER_CREATE",
                "USER",
                created.username(),
                "POST",
                "/api/v2/users",
                "SUCCESS",
                201,
                httpRequest == null ? null : httpRequest.getRemoteAddr(),
                Map.of("username", created.username(), "role", created.role())
        );
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    @PutMapping("/users/{username}")
    public SecurityAdminService.UserAccountView updateUser(
            @PathVariable("username") String username,
            @RequestBody(required = false) UpdateUserRequest request,
            HttpServletRequest httpRequest
    ) {
        if (request == null) {
            throw new IllegalArgumentException("请求正文不能为空");
        }
        SecurityAdminService.UserAccountView updated = adminService.updateUser(
                username, request.displayName(), request.role()
        );
        auditService.record(
                AuthContext.current(),
                "USER_UPDATE",
                "USER",
                updated.username(),
                "PUT",
                "/api/v2/users/" + updated.username(),
                "SUCCESS",
                200,
                httpRequest == null ? null : httpRequest.getRemoteAddr(),
                Map.of("role", updated.role(), "displayName", updated.displayName())
        );
        return updated;
    }

    @PostMapping("/users/{username}/status")
    public SecurityAdminService.UserAccountView updateUserStatus(
            @PathVariable("username") String username,
            @RequestBody(required = false) UserStatusRequest request,
            HttpServletRequest httpRequest
    ) {
        if (request == null || request.enabled() == null) {
            throw new IllegalArgumentException("必须指定 enabled 状态字段");
        }
        SecurityAdminService.UserAccountView updated = adminService.updateUserStatus(username, request.enabled());
        auditService.record(
                AuthContext.current(),
                "USER_STATUS_CHANGE",
                "USER",
                updated.username(),
                "POST",
                "/api/v2/users/" + updated.username() + "/status",
                "SUCCESS",
                200,
                httpRequest == null ? null : httpRequest.getRemoteAddr(),
                Map.of("enabled", updated.enabled(), "tokenVersion", updated.tokenVersion())
        );
        return updated;
    }

    @PostMapping("/users/{username}/reset-password")
    public Map<String, Object> resetPassword(
            @PathVariable("username") String username,
            @RequestBody(required = false) ResetPasswordRequest request,
            HttpServletRequest httpRequest
    ) {
        if (request == null) {
            throw new IllegalArgumentException("请求正文不能为空");
        }
        long tokenVersion = adminService.resetUserPassword(username, request.newPassword());
        auditService.record(
                AuthContext.current(),
                "USER_PASSWORD_RESET",
                "USER",
                username,
                "POST",
                "/api/v2/users/" + username + "/reset-password",
                "SUCCESS",
                200,
                httpRequest == null ? null : httpRequest.getRemoteAddr(),
                Map.of("tokenVersion", tokenVersion)
        );
        return Map.of("updated", true, "tokenVersion", tokenVersion);
    }

    @GetMapping("/agents")
    public Map<String, Object> listAgents() {
        return Map.of("items", adminService.listAgents());
    }

    @PostMapping("/agents")
    public ResponseEntity<SecurityAdminService.IssueAgentResult> issueAgent(
            @RequestBody(required = false) CreateAgentRequest request,
            HttpServletRequest httpRequest
    ) {
        if (request == null) {
            throw new IllegalArgumentException("请求正文不能为空");
        }
        String owner = AuthContext.username() == null ? "ADMIN" : AuthContext.username();
        SecurityAdminService.IssueAgentResult issued = adminService.issueAgent(
                request.name(), request.scopes(), request.description(), request.ttlHours(), owner
        );
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("name", issued.agent().name());
        detail.put("scopes", issued.agent().scopes());
        auditService.record(
                AuthContext.current(),
                "AGENT_ISSUE",
                "AGENT",
                issued.agent().agentId(),
                "POST",
                "/api/v2/agents",
                "SUCCESS",
                201,
                httpRequest == null ? null : httpRequest.getRemoteAddr(),
                detail
        );
        return ResponseEntity.status(HttpStatus.CREATED).body(issued);
    }

    @PostMapping("/agents/{agentId}/revoke")
    public SecurityAdminService.AgentCredentialView revokeAgent(
            @PathVariable("agentId") String agentId,
            @RequestBody(required = false) RevokeAgentRequest request,
            HttpServletRequest httpRequest
    ) {
        SecurityAdminService.AgentCredentialView revoked = adminService.revokeAgent(agentId);
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("tokenVersion", revoked.tokenVersion());
        if (request != null && request.reason() != null && !request.reason().isBlank()) {
            detail.put("reason", request.reason().trim());
        }
        auditService.record(
                AuthContext.current(),
                "AGENT_REVOKE",
                "AGENT",
                revoked.agentId(),
                "POST",
                "/api/v2/agents/" + revoked.agentId() + "/revoke",
                "SUCCESS",
                200,
                httpRequest == null ? null : httpRequest.getRemoteAddr(),
                detail
        );
        return revoked;
    }
}
