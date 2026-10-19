package com.example.cutdemotwo.service.solver;

import com.example.cutdemotwo.model.nesting.NestingProblem;
import com.example.cutdemotwo.model.nesting.NestingResult;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.Comparator;
import java.util.HashMap;
import static com.example.cutdemotwo.service.solver.NestingValidation.*;

/**
 * 排料求解策略工厂 (Strategy Factory)
 * 按显式能力分发标准问题，并统一核验和转换输出。引擎在应用启动时注册。
 * 原生引擎不可用时只在此处显式降级到已注册的替代引擎，结果始终标注实际运行的引擎和降级原因。
 */
@Service
public class SolverFactory {
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(SolverFactory.class);
    /** Native engine id → registered stand-in that may run, with a stated reason, while the native one is unavailable. */
    private static final Map<String, String> FALLBACKS = Map.of(
            "packingsolver", "javaguillotine",
            "packingsolver-irregular", "javairregular"
    );

    private final Map<String, ICutSolverEngine> engineMap = new ConcurrentHashMap<>();
    private final boolean fallbackEnabled;

    public SolverFactory(List<ICutSolverEngine> engines) {
        this(engines, true);
    }

    @Autowired
    public SolverFactory(List<ICutSolverEngine> engines,
                         @Value("${packingsolver.fallback.enabled:true}") boolean fallbackEnabled) {
        for (ICutSolverEngine engine : engines) {
            engineMap.put(engine.getEngineType().toLowerCase(), engine);
        }
        this.fallbackEnabled = fallbackEnabled;
    }

    /** The engine that will run instead of {@code engineType}, or null when it is available or has no usable stand-in. */
    public String fallbackFor(String engineType) {
        ICutSolverEngine engine = engineType == null ? null : engineMap.get(engineType.toLowerCase());
        if (!fallbackEnabled || engine == null || engine.isAvailable()) return null;
        ICutSolverEngine fallback = engineMap.get(FALLBACKS.getOrDefault(engine.getEngineType().toLowerCase(), ""));
        return fallback != null && fallback.isAvailable() ? fallback.getEngineType() : null;
    }

    public ICutSolverEngine getEngine(String solverType) {
        if (solverType == null || solverType.trim().isEmpty()) {
            solverType = "packingsolver";
        }
        ICutSolverEngine engine = engineMap.get(solverType.toLowerCase());
        return engine;
    }

    public List<EngineCapabilities> capabilities() {
        return engineMap.values().stream().map(ICutSolverEngine::capabilities)
                .sorted(Comparator.comparing(EngineCapabilities::id)).toList();
    }

    public NestingResult solve(NestingProblem problem) {
        long start = System.nanoTime();
        String selected = problem == null ? null : problem.engine();
        String requested = selected, fallbackReason = null;
        try {
            validate(problem);
            if (selected == null || selected.isBlank() || "auto".equals(selected))
                selected = switch (problem.process().mode()) {
                    case "CROSSCUT" -> "crosscut";
                    case "CONTOUR" -> "packingsolver-irregular";
                    default -> "packingsolver";
                };
            requested = selected;
            ICutSolverEngine engine = engineMap.get(selected);
            supported(engine != null, "系统未找到排料引擎: " + selected);
            checkSupport(problem, engine.capabilities());
            String fallback = fallbackFor(selected);
            if (fallback != null) {
                fallbackReason = requested + " 未就绪（原生可执行文件缺失或不可执行），本次由 " + fallback + " 求解";
                log.warn("Explicit engine fallback: {}", fallbackReason);
                selected = fallback;
                engine = engineMap.get(fallback);
                checkSupport(problem, engine.capabilities());
            }
            var capabilities = engine.capabilities();
            if ("CROSSCUT".equals(problem.process().mode())) {
                supported("horizontal".equals(problem.process().firstStageOrientation()), "横切策略仅支持水平首刀");
                for (var part : problem.parts()) require(Math.abs(part.shape().width() - problem.width()) < .001,
                        "横切需求必须等于材料幅宽");
            }
            if (!engine.isAvailable())
                return NestingResult.failure("UNAVAILABLE", "求解引擎尚未就绪", selected, requested, fallbackReason, elapsed(start));
            EngineResult result = engine.solve(problem);
            if (!result.isSuccess() && !"NO_SOLUTION_FOUND".equals(result.getFailureStatus()))
                return NestingResult.failure(result.getFailureStatus(), result.getMessage(), selected, requested, fallbackReason, elapsed(start));
            String error = "CONTOUR".equals(problem.process().mode()) ? PolygonResultValidator.validate(problem, result)
                    : !result.getPlacements().isEmpty() ? "矩形工艺不能混入轮廓候选结果" : RectangularResultValidator.validate(problem, result);
            if (error != null) return NestingResult.failure("INVALID_RESULT", error, selected, requested, fallbackReason, elapsed(start));
            return toResult(problem, result, selected, capabilities.version(), elapsed(start), requested, fallbackReason);
        } catch (Rejected error) {
            return NestingResult.failure(error.status, error.getMessage(), selected, requested, fallbackReason, elapsed(start));
        } catch (RuntimeException error) {
            log.error("Nesting engine or result conversion failed: {}", selected, error);
            return NestingResult.failure("FAILED", "求解执行或结果转换失败", selected, requested, fallbackReason, elapsed(start));
        }
    }

    private static void checkSupport(NestingProblem problem, EngineCapabilities capabilities) {
        supported(capabilities.modes().contains(problem.process().mode()), "所选引擎不支持请求的切割工艺");
        supported(capabilities.objectives().contains(String.valueOf(problem.process().objective())), "所选引擎不支持请求的优化目标");
        supported(capabilities.shapes().contains(problem.material().shape().type())
                && problem.parts().stream().allMatch(p -> capabilities.shapes().contains(p.shape().type()))
                && problem.material().exclusions().stream().allMatch(d -> capabilities.shapes().contains(d.shape().type())),
                "所选引擎不支持请求的几何类型");
        validatePrecision(problem, capabilities.coordinateResolutionMm());
    }

    private static long elapsed(long start) { return (System.nanoTime() - start) / 1_000_000; }

    public NestingResult validateAdjustment(NestingProblem problem, List<com.example.cutdemotwo.model.PlacedPiece> pieces) {
        long start = System.nanoTime();
        var result = ManualLayoutValidator.validate(problem, pieces);
        return toResult(problem, result, "manual-guillotine", "1", elapsed(start), "manual-guillotine", null);
    }

    private static void precision(double value, double resolution) {
        supported(Math.abs(value / resolution - Math.rint(value / resolution)) < .000001,
                "当前引擎的坐标分辨率为 " + resolution + " mm，不能静默舍入尺寸");
    }
    private static void validatePrecision(NestingProblem p, double resolution) {
        shapePrecision(p.material().shape(), resolution);
        precision(p.process().trimStart(), resolution);
        for (var part : p.parts()) shapePrecision(part.shape(), resolution);
        for (var d : p.material().exclusions()) {
            precision(d.x(), resolution); precision(d.y(), resolution); precision(d.clearance(), resolution);
            shapePrecision(d.shape(), resolution);
        }
    }
    private static void shapePrecision(NestingProblem.Shape shape, double resolution) {
        precision(shape.width(), resolution); precision(shape.height(), resolution);
        for (var point : shape.vertices()) { precision(point.x(), resolution); precision(point.y(), resolution); }
    }

    private static NestingResult toResult(NestingProblem problem, EngineResult result, String engine, String version, long elapsed,
                                          String requestedEngine, String fallbackReason) {
        boolean contour = "CONTOUR".equals(problem.process().mode());
        var placements = contour ? List.copyOf(result.getPlacements()) : result.getPieces().stream().map(p -> new NestingResult.Placement(p.getId(), p.getDemandId(),
                p.getName(), p.getX(), p.getY(), NestingProblem.Shape.rectangle(p.getW(), p.getL()), p.isRotated() ? 90 : 0)).toList();
        var leftovers = result.getRemnants().stream().map(r -> new NestingResult.Leftover(r.getId(), r.getX(), r.getY(),
                NestingProblem.Shape.rectangle(r.getW(), r.getL()), r.isHasDefect())).toList();
        var cuts = result.getCuts().stream().map(c -> {
            boolean horizontal = "横切".equals(c.getType());
            return new NestingResult.Cut(c.getStep(), horizontal ? "HORIZONTAL" : "VERTICAL",
                    c.getStartX() == null ? (horizontal ? c.getStart() : c.getPos()) : c.getStartX(),
                    c.getStartY() == null ? (horizontal ? c.getPos() : c.getStart()) : c.getStartY(),
                    c.getEndX() == null ? (horizontal ? c.getEnd() : c.getPos()) : c.getEndX(),
                    c.getEndY() == null ? (horizontal ? c.getPos() : c.getEnd()) : c.getEndY(),
                    c.getAirDistance() == null ? 0 : c.getAirDistance(), c.getDesc(), c.getStage());
        }).toList();
        Map<Integer, Integer> counts = new HashMap<>();
        placements.forEach(p -> counts.merge(p.demandId(), 1, Integer::sum));
        var fulfillment = problem.parts().stream().map(p -> {
            int placed = counts.getOrDefault(p.id(), 0);
            return new NestingResult.Fulfillment(p.id(), p.quantity(), placed, p.quantity() - placed,
                    placed == p.quantity() ? null : FulfillmentReason.unplaced(problem, p, "manual-guillotine".equals(engine)));
        }).toList();
        double area = PolygonGeometry.area(problem.material().shape());
        double pieces = placements.stream().mapToDouble(p -> PolygonGeometry.area(p.shape())).sum();
        double reusable = leftovers.stream().mapToDouble(p -> p.shape().width() * p.shape().height()).sum();
        return new NestingResult("1", "mm", "source-local-top-left", placements.isEmpty() ? "NO_SOLUTION_FOUND" : "FEASIBLE", result.getMessage(), engine, version, elapsed,
                problem.material().id(), problem.material().shape(), placements, leftovers, cuts, fulfillment,
                new NestingResult.Metrics(area, pieces, reusable, Math.max(0, area - pieces - reusable), contour ? 0 : result.getSuggestedFeedLength()),
                contour ? placements.stream().map(p -> new NestingResult.Contour(p.id(), PolygonGeometry.vertices(p.shape()).stream()
                        .map(v -> new NestingProblem.Point(v.x() + p.x(), v.y() + p.y())).toList(), true)).toList() : List.of(),
                requestedEngine, fallbackReason);
    }
}
