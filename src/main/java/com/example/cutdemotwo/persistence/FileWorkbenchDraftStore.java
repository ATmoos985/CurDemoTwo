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
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.locks.ReentrantReadWriteLock;

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
        if (draft == null || draft.draftId() == null || !draft.draftId().matches(VALID_ID_PATTERN)) {
            throw new IllegalArgumentException("工作台草案编号无效");
        }
        rwLock.writeLock().lock();
        Path target = directory.resolve(draft.draftId() + ".json");
        Path temporary = null;
        try {
            temporary = Files.createTempFile(directory, "draft-", ".tmp");
            Files.write(temporary, json.writeValueAsBytes(draft));
            try (FileChannel out = FileChannel.open(temporary, StandardOpenOption.WRITE)) {
                out.force(true);
            }
            replaceAtomically(temporary, target);
            return draft;
        } catch (IOException error) {
            throw new IllegalStateException("工作台草案写入失败", error);
        } finally {
            if (temporary != null) {
                try {
                    Files.deleteIfExists(temporary);
                } catch (IOException ignored) {
                }
            }
            rwLock.writeLock().unlock();
        }
    }

    @Override
    public Optional<WorkbenchSchemeDraft> find(String draftId) {
        if (draftId == null || !draftId.matches(VALID_ID_PATTERN)) {
            return Optional.empty();
        }
        rwLock.readLock().lock();
        try {
            Path file = directory.resolve(draftId + ".json");
            if (!Files.exists(file)) {
                return Optional.empty();
            }
            WorkbenchSchemeDraft draft = json.readValue(file.toFile(), WorkbenchSchemeDraft.class);
            if (draft == null || !draftId.equals(draft.draftId())) {
                throw new IllegalStateException("工作台草案文件身份不一致: " + draftId);
            }
            return Optional.of(draft);
        } catch (RuntimeException error) {
            throw new IllegalStateException("工作台草案读取失败，原文件保留: " + draftId, error);
        } finally {
            rwLock.readLock().unlock();
        }
    }

    @Override
    public List<WorkbenchSchemeDraft> listByTask(String taskId) {
        if (taskId == null || taskId.isBlank()) {
            return List.of();
        }
        rwLock.readLock().lock();
        try (var stream = Files.list(directory)) {
            List<WorkbenchSchemeDraft> matches = new ArrayList<>();
            for (Path path : stream.filter(p -> p.getFileName().toString().endsWith(".json")).toList()) {
                WorkbenchSchemeDraft draft = json.readValue(path.toFile(), WorkbenchSchemeDraft.class);
                if (draft != null && draft.target() != null && taskId.equals(draft.target().taskId())) {
                    matches.add(draft);
                }
            }
            matches.sort(Comparator.comparing(WorkbenchSchemeDraft::issuedAt, Comparator.nullsLast(Comparator.reverseOrder())));
            return List.copyOf(matches);
        } catch (IOException | RuntimeException error) {
            throw new IllegalStateException("按任务检索工作台草案失败", error);
        } finally {
            rwLock.readLock().unlock();
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
