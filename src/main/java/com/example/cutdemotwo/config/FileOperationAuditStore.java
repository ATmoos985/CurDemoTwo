package com.example.cutdemotwo.config;

import tools.jackson.databind.json.JsonMapper;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/**
 * File 模式操作审计存储：以 JSONL 追加写入 {@code *.audit/events.jsonl}，独立于 {@code cutdemo-state.json}。
 */
public final class FileOperationAuditStore implements OperationAuditStore {
    private static final JsonMapper JSON = JsonMapper.builder().build();

    private final Path directory;
    private final Path eventsFile;
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();

    public FileOperationAuditStore(String directoryPath) {
        Objects.requireNonNull(directoryPath, "审计目录不能为空");
        this.directory = Path.of(directoryPath);
        this.eventsFile = this.directory.resolve("events.jsonl");
        try {
            Files.createDirectories(this.directory);
        } catch (IOException error) {
            throw new UncheckedIOException("初始化本地审计目录失败：" + directoryPath, error);
        }
    }

    @Override
    public void append(AuditRecord record) {
        if (record == null) return;
        String line = JSON.writeValueAsString(record) + "\n";
        lock.writeLock().lock();
        try {
            Files.createDirectories(directory);
            Files.writeString(eventsFile, line, StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.WRITE, StandardOpenOption.APPEND);
        } catch (IOException error) {
            throw new UncheckedIOException("追加本地审计日志失败：" + eventsFile, error);
        } finally {
            lock.writeLock().unlock();
        }
    }

    @Override
    public AuditPage query(AuditQuery query) {
        int page = Math.max(0, query.page());
        int size = Math.min(200, Math.max(1, query.size()));
        lock.readLock().lock();
        try {
            if (!Files.exists(eventsFile)) {
                return new AuditPage(List.of(), 0L, page, size);
            }
            List<AuditRecord> matched = new ArrayList<>();
            try (BufferedReader reader = Files.newBufferedReader(eventsFile, StandardCharsets.UTF_8)) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.isBlank()) continue;
                    AuditRecord record = JSON.readValue(line, AuditRecord.class);
                    if (record != null && InMemoryOperationAuditStore.matches(record, query)) {
                        matched.add(record);
                    }
                }
            }
            Collections.reverse(matched);
            matched.sort((a, b) -> {
                int cmp = Long.compare(b.occurredAt(), a.occurredAt());
                return cmp != 0 ? cmp : String.valueOf(b.id()).compareTo(String.valueOf(a.id()));
            });
            long total = matched.size();
            int fromIdx = Math.min(matched.size(), page * size);
            int toIdx = Math.min(matched.size(), fromIdx + size);
            return new AuditPage(matched.subList(fromIdx, toIdx), total, page, size);
        } catch (IOException error) {
            throw new UncheckedIOException("检索本地审计日志失败：" + eventsFile, error);
        } finally {
            lock.readLock().unlock();
        }
    }
}
