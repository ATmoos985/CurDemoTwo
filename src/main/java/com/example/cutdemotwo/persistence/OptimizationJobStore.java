package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.contracts.jobs.StoredOptimizationJob;
import java.util.List;

public interface OptimizationJobStore extends AutoCloseable {
    List<StoredOptimizationJob> load();
    void save(StoredOptimizationJob document);
    /** 删除已归档的终态作业记录（默认空操作，兼容内存/测试桩实现）。 */
    default void delete(String id) {}
    /** 清理超出保留期（毫秒）的终态作业并返回本次删除条数。 */
    default int purgeExpiredTerminal(long retentionMillis) { return 0; }
    @Override void close();
}
