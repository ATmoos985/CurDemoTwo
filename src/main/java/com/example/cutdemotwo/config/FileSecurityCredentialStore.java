package com.example.cutdemotwo.config;

import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/**
 * File 模式安全凭据存储（独立目录 {@code *.security/}，与 {@code cutdemo-state.json} 解耦）：
 * 使用 {@link ReentrantReadWriteLock} + 临时文件原子替换落盘 {@code users.json}、{@code revocations.json}、{@code agents.json}。
 */
public final class FileSecurityCredentialStore implements SecurityCredentialStore {
    private static final JsonMapper JSON = JsonMapper.builder().build();

    private final Path directory;
    private final Path usersFile;
    private final Path revocationsFile;
    private final Path agentsFile;
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();
    private final Map<String, UserRecord> users = new LinkedHashMap<>();
    private final Map<String, TokenRevocationRecord> revocations = new LinkedHashMap<>();
    private final Map<String, AgentRecord> agents = new LinkedHashMap<>();

    public FileSecurityCredentialStore(String directoryPath) {
        Objects.requireNonNull(directoryPath, "安全凭据目录不能为空");
        this.directory = Path.of(directoryPath);
        this.usersFile = this.directory.resolve("users.json");
        this.revocationsFile = this.directory.resolve("revocations.json");
        this.agentsFile = this.directory.resolve("agents.json");
        loadAll();
    }

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
            if (!users.containsKey(user.username())) {
                users.put(user.username(), user);
                persistUsersLocked();
            }
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
            persistUsersLocked();
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
            persistUsersLocked();
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
            persistUsersLocked();
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
            persistUsersLocked();
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
                persistUsersLocked();
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
            persistRevocationsLocked();
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
            if (expired.isEmpty()) return 0;
            expired.forEach(revocations::remove);
            persistRevocationsLocked();
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
            persistAgentsLocked();
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
            persistAgentsLocked();
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
                persistAgentsLocked();
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

    private void loadAll() {
        lock.writeLock().lock();
        try {
            Files.createDirectories(directory);
            if (Files.exists(usersFile)) {
                UserRecord[] loaded = JSON.readValue(Files.readAllBytes(usersFile), UserRecord[].class);
                if (loaded != null) {
                    for (UserRecord user : loaded) {
                        if (user != null && user.username() != null) {
                            users.put(user.username(), user);
                        }
                    }
                }
            }
            if (Files.exists(revocationsFile)) {
                TokenRevocationRecord[] loaded = JSON.readValue(Files.readAllBytes(revocationsFile), TokenRevocationRecord[].class);
                if (loaded != null) {
                    for (TokenRevocationRecord item : loaded) {
                        if (item != null && item.jti() != null) {
                            revocations.put(item.jti(), item);
                        }
                    }
                }
            }
            if (Files.exists(agentsFile)) {
                AgentRecord[] loaded = JSON.readValue(Files.readAllBytes(agentsFile), AgentRecord[].class);
                if (loaded != null) {
                    for (AgentRecord agent : loaded) {
                        if (agent != null && agent.agentId() != null) {
                            agents.put(agent.agentId(), agent);
                        }
                    }
                }
            }
        } catch (IOException error) {
            throw new UncheckedIOException("读取本地安全凭据目录失败：" + directory, error);
        } finally {
            lock.writeLock().unlock();
        }
    }

    private void persistUsersLocked() {
        writeAtomically(usersFile, new ArrayList<>(users.values()));
    }

    private void persistRevocationsLocked() {
        writeAtomically(revocationsFile, new ArrayList<>(revocations.values()));
    }

    private void persistAgentsLocked() {
        writeAtomically(agentsFile, new ArrayList<>(agents.values()));
    }

    private void writeAtomically(Path target, Object payload) {
        try {
            Files.createDirectories(directory);
            Path tmp = Files.createTempFile(directory, target.getFileName().toString(), ".tmp");
            Files.write(tmp, JSON.writerWithDefaultPrettyPrinter().writeValueAsBytes(payload));
            try {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException fallback) {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException error) {
            throw new UncheckedIOException("写入本地安全凭据文件失败：" + target, error);
        }
    }
}
