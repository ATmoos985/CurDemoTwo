package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.algorithm.nesting.constraints.CurtainConstraintPack;

import com.example.cutdemotwo.contracts.nesting.EngineCapabilities;
import com.example.cutdemotwo.algorithm.api.NestingSolver;
import com.example.cutdemotwo.contracts.jobs.ProblemCheck;
import com.example.cutdemotwo.contracts.jobs.OptimizationRequest.InitialPlacement;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.ArrayList;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;
import java.util.concurrent.ConcurrentHashMap;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Set;
import static com.example.cutdemotwo.algorithm.geometry.NestingValidation.*;

/**
 * 排料求解策略工厂 (Strategy Factory)
 * 按显式能力分发标准问题，并统一核验和转换输出。引擎在应用启动时注册。
 * 原生引擎不可用时只在此处显式降级到已注册的替代引擎，结果始终标注实际运行的引擎和降级原因。
 */
@Service
public class SolverFactory implements NestingSolver {
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(SolverFactory.class);
    /** Native engine id → registered stand-in that may run, with a stated reason, while the native one is unavailable. */
    private static final Map<String, String> FALLBACKS = Map.of(
            "packingsolver", "javaguillotine",
            "packingsolver-irregular", "deepnest"
    );
    /** 原生 C++ 引擎尚未支持窗帘声明式约束，检测到窗帘规则时需跳过并路由至自主引擎。 */
    private static final Set<String> NATIVE_ENGINES_WITHOUT_CURTAIN_SUPPORT = Set.of(
            "packingsolver",
            "packingsolver-irregular"
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

    /** Validation/selection only: does not execute an engine or mutate business data. */
    private record Selection(String requested, ICutSolverEngine engine, String fallbackReason) {}

    private Selection select(NestingProblem problem, boolean allowFallback) {
        validate(problem);
        var curtainConstraints = CurtainConstraintPack.forProblem(problem);
        curtainConstraints.checkProblem(problem);
        boolean hasCurtainConstraints = !curtainConstraints.isNoop();
        String requested = problem.engine();
        boolean autoRequested = requested == null || requested.isBlank() || "auto".equals(requested);
        if (autoRequested)
            requested = switch (problem.process().mode()) {
                case "CROSSCUT" -> "crosscut";
                case "CONTOUR" -> "deepnest";
                default -> hasCurtainConstraints ? "javaguillotine" : "packingsolver";
            };
        String requestedLower = requested.toLowerCase();
        ICutSolverEngine engine;
        String reason = null;
        if (hasCurtainConstraints && NATIVE_ENGINES_WITHOUT_CURTAIN_SUPPORT.contains(requestedLower)) {
            String autonomousId = FALLBACKS.get(requestedLower);
            ICutSolverEngine autonomous = autonomousId == null ? null : engineMap.get(autonomousId);
            supported(allowFallback && autonomous != null && autonomous.isAvailable(),
                    requested + " 不支持窗帘工艺约束（布边/对花/疵点分级），请使用 " + autonomousId + " 或开启自动回退");
            reason = requested + " 不支持窗帘工艺约束，已自动跳过原生引擎并路由至 " + autonomous.getEngineType() + " 求解";
            log.info("窗帘约束自动路由：{}", reason);
            engine = autonomous;
            checkSupport(problem, engine.capabilities());
        } else {
            if (hasCurtainConstraints && autoRequested && "javaguillotine".equals(requestedLower)) {
                reason = "检测到窗帘工艺约束，已自动跳过不支持该约束的原生引擎 packingsolver，路由至 javaguillotine 求解";
                log.info("窗帘约束自动路由：{}", reason);
            }
            engine = engineMap.get(requestedLower);
            supported(engine != null, "系统未找到排料引擎: " + requested);
            checkSupport(problem, engine.capabilities());
            String fallback = allowFallback ? fallbackFor(requested) : null;
            if (fallback != null) {
                reason = requested + " 未就绪（原生可执行文件缺失或不可执行），本次由 " + fallback + " 求解";
                engine = engineMap.get(fallback);
                checkSupport(problem, engine.capabilities());
            }
        }
        if ("CROSSCUT".equals(problem.process().mode())) {
            supported("horizontal".equals(problem.process().firstStageOrientation()), "横切策略仅支持水平首刀");
            for (var part : problem.parts()) require(Math.abs(part.shape().width() - problem.width()) < .001,
                    "横切需求必须等于材料幅宽");
        }
        return new Selection(requested, engine, reason);
    }

    public ProblemCheck validateProblem(NestingProblem problem, boolean allowFallback) {
        try {
            var selected = select(problem, allowFallback);
            return new ProblemCheck(selected.engine().isAvailable() ? "VALID" : "UNAVAILABLE",
                    selected.engine().isAvailable() ? "输入与引擎能力检查通过；尚未求解" : "求解引擎尚未就绪",
                    selected.requested(), selected.engine().getEngineType(), selected.fallbackReason());
        } catch (Rejected error) { return new ProblemCheck(error.status, error.getMessage(), problem == null ? null : problem.engine(), null, null); }
    }

    public NestingResult solve(NestingProblem problem) { return solve(problem, true); }

    @Override
    public Optional<Function<NestingProblem, NestingResult>> stripSearch(NestingProblem problem, boolean allowFallback) {
        var engine = select(problem, allowFallback).engine();
        if (!(engine instanceof StripSearchCapable) || !engine.isAvailable())
            return Optional.empty();
        return Optional.of(candidate -> solve(candidate, false, true));
    }

    @Override
    public NestingResult validateMarkerSeed(NestingProblem problem, List<InitialPlacement> poses) {
        long start = System.nanoTime();
        if (poses == null || poses.isEmpty() || poses.size() != problem.parts().stream().mapToInt(NestingProblem.Part::quantity).sum())
            throw new IllegalArgumentException("初始排法必须包含全部齐套裁片");
        var demands = new HashMap<Integer, NestingProblem.Part>();
        problem.parts().forEach(part -> demands.put(part.id(), part));
        var placements = new ArrayList<NestingResult.Placement>();
        for (var pose : poses) {
            var part = pose == null ? null : demands.get(pose.demandId());
            if (part == null || pose.x() == null || pose.y() == null || pose.rotationDegrees() == null
                    || !Double.isFinite(pose.x()) || !Double.isFinite(pose.y()) || pose.x() < 0 || pose.y() < 0
                    || !part.contourAngles().contains(pose.rotationDegrees()))
                throw new IllegalArgumentException("初始排法的裁片、位置或方向无效");
            placements.add(new NestingResult.Placement(placements.size() + 1, part.id(), part.name(), pose.x(), pose.y(),
                    PolygonGeometry.rotate(part.shape(), pose.rotationDegrees()), pose.rotationDegrees()));
        }
        var candidate = new EngineResult();
        candidate.setSuccess(true);
        candidate.setPlacements(placements);
        String error = PolygonResultValidator.validate(problem, candidate);
        if (error != null) throw new IllegalArgumentException("初始排法未通过几何校验：" + error);
        return toResult(problem, candidate, "validated-seed", "1", elapsed(start), problem.engine(), null);
    }

    @Override
    public Optional<NestingResult> compactMarker(NestingProblem problem, NestingResult incumbent, long deadlineNanos) {
        long start = System.nanoTime();
        if (start >= deadlineNanos || !MarkerCompactor.supports(problem, incumbent.placements())) return Optional.empty();
        var placements = MarkerCompactor.compact(problem, incumbent.placements(), deadlineNanos);
        if (placements == incumbent.placements()) return Optional.of(incumbent);
        var candidate = new EngineResult();
        candidate.setSuccess(true);
        candidate.setPlacements(placements);
        if (PolygonResultValidator.validate(problem, candidate) != null) return Optional.of(incumbent);
        String engine = "validated-seed".equals(incumbent.engine()) ? "marker-compactor" : incumbent.engine();
        return Optional.of(toResult(problem, candidate, engine, incumbent.engineVersion(), elapsed(start),
                incumbent.requestedEngine(), incumbent.fallbackReason()));
    }

    @Override
    public List<NestingResult.Placement> fillMarkerGaps(NestingProblem problem, NestingResult incumbent,
                                                        Map<Integer, Integer> limits, long deadlineNanos) {
        if (System.nanoTime() >= deadlineNanos || limits.isEmpty() || !incumbent.feasible()
                || !"CONTOUR".equals(problem.process().mode()) || !MarkerCompactor.supportsGapSearch(problem))
            return List.of();
        var fixed = incumbent.placements();
        var baseCounts = new HashMap<Integer, Integer>();
        double length = 0;
        for (var piece : fixed) {
            baseCounts.merge(piece.demandId(), 1, Integer::sum);
            length = Math.max(length, piece.y() + piece.shape().height());
        }
        if (length <= 0 || length > problem.height() + .000001 || baseCounts.size() != problem.parts().size()
                || problem.parts().stream().anyMatch(p -> baseCounts.getOrDefault(p.id(), 0) != p.quantity()))
            return List.of();

        var extras = MarkerCompactor.fillGaps(problem, fixed, limits, length, deadlineNanos);
        if (extras.isEmpty()) return List.of();
        var counts = new HashMap<>(baseCounts);
        for (var extra : extras) counts.merge(extra.demandId(), 1, Integer::sum);
        var parts = problem.parts().stream().map(p -> new NestingProblem.Part(p.id(), p.name(), p.shape(),
                counts.get(p.id()), p.allowRotation(), p.allowHalfTurn(), p.rule())).toList();
        var material = new NestingProblem.Material(problem.material().id(), NestingProblem.Shape.rectangle(problem.width(), length),
                problem.material().exclusions(), problem.material().continuesAfterRegion(), problem.material().fabricRule());
        var filled = new NestingProblem(problem.schemaVersion(), problem.unit(), material, parts,
                problem.process(), problem.engine(), problem.timeLimitSeconds());
        var combined = new ArrayList<>(fixed);
        combined.addAll(extras);
        var candidate = new EngineResult();
        candidate.setPlacements(combined);
        return PolygonResultValidator.validate(filled, candidate) == null ? extras : List.of();
    }

    public NestingResult solve(NestingProblem problem, boolean allowFallback) {
        return solve(problem, allowFallback, false);
    }

    private NestingResult solve(NestingProblem problem, boolean allowFallback, boolean stripSearch) {
        long start = System.nanoTime();
        String selected = problem == null ? null : problem.engine();
        String requested = selected, fallbackReason = null;
        try {
            com.example.cutdemotwo.algorithm.ComputationCancellation.check();
            var selection = select(problem, allowFallback);
            ICutSolverEngine engine = selection.engine();
            requested = selection.requested(); selected = engine.getEngineType(); fallbackReason = selection.fallbackReason();
            if (fallbackReason != null) log.warn("Explicit engine fallback: {}", fallbackReason);
            var capabilities = engine.capabilities();
            if (!engine.isAvailable())
                return NestingResult.failure("UNAVAILABLE", "求解引擎尚未就绪", selected, requested, fallbackReason, elapsed(start));
            EngineResult result = stripSearch && engine instanceof StripSearchCapable stripCapable
                    ? stripCapable.solveStripCandidate(problem)
                    : engine.solve(problem);
            com.example.cutdemotwo.algorithm.ComputationCancellation.check();
            if (!result.isSuccess() && !"NO_SOLUTION_FOUND".equals(result.getFailureStatus())
                    && allowFallback && fallbackEnabled && fallbackReason == null) {
                String standInId = FALLBACKS.get(engine.getEngineType().toLowerCase());
                ICutSolverEngine standIn = standInId == null ? null : engineMap.get(standInId);
                if (standIn != null && standIn.isAvailable()) {
                    try {
                        checkSupport(problem, standIn.capabilities());
                        String cause = result.getMessage() != null && !result.getMessage().isBlank()
                                ? result.getMessage() : result.getFailureStatus();
                        log.warn("Runtime fallback from {} to {} after native failure: {}", selected, standInId, cause);
                        fallbackReason = requested + " 运行失败（" + cause + "），已自动降级由 " + standInId + " 求解";
                        engine = standIn;
                        selected = standIn.getEngineType();
                        capabilities = standIn.capabilities();
                        result = engine.solve(problem);
                        com.example.cutdemotwo.algorithm.ComputationCancellation.check();
                    } catch (Rejected unsupportedByStandIn) {
                        log.warn("Stand-in engine {} cannot handle problem after {} failed: {}",
                                standInId, selected, unsupportedByStandIn.getMessage());
                    }
                }
            }
            if (!result.isSuccess() && !"NO_SOLUTION_FOUND".equals(result.getFailureStatus()))
                return NestingResult.failure(result.getFailureStatus(), result.getMessage(), selected, requested, fallbackReason, elapsed(start));
            String error = "CONTOUR".equals(problem.process().mode()) ? PolygonResultValidator.validate(problem, result)
                    : !result.getPlacements().isEmpty() ? "矩形工艺不能混入轮廓候选结果" : RectangularResultValidator.validate(problem, result);
            if (error != null) return NestingResult.failure("INVALID_RESULT", error, selected, requested, fallbackReason, elapsed(start));
            com.example.cutdemotwo.algorithm.ComputationCancellation.check();
            return toResult(problem, result, selected, capabilities.version(), elapsed(start), requested, fallbackReason);
        } catch (java.util.concurrent.CancellationException cancelled) {
            return NestingResult.failure("CANCELLED", "计算已响应停止请求；未发布未经完整校验的结果", selected, requested, fallbackReason, elapsed(start));
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

    public NestingResult validateAdjustment(NestingProblem problem, List<com.example.cutdemotwo.contracts.geometry.PlacedPiece> pieces) {
        long start = System.nanoTime();
        var result = ManualLayoutValidator.validate(problem, pieces);
        return toResult(problem, result, "manual-guillotine", "1", elapsed(start), "manual-guillotine", null);
    }

    @Override
    public List<NestingResult.Placement> validateContourAdjustment(NestingProblem problem, List<PlacedPiece> pieces) {
        validate(problem);
        require("CONTOUR".equals(problem.process().mode()), "轮廓调整须使用 CONTOUR 工艺");
        require(pieces != null, "调整裁片不能为空");
        var output = new EngineResult();
        for (var p : pieces) {
            require(p != null && p.getShape() != null && p.getDemandId() != null, "调整缺少裁片轮廓或需求归属");
            output.getPlacements().add(new NestingResult.Placement(p.getId(), p.getDemandId(), p.getName(),
                    p.getX(), p.getY(), p.getShape(), p.getRotationDegrees()));
        }
        String error = PolygonResultValidator.validate(problem, output);
        if (error != null) throw new IllegalArgumentException(error);
        return List.copyOf(output.getPlacements());
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
