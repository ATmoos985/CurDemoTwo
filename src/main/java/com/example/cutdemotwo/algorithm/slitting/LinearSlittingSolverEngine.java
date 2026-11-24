package com.example.cutdemotwo.algorithm.slitting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.api.ISlittingSolverEngine;
import com.example.cutdemotwo.algorithm.api.ComputationTimeout;
import com.example.cutdemotwo.algorithm.runtime.IsolatedProcessRunner;

import com.google.ortools.Loader;
import changyang.cut.apsmodule.generator.NewSolver.CuttingSolver;
import changyang.cut.apsmodule.service.*;
import changyang.cut.apsmodule.solver.kernel.*;
import changyang.cut.apsmodule.solver.kernel.execution.SolverExecutionContext;
import com.example.cutdemotwo.contracts.slitting.*;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;
import java.io.*;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/** Pure legacy-kernel adapter. Reuses warm isolated JVMs while enforcing hard kill on timeout/cancel. */
@Service
public class LinearSlittingSolverEngine implements ISlittingSolverEngine, AutoCloseable {
    private static final Logger log = LoggerFactory.getLogger(LinearSlittingSolverEngine.class);
    static final String DEFAULT_CHILD_XMX = "768m";
    static final int MAX_CHILD_THREADS = 8;
    static final int DEFAULT_MAX_IDLE_WORKERS = 2;
    static final long DEFAULT_IDLE_TTL_SECONDS = 120L;
    static final int DEFAULT_MAX_ACTIVE_WORKERS = 2;
    static final int STDERR_RING_CAPACITY_BYTES = 4096;
    private static final int MAX_WORKERS_LIMIT = 16;
    private static final String WORKER_FLAG = "--worker";
    private static final String WARM_WORKER_PROP = "cutdemo.slitting.warmWorker";
    private static final long WORKER_READY_TIMEOUT_MS = 15_000L;
    private static final JsonMapper JSON = JsonMapper.builder().build();

    private final String childXmx;
    private final int childThreads;
    private final int maxIdleWorkers;
    private final long idleTtlSeconds;
    private final long idleTtlNanos;
    private final int maxActiveWorkers;
    private final Semaphore activeWorkerPermits;
    private final ScheduledExecutorService idleReaper;
    private final ConcurrentLinkedDeque<WarmWorker> idleWorkers = new ConcurrentLinkedDeque<>();
    private final Set<WarmWorker> activeWorkers = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean closed = new AtomicBoolean(false);

    public LinearSlittingSolverEngine() {
        this(DEFAULT_CHILD_XMX, defaultChildThreads(), DEFAULT_MAX_IDLE_WORKERS, DEFAULT_IDLE_TTL_SECONDS, DEFAULT_MAX_ACTIVE_WORKERS);
    }

    public LinearSlittingSolverEngine(String childXmx) {
        this(childXmx, defaultChildThreads(), DEFAULT_MAX_IDLE_WORKERS, DEFAULT_IDLE_TTL_SECONDS, DEFAULT_MAX_ACTIVE_WORKERS);
    }

    public LinearSlittingSolverEngine(String childXmx, int childThreads) {
        this(childXmx, childThreads, DEFAULT_MAX_IDLE_WORKERS, DEFAULT_IDLE_TTL_SECONDS, DEFAULT_MAX_ACTIVE_WORKERS);
    }

    public LinearSlittingSolverEngine(String childXmx, int childThreads, int maxIdleWorkers, long idleTtlSeconds, int maxActiveWorkers) {
        this.childXmx = normalizeChildXmx(childXmx);
        this.childThreads = normalizeChildThreads(childThreads);
        this.maxIdleWorkers = normalizeMaxIdleWorkers(maxIdleWorkers);
        this.idleTtlSeconds = normalizeIdleTtlSeconds(idleTtlSeconds);
        this.idleTtlNanos = TimeUnit.SECONDS.toNanos(this.idleTtlSeconds);
        this.maxActiveWorkers = normalizeMaxActiveWorkers(maxActiveWorkers);
        this.activeWorkerPermits = new Semaphore(this.maxActiveWorkers, true);
        this.idleReaper = createIdleReaper(this.maxIdleWorkers, this.idleTtlSeconds);
        registerShutdownCleanup(this);
    }

    @Autowired
    public LinearSlittingSolverEngine(
            @Value("${cutdemo.slitting.child-xmx:" + DEFAULT_CHILD_XMX + "}") String childXmx,
            @Value("${cutdemo.slitting.child-threads:auto}") String childThreads,
            @Value("${cutdemo.slitting.max-idle-workers:" + DEFAULT_MAX_IDLE_WORKERS + "}") int maxIdleWorkers,
            @Value("${cutdemo.slitting.idle-ttl-seconds:" + DEFAULT_IDLE_TTL_SECONDS + "}") long idleTtlSeconds,
            @Value("${cutdemo.slitting.max-active-workers:" + DEFAULT_MAX_ACTIVE_WORKERS + "}") int maxActiveWorkers) {
        this(childXmx, normalizeChildThreads(childThreads), maxIdleWorkers, idleTtlSeconds, maxActiveWorkers);
    }

    private ScheduledExecutorService createIdleReaper(int maxIdle, long ttlSeconds) {
        if (maxIdle <= 0) {
            return null;
        }
        ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "slitting-idle-reaper");
            t.setDaemon(true);
            return t;
        });
        long periodMs = Math.max(250L, Math.min(10_000L, TimeUnit.SECONDS.toMillis(ttlSeconds) / 2));
        scheduler.scheduleWithFixedDelay(this::evictExpiredIdleWorkers, periodMs, periodMs, TimeUnit.MILLISECONDS);
        return scheduler;
    }

    static int normalizeMaxIdleWorkers(int raw) {
        if (raw < 0 || raw > MAX_WORKERS_LIMIT) {
            throw new IllegalArgumentException("无效的一维空闲子进程上限配置 cutdemo.slitting.max-idle-workers: " + raw);
        }
        return raw;
    }

    static long normalizeIdleTtlSeconds(long raw) {
        if (raw < 1L || raw > 86_400L) {
            throw new IllegalArgumentException("无效的一维空闲子进程存活时间配置 cutdemo.slitting.idle-ttl-seconds: " + raw);
        }
        return raw;
    }

    static int normalizeMaxActiveWorkers(int raw) {
        if (raw < 1 || raw > MAX_WORKERS_LIMIT) {
            throw new IllegalArgumentException("无效的一维并发活跃子进程上限配置 cutdemo.slitting.max-active-workers: " + raw);
        }
        return raw;
    }

    int maxIdleWorkers() { return maxIdleWorkers; }
    long idleTtlSeconds() { return idleTtlSeconds; }
    int maxActiveWorkers() { return maxActiveWorkers; }

    static int defaultChildThreads() {
        return defaultChildThreads(Runtime.getRuntime().availableProcessors());
    }

    static int defaultChildThreads(int availableProcessors) {
        return Math.max(1, Math.min(3, Math.max(1, availableProcessors) / 2));
    }

    static int normalizeChildThreads(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty() || "auto".equalsIgnoreCase(value)) {
            return defaultChildThreads();
        }
        int parsed;
        try {
            parsed = Integer.parseInt(value);
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException("无效的一维子进程线程上限配置 cutdemo.slitting.child-threads: " + raw, error);
        }
        return normalizeChildThreads(parsed);
    }

    static int normalizeChildThreads(int raw) {
        if (raw < 1 || raw > MAX_CHILD_THREADS) {
            throw new IllegalArgumentException("无效的一维子进程线程上限配置 cutdemo.slitting.child-threads: " + raw);
        }
        return raw;
    }

    static int resolveKernelParallelThreads() {
        String configured = System.getProperty("cutting.parallel.globalThreads");
        if (configured != null && !configured.isBlank()) {
            try {
                return Math.max(1, Math.min(MAX_CHILD_THREADS, Integer.parseInt(configured.trim())));
            } catch (NumberFormatException ignored) {
                // ignore malformed override and fall back to adaptive default
            }
        }
        return defaultChildThreads();
    }

    int childThreads() {
        return childThreads;
    }

    private static void registerShutdownCleanup(LinearSlittingSolverEngine engine) {
        WeakReference<LinearSlittingSolverEngine> ref = new WeakReference<>(engine);
        try {
            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                LinearSlittingSolverEngine target = ref.get();
                if (target != null) {
                    target.close();
                }
            }, "slitting-worker-pool-shutdown"));
        } catch (IllegalStateException ignored) {
            // JVM already shutting down
        }
    }

    static String normalizeChildXmx(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (!value.matches("([1-9][0-9]{1,4}[mM]|[1-9][0-9]{0,1}[gG])")) {
            throw new IllegalArgumentException("无效的一维子进程堆上限配置 cutdemo.slitting.child-xmx: " + raw);
        }
        return value;
    }

    @Override public String getEngineType(){return "ortools-1d";}
    @Override public boolean isAvailable(){return Files.isExecutable(javaExecutable());}
    private static Path javaExecutable() {
        String launcher = System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java";
        return Path.of(System.getProperty("java.home"), "bin", launcher);
    }

    @Override
    @PreDestroy
    public void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        if (idleReaper != null) {
            idleReaper.shutdownNow();
        }
        WarmWorker idle;
        while ((idle = idleWorkers.poll()) != null) {
            idle.shutdownQuietly();
        }
        for (WarmWorker active : List.copyOf(activeWorkers)) {
            active.destroyAndWait();
        }
        activeWorkers.clear();
    }

    int idleWorkerCount() {
        return idleWorkers.size();
    }

    int evictExpiredIdleWorkers() {
        if (closed.get() || idleWorkers.isEmpty()) {
            return 0;
        }
        long now = System.nanoTime();
        int evicted = 0;
        for (WarmWorker worker : idleWorkers) {
            boolean expired = !worker.isAlive() || (now - worker.lastReturnedNanos() >= idleTtlNanos);
            if (expired && idleWorkers.remove(worker)) {
                worker.shutdownQuietly();
                evicted++;
            }
        }
        return evicted;
    }

    @Override public SlittingResult solve(SlittingProblem problem) {
        SlittingValidation.validateProblem(problem);
        if (closed.get()) {
            throw new IllegalStateException("一维计算引擎已关闭");
        }
        Path directory = null;
        try {
            ComputationCancellation.check();
            directory = Files.createTempDirectory("cutdemo-slitting-");
            Path input = directory.resolve("input.json"), output = directory.resolve("output.json");
            Files.write(input, JSON.writeValueAsBytes(problem));

            long totalTimeoutNanos = TimeUnit.SECONDS.toNanos(Math.max(1, problem.timeLimitSeconds()));
            long deadlineNanos = System.nanoTime() + totalTimeoutNanos;
            String response = executeOnWarmWorker(input, output, problem.timeLimitSeconds(), deadlineNanos);

            if ("INVALID".equals(response)) {
                throw new SlittingValidation.ValidationException("INVALID_RESULT", "内核候选结果未通过独立验收，未发布结果");
            }
            if (!"OK".equals(response) || !Files.isRegularFile(output) || Files.size(output) > 8_388_608) {
                throw new IllegalStateException("一维计算进程失败或输出超限，response=" + response);
            }
            var result = JSON.readValue(Files.readAllBytes(output), SlittingResult.class);
            SlittingValidation.validateResult(problem, result);
            return result;
        } catch (IOException error) {
            throw new IllegalStateException("一维计算进程启动或结果读取失败", error);
        } finally {
            IsolatedProcessRunner.deleteTempDirectory(directory);
        }
    }

    private String executeOnWarmWorker(Path input, Path output, int timeLimitSeconds, long deadlineNanos) throws IOException {
        acquireActivePermit(deadlineNanos);
        try {
            for (int attempt = 0; attempt < 2; attempt++) {
                boolean reused = false;
                WarmWorker worker = pollAliveIdleWorker();
                if (worker != null) {
                    reused = true;
                } else {
                    worker = startWarmWorker(deadlineNanos);
                }
                activeWorkers.add(worker);
                boolean keepWarm = false;
                boolean abnormalExit = false;
                String response = null;
                try {
                    response = worker.solve(input, output, timeLimitSeconds, deadlineNanos);
                    keepWarm = ("OK".equals(response) || "INVALID".equals(response)) && worker.isAlive() && !closed.get();
                    if (!keepWarm && !"OK".equals(response) && !"INVALID".equals(response)) {
                        abnormalExit = true;
                    }
                    return response;
                } catch (IOException ioError) {
                    abnormalExit = true;
                    if (reused && attempt == 0) {
                        // 空闲复用的子进程若在等待期间意外退出，立即销毁并冷启动一个新实例重试一次。
                        continue;
                    }
                    throw ioError;
                } catch (ComputationTimeout timeout) {
                    abnormalExit = true;
                    throw timeout;
                } catch (RuntimeException runtimeError) {
                    if (!(runtimeError instanceof CancellationException)) {
                        abnormalExit = true;
                    }
                    throw runtimeError;
                } finally {
                    activeWorkers.remove(worker);
                    if (keepWarm) {
                        returnToPool(worker);
                    } else {
                        // 超时、取消或异常退出时立即阻塞强杀子进程树，确保 native 求解线程彻底释放。
                        worker.destroyAndWait();
                        if (abnormalExit) {
                            logWorkerDiagnostic("一维求解子进程异常结束", worker, response);
                        }
                    }
                }
            }
            throw new IllegalStateException("一维温热子进程重试失败");
        } finally {
            activeWorkerPermits.release();
        }
    }

    private void acquireActivePermit(long deadlineNanos) {
        while (true) {
            ComputationCancellation.check();
            if (closed.get()) {
                throw new IllegalStateException("一维计算引擎已关闭");
            }
            long remainingNanos = deadlineNanos - System.nanoTime();
            if (remainingNanos <= 0L) {
                throw new ComputationTimeout();
            }
            long waitMs = Math.min(
                    IsolatedProcessRunner.DEFAULT_POLL_MILLIS,
                    Math.max(1L, TimeUnit.NANOSECONDS.toMillis(remainingNanos)));
            try {
                if (activeWorkerPermits.tryAcquire(waitMs, TimeUnit.MILLISECONDS)) {
                    if (closed.get()) {
                        activeWorkerPermits.release();
                        throw new IllegalStateException("一维计算引擎已关闭");
                    }
                    return;
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new CancellationException("计算收到停止请求");
            }
        }
    }

    private WarmWorker pollAliveIdleWorker() {
        long now = System.nanoTime();
        WarmWorker worker;
        while ((worker = idleWorkers.pollFirst()) != null) {
            if (worker.isAlive() && (now - worker.lastReturnedNanos() < idleTtlNanos)) {
                return worker;
            }
            worker.shutdownQuietly();
        }
        return null;
    }

    private void returnToPool(WarmWorker worker) {
        if (closed.get() || maxIdleWorkers <= 0 || !worker.isAlive() || idleWorkers.size() >= maxIdleWorkers) {
            worker.shutdownQuietly();
            return;
        }
        worker.markReturned();
        idleWorkers.offerFirst(worker);
        while (idleWorkers.size() > maxIdleWorkers) {
            WarmWorker extra = idleWorkers.pollLast();
            if (extra != null) {
                extra.shutdownQuietly();
            }
        }
        if (closed.get()) {
            WarmWorker drained;
            while ((drained = idleWorkers.poll()) != null) {
                drained.shutdownQuietly();
            }
        }
    }

    private WarmWorker startWarmWorker(long requestDeadlineNanos) throws IOException {
        ComputationCancellation.check();
        var cmd = workerCommand(ProcessHandle.current().pid(), childXmx, childThreads);
        ProcessBuilder pb = new ProcessBuilder(cmd);
        Process process = pb.start();
        WarmWorker worker = new WarmWorker(process);
        long readyDeadlineNanos = Math.min(
                requestDeadlineNanos,
                System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(WORKER_READY_TIMEOUT_MS));
        try {
            String ready = worker.awaitLine(readyDeadlineNanos);
            if (!"READY".equals(ready)) {
                throw new IOException("一维常驻子进程握手失败: " + ready);
            }
            return worker;
        } catch (RuntimeException | IOException error) {
            worker.destroyAndWait();
            if (!(error instanceof CancellationException)) {
                logWorkerDiagnostic("一维常驻子进程启动/握手失败", worker, null);
            }
            throw error;
        }
    }

    private static void logWorkerDiagnostic(String reason, WarmWorker worker, String response) {
        String stderrTail = worker.stderrTail();
        int exitCode = worker.exitCodeOrMinusOne();
        if (!stderrTail.isEmpty()) {
            log.warn("{} (pid={}, exitCode={}, response={})，stderr 尾部 4KB：\n{}",
                    reason, worker.pid(), exitCode, response, stderrTail);
        } else {
            log.warn("{} (pid={}, exitCode={}, response={})，子进程无 stderr 输出",
                    reason, worker.pid(), exitCode, response);
        }
    }

    static List<String> command(Path input, Path output, long parentPid) throws IOException {
        return command(input, output, parentPid, DEFAULT_CHILD_XMX, defaultChildThreads());
    }

    static List<String> command(Path input, Path output, long parentPid, String childXmx) throws IOException {
        return command(input, output, parentPid, childXmx, defaultChildThreads());
    }

    static List<String> command(Path input, Path output, long parentPid, String childXmx, int childThreads) throws IOException {
        var args = baseJvmCommand(childXmx, childThreads, false);
        args.addAll(List.of(input.toString(), output.toString(), Long.toString(parentPid)));
        return args;
    }

    static List<String> workerCommand(long parentPid, String childXmx) throws IOException {
        return workerCommand(parentPid, childXmx, defaultChildThreads());
    }

    static List<String> workerCommand(long parentPid, String childXmx, int childThreads) throws IOException {
        var args = baseJvmCommand(childXmx, childThreads, true);
        args.addAll(List.of(WORKER_FLAG, Long.toString(parentPid)));
        return args;
    }

    private static List<String> baseJvmCommand(String childXmx, int childThreads, boolean warmWorker) throws IOException {
        int normalizedThreads = normalizeChildThreads(childThreads);
        int activeProcessors = Math.max(2, normalizedThreads);
        String cp = System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
        var args = new ArrayList<>(List.of(
                javaExecutable().toString(),
                "-Xmx" + normalizeChildXmx(childXmx),
                "-XX:ActiveProcessorCount=" + activeProcessors,
                "-Dcutting.parallel.globalThreads=" + normalizedThreads));
        if (warmWorker) {
            args.add("-D" + WARM_WORKER_PROP + "=true");
        }
        boolean boot = false;
        if (!cp.contains(java.io.File.pathSeparator) && Files.isRegularFile(Path.of(cp))) {
            try (var jar = new java.util.zip.ZipFile(cp)) {
                boot = jar.getEntry("BOOT-INF/classes/") != null;
            }
        }
        if (boot) {
            args.add("-Dloader.main=" + LinearSlittingSolverEngine.class.getName());
        }
        args.addAll(List.of(
                "-cp",
                cp,
                boot ? "org.springframework.boot.loader.launch.PropertiesLauncher"
                        : LinearSlittingSolverEngine.class.getName()));
        return args;
    }

    /** Child entry point deliberately starts no HTTP server, inventory service or Spring context. */
    public static void main(String[] args) throws Exception {
        if (args.length >= 2 && WORKER_FLAG.equals(args[0])) {
            runWorkerLoop(Long.parseLong(args[1]));
            return;
        }
        var p = JSON.readValue(Files.readAllBytes(Path.of(args[0])), SlittingProblem.class);
        SlittingValidation.validateProblem(p);
        long parent = Long.parseLong(args[2]), deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(p.timeLimitSeconds());
        var watchdog = new Thread(() -> {
            for (;;) {
                if (System.nanoTime() >= deadline || ProcessHandle.of(parent).filter(ProcessHandle::isAlive).isEmpty()) {
                    Runtime.getRuntime().halt(124);
                }
                try { Thread.sleep(100); } catch (InterruptedException ignored) { return; }
            }
        }, "slitting-parent-watch");
        watchdog.setDaemon(true);
        watchdog.start();
        try {
            var result = solveKernel(p);
            Files.write(Path.of(args[1]), JSON.writeValueAsBytes(result));
        } catch (SlittingValidation.ValidationException rejected) {
            System.exit(2);
        }
        System.exit(0);
    }

    private static void runWorkerLoop(long parentPid) throws Exception {
        // 保留原始 stdout 仅用于协议通信，将常规 stdout 重定向到 stderr（已被父进程丢弃），防止日志污染协议流。
        PrintStream protocolOut = System.out;
        System.setOut(System.err);

        AtomicLong requestDeadlineNanos = new AtomicLong(0L);
        Thread watchdog = new Thread(() -> {
            for (;;) {
                long deadline = requestDeadlineNanos.get();
                if ((deadline > 0L && System.nanoTime() >= deadline)
                        || ProcessHandle.of(parentPid).filter(ProcessHandle::isAlive).isEmpty()) {
                    Runtime.getRuntime().halt(124);
                }
                try {
                    Thread.sleep(50);
                } catch (InterruptedException ignored) {
                    return;
                }
            }
        }, "slitting-worker-watch");
        watchdog.setDaemon(true);
        watchdog.start();

        // 预先加载 OR-Tools native 库，消除首次求解冷启动延迟。
        Loader.loadNativeLibraries();
        protocolOut.println("READY");
        protocolOut.flush();

        var decoder = Base64.getDecoder();
        try (BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = in.readLine()) != null) {
                if ("QUIT".equals(line)) {
                    break;
                }
                if (!line.startsWith("SOLVE ")) {
                    protocolOut.println("ERROR");
                    protocolOut.flush();
                    continue;
                }
                String[] parts = line.split(" ");
                if (parts.length != 4) {
                    protocolOut.println("ERROR");
                    protocolOut.flush();
                    continue;
                }
                Path inputPath = Path.of(new String(decoder.decode(parts[1]), StandardCharsets.UTF_8));
                Path outputPath = Path.of(new String(decoder.decode(parts[2]), StandardCharsets.UTF_8));
                int timeLimitSeconds = Integer.parseInt(parts[3]);
                requestDeadlineNanos.set(System.nanoTime() + TimeUnit.SECONDS.toNanos(Math.max(1, timeLimitSeconds)));
                try {
                    SlittingProblem problem = JSON.readValue(Files.readAllBytes(inputPath), SlittingProblem.class);
                    SlittingValidation.validateProblem(problem);
                    SlittingResult result = solveKernel(problem);
                    Files.write(outputPath, JSON.writeValueAsBytes(result));
                    protocolOut.println("OK");
                } catch (SlittingValidation.ValidationException rejected) {
                    protocolOut.println("INVALID");
                } catch (Throwable err) {
                    protocolOut.println("ERROR");
                } finally {
                    requestDeadlineNanos.set(0L);
                    protocolOut.flush();
                }
            }
        }
        System.exit(0);
    }

    static final class BoundedStderrBuffer {
        private final byte[] ring;
        private int writePos;
        private int count;

        BoundedStderrBuffer(int capacity) {
            this.ring = new byte[Math.max(64, capacity)];
        }

        synchronized void append(byte[] data, int offset, int length) {
            if (length <= 0) return;
            if (length >= ring.length) {
                System.arraycopy(data, offset + length - ring.length, ring, 0, ring.length);
                writePos = 0;
                count = ring.length;
                return;
            }
            int firstPart = Math.min(length, ring.length - writePos);
            System.arraycopy(data, offset, ring, writePos, firstPart);
            int remaining = length - firstPart;
            if (remaining > 0) {
                System.arraycopy(data, offset + firstPart, ring, 0, remaining);
            }
            writePos = (writePos + length) % ring.length;
            count = Math.min(ring.length, count + length);
        }

        synchronized void reset() {
            writePos = 0;
            count = 0;
        }

        synchronized String snapshotUtf8() {
            if (count == 0) return "";
            byte[] ordered = new byte[count];
            int start = (writePos - count + ring.length) % ring.length;
            int firstPart = Math.min(count, ring.length - start);
            System.arraycopy(ring, start, ordered, 0, firstPart);
            int remaining = count - firstPart;
            if (remaining > 0) {
                System.arraycopy(ring, 0, ordered, firstPart, remaining);
            }
            return new String(ordered, StandardCharsets.UTF_8).trim();
        }
    }

    static final class WarmWorker {
        private final Process process;
        private final BufferedWriter stdin;
        private final BufferedReader stdout;
        private final InputStream stderr;
        private final ExecutorService readerExecutor;
        private final BoundedStderrBuffer stderrBuffer;
        private final Thread stderrDrainThread;
        private volatile long lastReturnedNanos = System.nanoTime();

        WarmWorker(Process process) {
            this.process = process;
            this.stdin = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
            this.stdout = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
            this.stderr = process.getErrorStream();
            this.stderrBuffer = new BoundedStderrBuffer(STDERR_RING_CAPACITY_BYTES);
            this.readerExecutor = Executors.newSingleThreadExecutor(runnable -> {
                Thread t = new Thread(runnable, "slitting-worker-io-" + process.pid());
                t.setDaemon(true);
                return t;
            });
            this.stderrDrainThread = new Thread(this::drainStderr, "slitting-worker-err-" + process.pid());
            this.stderrDrainThread.setDaemon(true);
            this.stderrDrainThread.start();
        }

        private void drainStderr() {
            byte[] chunk = new byte[1024];
            try {
                int n;
                while ((n = stderr.read(chunk)) != -1) {
                    stderrBuffer.append(chunk, 0, n);
                }
            } catch (IOException ignored) {
                // 子进程退出关闭管道时自然结束读取。
            }
        }

        long pid() {
            return process.pid();
        }

        int exitCodeOrMinusOne() {
            return process.isAlive() ? -1 : process.exitValue();
        }

        String stderrTail() {
            return stderrBuffer.snapshotUtf8();
        }

        void markReturned() {
            this.lastReturnedNanos = System.nanoTime();
        }

        long lastReturnedNanos() {
            return lastReturnedNanos;
        }

        boolean isAlive() {
            return process.isAlive();
        }

        String solve(Path input, Path output, int timeLimitSeconds, long deadlineNanos) throws IOException {
            stderrBuffer.reset();
            var encoder = Base64.getEncoder();
            String commandLine = "SOLVE "
                    + encoder.encodeToString(input.toString().getBytes(StandardCharsets.UTF_8))
                    + " "
                    + encoder.encodeToString(output.toString().getBytes(StandardCharsets.UTF_8))
                    + " "
                    + timeLimitSeconds;
            stdin.write(commandLine);
            stdin.newLine();
            stdin.flush();
            return awaitLine(deadlineNanos);
        }

        String awaitLine(long deadlineNanos) throws IOException {
            Future<String> future = readerExecutor.submit(stdout::readLine);
            try {
                while (true) {
                    ComputationCancellation.check();
                    long remainingNanos = deadlineNanos - System.nanoTime();
                    if (remainingNanos <= 0L) {
                        throw new ComputationTimeout();
                    }
                    long waitMs = Math.min(
                            IsolatedProcessRunner.DEFAULT_POLL_MILLIS,
                            Math.max(1L, TimeUnit.NANOSECONDS.toMillis(remainingNanos)));
                    try {
                        String line = future.get(waitMs, TimeUnit.MILLISECONDS);
                        if (line == null) {
                            int exit = process.isAlive() ? -1 : process.exitValue();
                            if (exit == 124) {
                                throw new ComputationTimeout();
                            }
                            throw new IOException("一维常驻子进程提前关闭，exit=" + exit);
                        }
                        return line;
                    } catch (TimeoutException ignored) {
                        if (!process.isAlive()) {
                            int exit = process.exitValue();
                            if (exit == 124) {
                                throw new ComputationTimeout();
                            }
                            throw new IOException("一维常驻子进程意外退出，exit=" + exit);
                        }
                    }
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new CancellationException("计算收到停止请求");
            } catch (ExecutionException execError) {
                if (execError.getCause() instanceof IOException io) {
                    throw io;
                }
                throw new IOException("读取一维常驻子进程响应失败", execError.getCause());
            } finally {
                future.cancel(true);
            }
        }

        void shutdownQuietly() {
            try {
                if (process.isAlive()) {
                    stdin.write("QUIT");
                    stdin.newLine();
                    stdin.flush();
                    process.waitFor(500, TimeUnit.MILLISECONDS);
                }
            } catch (Exception ignored) {
            } finally {
                destroyAndWait();
            }
        }

        void destroyAndWait() {
            boolean interrupted = Thread.interrupted();
            try {
                // 先销毁子进程树切断 stdout/stderr 管道，使阻塞在 BufferedReader.readLine() 的读取线程立刻收到 EOF 释放内部锁，避免 close() 死锁。
                IsolatedProcessRunner.destroyProcessTree(process, -1L);
                readerExecutor.shutdownNow();
                try {
                    readerExecutor.awaitTermination(1, TimeUnit.SECONDS);
                } catch (InterruptedException again) {
                    interrupted = true;
                }
                try {
                    stderrDrainThread.join(500L);
                } catch (InterruptedException again) {
                    interrupted = true;
                }
                try { stdin.close(); } catch (Exception ignored) {}
                try { stdout.close(); } catch (Exception ignored) {}
                try { stderr.close(); } catch (Exception ignored) {}
            } finally {
                if (interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
        }
    }
    static SlittingResult solveKernel(SlittingProblem p) {
        SlittingValidation.validateProblem(p);
        long totalMs = p.timeLimitSeconds() * 1000L;
        boolean warmWorker = Boolean.getBoolean(WARM_WORKER_PROP);
        long startupMarginMs = warmWorker
                ? Math.min(3_000L, Math.max(1_000L, totalMs / 15))
                : Math.min(4_500L, Math.max(1_500L, totalMs / 4));
        long internalBudgetMs = Math.max(500L, totalMs - startupMarginMs);

        // 当启用单车刀数上限、危险细边禁区、切缝损耗或多宽母卷池时，切换至严格物理约束与多宽联合求解器；
        // 未启用时完整保留原有高性能列生成 + LNS 内核，并在输出端统一执行换刀 TSP 排序。
        boolean requiresConstrainedSolver = p.maxKnives() != null
                || p.hasForbiddenNarrowEdge()
                || p.effectiveKerfMm() > 0
                || p.hasCandidateRollWidths();
        if (requiresConstrainedSolver) {
            return ConstrainedSlittingSolver.solve(p, internalBudgetMs);
        }

        boolean fast = "FAST".equals(p.profile());
        var config = new SolverConfig(p.minWidthMm(), p.maxWidthMm(), p.widthStepMm(), p.motherWidthMm());
        config.setMode(p.minWidthMm() == p.maxWidthMm() ? "fixed" : "variable");

        long stageLimitMs = p.stageTimeLimitMs() != null ? p.stageTimeLimitMs() : 120_000L;
        // 隔离进程内多阶段串行共享总时限：精修模式须先保底与 FAST 同等强度的 A 层基线（避免截断倒挂），
        // 再将剩余预算用于多候选选型与 B 层受控 LNS 压缩序号组。
        long effectiveStageMs = fast
                ? Math.max(1_000L, Math.min(stageLimitMs, internalBudgetMs))
                : Math.max(2_000L, Math.min(stageLimitMs, Math.min(internalBudgetMs, Math.max(25_000L, internalBudgetMs / 3))));
        long effectiveStage4Ms = fast
                ? Math.max(1_000L, Math.min(30_000L, effectiveStageMs / 2))
                : Math.max(1_500L, Math.min(15_000L, effectiveStageMs / 2));
        long effectiveFastBudgetMs = fast
                ? internalBudgetMs
                : Math.min(internalBudgetMs, Math.max(effectiveStageMs, internalBudgetMs / 2));

        config.setTotalOverCap(p.totalOverCap());
        config.setTimeoutMs(effectiveStageMs);
        config.setNewSolverStage4TimeLimit(effectiveStage4Ms);
        config.setUseNewSolver(true);
        config.setNewSolverTopK(p.topK() != null ? p.topK() : 3);
        config.setMaxIterations(p.maxIterations() != null ? p.maxIterations() : 300);
        config.setNewSolverMaxPatterns(p.maxPatterns() != null ? p.maxPatterns() : 800);
        int requestedDistinct = p.maxDistinctWidths() != null ? p.maxDistinctWidths() : 4;
        // 保持 QUALITY 与 FAST 相同的列生成规格上限，避免擅自放大组合空间导致短时限内 SCIP 收敛劣化。
        config.setNewSolverMaxDistinctWidths(requestedDistinct);
        if (p.useOptimizedAssignment() != null) {
            config.setNewSolverUseOptimizedAssignment(p.useOptimizedAssignment());
        }
        if (p.underPenalty() != null) {
            config.setNewSolverUnderPenalty(p.underPenalty());
        }
        if (p.seqGroupAlpha() != null) {
            config.setNewSolverSeqGroupAlpha(p.seqGroupAlpha());
        }
        if (p.seqGroupBeta() != null) {
            config.setNewSolverSeqGroupBeta(p.seqGroupBeta());
        }

        var items = new ArrayList<SolverOrderItem>();
        long lengthUnit = lengthUnitMm(p);
        for (var o : p.orders()) {
            var item = new SolverOrderItem();
            item.setMessageText(o.id());
            item.setWidth(o.widthMm());
            item.setDemand(o.quantity());
            item.setLength(Math.toIntExact(o.lengthMm() / lengthUnit));
            item.setSurfaceTreatment(o.surfaceTreatment());
            item.setGroupKey(item.getLength() + "m+" + o.surfaceTreatment());
            items.add(item);
        }

        // 精修模式默认自动启用受控 LNS 压缩序号组（仅当请求显式设置 lnsEnabled=false 时关闭）。
        boolean enableLns = !fast && !Boolean.FALSE.equals(p.lnsEnabled());
        int parallelThreads = resolveKernelParallelThreads();
        boolean parallelEnabled = !fast && parallelThreads > 1;
        var options = new HashMap<String, String>();
        options.put("cutting.fast.preview", Boolean.toString(fast));
        options.put("cutting.quality", Boolean.toString(!fast));
        options.put("cutting.quality.legacyPipeline", "false");
        options.put("cutting.fast.budgetMs", Long.toString(effectiveFastBudgetMs));
        options.put("cutting.quality.budgetMs", Long.toString(internalBudgetMs));
        options.put("cutting.aLayerParityPenalties", fast ? "0" : "0,0.1");
        options.put("cutting.aLayerAlignmentLambdas", "0");
        options.put("cutting.nestedWidthCandidateSteps", "0");
        options.put("cutting.candidateOrders", "1");
        options.put("cutting.spr.enabled", "false");
        options.put("cutting.lns.enabled", Boolean.toString(enableLns));
        options.put("cutting.lns.enrichPatterns", "false");
        options.put("cutting.parallel.aLayer.enabled", Boolean.toString(parallelEnabled));
        options.put("cutting.parallel.candidates.enabled", Boolean.toString(parallelEnabled));
        options.put("cutting.parallel.aLayer.threads", Integer.toString(parallelThreads));
        options.put("cutting.parallel.candidates.threads", Integer.toString(parallelThreads));
        // 多候选并行时 CuttingSolver 会自动覆盖 cutting.lns.parallel=false 防止嵌套并发；
        // 当 B 层经主导预剪枝/去重后仅剩 1 个候选时，由 LNS 内部按受控线程数确定性并行求解邻域。
        options.put("cutting.lns.parallel", Boolean.toString(parallelEnabled && enableLns));
        options.put("cutting.lns.parallelism", Integer.toString(parallelThreads));
        for (String key : List.of(
                "cutting.phase2.enabled",
                "cutting.demandPeak.enabled",
                "cutting.demandPeak.smallPolish.enabled",
                "cutting.parallel.sprCandidates.enabled",
                "cutting.spr.parallel",
                "cutting.portfolio.enabled")) {
            options.put(key, "false");
        }
        var raw = new CurrentNewSolverKernelAdapter(new CuttingSolver())
                .solve(SolverKernelRequest.from(items, config, SolverExecutionContext.of(options)));
        if (!Set.of(SolverKernelStatus.SUCCEEDED, SolverKernelStatus.FEASIBLE, SolverKernelStatus.OPTIMAL).contains(raw.status()))
            throw new IllegalStateException("内核未返回候选结果：" + raw.status());
        return convert(p, raw.instructions());
    }
    // 内核按整数长度分组并透传；共用精确尺度，不改变整米请求原有编码，不舍入非整米长度。
    private static long lengthUnitMm(SlittingProblem p) {
        long unit=1000;
        for(var order:p.orders()) {
            long value=order.lengthMm();
            while(value!=0) {long remainder=unit%value;unit=value;value=remainder;}
        }
        return unit;
    }
    static SlittingResult convert(SlittingProblem p,List<CuttingInstruction> instructions) {
        var orders=new LinkedHashMap<String,SlittingProblem.Order>();p.orders().forEach(o->orders.put(o.id(),o));
        var patterns=new ArrayList<SlittingResult.Pattern>();var counts=new HashMap<String,Integer>();
        long mother=0,usable=0,piece=0;
        long lengthUnit=lengthUnitMm(p);
        for(var i:instructions) {
            var allocations=new LinkedHashMap<String,Integer>();
            for(var a:i.getStationAssignments()) {
                var o=orders.get(a.getMessageText());
                if(o==null || a.getWidth()!=o.widthMm())throw new SlittingValidation.ValidationException("INVALID_RESULT","内核订单身份或工位宽度不匹配");
                allocations.merge(o.id(),1,Math::addExact);counts.merge(o.id(),1,Math::addExact);
            }
            var stations=i.getSubRolls().entrySet().stream().sorted(Map.Entry.comparingByKey())
                    .map(e->new SlittingResult.Station(e.getKey(),e.getValue())).toList();
            int width=Math.toIntExact(stations.stream().mapToLong(s->Math.multiplyExact((long)s.widthMm(),s.countPerRepetition())).sum());
            long length=Math.multiplyExact((long)i.getLength(),lengthUnit);
            patterns.add(new SlittingResult.Pattern("PAT-"+(patterns.size()+1),i.getRollWidth(),width,length,
                    i.getSurfaceTreatment(),i.getUsageCount(),stations,
                    allocations.entrySet().stream().map(e->new SlittingResult.Allocation(e.getKey(),e.getValue())).toList()));
            long repeated=Math.multiplyExact(length,i.getUsageCount());
            mother=Math.addExact(mother,Math.multiplyExact((long)p.motherWidthMm(),repeated));
            usable=Math.addExact(usable,Math.multiplyExact((long)p.motherWidthMm()-p.leftTrimMm()-p.rightTrimMm(),repeated));
            piece=Math.addExact(piece,Math.multiplyExact((long)width,repeated));
        }
        var knifeOptimized = KnifeSetupSequenceOptimizer.optimize(patterns, p.leftTrimMm(), p.effectiveKerfMm());
        var orderedPatterns = ConstrainedSlittingSolver.renumberPatterns(knifeOptimized.orderedPatterns());
        var fulfillment=p.orders().stream().map(o->{int n=counts.getOrDefault(o.id(),0);return new SlittingResult.Fulfillment(
                o.id(),o.quantity(),n,Math.max(0,o.quantity()-n),Math.max(0,n-o.quantity()));}).toList();
        var result=new SlittingResult("1","mm","ortools-1d","newsolver-ortools-9.10",orderedPatterns.isEmpty()?"NO_SOLUTION_FOUND":"FEASIBLE",false,
                orderedPatterns,fulfillment,piece,mother,usable,fulfillment.stream().mapToInt(SlittingResult.Fulfillment::overproduced).sum(),
                knifeOptimized.estimatedKnifeChanges(),knifeOptimized.knifeChangesSaved());
        SlittingValidation.validateResult(p,result);return result;
    }
}
