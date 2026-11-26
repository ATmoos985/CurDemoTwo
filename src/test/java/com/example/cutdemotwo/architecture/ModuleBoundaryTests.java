package com.example.cutdemotwo.architecture;

import org.junit.jupiter.api.Test;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
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

    @Test void cuttingKernelAndVerticalDomainServicesStayAcyclicAndSynchronizedFree() throws IOException {
        Path cuttingDir = ROOT.resolve("business/cutting");
        List<String> verticalServices = List.of(
                "RollAndRemnantDomainService",
                "FactoryDocumentDomainService",
                "CuttingTaskDomainService",
                "CuttingExecutionAndReportService"
        );
        var errors = new ArrayList<String>();

        // 1. InventoryStateKernel 严禁反向依赖 RemnantService 或任何上层垂直服务
        String kernelCode = stripComments(Files.readString(cuttingDir.resolve("InventoryStateKernel.java")));
        for (String forbidden : List.of("RemnantService", "RollAndRemnantDomainService",
                "FactoryDocumentDomainService", "CuttingTaskDomainService", "CuttingExecutionAndReportService")) {
            if (Pattern.compile("\\b" + forbidden + "\\b").matcher(kernelCode).find()) {
                errors.add("InventoryStateKernel 禁止反向依赖 " + forbidden);
            }
        }

        // 2. 四个垂直领域服务彼此零相互依赖，且均严禁反向依赖 RemnantService
        for (String self : verticalServices) {
            String code = stripComments(Files.readString(cuttingDir.resolve(self + ".java")));
            if (Pattern.compile("\\bRemnantService\\b").matcher(code).find()) {
                errors.add(self + " 禁止反向依赖 RemnantService");
            }
            for (String other : verticalServices) {
                if (!self.equals(other) && Pattern.compile("\\b" + other + "\\b").matcher(code).find()) {
                    errors.add(self + " 禁止同级耦合依赖 " + other);
                }
            }
        }

        // 3. RemnantService 门面与 CuttingWorkflowService 须保持零 synchronized（统一由 InventoryStateKernel 读写锁管理）
        String facadeCode = stripComments(Files.readString(cuttingDir.resolve("RemnantService.java")));
        if (Pattern.compile("\\bsynchronized\\b").matcher(facadeCode).find()) {
            errors.add("RemnantService 门面禁止出现 synchronized 关键字");
        }
        String workflowCode = stripComments(Files.readString(cuttingDir.resolve("CuttingWorkflowService.java")));
        if (Pattern.compile("\\bsynchronized\\b").matcher(workflowCode).find()) {
            errors.add("CuttingWorkflowService 禁止残留 synchronized 关键字");
        }

        assertTrue(errors.isEmpty(), "阶段 B 垂直解耦门禁失败：\n" + String.join("\n", errors));
    }

    private static final Pattern PACKAGE_DECL = Pattern.compile("(?m)^\\s*package\\s+[\\w.]+\\s*;");
    private static final Pattern TWO_LEVEL_SUBPACKAGE_REF = Pattern.compile(
            "\\bcom\\.example\\.cutdemotwo\\.((?:[a-z][a-z0-9_]*\\.)*)(?:[A-Z][A-Za-z0-9_]*|\\*)");

    @Test void businessClassesOutsideModelStayStrictlyAcyclic() throws IOException {
        Path businessRoot = ROOT.resolve("business");
        Map<String, String> classPkg = new TreeMap<>();
        Map<String, String> classSimple = new TreeMap<>();
        Map<String, String> classCode = new TreeMap<>();

        for (Path file : javaFiles(businessRoot)) {
            String rel = businessRoot.relativize(file).toString().replace('\\', '/');
            String[] parts = rel.split("/");
            if (parts.length < 2 || "model".equals(parts[0])) continue;
            String subPkg = String.join(".", java.util.Arrays.copyOf(parts, parts.length - 1));
            String simple = parts[parts.length - 1].replaceFirst("\\.java$", "");
            String node = subPkg + "." + simple;
            String sanitized = PACKAGE_DECL.matcher(stripCommentsAndStrings(Files.readString(file))).replaceFirst("");
            classPkg.put(node, subPkg);
            classSimple.put(node, simple);
            classCode.put(node, sanitized);
        }

        assertTrue(classCode.size() >= 20, "业务服务类扫描数量异常偏少，禁止空跑通过：" + classCode.size());

        Map<String, Set<String>> graph = new TreeMap<>();
        for (String from : classCode.keySet()) {
            graph.put(from, new TreeSet<>());
        }

        for (String from : classCode.keySet()) {
            String code = classCode.get(from);
            String fromPkg = classPkg.get(from);
            for (String to : classCode.keySet()) {
                if (from.equals(to)) continue;
                String toPkg = classPkg.get(to);
                String toSimple = classSimple.get(to);
                boolean depends;
                if (fromPkg.equals(toPkg)) {
                    depends = Pattern.compile("\\b" + Pattern.quote(toSimple) + "\\b").matcher(code).find();
                } else {
                    String fqcn = "com.example.cutdemotwo.business." + toPkg + "." + toSimple;
                    boolean directRef = Pattern.compile("\\b" + Pattern.quote(fqcn) + "\\b").matcher(code).find();
                    boolean wildcardRef = Pattern.compile(
                                    "\\bimport\\s+com\\.example\\.cutdemotwo\\.business\\." + Pattern.quote(toPkg) + "\\.\\*\\s*;")
                            .matcher(code).find()
                            && Pattern.compile("\\b" + Pattern.quote(toSimple) + "\\b").matcher(code).find();
                    depends = directRef || wildcardRef;
                }
                if (depends) {
                    graph.get(from).add(to);
                }
            }
        }

        List<List<String>> cycles = tarjanCycles(graph);
        if (!cycles.isEmpty()) {
            var details = new ArrayList<String>();
            for (List<String> scc : cycles) {
                List<String> path = findCyclePath(scc, graph);
                details.add("循环路径: " + String.join(" -> ", path) + " | 强连通分量成员: " + scc);
            }
            fail("全仓 business.*（不含 business.model）检测到类级循环依赖（Tarjan SCC）：\n"
                    + String.join("\n", details));
        }
    }

    @Test void twoLevelSubpackagesAcrossWholeRepositoryStayStrictlyAcyclic() throws IOException {
        List<Path> allFiles = javaFiles(ROOT);
        assertTrue(allFiles.size() >= 50, "全仓源文件扫描数量异常偏少：" + allFiles.size());

        Map<String, Set<String>> graph = new TreeMap<>();
        Map<String, List<String>> edgeEvidence = new LinkedHashMap<>();

        for (Path file : allFiles) {
            String rel = ROOT.relativize(file).toString().replace('\\', '/');
            String fromPkg = twoLevelSubpackageOf(rel);
            graph.computeIfAbsent(fromPkg, k -> new TreeSet<>());
            for (String toPkg : extractTwoLevelTargets(Files.readString(file))) {
                if (fromPkg.equals(toPkg)) continue;
                graph.get(fromPkg).add(toPkg);
                graph.computeIfAbsent(toPkg, k -> new TreeSet<>());
                edgeEvidence.computeIfAbsent(fromPkg + "->" + toPkg, k -> new ArrayList<>()).add(rel);
            }
        }

        for (String required : List.of(
                "contracts.common", "contracts.jobs", "contracts.nesting", "contracts.slitting", "contracts.geometry",
                "business.cutting", "business.optimization", "business.integration", "business.model")) {
            assertTrue(graph.containsKey(required), "2 级子包门禁未覆盖关键子包：" + required);
        }

        List<List<String>> cycles = tarjanCycles(graph);
        if (!cycles.isEmpty()) {
            var details = new ArrayList<String>();
            for (List<String> scc : cycles) {
                List<String> path = findCyclePath(scc, graph);
                var edgeNotes = new ArrayList<String>();
                for (int i = 0; i < path.size() - 1; i++) {
                    String edgeKey = path.get(i) + "->" + path.get(i + 1);
                    List<String> files = edgeEvidence.getOrDefault(edgeKey, List.of());
                    edgeNotes.add(edgeKey + " (" + (files.isEmpty() ? "?" : files.get(0)) + ")");
                }
                details.add("子包循环路径: " + String.join(" -> ", path) + " | 跨包证据: " + String.join("; ", edgeNotes));
            }
            fail("全仓 2 级子包检测到循环依赖（Tarjan SCC）：\n" + String.join("\n", details));
        }
    }

    @Test void tarjanCycleDetectorCatchesClassAndSubpackageCycles() {
        Map<String, Set<String>> cyclic = new TreeMap<>();
        cyclic.put("a", new TreeSet<>(Set.of("b")));
        cyclic.put("b", new TreeSet<>(Set.of("c")));
        cyclic.put("c", new TreeSet<>(Set.of("a", "d")));
        cyclic.put("d", new TreeSet<>());

        List<List<String>> sccs = tarjanCycles(cyclic);
        assertEquals(1, sccs.size());
        assertEquals(List.of("a", "b", "c"), sccs.get(0));
        assertEquals(List.of("a", "b", "c", "a"), findCyclePath(sccs.get(0), cyclic));

        Map<String, Set<String>> acyclic = new TreeMap<>();
        acyclic.put("contracts.jobs", new TreeSet<>(Set.of("contracts.nesting", "contracts.slitting", "contracts.common")));
        acyclic.put("contracts.nesting", new TreeSet<>(Set.of("contracts.common")));
        acyclic.put("contracts.slitting", new TreeSet<>(Set.of("contracts.common")));
        acyclic.put("contracts.common", new TreeSet<>());
        assertTrue(tarjanCycles(acyclic).isEmpty());

        String sample = """
                package com.example.cutdemotwo.contracts.jobs;
                import com.example.cutdemotwo.contracts.common.OptimizationProblem;
                import com.example.cutdemotwo.contracts.nesting.*;
                import static com.example.cutdemotwo.business.cutting.DefectWindowSupport.sliceForWindow;
                // com.example.cutdemotwo.contracts.slitting.SlittingProblem
                class Demo {
                    String ignored = "com.example.cutdemotwo.controller.OptimizationController";
                    Object x = com.example.cutdemotwo.persistence.InventoryConflictException.class;
                    void f() { com.example.cutdemotwo.algorithm.ComputationCancellation.check(); }
                }
                """;
        assertEquals(
                Set.of("contracts.common", "contracts.nesting", "business.cutting", "persistence", "algorithm"),
                extractTwoLevelTargets(sample));
    }

    private static String twoLevelSubpackageOf(String relPath) {
        String[] parts = relPath.split("/");
        if (parts.length >= 3) return parts[0] + "." + parts[1];
        if (parts.length == 2) return parts[0];
        return "root";
    }

    private static Set<String> extractTwoLevelTargets(String source) {
        String cleaned = PACKAGE_DECL.matcher(stripCommentsAndStrings(source)).replaceFirst("");
        Set<String> targets = new TreeSet<>();
        var matcher = TWO_LEVEL_SUBPACKAGE_REF.matcher(cleaned);
        while (matcher.find()) {
            String pkgChain = matcher.group(1);
            if (pkgChain == null || pkgChain.isEmpty()) {
                targets.add("root");
                continue;
            }
            String[] segs = pkgChain.split("\\.");
            if (segs.length >= 2) {
                targets.add(segs[0] + "." + segs[1]);
            } else if (segs.length == 1 && !segs[0].isEmpty()) {
                targets.add(segs[0]);
            }
        }
        return targets;
    }

    /** 剥离注释与字符串/文本块字面量，防止注释示例或日志文本触发源码依赖误报。 */
    private static String stripCommentsAndStrings(String source) {
        StringBuilder out = new StringBuilder(source.length());
        int n = source.length();
        int i = 0;
        while (i < n) {
            char c = source.charAt(i);
            if (c == '/' && i + 1 < n && source.charAt(i + 1) == '/') {
                i += 2;
                while (i < n && source.charAt(i) != '\n') i++;
                continue;
            }
            if (c == '/' && i + 1 < n && source.charAt(i + 1) == '*') {
                i += 2;
                while (i + 1 < n && !(source.charAt(i) == '*' && source.charAt(i + 1) == '/')) {
                    if (source.charAt(i) == '\n') out.append('\n');
                    i++;
                }
                i = Math.min(n, i + 2);
                out.append(' ');
                continue;
            }
            if (c == '"' && i + 2 < n && source.charAt(i + 1) == '"' && source.charAt(i + 2) == '"') {
                i += 3;
                while (i + 2 < n && !(source.charAt(i) == '"' && source.charAt(i + 1) == '"' && source.charAt(i + 2) == '"')) {
                    if (source.charAt(i) == '\\' && i + 1 < n) {
                        i += 2;
                        continue;
                    }
                    if (source.charAt(i) == '\n') out.append('\n');
                    i++;
                }
                i = Math.min(n, i + 3);
                out.append("\"\"");
                continue;
            }
            if (c == '"') {
                i++;
                while (i < n && source.charAt(i) != '"') {
                    if (source.charAt(i) == '\\' && i + 1 < n) {
                        i += 2;
                        continue;
                    }
                    i++;
                }
                i = Math.min(n, i + 1);
                out.append("\"\"");
                continue;
            }
            if (c == '\'') {
                i++;
                while (i < n && source.charAt(i) != '\'') {
                    if (source.charAt(i) == '\\' && i + 1 < n) {
                        i += 2;
                        continue;
                    }
                    i++;
                }
                i = Math.min(n, i + 1);
                out.append("''");
                continue;
            }
            out.append(c);
            i++;
        }
        return out.toString();
    }

    /** 标准 Tarjan 强连通分量算法：返回全部节点数 >= 2 的循环强连通分量（字典序确定性输出）。 */
    private static List<List<String>> tarjanCycles(Map<String, Set<String>> graph) {
        Map<String, Integer> indexMap = new HashMap<>();
        Map<String, Integer> lowlink = new HashMap<>();
        Set<String> onStack = new HashSet<>();
        ArrayDeque<String> stack = new ArrayDeque<>();
        List<List<String>> cycles = new ArrayList<>();
        int[] nextIndex = {0};

        for (String node : new TreeSet<>(graph.keySet())) {
            if (!indexMap.containsKey(node)) {
                strongConnect(node, graph, indexMap, lowlink, onStack, stack, nextIndex, cycles);
            }
        }
        return cycles;
    }

    private static void strongConnect(
            String v,
            Map<String, Set<String>> graph,
            Map<String, Integer> indexMap,
            Map<String, Integer> lowlink,
            Set<String> onStack,
            ArrayDeque<String> stack,
            int[] nextIndex,
            List<List<String>> cycles
    ) {
        int idx = nextIndex[0]++;
        indexMap.put(v, idx);
        lowlink.put(v, idx);
        stack.push(v);
        onStack.add(v);

        for (String w : graph.getOrDefault(v, Set.of())) {
            if (!graph.containsKey(w)) continue;
            if (!indexMap.containsKey(w)) {
                strongConnect(w, graph, indexMap, lowlink, onStack, stack, nextIndex, cycles);
                lowlink.put(v, Math.min(lowlink.get(v), lowlink.get(w)));
            } else if (onStack.contains(w)) {
                lowlink.put(v, Math.min(lowlink.get(v), indexMap.get(w)));
            }
        }

        if (lowlink.get(v).equals(indexMap.get(v))) {
            List<String> component = new ArrayList<>();
            while (true) {
                String w = stack.pop();
                onStack.remove(w);
                component.add(w);
                if (w.equals(v)) break;
            }
            if (component.size() > 1) {
                Collections.sort(component);
                cycles.add(component);
            }
        }
    }

    /** 在已知强连通分量内通过 BFS 提取最短闭合环路径，便于报错精准定位。 */
    private static List<String> findCyclePath(List<String> scc, Map<String, Set<String>> graph) {
        Set<String> members = new HashSet<>(scc);
        String start = scc.get(0);
        ArrayDeque<List<String>> queue = new ArrayDeque<>();
        Set<String> visited = new HashSet<>();
        for (String next : graph.getOrDefault(start, Set.of())) {
            if (!members.contains(next)) continue;
            List<String> path = new ArrayList<>();
            path.add(start);
            path.add(next);
            if (next.equals(start)) return path;
            queue.add(path);
            visited.add(next);
        }
        while (!queue.isEmpty()) {
            List<String> current = queue.poll();
            String tail = current.get(current.size() - 1);
            for (String next : graph.getOrDefault(tail, Set.of())) {
                if (!members.contains(next)) continue;
                if (next.equals(start)) {
                    List<String> closed = new ArrayList<>(current);
                    closed.add(start);
                    return closed;
                }
                if (visited.add(next)) {
                    List<String> extended = new ArrayList<>(current);
                    extended.add(next);
                    queue.add(extended);
                }
            }
        }
        return scc;
    }
}
