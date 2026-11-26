package com.example.cutdemotwo.algorithm;

import com.example.cutdemotwo.algorithm.geometry.CoordinateFrame;
import com.example.cutdemotwo.algorithm.geometry.EngineGeometry;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.algorithm.nesting.ContourGeometrySupport;
import com.example.cutdemotwo.algorithm.nesting.EngineResult;
import com.example.cutdemotwo.algorithm.nesting.GuillotinePostProcessor;
import com.example.cutdemotwo.algorithm.nesting.ICutSolverEngine;
import com.example.cutdemotwo.algorithm.nesting.SolverFactory;
import com.example.cutdemotwo.algorithm.nesting.StripSearchCapable;
import com.example.cutdemotwo.algorithm.runtime.IsolatedProcessRunner;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.nesting.EngineCapabilities;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Exclusion;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Material;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Part;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Process;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

class Phase1DecouplingTests {

    @TempDir
    Path tempDir;

    /** 供子进程测试使用的最小休眠入口：将自身 PID 写入指定文件后休眠。 */
    public static final class SleeperMain {
        public static void main(String[] args) throws Exception {
            if (args.length >= 1) {
                Files.writeString(Path.of(args[0]), Long.toString(ProcessHandle.current().pid()));
            }
            long sleepMs = args.length >= 2 ? Long.parseLong(args[1]) : 30_000L;
            Thread.sleep(sleepMs);
        }
    }

    private static ProcessBuilder sleeperProcess(Path pidFile, long sleepMs) {
        String launcher = System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java";
        String javaBin = Path.of(System.getProperty("java.home"), "bin", launcher).toString();
        String cp = System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
        return new ProcessBuilder(javaBin, "-Xmx64m", "-cp", cp, SleeperMain.class.getName(),
                pidFile.toString(), Long.toString(sleepMs))
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .redirectError(ProcessBuilder.Redirect.DISCARD);
    }

    private static long awaitPid(Path pidFile, long timeoutMs) throws Exception {
        long deadline = System.nanoTime() + timeoutMs * 1_000_000L;
        while (System.nanoTime() < deadline) {
            if (Files.isRegularFile(pidFile)) {
                String content = Files.readString(pidFile).trim();
                if (!content.isEmpty()) {
                    return Long.parseLong(content);
                }
            }
            Thread.sleep(20);
        }
        fail("子进程未在预期时间内启动并写出 PID");
        return -1L;
    }

    @Test
    void isolatedProcessRunnerCancelsCooperativelyAndKillsChildProcess() throws Exception {
        Path pidFile = tempDir.resolve("cancel.pid");
        AtomicReference<Throwable> thrown = new AtomicReference<>();
        AtomicBoolean interruptedPreserved = new AtomicBoolean(false);

        Thread worker = new Thread(() -> {
            try {
                IsolatedProcessRunner.run(sleeperProcess(pidFile, 30_000L), 20_000L, 50L, true);
            } catch (Throwable t) {
                thrown.set(t);
                interruptedPreserved.set(Thread.currentThread().isInterrupted());
            }
        }, "phase1-cancel-runner-test");
        worker.setDaemon(true);
        worker.start();

        long childPid = awaitPid(pidFile, 10_000L);
        assertTrue(ProcessHandle.of(childPid).map(ProcessHandle::isAlive).orElse(false), "取消前子进程应处于存活状态");

        long cancelStart = System.nanoTime();
        worker.interrupt();
        worker.join(3_000L);
        long elapsedMs = (System.nanoTime() - cancelStart) / 1_000_000L;

        assertFalse(worker.isAlive(), "工作线程应在取消后快速退出");
        assertInstanceOf(CancellationException.class, thrown.get(), "取消时应抛出 CancellationException");
        assertTrue(interruptedPreserved.get(), "取消后必须保留调用线程的中断标志");
        assertTrue(elapsedMs < 3_000L, "协作取消响应时间过长: " + elapsedMs + "ms");
        assertFalse(ProcessHandle.of(childPid).map(ProcessHandle::isAlive).orElse(false), "取消后子进程必须被强杀");
    }

    @Test
    void isolatedProcessRunnerEnforcesTimeoutAndDeletesTempDirectory() throws Exception {
        Path workDir = Files.createTempDirectory("phase1_runner_timeout_");
        Path pidFile = workDir.resolve("timeout.pid");
        try {
            var result = IsolatedProcessRunner.run(sleeperProcess(pidFile, 30_000L), 350L, 50L, true);
            assertTrue(result.timedOut(), "超时后应标记 timedOut=true");
            if (Files.isRegularFile(pidFile)) {
                String text = Files.readString(pidFile).trim();
                if (!text.isEmpty()) {
                    long pid = Long.parseLong(text);
                    assertFalse(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false), "超时后子进程必须已终止");
                }
            }
        } finally {
            IsolatedProcessRunner.deleteTempDirectory(workDir);
        }
        assertFalse(Files.exists(workDir), "临时目录及其子文件应被递归清理");
    }

    @Test
    void coordinateFrameRoundTripMatchesAcrossAllStartCornersAndSheetModes() {
        double width = 1200.0;
        double height = 2000.0;
        double rectW = 320.0;
        double rectH = 450.0;
        double physX = 210.0;
        double physY = 340.0;

        for (String corner : List.of("left-top", "right-top", "left-bottom", "right-bottom")) {
            for (boolean sheet : List.of(false, true)) {
                for (double trim : List.of(0.0, 25.0)) {
                    CoordinateFrame frame = CoordinateFrame.of(width, height, trim, corner, sheet);
                    double localX = frame.toLocalX(physX, rectW);
                    double localY = frame.toLocalY(physY, rectH);
                    assertEquals(physX, frame.toPhysicalX(localX, rectW), EngineGeometry.COORDINATE_EPS_MM,
                            "X 往返不一致: corner=" + corner + ", sheet=" + sheet + ", trim=" + trim);
                    assertEquals(physY, frame.toPhysicalY(localY, rectH), EngineGeometry.COORDINATE_EPS_MM,
                            "Y 往返不一致: corner=" + corner + ", sheet=" + sheet + ", trim=" + trim);

                    assertEquals(corner.startsWith("right") ? width : 0.0, frame.homeX(), EngineGeometry.COORDINATE_EPS_MM);
                    assertEquals(corner.endsWith("bottom") ? height : 0.0, frame.homeY(), EngineGeometry.COORDINATE_EPS_MM);
                    assertEquals(sheet && corner.endsWith("bottom"), frame.isMirrorY());
                }
            }
        }
    }

    @Test
    void solverFactoryRoutesStripSearchViaStripSearchCapableWithoutConcreteInstanceof() {
        AtomicBoolean stripCalled = new AtomicBoolean(false);
        AtomicBoolean regularCalled = new AtomicBoolean(false);

        ICutSolverEngine capableStub = new StubStripCapableEngine("stub-strip", stripCalled, regularCalled);
        ICutSolverEngine plainStub = new StubPlainContourEngine("stub-plain");
        SolverFactory factory = new SolverFactory(List.of(capableStub, plainStub));

        NestingProblem stripProblem = contourProblem("stub-strip");
        var stripFn = factory.stripSearch(stripProblem, false);
        assertTrue(stripFn.isPresent(), "实现 StripSearchCapable 的可用引擎应被识别");
        var res = stripFn.get().apply(stripProblem);
        assertEquals("FEASIBLE", res.status());
        assertTrue(stripCalled.get(), "stripSearch 应路由到 solveStripCandidate");
        assertFalse(regularCalled.get(), "stripSearch 不应误调用常规 solve");

        NestingProblem plainProblem = contourProblem("stub-plain");
        assertTrue(factory.stripSearch(plainProblem, false).isEmpty(), "未实现 StripSearchCapable 的引擎应返回 empty");
    }

    @Test
    void guillotinePostProcessorAndContourGeometrySupportMatchExpectedSemantics() {
        var problem = new NestingProblem(
                "1", "mm",
                new Material("roll", Shape.rectangle(1000, 2000), List.of(), true),
                List.of(new Part(1, "P1", Shape.rectangle(200, 200), 1, false)),
                new Process("GUILLOTINE", "ROLL", "right-top", "horizontal", 20, 100, 100, 0, "MAXIMIZE_PIECE_AREA"),
                "javaguillotine", 2
        );
        CoordinateFrame frame = CoordinateFrame.of(problem);
        var trimRem = GuillotinePostProcessor.createTrimRemnant(frame, 1);
        var trimCut = GuillotinePostProcessor.createTrimCut(frame, 1);
        assertEquals("TRIM-01", trimRem.getId());
        assertEquals(20.0, trimCut.getPos(), EngineGeometry.COORDINATE_EPS_MM);

        // 连续母卷尾段应被识别并跳过回收
        assertTrue(GuillotinePostProcessor.isContinuousTail(problem, frame, 1500, 1520, 1000, 480));
        assertNull(GuillotinePostProcessor.tryCreateRemnant(problem, frame, "REM", 1, 1500, 0, 1520, 1000, 480, List.of()));

        // 带疵料头打标
        Defect defect = new Defect(1, 100, 100, 50, 50, 10);
        var tagged = GuillotinePostProcessor.tryCreateRemnant(problem, frame, "REM", 2, 0, 80, 80, 200, 200, List.of(defect));
        assertNotNull(tagged);
        assertTrue(tagged.isHasDefect());
        assertEquals("带疵料头", tagged.getStatus());

        // 异形疵点裁剪外扩 & 最小边段间距判定
        Exclusion edgeDefect = new Exclusion(1, 5, 5, Shape.rectangle(20, 20), 10);
        var clipped = ContourGeometrySupport.expandExclusionClipped(edgeDefect, 100, 100, 0.1);
        assertEquals(0.0, clipped.x(), EngineGeometry.COORDINATE_EPS_MM);
        assertEquals(0.0, clipped.y(), EngineGeometry.COORDINATE_EPS_MM);
        assertEquals(35.0, clipped.shape().width(), EngineGeometry.COORDINATE_EPS_MM);
        assertEquals(35.0, clipped.shape().height(), EngineGeometry.COORDINATE_EPS_MM);

        var rectVerts = PolygonGeometry.vertices(Shape.rectangle(100, 100));
        assertTrue(ContourGeometrySupport.violatesMinEdgeGap(rectVerts, 0, 0, rectVerts, 104, 0, 5.0, 0.001));
        assertFalse(ContourGeometrySupport.violatesMinEdgeGap(rectVerts, 0, 0, rectVerts, 105, 0, 5.0, 0.001));
    }

    private static NestingProblem contourProblem(String engine) {
        return new NestingProblem(
                "1", "mm",
                new Material("sheet", Shape.rectangle(500, 500), List.of(), false),
                List.of(new Part(1, "P1", Shape.rectangle(100, 100), 1, false)),
                new Process("CONTOUR", "SHEET", "left-top", "none", 0, 0, 0, 0, "MAXIMIZE_PIECE_AREA"),
                engine, 2
        );
    }

    private static final class StubStripCapableEngine implements ICutSolverEngine, StripSearchCapable {
        private final String id;
        private final AtomicBoolean stripCalled;
        private final AtomicBoolean regularCalled;

        StubStripCapableEngine(String id, AtomicBoolean stripCalled, AtomicBoolean regularCalled) {
            this.id = id;
            this.stripCalled = stripCalled;
            this.regularCalled = regularCalled;
        }

        @Override public String getEngineType() { return id; }
        @Override public boolean isAvailable() { return true; }
        @Override public EngineCapabilities capabilities() {
            return new EngineCapabilities(id, "1", List.of("RECTANGLE", "POLYGON"), List.of("CONTOUR"),
                    List.of("MAXIMIZE_PIECE_AREA"), 0.1, true);
        }

        @Override public EngineResult solve(NestingProblem problem) {
            regularCalled.set(true);
            return singlePlacementResult(problem);
        }

        @Override public EngineResult solveStripCandidate(NestingProblem problem) {
            stripCalled.set(true);
            return singlePlacementResult(problem);
        }

        private static EngineResult singlePlacementResult(NestingProblem problem) {
            var part = problem.parts().get(0);
            var res = new EngineResult();
            res.setSuccess(true);
            res.setPlacements(List.of(new Placement(1, part.id(), part.name(), 0, 0, part.shape(), 0)));
            return res;
        }
    }

    private static final class StubPlainContourEngine implements ICutSolverEngine {
        private final String id;
        StubPlainContourEngine(String id) { this.id = id; }
        @Override public String getEngineType() { return id; }
        @Override public boolean isAvailable() { return true; }
        @Override public EngineCapabilities capabilities() {
            return new EngineCapabilities(id, "1", List.of("RECTANGLE", "POLYGON"), List.of("CONTOUR"),
                    List.of("MAXIMIZE_PIECE_AREA"), 0.1, true);
        }
        @Override public EngineResult solve(NestingProblem problem) {
            var res = new EngineResult();
            res.setSuccess(false);
            res.setFailureStatus("NO_SOLUTION_FOUND");
            return res;
        }
    }
}
