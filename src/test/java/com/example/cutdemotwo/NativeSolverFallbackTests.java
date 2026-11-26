package com.example.cutdemotwo;

import com.example.cutdemotwo.business.model.PieceDemand;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.business.cutting.FabricSolveAdapter;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSolverEngine;
import com.example.cutdemotwo.algorithm.nesting.IrregularPackingSolverService;
import com.example.cutdemotwo.algorithm.nesting.PackingSolverService;
import com.example.cutdemotwo.algorithm.nesting.JavaGuillotineSolverEngine;
import com.example.cutdemotwo.algorithm.nesting.SolverFactory;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** The rectangle engine label must always name the engine that actually produced the layout. */
class NativeSolverFallbackTests {
    @TempDir Path temp;

    private PackingSolverService missingNative() {
        var engine = new PackingSolverService();
        ReflectionTestUtils.setField(engine, "solverPath", temp.resolve("missing-packingsolver.exe").toString());
        return engine;
    }

    static NestingProblem guillotine(String engine) {
        return new NestingProblem("1", "mm",
                new NestingProblem.Material("sheet", NestingProblem.Shape.rectangle(1000, 600), List.of(), false),
                List.of(new NestingProblem.Part(7, "part", NestingProblem.Shape.rectangle(400, 300), 2, false)),
                new NestingProblem.Process("GUILLOTINE", "SHEET", "left-top", "horizontal", 0, 200, 300, 0,
                        "MAXIMIZE_PIECE_AREA"), engine, 1);
    }

    @Test void missingNativeExecutableIsReportedUnavailable() {
        var engine = missingNative();
        assertFalse(engine.isAvailable());
        assertFalse(engine.capabilities().available());
        assertFalse(engine.solve(guillotine("packingsolver")).isSuccess(), "the native adapter must not run another engine");
    }

    @Test void missingNativeFallsBackExplicitlyAndLabelsTheEngineThatRan() {
        var factory = new SolverFactory(List.of(missingNative(), new JavaGuillotineSolverEngine()));
        for (String requested : List.of("packingsolver", "auto")) {
            var result = factory.solve(guillotine(requested));
            assertEquals("FEASIBLE", result.status(), result.message());
            assertEquals(2, result.placements().size());
            assertEquals("javaguillotine", result.engine());
            assertEquals("1", result.engineVersion());
            assertEquals("packingsolver", result.requestedEngine());
            assertNotNull(result.fallbackReason());
            assertTrue(result.fallbackReason().contains("javaguillotine"), result.fallbackReason());
        }
    }

    @Test void disabledFallbackReportsTheMissingNativeEngineAsUnavailable() {
        var factory = new SolverFactory(List.of(missingNative(), new JavaGuillotineSolverEngine()), false);
        var result = factory.solve(guillotine("packingsolver"));
        assertEquals("UNAVAILABLE", result.status());
        assertEquals("packingsolver", result.engine());
        assertNull(result.fallbackReason());
        assertTrue(result.placements().isEmpty());
        assertNull(factory.fallbackFor("packingsolver"));
    }

    @Test void missingNativeWithoutRegisteredFallbackIsUnavailable() {
        var factory = new SolverFactory(List.of(missingNative()));
        assertEquals("UNAVAILABLE", factory.solve(guillotine("packingsolver")).status());
        assertNull(factory.fallbackFor("packingsolver"));
    }

    @Test void explicitlyRequestedJavaEngineIsNotReportedAsFallback() {
        var factory = new SolverFactory(List.of(missingNative(), new JavaGuillotineSolverEngine()));
        assertEquals("javaguillotine", factory.fallbackFor("packingsolver"));
        var result = factory.solve(guillotine("javaguillotine"));
        assertEquals("FEASIBLE", result.status(), result.message());
        assertEquals("javaguillotine", result.engine());
        assertEquals("javaguillotine", result.requestedEngine());
        assertNull(result.fallbackReason());
    }

    @Test void legacyResponseCarriesActualEngineAndFallbackReasonWithAndWithoutGap() {
        var factory = new SolverFactory(List.of(missingNative(), new JavaGuillotineSolverEngine()));
        for (double gap : new double[]{0, 10}) {
            var request = new SolveRequest();
            request.setRollW(1000); request.setRollL(2000); request.setTotalRollL(10000);
            request.setCutOrigin("left-top"); request.setTimeLimitSeconds(1); request.setPieceGap(gap);
            request.setSolver("packingsolver");
            request.setDemands(List.of(new PieceDemand(1, "裁片", 400, 600, 2, false)));
            var response = FabricSolveAdapter.solve(factory, request);
            assertTrue(response.isSuccess(), response.getMessage());
            assertEquals("javaguillotine", response.getEngine(), "gap " + gap);
            assertEquals("packingsolver", response.getRequestedEngine(), "gap " + gap);
            assertNotNull(response.getFallbackReason(), "gap " + gap);
        }
    }

    @Test void runtimeNativeCrashFallsBackExplicitlyWhenAllowedAndRespectsDisabledFallback() {
        var crashingNative = new com.example.cutdemotwo.algorithm.nesting.ICutSolverEngine() {
            @Override public String getEngineType() { return "packingsolver"; }
            @Override public boolean isAvailable() { return true; }
            @Override public com.example.cutdemotwo.contracts.nesting.EngineCapabilities capabilities() {
                return new com.example.cutdemotwo.contracts.nesting.EngineCapabilities(
                        "packingsolver", "1", List.of("RECTANGLE"), List.of("GUILLOTINE"),
                        List.of("MAXIMIZE_PIECE_AREA"), 0.1, true);
            }
            @Override public com.example.cutdemotwo.algorithm.nesting.EngineResult solve(NestingProblem p) {
                var r = new com.example.cutdemotwo.algorithm.nesting.EngineResult();
                r.setSuccess(false);
                r.setFailureStatus("FAILED");
                r.setMessage("模拟原生进程 OOM 退出码 137");
                return r;
            }
        };
        var factory = new SolverFactory(List.of(crashingNative, new JavaGuillotineSolverEngine()));
        var ok = factory.solve(guillotine("packingsolver"), true);
        assertEquals("FEASIBLE", ok.status(), ok.message());
        assertEquals("javaguillotine", ok.engine());
        assertEquals("packingsolver", ok.requestedEngine());
        assertNotNull(ok.fallbackReason());
        assertTrue(ok.fallbackReason().contains("137"), ok.fallbackReason());

        var noFallback = factory.solve(guillotine("packingsolver"), false);
        assertEquals("FAILED", noFallback.status());
        assertEquals("packingsolver", noFallback.engine());
        assertNull(noFallback.fallbackReason());
    }

    private IrregularPackingSolverService missingNativeIrregular() {
        var engine = new IrregularPackingSolverService();
        ReflectionTestUtils.setField(engine, "solverPath", temp.resolve("missing-packingsolver-irregular.exe").toString());
        return engine;
    }

    static NestingProblem contour(String engine) {
        return new NestingProblem("1", "mm",
                new NestingProblem.Material("sheet", NestingProblem.Shape.rectangle(1000, 600), List.of(), false),
                List.of(new NestingProblem.Part(7, "part", NestingProblem.Shape.rectangle(400, 300), 2, false)),
                new NestingProblem.Process("CONTOUR", "SHEET", "left-top", "none", 0, 0, 0, 0,
                        "MAXIMIZE_PIECE_AREA"), engine, 1);
    }

    @Test void contourAutoRoutesDirectlyToDeepnestWithoutFallback() {
        var factory = new SolverFactory(List.of(missingNativeIrregular(), new DeepnestSolverEngine()));
        for (String requested : List.of("auto", "")) {
            var result = factory.solve(contour(requested));
            assertEquals("FEASIBLE", result.status(), result.message());
            assertEquals(2, result.placements().size());
            assertEquals("deepnest", result.engine());
            assertEquals("deepnest", result.requestedEngine());
            assertNull(result.fallbackReason());
        }
    }

    @Test void missingNativeIrregularFallsBackExplicitlyToDeepnestAndRespectsDisabledFallback() {
        var factory = new SolverFactory(List.of(missingNativeIrregular(), new DeepnestSolverEngine()));
        assertEquals("deepnest", factory.fallbackFor("packingsolver-irregular"));
        var result = factory.solve(contour("packingsolver-irregular"));
        assertEquals("FEASIBLE", result.status(), result.message());
        assertEquals(2, result.placements().size());
        assertEquals("deepnest", result.engine());
        assertEquals("packingsolver-irregular", result.requestedEngine());
        assertNotNull(result.fallbackReason());
        assertTrue(result.fallbackReason().contains("deepnest"), result.fallbackReason());

        var noFallback = factory.solve(contour("packingsolver-irregular"), false);
        assertEquals("UNAVAILABLE", noFallback.status());
        assertEquals("packingsolver-irregular", noFallback.engine());
        assertNull(noFallback.fallbackReason());
    }
}
