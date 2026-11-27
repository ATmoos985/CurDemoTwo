package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.contracts.jobs.OptimizationFailure;
import com.example.cutdemotwo.contracts.jobs.OptimizationJob;
import com.example.cutdemotwo.contracts.jobs.OptimizationRequest;
import com.example.cutdemotwo.contracts.jobs.OptimizationResult;
import com.example.cutdemotwo.contracts.jobs.StoredOptimizationJob;
import com.example.cutdemotwo.contracts.jobs.WorkbenchJobSource;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingResult;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 同步归档已验证 2D 布局文档的辅助构建器（纯单向依赖契约层，避免与 {@link OptimizationService} 形成类环）。
 */
final class OptimizationArchiveSupport {
    private OptimizationArchiveSupport() {}

    static StoredOptimizationJob buildArchived2DDocument(
            String idempotencyKey,
            OptimizationRequest input,
            NestingResult layout,
            WorkbenchJobSource workbenchSource,
            long nowMillis
    ) {
        if (layout == null || !layout.feasible() || layout.placements() == null || layout.placements().isEmpty()) {
            throw new OptimizationFailure("INVALID_INPUT", "同步归档必须提供可行的非空 2D 排料布局", 400, false);
        }
        String id = UUID.randomUUID().toString();
        String inputHash = StoredOptimizationJob.inputHash(input);
        String nowIso = Instant.ofEpochMilli(nowMillis).toString();

        NestingProblem problem = input.nestingProblem();
        Map<Integer, Integer> placedByDemand = new LinkedHashMap<>();
        double pieceAreaMm2 = 0.0;
        for (NestingResult.Placement p : layout.placements()) {
            placedByDemand.merge(p.demandId(), 1, Integer::sum);
            if (p.shape() != null) {
                pieceAreaMm2 += p.shape().areaMm2();
            }
        }

        int requested = 0;
        int placed = 0;
        List<NestingResult.Fulfillment> fulfillments = new ArrayList<>(problem.parts().size());
        for (NestingProblem.Part part : problem.parts()) {
            int reqQty = part.quantity();
            int got = Math.min(reqQty, placedByDemand.getOrDefault(part.id(), 0));
            requested += reqQty;
            placed += got;
            fulfillments.add(new NestingResult.Fulfillment(
                    part.id(),
                    reqQty,
                    got,
                    Math.max(0, reqQty - got),
                    got < reqQty ? "MULTI_MATERIAL_SEGMENT_SPLIT" : null
            ));
        }
        boolean complete = requested > 0 && placed == requested;
        String fulfillmentStatus = complete ? "COMPLETE" : (placed > 0 ? "PARTIAL" : "NONE");

        double processingAreaMm2 = problem.width() * problem.height();
        if (layout.metrics() != null && layout.metrics().processingAreaMm2() > 0) {
            processingAreaMm2 = layout.metrics().processingAreaMm2();
        }
        if (layout.metrics() != null && layout.metrics().pieceAreaMm2() > 0) {
            pieceAreaMm2 = layout.metrics().pieceAreaMm2();
        }
        double utilPct = processingAreaMm2 > 0 ? Math.min(100.0, pieceAreaMm2 / processingAreaMm2 * 100.0) : 0.0;
        List<OptimizationResult.Metric> metrics = List.of(
                new OptimizationResult.Metric(
                        "processingAreaUtilization",
                        utilPct,
                        "%",
                        pieceAreaMm2,
                        processingAreaMm2,
                        "piece-net-area / submitted-processing-area; not actual consumed material",
                        "1"
                )
        );

        NestingResult normalizedLayout = new NestingResult(
                layout.schemaVersion() != null ? layout.schemaVersion() : "1",
                layout.unit() != null ? layout.unit() : "mm",
                layout.coordinateSystem() != null ? layout.coordinateSystem() : "source-local-top-left",
                "FEASIBLE",
                layout.message() != null ? layout.message() : "多料联排同步归档布局",
                layout.engine() != null ? layout.engine() : "multi-material-planner",
                layout.engineVersion() != null ? layout.engineVersion() : "1",
                layout.elapsedMs(),
                problem.material().id(),
                NestingProblem.Shape.rectangle(problem.width(), problem.height()),
                layout.placements(),
                layout.leftovers() != null ? layout.leftovers() : List.of(),
                layout.cuts() != null ? layout.cuts() : List.of(),
                List.copyOf(fulfillments),
                layout.metrics() != null ? layout.metrics() : new NestingResult.Metrics(
                        processingAreaMm2,
                        pieceAreaMm2,
                        0.0,
                        Math.max(0.0, processingAreaMm2 - pieceAreaMm2),
                        problem.height()
                ),
                layout.contours() != null ? layout.contours() : List.of(),
                layout.requestedEngine() != null ? layout.requestedEngine() : "auto",
                layout.fallbackReason()
        );

        OptimizationResult result = new OptimizationResult(
                id,
                id,
                inputHash,
                "2.0",
                "PASSED",
                fulfillmentStatus,
                !Boolean.TRUE.equals(input.requireComplete()) || complete,
                "COMPLETED",
                metrics,
                normalizedLayout,
                null
        );

        OptimizationJob job = new OptimizationJob(
                id,
                "2.0",
                input.clientRequestId(),
                inputHash,
                "SUCCEEDED",
                "STOPPED",
                nowIso,
                nowIso,
                nowIso,
                problem.timeLimitSeconds(),
                "/api/v2/optimization-results/" + id,
                null,
                "多料联排同步归档完成"
        );

        return new StoredOptimizationJob(idempotencyKey, input, job, result, workbenchSource);
    }
}
