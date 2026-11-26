package com.example.cutdemotwo.persistence;

public interface InventoryStore {
    InventorySnapshot load();
    long save(InventorySnapshot snapshot);
    default boolean shared() { return false; }
    default long now() { return System.currentTimeMillis(); }

    /**
     * 轻量无锁查询当前存储版本号：返回 null 表示该存储实现不支持轻量探测，调用方退回完整 load()。
     */
    default Long currentRevision() { return null; }

    /**
     * 轻量无锁健康检查：返回 null 表示存储可用，非空返回具体故障原因。
     */
    default String healthCheckError() { return null; }
}
