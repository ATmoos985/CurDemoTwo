package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.contracts.jobs.StoredOptimizationJob;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.DeserializationFeature;
import java.nio.channels.*;
import java.nio.file.*;
import java.io.IOException;
import java.util.*;

/** One dispatcher owns this directory for its entire lifetime. Documents replace atomically or fail. */
public final class FileOptimizationJobStore implements OptimizationJobStore {
    @FunctionalInterface
    interface AtomicReplace {
        void move(Path source, Path target) throws IOException;
    }
    private final AtomicReplace replace;
    private final Path directory;
    private final FileChannel channel;
    private final FileLock lock;
    private final JsonMapper json = JsonMapper.builder().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES,
            DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    public FileOptimizationJobStore(Path directory) {
        this(directory, (source, target) -> Files.move(source, target,
                StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING));
    }
    FileOptimizationJobStore(Path directory, AtomicReplace replace) {
        this.replace = replace;
        this.directory = directory.toAbsolutePath();
        FileChannel opened = null;
        try {
            Files.createDirectories(this.directory);
            opened = FileChannel.open(this.directory.resolve("dispatcher.lock"), StandardOpenOption.CREATE, StandardOpenOption.WRITE);
            var acquired = opened.tryLock();
            if (acquired == null) throw new IllegalStateException("计算作业目录已由另一服务占用");
            channel = opened; lock = acquired;
        } catch (IOException | RuntimeException error) {
            if (opened != null) try { opened.close(); } catch (IOException ignored) {}
            throw new IllegalStateException("无法独占计算作业存储目录", error);
        }
    }
    @Override public List<StoredOptimizationJob> load() {
        try (var files = Files.list(directory)) {
            var result = new ArrayList<StoredOptimizationJob>();
            for (Path path : files.filter(p -> p.getFileName().toString().endsWith(".json")).sorted().toList()) {
                var document = json.readValue(path.toFile(), StoredOptimizationJob.class);
                if (document.job() == null || !path.getFileName().toString().equals(document.job().id()+".json"))
                    throw new IllegalStateException("作业文件身份不一致");
                result.add(document);
            }
            return result;
        } catch (IOException | RuntimeException error) { throw new IllegalStateException("计算作业读取失败，原文件保留",error); }
    }
    @Override public void save(StoredOptimizationJob document) {
        String id = document.job().id();
        if (!id.matches("[0-9a-f-]{36}")) throw new IllegalArgumentException("无效的作业标识");
        Path temporary = null;
        try {
            temporary = Files.createTempFile(directory,"pending-",".tmp");
            Files.write(temporary,json.writeValueAsBytes(document));
            try (var output = FileChannel.open(temporary,StandardOpenOption.WRITE)) { output.force(true); }
            replaceSnapshot(temporary, directory.resolve(id+".json"));
        } catch (IOException error) { throw new IllegalStateException("计算作业保存失败",error); }
        finally { if (temporary != null) try { Files.deleteIfExists(temporary); } catch (IOException ignored) {} }
    }
    private void replaceSnapshot(Path source, Path target) throws IOException {
        // Windows can briefly deny replacement while another process has a snapshot open.
        for (int delayMillis = 10; ; delayMillis *= 2) {
            try {
                replace.move(source, target);
                return;
            } catch (AccessDeniedException denied) {
                if (delayMillis > 160) throw denied;
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
    @Override public void delete(String id) {
        if (id == null || !id.matches("[0-9a-f-]{36}")) throw new IllegalArgumentException("无效的作业标识");
        try {
            deleteSnapshot(directory.resolve(id + ".json"));
        } catch (IOException error) {
            throw new IllegalStateException("计算作业删除失败", error);
        }
    }
    private void deleteSnapshot(Path target) throws IOException {
        for (int delayMillis = 10; ; delayMillis *= 2) {
            try {
                Files.deleteIfExists(target);
                return;
            } catch (AccessDeniedException denied) {
                if (delayMillis > 160) throw denied;
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
    @Override public void close() {
        try { lock.release(); channel.close(); }
        catch (IOException error) { throw new IllegalStateException("作业存储关闭失败",error); }
    }
}
