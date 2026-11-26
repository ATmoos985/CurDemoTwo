package com.example.cutdemotwo.algorithm.slitting;

import com.example.cutdemotwo.contracts.slitting.SlittingProblem;
import com.example.cutdemotwo.contracts.slitting.SlittingResult;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class LinearSlittingSolverEngineTests {

    private final LinearSlittingSolverEngine engine = new LinearSlittingSolverEngine();

    @AfterEach
    void closeEngine() {
        engine.close();
    }

    @Test
    void standardProblemSolvesFeasibleWithValidFulfillment() {
        var problem = new SlittingProblem("1", "mm", 1200, 10, 10, 1000, 1180, 10, 10, "FAST",
                List.of(
                        new SlittingProblem.Order("O1", 500, 3000, 4, "素色"),
                        new SlittingProblem.Order("O2", 600, 3000, 2, "素色")
                ), 10);

        SlittingResult result = engine.solve(problem);

        assertEquals("FEASIBLE", result.status());
        assertEquals("ortools-1d", result.engine());
        assertFalse(result.patterns().isEmpty());
        assertEquals(2, result.fulfillment().size());

        var f1 = result.fulfillment().stream().filter(f -> f.orderId().equals("O1")).findFirst().orElseThrow();
        assertEquals(4, f1.requested());
        assertEquals(4, f1.produced());
        assertEquals(0, f1.missing());

        var f2 = result.fulfillment().stream().filter(f -> f.orderId().equals("O2")).findFirst().orElseThrow();
        assertEquals(2, f2.requested());
        assertEquals(2, f2.produced());
        assertEquals(0, f2.missing());

        assertTrue(result.pieceAreaMm2() > 0);
        assertTrue(result.motherAreaMm2() >= result.usableAreaMm2());
    }

    @Test
    void millimetreLengthsRemainExactAcrossGroupsAndLargeLengths() {
        for (String profile : List.of("FAST", "QUALITY")) {
            var lengths = List.of(2440L, 2441L, 1L, 1_000_000_000L);
            var orders = lengths.stream().map(length -> new SlittingProblem.Order("L" + length, 500, length, 2, "plain")).toList();
            var p = new SlittingProblem("1", "mm", 1000, 0, 0, 1000, 1000, 1, 0, profile, orders, 20);
            var r = engine.solve(p);
            assertEquals("FEASIBLE", r.status());
            assertTrue(r.fulfillment().stream().allMatch(f -> f.produced() == 2 && f.missing() == 0));
            assertEquals(new java.util.HashSet<>(lengths), r.patterns().stream().map(SlittingResult.Pattern::lengthMm).collect(java.util.stream.Collectors.toSet()));
            assertEquals(lengths.stream().mapToLong(l -> l * 1000).sum(), r.motherAreaMm2());
            assertEquals(r.motherAreaMm2(), r.pieceAreaMm2());
        }
    }

    @Test
    void malformedKernelOutputNeverGuessesAssignmentsOrSubstitutesRollLength() {
        var p=new SlittingProblem("1","mm",1000,0,0,1000,1000,1,0,"FAST",
                List.of(new SlittingProblem.Order("external-A",500,1000,2,"A")),10);
        var raw=new changyang.cut.apsmodule.service.CuttingInstruction();
        raw.setRollWidth(1000);raw.setLength(1);raw.setSurfaceTreatment("A");raw.setUsageCount(1);
        raw.setSubRolls(java.util.Map.of(500,2));
        assertThrows(com.example.cutdemotwo.contracts.slitting.SlittingValidation.ValidationException.class,
                ()->LinearSlittingSolverEngine.convert(p,List.of(raw)));
        raw.setStationAssignments(List.of(new changyang.cut.apsmodule.service.StationAssignment(500,"external-A"),
                new changyang.cut.apsmodule.service.StationAssignment(500,"external-A")));
        assertEquals(2,LinearSlittingSolverEngine.convert(p,List.of(raw)).fulfillment().get(0).produced());
        raw.setLength(2);
        assertThrows(com.example.cutdemotwo.contracts.slitting.SlittingValidation.ValidationException.class,
                ()->LinearSlittingSolverEngine.convert(p,List.of(raw)));
    }
    @Test @org.junit.jupiter.api.Timeout(15)
    void cancellationWaitsForOwnedChildProcessToExit() throws Exception {
        var p=new SlittingProblem("1","mm",1200,10,10,1000,1180,10,10,"QUALITY",
                List.of(new SlittingProblem.Order("O1",500,3000,400,"A"),new SlittingProblem.Order("O2",600,3000,200,"A")),30);
        var error=new java.util.concurrent.atomic.AtomicReference<Throwable>();
        Thread worker=new Thread(()->{try{engine.solve(p);}catch(Throwable e){error.set(e);}});
        var existing=ProcessHandle.current().children().map(ProcessHandle::pid).collect(java.util.stream.Collectors.toSet());
        worker.start();ProcessHandle child=null;
        try {
            long deadline=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
            while(child==null && worker.isAlive() && System.nanoTime()<deadline) {
                child=newJavaChildren(existing).findFirst().orElse(null);
                if(child==null)Thread.sleep(2);
            }
            assertNotNull(child,"must observe the actual solver JVM; worker failure="+error.get());
            assertTrue(child.isAlive());
            worker.interrupt();worker.join(5000);
            assertFalse(worker.isAlive());assertFalse(child.isAlive());assertInstanceOf(java.util.concurrent.CancellationException.class,error.get());
        } finally {
            // An observation/assertion failure must not leave the solver running into the next test.
            worker.interrupt();worker.join(5000);
            if(child!=null && child.isAlive())child.destroyForcibly();
        }
    }

    private static java.util.stream.Stream<ProcessHandle> newJavaChildren(java.util.Set<Long> existing) {
        // Linux JDK 17 only reads one page of argv. The test classpath exceeds that page,
        // so the main class after -cp is absent from commandLine(). Use owned PID + executable.
        return ProcessHandle.current().children().filter(c->!existing.contains(c.pid()) && c.isAlive()
                && c.info().command().map(command->java.nio.file.Path.of(command).getFileName().toString())
                .filter(name->name.equals("java") || name.equals("java.exe")).isPresent());
    }
    @Test @org.junit.jupiter.api.Timeout(15)
    void childSelfTerminatesWhenParentNoLongerExists(@org.junit.jupiter.api.io.TempDir java.nio.file.Path temp) throws Exception {
        var p=new SlittingProblem("1","mm",1200,10,10,1000,1180,10,10,"QUALITY",
                List.of(new SlittingProblem.Order("O1",500,3000,4,"A")),10);
        var input=temp.resolve("input.json");var output=temp.resolve("output.json");
        java.nio.file.Files.write(input,tools.jackson.databind.json.JsonMapper.builder().build().writeValueAsBytes(p));
        var command=LinearSlittingSolverEngine.command(input,output,Long.MAX_VALUE);
        var child=new ProcessBuilder(command).redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD).start();
        try {assertTrue(child.waitFor(8,java.util.concurrent.TimeUnit.SECONDS));assertEquals(124,child.exitValue());}
        finally{if(child.isAlive()){child.destroyForcibly();child.waitFor();}}
    }
 @Test void sameWidthDifferentLengthAndSurfaceRetainIdentity(){
  var p=new SlittingProblem("1","mm",1200,10,10,1000,1180,10,0,"FAST",List.of(
   new SlittingProblem.Order("A",500,3000,2,"plain"),new SlittingProblem.Order("B",500,6000,2,"plain"),
   new SlittingProblem.Order("C",500,3000,2,"coated"),new SlittingProblem.Order("D",500,6000,2,"coated")),20);
  var r=new LinearSlittingSolverEngine().solve(p);
  assertEquals("FEASIBLE",r.status());assertEquals(4,r.fulfillment().size());
  assertTrue(r.fulfillment().stream().allMatch(f->f.produced()==2 && f.missing()==0));
 }
 public static class ParentMain {
  public static void main(String[] args) throws Exception {
   var p=tools.jackson.databind.json.JsonMapper.builder().build().readValue(java.nio.file.Files.readAllBytes(java.nio.file.Path.of(args[0])),SlittingProblem.class);
   new LinearSlittingSolverEngine().solve(p);
  }
 }
 @Test void actualParentDeathStopsLiveChild(@org.junit.jupiter.api.io.TempDir java.nio.file.Path temp) throws Exception {
  var in=temp.resolve("parent-input.json");java.nio.file.Files.write(in,tools.jackson.databind.json.JsonMapper.builder().build().writeValueAsBytes(new SlittingProblem("1","mm",1200,10,10,1000,1180,10,0,"FAST",List.of(new SlittingProblem.Order("A",500,3000,4,"plain")),20)));
  var parent=new ProcessBuilder(java.nio.file.Path.of(System.getProperty("java.home"),"bin","java").toString(),"-cp",System.getProperty("surefire.test.class.path",System.getProperty("java.class.path")),ParentMain.class.getName(),in.toString()).redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD).start();
  ProcessHandle child=null;
  try {
   long limit=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(10);
   while(System.nanoTime()<limit && child==null){child=parent.children().findFirst().orElse(null);Thread.sleep(2);}
   assertNotNull(child,"supervisor must launch real solver child");parent.destroyForcibly();assertTrue(parent.waitFor(5,java.util.concurrent.TimeUnit.SECONDS));
   limit=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
   while(System.nanoTime()<limit && child.isAlive())Thread.sleep(20);
   assertFalse(child.isAlive(),"child JVM must self-stop after real supervisor death");
  } finally {parent.destroyForcibly();parent.waitFor();if(child!=null && child.isAlive())child.destroyForcibly();}
 }

    @Test @org.junit.jupiter.api.Timeout(15)
    void wallClockTimeoutStopsProcessWithManyIndependentGroups() {
        var orders=java.util.stream.IntStream.range(0,500).mapToObj(i->
                new SlittingProblem.Order("group-"+i,500,3000,2,"surface-"+i)).toList();
        var p=new SlittingProblem("1","mm",1200,10,10,1000,1180,10,0,"QUALITY",orders,1);
        var existing=ProcessHandle.current().children().map(ProcessHandle::pid).collect(java.util.stream.Collectors.toSet());
        long start=System.nanoTime();
        assertThrows(com.example.cutdemotwo.algorithm.api.ComputationTimeout.class,()->engine.solve(p));
        assertTrue(System.nanoTime()-start<java.util.concurrent.TimeUnit.SECONDS.toNanos(8));
        assertTrue(newJavaChildren(existing).findAny().isEmpty(),"timeout must leave no owned solver JVM alive");
    }

    @Test
    void customAdvancedNewSolverParametersSolveCleanlyInFastAndQuality() {
        for (String profile : List.of("FAST", "QUALITY")) {
            var p = new SlittingProblem("1", "mm", 4600, 100, 100, 4300, 4400, 10, 30, profile,
                    List.of(
                            new SlittingProblem.Order("O1", 860, 1_350_000L, 20, "不电晕/不涂布"),
                            new SlittingProblem.Order("O2", 990, 1_350_000L, 18, "不电晕/不涂布"),
                            new SlittingProblem.Order("O3", 1150, 1_350_000L, 16, "不电晕/不涂布"),
                            new SlittingProblem.Order("O4", 1270, 1_350_000L, 12, "不电晕/不涂布")
                    ), 25,
                    3, 300, 800, 4, 120_000L, true, 1e6, 1.0, 0.0, false);
            var r = engine.solve(p);
            assertEquals("FEASIBLE", r.status());
            assertTrue(r.fulfillment().stream().allMatch(f -> f.missing() == 0));
            assertTrue(r.totalOverproduced() <= 30);
            assertFalse(r.patterns().isEmpty());
        }
    }

    @Test
    void childXmxConfigurationAppliesToCommandAndRejectsInvalidValues(@org.junit.jupiter.api.io.TempDir java.nio.file.Path temp) throws Exception {
        var in = temp.resolve("in.json");
        var out = temp.resolve("out.json");
        assertTrue(LinearSlittingSolverEngine.command(in, out, 1L).contains("-Xmx768m"));
        assertTrue(LinearSlittingSolverEngine.command(in, out, 1L, "384m").contains("-Xmx384m"));
        assertThrows(IllegalArgumentException.class, () -> new LinearSlittingSolverEngine(""));
        assertThrows(IllegalArgumentException.class, () -> new LinearSlittingSolverEngine("384m -XX:+UnlockExperimentalVMOptions"));
        assertThrows(IllegalArgumentException.class, () -> new LinearSlittingSolverEngine("0m"));

        try (var lowMemEngine = new LinearSlittingSolverEngine("384m")) {
            var problem = new SlittingProblem("1", "mm", 1200, 10, 10, 1000, 1180, 10, 10, "FAST",
                    List.of(new SlittingProblem.Order("O1", 500, 3000, 2, "素色")), 10);
            var result = lowMemEngine.solve(problem);
            assertEquals("FEASIBLE", result.status());
            assertEquals(2, result.fulfillment().get(0).produced());
        }
    }

    @Test
    void warmWorkerPoolReusesLiveChildAndCleansUpOnClose() throws Exception {
        var problem = new SlittingProblem("1", "mm", 1200, 10, 10, 1000, 1180, 10, 10, "FAST",
                List.of(
                        new SlittingProblem.Order("O1", 500, 3000, 4, "素色"),
                        new SlittingProblem.Order("O2", 600, 3000, 2, "素色")
                ), 15);
        var existing = ProcessHandle.current().children().map(ProcessHandle::pid).collect(java.util.stream.Collectors.toSet());
        try (var pooled = new LinearSlittingSolverEngine()) {
            assertEquals(0, pooled.idleWorkerCount());
            var r1 = pooled.solve(problem);
            assertEquals("FEASIBLE", r1.status());
            assertEquals(1, pooled.idleWorkerCount());
            var firstPid = newJavaChildren(existing).map(ProcessHandle::pid).findFirst().orElseThrow();

            long warmStart = System.nanoTime();
            var r2 = pooled.solve(problem);
            long warmMs = (System.nanoTime() - warmStart) / 1_000_000L;
            assertEquals("FEASIBLE", r2.status());
            assertEquals(1, pooled.idleWorkerCount());
            var secondPid = newJavaChildren(existing).map(ProcessHandle::pid).findFirst().orElseThrow();
            assertEquals(firstPid, secondPid, "连续请求应复用同一温热常驻子进程");
            assertTrue(warmMs < 3_000L, "温热复用求解应显著快于冷启动，实际=" + warmMs + "ms");
        }
        assertTrue(newJavaChildren(existing).findAny().isEmpty(), "关闭引擎后应清理全部常驻子进程");
    }

    @Test
    void qualityModeAutoEnablesControlledLnsAndRespectsExplicitDisable() {
        var problem = new SlittingProblem("1", "mm", 2800, 20, 20, 2660, 2760, 10, 30, "QUALITY",
                List.of(
                        new SlittingProblem.Order("A", 900, 50_000L, 20, "涂层"),
                        new SlittingProblem.Order("B", 1200, 50_000L, 16, "涂层"),
                        new SlittingProblem.Order("C", 1500, 50_000L, 12, "涂层"),
                        new SlittingProblem.Order("D", 600, 50_000L, 30, "涂层")
                ), 30);
        var withAutoLns = engine.solve(problem);
        assertEquals("FEASIBLE", withAutoLns.status());
        assertTrue(withAutoLns.patterns().size() <= 4, "精修自动 LNS 应将窗帘算例压缩至 <= 4 组");

        var disabledLnsProblem = new SlittingProblem("1", "mm", 2800, 20, 20, 2660, 2760, 10, 30, "QUALITY",
                problem.orders(), 30, null, null, null, null, null, null, null, null, null, false);
        var withoutLns = engine.solve(disabledLnsProblem);
        assertEquals("FEASIBLE", withoutLns.status());
        assertTrue(withAutoLns.patterns().size() <= withoutLns.patterns().size(),
                "自动 LNS 压缩后的序号组数不应劣于关闭 LNS");
    }

    @Test
    void qualityModeNeverDegradesCarsOrUtilizationComparedToFastMode() {
        var orders = List.of(
                new SlittingProblem.Order("O1", 750, 50_000L, 40, "S"),
                new SlittingProblem.Order("O2", 790, 50_000L, 28, "S"),
                new SlittingProblem.Order("O3", 830, 50_000L, 32, "S"),
                new SlittingProblem.Order("O4", 910, 50_000L, 26, "S"),
                new SlittingProblem.Order("O5", 960, 50_000L, 30, "S"),
                new SlittingProblem.Order("O6", 1020, 50_000L, 22, "S"),
                new SlittingProblem.Order("O7", 1090, 50_000L, 18, "S"),
                new SlittingProblem.Order("O8", 1160, 50_000L, 20, "S"),
                new SlittingProblem.Order("O9", 1260, 50_000L, 16, "S"),
                new SlittingProblem.Order("O10", 1480, 50_000L, 14, "S")
        );
        var fastProblem = new SlittingProblem("1", "mm", 4500, 50, 50, 4200, 4400, 10, 0, "FAST", orders, 60);
        var qualityProblem = new SlittingProblem("1", "mm", 4500, 50, 50, 4200, 4400, 10, 0, "QUALITY", orders, 60);

        var fastRes = engine.solve(fastProblem);
        var qualityRes = engine.solve(qualityProblem);
        assertEquals("FEASIBLE", fastRes.status());
        assertEquals("FEASIBLE", qualityRes.status());

        int fastCars = fastRes.patterns().stream().mapToInt(SlittingResult.Pattern::repetitions).sum();
        int qualityCars = qualityRes.patterns().stream().mapToInt(SlittingResult.Pattern::repetitions).sum();
        double fastUtil = fastRes.pieceAreaMm2() / (double) fastRes.motherAreaMm2();
        double qualityUtil = qualityRes.pieceAreaMm2() / (double) qualityRes.motherAreaMm2();

        assertTrue(qualityRes.totalOverproduced() <= fastRes.totalOverproduced(),
                "QUALITY 超产不应高于 FAST: quality=" + qualityRes.totalOverproduced() + " fast=" + fastRes.totalOverproduced());
        if (qualityRes.totalOverproduced() == fastRes.totalOverproduced()) {
            assertTrue(qualityCars <= fastCars,
                    "QUALITY 车数不应劣于 FAST: quality=" + qualityCars + " fast=" + fastCars);
            assertTrue(qualityUtil + 1e-6 >= fastUtil,
                    "QUALITY 利用率不应低于 FAST: quality=" + qualityUtil + " fast=" + fastUtil);
        }
    }

    @Test
    void childThreadsConfigurationAppliesAdaptiveDefaultsAndCommandFlags(@org.junit.jupiter.api.io.TempDir java.nio.file.Path temp) throws Exception {
        assertEquals(1, LinearSlittingSolverEngine.defaultChildThreads(1));
        assertEquals(1, LinearSlittingSolverEngine.defaultChildThreads(2));
        assertEquals(1, LinearSlittingSolverEngine.defaultChildThreads(3));
        assertEquals(2, LinearSlittingSolverEngine.defaultChildThreads(4));
        assertEquals(3, LinearSlittingSolverEngine.defaultChildThreads(6));
        assertEquals(3, LinearSlittingSolverEngine.defaultChildThreads(8));
        assertEquals(3, LinearSlittingSolverEngine.defaultChildThreads(16));

        assertEquals(LinearSlittingSolverEngine.defaultChildThreads(), LinearSlittingSolverEngine.normalizeChildThreads("auto"));
        assertEquals(1, LinearSlittingSolverEngine.normalizeChildThreads("1"));
        assertEquals(3, LinearSlittingSolverEngine.normalizeChildThreads("3"));
        assertThrows(IllegalArgumentException.class, () -> LinearSlittingSolverEngine.normalizeChildThreads("0"));
        assertThrows(IllegalArgumentException.class, () -> LinearSlittingSolverEngine.normalizeChildThreads("-1"));
        assertThrows(IllegalArgumentException.class, () -> LinearSlittingSolverEngine.normalizeChildThreads("9"));
        assertThrows(IllegalArgumentException.class, () -> LinearSlittingSolverEngine.normalizeChildThreads("abc"));

        var in = temp.resolve("in.json");
        var out = temp.resolve("out.json");
        var singleCmd = LinearSlittingSolverEngine.command(in, out, 1L, "384m", 1);
        assertTrue(singleCmd.contains("-Xmx384m"));
        assertTrue(singleCmd.contains("-XX:ActiveProcessorCount=2"));
        assertTrue(singleCmd.contains("-Dcutting.parallel.globalThreads=1"));

        var multiCmd = LinearSlittingSolverEngine.command(in, out, 1L, "768m", 3);
        assertTrue(multiCmd.contains("-XX:ActiveProcessorCount=3"));
        assertTrue(multiCmd.contains("-Dcutting.parallel.globalThreads=3"));

        var workerCmd = LinearSlittingSolverEngine.workerCommand(1L, "512m", 3);
        assertTrue(workerCmd.contains("-Xmx512m"));
        assertTrue(workerCmd.contains("-XX:ActiveProcessorCount=3"));
        assertTrue(workerCmd.contains("-Dcutting.parallel.globalThreads=3"));
        assertTrue(workerCmd.contains("--worker"));
    }

    @Test
    void qualityModeIsDeterministicAcrossRepeatedRunsAndSingleVsMultiThreads() {
        var orders = List.of(
                new SlittingProblem.Order("C1", 750, 50_000L, 40, "S"),
                new SlittingProblem.Order("C2", 790, 50_000L, 28, "S"),
                new SlittingProblem.Order("C3", 830, 50_000L, 32, "S"),
                new SlittingProblem.Order("C4", 910, 50_000L, 26, "S"),
                new SlittingProblem.Order("C5", 960, 50_000L, 30, "S"),
                new SlittingProblem.Order("C6", 1020, 50_000L, 22, "S"),
                new SlittingProblem.Order("C7", 1090, 50_000L, 18, "S"),
                new SlittingProblem.Order("C8", 1160, 50_000L, 20, "S"),
                new SlittingProblem.Order("C9", 1260, 50_000L, 16, "S"),
                new SlittingProblem.Order("C10", 1480, 50_000L, 14, "S")
        );
        var problem = new SlittingProblem("1", "mm", 4500, 50, 50, 4200, 4400, 10, 0, "QUALITY", orders, 60);

        var run1 = engine.solve(problem);
        var run2 = engine.solve(problem);
        assertEquals("FEASIBLE", run1.status());
        assertEquals(run1, run2, "连续两次 QUALITY 求解输出必须 100% 确定性一致");

        try (var singleThreadEngine = new LinearSlittingSolverEngine("384m", 1)) {
            var singleRun = singleThreadEngine.solve(problem);
            assertEquals("FEASIBLE", singleRun.status());
            assertEquals(run1, singleRun, "低配单线程模式与多核并发模式 QUALITY 输出必须 100% 一致");
        }
    }

    public static class SilentBlockingChildMain {
        public static void main(String[] args) throws Exception {
            System.err.println("DIAG_START_MARKER: slitting worker diagnostic line");
            System.err.flush();
            Thread.sleep(30_000L);
        }
    }

    @Test
    @org.junit.jupiter.api.Timeout(10)
    void destroyAndWaitDoesNotDeadlockWhileReaderIsBlockedOnStdoutAndCapturesStderr() throws Exception {
        String javaBin = java.nio.file.Path.of(System.getProperty("java.home"), "bin",
                System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java").toString();
        String cp = System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
        Process process = new ProcessBuilder(javaBin, "-cp", cp, SilentBlockingChildMain.class.getName()).start();
        var worker = new LinearSlittingSolverEngine.WarmWorker(process);
        var readerError = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        var started = new java.util.concurrent.CountDownLatch(1);
        Thread reader = new Thread(() -> {
            started.countDown();
            try {
                worker.awaitLine(System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(20));
            } catch (Throwable t) {
                readerError.set(t);
            }
        }, "test-await-line");
        reader.start();
        assertTrue(started.await(2, java.util.concurrent.TimeUnit.SECONDS));
        // 等待后台线程切实进入 BufferedReader.readLine() 阻塞并收到子进程 stderr 诊断输出
        long waitDeadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(4);
        while (worker.stderrTail().isEmpty() && System.nanoTime() < waitDeadline) {
            Thread.sleep(20);
        }
        assertTrue(worker.stderrTail().contains("DIAG_START_MARKER"),
                "应通过有限环形缓冲捕获子进程 stderr 诊断信息，实际=" + worker.stderrTail());

        long destroyStart = System.nanoTime();
        Thread.currentThread().interrupt();
        try {
            worker.destroyAndWait();
            assertTrue(Thread.currentThread().isInterrupted(), "destroyAndWait 必须保留调用线程中断标志");
        } finally {
            Thread.interrupted();
        }
        long elapsedMs = java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - destroyStart);
        assertTrue(elapsedMs < 3_000L, "destroyAndWait 不得因 stdout.readLine() 锁竞争发生死锁，实际耗时=" + elapsedMs + "ms");
        assertFalse(worker.isAlive(), "子进程必须已彻底终止");
        reader.join(2_000L);
        assertFalse(reader.isAlive(), "读取线程必须随管道关闭立即退出");
        assertNotNull(readerError.get());
    }

    @Test
    void boundedStderrBufferRetainsLatestTailWithinCapacity() {
        var buffer = new LinearSlittingSolverEngine.BoundedStderrBuffer(64);
        byte[] prefix = "A".repeat(100).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] suffix = "TAIL_DIAG_12345".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        buffer.append(prefix, 0, prefix.length);
        buffer.append(suffix, 0, suffix.length);
        String tail = buffer.snapshotUtf8();
        assertEquals(64, tail.length());
        assertTrue(tail.endsWith("TAIL_DIAG_12345"), tail);
        buffer.reset();
        assertEquals("", buffer.snapshotUtf8());
    }

    @Test
    @org.junit.jupiter.api.Timeout(25)
    void workerPoolRespectsExternalizedMaxIdleTtlAndActiveConcurrencyLimits() throws Exception {
        assertThrows(IllegalArgumentException.class, () -> new LinearSlittingSolverEngine("384m", 1, -1, 120, 2));
        assertThrows(IllegalArgumentException.class, () -> new LinearSlittingSolverEngine("384m", 1, 2, 0, 2));
        assertThrows(IllegalArgumentException.class, () -> new LinearSlittingSolverEngine("384m", 1, 2, 120, 0));

        var problem = new SlittingProblem("1", "mm", 1200, 10, 10, 1000, 1180, 10, 10, "FAST",
                List.of(new SlittingProblem.Order("O1", 500, 3000, 4, "素色")), 15);
        var existing = ProcessHandle.current().children().map(ProcessHandle::pid).collect(java.util.stream.Collectors.toSet());

        // 1. maxIdleWorkers=0 时不缓存空闲子进程
        try (var noIdle = new LinearSlittingSolverEngine("384m", 1, 0, 120, 1)) {
            assertEquals("FEASIBLE", noIdle.solve(problem).status());
            assertEquals(0, noIdle.idleWorkerCount());
            assertTrue(newJavaChildren(existing).findAny().isEmpty(), "maxIdleWorkers=0 时用完应立即回收子进程");
        }

        // 2. idleTtlSeconds=1 时到期自动回收空闲子进程
        try (var shortTtl = new LinearSlittingSolverEngine("384m", 1, 1, 1, 1)) {
            assertEquals("FEASIBLE", shortTtl.solve(problem).status());
            assertEquals(1, shortTtl.idleWorkerCount());
            long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
            while ((shortTtl.idleWorkerCount() > 0 || newJavaChildren(existing).findAny().isPresent())
                    && System.nanoTime() < deadline) {
                Thread.sleep(100);
            }
            assertEquals(0, shortTtl.idleWorkerCount(), "超过 idleTtlSeconds 后应自动回收过期空闲子进程");
            assertTrue(newJavaChildren(existing).findAny().isEmpty());
        }

        // 3. maxActiveWorkers=1 时并发请求受信号量限流，最多仅 1 个活跃子进程且均成功
        try (var serialized = new LinearSlittingSolverEngine("384m", 1, 1, 60, 1)) {
            var pool = java.util.concurrent.Executors.newFixedThreadPool(2);
            try {
                var f1 = pool.submit(() -> serialized.solve(problem));
                var f2 = pool.submit(() -> serialized.solve(problem));
                assertEquals("FEASIBLE", f1.get(20, java.util.concurrent.TimeUnit.SECONDS).status());
                assertEquals("FEASIBLE", f2.get(20, java.util.concurrent.TimeUnit.SECONDS).status());
                assertTrue(serialized.idleWorkerCount() <= 1);
            } finally {
                pool.shutdownNow();
            }
        }
    }
}
