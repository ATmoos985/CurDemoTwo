package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.business.optimization.StoredOptimizationJob;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.DeserializationFeature;
import java.nio.channels.*;
import java.nio.file.*;
import java.io.IOException;
import java.util.*;

/** One dispatcher owns this directory for its entire lifetime. Documents replace atomically or fail. */
public final class FileOptimizationJobStore implements OptimizationJobStore {
    private final Path directory;
    private final FileChannel channel;
    private final FileLock lock;
    private final JsonMapper json = JsonMapper.builder().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES,
            DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    public FileOptimizationJobStore(Path directory) {
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
            Files.move(temporary,directory.resolve(id+".json"),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException error) { throw new IllegalStateException("计算作业保存失败",error); }
        finally { if (temporary != null) try { Files.deleteIfExists(temporary); } catch (IOException ignored) {} }
    }
    @Override public void close() {
        try { lock.release(); channel.close(); }
        catch (IOException error) { throw new IllegalStateException("作业存储关闭失败",error); }
    }
}
