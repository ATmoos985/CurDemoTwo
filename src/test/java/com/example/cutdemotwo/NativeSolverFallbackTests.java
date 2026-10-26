package com.example.cutdemotwo;

import com.example.cutdemotwo.business.model.PieceDemand;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.business.cutting.FabricSolveAdapter;
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
}
