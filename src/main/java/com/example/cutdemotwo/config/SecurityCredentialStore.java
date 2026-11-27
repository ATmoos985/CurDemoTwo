package com.example.cutdemotwo.config;

import java.util.List;
import java.util.Optional;

/**
 * 用户凭据、令牌吊销与 AI Agent 凭证的统一持久化抽象（支持 MySQL/H2 JDBC、File JSON 与内存三种后端）。
 */
public interface SecurityCredentialStore {

    record UserRecord(
            String username,
            String displayName,
            String role,
            String passwordHash,
            boolean enabled,
            long tokenVersion,
            long createdAt,
            long updatedAt,
            Long lastLoginAt,
            Long passwordUpdatedAt
    ) {}

    record TokenRevocationRecord(
            String jti,
            String actorType,
            String subjectId,
            String reason,
            long revokedAt,
            long expiresAt
    ) {}

    record AgentRecord(
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
    ) {
        public AgentRecord {
            scopes = scopes == null ? List.of() : List.copyOf(scopes);
        }
    }

    long countUsers();

    Optional<UserRecord> findUser(String username);

    List<UserRecord> listUsers();

    void createUserIfAbsent(UserRecord user);

    UserRecord createUser(UserRecord user);

    UserRecord updateUserProfile(String username, String displayName, String role, long updatedAt);

    UserRecord updateUserStatus(String username, boolean enabled, long updatedAt);

    UserRecord updatePassword(String username, String newPasswordHash, long updatedAt);

    void touchUserLastLogin(String username, long loginAt);

    void revokeToken(TokenRevocationRecord revocation);

    boolean isTokenRevoked(String jti);

    int purgeExpiredRevocations(long nowEpochMs);

    Optional<AgentRecord> findAgent(String agentId);

    List<AgentRecord> listAgents();

    AgentRecord createAgent(AgentRecord agent);

    AgentRecord revokeAgent(String agentId, long revokedAt);

    void touchAgentLastUsed(String agentId, long usedAt);
}
