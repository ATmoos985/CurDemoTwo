package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 轻量有界并行执行器（留在 {@code algorithm.nesting} 内部）：
 * <ul>
 *   <li>并发度上限为 {@code Math.min(4, availableProcessors)}，避免线程池过载；</li>
 *   <li>调用线程亲自执行第 0 个任务，既减少一次上下文切换，又避免嵌套调用死锁并保持调用栈可观测；</li>
 *   <li>严格按原任务索引顺序返回结果，保证确定性归约；</li>
 *   <li>任一任务收到中断/取消时立即向所有工作线程传播 {@code cancel(true)} 并保持调用线程中断位。</li>
 * </ul>
 */
final class NestingParallelExecutor {
    static final int MAX_PARALLELISM = Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors()));

    private static final AtomicInteger THREAD_SEQ = new AtomicInteger(1);
    private static final ExecutorService POOL = MAX_PARALLELISM <= 1
            ? null
            : Executors.newFixedThreadPool(MAX_PARALLELISM, r -> {
                Thread t = new Thread(r, "nesting-worker-" + THREAD_SEQ.getAndIncrement());
                t.setDaemon(true);
                return t;
            });

    private NestingParallelExecutor() {}

    static <T> List<T> runDeterministic(List<Callable<T>> tasks) {
        ComputationCancellation.check();
        int count = tasks.size();
        if (count == 0) {
            return List.of();
        }
        if (count == 1 || POOL == null) {
            List<T> sequential = new ArrayList<>(count);
            for (Callable<T> task : tasks) {
                ComputationCancellation.check();
                sequential.add(callUnchecked(task));
            }
            return sequential;
        }

        List<Future<T>> futures = new ArrayList<>(count - 1);
        for (int i = 1; i < count; i++) {
            final Callable<T> task = tasks.get(i);
            futures.add(POOL.submit(() -> {
                ComputationCancellation.check();
                return task.call();
            }));
        }

        boolean completedNormally = false;
        try {
            List<T> results = new ArrayList<>(count);
            results.add(callUnchecked(tasks.get(0)));
            for (Future<T> future : futures) {
                ComputationCancellation.check();
                try {
                    results.add(future.get());
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new CancellationException("计算收到停止请求");
                } catch (ExecutionException e) {
                    Throwable cause = e.getCause();
                    if (cause instanceof CancellationException ce) throw ce;
                    if (cause instanceof RuntimeException re) throw re;
                    if (cause instanceof Error err) throw err;
                    throw new RuntimeException(cause);
                }
            }
            completedNormally = true;
            return results;
        } finally {
            if (!completedNormally) {
                for (Future<T> future : futures) {
                    future.cancel(true);
                }
            }
        }
    }

    private static <T> T callUnchecked(Callable<T> task) {
        try {
            return task.call();
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
