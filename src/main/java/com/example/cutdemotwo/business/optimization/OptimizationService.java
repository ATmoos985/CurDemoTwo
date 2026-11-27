package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.algorithm.api.ISlittingSolverEngine;
import com.example.cutdemotwo.algorithm.api.NestingSolver;
import com.example.cutdemotwo.contracts.jobs.*;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import com.example.cutdemotwo.persistence.*;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.*;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;

/**
 * 统一计算作业应用层：
 * - 2D（nestingExecutor）与 1D（slittingExecutor）算力双池物理隔离，长耗时 1D 精修绝不阻塞 2D 实时排样；
 * - 消除全类 synchronized(this)，校验与只读查询零锁竞争，单作业状态迁移采用按 jobId 细粒度锁；
 * - 内置 SSE 实时进度与终态广播中心，支持超时/断连自动注销与零内存泄漏回收；
 * - 仅调度计算与归档验证结果，不改写任何业务库存。
 */
@Service
public class OptimizationService implements AutoCloseable {
    public static class Failure extends OptimizationFailure {
        public Failure(String code, String message, int status, boolean retryable) {
            super(code, message, status, retryable);
        }
    }

    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(OptimizationService.class);
    private static final long CLEANUP_INTERVAL_MINUTES = 5L;
    private static final long DEFAULT_TERMINAL_RETENTION_HOURS = 168L;
    private static final String DEFAULT_SLITTING_CHILD_XMX = "768m";
    private static final int MAX_NESTING_TIME_LIMIT_SECONDS = 60;
    private static final int MAX_SLITTING_TIME_LIMIT_SECONDS = 180;

    private final NestingSolver solvers;
    private final ISlittingSolverEngine slitting;
    private final OptimizationJobStore store;
    private final LeasedOptimizationJobStore shared;

    private final int workers;
    private final int slittingWorkers;
    private final int queueCapacity;
    private final int maxStored;
    private final long terminalRetentionHours;
    private final long terminalRetentionMillis;
    private final int slittingMaxHeapMiB;

    private final OptimizationSseHub sseHub = new OptimizationSseHub();
    private final OptimizationExecutionPool executionPool;

    /** 细粒度并发状态表（替代原全类 synchronized(this)） */
    private final ConcurrentHashMap<String, StoredOptimizationJob> documents = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, String> keys = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Object> jobLocks = new ConcurrentHashMap<>();

    /** 仅用于文件模式新作业准入与淘汰的短临界区锁（锁外完成几何校验与哈希，不阻塞只读查询） */
    private final Object fileAdmissionLock = new Object();
    private volatile boolean closing;
    private volatile boolean storageFailed;

    public OptimizationService(NestingSolver solvers,
                               ISlittingSolverEngine slitting,
                               OptimizationJobStore store,
                               int workers, int queueCapacity, int maxStored) {
        this(solvers, slitting, store, workers, queueCapacity, maxStored,
                DEFAULT_TERMINAL_RETENTION_HOURS, DEFAULT_SLITTING_CHILD_XMX, 0);
    }

    public OptimizationService(NestingSolver solvers,
                               ISlittingSolverEngine slitting,
                               OptimizationJobStore store,
                               int workers, int queueCapacity, int maxStored,
                               long terminalRetentionHours, String slittingChildXmx) {
        this(solvers, slitting, store, workers, queueCapacity, maxStored,
                terminalRetentionHours, slittingChildXmx, 0);
    }

    @Autowired
    public OptimizationService(NestingSolver solvers,
                               ISlittingSolverEngine slitting,
                               OptimizationJobStore store,
                               @Value("${cutdemo.jobs.workers:6}") int workers,
                               @Value("${cutdemo.jobs.queue-capacity:32}") int queueCapacity,
                               @Value("${cutdemo.jobs.max-stored:1000}") int maxStored,
                               @Value("${cutdemo.jobs.terminal-retention-hours:168}") long terminalRetentionHours,
                               @Value("${cutdemo.slitting.child-xmx:768m}") String slittingChildXmx,
                               @Value("${cutdemo.jobs.slitting-workers:0}") int configuredSlittingWorkers) {
        this.solvers = solvers;
        this.slitting = slitting;
        this.store = store;
        this.workers = workers;
        this.queueCapacity = queueCapacity;
        this.maxStored = maxStored;
        this.shared = store instanceof LeasedOptimizationJobStore leased ? leased : null;

        if (workers < 1 || workers > 16 || queueCapacity < 1 || queueCapacity > 1000
                || maxStored < 1 || terminalRetentionHours < 0
                || configuredSlittingWorkers < 0 || configuredSlittingWorkers > 16) {
            store.close();
            throw new IllegalArgumentException("计算作业并发、排队、归档限额或保留时长配置无效");
        }
        this.slittingWorkers = configuredSlittingWorkers > 0
                ? configuredSlittingWorkers
                : Math.max(1, Math.min(2, workers));
        try {
            this.slittingMaxHeapMiB = parseHeapMiB(slittingChildXmx);
        } catch (IllegalArgumentException invalidXmx) {
            store.close();
            throw invalidXmx;
        }
        this.terminalRetentionHours = terminalRetentionHours;
        this.terminalRetentionMillis = TimeUnit.HOURS.toMillis(terminalRetentionHours);
        this.executionPool = new OptimizationExecutionPool(
                solvers, slitting, shared, sseHub, workers, this.slittingWorkers, queueCapacity);

        try {
            if (shared != null) {
                shared.configure(workers, queueCapacity, maxStored);
                executionPool.scheduleSharedDispatch(200);
            } else {
                for (var document : store.load()) {
                    var job = document.job();
                    if (keys.putIfAbsent(document.idempotencyKey(), job.id()) != null
                            || documents.putIfAbsent(job.id(), document) != null) {
                        throw new IllegalStateException("作业存储中存在重复身份或幂等键");
                    }
                    if (!job.terminal()) {
                        persist(OptimizationResultSupport.transition(document, "FAILED", "STOPPED", "PROCESS_RESTARTED",
                                "服务重启打断了作业；未自动重算，请使用新的幂等键重试", null));
                    }
                }
            }
            executionPool.scheduleCleanup(this::cleanupExpiredTerminalJobs, CLEANUP_INTERVAL_MINUTES);
        } catch (RuntimeException error) {
            executionPool.shutdownNowAndCloseStore(store);
            throw error;
        }
    }

    static int parseHeapMiB(String raw) {
        return OptimizationResultSupport.parseHeapMiB(raw);
    }

    public Map<String, Object> capabilities() {
        return Map.of(
                "schemaVersion", "2.0",
                "problemTypes", List.of("NESTING_2D", "SLITTING_1D"),
                "inputProfile", "nesting-v1",
                "inputProfiles", List.of("nesting-v1", "slitting-v1"),
                "slittingEngine", Map.of(
                        "id", slitting.getEngineType(),
                        "available", slitting.isAvailable(),
                        "cancellation", "isolated-process",
                        "maxOrders", 500,
                        "maxTotalProducedRolls", 100000,
                        "lengthResolutionMm", 1,
                        "maxHeapMiB", slittingMaxHeapMiB,
                        "maxTimeLimitSeconds", MAX_SLITTING_TIME_LIMIT_SECONDS),
                "engines", solvers.capabilities(),
                "limits", Map.ofEntries(
                        Map.entry("workers", workers),
                        Map.entry("nestingWorkers", workers),
                        Map.entry("slittingWorkers", slittingWorkers),
                        Map.entry("queueCapacity", queueCapacity),
                        Map.entry("maxStoredJobs", maxStored),
                        Map.entry("terminalRetentionHours", terminalRetentionHours),
                        Map.entry("maxRequestBytes", 262144),
                        Map.entry("maxPieces", 10000),
                        Map.entry("maxContourPieces", 200),
                        Map.entry("maxTimeLimitSeconds", MAX_NESTING_TIME_LIMIT_SECONDS),
                        Map.entry("maxNestingTimeLimitSeconds", MAX_NESTING_TIME_LIMIT_SECONDS),
                        Map.entry("maxSlittingTimeLimitSeconds", MAX_SLITTING_TIME_LIMIT_SECONDS)),
                "features", Map.of(
                        "polling", true,
                        "cancellation", "cooperative-request",
                        "hardPreemption", false,
                        "progress", "sse-and-poll",
                        "storage", shared == null ? "single-dispatcher-local-files" : "jdbc-leases",
                        "distributedWorkers", shared != null,
                        "sse", true,
                        "inventoryWrites", false),
                "units", Map.of("length", "mm", "area", "mm2"),
                "strategies", List.of(
                        Map.of("id", "marker-shortening", "version", "1", "maxTrials", 12),
                        Map.of("id", "marker-shortening", "version", "2", "maxTrials", 12)));
    }

    public ProblemCheck validate(OptimizationRequest request) {
        try {
            return OptimizationResultSupport.validateProblemRequest(request, solvers, slitting);
        } catch (OptimizationFailure failure) {
            throw toFailure(failure);
        }
    }

    /**
     * 订阅指定作业的实时 SSE 事件流（契约：progress 阶段推送 + 终态 done 推送并自动优雅关闭）。
     * 作业不存在抛 404；已处于终态直接推送一次 done 并立即关闭，绝不泄漏监听器内存。
     */
    public SseEmitter subscribeEvents(String jobId) {
        var initial = required(jobId);
        return sseHub.subscribe(
                initial,
                () -> shared == null ? documents.get(jobId) : shared.find(jobId),
                () -> executionPool.resolveAttempt(jobId)
        );
    }

    /** 返回当前活跃 SSE 监听器总数（供运维监控与内存泄漏专项单测核验）。 */
    int activeEventSubscriberCount() {
        return sseHub.activeSubscriberCount();
    }

    private Object lockFor(String id) {
        return jobLocks.computeIfAbsent(id, k -> new Object());
    }

    public OptimizationJob submit(String key, OptimizationRequest input) {
        return submit(key, input, null);
    }

    /** 提交计算作业并可选归档不可变的工作台来源上下文（来源上下文不参与输入哈希计算）。 */
    public OptimizationJob submit(String key, OptimizationRequest input, WorkbenchJobSource workbenchSource) {
        if (key == null || !key.matches("[A-Za-z0-9._:-]{8,128}"))
            throw new Failure("INVALID_INPUT", "Idempotency-Key 必须为 8–128 个字母、数字或 . _ : -", 400, false);
        if (input == null)
            throw new Failure("INVALID_INPUT", "请求不能为空", 400, false);

        String inputHash = hash(input);

        if (shared != null) {
            // 共享模式全程零应用层大锁：DB 事务保证全局幂等与配额，几何校验在锁外完成。
            var existing = shared.findByKey(key);
            if (existing != null) {
                assertIdempotencyMatch(existing, inputHash, workbenchSource);
                return existing.job();
            }
            if (closing) throw new Failure("SERVICE_UNAVAILABLE", "作业服务正在关闭", 503, true);
            validate(input);
            String id = UUID.randomUUID().toString();
            var job = new OptimizationJob(id, "2.0", input.clientRequestId(), inputHash, "QUEUED", "QUEUED",
                    Instant.now().toString(), null, null, input.problem().timeLimitSeconds(), null, null, "已持久化，等待计算");
            try {
                var stored = shared.submitOrGet(new StoredOptimizationJob(key, input, job, null, workbenchSource));
                assertIdempotencyMatch(stored, inputHash, workbenchSource);
                sseHub.publishJobEvent(stored, 1);
                return stored.job();
            } catch (OptimizationFailure failure) {
                throw toFailure(failure);
            }
        }

        // 文件模式快速无锁幂等热路径
        String existingId = keys.get(key);
        if (existingId != null) {
            var old = documents.get(existingId);
            if (old != null) {
                assertIdempotencyMatch(old, inputHash, workbenchSource);
                return old.job();
            }
        }

        if (closing || storageFailed)
            throw new Failure("SERVICE_UNAVAILABLE", "作业服务暂不可受理，请检查服务与持久化状态", 503, true);

        // 耗时几何校验严格在锁外执行，不阻塞任何其他作业的查询、取消或提交。
        validate(input);

        StoredOptimizationJob accepted;
        OptimizationExecutionPool.PendingEntry pendingEntry;
        synchronized (fileAdmissionLock) {
            String doubleCheckId = keys.get(key);
            if (doubleCheckId != null) {
                var old = documents.get(doubleCheckId);
                if (old != null) {
                    assertIdempotencyMatch(old, inputHash, workbenchSource);
                    return old.job();
                }
            }
            if (closing || storageFailed)
                throw new Failure("SERVICE_UNAVAILABLE", "作业服务暂不可受理，请检查服务与持久化状态", 503, true);
            if (executionPool.pendingSize() >= workers + queueCapacity)
                throw new Failure("QUOTA_EXCEEDED", "作业并发/排队限额已满；请稍后重试", 429, true);
            if (documents.size() >= maxStored) {
                evictTerminalJobsFileModeLocked(true);
            }
            if (documents.size() >= maxStored)
                throw new Failure("QUOTA_EXCEEDED", "作业归档限额已满且无终态作业可清理；请等待活跃作业完成后重试", 429, true);

            String id = UUID.randomUUID().toString();
            var job = new OptimizationJob(id, "2.0", input.clientRequestId(), inputHash, "QUEUED", "QUEUED",
                    Instant.now().toString(), null, null, input.problem().timeLimitSeconds(), null, null, "已持久化，等待计算");
            accepted = new StoredOptimizationJob(key, input, job, null, workbenchSource);
            synchronized (lockFor(id)) {
                persist(accepted);
            }
            keys.put(key, id);
            pendingEntry = executionPool.registerPending(id, input.problemType(), () -> execute(id));
        }

        String id = accepted.job().id();
        try {
            executionPool.submitPending(pendingEntry);
        } catch (RejectedExecutionException rejected) {
            executionPool.removePending(id);
            StoredOptimizationJob failedDoc;
            synchronized (lockFor(id)) {
                failedDoc = OptimizationResultSupport.transition(documents.get(id), "FAILED", "STOPPED", "QUEUE_REJECTED",
                        "队列已关闭，请使用新的幂等键重试", null);
                persist(failedDoc);
            }
            sseHub.publishJobEvent(failedDoc, 1);
            return failedDoc.job();
        }
        sseHub.publishJobEvent(accepted, 1);
        return documents.getOrDefault(id, accepted).job();
    }

    /** 直接同步归档已完成计算的 2D 排料布局（供多料联排协同跳过异步重算生成 {@code resultId}）。 */
    public StoredOptimizationJob archiveCompleted2DResult(
            String key,
            OptimizationRequest input,
            NestingResult layout,
            WorkbenchJobSource workbenchSource
    ) {
        if (key == null || !key.matches("[A-Za-z0-9._:-]{8,128}"))
            throw new Failure("INVALID_INPUT", "Idempotency-Key 必须为 8–128 个字母、数字或 . _ : -", 400, false);
        if (input == null || !"NESTING_2D".equals(input.problemType()))
            throw new Failure("INVALID_INPUT", "同步归档仅支持 NESTING_2D 计算请求", 400, false);

        String inputHash = hash(input);
        if (shared != null) {
            var existing = shared.findByKey(key);
            if (existing != null) {
                assertIdempotencyMatch(existing, inputHash, workbenchSource);
                return existing;
            }
            if (closing) throw new Failure("SERVICE_UNAVAILABLE", "作业服务正在关闭", 503, true);
            validate(input);
            StoredOptimizationJob doc = OptimizationArchiveSupport.buildArchived2DDocument(
                    key, input, layout, workbenchSource, System.currentTimeMillis());
            try {
                var stored = shared.archiveCompletedOrGet(doc);
                assertIdempotencyMatch(stored, inputHash, workbenchSource);
                return stored;
            } catch (OptimizationFailure failure) {
                throw toFailure(failure);
            }
        }

        String existingId = keys.get(key);
        if (existingId != null) {
            var old = documents.get(existingId);
            if (old != null) {
                assertIdempotencyMatch(old, inputHash, workbenchSource);
                return old;
            }
        }
        if (closing || storageFailed)
            throw new Failure("SERVICE_UNAVAILABLE", "作业服务暂不可受理，请检查服务与持久化状态", 503, true);
        validate(input);
        StoredOptimizationJob doc = OptimizationArchiveSupport.buildArchived2DDocument(
                key, input, layout, workbenchSource, System.currentTimeMillis());
        synchronized (fileAdmissionLock) {
            String doubleCheckId = keys.get(key);
            if (doubleCheckId != null) {
                var old = documents.get(doubleCheckId);
                if (old != null) {
                    assertIdempotencyMatch(old, inputHash, workbenchSource);
                    return old;
                }
            }
            if (closing || storageFailed)
                throw new Failure("SERVICE_UNAVAILABLE", "作业服务暂不可受理，请检查服务与持久化状态", 503, true);
            if (documents.size() >= maxStored) {
                evictTerminalJobsFileModeLocked(true);
            }
            if (documents.size() >= maxStored)
                throw new Failure("QUOTA_EXCEEDED", "作业归档限额已满且无终态作业可清理；请等待活跃作业完成后重试", 429, true);
            synchronized (lockFor(doc.job().id())) {
                persist(doc);
            }
            keys.put(key, doc.job().id());
            return doc;
        }
    }

    /** 只读查询作业完整文档（含工作台来源元数据），不存在返回 null。调用方禁止对外暴露 idempotencyKey。 */
    public StoredOptimizationJob findJobWithSource(String resultId) {
        if (resultId == null || resultId.isBlank()) {
            return null;
        }
        return shared == null ? documents.get(resultId) : shared.find(resultId);
    }

    public OptimizationJob get(String id) { return required(id).job(); }

    public OptimizationRequest input(String id) { return required(id).input(); }

    public OptimizationResult result(String id) {
        var document = required(id);
        if (document.result() == null)
            throw new Failure("RESULT_NOT_AVAILABLE", "作业尚无已归档的验证结果，请查看作业状态", 409, !document.job().terminal());
        return document.result();
    }

    public ResultComparison compare(String leftId, String rightId) {
        if (leftId == null || leftId.isBlank() || rightId == null || rightId.isBlank())
            throw new Failure("INVALID_INPUT", "请提供两份已归档结果的编号", 400, false);
        return ResultComparisons.compare(input(leftId), result(leftId), input(rightId), result(rightId));
    }

    public OptimizationJob cancel(String id) {
        if (shared != null) {
            var document = shared.cancel(id);
            if (document == null) throw new Failure("NOT_FOUND", "计算作业或结果不存在", 404, false);
            if (!document.job().terminal()) {
                executionPool.interruptRunning(id);
            }
            sseHub.publishJobEvent(document, executionPool.resolveAttempt(id));
            return document.job();
        }
        StoredOptimizationJob updated;
        synchronized (lockFor(id)) {
            var document = required(id);
            if (document.job().terminal() || "CANCEL_REQUESTED".equals(document.job().state())) return document.job();
            boolean started = executionPool.isRunning(id);
            updated = OptimizationResultSupport.transition(document, started ? "CANCEL_REQUESTED" : "CANCELLED",
                    started ? "STOPPING" : "STOPPED", "CANCELLED", "调用方请求取消", null);
            persist(updated);
            if (started) {
                executionPool.interruptRunning(id);
            } else {
                executionPool.cancelPendingFileTask(id);
            }
        }
        sseHub.publishJobEvent(updated, 1);
        return updated.job();
    }

    int cleanupExpiredTerminalJobs() {
        try {
            if (shared != null) {
                if (closing) return 0;
                return store.purgeExpiredTerminal(terminalRetentionMillis);
            }
            synchronized (fileAdmissionLock) {
                if (closing || storageFailed) return 0;
                return evictTerminalJobsFileModeLocked(false);
            }
        } catch (RuntimeException error) {
            log.warn("定时清理过期终态作业失败", error);
            return 0;
        }
    }

    private StoredOptimizationJob required(String id) {
        var document = shared == null ? documents.get(id) : shared.find(id);
        if (document == null) throw new Failure("NOT_FOUND", "计算作业或结果不存在", 404, false);
        return document;
    }

    private static void assertIdempotencyMatch(
            StoredOptimizationJob existing,
            String inputHash,
            WorkbenchJobSource incomingSource
    ) {
        try {
            OptimizationResultSupport.assertIdempotencyMatch(existing, inputHash, incomingSource);
        } catch (OptimizationFailure failure) {
            throw toFailure(failure);
        }
    }

    private static Failure toFailure(OptimizationFailure failure) {
        if (failure instanceof Failure typed) return typed;
        return new Failure(failure.code, failure.getMessage(), failure.status, failure.retryable);
    }

    private void deadline(String id) {
        StoredOptimizationJob updated = null;
        synchronized (lockFor(id)) {
            var document = documents.get(id);
            if (document == null || document.job().terminal() || "CANCEL_REQUESTED".equals(document.job().state())) return;
            try {
                updated = OptimizationResultSupport.transition(document, "CANCEL_REQUESTED", "STOPPING", "TIMED_OUT", "已到求解时限，等待计算退出", null);
                persist(updated);
            } catch (RuntimeException error) {
                storageFailed = true;
                log.error("Cannot persist optimization timeout", error);
            }
            executionPool.interruptRunning(id);
        }
        if (updated != null) {
            sseHub.publishJobEvent(updated, 1);
        }
    }

    private void execute(String id) {
        ScheduledFuture<?> timeout = null;
        try {
            StoredOptimizationJob document;
            synchronized (lockFor(id)) {
                document = documents.get(id);
                if (document == null || document.job().terminal()) return;
                document = OptimizationResultSupport.transition(document, "RUNNING", "SOLVING", null, "正在计算并独立校验结果", null);
                persist(document);
                executionPool.registerRunning(id, Thread.currentThread());
                timeout = executionPool.scheduleTimeout(() -> deadline(id), document.input().problem().timeLimitSeconds());
            }
            sseHub.publishJobEvent(document, 1);

            long start = System.nanoTime();
            if ("SLITTING_1D".equals(document.input().problemType())) {
                var slittingResult = slitting.solve(document.input().slittingProblem());
                StoredOptimizationJob finalDoc;
                synchronized (lockFor(id)) {
                    document = required(id);
                    boolean stop = "CANCEL_REQUESTED".equals(document.job().state());
                    boolean timed = "TIMED_OUT".equals(document.job().code())
                            || (!stop && System.nanoTime() - start >= TimeUnit.SECONDS.toNanos(document.input().problem().timeLimitSeconds()));
                    Thread.interrupted();
                    boolean valid = Set.of("FEASIBLE", "NO_SOLUTION_FOUND").contains(slittingResult.status());
                    String state = timed ? "TIMED_OUT" : stop ? "CANCELLED" : valid ? "SUCCEEDED" : "FAILED";
                    var result = valid ? OptimizationResultSupport.resultSlitting(document, slittingResult, timed ? "TIME_LIMIT" : stop ? "CANCELLED" : "COMPLETED") : null;
                    finalDoc = OptimizationResultSupport.transition(document, state, "STOPPED",
                            timed ? "TIMED_OUT" : stop ? "CANCELLED" : valid ? null : slittingResult.status(),
                            timed ? "计算已退出，达到时限" : stop ? "计算已退出，取消完成" : valid ? "计算结束，履约状态请查看结果" : slittingResult.status(),
                            result);
                    persist(finalDoc);
                }
                sseHub.publishJobEvent(finalDoc, 1);
                return;
            }

            var outcome = document.input().strategy() == null
                    ? new MarkerOptimization.Outcome(solvers.solve(document.input().nestingProblem(), document.input().allowFallback()), null, null)
                    : MarkerOptimization.solve(document.input(), solvers, message -> progress(id, message));
            NestingResult layout = outcome.layout();

            StoredOptimizationJob finalDoc;
            synchronized (lockFor(id)) {
                document = required(id);
                boolean stop = "CANCEL_REQUESTED".equals(document.job().state());
                boolean timed = "TIMED_OUT".equals(document.job().code())
                        || (!stop && System.nanoTime() - start >= TimeUnit.SECONDS.toNanos(document.input().problem().timeLimitSeconds()));
                // Interrupts are execution signals, not permission to interrupt the final durable write.
                Thread.interrupted();
                boolean valid = Set.of("FEASIBLE", "NO_SOLUTION_FOUND").contains(layout.status());
                String state = timed ? "TIMED_OUT" : stop ? "CANCELLED" : valid && outcome.failureCode() == null ? "SUCCEEDED" : "FAILED";
                var result = valid ? OptimizationResultSupport.buildNestingResult(document, layout,
                        timed ? "TIME_LIMIT" : stop ? "CANCELLED" : outcome.failureCode() != null ? "ENGINE_ERROR" : "COMPLETED",
                        outcome.marker()) : null;
                finalDoc = OptimizationResultSupport.transition(document, state, "STOPPED",
                        timed ? "TIMED_OUT" : stop ? "CANCELLED" : outcome.failureCode() != null ? outcome.failureCode() : valid ? null : layout.status(),
                        timed ? "计算已退出，达到时限" : stop ? "计算已退出，取消完成"
                                : outcome.failureCode() != null ? "后续试排失败；此前已验证结果如有保留，请查看结果与试排记录"
                                : valid ? "计算结束，履约状态请查看结果" : layout.message(),
                        result);
                persist(finalDoc);
            }
            sseHub.publishJobEvent(finalDoc, 1);
        } catch (Throwable error) {
            StoredOptimizationJob failedDoc = null;
            synchronized (lockFor(id)) {
                Thread.interrupted();
                var document = documents.get(id);
                if (document != null && !document.job().terminal()) {
                    failedDoc = OptimizationResultSupport.executionFailure(document, error);
                    try {
                        persist(failedDoc);
                    } catch (RuntimeException storageError) {
                        storageFailed = true;
                        documents.put(id, failedDoc);
                        log.error("Optimization result could not be persisted", storageError);
                    }
                }
                log.error("Optimization job failed: {}", id, error);
            }
            if (failedDoc != null) {
                sseHub.publishJobEvent(failedDoc, 1);
            }
        } finally {
            if (timeout != null) timeout.cancel(false);
            executionPool.clearExecutionTracking(id);
            Thread.interrupted();
        }
    }

    private void progress(String id, String message) {
        StoredOptimizationJob updated = null;
        synchronized (lockFor(id)) {
            var document = documents.get(id);
            if (document == null || !"RUNNING".equals(document.job().state())) return;
            updated = OptimizationResultSupport.withMessage(document, message);
            persist(updated);
        }
        if (updated != null) {
            sseHub.publishJobEvent(updated, 1);
        }
    }

    private int evictTerminalJobsFileModeLocked(boolean enforceCapacity) {
        long cutoff = System.currentTimeMillis() - terminalRetentionMillis;
        var candidates = new ArrayList<StoredOptimizationJob>();
        for (var entry : documents.entrySet()) {
            String id = entry.getKey();
            var doc = entry.getValue();
            if (OptimizationResultSupport.isEvictableTerminal(doc) && !executionPool.isPendingOrRunning(id)) {
                candidates.add(doc);
            }
        }
        if (candidates.isEmpty()) return 0;
        candidates.sort(Comparator.comparingLong(OptimizationResultSupport::terminalTimestampMillis)
                .thenComparing(doc -> doc.job().id()));
        int removed = 0;
        for (var doc : candidates) {
            boolean expired = OptimizationResultSupport.terminalTimestampMillis(doc) <= cutoff;
            boolean needSpace = enforceCapacity && documents.size() >= maxStored;
            if (!expired && !needSpace) break;
            String id = doc.job().id();
            synchronized (lockFor(id)) {
                if (executionPool.isPendingOrRunning(id)) continue;
                var latest = documents.get(id);
                if (!OptimizationResultSupport.isEvictableTerminal(latest)) continue;
                store.delete(id);
                documents.remove(id);
                keys.remove(latest.idempotencyKey(), id);
                jobLocks.remove(id);
                removed++;
            }
        }
        return removed;
    }

    private void persist(StoredOptimizationJob document) {
        store.save(document);
        documents.put(document.job().id(), document);
    }

    private String hash(OptimizationRequest input) {
        return StoredOptimizationJob.inputHash(input);
    }

    @Override
    @PreDestroy
    public void close() {
        synchronized (fileAdmissionLock) {
            if (closing) return;
            closing = true;
            executionPool.markClosing();
        }
        // 关闭全部活跃 SSE 连接防止停机挂起与内存残留
        sseHub.closeAll();

        if (shared != null) {
            // Stop this process's attempts; leave durable queued jobs for surviving workers.
            executionPool.fenceAllLocalLeases();
        } else {
            for (String id : executionPool.pendingJobIdsSnapshot()) {
                try {
                    cancel(id);
                } catch (RuntimeException error) {
                    log.error("Cannot persist shutdown cancellation", error);
                }
            }
        }
        executionPool.shutdownAndCloseStore(store);
    }
}
