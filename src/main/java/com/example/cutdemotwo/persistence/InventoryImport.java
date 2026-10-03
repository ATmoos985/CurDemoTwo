package com.example.cutdemotwo.persistence;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Explicit, one-time import; the source file is never modified and a populated target is rejected. */
@Component
public class InventoryImport implements ApplicationRunner {
    private final InventoryStore store;
    private final String source;
    public InventoryImport(InventoryStore store, @Value("${cutdemo.import-file:}") String source) {
        this.store = store; this.source = source;
    }
    @Override public void run(ApplicationArguments arguments) {
        if (source.isBlank()) return;
        if (!store.shared()) throw new IllegalStateException("库存导入仅用于空 MySQL 数据库");
        if (store.load() != null) throw new IllegalStateException("目标数据库已有数据，拒绝覆盖导入；完成导入后请移除 cutdemo.import-file");
        InventorySnapshot snapshot = new FileInventoryStore(source).load();
        if (snapshot == null) throw new IllegalStateException("导入文件不存在");
        store.save(snapshot.withRevision(0));
    }
}
