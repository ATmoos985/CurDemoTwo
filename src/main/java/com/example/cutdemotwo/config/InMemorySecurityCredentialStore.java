package com.example.cutdemotwo.config;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/**
 * 内存安全凭据存储（用于纯单元测试与未装配外部持久化时的默认兜底）。
 */
public final class InMemorySecurityCredentialStore implements SecurityCredentialStore {
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();
    private final Map<String, UserRecord> users = new LinkedHashMap<>();
    private final Map<String, TokenRevocationRecord> revocations = new LinkedHashMap<>();
    private final Map<String, AgentRecord> agents = new LinkedHashMap<>();

    @Override
    public long countUsers() {
        lock.readLock().lock();
        try {
            return users.size();
        } finally {
            lock.readLock().unlock();
        }
    }

    @Override
    public Optional<UserRecord> findUser(String username) {
        if (username == null) return Optional.empty();
        lock.readLock().lock();
        try {
            return Optional.ofNullable(users.get(username));
        } finally {
            lock.readLock().unlock();
        }
    }

    @Override
    public List<UserRecord> listUsers() {
        lock.readLock().lock();
        try {
            return users.values().stream()
                    .sorted(Comparator.comparing(UserRecord::createdAt).thenComparing(UserRecord::username))
                    .toList();
        } finally {
            lock.readLock().unlock();
        }
    }

    @Override
    public void createUserIfAbsent(UserRecord user) {
        lock.writeLock().lock();
        try {
            users.putIfAbsent(user.username(), user);
        } finally {
            lock.writeLock().unlock();
        }
    }

    @Override
    public UserRecord createUser(UserRecord user) {
        lock.writeLock().lock();
        try {
            if (users.containsKey(user.username())) {
                throw new IllegalStateException("用户名已存在：" + user.username());
            }
            users.put(user.username(), user);
            return user;
        } finally {
            lock.writeLock().unlock();
        }
    }

    @Override
    public UserRecord updateUserProfile(String username, String displayName, String role, long updatedAt) {
        lock.writeLock().lock();
        try {
            UserRecord existing = users.get(username);
            if (existing == null) {
                throw new IllegalArgumentException("用户不存在：" + username);
            }
            boolean roleChanged = !existing.role().equals(role);
            if (roleChanged && AuthContext.ROLE_ADMIN.equals(existing.role()) && existing.enabled()
                    && countActiveAdminsLocked() <= 1) {
                throw new IllegalStateException("不能降级最后一个活跃管理员账号");
            }
            long nextVer = roleChanged ? existing.tokenVersion() + 1 : existing.tokenVersion();
            UserRecord updated = new UserRecord(
                    existing.username(),
                    displayName,
                    role,
                    existing.passwordHash(),
                    existing.enabled(),
                    nextVer,
                    existing.createdAt(),
                    updatedAt,
                    existing.lastLoginAt(),
                    existing.passwordUpdatedAt()
            );
            users.put(username, updated);
            return updated;
        } finally {
            lock.writeLock().unlock();
        }
    }

    @Override
    public UserRecord updateUserStatus(String username, boolean enabled, long updatedAt) {
        lock.writeLock().lock();
        try {
            UserRecord existing = users.get(username);
            if (existing == null) {
                throw new IllegalArgumentException("用户不存在：" + username);
            }
            if (!enabled && AuthContext.ROLE_ADMIN.equals(existing.role()) && existing.enabled()
                    && countActiveAdminsLocked() <= 1) {
                throw new IllegalStateException("不能禁用最后一个活跃管理员账号");
            }
            long nextVer = existing.enabled() != enabled ? existing.tokenVersion() + 1 : existing.tokenVersion();
            UserRecord updated = new UserRecord(
                    existing.username(),
                    existing.displayName(),
                    existing.role(),
                    existing.passwordHash(),
                    enabled,
                    nextVer,
                    existing.createdAt(),
                    updatedAt,
                    existing.lastLoginAt(),
                    existing.passwordUpdatedAt()
            );
            users.put(username, updated);
            return updated;
        } finally {
            lock.writeLock().unlock();
        }
    }

    @Override
    public UserRecord updatePassword(String username, String newPasswordHash, long updatedAt) {
        lock.writeLock().lock();
        try {
            UserRecord existing = users.get(username);
            if (existing == null) {
                throw new IllegalArgumentException("用户不存在：" + username);
            }
            UserRecord updated = new UserRecord(
                    existing.username(),
                    existing.displayName(),
                    existing.role(),
                    newPasswordHash,
                    existing.enabled(),
                    existing.tokenVersion() + 1,
                    existing.createdAt(),
                    updatedAt,
                    existing.lastLoginAt(),
                    updatedAt
            );
            users.put(username, updated);
            return updated;
        } finally {
            lock.writeLock().unlock();
        }
    }

    @Override
    public void touchUserLastLogin(String username, long loginAt) {
        lock.writeLock().lock();
        try {
            UserRecord existing = users.get(username);
            if (existing != null) {
                users.put(username, new UserRecord(
                        existing.username(),
                        existing.displayName(),
                        existing.role(),
                        existing.passwordHash(),
                        existing.enabled(),
                        existing.tokenVersion(),
                        existing.createdAt(),
                        existing.updatedAt(),
                        loginAt,
                        existing.passwordUpdatedAt()
                ));
            }
        } finally {
            lock.writeLock().unlock();
        }
    }

    @Override
    public void revokeToken(TokenRevocationRecord revocation) {
        lock.writeLock().lock();
        try {
            revocations.put(revocation.jti(), revocation);
        } finally {
            lock.writeLock().unlock();
        }
    }

    @Override
    public boolean isTokenRevoked(String jti) {
        if (jti == null || jti.isBlank()) return false;
        lock.readLock().lock();
        try {
            return revocations.containsKey(jti);
        } finally {
            lock.readLock().unlock();
        }
    }

    @Override
    public int purgeExpiredRevocations(long nowEpochMs) {
        lock.writeLock().lock();
        try {
            List<String> expired = new ArrayList<>();
            for (var entry : revocations.entrySet()) {
                if (entry.getValue().expiresAt() <= nowEpochMs) {
                    expired.add(entry.getKey());
                }
            }
            expired.forEach(revocations::remove);
            return expired.size();
        } finally {
            lock.writeLock().unlock();
        }
    }

    @Override
    public Optional<AgentRecord> findAgent(String agentId) {
        if (agentId == null) return Optional.empty();
        lock.readLock().lock();
        try {
            return Optional.ofNullable(agents.get(agentId));
        } finally {
            lock.readLock().unlock();
        }
    }

    @Override
    public List<AgentRecord> listAgents() {
        lock.readLock().lock();
        try {
            return agents.values().stream()
                    .sorted(Comparator.comparing(AgentRecord::createdAt).reversed().thenComparing(AgentRecord::agentId))
                    .toList();
        } finally {
            lock.readLock().unlock();
        }
    }

    @Override
    public AgentRecord createAgent(AgentRecord agent) {
        lock.writeLock().lock();
        try {
            if (agents.containsKey(agent.agentId())) {
                throw new IllegalStateException("Agent ID 已存在：" + agent.agentId());
            }
            agents.put(agent.agentId(), agent);
            return agent;
        } finally {
            lock.writeLock().unlock();
        }
    }

    @Override
    public AgentRecord revokeAgent(String agentId, long revokedAt) {
        lock.writeLock().lock();
        try {
            AgentRecord existing = agents.get(agentId);
            if (existing == null) {
                throw new IllegalArgumentException("Agent 不存在：" + agentId);
            }
            AgentRecord updated = new AgentRecord(
                    existing.agentId(),
                    existing.name(),
                    existing.ownerUsername(),
                    existing.scopes(),
                    false,
                    existing.tokenVersion() + 1,
                    existing.description(),
                    existing.createdAt(),
                    revokedAt,
                    existing.expiresAt(),
                    existing.revokedAt() != null ? existing.revokedAt() : revokedAt,
                    existing.lastUsedAt()
            );
            agents.put(agentId, updated);
            return updated;
        } finally {
            lock.writeLock().unlock();
        }
    }

    @Override
    public void touchAgentLastUsed(String agentId, long usedAt) {
        lock.writeLock().lock();
        try {
            AgentRecord existing = agents.get(agentId);
            if (existing != null) {
                agents.put(agentId, new AgentRecord(
                        existing.agentId(),
                        existing.name(),
                        existing.ownerUsername(),
                        existing.scopes(),
                        existing.enabled(),
                        existing.tokenVersion(),
                        existing.description(),
                        existing.createdAt(),
                        existing.updatedAt(),
                        existing.expiresAt(),
                        existing.revokedAt(),
                        usedAt
                ));
            }
        } finally {
            lock.writeLock().unlock();
        }
    }

    private long countActiveAdminsLocked() {
        return users.values().stream()
                .filter(u -> u.enabled() && AuthContext.ROLE_ADMIN.equals(u.role()))
                .count();
    }
}
