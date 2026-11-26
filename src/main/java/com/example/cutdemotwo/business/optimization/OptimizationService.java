package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.algorithm.api.NestingSolver;
import com.example.cutdemotwo.contracts.jobs.*;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import com.example.cutdemotwo.persistence.*;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.*;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

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
    private static final long LEASE_MILLIS = 15_000L;
    private static final long CLEANUP_INTERVAL_MINUTES = 5L;
    private static final long DEFAULT_TERMINAL_RETENTION_HOURS = 168L;
    private static final String DEFAULT_SLITTING_CHILD_XMX = "768m";
    private static final int MAX_NESTING_TIME_LIMIT_SECONDS = 60;
    private static final int MAX_SLITTING_TIME_LIMIT_SECONDS = 180;
    private static final long MIN_SSE_TIMEOUT_MILLIS = 60_000L;
    private static final long MAX_SSE_TIMEOUT_MILLIS = 300_000L;

    private final NestingSolver solvers;
    private final com.example.cutdemotwo.algorithm.api.ISlittingSolverEngine slitting;
    private final OptimizationJobStore store;
    private final LeasedOptimizationJobStore shared;
    private final String owner = UUID.randomUUID().toString();
    private final String owner2d = owner + ":2d";
    private final String owner1d = owner + ":1d";

    private static final class LocalLease {
        final LeasedOptimizationJobStore.Lease lease;
        final String problemType;
        volatile boolean lost;

        LocalLease(LeasedOptimizationJobStore.Lease lease, String problemType) {
            this.lease = lease;
            this.problemType = problemType;
        }
    }

    private record PendingEntry(Runnable task, ThreadPoolExecutor pool, String problemType) {}

    /** 单个客户端 SSE 订阅句柄：内部串行推送事件并保证终态/断连/超时后立即注销零泄漏。 */
    private final class JobEventSubscriber {
        final String jobId;
        final SseEmitter emitter;
        final AtomicBoolean closed = new AtomicBoolean(false);
        volatile String lastFingerprint;

        JobEventSubscriber(String jobId, SseEmitter emitter) {
            this.jobId = jobId;
            this.emitter = emitter;
        }

        synchronized void sendProgress(Map<String, Object> payload, String fingerprint) {
            if (closed.get()) return;
            if (fingerprint != null && fingerprint.equals(lastFingerprint)) return;
            try {
                emitter.send(SseEmitter.event().name("progress").data(payload, MediaType.APPLICATION_JSON));
                lastFingerprint = fingerprint;
            } catch (IOException | IllegalStateException error) {
                closeAndUnregister();
            }
        }

        synchronized void sendDoneAndComplete(Map<String, Object> payload) {
            if (!closed.compareAndSet(false, true)) return;
            try {
                emitter.send(SseEmitter.event().name("done").data(payload, MediaType.APPLICATION_JSON));
                emitter.complete();
            } catch (IOException | IllegalStateException ignored) {
                // 客户端已断连时直接安静注销
            } finally {
                unregisterSubscriber(this);
            }
        }

        synchronized void closeAndUnregister() {
            if (!closed.compareAndSet(false, true)) return;
            try {
                emitter.complete();
            } catch (RuntimeException ignored) {
            } finally {
                unregisterSubscriber(this);
            }
        }
    }

    private final int workers;
    private final int slittingWorkers;
    private final int queueCapacity;
    private final int maxStored;
    private final long terminalRetentionHours;
    private final long terminalRetentionMillis;
    private final int slittingMaxHeapMiB;

    /** 2D 排样独立执行池 */
    private final ThreadPoolExecutor nestingExecutor;
    /** 1D 分切独立隔离执行池（并发度独立受限，防止 1D 精修阻塞 2D 实时排样） */
    private final ThreadPoolExecutor slittingExecutor;
    private final ScheduledExecutorService timer;

    /** 细粒度并发状态表（替代原全类 synchronized(this)） */
    private final ConcurrentHashMap<String, StoredOptimizationJob> documents = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, String> keys = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, PendingEntry> pending = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Thread> running = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, LocalLease> leases = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Object> jobLocks = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, CopyOnWriteArraySet<JobEventSubscriber>> eventSubscribers = new ConcurrentHashMap<>();

    /** 仅用于文件模式新作业准入与淘汰的短临界区锁（锁外完成几何校验与哈希，不阻塞只读查询） */
    private final Object fileAdmissionLock = new Object();
    private final AtomicBoolean dispatching = new AtomicBoolean(false);
    private volatile boolean closing;
    private volatile boolean storageFailed;

    public OptimizationService(NestingSolver solvers,
                               com.example.cutdemotwo.algorithm.api.ISlittingSolverEngine slitting,
                               OptimizationJobStore store,
                               int workers, int queueCapacity, int maxStored) {
        this(solvers, slitting, store, workers, queueCapacity, maxStored,
                DEFAULT_TERMINAL_RETENTION_HOURS, DEFAULT_SLITTING_CHILD_XMX, 0);
    }

    public OptimizationService(NestingSolver solvers,
                               com.example.cutdemotwo.algorithm.api.ISlittingSolverEngine slitting,
                               OptimizationJobStore store,
                               int workers, int queueCapacity, int maxStored,
                               long terminalRetentionHours, String slittingChildXmx) {
        this(solvers, slitting, store, workers, queueCapacity, maxStored,
                terminalRetentionHours, slittingChildXmx, 0);
    }

    @Autowired
    public OptimizationService(NestingSolver solvers,
                               com.example.cutdemotwo.algorithm.api.ISlittingSolverEngine slitting,
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
                this.slittingWorkers, this.slittingWorkers, 0, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(this.slittingWorkers + queueCapacity),
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

        try {
            if (shared != null) {
                shared.configure(workers, queueCapacity, maxStored);
                timer.scheduleWithFixedDelay(this::dispatch, 0, 200, TimeUnit.MILLISECONDS);
            } else {
                for (var document : store.load()) {
                    var job = document.job();
                    if (keys.putIfAbsent(document.idempotencyKey(), job.id()) != null
                            || documents.putIfAbsent(job.id(), document) != null) {
                        throw new IllegalStateException("作业存储中存在重复身份或幂等键");
                    }
                    if (!job.terminal()) {
                        persist(transition(document, "FAILED", "STOPPED", "PROCESS_RESTARTED",
                                "服务重启打断了作业；未自动重算，请使用新的幂等键重试", null));
                    }
                }
            }
            timer.scheduleWithFixedDelay(this::cleanupExpiredTerminalJobs,
                    CLEANUP_INTERVAL_MINUTES, CLEANUP_INTERVAL_MINUTES, TimeUnit.MINUTES);
        } catch (RuntimeException error) {
            nestingExecutor.shutdownNow();
            slittingExecutor.shutdownNow();
            timer.shutdownNow();
            store.close();
            throw error;
        }
    }

    static int parseHeapMiB(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (!value.matches("([1-9][0-9]{1,4}[mM]|[1-9][0-9]{0,1}[gG])")) {
            throw new IllegalArgumentException("无效的一维子进程堆上限配置 cutdemo.slitting.child-xmx: " + raw);
        }
        int amount = Integer.parseInt(value.substring(0, value.length() - 1));
        char unit = Character.toLowerCase(value.charAt(value.length() - 1));
        return unit == 'g' ? Math.multiplyExact(amount, 1024) : amount;
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

    public com.example.cutdemotwo.contracts.jobs.ProblemCheck validate(OptimizationRequest request) {
        if (request == null || request.problem() == null || request.allowFallback() == null || request.requireComplete() == null
                || request.clientRequestId() == null || request.clientRequestId().isBlank() || request.clientRequestId().length() > 128)
            throw new Failure("INVALID_INPUT", "必须提供问题、明确的降级/齐套选项及 1–128 字调用方请求编号", 400, false);
        if (!"2.0".equals(request.schemaVersion()))
            throw new Failure("UNSUPPORTED_CONSTRAINT", "当前仅支持 schemaVersion=2.0", 422, false);
        if ("SLITTING_1D".equals(request.problemType())) {
            if (!(request.problem() instanceof com.example.cutdemotwo.contracts.slitting.SlittingProblem))
                throw new Failure("INVALID_INPUT", "问题类型与内容不匹配", 400, false);
            if (request.strategy() != null)
                throw new Failure("UNSUPPORTED_CONSTRAINT", "一维问题不支持唛架策略", 422, false);
            if (!slitting.isAvailable())
                throw new Failure("ENGINE_UNAVAILABLE", "一维计算运行时不可用", 503, true);
            try {
                com.example.cutdemotwo.contracts.slitting.SlittingValidation.validateProblem(request.slittingProblem());
                return new com.example.cutdemotwo.contracts.jobs.ProblemCheck("VALID", "一维分切问题合法",
                        slitting.getEngineType(), slitting.getEngineType(), null);
            } catch (com.example.cutdemotwo.contracts.slitting.SlittingValidation.ValidationException e) {
                int status = "INVALID_INPUT".equals(e.getCode()) ? 400 : 422;
                throw new Failure(e.getCode(), e.getMessage(), status, false);
            }
        }
        if (!"NESTING_2D".equals(request.problemType()))
            throw new Failure("UNSUPPORTED_CONSTRAINT", "不支持的作业类型: " + request.problemType(), 422, false);
        if (!(request.problem() instanceof com.example.cutdemotwo.contracts.nesting.NestingProblem))
            throw new Failure("INVALID_INPUT", "问题类型与内容不匹配", 400, false);
        var check = solvers.validateProblem(request.nestingProblem(), request.allowFallback());
        if (!"VALID".equals(check.status())) throw switch (check.status()) {
            case "INVALID_INPUT" -> new Failure("INVALID_INPUT", check.message(), 400, false);
            case "UNAVAILABLE" -> new Failure("ENGINE_UNAVAILABLE", check.message(), 503, true);
            default -> new Failure("UNSUPPORTED_CONSTRAINT", check.message(), 422, false);
        };
        try {
            MarkerOptimization.validate(request);
            if (request.strategy() != null && request.strategy().initialPlacements() != null)
                MarkerOptimization.validatedSeed(request, solvers);
        } catch (OptimizationFailure failure) {
            if (failure instanceof Failure typed) throw typed;
            throw new Failure(failure.code, failure.getMessage(), failure.status, failure.retryable);
        }
        return check;
    }

    /**
     * 订阅指定作业的实时 SSE 事件流（契约：progress 阶段推送 + 终态 done 推送并自动优雅关闭）。
     * 作业不存在抛 404；已处于终态直接推送一次 done 并立即关闭，绝不泄漏监听器内存。
     */
    public SseEmitter subscribeEvents(String jobId) {
        var initial = required(jobId);
        long timeoutMs = computeSseTimeoutMillis(initial.job().timeLimitSeconds());
        SseEmitter emitter = new SseEmitter(timeoutMs);

        if (initial.job().terminal()) {
            try {
                emitter.send(SseEmitter.event()
                        .name("done")
                        .data(buildDonePayload(initial, resolveAttempt(jobId)), MediaType.APPLICATION_JSON));
                emitter.complete();
            } catch (IOException | IllegalStateException ignored) {
                // 客户端在响应写出前断开连接时安静结束
            }
            return emitter;
        }

        JobEventSubscriber subscriber = new JobEventSubscriber(jobId, emitter);
        emitter.onCompletion(() -> {
            subscriber.closed.set(true);
            unregisterSubscriber(subscriber);
        });
        emitter.onTimeout(subscriber::closeAndUnregister);
        emitter.onError(error -> subscriber.closeAndUnregister());

        // 先注册后重读最新状态，彻底消除“检查未终态 -> 作业刚好终态 -> 漏收 done”的竞态窗口。
        eventSubscribers.computeIfAbsent(jobId, k -> new CopyOnWriteArraySet<>()).add(subscriber);

        StoredOptimizationJob latest = shared == null ? documents.get(jobId) : shared.find(jobId);
        if (latest == null) {
            subscriber.closeAndUnregister();
            return emitter;
        }
        int attempt = resolveAttempt(jobId);
        if (latest.job().terminal()) {
            subscriber.sendDoneAndComplete(buildDonePayload(latest, attempt));
        } else {
            subscriber.sendProgress(buildProgressPayload(latest, attempt), eventFingerprint(latest.job(), attempt));
        }
        return emitter;
    }

    /** 返回当前活跃 SSE 监听器总数（供运维监控与内存泄漏专项单测核验）。 */
    int activeEventSubscriberCount() {
        int total = 0;
        for (var set : eventSubscribers.values()) {
            total += set.size();
        }
        return total;
    }

    private void unregisterSubscriber(JobEventSubscriber subscriber) {
        eventSubscribers.computeIfPresent(subscriber.jobId, (id, set) -> {
            set.remove(subscriber);
            return set.isEmpty() ? null : set;
        });
    }

    private void publishJobEvent(StoredOptimizationJob document, int attempt) {
        if (document == null || document.job() == null) return;
        String jobId = document.job().id();
        var set = eventSubscribers.get(jobId);
        if (set == null || set.isEmpty()) return;

        if (document.job().terminal()) {
            Map<String, Object> payload = buildDonePayload(document, attempt);
            for (JobEventSubscriber sub : set) {
                sub.sendDoneAndComplete(payload);
            }
        } else {
            Map<String, Object> payload = buildProgressPayload(document, attempt);
            String fingerprint = eventFingerprint(document.job(), attempt);
            for (JobEventSubscriber sub : set) {
                sub.sendProgress(payload, fingerprint);
            }
        }
    }

    private static long computeSseTimeoutMillis(int timeLimitSeconds) {
        long candidate = (Math.max(1, timeLimitSeconds) + 30L) * 1000L;
        return Math.max(MIN_SSE_TIMEOUT_MILLIS, Math.min(MAX_SSE_TIMEOUT_MILLIS, candidate));
    }

    private int resolveAttempt(String jobId) {
        LocalLease local = leases.get(jobId);
        if (local != null) {
            return (int) Math.max(1L, local.lease.token());
        }
        return 1;
    }

    private static long computeElapsedMs(OptimizationJob job) {
        String startRaw = job.startedAt() != null ? job.startedAt() : job.createdAt();
        if (startRaw == null) return 0L;
        try {
            long startMs = Instant.parse(startRaw).toEpochMilli();
            long endMs = job.finishedAt() != null
                    ? Instant.parse(job.finishedAt()).toEpochMilli()
                    : System.currentTimeMillis();
            return Math.max(0L, endMs - startMs);
        } catch (RuntimeException ignored) {
            return 0L;
        }
    }

    private static Map<String, Object> buildProgressPayload(StoredOptimizationJob document, int attempt) {
        OptimizationJob j = document.job();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("jobId", j.id());
        payload.put("status", j.state());
        payload.put("phase", j.phase());
        payload.put("elapsedMs", computeElapsedMs(j));
        payload.put("attempt", Math.max(1, attempt));
        if (j.message() != null) {
            payload.put("message", j.message());
        }
        return payload;
    }

    private static Map<String, Object> buildDonePayload(StoredOptimizationJob document, int attempt) {
        OptimizationJob j = document.job();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("jobId", j.id());
        payload.put("status", j.state());
        payload.put("phase", j.phase());
        payload.put("elapsedMs", computeElapsedMs(j));
        payload.put("finishedAt", j.finishedAt() != null ? j.finishedAt() : Instant.now().toString());
        payload.put("attempt", Math.max(1, attempt));
        if (j.code() != null) payload.put("code", j.code());
        if (j.message() != null) payload.put("message", j.message());
        if (j.resultRef() != null) payload.put("resultRef", j.resultRef());
        return payload;
    }

    private static String eventFingerprint(OptimizationJob job, int attempt) {
        return job.state() + "|" + job.phase() + "|" + attempt + "|" + Objects.toString(job.code(), "")
                + "|" + Objects.toString(job.message(), "");
    }

    private Object lockFor(String id) {
        return jobLocks.computeIfAbsent(id, k -> new Object());
    }

    private ThreadPoolExecutor executorFor(String problemType) {
        return "SLITTING_1D".equals(problemType) ? slittingExecutor : nestingExecutor;
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
                publishJobEvent(stored, 1);
                return stored.job();
            } catch (OptimizationFailure failure) {
                if (failure instanceof Failure typed) throw typed;
                throw new Failure(failure.code, failure.getMessage(), failure.status, failure.retryable);
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
        PendingEntry pendingEntry;
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
            if (pending.size() >= workers + queueCapacity)
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
            ThreadPoolExecutor targetPool = executorFor(input.problemType());
            Runnable task = () -> execute(id);
            pendingEntry = new PendingEntry(task, targetPool, input.problemType());
            pending.put(id, pendingEntry);
        }

        String id = accepted.job().id();
        try {
            pendingEntry.pool().execute(pendingEntry.task());
        } catch (RejectedExecutionException rejected) {
            pending.remove(id);
            StoredOptimizationJob failedDoc;
            synchronized (lockFor(id)) {
                failedDoc = transition(documents.get(id), "FAILED", "STOPPED", "QUEUE_REJECTED",
                        "队列已关闭，请使用新的幂等键重试", null);
                persist(failedDoc);
            }
            publishJobEvent(failedDoc, 1);
            return failedDoc.job();
        }
        publishJobEvent(accepted, 1);
        return documents.getOrDefault(id, accepted).job();
    }

    private static void assertIdempotencyMatch(StoredOptimizationJob existing, String inputHash, WorkbenchJobSource incomingSource) {
        if (!existing.job().inputHash().equals(inputHash)) {
            throw new Failure("IDEMPOTENCY_CONFLICT", "同一幂等键已绑定不同请求", 409, false);
        }
        WorkbenchJobSource oldSource = existing.workbenchSource();
        if (oldSource == null && incomingSource == null) {
            return;
        }
        if (oldSource == null || incomingSource == null
                || !Objects.equals(oldSource.taskId(), incomingSource.taskId())
                || !Objects.equals(oldSource.materialType(), incomingSource.materialType())
                || !Objects.equals(oldSource.materialId(), incomingSource.materialId())) {
            throw new Failure("IDEMPOTENCY_CONFLICT", "同一幂等键已绑定不同工作台任务或材料上下文", 409, false);
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

    private StoredOptimizationJob required(String id) {
        var document = shared == null ? documents.get(id) : shared.find(id);
        if (document == null) throw new Failure("NOT_FOUND", "计算作业或结果不存在", 404, false);
        return document;
    }

    public OptimizationJob cancel(String id) {
        if (shared != null) {
            var document = shared.cancel(id);
            if (document == null) throw new Failure("NOT_FOUND", "计算作业或结果不存在", 404, false);
            var thread = running.get(id);
            if (thread != null && !document.job().terminal()) thread.interrupt();
            publishJobEvent(document, resolveAttempt(id));
            return document.job();
        }
        StoredOptimizationJob updated;
        synchronized (lockFor(id)) {
            var document = required(id);
            if (document.job().terminal() || "CANCEL_REQUESTED".equals(document.job().state())) return document.job();
            boolean started = running.containsKey(id);
            updated = transition(document, started ? "CANCEL_REQUESTED" : "CANCELLED",
                    started ? "STOPPING" : "STOPPED", "CANCELLED", "调用方请求取消", null);
            persist(updated);
            if (started) {
                var thread = running.get(id);
                if (thread != null) thread.interrupt();
            } else {
                var entry = pending.remove(id);
                if (entry != null) entry.pool().remove(entry.task());
            }
        }
        publishJobEvent(updated, 1);
        return updated.job();
    }

    private void deadline(String id) {
        StoredOptimizationJob updated = null;
        synchronized (lockFor(id)) {
            var document = documents.get(id);
            if (document == null || document.job().terminal() || "CANCEL_REQUESTED".equals(document.job().state())) return;
            try {
                updated = transition(document, "CANCEL_REQUESTED", "STOPPING", "TIMED_OUT", "已到求解时限，等待计算退出", null);
                persist(updated);
            } catch (RuntimeException error) {
                storageFailed = true;
                log.error("Cannot persist optimization timeout", error);
            }
            var thread = running.get(id);
            if (thread != null) thread.interrupt();
        }
        if (updated != null) {
            publishJobEvent(updated, 1);
        }
    }

    private void execute(String id) {
        ScheduledFuture<?> timeout = null;
        try {
            StoredOptimizationJob document;
            synchronized (lockFor(id)) {
                document = documents.get(id);
                if (document == null || document.job().terminal()) return;
                document = transition(document, "RUNNING", "SOLVING", null, "正在计算并独立校验结果", null);
                persist(document);
                running.put(id, Thread.currentThread());
                timeout = timer.schedule(() -> deadline(id), document.input().problem().timeLimitSeconds(), TimeUnit.SECONDS);
            }
            publishJobEvent(document, 1);

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
                    var result = valid ? resultSlitting(document, slittingResult, timed ? "TIME_LIMIT" : stop ? "CANCELLED" : "COMPLETED") : null;
                    finalDoc = transition(document, state, "STOPPED",
                            timed ? "TIMED_OUT" : stop ? "CANCELLED" : valid ? null : slittingResult.status(),
                            timed ? "计算已退出，达到时限" : stop ? "计算已退出，取消完成" : valid ? "计算结束，履约状态请查看结果" : slittingResult.status(),
                            result);
                    persist(finalDoc);
                }
                publishJobEvent(finalDoc, 1);
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
                var result = valid ? result(document, layout,
                        timed ? "TIME_LIMIT" : stop ? "CANCELLED" : outcome.failureCode() != null ? "ENGINE_ERROR" : "COMPLETED",
                        outcome.marker()) : null;
                finalDoc = transition(document, state, "STOPPED",
                        timed ? "TIMED_OUT" : stop ? "CANCELLED" : outcome.failureCode() != null ? outcome.failureCode() : valid ? null : layout.status(),
                        timed ? "计算已退出，达到时限" : stop ? "计算已退出，取消完成"
                                : outcome.failureCode() != null ? "后续试排失败；此前已验证结果如有保留，请查看结果与试排记录"
                                : valid ? "计算结束，履约状态请查看结果" : layout.message(),
                        result);
                persist(finalDoc);
            }
            publishJobEvent(finalDoc, 1);
        } catch (Throwable error) {
            StoredOptimizationJob failedDoc = null;
            synchronized (lockFor(id)) {
                Thread.interrupted();
                var document = documents.get(id);
                if (document != null && !document.job().terminal()) {
                    failedDoc = executionFailure(document, error);
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
                publishJobEvent(failedDoc, 1);
            }
        } finally {
            if (timeout != null) timeout.cancel(false);
            running.remove(id);
            pending.remove(id);
            Thread.interrupted();
        }
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
                    publishJobEvent(current, (int) local.lease.token());
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
                publishJobEvent(lease.document(), (int) lease.token());
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
                publishJobEvent(lease.document(), (int) lease.token());
                slittingExecutor.execute(() -> executeShared(local));
            }

            // 4. 若有客户端订阅了由其他集群节点执行的作业，同步其最新状态/终态至本地 SSE 流
            if (!eventSubscribers.isEmpty()) {
                for (String subscribedId : List.copyOf(eventSubscribers.keySet())) {
                    if (leases.containsKey(subscribedId)) continue;
                    var latest = shared.find(subscribedId);
                    if (latest != null) {
                        publishJobEvent(latest, 1);
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
                        written[0] = finishedSlitting(current, result);
                        return written[0];
                    }, true);
                    if (ok && written[0] != null) {
                        publishJobEvent(written[0], attempt);
                    }
                }
                return;
            }
            var p = input.nestingProblem();
            var bounded = new com.example.cutdemotwo.contracts.nesting.NestingProblem(
                    p.schemaVersion(), p.unit(), p.material(), p.parts(), p.process(), p.engine(), seconds);
            var execution = new OptimizationRequest(input.schemaVersion(), input.problemType(), input.clientRequestId(),
                    bounded, input.allowFallback(), input.requireComplete(), input.strategy());
            var outcome = execution.strategy() == null
                    ? new MarkerOptimization.Outcome(solvers.solve(bounded, input.allowFallback()), null, null)
                    : MarkerOptimization.solve(execution, solvers, message -> {
                        if (local.lost) return;
                        var progressed = new StoredOptimizationJob[1];
                        boolean ok = shared.update(local.lease, current -> {
                            progressed[0] = withMessage(current, message);
                            return progressed[0];
                        }, false);
                        if (!ok) {
                            Thread.currentThread().interrupt();
                        } else if (progressed[0] != null) {
                            publishJobEvent(progressed[0], attempt);
                        }
                    });
            Thread.interrupted();
            if (!local.lost) {
                var written = new StoredOptimizationJob[1];
                boolean ok = shared.update(local.lease, current -> {
                    written[0] = finished(current, outcome);
                    return written[0];
                }, true);
                if (!ok) {
                    log.info("Discarded result from expired optimization attempt: {} token {}", id, local.lease.token());
                } else if (written[0] != null) {
                    publishJobEvent(written[0], attempt);
                }
            }
        } catch (Throwable error) {
            Thread.interrupted();
            if (!local.lost) {
                try {
                    var written = new StoredOptimizationJob[1];
                    boolean ok = shared.update(local.lease, current -> {
                        written[0] = executionFailure(current, error);
                        return written[0];
                    }, true);
                    if (ok && written[0] != null) {
                        publishJobEvent(written[0], attempt);
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

    private StoredOptimizationJob executionFailure(StoredOptimizationJob document, Throwable error) {
        boolean stopping = "CANCEL_REQUESTED".equals(document.job().state());
        boolean timed = "TIMED_OUT".equals(document.job().code())
                || (!stopping && error instanceof com.example.cutdemotwo.algorithm.api.ComputationTimeout);
        String state = timed ? "TIMED_OUT" : stopping ? "CANCELLED" : "FAILED";
        String code = timed || stopping ? state : error instanceof com.example.cutdemotwo.contracts.slitting.SlittingValidation.ValidationException
                ? "INVALID_RESULT" : "EXECUTION_FAILED";
        return transition(document, state, "STOPPED", code, timed || stopping ? "计算进程已退出" : "执行或结果验证失败，请检查服务日志", null);
    }

    private StoredOptimizationJob finishedSlitting(StoredOptimizationJob current, com.example.cutdemotwo.contracts.slitting.SlittingResult result) {
        boolean stop = "CANCEL_REQUESTED".equals(current.job().state()), timed = stop && "TIMED_OUT".equals(current.job().code());
        return transition(current, timed ? "TIMED_OUT" : stop ? "CANCELLED" : "SUCCEEDED", "STOPPED",
                timed ? "TIMED_OUT" : stop ? "CANCELLED" : null,
                "计算已退出，履约状态请查看结果",
                resultSlitting(current, result, timed ? "TIME_LIMIT" : stop ? "CANCELLED" : "COMPLETED"));
    }

    private OptimizationResult resultSlitting(StoredOptimizationJob document, com.example.cutdemotwo.contracts.slitting.SlittingResult r, String termination) {
        com.example.cutdemotwo.contracts.slitting.SlittingValidation.validateResult(document.input().slittingProblem(), r);
        boolean complete = !r.fulfillment().isEmpty() && r.fulfillment().stream().allMatch(f -> f.missing() == 0);
        boolean any = r.fulfillment().stream().anyMatch(f -> f.produced() > 0);
        var metrics = List.of(
                new OptimizationResult.Metric("motherAreaUtilization", r.motherAreaMm2() > 0 ? 100d * r.pieceAreaMm2() / r.motherAreaMm2() : 0,
                        "%", r.pieceAreaMm2(), r.motherAreaMm2(), "planned-produced-area / planned-mother-area; includes fixed trims in denominator", "1"),
                new OptimizationResult.Metric("usableAreaUtilization", r.usableAreaMm2() > 0 ? 100d * r.pieceAreaMm2() / r.usableAreaMm2() : 0,
                        "%", r.pieceAreaMm2(), r.usableAreaMm2(), "planned-produced-area / planned-usable-area; excludes fixed trims from denominator", "1"));
        return new OptimizationResult(document.job().id(), document.job().id(), document.job().inputHash(), "2.0", "PASSED",
                complete ? "COMPLETE" : any ? "PARTIAL" : "NONE", any && (!document.input().requireComplete() || complete), termination, metrics, r);
    }

    private StoredOptimizationJob finished(StoredOptimizationJob current, MarkerOptimization.Outcome outcome) {
        boolean stop = "CANCEL_REQUESTED".equals(current.job().state()), timed = stop && "TIMED_OUT".equals(current.job().code());
        var layout = outcome.layout();
        boolean valid = Set.of("FEASIBLE", "NO_SOLUTION_FOUND").contains(layout.status());
        String state = timed ? "TIMED_OUT" : stop ? "CANCELLED" : valid && outcome.failureCode() == null ? "SUCCEEDED" : "FAILED";
        var result = valid ? result(current, layout,
                timed ? "TIME_LIMIT" : stop ? "CANCELLED" : outcome.failureCode() != null ? "ENGINE_ERROR" : "COMPLETED",
                outcome.marker()) : null;
        return transition(current, state, "STOPPED",
                timed ? "TIMED_OUT" : stop ? "CANCELLED" : outcome.failureCode() != null ? outcome.failureCode() : valid ? null : layout.status(),
                stop ? "计算已退出" : outcome.failureCode() != null ? "后续试排失败；此前已验证结果如有保留，请查看试排记录"
                        : valid ? "计算结束，履约状态请查看结果" : layout.message(),
                result);
    }

    private StoredOptimizationJob withMessage(StoredOptimizationJob document, String message) {
        var j = document.job();
        var job = new OptimizationJob(j.id(), j.schemaVersion(), j.clientRequestId(), j.inputHash(), j.state(), j.phase(), j.createdAt(),
                j.startedAt(), j.finishedAt(), j.timeLimitSeconds(), j.resultRef(), j.code(), message);
        return new StoredOptimizationJob(document.idempotencyKey(), document.input(), job, document.result(), document.workbenchSource());
    }

    private void progress(String id, String message) {
        StoredOptimizationJob updated = null;
        synchronized (lockFor(id)) {
            var document = documents.get(id);
            if (document == null || !"RUNNING".equals(document.job().state())) return;
            var j = document.job();
            var job = new OptimizationJob(j.id(), j.schemaVersion(), j.clientRequestId(), j.inputHash(), j.state(), j.phase(),
                    j.createdAt(), j.startedAt(), j.finishedAt(), j.timeLimitSeconds(), j.resultRef(), j.code(), message);
            updated = new StoredOptimizationJob(document.idempotencyKey(), document.input(), job, document.result(), document.workbenchSource());
            persist(updated);
        }
        if (updated != null) {
            publishJobEvent(updated, 1);
        }
    }

    private OptimizationResult result(StoredOptimizationJob document, NestingResult layout, String termination, OptimizationResult.MarkerReport marker) {
        int requested = layout.fulfillment().stream().mapToInt(NestingResult.Fulfillment::requested).sum();
        int placed = layout.fulfillment().stream().mapToInt(NestingResult.Fulfillment::placed).sum();
        boolean complete = requested > 0 && requested == placed;
        var m = layout.metrics();
        var metrics = new ArrayList<OptimizationResult.Metric>();
        metrics.add(new OptimizationResult.Metric("processingAreaUtilization", m.processingAreaMm2() > 0 ? m.pieceAreaMm2() / m.processingAreaMm2() * 100 : 0,
                "%", m.pieceAreaMm2(), m.processingAreaMm2(), "piece-net-area / submitted-processing-area; not actual consumed material", "1"));
        if (marker != null && marker.occupiedLengthMm() != null && complete) {
            double area = layout.processingRegion().width() * marker.occupiedLengthMm();
            metrics.add(new OptimizationResult.Metric("markerAreaUtilization", m.pieceAreaMm2() / area * 100, "%",
                    m.pieceAreaMm2(), area, "complete-kit-net-area / (fixed-width * occupied-marker-length); excludes unused tail; planned", "1"));
            if (marker.gapFillPlacements() != null) {
                double withFill = m.pieceAreaMm2() + marker.gapFillPlacements().stream().mapToDouble(p -> p.shape().areaMm2()).sum();
                metrics.add(new OptimizationResult.Metric("markerAreaUtilizationWithFill", withFill / area * 100, "%",
                        withFill, area, "(complete-kit + verified spare net area) / (fixed-width * occupied-marker-length); planned", "1"));
            }
        }
        return new OptimizationResult(document.job().id(), document.job().id(), document.job().inputHash(), "2.0", "PASSED",
                complete ? "COMPLETE" : placed > 0 ? "PARTIAL" : "NONE", layout.feasible() && (!document.input().requireComplete() || complete), termination,
                List.copyOf(metrics), layout, marker);
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

    private int evictTerminalJobsFileModeLocked(boolean enforceCapacity) {
        long cutoff = System.currentTimeMillis() - terminalRetentionMillis;
        var candidates = new ArrayList<StoredOptimizationJob>();
        for (var entry : documents.entrySet()) {
            String id = entry.getKey();
            var doc = entry.getValue();
            if (isEvictableTerminal(doc) && !pending.containsKey(id) && !running.containsKey(id)) {
                candidates.add(doc);
            }
        }
        if (candidates.isEmpty()) return 0;
        candidates.sort(Comparator.comparingLong(OptimizationService::terminalTimestampMillis)
                .thenComparing(doc -> doc.job().id()));
        int removed = 0;
        for (var doc : candidates) {
            boolean expired = terminalTimestampMillis(doc) <= cutoff;
            boolean needSpace = enforceCapacity && documents.size() >= maxStored;
            if (!expired && !needSpace) break;
            String id = doc.job().id();
            synchronized (lockFor(id)) {
                if (pending.containsKey(id) || running.containsKey(id)) continue;
                var latest = documents.get(id);
                if (!isEvictableTerminal(latest)) continue;
                store.delete(id);
                documents.remove(id);
                keys.remove(latest.idempotencyKey(), id);
                jobLocks.remove(id);
                removed++;
            }
        }
        return removed;
    }

    private static boolean isEvictableTerminal(StoredOptimizationJob doc) {
        if (doc == null || doc.job() == null) return false;
        return doc.job().terminal() || "LEASE_LOST".equals(doc.job().state());
    }

    private static long terminalTimestampMillis(StoredOptimizationJob doc) {
        String raw = doc.job().finishedAt() != null ? doc.job().finishedAt() : doc.job().createdAt();
        if (raw == null) return 0L;
        try {
            return Instant.parse(raw).toEpochMilli();
        } catch (RuntimeException ignored) {
            return 0L;
        }
    }

    private StoredOptimizationJob transition(StoredOptimizationJob d, String state, String phase, String code, String message, OptimizationResult result) {
        return d.transition(state, phase, code, message, result, System.currentTimeMillis());
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
        }
        // 关闭全部活跃 SSE 连接防止停机挂起与内存残留
        for (var set : List.copyOf(eventSubscribers.values())) {
            for (JobEventSubscriber sub : set) {
                sub.closeAndUnregister();
            }
        }
        eventSubscribers.clear();

        if (shared != null) {
            // Stop this process's attempts; leave durable queued jobs for surviving workers.
            for (var entry : leases.entrySet()) {
                entry.getValue().lost = true;
                var thread = running.get(entry.getKey());
                if (thread != null) thread.interrupt();
            }
        } else {
            for (String id : List.copyOf(pending.keySet())) {
                try {
                    cancel(id);
                } catch (RuntimeException error) {
                    log.error("Cannot persist shutdown cancellation", error);
                }
            }
        }
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
}
