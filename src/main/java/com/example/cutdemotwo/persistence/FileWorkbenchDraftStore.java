package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.contracts.jobs.WorkbenchSchemeDraft;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.file.AccessDeniedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import java.util.function.UnaryOperator;

/**
 * 文件模式工作台草案持久化存储：
 * 独立写入 {@code *.drafts} 目录并采用独占锁 + 读写锁 + 原子替换，绝不触碰实物库存文件或库存 revision。
 */
public final class FileWorkbenchDraftStore implements WorkbenchDraftStore {
    private static final String VALID_ID_PATTERN = "[A-Za-z0-9._-]{1,128}";

    private final Path directory;
    private final FileChannel channel;
    private final FileLock lock;
    private final ReentrantReadWriteLock rwLock = new ReentrantReadWriteLock();
    private final JsonMapper json = JsonMapper.builder()
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .build();

    public FileWorkbenchDraftStore(Path directory) {
        this.directory = Objects.requireNonNull(directory, "草案存储目录不能为空").toAbsolutePath();
        FileChannel opened = null;
        try {
            Files.createDirectories(this.directory);
            opened = FileChannel.open(this.directory.resolve("drafts.lock"), StandardOpenOption.CREATE, StandardOpenOption.WRITE);
            FileLock acquired = opened.tryLock();
            if (acquired == null) {
                throw new IllegalStateException("工作台草案存储目录已由另一服务实例占用");
            }
            this.channel = opened;
            this.lock = acquired;
        } catch (IOException | RuntimeException error) {
            if (opened != null) {
                try {
                    opened.close();
                } catch (IOException ignored) {
                }
            }
            throw new IllegalStateException("无法初始化并独占工作台草案存储目录", error);
        }
    }

    @Override
    public WorkbenchSchemeDraft save(WorkbenchSchemeDraft draft) {
        validateDraft(draft);
        rwLock.writeLock().lock();
        try {
            writeDraftLocked(draft);
            return draft;
        } finally {
            rwLock.writeLock().unlock();
        }
    }

    @Override
    public List<WorkbenchSchemeDraft> saveAll(List<WorkbenchSchemeDraft> drafts) {
        if (drafts == null || drafts.isEmpty()) {
            return List.of();
        }
        for (WorkbenchSchemeDraft draft : drafts) {
            validateDraft(draft);
        }
        rwLock.writeLock().lock();
        try {
            List<WorkbenchSchemeDraft> saved = new ArrayList<>(drafts.size());
            for (WorkbenchSchemeDraft draft : drafts) {
                writeDraftLocked(draft);
                saved.add(draft);
            }
            return List.copyOf(saved);
        } finally {
            rwLock.writeLock().unlock();
        }
    }

    private void writeDraftLocked(WorkbenchSchemeDraft draft) {
        Path target = directory.resolve(draft.draftId() + ".json");
        Path temporary = null;
        try {
            temporary = Files.createTempFile(directory, "draft-", ".tmp");
            Files.write(temporary, json.writeValueAsBytes(draft));
            try (FileChannel out = FileChannel.open(temporary, StandardOpenOption.WRITE)) {
                out.force(true);
            }
            replaceAtomically(temporary, target);
        } catch (IOException error) {
            throw new IllegalStateException("工作台草案写入失败", error);
        } finally {
            if (temporary != null) {
                try {
                    Files.deleteIfExists(temporary);
                } catch (IOException ignored) {
                }
            }
        }
    }

    @Override
    public Optional<WorkbenchSchemeDraft> find(String draftId) {
        if (draftId == null || !draftId.matches(VALID_ID_PATTERN)) {
            return Optional.empty();
        }
        rwLock.readLock().lock();
        try {
            return Optional.ofNullable(readDraftFile(draftId));
        } finally {
            rwLock.readLock().unlock();
        }
    }

    private WorkbenchSchemeDraft readDraftFile(String draftId) {
        Path file = directory.resolve(draftId + ".json");
        if (!Files.exists(file)) {
            return null;
        }
        try {
            WorkbenchSchemeDraft draft = json.readValue(file.toFile(), WorkbenchSchemeDraft.class);
            if (draft == null || !draftId.equals(draft.draftId())) {
                throw new IllegalStateException("工作台草案文件身份不一致: " + draftId);
            }
            return draft;
        } catch (RuntimeException error) {
            throw new IllegalStateException("工作台草案读取失败，原文件保留: " + draftId, error);
        }
    }

    @Override
    public List<WorkbenchSchemeDraft> listByTask(String taskId) {
        if (taskId == null || taskId.isBlank()) {
            return List.of();
        }
        rwLock.readLock().lock();
        try {
            List<WorkbenchSchemeDraft> matches = new ArrayList<>();
            for (WorkbenchSchemeDraft draft : readAllDraftsLocked()) {
                if (draft.target() != null && taskId.equals(draft.target().taskId())) {
                    matches.add(draft);
                }
            }
            matches.sort(Comparator.comparingLong((WorkbenchSchemeDraft d) -> parseEpochMillis(d.issuedAt(), 0L))
                    .reversed()
                    .thenComparing(WorkbenchSchemeDraft::draftId, Comparator.nullsLast(Comparator.reverseOrder())));
            return List.copyOf(matches);
        } finally {
            rwLock.readLock().unlock();
        }
    }

    @Override
    public DraftPage query(DraftQuery query, long nowMs) {
        int safePage = query == null ? 0 : Math.max(0, query.page());
        int safeSize = query == null ? 20 : Math.max(1, Math.min(100, query.size()));
        String taskId = (query == null || query.taskId() == null || query.taskId().isBlank()) ? null : query.taskId().trim();
        String batchGroupId = (query == null || query.batchGroupId() == null || query.batchGroupId().isBlank()) ? null : query.batchGroupId().trim();
        String statusFilter = (query == null || query.status() == null || query.status().isBlank())
                ? null : query.status().trim().toUpperCase();

        rwLock.readLock().lock();
        try {
            List<WorkbenchSchemeDraft> all = readAllDraftsLocked();
            long pendingCount = 0L;
            List<WorkbenchSchemeDraft> filtered = new ArrayList<>();
            for (WorkbenchSchemeDraft raw : all) {
                WorkbenchSchemeDraft normalized = normalizeClockStatus(raw, nowMs);
                if (WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION.equals(normalized.status())) {
                    pendingCount++;
                }
                if (taskId != null && (normalized.target() == null || !taskId.equals(normalized.target().taskId()))) {
                    continue;
                }
                if (batchGroupId != null && !batchGroupId.equals(normalized.batchGroupId())) {
                    continue;
                }
                if (statusFilter != null && !"ALL".equals(statusFilter) && !statusFilter.equals(normalized.status())) {
                    continue;
                }
                filtered.add(normalized);
            }
            filtered.sort(Comparator.comparingLong((WorkbenchSchemeDraft d) -> parseEpochMillis(d.issuedAt(), 0L))
                    .reversed()
                    .thenComparing(WorkbenchSchemeDraft::draftId, Comparator.nullsLast(Comparator.reverseOrder())));

            long total = filtered.size();
            int from = (int) Math.min(total, (long) safePage * safeSize);
            int to = (int) Math.min(total, (long) from + safeSize);
            return new DraftPage(List.copyOf(filtered.subList(from, to)), total, safePage, safeSize, pendingCount);
        } finally {
            rwLock.readLock().unlock();
        }
    }

    @Override
    public TransitionResult transitionFromPending(
            String draftId,
            long nowMs,
            UnaryOperator<WorkbenchSchemeDraft> updater
    ) {
        if (draftId == null || !draftId.matches(VALID_ID_PATTERN)) {
            return new TransitionResult(TransitionOutcome.NOT_FOUND, null);
        }
        Objects.requireNonNull(updater, "updater");
        rwLock.writeLock().lock();
        try {
            WorkbenchSchemeDraft current = readDraftFile(draftId);
            if (current == null) {
                return new TransitionResult(TransitionOutcome.NOT_FOUND, null);
            }
            if (!WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION.equals(current.status())) {
                return new TransitionResult(TransitionOutcome.CONFLICT_STATE, current);
            }
            long expiresMs = parseEpochMillis(current.expiresAt(), Long.MAX_VALUE);
            if (expiresMs < nowMs) {
                WorkbenchSchemeDraft expired = current.withEvaluatedState(
                        WorkbenchSchemeDraft.STATUS_EXPIRED, current.stale(), current.staleReasons()
                );
                return new TransitionResult(TransitionOutcome.EXPIRED, expired);
            }
            WorkbenchSchemeDraft next = updater.apply(current);
            if (next == null) {
                throw new IllegalStateException("草案状态更新器返回 null");
            }
            writeDraftLocked(next);
            return new TransitionResult(TransitionOutcome.UPDATED, next);
        } finally {
            rwLock.writeLock().unlock();
        }
    }

    @Override
    public int expireAndPurge(long nowMs, long purgeBeforeMs) {
        rwLock.writeLock().lock();
        try (var stream = Files.list(directory)) {
            int affected = 0;
            List<Path> jsonFiles = stream.filter(p -> p.getFileName().toString().endsWith(".json")).toList();
            for (Path path : jsonFiles) {
                WorkbenchSchemeDraft draft = json.readValue(path.toFile(), WorkbenchSchemeDraft.class);
                if (draft == null) continue;
                WorkbenchSchemeDraft current = draft;
                if (WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION.equals(draft.status())) {
                    long expiresMs = parseEpochMillis(draft.expiresAt(), Long.MAX_VALUE);
                    if (expiresMs < nowMs) {
                        current = draft.withEvaluatedState(
                                WorkbenchSchemeDraft.STATUS_EXPIRED, draft.stale(), draft.staleReasons()
                        );
                        writeDraftLocked(current);
                        affected++;
                    }
                }
                if (!WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION.equals(current.status())) {
                    long terminalTs = resolveTerminalTimestamp(current);
                    if (terminalTs < purgeBeforeMs && Files.deleteIfExists(path)) {
                        affected++;
                    }
                }
            }
            return affected;
        } catch (IOException | RuntimeException error) {
            throw new IllegalStateException("清理过期工作台草案失败", error);
        } finally {
            rwLock.writeLock().unlock();
        }
    }

    @Override
    public List<String> listCleanupCandidateIds(long nowMs, long purgeBeforeMs) {
        rwLock.readLock().lock();
        try {
            List<String> ids = new ArrayList<>();
            for (WorkbenchSchemeDraft draft : readAllDraftsLocked()) {
                if (WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION.equals(draft.status())) {
                    long expiresMs = parseEpochMillis(draft.expiresAt(), Long.MAX_VALUE);
                    if (expiresMs < nowMs) {
                        ids.add(draft.draftId());
                    }
                } else {
                    long terminalTs = resolveTerminalTimestamp(draft);
                    if (terminalTs < purgeBeforeMs) {
                        ids.add(draft.draftId());
                    }
                }
            }
            return List.copyOf(ids);
        } finally {
            rwLock.readLock().unlock();
        }
    }

    @Override
    public int expireOrPurgeSingle(String draftId, long nowMs, long purgeBeforeMs) {
        if (draftId == null || !draftId.matches(VALID_ID_PATTERN)) {
            return 0;
        }
        rwLock.writeLock().lock();
        try {
            WorkbenchSchemeDraft draft = readDraftFile(draftId);
            if (draft == null) {
                return 0;
            }
            int affected = 0;
            WorkbenchSchemeDraft current = draft;
            if (WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION.equals(draft.status())) {
                long expiresMs = parseEpochMillis(draft.expiresAt(), Long.MAX_VALUE);
                if (expiresMs < nowMs) {
                    current = draft.withEvaluatedState(
                            WorkbenchSchemeDraft.STATUS_EXPIRED, draft.stale(), draft.staleReasons()
                    );
                    writeDraftLocked(current);
                    affected++;
                }
            }
            if (!WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION.equals(current.status())) {
                long terminalTs = resolveTerminalTimestamp(current);
                Path path = directory.resolve(draftId + ".json");
                if (terminalTs < purgeBeforeMs && Files.deleteIfExists(path)) {
                    affected++;
                }
            }
            return affected;
        } catch (IOException | RuntimeException error) {
            throw new IllegalStateException("清理单条过期工作台草案失败: " + draftId, error);
        } finally {
            rwLock.writeLock().unlock();
        }
    }

    private List<WorkbenchSchemeDraft> readAllDraftsLocked() {
        try (var stream = Files.list(directory)) {
            List<WorkbenchSchemeDraft> all = new ArrayList<>();
            for (Path path : stream.filter(p -> p.getFileName().toString().endsWith(".json")).toList()) {
                WorkbenchSchemeDraft draft = json.readValue(path.toFile(), WorkbenchSchemeDraft.class);
                if (draft != null) {
                    all.add(draft);
                }
            }
            return all;
        } catch (IOException | RuntimeException error) {
            throw new IllegalStateException("检索工作台草案目录失败", error);
        }
    }

    private static WorkbenchSchemeDraft normalizeClockStatus(WorkbenchSchemeDraft draft, long nowMs) {
        if (draft == null || draft.isFinalized()) {
            return draft;
        }
        long expiresMs = parseEpochMillis(draft.expiresAt(), Long.MAX_VALUE);
        if (expiresMs < nowMs && !WorkbenchSchemeDraft.STATUS_EXPIRED.equals(draft.status())) {
            return draft.withEvaluatedState(WorkbenchSchemeDraft.STATUS_EXPIRED, draft.stale(), draft.staleReasons());
        }
        return draft;
    }

    private static long resolveTerminalTimestamp(WorkbenchSchemeDraft draft) {
        long confirmed = parseEpochMillis(draft.confirmedAt(), -1L);
        if (confirmed >= 0L) return confirmed;
        long discarded = parseEpochMillis(draft.discardedAt(), -1L);
        if (discarded >= 0L) return discarded;
        long expires = parseEpochMillis(draft.expiresAt(), -1L);
        if (expires >= 0L) return expires;
        return parseEpochMillis(draft.issuedAt(), 0L);
    }

    private static long parseEpochMillis(String iso, long fallback) {
        if (iso == null || iso.isBlank()) {
            return fallback;
        }
        try {
            return Instant.parse(iso).toEpochMilli();
        } catch (RuntimeException ignored) {
            return fallback;
        }
    }

    private static void validateDraft(WorkbenchSchemeDraft draft) {
        if (draft == null || draft.draftId() == null || !draft.draftId().matches(VALID_ID_PATTERN)) {
            throw new IllegalArgumentException("工作台草案编号无效");
        }
    }

    private void replaceAtomically(Path source, Path target) throws IOException {
        for (int delayMillis = 10; ; delayMillis *= 2) {
            try {
                Files.move(source, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                return;
            } catch (AccessDeniedException denied) {
                if (delayMillis > 160) {
                    throw denied;
                }
                try {
                    Thread.sleep(delayMillis);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    denied.addSuppressed(interrupted);
                    throw denied;
                }
            }
        }
    }

    @Override
    public void close() {
        try {
            lock.release();
            channel.close();
        } catch (IOException error) {
            throw new IllegalStateException("关闭工作台草案存储目录失败", error);
        }
    }
}
