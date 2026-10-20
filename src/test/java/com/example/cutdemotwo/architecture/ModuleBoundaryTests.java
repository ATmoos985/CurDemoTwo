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
