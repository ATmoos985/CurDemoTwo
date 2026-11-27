package com.example.cutdemotwo.config;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

import javax.sql.DataSource;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * JDBC 模式安全凭据存储（MySQL 8.4 与 H2 MySQL 模式双兼容，读写 {@code sys_user}、{@code sys_token_revocation}、{@code sys_agent_credential}）。
 */
public final class JdbcSecurityCredentialStore implements SecurityCredentialStore {
    private static final JsonMapper JSON = JsonMapper.builder().build();

    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;

    public JdbcSecurityCredentialStore(DataSource source) {
        Objects.requireNonNull(source, "数据源不能为空");
        this.jdbc = new JdbcTemplate(source);
        this.transaction = new TransactionTemplate(new DataSourceTransactionManager(source));
        this.transaction.setTimeout(5);
    }

    @Override
    public long countUsers() {
        Long count = jdbc.queryForObject("SELECT COUNT(*) FROM sys_user", Long.class);
        return count == null ? 0L : count;
    }

    @Override
    public Optional<UserRecord> findUser(String username) {
        if (username == null) return Optional.empty();
        List<UserRecord> rows = jdbc.query(
                "SELECT username, display_name, role, password_hash, enabled, token_version, created_at, updated_at, last_login_at, password_updated_at FROM sys_user WHERE username = ?",
                (rs, idx) -> mapUser(rs),
                username
        );
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    @Override
    public List<UserRecord> listUsers() {
        return jdbc.query(
                "SELECT username, display_name, role, password_hash, enabled, token_version, created_at, updated_at, last_login_at, password_updated_at FROM sys_user ORDER BY created_at ASC, username ASC",
                (rs, idx) -> mapUser(rs)
        );
    }

    @Override
    public void createUserIfAbsent(UserRecord user) {
        transaction.executeWithoutResult(status -> {
            if (findUser(user.username()).isPresent()) {
                return;
            }
            try {
                insertUser(user);
            } catch (DuplicateKeyException ignored) {
                // 多实例并发首启时允许其余节点跳过
            }
        });
    }

    @Override
    public UserRecord createUser(UserRecord user) {
        return transaction.execute(status -> {
            if (findUser(user.username()).isPresent()) {
                throw new IllegalStateException("用户名已存在：" + user.username());
            }
            try {
                insertUser(user);
            } catch (DuplicateKeyException duplicate) {
                throw new IllegalStateException("用户名已存在：" + user.username(), duplicate);
            }
            return user;
        });
    }

    @Override
    public UserRecord updateUserProfile(String username, String displayName, String role, long updatedAt) {
        return transaction.execute(status -> {
            // 固定锁序：ALL_ACTIVE_ADMINS (ORDER BY username ASC) -> TARGET_ROW，避免并发修改管理员席位触发 AB-BA 死锁
            long activeAdmins = countActiveAdminsInTx();
            UserRecord existing = findUserForUpdate(username)
                    .orElseThrow(() -> new IllegalArgumentException("用户不存在：" + username));
            boolean roleChanged = !existing.role().equals(role);
            if (roleChanged && AuthContext.ROLE_ADMIN.equals(existing.role()) && existing.enabled()
                    && activeAdmins <= 1) {
                throw new IllegalStateException("不能降级最后一个活跃管理员账号");
            }
            long nextVer = roleChanged ? existing.tokenVersion() + 1 : existing.tokenVersion();
            jdbc.update(
                    "UPDATE sys_user SET display_name = ?, role = ?, token_version = ?, updated_at = ? WHERE username = ?",
                    displayName, role, nextVer, updatedAt, username
            );
            return findUser(username).orElseThrow();
        });
    }

    @Override
    public UserRecord updateUserStatus(String username, boolean enabled, long updatedAt) {
        return transaction.execute(status -> {
            // 固定锁序：ALL_ACTIVE_ADMINS (ORDER BY username ASC) -> TARGET_ROW，避免双管理员并发互相禁用触发 AB-BA 死锁
            long activeAdmins = countActiveAdminsInTx();
            UserRecord existing = findUserForUpdate(username)
                    .orElseThrow(() -> new IllegalArgumentException("用户不存在：" + username));
            if (!enabled && AuthContext.ROLE_ADMIN.equals(existing.role()) && existing.enabled()
                    && activeAdmins <= 1) {
                throw new IllegalStateException("不能禁用最后一个活跃管理员账号");
            }
            long nextVer = existing.enabled() != enabled ? existing.tokenVersion() + 1 : existing.tokenVersion();
            jdbc.update(
                    "UPDATE sys_user SET enabled = ?, token_version = ?, updated_at = ? WHERE username = ?",
                    enabled, nextVer, updatedAt, username
            );
            return findUser(username).orElseThrow();
        });
    }

    @Override
    public UserRecord updatePassword(String username, String newPasswordHash, long updatedAt) {
        return transaction.execute(status -> {
            UserRecord existing = findUserForUpdate(username)
                    .orElseThrow(() -> new IllegalArgumentException("用户不存在：" + username));
            long nextVer = existing.tokenVersion() + 1;
            jdbc.update(
                    "UPDATE sys_user SET password_hash = ?, token_version = ?, updated_at = ?, password_updated_at = ? WHERE username = ?",
                    newPasswordHash, nextVer, updatedAt, updatedAt, username
            );
            return findUser(username).orElseThrow();
        });
    }

    @Override
    public void touchUserLastLogin(String username, long loginAt) {
        jdbc.update("UPDATE sys_user SET last_login_at = ? WHERE username = ?", loginAt, username);
    }

    @Override
    public void revokeToken(TokenRevocationRecord revocation) {
        transaction.executeWithoutResult(status -> {
            Integer exists = jdbc.queryForObject(
                    "SELECT COUNT(*) FROM sys_token_revocation WHERE jti = ?",
                    Integer.class,
                    revocation.jti()
            );
            if (exists != null && exists > 0) {
                return;
            }
            try {
                jdbc.update(
                        "INSERT INTO sys_token_revocation(jti, actor_type, subject_id, reason, revoked_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
                        revocation.jti(),
                        revocation.actorType(),
                        revocation.subjectId(),
                        revocation.reason(),
                        revocation.revokedAt(),
                        revocation.expiresAt()
                );
            } catch (DuplicateKeyException ignored) {
                // 幂等忽略重复吊销
            }
        });
    }

    @Override
    public boolean isTokenRevoked(String jti) {
        if (jti == null || jti.isBlank()) return false;
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM sys_token_revocation WHERE jti = ?",
                Integer.class,
                jti
        );
        return count != null && count > 0;
    }

    @Override
    public int purgeExpiredRevocations(long nowEpochMs) {
        return jdbc.update("DELETE FROM sys_token_revocation WHERE expires_at <= ?", nowEpochMs);
    }

    @Override
    public Optional<AgentRecord> findAgent(String agentId) {
        if (agentId == null) return Optional.empty();
        List<AgentRecord> rows = jdbc.query(
                "SELECT agent_id, name, owner_username, scopes_json, enabled, token_version, description, created_at, updated_at, expires_at, revoked_at, last_used_at FROM sys_agent_credential WHERE agent_id = ?",
                (rs, idx) -> mapAgent(rs),
                agentId
        );
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    @Override
    public List<AgentRecord> listAgents() {
        return jdbc.query(
                "SELECT agent_id, name, owner_username, scopes_json, enabled, token_version, description, created_at, updated_at, expires_at, revoked_at, last_used_at FROM sys_agent_credential ORDER BY created_at DESC, agent_id ASC",
                (rs, idx) -> mapAgent(rs)
        );
    }

    @Override
    public AgentRecord createAgent(AgentRecord agent) {
        return transaction.execute(status -> {
            if (findAgent(agent.agentId()).isPresent()) {
                throw new IllegalStateException("Agent ID 已存在：" + agent.agentId());
            }
            jdbc.update(
                    "INSERT INTO sys_agent_credential(agent_id, name, owner_username, scopes_json, enabled, token_version, description, created_at, updated_at, expires_at, revoked_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    agent.agentId(),
                    agent.name(),
                    agent.ownerUsername(),
                    JSON.writeValueAsString(agent.scopes()),
                    agent.enabled(),
                    agent.tokenVersion(),
                    agent.description(),
                    agent.createdAt(),
                    agent.updatedAt(),
                    agent.expiresAt(),
                    agent.revokedAt(),
                    agent.lastUsedAt()
            );
            return agent;
        });
    }

    @Override
    public AgentRecord revokeAgent(String agentId, long revokedAt) {
        return transaction.execute(status -> {
            List<AgentRecord> rows = jdbc.query(
                    "SELECT agent_id, name, owner_username, scopes_json, enabled, token_version, description, created_at, updated_at, expires_at, revoked_at, last_used_at FROM sys_agent_credential WHERE agent_id = ? FOR UPDATE",
                    (rs, idx) -> mapAgent(rs),
                    agentId
            );
            if (rows.isEmpty()) {
                throw new IllegalArgumentException("Agent 不存在：" + agentId);
            }
            AgentRecord existing = rows.get(0);
            long effectiveRevokedAt = existing.revokedAt() != null ? existing.revokedAt() : revokedAt;
            jdbc.update(
                    "UPDATE sys_agent_credential SET enabled = ?, token_version = ?, updated_at = ?, revoked_at = ? WHERE agent_id = ?",
                    false,
                    existing.tokenVersion() + 1,
                    revokedAt,
                    effectiveRevokedAt,
                    agentId
            );
            return findAgent(agentId).orElseThrow();
        });
    }

    @Override
    public void touchAgentLastUsed(String agentId, long usedAt) {
        jdbc.update("UPDATE sys_agent_credential SET last_used_at = ? WHERE agent_id = ?", usedAt, agentId);
    }

    private Optional<UserRecord> findUserForUpdate(String username) {
        List<UserRecord> rows = jdbc.query(
                "SELECT username, display_name, role, password_hash, enabled, token_version, created_at, updated_at, last_login_at, password_updated_at FROM sys_user WHERE username = ? FOR UPDATE",
                (rs, idx) -> mapUser(rs),
                username
        );
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    private long countActiveAdminsInTx() {
        jdbc.query(
                "SELECT username FROM sys_user WHERE role = ? ORDER BY username ASC FOR UPDATE",
                (rs, idx) -> rs.getString("username"),
                AuthContext.ROLE_ADMIN
        );
        List<String> adminUsernames = jdbc.query(
                "SELECT username FROM sys_user WHERE role = ? AND enabled = ? ORDER BY username ASC FOR UPDATE",
                (rs, idx) -> rs.getString("username"),
                AuthContext.ROLE_ADMIN,
                Boolean.TRUE
        );
        return adminUsernames.size();
    }

    private void insertUser(UserRecord user) {
        jdbc.update(
                "INSERT INTO sys_user(username, display_name, role, password_hash, enabled, token_version, created_at, updated_at, last_login_at, password_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                user.username(),
                user.displayName(),
                user.role(),
                user.passwordHash(),
                user.enabled(),
                user.tokenVersion(),
                user.createdAt(),
                user.updatedAt(),
                user.lastLoginAt(),
                user.passwordUpdatedAt()
        );
    }

    private static UserRecord mapUser(ResultSet rs) throws SQLException {
        return new UserRecord(
                rs.getString("username"),
                rs.getString("display_name"),
                rs.getString("role"),
                rs.getString("password_hash"),
                rs.getBoolean("enabled"),
                rs.getLong("token_version"),
                rs.getLong("created_at"),
                rs.getLong("updated_at"),
                rs.getObject("last_login_at") == null ? null : rs.getLong("last_login_at"),
                rs.getObject("password_updated_at") == null ? null : rs.getLong("password_updated_at")
        );
    }

    private static AgentRecord mapAgent(ResultSet rs) throws SQLException {
        String scopesJson = rs.getString("scopes_json");
        List<String> scopes = List.of();
        if (scopesJson != null && !scopesJson.isBlank()) {
            String[] parsed = JSON.readValue(scopesJson, String[].class);
            scopes = parsed == null ? List.of() : Arrays.asList(parsed);
        }
        return new AgentRecord(
                rs.getString("agent_id"),
                rs.getString("name"),
                rs.getString("owner_username"),
                scopes,
                rs.getBoolean("enabled"),
                rs.getLong("token_version"),
                rs.getString("description"),
                rs.getLong("created_at"),
                rs.getLong("updated_at"),
                rs.getObject("expires_at") == null ? null : rs.getLong("expires_at"),
                rs.getObject("revoked_at") == null ? null : rs.getLong("revoked_at"),
                rs.getObject("last_used_at") == null ? null : rs.getLong("last_used_at")
        );
    }
}
