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
    private static final Path CHANGYANG_ROOT = Path.of("src/main/java/changyang");
    private static final Path LINEAR_RESOURCES = Path.of("src/main/resources/linear");
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

    @Test void configStaysInfrastructureOnly() throws IOException {
        assertBoundary("config", Set.of("config"));
    }

    @Test void controllersStayInHttpLayerAndNeverTouchLegacyLinearOrStoreImplementations() throws IOException {
        assertBoundary("controller", Set.of("controller", "business", "algorithm", "contracts", "persistence", "config"));
        var errors = new ArrayList<String>();
        for (var file : javaFiles(ROOT.resolve("controller"))) {
            for (var ref : persistenceMemberReferences(Files.readString(file))) {
                if (!"InventoryConflictException".equals(ref)) {
                    errors.add(file + " -> persistence." + ref);
                }
            }
        }
        assertTrue(errors.isEmpty(), "控制器禁止直接依赖持久化实现类（仅允许捕获 InventoryConflictException）：\n" + String.join("\n", errors));
    }

    @Test void persistenceDoesNotDependOnControllersAlgorithmsOrBusinessServices() throws IOException {
        assertBoundary("persistence", Set.of("persistence", "business", "contracts"));
        // 持久化层严禁反向依赖 business.optimization / business.cutting / business.integration 等任何业务服务包，
        // 仅允许引用 business.model 数据模型（作业共享文档与异常已迁入 contracts.jobs）。
        var errors = new ArrayList<String>();
        for (var file : javaFiles(ROOT.resolve("persistence"))) {
            for (var ref : businessSubReferences(Files.readString(file))) {
                if (ref.startsWith("model.")) continue;
                errors.add(file + " -> business." + ref);
            }
        }
        assertTrue(errors.isEmpty(), "持久化层严禁越层依赖业务服务或 business.optimization：\n" + String.join("\n", errors));
    }

    @Test void changyangReferencesStayStrictlyInsideSlittingKernel() throws IOException {
        assertFalse(Files.exists(ROOT.resolve("linear")), "旧一维兼容宿主目录 linear/ 已移除，不得重新引入");
        var errors = new ArrayList<String>();
        for (var file : javaFiles(ROOT)) {
            String rel = ROOT.relativize(file).toString().replace('\\', '/');
            for (var ref : changyangReferences(Files.readString(file))) {
                if (rel.startsWith("algorithm/slitting/")) {
                    // 标准一维适配层仅允许引用 changyang 纯计算内核，严禁引用 rest/excel/recut 越层包
                    boolean allowedKernel = ref.startsWith("changyang.cut.apsmodule.")
                            && !ref.startsWith("changyang.cut.apsmodule.service.excel.")
                            && !ref.startsWith("changyang.cut.apsmodule.recut.");
                    if (!allowedKernel) errors.add(rel + " -> " + ref);
                } else {
                    errors.add(rel + " -> " + ref);
                }
            }
        }
        assertTrue(errors.isEmpty(), "除 algorithm/slitting/ 纯内核适配层外严禁引用 changyang.*：\n" + String.join("\n", errors));
    }

    @Test void changyangKernelStaysPureWithoutLegacyHostsOrForbiddenDependencies() throws IOException {
        assertFalse(Files.exists(LINEAR_RESOURCES), "旧一维 Excel 模板资源目录 src/main/resources/linear 已移除，不得重新引入");
        List<String> forbiddenSubdirs = List.of(
                "cut/rest",
                "cut/util",
                "cut/apsmodule/service/excel",
                "cut/apsmodule/recut"
        );
        for (String sub : forbiddenSubdirs) {
            assertFalse(Files.exists(CHANGYANG_ROOT.resolve(sub)),
                    "changyang 内核区严禁重新引入旧宿主目录：" + sub);
        }

        var errors = new ArrayList<String>();
        for (var file : javaFiles(CHANGYANG_ROOT)) {
            String rel = CHANGYANG_ROOT.relativize(file).toString().replace('\\', '/');
            for (String sub : forbiddenSubdirs) {
                if (rel.startsWith(sub + "/")) {
                    errors.add(rel + " 位于禁止的旧宿主包 " + sub + "/");
                }
            }
            for (var ref : changyangForbiddenDependencies(Files.readString(file))) {
                errors.add(rel + " -> " + ref);
            }
        }
        assertTrue(errors.isEmpty(),
                "changyang 一维纯计算内核严禁引用 POI、Spring Web、Servlet 或反向依赖主工程 com.example.cutdemotwo.*：\n"
                        + String.join("\n", errors));
    }

    private static final Pattern PERSISTENCE_MEMBER_REF = Pattern.compile(
            "\\bcom\\.example\\.cutdemotwo\\.persistence\\.([A-Za-z0-9_*]+)");
    private static final Pattern BUSINESS_SUB_REF = Pattern.compile(
            "\\bcom\\.example\\.cutdemotwo\\.business\\.([a-z][a-z0-9_]*\\.[A-Za-z0-9_*]+)");
    private static final Pattern CHANGYANG_REF = Pattern.compile(
            "\\b(changyang\\.[A-Za-z0-9_.*]+)");
    private static final Pattern CHANGYANG_FORBIDDEN_DEP = Pattern.compile(
            "\\b((?:org\\.apache\\.poi|org\\.springframework\\.web|jakarta\\.servlet|javax\\.servlet|com\\.example\\.cutdemotwo)\\.[A-Za-z0-9_.*]+)");

    private static String stripComments(String source) {
        return source.replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("(?m)//[^\\n]*", "");
    }

    private static List<Path> javaFiles(Path dir) throws IOException {
        try (var stream = Files.walk(dir)) {
            var files = stream.filter(p -> p.toString().endsWith(".java")).toList();
            assertFalse(files.isEmpty(), "模块未被扫描，不能以零文件通过：" + dir);
            return files;
        }
    }

    private static List<String> persistenceMemberReferences(String source) {
        var result = new ArrayList<String>();
        var matcher = PERSISTENCE_MEMBER_REF.matcher(stripComments(source));
        while (matcher.find()) result.add(matcher.group(1));
        return result;
    }

    private static List<String> businessSubReferences(String source) {
        var result = new ArrayList<String>();
        var matcher = BUSINESS_SUB_REF.matcher(stripComments(source));
        while (matcher.find()) result.add(matcher.group(1));
        return result;
    }

    private static List<String> changyangReferences(String source) {
        var result = new ArrayList<String>();
        var matcher = CHANGYANG_REF.matcher(stripComments(source));
        while (matcher.find()) result.add(matcher.group(1));
        return result;
    }

    private static List<String> changyangForbiddenDependencies(String source) {
        var result = new ArrayList<String>();
        var matcher = CHANGYANG_FORBIDDEN_DEP.matcher(stripComments(source));
        while (matcher.find()) result.add(matcher.group(1));
        return result;
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
        assertAlgorithmBoundary("algorithm/nesting", Set.of("nesting", "api", "geometry", "toolpath", "runtime"));
        assertAlgorithmBoundary("algorithm/slitting", Set.of("slitting", "api", "runtime"));
        assertAlgorithmBoundary("algorithm/toolpath", Set.of("toolpath", "api", "geometry"));
        assertAlgorithmBoundary("algorithm/runtime", Set.of("runtime"));
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

    @Test void extendedGuardsCatchPersistenceControllerAndChangyangViolations() {
        assertEquals(List.of("JdbcInventoryStore"),
                persistenceMemberReferences("import com.example.cutdemotwo.persistence.JdbcInventoryStore;"));
        assertEquals(List.of("cutting.RemnantService"),
                businessSubReferences("import com.example.cutdemotwo.business.cutting.RemnantService;"));
        assertEquals(List.of("optimization.StoredOptimizationJob", "optimization.OptimizationService"),
                businessSubReferences("import com.example.cutdemotwo.business.optimization.StoredOptimizationJob;\n"
                        + "import com.example.cutdemotwo.business.optimization.OptimizationService;"));
        assertEquals(List.of("changyang.cut.rest.CuttingExportController"),
                changyangReferences("import changyang.cut.rest.CuttingExportController;"));
        assertTrue(changyangReferences("// changyang.cut.rest.Example").isEmpty());
        assertEquals(List.of(
                        "org.apache.poi.xssf.usermodel.XSSFWorkbook",
                        "org.springframework.web.bind.annotation.RestController",
                        "jakarta.servlet.http.HttpServletResponse",
                        "com.example.cutdemotwo.business.cutting.RemnantService"),
                changyangForbiddenDependencies(
                        "import org.apache.poi.xssf.usermodel.XSSFWorkbook;\n"
                                + "import org.springframework.web.bind.annotation.RestController;\n"
                                + "import jakarta.servlet.http.HttpServletResponse;\n"
                                + "com.example.cutdemotwo.business.cutting.RemnantService svc;\n"
                                + "// org.apache.poi.ss.usermodel.Workbook\n"));
        assertTrue(changyangForbiddenDependencies(
                "import org.springframework.stereotype.Component;\n"
                        + "import com.google.ortools.linearsolver.MPSolver;\n").isEmpty());
    }
}
