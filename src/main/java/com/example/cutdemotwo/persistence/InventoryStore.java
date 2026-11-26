package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.business.model.DemandTemplate;
import java.util.List;

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

    /**
     * 是否支持需求模板独立持久化（不占用库存全局 revision 锁与账本事务）。
     */
    default boolean supportsIndependentTemplates() { return false; }

    default List<DemandTemplate> loadTemplates() { return List.of(); }

    default void upsertTemplate(DemandTemplate template) {
        throw new UnsupportedOperationException("当前存储实现不支持独立写入需求模板");
    }

    default boolean deleteTemplate(String id) {
        throw new UnsupportedOperationException("当前存储实现不支持独立删除需求模板");
    }

    /**
     * 增量提交变更集：默认回退至全量快照 save()，保证文件存储及测试桩 100% 兼容；
     * JDBC 存储实现为定点 SQL UPSERT/DELETE + 追加表尾行 INSERT，消除全表扫描。
     */
    default long saveDelta(InventoryDelta delta, java.util.function.Supplier<InventorySnapshot> fullSnapshotSupplier) {
        return save(fullSnapshotSupplier.get());
    }
}
