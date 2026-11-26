package com.example.cutdemotwo.persistence;

import tools.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.*;

/** Local single-process storage. The MySQL store provides cross-process concurrency control. */
public class FileInventoryStore implements InventoryStore {
    private final Path file;
    private final ObjectMapper json = new ObjectMapper();
    private volatile Long cachedRevision;
    private volatile long cachedLastModified = Long.MIN_VALUE;
    private volatile long cachedSize = -1L;

    public FileInventoryStore(String path) { file = Path.of(path); }

    @Override public Long currentRevision() {
        if (!Files.exists(file)) {
            cachedRevision = 0L;
            cachedLastModified = Long.MIN_VALUE;
            cachedSize = -1L;
            return 0L;
        }
        try {
            long mtime = Files.getLastModifiedTime(file).toMillis();
            long size = Files.size(file);
            Long cached = cachedRevision;
            if (cached != null && mtime == cachedLastModified && size == cachedSize) {
                return cached;
            }
            var document = json.readTree(file.toFile());
            long rev = document != null && document.has("revision") ? document.get("revision").asLong(0L) : 0L;
            cachedRevision = rev;
            cachedLastModified = mtime;
            cachedSize = size;
            return rev;
        } catch (Exception e) {
            throw new IllegalStateException("库存文件版本探测失败，请检查后恢复: " + file, e);
        }
    }

    @Override public String healthCheckError() {
        try {
            Path abs = file.toAbsolutePath();
            if (Files.exists(abs)) {
                if (!Files.isRegularFile(abs) || !Files.isReadable(abs)) {
                    return "库存文件不可读: " + abs;
                }
            } else {
                Path parent = abs.getParent();
                if (parent != null && Files.exists(parent) && !Files.isDirectory(parent)) {
                    return "库存父路径不是有效目录: " + parent;
                }
            }
            return null;
        } catch (Exception e) {
            return "文件存储检查失败: " + e.getMessage();
        }
    }

    @Override public InventorySnapshot load() {
        if (!Files.exists(file)) return null;
        try {
            long mtime = Files.getLastModifiedTime(file).toMillis();
            long size = Files.size(file);
            var document = (tools.jackson.databind.node.ObjectNode) json.readTree(file.toFile());
            if (!document.has("revision")) document.put("revision", 0L);
            InventorySnapshot snapshot = json.treeToValue(document, InventorySnapshot.class);
            cachedRevision = snapshot.revision();
            cachedLastModified = mtime;
            cachedSize = size;
            return snapshot;
        }
        catch (Exception e) { throw new IllegalStateException("库存文件读取失败，请检查后恢复: " + file, e); }
    }
    @Override public long save(InventorySnapshot snapshot) {
        var previous = load();
        com.example.cutdemotwo.business.model.InventoryLedgerEntry.requireAppendOnly(
                previous == null ? java.util.List.of() : previous.ledger(), snapshot.ledger());
        com.example.cutdemotwo.business.model.InventoryTransfer.requireAppendOnly(
                previous == null ? java.util.Map.of() : previous.transfers(), snapshot.transfers());
        com.example.cutdemotwo.business.model.InventoryEvent.requireAppendOnly(
                previous == null ? java.util.List.of() : previous.outbox(), snapshot.outbox());
        com.example.cutdemotwo.business.model.InventoryCount.requireAppendOnly(
                previous == null ? java.util.Map.of() : previous.counts(), snapshot.counts());
        com.example.cutdemotwo.business.model.QualityReleaseDocument.requireAppendOnly(
                previous == null ? java.util.Map.of() : previous.qualityReleases(), snapshot.qualityReleases());
        com.example.cutdemotwo.business.model.InventoryReceiptDocument.requireAppendOnly(
                previous == null ? java.util.Map.of() : previous.inventoryReceipts(), snapshot.inventoryReceipts());
        com.example.cutdemotwo.business.model.MaterialIssueDocument.requireAppendOnly(
                previous == null ? java.util.Map.of() : previous.materialIssues(), snapshot.materialIssues());
        try {
            Path parent = file.toAbsolutePath().getParent();
            Files.createDirectories(parent);
            Path temporary = Files.createTempFile(parent, "cutdemo-", ".json");
            long nextRevision = snapshot.revision() + 1;
            try {
                json.writeValue(temporary.toFile(), snapshot.withRevision(nextRevision));
                try { Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
                catch (AtomicMoveNotSupportedException e) { Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING); }
            } finally { Files.deleteIfExists(temporary); }
            cachedRevision = nextRevision;
            cachedLastModified = Files.getLastModifiedTime(file).toMillis();
            cachedSize = Files.size(file);
            return nextRevision;
        } catch (IOException e) { throw new IllegalStateException("库存保存失败: " + file, e); }
    }
}
