package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.contracts.jobs.OptimizationJob;
import com.example.cutdemotwo.contracts.jobs.StoredOptimizationJob;
import org.springframework.http.MediaType;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.IntSupplier;
import java.util.function.Supplier;

/**
 * 计算作业 SSE 实时事件广播中心：
 * 维护客户端订阅句柄生命周期、严格执行“先注册后重读状态”防竞态窗口，并在终态/断连/超时后立即注销零泄漏。
 */
final class OptimizationSseHub {
    private static final long MIN_SSE_TIMEOUT_MILLIS = 60_000L;
    private static final long MAX_SSE_TIMEOUT_MILLIS = 300_000L;

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

    private final ConcurrentHashMap<String, CopyOnWriteArraySet<JobEventSubscriber>> eventSubscribers = new ConcurrentHashMap<>();

    SseEmitter subscribe(
            StoredOptimizationJob initial,
            Supplier<StoredOptimizationJob> latestReader,
            IntSupplier attemptResolver
    ) {
        String jobId = initial.job().id();
        long timeoutMs = computeSseTimeoutMillis(initial.job().timeLimitSeconds());
        SseEmitter emitter = new SseEmitter(timeoutMs);

        if (initial.job().terminal()) {
            try {
                emitter.send(SseEmitter.event()
                        .name("done")
                        .data(buildDonePayload(initial, attemptResolver.getAsInt()), MediaType.APPLICATION_JSON));
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

        StoredOptimizationJob latest = latestReader.get();
        if (latest == null) {
            subscriber.closeAndUnregister();
            return emitter;
        }
        int attempt = attemptResolver.getAsInt();
        if (latest.job().terminal()) {
            subscriber.sendDoneAndComplete(buildDonePayload(latest, attempt));
        } else {
            subscriber.sendProgress(buildProgressPayload(latest, attempt), eventFingerprint(latest.job(), attempt));
        }
        return emitter;
    }

    int activeSubscriberCount() {
        int total = 0;
        for (var set : eventSubscribers.values()) {
            total += set.size();
        }
        return total;
    }

    boolean hasSubscribers() {
        return !eventSubscribers.isEmpty();
    }

    List<String> subscribedJobIdsSnapshot() {
        return List.copyOf(eventSubscribers.keySet());
    }

    void publishJobEvent(StoredOptimizationJob document, int attempt) {
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

    void closeAll() {
        for (var set : List.copyOf(eventSubscribers.values())) {
            for (JobEventSubscriber sub : set) {
                sub.closeAndUnregister();
            }
        }
        eventSubscribers.clear();
    }

    private void unregisterSubscriber(JobEventSubscriber subscriber) {
        eventSubscribers.computeIfPresent(subscriber.jobId, (id, set) -> {
            set.remove(subscriber);
            return set.isEmpty() ? null : set;
        });
    }

    private static long computeSseTimeoutMillis(int timeLimitSeconds) {
        long candidate = (Math.max(1, timeLimitSeconds) + 30L) * 1000L;
        return Math.max(MIN_SSE_TIMEOUT_MILLIS, Math.min(MAX_SSE_TIMEOUT_MILLIS, candidate));
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
}
