package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.algorithm.api.ISlittingSolverEngine;
import com.example.cutdemotwo.algorithm.api.NestingSolver;
import com.example.cutdemotwo.contracts.jobs.OptimizationRequest;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.persistence.LeasedOptimizationJobStore;
import com.example.cutdemotwo.persistence.OptimizationJobStore;
import com.example.cutdemotwo.contracts.jobs.StoredOptimizationJob;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 计算作业 2D/1D 双池物理隔离执行器与共享集群租约调度器：
 * <ul>
 *   <li>2D（nestingExecutor）与 1D（slittingExecutor）独立队列和线程隔离，防止长耗时 1D 精修阻塞 2D 实时排样；</li>
 *   <li>共享模式维持 fail-closed 租约围栏与心跳续租，并同步跨节点 SSE 状态推送。</li>
 * </ul>
 */
final class OptimizationExecutionPool {
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(OptimizationExecutionPool.class);
    private static final long LEASE_MILLIS = 15_000L;

    static final class LocalLease {
        final LeasedOptimizationJobStore.Lease lease;
        final String problemType;
        volatile boolean lost;

        LocalLease(LeasedOptimizationJobStore.Lease lease, String problemType) {
            this.lease = lease;
            this.problemType = problemType;
        }
    }

    record PendingEntry(Runnable task, ThreadPoolExecutor pool, String problemType) {}

    private final NestingSolver solvers;
    private final ISlittingSolverEngine slitting;
    private final LeasedOptimizationJobStore shared;
    private final OptimizationSseHub sseHub;
    private final int workers;
    private final int slittingWorkers;
    private final String owner2d;
    private final String owner1d;

    /** 2D 排样独立执行池 */
    private final ThreadPoolExecutor nestingExecutor;
    /** 1D 分切独立隔离执行池（并发度独立受限，防止 1D 精修阻塞 2D 实时排样） */
    private final ThreadPoolExecutor slittingExecutor;
    private final ScheduledExecutorService timer;

    private final ConcurrentHashMap<String, PendingEntry> pending = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Thread> running = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, LocalLease> leases = new ConcurrentHashMap<>();
    private final AtomicBoolean dispatching = new AtomicBoolean(false);
    private volatile boolean closing;

    OptimizationExecutionPool(
            NestingSolver solvers,
            ISlittingSolverEngine slitting,
            LeasedOptimizationJobStore shared,
            OptimizationSseHub sseHub,
            int workers,
            int slittingWorkers,
            int queueCapacity
    ) {
        this.solvers = solvers;
        this.slitting = slitting;
        this.shared = shared;
        this.sseHub = sseHub;
        this.workers = workers;
        this.slittingWorkers = slittingWorkers;
        String owner = UUID.randomUUID().toString();
        this.owner2d = owner + ":2d";
        this.owner1d = owner + ":1d";

        // 2D 与 1D 独立执行池均预留交接槽，避免业务名额释放与工作线程交接间隙误触发队列拒绝。
        AtomicInteger nestingThreadSeq = new AtomicInteger(1);
        this.nestingExecutor = new ThreadPoolExecutor(
                workers, workers, 0, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(workers + queueCapacity),
                r -> {
                    var t = new Thread(r, "optimization-2d-worker-" + nestingThreadSeq.getAndIncrement());
                    t.setDaemon(true);
                    return t;
                });

        AtomicInteger slittingThreadSeq = new AtomicInteger(1);
        this.slittingExecutor = new ThreadPoolExecutor(
                slittingWorkers, slittingWorkers, 0, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(slittingWorkers + queueCapacity),
                r -> {
                    var t = new Thread(r, "optimization-1d-worker-" + slittingThreadSeq.getAndIncrement());
                    t.setDaemon(true);
                    return t;
                });

        this.timer = Executors.newSingleThreadScheduledExecutor(r -> {
            var t = new Thread(r, "optimization-deadline");
            t.setDaemon(true);
            return t;
        });
    }

    void markClosing() {
        this.closing = true;
    }

    void scheduleSharedDispatch(long delayMs) {
        timer.scheduleWithFixedDelay(this::dispatch, 0, delayMs, TimeUnit.MILLISECONDS);
    }

    void scheduleCleanup(Runnable cleanupTask, long intervalMinutes) {
        timer.scheduleWithFixedDelay(cleanupTask, intervalMinutes, intervalMinutes, TimeUnit.MINUTES);
    }

    ScheduledFuture<?> scheduleTimeout(Runnable task, long delaySeconds) {
        return timer.schedule(task, delaySeconds, TimeUnit.SECONDS);
    }

    int pendingSize() {
        return pending.size();
    }

    boolean isPendingOrRunning(String jobId) {
        return pending.containsKey(jobId) || running.containsKey(jobId);
    }

    boolean isRunning(String jobId) {
        return running.containsKey(jobId);
    }

    PendingEntry registerPending(String jobId, String problemType, Runnable task) {
        ThreadPoolExecutor targetPool = executorFor(problemType);
        PendingEntry entry = new PendingEntry(task, targetPool, problemType);
        pending.put(jobId, entry);
        return entry;
    }

    void submitPending(PendingEntry entry) {
        entry.pool().execute(entry.task());
    }

    void removePending(String jobId) {
        pending.remove(jobId);
    }

    void cancelPendingFileTask(String jobId) {
        var entry = pending.remove(jobId);
        if (entry != null) {
            entry.pool().remove(entry.task());
        }
    }

    void registerRunning(String jobId, Thread thread) {
        running.put(jobId, thread);
    }

    void clearExecutionTracking(String jobId) {
        running.remove(jobId);
        pending.remove(jobId);
    }

    void interruptRunning(String jobId) {
        var thread = running.get(jobId);
        if (thread != null) {
            thread.interrupt();
        }
    }

    List<String> pendingJobIdsSnapshot() {
        return List.copyOf(pending.keySet());
    }

    int resolveAttempt(String jobId) {
        LocalLease local = leases.get(jobId);
        if (local != null) {
            return (int) Math.max(1L, local.lease.token());
        }
        return 1;
    }

    void fenceAllLocalLeases() {
        for (var entry : leases.entrySet()) {
            entry.getValue().lost = true;
            var thread = running.get(entry.getKey());
            if (thread != null) thread.interrupt();
        }
    }

    void shutdownNowAndCloseStore(OptimizationJobStore store) {
        nestingExecutor.shutdownNow();
        slittingExecutor.shutdownNow();
        timer.shutdownNow();
        store.close();
    }

    void shutdownAndCloseStore(OptimizationJobStore store) {
        nestingExecutor.shutdown();
        slittingExecutor.shutdown();
        timer.shutdownNow();
        try {
            boolean nestingDone = nestingExecutor.awaitTermination(5, TimeUnit.SECONDS);
            boolean slittingDone = slittingExecutor.awaitTermination(5, TimeUnit.SECONDS);
            if (nestingDone && slittingDone) {
                store.close();
            } else {
                var cleanup = new Thread(() -> {
                    try {
                        while (!nestingExecutor.awaitTermination(1, TimeUnit.SECONDS)) {}
                        while (!slittingExecutor.awaitTermination(1, TimeUnit.SECONDS)) {}
                        store.close();
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }, "optimization-storage-close");
                cleanup.setDaemon(true);
                cleanup.start();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private ThreadPoolExecutor executorFor(String problemType) {
        return "SLITTING_1D".equals(problemType) ? slittingExecutor : nestingExecutor;
    }

    /** 共享集群调度器：无锁续租心跳、按 2D/1D 独立执行池分派领取，并同步跨节点 SSE 订阅状态。 */
    private void dispatch() {
        if (closing || !dispatching.compareAndSet(false, true)) return;
        try {
            // 1. 续租本地活跃租约，同步远端取消意图
            for (var entry : leases.entrySet()) {
                var local = entry.getValue();
                if (local.lost) continue;
                var current = shared.heartbeat(local.lease, LEASE_MILLIS);
                if (current == null) {
                    local.lost = true;
                } else {
                    sseHub.publishJobEvent(current, (int) local.lease.token());
                }
                if (current == null || "CANCEL_REQUESTED".equals(current.job().state())) {
                    var thread = running.get(entry.getKey());
                    if (thread != null) thread.interrupt();
                }
            }

            // 2. 按 2D 独立执行池空闲槽位领取 NESTING_2D 作业（锁外校验在 JdbcOptimizationJobStore 内执行）
            while (!closing && activeLeasesFor("NESTING_2D") < workers) {
                var lease = shared.claim(owner2d, LEASE_MILLIS, document ->
                        !"SLITTING_1D".equals(document.input().problemType())
                                && "VALID".equals(solvers.validateProblem(
                                document.input().nestingProblem(), document.input().allowFallback()).status()));
                if (lease == null) break;
                var local = new LocalLease(lease, "NESTING_2D");
                String id = lease.document().job().id();
                leases.put(id, local);
                sseHub.publishJobEvent(lease.document(), (int) lease.token());
                nestingExecutor.execute(() -> executeShared(local));
            }

            // 3. 按 1D 独立执行池空闲槽位领取 SLITTING_1D 作业（与 2D 彻底物理隔离，绝不相互抢槽）
            while (!closing && activeLeasesFor("SLITTING_1D") < slittingWorkers) {
                var lease = shared.claim(owner1d, LEASE_MILLIS, document ->
                        "SLITTING_1D".equals(document.input().problemType()) && slitting.isAvailable());
                if (lease == null) break;
                var local = new LocalLease(lease, "SLITTING_1D");
                String id = lease.document().job().id();
                leases.put(id, local);
                sseHub.publishJobEvent(lease.document(), (int) lease.token());
                slittingExecutor.execute(() -> executeShared(local));
            }

            // 4. 若有客户端订阅了由其他集群节点执行的作业，同步其最新状态/终态至本地 SSE 流
            if (sseHub.hasSubscribers()) {
                for (String subscribedId : sseHub.subscribedJobIdsSnapshot()) {
                    if (leases.containsKey(subscribedId)) continue;
                    var latest = shared.find(subscribedId);
                    if (latest != null) {
                        sseHub.publishJobEvent(latest, 1);
                    }
                }
            }
        } catch (RuntimeException error) {
            // On uncertain ownership, fail closed locally. DB expiry/recovery decides retry.
            for (var entry : leases.entrySet()) {
                entry.getValue().lost = true;
                var thread = running.get(entry.getKey());
                if (thread != null) thread.interrupt();
            }
            log.error("Shared optimization dispatch/heartbeat failed; local owners fenced", error);
        } finally {
            dispatching.set(false);
        }
    }

    private int activeLeasesFor(String problemType) {
        int count = 0;
        for (LocalLease lease : leases.values()) {
            if (!lease.lost && problemType.equals(lease.problemType)) {
                count++;
            }
        }
        return count;
    }

    private void executeShared(LocalLease local) {
        String id = local.lease.document().job().id();
        int attempt = (int) Math.max(1L, local.lease.token());
        try {
            if (local.lost || closing) return;
            running.put(id, Thread.currentThread());
            if (local.lost || closing) return;

            var document = local.lease.document();
            // A retry shares the first attempt's wall-clock deadline; it does not get a new full budget.
            var input = document.input();
            int seconds = Math.max(1, (int) Math.ceil(local.lease.remainingMillis() / 1000d));
            if ("SLITTING_1D".equals(input.problemType())) {
                var p = input.slittingProblem();
                var bounded = p.withTimeLimitSeconds(seconds);
                var result = slitting.solve(bounded);
                Thread.interrupted();
                if (!local.lost) {
                    var written = new StoredOptimizationJob[1];
                    boolean ok = shared.update(local.lease, current -> {
                        written[0] = OptimizationResultSupport.finishedSlitting(current, result);
                        return written[0];
                    }, true);
                    if (ok && written[0] != null) {
                        sseHub.publishJobEvent(written[0], attempt);
                    }
                }
                return;
            }
            var p = input.nestingProblem();
            var bounded = new NestingProblem(
                    p.schemaVersion(), p.unit(), p.material(), p.parts(), p.process(), p.engine(), seconds);
            var execution = new OptimizationRequest(input.schemaVersion(), input.problemType(), input.clientRequestId(),
                    bounded, input.allowFallback(), input.requireComplete(), input.strategy());
            var outcome = execution.strategy() == null
                    ? new MarkerOptimization.Outcome(solvers.solve(bounded, input.allowFallback()), null, null)
                    : MarkerOptimization.solve(execution, solvers, message -> {
                        if (local.lost) return;
                        var progressed = new StoredOptimizationJob[1];
                        boolean ok = shared.update(local.lease, current -> {
                            progressed[0] = OptimizationResultSupport.withMessage(current, message);
                            return progressed[0];
                        }, false);
                        if (!ok) {
                            Thread.currentThread().interrupt();
                        } else if (progressed[0] != null) {
                            sseHub.publishJobEvent(progressed[0], attempt);
                        }
                    });
            Thread.interrupted();
            if (!local.lost) {
                var written = new StoredOptimizationJob[1];
                boolean ok = shared.update(local.lease, current -> {
                    written[0] = OptimizationResultSupport.finished(current, outcome);
                    return written[0];
                }, true);
                if (!ok) {
                    log.info("Discarded result from expired optimization attempt: {} token {}", id, local.lease.token());
                } else if (written[0] != null) {
                    sseHub.publishJobEvent(written[0], attempt);
                }
            }
        } catch (Throwable error) {
            Thread.interrupted();
            if (!local.lost) {
                try {
                    var written = new StoredOptimizationJob[1];
                    boolean ok = shared.update(local.lease, current -> {
                        written[0] = OptimizationResultSupport.executionFailure(current, error);
                        return written[0];
                    }, true);
                    if (ok && written[0] != null) {
                        sseHub.publishJobEvent(written[0], attempt);
                    }
                } catch (RuntimeException writeError) {
                    log.error("Shared optimization final state not persisted; lease recovery will resolve it", writeError);
                }
            }
            log.error("Shared optimization execution failed: {}", id, error);
        } finally {
            running.remove(id);
            leases.remove(id);
            Thread.interrupted();
        }
    }
}
