package com.example.cutdemotwo.algorithm.solver;

import com.example.cutdemotwo.algorithm.toolpath.ToolpathOptimizerService;
import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.*;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.jupiter.api.Assertions.*;

class SolverCancellationTests {
    private static NestingProblem problem(String engine, String mode) {
        return new NestingProblem("1", "mm",
                new Material("cancel-test", Shape.rectangle(1000, 1000), List.of(), false),
                List.of(new Part(1, "piece", Shape.rectangle("CROSSCUT".equals(mode) ? 1000 : 100, 100), 2, false)),
                new NestingProblem.Process(mode, "SHEET", "left-top", "CONTOUR".equals(mode) ? "none" : "horizontal",
                        0, 0, 0, 0, "CROSSCUT".equals(mode) ? "INPUT_ORDER" : "MAXIMIZE_PIECE_AREA", 0), engine, 2);
    }
    private static void interrupted(Runnable operation) {
        Thread.currentThread().interrupt();
        try {
            assertThrows(CancellationException.class, operation::run);
            assertTrue(Thread.currentThread().isInterrupted(), "The algorithm must not consume the caller's stop signal");
        } finally { Thread.interrupted(); }
    }
    @Test void contourStopsBeforeStarting() {
        interrupted(() -> new JavaIrregularSolverEngine().solve(problem("javairregular", "CONTOUR")));
    }
    @Test void guillotineStopsBeforeStarting() {
        interrupted(() -> new JavaGuillotineSolverEngine().solve(problem("javaguillotine", "GUILLOTINE")));
    }
    @Test void crosscutStopsBeforeStarting() {
        interrupted(() -> new CrossCutSolverService().solve(problem("crosscut", "CROSSCUT")));
    }
    @Test void factoryReportsCancellationInsteadOfFailureOrFeasibility() {
        var factory = new SolverFactory(List.of(new CrossCutSolverService()));
        Thread.currentThread().interrupt();
        try {
            var result = factory.solve(problem("crosscut", "CROSSCUT"));
            assertEquals("CANCELLED", result.status());
            assertTrue(result.placements().isEmpty());
            assertTrue(Thread.currentThread().isInterrupted());
        } finally { Thread.interrupted(); }
        assertEquals("FEASIBLE", factory.solve(problem("crosscut", "CROSSCUT")).status());
    }
    @Test void contourValidationCannotPublishAfterInterruption() {
        var problem = problem("javairregular", "CONTOUR");
        var candidate = new JavaIrregularSolverEngine().solve(problem);
        interrupted(() -> PolygonResultValidator.validate(problem, candidate));
    }
    @Test void rectangleValidationCannotPublishAfterInterruption() {
        var problem = problem("crosscut", "CROSSCUT");
        var candidate = new CrossCutSolverService().solve(problem);
        interrupted(() -> RectangularResultValidator.validate(problem, candidate));
    }
    @Test void toolpathStopsBeforeStarting() {
        interrupted(() -> new ToolpathOptimizerService().optimizeAndChain(
                List.of(new CutStep(1, "横切", 100, 0, 1000, "test")), 0, 0, false));
    }
    @Test void runningContourSearchStopsInsideCandidateLoop() throws Exception {
        var input = problem("javairregular", "CONTOUR");
        var large = new NestingProblem("1", "mm",
                new Material("large", Shape.rectangle(10000, 10000), List.of(), false),
                List.of(new Part(1, "piece", Shape.rectangle(100, 100), 200, true)),
                input.process(), input.engine(), 10);
        stopsDuring(() -> new JavaIrregularSolverEngine().solve(large),
                "isPositionValid", "squeezeLeftUp", "runPlacementPass");
    }
    @Test void runningToolpathSearchStopsInsideNearestNeighbourLoop() throws Exception {
        var cuts = new ArrayList<CutStep>();
        for (int i = 0; i < 10000; i++) cuts.add(new CutStep(i+1, "横切", i, 0, 1000, "test"));
        stopsDuring(() -> new ToolpathOptimizerService().optimizeAndChain(cuts, 0, 0, false),
                "solveUnconstrainedSegmentTSP");
    }
    private static void stopsDuring(Runnable operation, String... methods) throws Exception {
        var outcome = new AtomicReference<Throwable>();
        var worker = new Thread(() -> {
            try { operation.run(); outcome.set(new AssertionError("Finished without observing stop")); }
            catch (Throwable stopped) { outcome.set(stopped); }
        }, "real-algorithm-cancellation-test");
        worker.setDaemon(true);
        worker.start();
        try {
            long deadline = System.nanoTime() + 3_000_000_000L;
            boolean computing = false;
            while (worker.isAlive() && System.nanoTime() < deadline) {
                computing = Arrays.stream(worker.getStackTrace()).anyMatch(frame ->
                        frame.getClassName().startsWith("com.example.cutdemotwo.algorithm")
                        && List.of(methods).contains(frame.getMethodName()));
                if (computing) break;
                Thread.sleep(1);
            }
            assertTrue(computing, "Must observe actual algorithm work before interrupting");
            worker.interrupt();
            worker.join(1000);
            assertFalse(worker.isAlive(), "Interrupted computation must release its worker promptly");
            assertInstanceOf(CancellationException.class, outcome.get());
        } finally { worker.interrupt(); worker.join(1000); }
    }
}
