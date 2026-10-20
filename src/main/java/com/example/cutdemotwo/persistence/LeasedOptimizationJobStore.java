package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.business.optimization.StoredOptimizationJob;
import java.util.function.UnaryOperator;
import java.util.function.Predicate;

/** Shared dispatcher operations are atomic; a stale owner cannot renew, report progress or publish. */
public interface LeasedOptimizationJobStore extends OptimizationJobStore {
    record Lease(StoredOptimizationJob document, String owner, long token, long remainingMillis) {}
    void configure(int workers, int queue, int archive);
    StoredOptimizationJob submitOrGet(StoredOptimizationJob document);
    StoredOptimizationJob find(String id);
    StoredOptimizationJob findByKey(String key);
    default Lease claim(String owner,long leaseMillis) {return claim(owner,leaseMillis,document->true);}
    Lease claim(String owner, long leaseMillis, Predicate<StoredOptimizationJob> executable);
    StoredOptimizationJob heartbeat(Lease lease, long leaseMillis);
    StoredOptimizationJob cancel(String id);
    /** Pure transformation: may be evaluated again if the execution deadline passes during wrapping. */
    boolean update(Lease lease, UnaryOperator<StoredOptimizationJob> change, boolean terminal);
}
