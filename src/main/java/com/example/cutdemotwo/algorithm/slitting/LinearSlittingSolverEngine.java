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
    static final String DEFAULT_CHILD_XMX = "768m";
    private static final String WORKER_FLAG = "--worker";
    private static final String WARM_WORKER_PROP = "cutdemo.slitting.warmWorker";
    private static final int MAX_IDLE_WORKERS = 2;
    private static final long WORKER_READY_TIMEOUT_MS = 15_000L;
    private static final JsonMapper JSON = JsonMapper.builder().build();

    private final String childXmx;
    private final ConcurrentLinkedDeque<WarmWorker> idleWorkers = new ConcurrentLinkedDeque<>();
    private final Set<WarmWorker> activeWorkers = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean closed = new AtomicBoolean(false);

    public LinearSlittingSolverEngine() {
        this(DEFAULT_CHILD_XMX);
    }

    @Autowired
    public LinearSlittingSolverEngine(@Value("${cutdemo.slitting.child-xmx:" + DEFAULT_CHILD_XMX + "}") String childXmx) {
        this.childXmx = normalizeChildXmx(childXmx);
        registerShutdownCleanup(this);
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
        if (!value.matches("[1-9][0-9]{1,4}[mMgG]")) {
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
            try {
                String response = worker.solve(input, output, timeLimitSeconds, deadlineNanos);
                keepWarm = ("OK".equals(response) || "INVALID".equals(response)) && worker.isAlive() && !closed.get();
                return response;
            } catch (IOException ioError) {
                if (reused && attempt == 0) {
                    // 空闲复用的子进程若在等待期间意外退出，立即销毁并冷启动一个新实例重试一次。
                    continue;
                }
                throw ioError;
            } finally {
                activeWorkers.remove(worker);
                if (keepWarm) {
                    returnToPool(worker);
                } else {
                    // 超时、取消或异常退出时立即阻塞强杀子进程树，确保 native 求解线程彻底释放。
                    worker.destroyAndWait();
                }
            }
        }
        throw new IllegalStateException("一维温热子进程重试失败");
    }

    private WarmWorker pollAliveIdleWorker() {
        WarmWorker worker;
        while ((worker = idleWorkers.pollFirst()) != null) {
            if (worker.isAlive()) {
                return worker;
            }
            worker.destroyAndWait();
        }
        return null;
    }

    private void returnToPool(WarmWorker worker) {
        if (closed.get() || !worker.isAlive() || idleWorkers.size() >= MAX_IDLE_WORKERS) {
            worker.shutdownQuietly();
            return;
        }
        idleWorkers.offerFirst(worker);
        if (closed.get()) {
            WarmWorker drained;
            while ((drained = idleWorkers.poll()) != null) {
                drained.shutdownQuietly();
            }
        }
    }

    private WarmWorker startWarmWorker(long requestDeadlineNanos) throws IOException {
        ComputationCancellation.check();
        var cmd = workerCommand(ProcessHandle.current().pid(), childXmx);
        ProcessBuilder pb = new ProcessBuilder(cmd)
                .redirectError(ProcessBuilder.Redirect.DISCARD);
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
            throw error;
        }
    }

    static List<String> command(Path input, Path output, long parentPid) throws IOException {
        return command(input, output, parentPid, DEFAULT_CHILD_XMX);
    }

    static List<String> command(Path input, Path output, long parentPid, String childXmx) throws IOException {
        var args = baseJvmCommand(childXmx, false);
        args.addAll(List.of(input.toString(), output.toString(), Long.toString(parentPid)));
        return args;
    }

    static List<String> workerCommand(long parentPid, String childXmx) throws IOException {
        var args = baseJvmCommand(childXmx, true);
        args.addAll(List.of(WORKER_FLAG, Long.toString(parentPid)));
        return args;
    }

    private static List<String> baseJvmCommand(String childXmx, boolean warmWorker) throws IOException {
        String cp = System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
        var args = new ArrayList<>(List.of(
                javaExecutable().toString(),
                "-Xmx" + normalizeChildXmx(childXmx),
                "-XX:ActiveProcessorCount=2",
                "-Dcutting.parallel.globalThreads=1"));
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

    private static final class WarmWorker {
        private final Process process;
        private final BufferedWriter stdin;
        private final BufferedReader stdout;
        private final ExecutorService readerExecutor;

        WarmWorker(Process process) {
            this.process = process;
            this.stdin = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
            this.stdout = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
            this.readerExecutor = Executors.newSingleThreadExecutor(runnable -> {
                Thread t = new Thread(runnable, "slitting-worker-io-" + process.pid());
                t.setDaemon(true);
                return t;
            });
        }

        boolean isAlive() {
            return process.isAlive();
        }

        String solve(Path input, Path output, int timeLimitSeconds, long deadlineNanos) throws IOException {
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
            try { stdin.close(); } catch (Exception ignored) {}
            try { stdout.close(); } catch (Exception ignored) {}
            IsolatedProcessRunner.destroyProcessTree(process, -1L);
            readerExecutor.shutdownNow();
        }
    }
    static SlittingResult solveKernel(SlittingProblem p) {
        SlittingValidation.validateProblem(p);
        boolean fast = "FAST".equals(p.profile());
        var config = new SolverConfig(p.minWidthMm(), p.maxWidthMm(), p.widthStepMm(), p.motherWidthMm());
        config.setMode(p.minWidthMm() == p.maxWidthMm() ? "fixed" : "variable");

        long totalMs = p.timeLimitSeconds() * 1000L;
        boolean warmWorker = Boolean.getBoolean(WARM_WORKER_PROP);
        long startupMarginMs = warmWorker
                ? Math.min(3_000L, Math.max(1_000L, totalMs / 15))
                : Math.min(4_500L, Math.max(1_500L, totalMs / 4));
        long internalBudgetMs = Math.max(500L, totalMs - startupMarginMs);
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
        for (String key : List.of(
                "cutting.phase2.enabled",
                "cutting.demandPeak.enabled",
                "cutting.demandPeak.smallPolish.enabled",
                "cutting.parallel.aLayer.enabled",
                "cutting.parallel.candidates.enabled",
                "cutting.parallel.sprCandidates.enabled",
                "cutting.spr.parallel",
                "cutting.lns.parallel",
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
        var fulfillment=p.orders().stream().map(o->{int n=counts.getOrDefault(o.id(),0);return new SlittingResult.Fulfillment(
                o.id(),o.quantity(),n,Math.max(0,o.quantity()-n),Math.max(0,n-o.quantity()));}).toList();
        var result=new SlittingResult("1","mm","ortools-1d","newsolver-ortools-9.10",patterns.isEmpty()?"NO_SOLUTION_FOUND":"FEASIBLE",false,
                patterns,fulfillment,piece,mother,usable,fulfillment.stream().mapToInt(SlittingResult.Fulfillment::overproduced).sum());
        SlittingValidation.validateResult(p,result);return result;
    }
}
