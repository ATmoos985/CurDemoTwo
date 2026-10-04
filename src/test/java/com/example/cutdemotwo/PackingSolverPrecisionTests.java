package com.example.cutdemotwo;

import com.example.cutdemotwo.model.Defect;
import com.example.cutdemotwo.model.PieceDemand;
import com.example.cutdemotwo.model.SolveRequest;
import com.example.cutdemotwo.model.nesting.NestingProblem;
import com.example.cutdemotwo.service.FabricSolveAdapter;
import com.example.cutdemotwo.service.PackingSolverService;
import com.example.cutdemotwo.service.solver.SolverFactory;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class PackingSolverPrecisionTests {
    private final PackingSolverService engine = new PackingSolverService();
    private final SolverFactory kernel = new SolverFactory(List.of(engine));

    PackingSolverPrecisionTests() {
        ReflectionTestUtils.setField(engine, "solverPath", System.getenv().getOrDefault(
                "PACKINGSOLVER_PATH", "data/solver/packingsolver_rectangleguillotine.exe"));
    }

    @Test void fabric893292FirstStationAcceptsItsOriginalFractionalDefect() {
        assertTrue(engine.isAvailable(), "Native solver is required for this regression");
        SolveRequest request = new SolveRequest();
        request.setRollW(2800); request.setRollL(5000); request.setTotalRollL(100000);
        request.setCutOrigin("right-bottom"); request.setTimeLimitSeconds(2);
        request.setDefects(List.of(new Defect(1, 2118.8, 3630.6, 144.1, 180.2, 20)));
        int[][] sizes = {{2170,3250,2},{2170,3570,2},{2220,1620,1},{2715,2930,4},
                {2220,2260,2},{2220,2260,1},{2220,2930,1},{1603,2260,4},
                {1500,3250,2},{2640,4470,2},{2660,2355,2},{400,1600,4},{180,800,6},{450,450,4}};
        var demands = new java.util.ArrayList<PieceDemand>();
        for (int i = 0; i < sizes.length; i++) demands.add(new PieceDemand(i + 1, "demand-" + i,
                sizes[i][0], sizes[i][1], sizes[i][2], false));
        request.setDemands(demands);
        var result = FabricSolveAdapter.solve(kernel, request);
        assertTrue(result.isSuccess(), result.getMessage());
        assertFalse(result.getPieces().isEmpty());
        assertFalse(result.getCuts().isEmpty());
        assertEquals(14, result.getTotalArea(), 1e-8);
        assertEquals(result.getTotalArea(), result.getPieceArea() + result.getRemArea() + result.getWasteArea(), 1e-8);
        for (var p : result.getPieces()) assertTrue(p.getX() + p.getW() <= 2098.8 + 1e-7
                || p.getX() >= 2282.9 - 1e-7 || p.getY() + p.getL() <= 3610.6 + 1e-7
                || p.getY() >= 3830.8 - 1e-7, "Piece must avoid the original defect plus margin");
        assertEquals(2118.8, request.getDefects().get(0).getX(), "Input must stay unchanged");
    }

    @Test void fractionalSheetAndTrimRoundTripInMillimetersAtEveryOrigin() {
        assertTrue(engine.isAvailable());
        for (String origin : List.of("left-top", "right-top", "left-bottom", "right-bottom")) {
            var result = kernel.solve(problem(600.5, 800.7, 600.5, 200.2, false, 10.1, origin));
            assertTrue(result.feasible(), origin + ": " + result.message());
            var placed = result.placements().get(0);
            assertEquals(600.5, placed.shape().width(), 1e-8);
            assertEquals(200.2, placed.shape().height(), 1e-8);
            assertFalse(result.cuts().isEmpty());
            assertFalse(result.leftovers().isEmpty());
            assertEquals(600.5 * 800.7, result.metrics().processingAreaMm2(), 1e-8);
            assertEquals(600.5 * 200.2, result.metrics().pieceAreaMm2(), 1e-8);
        }
    }

    @Test void fractionalPartCanRotateWithoutChangingItsPhysicalSize() {
        var result = kernel.solve(problem(300.3, 500.5, 500.5, 300.3, true, 0, "right-top"));
        assertTrue(result.feasible(), result.message());
        assertEquals(90, result.placements().get(0).rotationDegrees());
        assertEquals(300.3, result.placements().get(0).shape().width(), 1e-8);
        assertEquals(500.5, result.placements().get(0).shape().height(), 1e-8);
    }

    @Test void hundredthMillimeterStillFailsInsteadOfBeingRounded() {
        var result = kernel.solve(problem(600, 800, 200.01, 300, false, 0, "left-top"));
        assertEquals("UNSUPPORTED", result.status());
        assertTrue(result.placements().isEmpty());
    }

    private NestingProblem problem(double width, double height, double partWidth, double partHeight,
                                   boolean rotation, double trim, String origin) {
        return new NestingProblem("1", "mm",
                new NestingProblem.Material("sheet", NestingProblem.Shape.rectangle(width, height), List.of(), false),
                List.of(new NestingProblem.Part(1, "part", NestingProblem.Shape.rectangle(partWidth, partHeight), 1, rotation)),
                new NestingProblem.Process("GUILLOTINE", "SHEET", origin, "horizontal", trim, 20, 20, 0,
                        "MAXIMIZE_PIECE_AREA"), "packingsolver", 1);
    }
}
