package com.example.cutdemotwo.config;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/**
 * 内存操作审计日志存储（供纯单元测试或无持久化装配时使用）。
 */
public final class InMemoryOperationAuditStore implements OperationAuditStore {
    private static final int MAX_IN_MEMORY_RECORDS = 10_000;
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();
    private final List<AuditRecord> records = new ArrayList<>();

    @Override
    public void append(AuditRecord record) {
        if (record == null) return;
        lock.writeLock().lock();
        try {
            records.add(record);
            if (records.size() > MAX_IN_MEMORY_RECORDS) {
                records.remove(0);
            }
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
            List<AuditRecord> filtered = records.stream()
                    .filter(r -> matches(r, query))
                    .sorted(Comparator.comparingLong(AuditRecord::occurredAt).reversed()
                            .thenComparing(AuditRecord::id, Comparator.reverseOrder()))
                    .toList();
            long total = filtered.size();
            int fromIdx = Math.min(filtered.size(), page * size);
            int toIdx = Math.min(filtered.size(), fromIdx + size);
            return new AuditPage(filtered.subList(fromIdx, toIdx), total, page, size);
        } finally {
            lock.readLock().unlock();
        }
    }

    static boolean matches(AuditRecord r, AuditQuery q) {
        if (hasText(q.actor()) && !q.actor().trim().equals(r.actor())) return false;
        if (hasText(q.actorType()) && !q.actorType().trim().equalsIgnoreCase(r.actorType())) return false;
        if (hasText(q.action()) && !q.action().trim().equalsIgnoreCase(r.action())) return false;
        if (hasText(q.targetType()) && !q.targetType().trim().equalsIgnoreCase(r.targetType())) return false;
        if (hasText(q.targetId()) && !q.targetId().trim().equals(r.targetId())) return false;
        if (hasText(q.outcome()) && !q.outcome().trim().equalsIgnoreCase(r.outcome())) return false;
        if (q.from() != null && r.occurredAt() < q.from()) return false;
        if (q.to() != null && r.occurredAt() > q.to()) return false;
        return true;
    }

    private static boolean hasText(String value) {
        return value != null && !value.isBlank();
    }
}
