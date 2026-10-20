package com.example.cutdemotwo;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.algorithm.solver.PackingSolverService;
import com.example.cutdemotwo.algorithm.solver.SolverFactory;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.io.File;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.IntStream;

import static org.junit.jupiter.api.Assertions.*;

/** The native solver writes its certificate once, when it exits, instead of rewriting it on every improvement. */
class PackingSolverCertificateWriteTests {
    @TempDir Path temp;

    @Test void commandAsksForTheCertificateOnlyAtTheEnd() {
        var engine = new PackingSolverService();
        ReflectionTestUtils.setField(engine, "solverPath", "packingsolver_rectangleguillotine");
        File certificate = temp.resolve("certificate.csv").toFile();
        List<String> command = ReflectionTestUtils.invokeMethod(engine, "command", NativeSolverFallbackTests.guillotine("packingsolver"),
                temp.resolve("items.csv").toFile(), temp.resolve("bins.csv").toFile(), temp.resolve("defects.csv").toFile(), certificate);
        assertNotNull(command);
        assertEquals(certificate.getAbsolutePath(), command.get(command.indexOf("--certificate") + 1));
        assertTrue(command.contains("--only-write-at-the-end"), String.join(" ", command));
    }

    /** The benchmark's synthetic2000: 10 sizes x 200 copies on a 2000 x 60000 mm continuous region with two defects. */
    @Test void largeInstanceSearchIsNotThrottledByCertificateRewrites() {
        var engine = new PackingSolverService();
        ReflectionTestUtils.setField(engine, "solverPath", System.getenv().getOrDefault(
                "PACKINGSOLVER_PATH", "data/solver/packingsolver_rectangleguillotine.exe"));
        org.junit.jupiter.api.Assumptions.assumeTrue(engine.isAvailable(), "Native solver is required for this regression");
        int[][] sizes = {{300, 400}, {250, 500}, {200, 300}, {350, 450}, {150, 600}, {400, 400}, {220, 330}, {180, 240}, {500, 260}, {320, 280}};
        var parts = IntStream.range(0, sizes.length).mapToObj(i -> new NestingProblem.Part(i + 1, "规格" + (i + 1),
                NestingProblem.Shape.rectangle(sizes[i][0], sizes[i][1]), 200, i % 2 == 0)).toList();
        var defects = List.of(new NestingProblem.Exclusion(1, 700, 12000, NestingProblem.Shape.rectangle(120, 80), 20),
                new NestingProblem.Exclusion(2, 1500, 41000, NestingProblem.Shape.rectangle(60, 300), 20));
        var result = new SolverFactory(List.of(engine)).solve(new NestingProblem("1", "mm",
                new NestingProblem.Material("SYNTH-2000", NestingProblem.Shape.rectangle(2000, 60000), defects, true), parts,
                new NestingProblem.Process("GUILLOTINE", "CONTINUOUS", "right-top", "horizontal", 0, 100, 100, 0, "MAXIMIZE_PIECE_AREA"),
                "packingsolver", 1));
        assertTrue(result.feasible(), result.message());
        assertEquals("packingsolver", result.engine());
        // On Windows, rewriting the certificate after each improvement placed 141–169 pieces in this second;
        // writing it once at exit placed 785, and already 375 after 0.1 s.
        assertTrue(result.placements().size() >= 400, "placed " + result.placements().size() + " of 2000 in 1 s");
    }
}
