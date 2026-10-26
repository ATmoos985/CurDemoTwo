package com.example.cutdemotwo.architecture;

import org.junit.jupiter.api.Test;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import static org.junit.jupiter.api.Assertions.*;

/** Source-level dependency guard: also catches fully qualified references outside import statements. */
class ModuleBoundaryTests {
    private static final Path ROOT = Path.of("src/main/java/com/example/cutdemotwo");
    private static final Pattern REFERENCE = Pattern.compile("\\bcom\\.example\\.cutdemotwo\\.(\\w+)\\.");

    private static List<String> violations(String source, Set<String> allowed) {
        var result = new ArrayList<String>();
        // Avoid treating documentation examples as dependencies.
        String code = source.replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("(?m)//[^\\n]*", "");
        var matcher = REFERENCE.matcher(code);
        while (matcher.find()) if (!allowed.contains(matcher.group(1))) result.add(matcher.group());
        return result;
    }

    private void assertBoundary(String module, Set<String> allowed) throws IOException {
        List<Path> files;
        try (var stream = Files.walk(ROOT.resolve(module))) {
            files = stream.filter(p -> p.toString().endsWith(".java")).toList();
        }
        assertFalse(files.isEmpty(), "模块未被扫描，不能以零文件通过");
        var errors = new ArrayList<String>();
        for (var file : files) {
            for (var violation : violations(Files.readString(file), allowed))
                errors.add(file + " -> " + violation);
        }
        assertTrue(errors.isEmpty(), String.join("\n", errors));
    }

    @Test void contractsNeverDependOnAlgorithmsOrBusiness() throws IOException {
        assertBoundary("contracts", Set.of("contracts"));
    }

    @Test void algorithmsOnlyDependOnAlgorithmsAndContracts() throws IOException {
        assertBoundary("algorithm", Set.of("algorithm", "contracts"));
    }

    @Test void businessDoesNotDependOnControllersOrLegacyLinearHost() throws IOException {
        assertBoundary("business", Set.of("business", "algorithm", "contracts", "persistence"));
    }

    private static final Pattern ALGORITHM_REFERENCE = Pattern.compile(
            "\\bcom\\.example\\.cutdemotwo\\.algorithm\\.([a-z][a-z0-9_]*)\\.");

    private static List<String> algorithmViolations(String source, Set<String> allowed) {
        String code = source.replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("(?m)//[^\\n]*", "");
        var errors = new ArrayList<String>();
        var matcher = ALGORITHM_REFERENCE.matcher(code);
        while (matcher.find()) if (!allowed.contains(matcher.group(1))) errors.add(matcher.group());
        return errors;
    }

    private void assertAlgorithmBoundary(String module, Set<String> allowed) throws IOException {
        try (var stream = Files.walk(ROOT.resolve(module))) {
            var files = stream.filter(p -> p.toString().endsWith(".java")).toList();
            assertFalse(files.isEmpty(), "边界必须覆盖实际源文件");
            var errors = new ArrayList<String>();
            for (var file : files) for (var violation : algorithmViolations(Files.readString(file), allowed))
                errors.add(file + " -> " + violation);
            assertTrue(errors.isEmpty(), String.join("\n", errors));
        }
    }

    @Test void businessAndHttpUseAlgorithmApiOrPureGeometryOnly() throws IOException {
        assertAlgorithmBoundary("business", Set.of("api", "geometry"));
        assertAlgorithmBoundary("controller", Set.of("api", "geometry"));
    }

    @Test void publicAlgorithmApiAndGeometryDoNotDependOnImplementations() throws IOException {
        assertAlgorithmBoundary("algorithm/api", Set.of("api"));
        assertAlgorithmBoundary("algorithm/geometry", Set.of("geometry"));
    }

    @Test void oneAndTwoDimensionalImplementationsStayIndependent() throws IOException {
        assertAlgorithmBoundary("algorithm/nesting", Set.of("nesting", "api", "geometry", "toolpath"));
        assertAlgorithmBoundary("algorithm/slitting", Set.of("slitting", "api"));
        assertAlgorithmBoundary("algorithm/toolpath", Set.of("toolpath", "api", "geometry"));
    }

    @Test void implementationGuardCatchesWildcardAndInlineConstruction() {
        for (String source : List.of(
                "import com.example.cutdemotwo.algorithm.nesting.*;",
                "new com.example.cutdemotwo.algorithm.slitting.LinearSlittingSolverEngine();",
                "com.example.cutdemotwo.algorithm.nesting.SolverFactory.ProblemCheck result;"))
            assertFalse(algorithmViolations(source, Set.of("api", "geometry")).isEmpty());
        assertTrue(algorithmViolations("import com.example.cutdemotwo.algorithm.api.NestingSolver;",
                Set.of("api", "geometry")).isEmpty());
        assertTrue(algorithmViolations("com.example.cutdemotwo.algorithm.ComputationCancellation.check();",
                Set.of("api", "geometry")).isEmpty());
    }

    @Test void guardDetectsImportsWildcardAndInlineReferences() {
        for (String source : List.of(
                "import com.example.cutdemotwo.business.model.SolveRequest;",
                "import com.example.cutdemotwo.business.model.*;",
                "com.example.cutdemotwo.business.model.SolveRequest.validatePieceGap(1);")) {
            assertFalse(violations(source, Set.of("algorithm", "contracts")).isEmpty());
        }
        assertTrue(violations("// com.example.cutdemotwo.business.model.Example\n"
                + "import com.example.cutdemotwo.contracts.nesting.NestingProblem;",
                Set.of("contracts")).isEmpty());
    }
}
