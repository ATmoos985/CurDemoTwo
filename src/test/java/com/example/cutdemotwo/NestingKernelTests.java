package com.example.cutdemotwo;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.model.nesting.*;
import com.example.cutdemotwo.service.CrossCutSolverService;
import com.example.cutdemotwo.service.FabricSolveAdapter;
import com.example.cutdemotwo.service.solver.*;
import org.junit.jupiter.api.Test;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class NestingKernelTests {
    private final SolverFactory kernel = new SolverFactory(List.of(new CrossCutSolverService()));

    static NestingProblem problem() {
        return new NestingProblem("1", "mm",
                new NestingProblem.Material("board-A", NestingProblem.Shape.rectangle(2000, 3000), List.of(), false),
                List.of(new NestingProblem.Part(42, "part-A", NestingProblem.Shape.rectangle(2000, 1200), 3, false)),
                new NestingProblem.Process("CROSSCUT", "SHEET", "left-top", "horizontal", 0, 200, 300, 0, "INPUT_ORDER"),
                "auto", 3);
    }
    static NestingProblem change(NestingProblem p, NestingProblem.Material material, List<NestingProblem.Part> parts,
                                 NestingProblem.Process process, String engine) {
        return new NestingProblem(p.schemaVersion(), p.unit(), material, parts, process, engine, p.timeLimitSeconds());
    }

    @Test void standaloneSolveReportsPartialFulfillmentWithExplicitAreaUnits() {
        var result = kernel.solve(problem());
        assertEquals("FEASIBLE", result.status());
        assertEquals("board-A", result.materialId());
        assertEquals("source-local-top-left", result.coordinateSystem());
        assertEquals(2, result.placements().size());
        assertEquals(new NestingResult.Fulfillment(42, 3, 2, 1, "NOT_PLACED_IN_THIS_SOLUTION"), result.fulfillment().get(0));
        assertEquals(6_000_000, result.metrics().processingAreaMm2());
        assertEquals(4_800_000, result.metrics().pieceAreaMm2());
        assertEquals(1_200_000, result.metrics().reusableAreaMm2());
        assertEquals(0, result.metrics().unassignedAreaMm2());
    }

    @Test void noSolutionIsNotClaimedAsInfeasibleAndRetainsUnmetDemand() {
        var p = problem();
        var parts = List.of(new NestingProblem.Part(42, "too-long", NestingProblem.Shape.rectangle(2000, 4000), 1, false));
        var result = kernel.solve(change(p, p.material(), parts, p.process(), "auto"));
        assertEquals("NO_SOLUTION_FOUND", result.status());
        assertEquals(1, result.fulfillment().get(0).unplaced());
        assertEquals("board-A", result.materialId());
        assertTrue(result.placements().isEmpty());
    }

    @Test void unknownAndPresetEnginesNeverSilentlyFallBack() {
        var p = problem();
        for (String engine : List.of("typo", "preset", "packingsolver"))
            assertEquals("UNSUPPORTED", kernel.solve(change(p, p.material(), p.parts(), p.process(), engine)).status());
    }

    @Test void polygonAndUnsupportedProcessAreRejectedBeforeSolving() {
        var p = problem();
        var polygon = new NestingProblem.Shape("POLYGON", 2000, 3000, List.of(new NestingProblem.Point(0, 0)));
        assertEquals("UNSUPPORTED", kernel.solve(change(p, new NestingProblem.Material("P", polygon, List.of(), false), p.parts(), p.process(), "auto")).status());
        var process = new NestingProblem.Process("CONTOUR", "SHEET", "left-top", "horizontal", 0, 200, 300, 0, "INPUT_ORDER");
        assertEquals("UNSUPPORTED", kernel.solve(change(p, p.material(), p.parts(), process, "auto")).status());
        process = new NestingProblem.Process("CROSSCUT", "SHEET", "left-top", "horizontal", 0, 200, 300, 2, "INPUT_ORDER");
        assertEquals("UNSUPPORTED", kernel.solve(change(p, p.material(), p.parts(), process, "auto")).status());
        process = new NestingProblem.Process("CROSSCUT", "SHEET", "left-top", "horizontal", 0, 200, 300, 0, "MINIMIZE_CUTS");
        assertEquals("UNSUPPORTED", kernel.solve(change(p, p.material(), p.parts(), process, "auto")).status());
    }

    @Test void invalidGeometryDuplicateIdsAndExcessiveQuantitiesAreRejected() {
        var p = problem();
        assertEquals("INVALID_INPUT", kernel.solve(change(p, p.material(), List.of(p.parts().get(0), p.parts().get(0)), p.process(), "auto")).status());
        var bad = new NestingProblem.Part(42, "bad", NestingProblem.Shape.rectangle(Double.NaN, 1000), 1, false);
        assertEquals("INVALID_INPUT", kernel.solve(change(p, p.material(), List.of(bad), p.process(), "auto")).status());
        bad = new NestingProblem.Part(42, "bad", NestingProblem.Shape.rectangle(2000, 1000), 10001, false);
        assertEquals("INVALID_INPUT", kernel.solve(change(p, p.material(), List.of(bad), p.process(), "auto")).status());
    }

    @Test void fabricAdapterRemovesTaskAndGlobalWindowState() {
        SolveRequest legacy = new SolveRequest();
        legacy.setTaskId("task-do-not-send"); legacy.setTaskRevision(18);
        legacy.setWindowStartY(5000); legacy.setAllowLongitudinal(false);
        legacy.setDemands(List.of(new PieceDemand(42, "curtain", 2000, 1200, 1, false)));
        var first = FabricSolveAdapter.toProblem(legacy);
        legacy.setTaskId("other-task"); legacy.setTaskRevision(99); legacy.setWindowStartY(10000);
        assertEquals(first, FabricSolveAdapter.toProblem(legacy));
        var result = FabricSolveAdapter.solve(kernel, legacy);
        assertTrue(result.isSuccess());
        assertEquals(0, result.getPieces().get(0).getY());
        assertTrue(kernel.solve(first).feasible());
        assertEquals(10000, legacy.getWindowStartY(), "solver must not mutate workflow input");
    }

    @Test void sheetResultHasGeometryButBusinessAdapterAloneMakesRollDeductionZero() {
        SolveRequest legacy = new SolveRequest();
        legacy.setFeedPortType("remnant"); legacy.setSourceRemnantId("stock-A"); legacy.setAllowLongitudinal(false);
        legacy.setRollL(3000); legacy.setDemands(List.of(new PieceDemand(42, "part", 2000, 1200, 1, false)));
        var result = FabricSolveAdapter.solve(kernel, legacy);
        assertTrue(result.isSuccess());
        assertEquals(0, result.getDeductLen());
        assertEquals("stock-A", result.getSourceRemnantId());
        assertTrue(kernel.solve(FabricSolveAdapter.toProblem(legacy)).metrics().suggestedFeedLengthMm() > 0);
    }

    @Test void independentValidationRejectsOverlappingOrOversizedEngineOutput() {
        EngineResult output = new EngineResult(); output.setSuccess(true);
        output.setPieces(List.of(new PlacedPiece(1, "part", 0, 0, 2000, 1200, false, 42),
                new PlacedPiece(2, "part", 0, 100, 2000, 1200, false, 42)));
        assertEquals("INVALID_RESULT", fake(output).solve(problem()).status());
        output.setPieces(List.of(new PlacedPiece(1, "part", 0, 2000, 2000, 1200, false, 42)));
        assertEquals("INVALID_RESULT", fake(output).solve(problem()).status());
        output.setPieces(List.of(new PlacedPiece(1, "part", 0, 0, 1000, 1200, false, 42)));
        assertEquals("INVALID_RESULT", fake(output).solve(problem()).status());
    }

    @Test void independentValidationRejectsDefectCollision() {
        var p = problem();
        var material = new NestingProblem.Material("board-A", p.material().shape(),
                List.of(new NestingProblem.Exclusion(1, 500, 500, NestingProblem.Shape.rectangle(100, 100), 20)), false);
        EngineResult output = new EngineResult(); output.setSuccess(true);
        output.setPieces(List.of(new PlacedPiece(1, "part", 0, 0, 2000, 1200, false, 42)));
        assertEquals("INVALID_RESULT", fake(output).solve(change(p, material, p.parts(), p.process(), "auto")).status());
    }

    @Test void crosscutHonorsRightTopToolHomeAndDeclaredPrecision() {
        var p = problem();
        var process = new NestingProblem.Process("CROSSCUT", "SHEET", "right-top", "horizontal", 0, 200, 300, 0, "INPUT_ORDER");
        var parts = List.of(new NestingProblem.Part(42, "part", NestingProblem.Shape.rectangle(2000, 1200.1), 1, false));
        var result = kernel.solve(change(p, p.material(), parts, process, "auto"));
        assertTrue(result.feasible(), result.message());
        assertEquals(2000, result.cuts().get(0).startX());
        assertEquals(1200.1, result.cuts().get(0).airDistanceMm(), .001);
        parts = List.of(new NestingProblem.Part(42, "too-precise", NestingProblem.Shape.rectangle(2000, 1200.01), 1, false));
        assertEquals("UNSUPPORTED", kernel.solve(change(p, p.material(), parts, process, "auto")).status());
    }

    private SolverFactory fake(EngineResult output) {
        return new SolverFactory(List.of(new ICutSolverEngine() {
            public String getEngineType() { return "crosscut"; }
            public boolean isAvailable() { return true; }
            public EngineCapabilities capabilities() { return new CrossCutSolverService().capabilities(); }
            public EngineResult solve(NestingProblem p) { return output; }
        }));
    }
}
