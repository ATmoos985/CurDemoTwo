package com.example.cutdemotwo.algorithm.runtime;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.concurrent.CancellationException;
import java.util.concurrent.TimeUnit;

/**
 * 外部求解进程统一执行器。
 * 封装进程启动、短周期协作取消轮询、超时控制、进程树强杀及临时目录安全清理。
 */
public final class IsolatedProcessRunner {
    private static final Logger log = LoggerFactory.getLogger(IsolatedProcessRunner.class);
    public static final long DEFAULT_POLL_MILLIS = 50L;
    private static final long DEFAULT_KILL_WAIT_MILLIS = 2_000L;

    private IsolatedProcessRunner() {}

    public record RunResult(int exitCode, boolean timedOut) {}

    public static RunResult run(ProcessBuilder processBuilder, long timeoutMillis) throws IOException {
        return run(processBuilder, timeoutMillis, DEFAULT_POLL_MILLIS, false);
    }

    public static RunResult run(ProcessBuilder processBuilder, long timeoutMillis, long pollMillis) throws IOException {
        return run(processBuilder, timeoutMillis, pollMillis, false);
    }

    /**
     * 执行外部进程并在等待期间以短周期轮询 {@link ComputationCancellation#check()}。
     *
     * @param waitUntilTerminatedOnKill 若为 true，强杀后阻塞等待直到子进程彻底退出（用于释放受限算力许可）
     */
    public static RunResult run(ProcessBuilder processBuilder,
                                long timeoutMillis,
                                long pollMillis,
                                boolean waitUntilTerminatedOnKill) throws IOException {
        ComputationCancellation.check();
        long effectiveTimeoutMs = Math.max(1L, timeoutMillis);
        long effectivePollMs = Math.max(10L, pollMillis);
        Process process = processBuilder.start();
        try {
            long deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(effectiveTimeoutMs);
            while (true) {
                ComputationCancellation.check();
                long remainingNanos = deadlineNanos - System.nanoTime();
                if (remainingNanos <= 0L) {
                    if (!process.isAlive()) {
                        return new RunResult(process.exitValue(), false);
                    }
                    return new RunResult(-1, true);
                }
                long waitMs = Math.min(effectivePollMs, Math.max(1L, TimeUnit.NANOSECONDS.toMillis(remainingNanos)));
                try {
                    if (process.waitFor(waitMs, TimeUnit.MILLISECONDS)) {
                        return new RunResult(process.exitValue(), false);
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new CancellationException("计算收到停止请求");
                }
            }
        } finally {
            if (process.isAlive()) {
                destroyProcessTree(process, waitUntilTerminatedOnKill ? -1L : DEFAULT_KILL_WAIT_MILLIS);
            }
        }
    }

    /**
     * 强杀进程及其全部后代进程，并按策略等待退出；始终保留调用线程的中断标志。
     *
     * @param waitMillis 小于 0 表示阻塞等待直至退出；否则最多等待指定毫秒数
     */
    public static void destroyProcessTree(Process process, long waitMillis) {
        if (process == null || !process.isAlive()) {
            return;
        }
        boolean interrupted = Thread.interrupted();
        try {
            process.descendants().forEach(ProcessHandle::destroyForcibly);
            process.destroyForcibly();
            if (waitMillis < 0L) {
                while (true) {
                    try {
                        process.waitFor();
                        break;
                    } catch (InterruptedException again) {
                        interrupted = true;
                    }
                }
            } else if (waitMillis > 0L) {
                try {
                    process.waitFor(waitMillis, TimeUnit.MILLISECONDS);
                } catch (InterruptedException again) {
                    interrupted = true;
                }
            }
        } finally {
            if (interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /**
     * 安全清理单次调用创建的临时目录（{@code Files.walk} 默认不跟随符号链接）。
     */
    public static void deleteTempDirectory(Path directory) {
        if (directory == null) {
            return;
        }
        try (var files = Files.walk(directory)) {
            for (Path path : files.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(path);
            }
        } catch (IOException cleanup) {
            log.warn("Unable to clean solver temporary directory {}", directory, cleanup);
        }
    }
}
