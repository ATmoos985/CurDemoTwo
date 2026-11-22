package com.example.cutdemotwo.algorithm;

import changyang.cut.apsmodule.generator.NewSolver.config.SolverRuntimeProperties;
import changyang.cut.apsmodule.generator.NewSolver.report.SolveReportWriter;
import com.example.cutdemotwo.algorithm.geometry.EngineGeometry;
import com.example.cutdemotwo.algorithm.nesting.EngineResult;
import com.example.cutdemotwo.algorithm.nesting.JavaGuillotineSolverEngine;
import com.example.cutdemotwo.algorithm.nesting.PackingSolverService;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class Phase0ConsistencyTests {

    @TempDir
    Path tempDir;

    @Test
    void startCornerDefaultMatchesAcrossGuillotineEngines() throws Exception {
        assertEquals("right-top", EngineGeometry.normalizeStartCorner(null));
        assertEquals("right-top", EngineGeometry.normalizeStartCorner("  "));
        assertEquals("right-bottom", EngineGeometry.normalizeStartCorner(" Right-Bottom "));

        // Sheet 1000x1000 with one 400x300 piece: under right-top, piece lands at x=600, y=0 (no Y mirror).
        var sheetNullCorner = new NestingProblem(
                "1", "mm",
                new NestingProblem.Material("sheet", NestingProblem.Shape.rectangle(1000, 1000), List.of(), false),
                List.of(new NestingProblem.Part(1, "P1", NestingProblem.Shape.rectangle(400, 300), 1, false)),
                new NestingProblem.Process("GUILLOTINE", "SHEET", null, "horizontal", 0, 100, 100, 0, "MAXIMIZE_PIECE_AREA"),
                "javaguillotine", 2
        );
        var javaResult = new JavaGuillotineSolverEngine().solve(sheetNullCorner);
        assertTrue(javaResult.isSuccess());
        assertEquals(1, javaResult.getPieces().size());
        var javaPiece = javaResult.getPieces().get(0);
        assertEquals(600.0, javaPiece.getX(), EngineGeometry.COORDINATE_EPS_MM);
        assertEquals(0.0, javaPiece.getY(), EngineGeometry.COORDINATE_EPS_MM);

        // Native PackingSolverService parseCertificate with the same null startCorner places at the same (600, 0).
        Path cert = tempDir.resolve("cert.csv");
        Files.writeString(cert, """
                PLATE_ID,NODE_ID_PARENT,NODE_ID,X,Y,WIDTH,HEIGHT,TYPE,CUT,PARENT
                0,0,1,0,0,4000,3000,0,1,
                """);
        EngineResult nativeResult = ReflectionTestUtils.invokeMethod(
                new PackingSolverService(), "parseCertificate",
                cert.toFile(), sheetNullCorner, sheetNullCorner.parts());
        assertNotNull(nativeResult);
        assertEquals(1, nativeResult.getPieces().size());
        var nativePiece = nativeResult.getPieces().get(0);
        assertEquals(javaPiece.getX(), nativePiece.getX(), EngineGeometry.COORDINATE_EPS_MM);
        assertEquals(javaPiece.getY(), nativePiece.getY(), EngineGeometry.COORDINATE_EPS_MM);
    }

    @Test
    void javaGuillotineHonorsMinReusableDimensionsBelow100mm() {
        // 500x500 sheet with one 420x500 piece leaves an 80x500 side remnant.
        var problem = new NestingProblem(
                "1", "mm",
                new NestingProblem.Material("sheet", NestingProblem.Shape.rectangle(500, 500), List.of(), false),
                List.of(new NestingProblem.Part(1, "P1", NestingProblem.Shape.rectangle(420, 500), 1, false)),
                new NestingProblem.Process("GUILLOTINE", "SHEET", "left-top", "horizontal", 0, 60, 60, 0, "MAXIMIZE_PIECE_AREA"),
                "javaguillotine", 2
        );
        var result = new JavaGuillotineSolverEngine().solve(problem);
        assertTrue(result.isSuccess());
        assertEquals(1, result.getRemnants().size(), "应按契约 60mm 下限回收 80x500 余料，不应被 100mm 硬编码吞掉");
        var rem = result.getRemnants().get(0);
        assertEquals(80.0, rem.getW(), EngineGeometry.COORDINATE_EPS_MM);
        assertEquals(500.0, rem.getL(), EngineGeometry.COORDINATE_EPS_MM);
    }

    @Test
    void sharedGeometryTolerancesPreserveExactSemantics() {
        assertEquals(0.001, EngineGeometry.COORDINATE_EPS_MM);
        assertEquals(0.001, EngineGeometry.AREA_EPS_MM2);
    }

    @Test
    void solveReportWriterDoesNotWriteDiskByDefaultAndWritesWhenExplicitlyEnabled() throws Exception {
        Path reportDir = tempDir.resolve("reports");
        SolverRuntimeProperties.withOverrides(Map.of(SolveReportWriter.LOG_DIR_PROPERTY, reportDir.toString()), () -> {
            try (SolveReportWriter report = SolveReportWriter.create()) {
                assertEquals("disabled", report.getFilePath());
                report.writeSummary(0);
            }
            return null;
        });
        assertFalse(Files.exists(reportDir), "默认关闭报告落盘时不应创建目录");

        Path createdFile = SolverRuntimeProperties.withOverrides(
                Map.of(
                        SolveReportWriter.ENABLED_PROPERTY, "true",
                        SolveReportWriter.LOG_DIR_PROPERTY, reportDir.toString()
                ),
                () -> {
                    try (SolveReportWriter report = SolveReportWriter.create()) {
                        assertNotEquals("disabled", report.getFilePath());
                        report.writeSummary(0);
                        return Path.of(report.getFilePath());
                    }
                });
        assertTrue(Files.isRegularFile(createdFile), "显式开启后应生成报告文件");
        assertTrue(Files.size(createdFile) > 0);
    }
}
