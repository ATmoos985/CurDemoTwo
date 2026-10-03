package com.example.cutdemotwo.persistence;

import tools.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.*;

/** Local single-process storage. The MySQL store provides cross-process concurrency control. */
public class FileInventoryStore implements InventoryStore {
    private final Path file;
    private final ObjectMapper json = new ObjectMapper();
    public FileInventoryStore(String path) { file = Path.of(path); }
    @Override public InventorySnapshot load() {
        if (!Files.exists(file)) return null;
        try { return json.readValue(file.toFile(), InventorySnapshot.class); }
        catch (Exception e) { throw new IllegalStateException("库存文件读取失败，请检查后恢复: " + file, e); }
    }
    @Override public long save(InventorySnapshot snapshot) {
        try {
            Path parent = file.toAbsolutePath().getParent();
            Files.createDirectories(parent);
            Path temporary = Files.createTempFile(parent, "cutdemo-", ".json");
            try {
                json.writeValue(temporary.toFile(), snapshot.withRevision(snapshot.revision() + 1));
                try { Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
                catch (AtomicMoveNotSupportedException e) { Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING); }
            } finally { Files.deleteIfExists(temporary); }
            return snapshot.revision() + 1;
        } catch (IOException e) { throw new IllegalStateException("库存保存失败: " + file, e); }
    }
}
