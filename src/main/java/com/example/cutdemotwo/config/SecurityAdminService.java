package com.example.cutdemotwo.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * 管理员安全管理服务：提供用户全生命周期管理、AI Agent 受限凭证签发与吊销，以及定期清理过期吊销表记录。
 */
@Service
public class SecurityAdminService {
    private static final Logger log = LoggerFactory.getLogger(SecurityAdminService.class);
    private static final Pattern VALID_USERNAME = Pattern.compile("^[A-Za-z0-9._-]{2,64}$");

    public record UserAccountView(
            String username,
            String displayName,
            String role,
            boolean enabled,
            long tokenVersion,
            long createdAt,
            long updatedAt,
            Long lastLoginAt,
            Long passwordUpdatedAt
    ) {}

    public record AgentCredentialView(
            String agentId,
            String name,
            String ownerUsername,
            List<String> scopes,
            boolean enabled,
            long tokenVersion,
            String description,
            long createdAt,
            long updatedAt,
            Long expiresAt,
            Long revokedAt,
            Long lastUsedAt
    ) {}

    public record IssueAgentResult(AgentCredentialView agent, String token) {}

    private final SecurityCredentialStore store;
    private final AuthService authService;
    private final Clock clock;

    @Autowired
    public SecurityAdminService(SecurityCredentialStore store, AuthService authService) {
        this(store, authService, authService.getClock());
    }

    public SecurityAdminService(SecurityCredentialStore store, AuthService authService, Clock clock) {
        this.store = store;
        this.authService = authService;
        this.clock = clock == null ? Clock.systemUTC() : clock;
    }

    public List<UserAccountView> listUsers() {
        return store.listUsers().stream().map(SecurityAdminService::toUserView).toList();
    }

    public UserAccountView createUser(String username, String displayName, String role, String password) {
        String cleanUsername = requireValidUsername(username);
        String cleanRole = requireValidRole(role);
        String cleanDisplay = (displayName == null || displayName.isBlank()) ? cleanUsername : displayName.trim();
        if (password == null || password.length() < 6) {
            throw new IllegalArgumentException("初始密码长度不能少于 6 位");
        }
        long nowMs = clock.millis();
        SecurityCredentialStore.UserRecord created = store.createUser(new SecurityCredentialStore.UserRecord(
                cleanUsername,
                cleanDisplay,
                cleanRole,
                PasswordHasher.hash(password),
                true,
                1L,
                nowMs,
                nowMs,
                null,
                nowMs
        ));
        return toUserView(created);
    }

    public UserAccountView updateUser(String username, String displayName, String role) {
        String cleanUsername = requireValidUsername(username);
        String cleanRole = requireValidRole(role);
        String cleanDisplay = (displayName == null || displayName.isBlank()) ? cleanUsername : displayName.trim();
        return toUserView(store.updateUserProfile(cleanUsername, cleanDisplay, cleanRole, clock.millis()));
    }

    public UserAccountView updateUserStatus(String username, boolean enabled) {
        String cleanUsername = requireValidUsername(username);
        return toUserView(store.updateUserStatus(cleanUsername, enabled, clock.millis()));
    }

    public long resetUserPassword(String username, String newPassword) {
        String cleanUsername = requireValidUsername(username);
        if (newPassword == null || newPassword.length() < 6) {
            throw new IllegalArgumentException("重置密码长度不能少于 6 位");
        }
        SecurityCredentialStore.UserRecord updated = store.updatePassword(
                cleanUsername, PasswordHasher.hash(newPassword), clock.millis()
        );
        return updated.tokenVersion();
    }

    public List<AgentCredentialView> listAgents() {
        return store.listAgents().stream().map(SecurityAdminService::toAgentView).toList();
    }

    public IssueAgentResult issueAgent(
            String name,
            List<String> scopes,
            String description,
            Long ttlHours,
            String ownerUsername
    ) {
        if (name == null || name.isBlank()) {
            throw new IllegalArgumentException("Agent 名称不能为空");
        }
        List<String> cleanScopes = sanitizeScopes(scopes);
        if (cleanScopes.isEmpty()) {
            throw new IllegalArgumentException("必须至少为 AI Agent 分配一个合法作用域（scopes）");
        }
        long nowMs = clock.millis();
        long effectiveHours = (ttlHours != null && ttlHours > 0) ? ttlHours : 720L;
        Long expiresAt = nowMs + effectiveHours * 3600_000L;
        String cleanOwner = (ownerUsername == null || ownerUsername.isBlank()) ? "ADMIN" : ownerUsername.trim();
        String agentId = "AGT-" + UUID.randomUUID().toString().replace("-", "").substring(0, 12).toUpperCase(Locale.ROOT);
        SecurityCredentialStore.AgentRecord record = new SecurityCredentialStore.AgentRecord(
                agentId,
                name.trim(),
                cleanOwner,
                cleanScopes,
                true,
                1L,
                description == null ? null : description.trim(),
                nowMs,
                nowMs,
                expiresAt,
                null,
                null
        );
        SecurityCredentialStore.AgentRecord saved = store.createAgent(record);
        String token = authService.issueAgentToken(saved, effectiveHours * 3600L);
        return new IssueAgentResult(toAgentView(saved), token);
    }

    public AgentCredentialView revokeAgent(String agentId) {
        if (agentId == null || agentId.isBlank()) {
            throw new IllegalArgumentException("agentId 不能为空");
        }
        SecurityCredentialStore.AgentRecord updated = store.revokeAgent(agentId.trim(), clock.millis());
        return toAgentView(updated);
    }

    @Scheduled(fixedDelay = 3_600_000L, initialDelay = 300_000L)
    public void purgeExpiredTokenRevocations() {
        try {
            int deleted = store.purgeExpiredRevocations(clock.millis());
            if (deleted > 0) {
                log.debug("已清理过期令牌吊销记录 {} 条", deleted);
            }
        } catch (RuntimeException ex) {
            log.warn("清理过期令牌吊销记录失败", ex);
        }
    }

    private static List<String> sanitizeScopes(List<String> scopes) {
        if (scopes == null || scopes.isEmpty()) {
            return List.of();
        }
        return scopes.stream()
                .filter(s -> s != null && !s.isBlank())
                .map(s -> s.trim().toUpperCase(Locale.ROOT))
                .map(s -> {
                    if (!AuthContext.AGENT_ALLOWED_SCOPES.contains(s)) {
                        throw new IllegalArgumentException("不支持的 AI Agent 作用域：" + s);
                    }
                    return s;
                })
                .distinct()
                .toList();
    }

    private static String requireValidUsername(String username) {
        if (username == null || username.isBlank()) {
            throw new IllegalArgumentException("用户名不能为空");
        }
        String trimmed = username.trim();
        if (!VALID_USERNAME.matcher(trimmed).matches()) {
            throw new IllegalArgumentException("用户名仅支持 2-64 位字母、数字及 . _ -");
        }
        return trimmed;
    }

    private static String requireValidRole(String role) {
        if (role == null || role.isBlank()) {
            throw new IllegalArgumentException("角色不能为空");
        }
        String upper = role.trim().toUpperCase(Locale.ROOT);
        if (!AuthContext.ALL_ROLES.contains(upper)) {
            throw new IllegalArgumentException("不支持的用户角色：" + role);
        }
        return upper;
    }

    private static UserAccountView toUserView(SecurityCredentialStore.UserRecord r) {
        return new UserAccountView(
                r.username(),
                r.displayName(),
                r.role(),
                r.enabled(),
                r.tokenVersion(),
                r.createdAt(),
                r.updatedAt(),
                r.lastLoginAt(),
                r.passwordUpdatedAt()
        );
    }

    private static AgentCredentialView toAgentView(SecurityCredentialStore.AgentRecord r) {
        return new AgentCredentialView(
                r.agentId(),
                r.name(),
                r.ownerUsername(),
                r.scopes(),
                r.enabled(),
                r.tokenVersion(),
                r.description(),
                r.createdAt(),
                r.updatedAt(),
                r.expiresAt(),
                r.revokedAt(),
                r.lastUsedAt()
        );
    }
}
