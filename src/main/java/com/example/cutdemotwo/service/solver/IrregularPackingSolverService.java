package com.example.cutdemotwo.service.solver;

import com.example.cutdemotwo.model.nesting.NestingProblem;
import com.example.cutdemotwo.model.nesting.NestingResult;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.TimeUnit;

/** Stateless adapter for PackingSolver's straight-edge irregular knapsack engine. */
@Service
public class IrregularPackingSolverService implements ICutSolverEngine {
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(IrregularPackingSolverService.class);
    private final JsonMapper json = new JsonMapper();
    @Value("${packingsolver.irregular.executable.path:data/solver/packingsolver_irregular.exe}")
    private String solverPath;

    @Override public String getEngineType() { return "packingsolver-irregular"; }
    @Override public boolean isAvailable() {
        return solverPath != null && !solverPath.isBlank() && Files.isRegularFile(Path.of(solverPath)) && Files.isExecutable(Path.of(solverPath));
    }
    @Override public EngineCapabilities capabilities() {
        return new EngineCapabilities(getEngineType(), "1", List.of("RECTANGLE", "POLYGON"), List.of("CONTOUR"),
                List.of("MAXIMIZE_PIECE_AREA"), .1, isAvailable());
    }
    @Override public EngineResult solve(NestingProblem problem) {
        if (!isAvailable()) return failure("UNAVAILABLE", "异形引擎尚未安装或不可执行");
        Path temp = null; Process process = null;
        try {
            temp = Files.createTempDirectory("ps_irregular_");
            Path input = temp.resolve("input.json"), certificate = temp.resolve("certificate.json");
            Files.writeString(input, json.writeValueAsString(nativeInput(problem)));
            process = new ProcessBuilder(Path.of(solverPath).toAbsolutePath().toString(), "--input", input.toString(),
                    "--certificate", certificate.toString(), "--time-limit", Integer.toString(problem.timeLimitSeconds()),
                    "--verbosity-level", "0", "--only-write-at-the-end", "--memory-limit", "512")
                    .redirectErrorStream(true).redirectOutput(temp.resolve("solver.log").toFile()).start();
            if (!process.waitFor(problem.timeLimitSeconds() + 5L, TimeUnit.SECONDS))
                return failure("FAILED", "异形求解超过时限，已终止");
            if (process.exitValue() != 0 || !Files.isRegularFile(certificate)) {
                log.warn("Irregular solver exited with code {}", process.exitValue());
                return failure("FAILED", "异形引擎未生成有效结果，请检查运行环境；退出码 " + process.exitValue());
            }
            try { return parseCertificate(json.readTree(certificate.toFile()), problem); }
            catch (RuntimeException invalid) {
                log.warn("Invalid irregular certificate", invalid);
                return failure("INVALID_RESULT", "异形引擎返回了无效轮廓");
            }
        } catch (Exception error) {
            if (error instanceof InterruptedException) Thread.currentThread().interrupt();
            log.error("Irregular solver execution failed", error);
            return failure("FAILED", "异形求解执行失败，请检查运行环境");
        } finally {
            if (process != null && process.isAlive()) {
                process.descendants().forEach(ProcessHandle::destroyForcibly); process.destroyForcibly();
                try { process.waitFor(2, TimeUnit.SECONDS); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
            }
            // Only this invocation's new temporary directory; Files.walk does not follow symlinks.
            if (temp != null) try (var files = Files.walk(temp)) {
                for (Path path : files.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
            } catch (IOException cleanup) { log.warn("Unable to clean irregular solver temporary files", cleanup); }
        }
    }
    private static EngineResult failure(String status, String message) {
        var result = new EngineResult(); result.setFailureStatus(status); result.setMessage(message); return result;
    }
    private static Map<String, Object> polygon(NestingProblem.Shape shape, double x, double y) {
        var points = new ArrayList<>(PolygonGeometry.vertices(shape));
        // Native geometry expects positive signed area. No physical mirroring is applied.
        if (PolygonGeometry.signedArea(points) < 0) Collections.reverse(points);
        var result = new LinkedHashMap<String, Object>(); result.put("type", "polygon");
        result.put("vertices", points.stream().map(p -> Map.of("x", p.x() + x, "y", p.y() + y)).toList());
        return result;
    }
    static Map<String, Object> nativeInput(NestingProblem p) {
        var bin = polygon(p.material().shape(), 0, 0); bin.put("copies", 1);
        bin.put("defects", p.material().exclusions().stream().map(d -> {
            var shape = d.clearance() == 0 ? d.shape() : NestingProblem.Shape.rectangle(d.shape().width() + 2*d.clearance(), d.shape().height() + 2*d.clearance());
            var defect = polygon(shape, d.x() - d.clearance(), d.y() - d.clearance());
            defect.put("defect_type", -1); defect.put("item_defect_minimum_spacing", 0); return defect;
        }).toList());
        var items = p.parts().stream().map(part -> {
            var item = polygon(part.shape(), 0, 0); item.put("copies", part.quantity()); item.put("profit", PolygonGeometry.area(part.shape()));
            item.put("allowed_rotations", (part.allowRotation() ? List.of(0, 90, 180, 270) : List.of(0)).stream()
                    .map(angle -> Map.of("start", angle, "end", angle, "mirror", false)).toList());
            return item;
        }).toList();
        return Map.of("objective", "knapsack", "bin_types", List.of(bin), "item_types", items);
    }
    static EngineResult parseCertificate(JsonNode root, NestingProblem problem) {
        var result = new EngineResult(); result.setSuccess(true);
        // Upstream writes null when the solution contains no bins.
        if (root.isNull()) return result;
        var bins = root.path("bins"); check(bins.isArray() && bins.size() <= 1);
        for (var bin : bins) {
            check(integer(bin, "id") == 0 && integer(bin, "copies") == 1 && bin.path("items").isArray());
            for (var item : bin.path("items")) {
                int type = integer(item, "id"); check(type >= 0 && type < problem.parts().size());
                check(item.path("mirror").isBoolean() && !item.path("mirror").asBoolean());
                double angle = number(item, "angle"); check(Set.of(0d, 90d, 180d, 270d).contains(angle));
                var shapes = item.path("item_shapes"); check(shapes.isArray() && shapes.size() == 1);
                var outline = shapes.get(0); check(outline.path("holes").isMissingNode() || outline.path("holes").isEmpty());
                var edges = outline.path("shape"); check(edges.isArray() && edges.size() >= 3 && edges.size() <= 128);
                var points = new ArrayList<NestingProblem.Point>();
                for (int i = 0; i < edges.size(); i++) {
                    var edge = edges.get(i); var next = edges.get((i+1) % edges.size());
                    check("LineSegment".equals(edge.path("type").asText()));
                    check(Math.abs(number(edge, "xe") - number(next, "xs")) < 1e-7 && Math.abs(number(edge, "ye") - number(next, "ys")) < 1e-7);
                    points.add(new NestingProblem.Point(number(edge, "xs"), number(edge, "ys")));
                }
                double x = points.stream().mapToDouble(NestingProblem.Point::x).min().orElseThrow(), y = points.stream().mapToDouble(NestingProblem.Point::y).min().orElseThrow();
                double w = points.stream().mapToDouble(NestingProblem.Point::x).max().orElseThrow() - x, h = points.stream().mapToDouble(NestingProblem.Point::y).max().orElseThrow() - y;
                var shape = new NestingProblem.Shape("POLYGON", w, h, points.stream().map(v -> new NestingProblem.Point(v.x() - x, v.y() - y)).toList());
                var part = problem.parts().get(type);
                result.getPlacements().add(new NestingResult.Placement(result.getPlacements().size() + 1, part.id(), part.name(), x, y, shape, (int) angle));
            }
        }
        return result;
    }
    private static void check(boolean ok) { if (!ok) throw new IllegalArgumentException("Invalid irregular certificate"); }
    private static double number(JsonNode node, String name) {
        var field = node.path(name); check(field.isNumber() && Double.isFinite(field.asDouble())); return field.asDouble();
    }
    private static int integer(JsonNode node, String name) {
        var field = node.path(name); check(field.isIntegralNumber() && field.canConvertToInt()); return field.asInt();
    }
}
