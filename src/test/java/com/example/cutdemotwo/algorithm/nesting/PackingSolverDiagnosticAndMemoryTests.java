package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** P0-4 回归测试：验证原生矩形求解器 --memory-limit 参数透传/边界截断及 solver.log 尾部 4KB 诊断摘录。 */
class PackingSolverDiagnosticAndMemoryTests {
    @TempDir Path temp;

    private static NestingProblem sampleGuillotine() {
        return new NestingProblem("1", "mm",
                new NestingProblem.Material("sheet", NestingProblem.Shape.rectangle(1000, 600), List.of(), false),
                List.of(new NestingProblem.Part(1, "part", NestingProblem.Shape.rectangle(400, 300), 2, false)),
                new NestingProblem.Process("GUILLOTINE", "SHEET", "left-top", "horizontal", 0, 200, 300, 0,
                        "MAXIMIZE_PIECE_AREA"),
                "packingsolver", 2);
    }

    @Test
    void commandPassesMemoryLimitWithSafeClampBounds() {
        var engine = new PackingSolverService();
        ReflectionTestUtils.setField(engine, "solverPath", "packingsolver_rectangleguillotine");
        File cert = temp.resolve("certificate.csv").toFile();

        List<String> defaultCmd = ReflectionTestUtils.invokeMethod(engine, "command", sampleGuillotine(),
                temp.resolve("items.csv").toFile(), temp.resolve("bins.csv").toFile(), temp.resolve("defects.csv").toFile(), cert);
        assertNotNull(defaultCmd);
        assertEquals("512", defaultCmd.get(defaultCmd.indexOf("--memory-limit") + 1));

        ReflectionTestUtils.setField(engine, "memoryLimitMb", 256);
        List<String> configuredCmd = ReflectionTestUtils.invokeMethod(engine, "command", sampleGuillotine(),
                temp.resolve("items.csv").toFile(), temp.resolve("bins.csv").toFile(), temp.resolve("defects.csv").toFile(), cert);
        assertNotNull(configuredCmd);
        assertEquals("256", configuredCmd.get(configuredCmd.indexOf("--memory-limit") + 1));

        ReflectionTestUtils.setField(engine, "memoryLimitMb", 32);
        List<String> lowClamped = ReflectionTestUtils.invokeMethod(engine, "command", sampleGuillotine(),
                temp.resolve("items.csv").toFile(), temp.resolve("bins.csv").toFile(), temp.resolve("defects.csv").toFile(), cert);
        assertNotNull(lowClamped);
        assertEquals("128", lowClamped.get(lowClamped.indexOf("--memory-limit") + 1));

        ReflectionTestUtils.setField(engine, "memoryLimitMb", 99999);
        List<String> highClamped = ReflectionTestUtils.invokeMethod(engine, "command", sampleGuillotine(),
                temp.resolve("items.csv").toFile(), temp.resolve("bins.csv").toFile(), temp.resolve("defects.csv").toFile(), cert);
        assertNotNull(highClamped);
        assertEquals("4096", highClamped.get(highClamped.indexOf("--memory-limit") + 1));
    }

    @Test
    void readLogTailExtractsLatest4KBFromOversizedSolverLogAndHandlesMissingFiles() throws Exception {
        assertEquals("", PackingSolverService.readLogTail(null, 4096));
        assertEquals("", PackingSolverService.readLogTail(temp.resolve("missing.log"), 4096));

        Path logFile = temp.resolve("solver.log");
        String content = "X".repeat(8192) + "\nERROR_TAIL_DIAGNOSTIC_MARKER";
        Files.writeString(logFile, content, StandardCharsets.UTF_8);

        String tail = PackingSolverService.readLogTail(logFile, PackingSolverService.DIAGNOSTIC_LOG_TAIL_BYTES);
        assertTrue(tail.length() <= PackingSolverService.DIAGNOSTIC_LOG_TAIL_BYTES);
        assertTrue(tail.endsWith("ERROR_TAIL_DIAGNOSTIC_MARKER"), tail);
        assertFalse(tail.startsWith("X".repeat(5000)));
    }
}
