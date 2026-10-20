package com.example.cutdemotwo;

import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import com.example.cutdemotwo.algorithm.solver.PackingSolverService;
import com.example.cutdemotwo.algorithm.solver.EngineResult;
import com.example.cutdemotwo.algorithm.solver.SolverFactory;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** Each demand is one native item type with COPIES; placed pieces map back to their demand with unique ids. */
class PackingSolverItemTypeTests {
    @TempDir Path temp;

    private static final List<NestingProblem.Part> PARTS = List.of(
            new NestingProblem.Part(7, "甲", NestingProblem.Shape.rectangle(300, 200), 3, false),
            new NestingProblem.Part(9, "乙", NestingProblem.Shape.rectangle(200, 400), 1, true));

    @Test void itemsFileHasOneRowPerDemandWithItsCopies() throws Exception {
        Path items = temp.resolve("items.csv");
        List<?> itemTypes = ReflectionTestUtils.invokeMethod(PackingSolverService.class, "writeItems", items.toFile(), PARTS);
        assertEquals(List.of("ID,WIDTH,HEIGHT,COPIES,STACK_ID,ORIENTED", "0,3000,2000,3,0,1", "1,2000,4000,1,1,0"),
                Files.readAllLines(items));
        assertEquals(PARTS, itemTypes);
    }

    @Test void copiesSharingOneCertificateTypeMapBackToTheirDemandWithUniqueIds() throws Exception {
        Path certificate = temp.resolve("certificate.csv");
        Files.writeString(certificate, """
                PLATE_ID,NODE_ID_PARENT,NODE_ID,X,Y,WIDTH,HEIGHT,TYPE,CUT,PARENT
                0,0,0,0,0,10000,10000,-2,0,
                0,0,1,0,0,3000,2000,0,1,0
                0,0,2,3000,0,3000,2000,0,1,0
                0,0,3,6000,0,4000,2000,1,1,0
                0,0,4,0,2000,3000,2000,0,1,0
                """);
        var problem = new NestingProblem("1", "mm",
                new NestingProblem.Material("sheet", NestingProblem.Shape.rectangle(1000, 1000), List.of(), false),
                PARTS, new NestingProblem.Process("GUILLOTINE", "SHEET", "left-top", "horizontal",
                0, 100, 100, 0, "MAXIMIZE_PIECE_AREA"), "packingsolver", 1);
        EngineResult result = ReflectionTestUtils.invokeMethod(new PackingSolverService(), "parseCertificate",
                certificate.toFile(), problem, PARTS);
        assertNotNull(result);
        List<PlacedPiece> pieces = result.getPieces();
        assertEquals(List.of(0, 1, 3, 2), pieces.stream().map(PlacedPiece::getId).toList(),
                "Copies take the ids of their demand's range in certificate order");
        assertEquals(List.of(7, 7, 9, 7), pieces.stream().map(PlacedPiece::getDemandId).toList());
        assertEquals(List.of("甲", "甲", "乙", "甲"), pieces.stream().map(PlacedPiece::getName).toList());
        assertEquals(List.of(false, false, true, false), pieces.stream().map(PlacedPiece::isRotated).toList());
    }

    @Test void nativeSolverPlacesEveryCopyWithUniqueIdsThatPassValidation() {
        PackingSolverService engine = new PackingSolverService();
        ReflectionTestUtils.setField(engine, "solverPath", System.getenv().getOrDefault(
                "PACKINGSOLVER_PATH", "data/solver/packingsolver_rectangleguillotine.exe"));
        org.junit.jupiter.api.Assumptions.assumeTrue(engine.isAvailable(), "Native solver is required for this regression");
        var result = new SolverFactory(List.of(engine)).solve(new NestingProblem("1", "mm",
                new NestingProblem.Material("sheet", NestingProblem.Shape.rectangle(2000, 1500), List.of(), false),
                List.of(new NestingProblem.Part(1, "方片", NestingProblem.Shape.rectangle(500, 500), 6, false),
                        new NestingProblem.Part(2, "条片", NestingProblem.Shape.rectangle(1000, 250), 2, false)),
                new NestingProblem.Process("GUILLOTINE", "SHEET", "left-top", "horizontal", 0, 100, 100, 0,
                        "MAXIMIZE_PIECE_AREA"), "packingsolver", 2));
        assertTrue(result.feasible(), result.message());
        assertEquals("packingsolver", result.engine());
        assertEquals(8, result.placements().size());
        assertEquals(8, new HashSet<>(result.placements().stream().map(NestingResult.Placement::id).toList()).size());
        for (var f : result.fulfillment()) assertEquals(f.requested(), f.placed(), "demand " + f.demandId());
        assertEquals(6, result.placements().stream().filter(p -> p.demandId() == 1 && "方片".equals(p.name())).count());
    }
}
