package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.algorithm.api.ComputationTimeout;
import com.example.cutdemotwo.algorithm.api.ISlittingSolverEngine;
import com.example.cutdemotwo.algorithm.api.NestingSolver;
import com.example.cutdemotwo.contracts.jobs.*;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import com.example.cutdemotwo.contracts.slitting.SlittingProblem;
import com.example.cutdemotwo.contracts.slitting.SlittingResult;
import com.example.cutdemotwo.contracts.slitting.SlittingValidation;

import java.time.Instant;
import java.util.*;

/**
 * 计算作业无状态输入校验、幂等冲突核验与结果/状态转换构建辅助类。
 */
final class OptimizationResultSupport {

    private OptimizationResultSupport() {}

    static int parseHeapMiB(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (!value.matches("([1-9][0-9]{1,4}[mM]|[1-9][0-9]{0,1}[gG])")) {
            throw new IllegalArgumentException("无效的一维子进程堆上限配置 cutdemo.slitting.child-xmx: " + raw);
        }
        int amount = Integer.parseInt(value.substring(0, value.length() - 1));
        char unit = Character.toLowerCase(value.charAt(value.length() - 1));
        return unit == 'g' ? Math.multiplyExact(amount, 1024) : amount;
    }

    static ProblemCheck validateProblemRequest(
            OptimizationRequest request,
            NestingSolver solvers,
            ISlittingSolverEngine slitting
    ) {
        if (request == null || request.problem() == null || request.allowFallback() == null || request.requireComplete() == null
                || request.clientRequestId() == null || request.clientRequestId().isBlank() || request.clientRequestId().length() > 128)
            throw new OptimizationFailure("INVALID_INPUT", "必须提供问题、明确的降级/齐套选项及 1–128 字调用方请求编号", 400, false);
        if (!"2.0".equals(request.schemaVersion()))
            throw new OptimizationFailure("UNSUPPORTED_CONSTRAINT", "当前仅支持 schemaVersion=2.0", 422, false);
        if ("SLITTING_1D".equals(request.problemType())) {
            if (!(request.problem() instanceof SlittingProblem))
                throw new OptimizationFailure("INVALID_INPUT", "问题类型与内容不匹配", 400, false);
            if (request.strategy() != null)
                throw new OptimizationFailure("UNSUPPORTED_CONSTRAINT", "一维问题不支持唛架策略", 422, false);
            if (!slitting.isAvailable())
                throw new OptimizationFailure("ENGINE_UNAVAILABLE", "一维计算运行时不可用", 503, true);
            try {
                SlittingValidation.validateProblem(request.slittingProblem());
                return new ProblemCheck("VALID", "一维分切问题合法", slitting.getEngineType(), slitting.getEngineType(), null);
            } catch (SlittingValidation.ValidationException e) {
                int status = "INVALID_INPUT".equals(e.getCode()) ? 400 : 422;
                throw new OptimizationFailure(e.getCode(), e.getMessage(), status, false);
            }
        }
        if (!"NESTING_2D".equals(request.problemType()))
            throw new OptimizationFailure("UNSUPPORTED_CONSTRAINT", "不支持的作业类型: " + request.problemType(), 422, false);
        if (!(request.problem() instanceof NestingProblem))
            throw new OptimizationFailure("INVALID_INPUT", "问题类型与内容不匹配", 400, false);
        var check = solvers.validateProblem(request.nestingProblem(), request.allowFallback());
        if (!"VALID".equals(check.status())) throw switch (check.status()) {
            case "INVALID_INPUT" -> new OptimizationFailure("INVALID_INPUT", check.message(), 400, false);
            case "UNAVAILABLE" -> new OptimizationFailure("ENGINE_UNAVAILABLE", check.message(), 503, true);
            default -> new OptimizationFailure("UNSUPPORTED_CONSTRAINT", check.message(), 422, false);
        };
        MarkerOptimization.validate(request);
        if (request.strategy() != null && request.strategy().initialPlacements() != null) {
            MarkerOptimization.validatedSeed(request, solvers);
        }
        return check;
    }

    static void assertIdempotencyMatch(
            StoredOptimizationJob existing,
            String inputHash,
            WorkbenchJobSource incomingSource
    ) {
        if (!existing.job().inputHash().equals(inputHash)) {
            throw new OptimizationFailure("IDEMPOTENCY_CONFLICT", "同一幂等键已绑定不同请求", 409, false);
        }
        WorkbenchJobSource oldSource = existing.workbenchSource();
        if (oldSource == null && incomingSource == null) {
            return;
        }
        if (oldSource == null || incomingSource == null
                || !Objects.equals(oldSource.taskId(), incomingSource.taskId())
                || !Objects.equals(oldSource.materialType(), incomingSource.materialType())
                || !Objects.equals(oldSource.materialId(), incomingSource.materialId())) {
            throw new OptimizationFailure("IDEMPOTENCY_CONFLICT", "同一幂等键已绑定不同工作台任务或材料上下文", 409, false);
        }
    }

    static StoredOptimizationJob executionFailure(StoredOptimizationJob document, Throwable error) {
        boolean stopping = "CANCEL_REQUESTED".equals(document.job().state());
        boolean timed = "TIMED_OUT".equals(document.job().code())
                || (!stopping && error instanceof ComputationTimeout);
        String state = timed ? "TIMED_OUT" : stopping ? "CANCELLED" : "FAILED";
        String code = timed || stopping ? state : error instanceof SlittingValidation.ValidationException
                ? "INVALID_RESULT" : "EXECUTION_FAILED";
        return transition(document, state, "STOPPED", code, timed || stopping ? "计算进程已退出" : "执行或结果验证失败，请检查服务日志", null);
    }

    static StoredOptimizationJob finishedSlitting(StoredOptimizationJob current, SlittingResult result) {
        boolean stop = "CANCEL_REQUESTED".equals(current.job().state()), timed = stop && "TIMED_OUT".equals(current.job().code());
        return transition(current, timed ? "TIMED_OUT" : stop ? "CANCELLED" : "SUCCEEDED", "STOPPED",
                timed ? "TIMED_OUT" : stop ? "CANCELLED" : null,
                "计算已退出，履约状态请查看结果",
                resultSlitting(current, result, timed ? "TIME_LIMIT" : stop ? "CANCELLED" : "COMPLETED"));
    }

    static OptimizationResult resultSlitting(StoredOptimizationJob document, SlittingResult r, String termination) {
        SlittingValidation.validateResult(document.input().slittingProblem(), r);
        boolean complete = !r.fulfillment().isEmpty() && r.fulfillment().stream().allMatch(f -> f.missing() == 0);
        boolean any = r.fulfillment().stream().anyMatch(f -> f.produced() > 0);
        var metrics = List.of(
                new OptimizationResult.Metric("motherAreaUtilization", r.motherAreaMm2() > 0 ? 100d * r.pieceAreaMm2() / r.motherAreaMm2() : 0,
                        "%", r.pieceAreaMm2(), r.motherAreaMm2(), "planned-produced-area / planned-mother-area; includes fixed trims in denominator", "1"),
                new OptimizationResult.Metric("usableAreaUtilization", r.usableAreaMm2() > 0 ? 100d * r.pieceAreaMm2() / r.usableAreaMm2() : 0,
                        "%", r.pieceAreaMm2(), r.usableAreaMm2(), "planned-produced-area / planned-usable-area; excludes fixed trims from denominator", "1"));
        return new OptimizationResult(document.job().id(), document.job().id(), document.job().inputHash(), "2.0", "PASSED",
                complete ? "COMPLETE" : any ? "PARTIAL" : "NONE", any && (!document.input().requireComplete() || complete), termination, metrics, r);
    }

    static StoredOptimizationJob finished(StoredOptimizationJob current, MarkerOptimization.Outcome outcome) {
        boolean stop = "CANCEL_REQUESTED".equals(current.job().state()), timed = stop && "TIMED_OUT".equals(current.job().code());
        var layout = outcome.layout();
        boolean valid = Set.of("FEASIBLE", "NO_SOLUTION_FOUND").contains(layout.status());
        String state = timed ? "TIMED_OUT" : stop ? "CANCELLED" : valid && outcome.failureCode() == null ? "SUCCEEDED" : "FAILED";
        var result = valid ? buildNestingResult(current, layout,
                timed ? "TIME_LIMIT" : stop ? "CANCELLED" : outcome.failureCode() != null ? "ENGINE_ERROR" : "COMPLETED",
                outcome.marker()) : null;
        return transition(current, state, "STOPPED",
                timed ? "TIMED_OUT" : stop ? "CANCELLED" : outcome.failureCode() != null ? outcome.failureCode() : valid ? null : layout.status(),
                stop ? "计算已退出" : outcome.failureCode() != null ? "后续试排失败；此前已验证结果如有保留，请查看试排记录"
                        : valid ? "计算结束，履约状态请查看结果" : layout.message(),
                result);
    }

    static StoredOptimizationJob withMessage(StoredOptimizationJob document, String message) {
        var j = document.job();
        var job = new OptimizationJob(j.id(), j.schemaVersion(), j.clientRequestId(), j.inputHash(), j.state(), j.phase(), j.createdAt(),
                j.startedAt(), j.finishedAt(), j.timeLimitSeconds(), j.resultRef(), j.code(), message);
        return new StoredOptimizationJob(document.idempotencyKey(), document.input(), job, document.result(), document.workbenchSource());
    }

    static OptimizationResult buildNestingResult(
            StoredOptimizationJob document,
            NestingResult layout,
            String termination,
            OptimizationResult.MarkerReport marker
    ) {
        int requested = layout.fulfillment().stream().mapToInt(NestingResult.Fulfillment::requested).sum();
        int placed = layout.fulfillment().stream().mapToInt(NestingResult.Fulfillment::placed).sum();
        boolean complete = requested > 0 && requested == placed;
        var m = layout.metrics();
        var metrics = new ArrayList<OptimizationResult.Metric>();
        metrics.add(new OptimizationResult.Metric("processingAreaUtilization", m.processingAreaMm2() > 0 ? m.pieceAreaMm2() / m.processingAreaMm2() * 100 : 0,
                "%", m.pieceAreaMm2(), m.processingAreaMm2(), "piece-net-area / submitted-processing-area; not actual consumed material", "1"));
        if (marker != null && marker.occupiedLengthMm() != null && complete) {
            double area = layout.processingRegion().width() * marker.occupiedLengthMm();
            metrics.add(new OptimizationResult.Metric("markerAreaUtilization", m.pieceAreaMm2() / area * 100, "%",
                    m.pieceAreaMm2(), area, "complete-kit-net-area / (fixed-width * occupied-marker-length); excludes unused tail; planned", "1"));
            if (marker.gapFillPlacements() != null) {
                double withFill = m.pieceAreaMm2() + marker.gapFillPlacements().stream().mapToDouble(p -> p.shape().areaMm2()).sum();
                metrics.add(new OptimizationResult.Metric("markerAreaUtilizationWithFill", withFill / area * 100, "%",
                        withFill, area, "(complete-kit + verified spare net area) / (fixed-width * occupied-marker-length); planned", "1"));
            }
        }
        return new OptimizationResult(document.job().id(), document.job().id(), document.job().inputHash(), "2.0", "PASSED",
                complete ? "COMPLETE" : placed > 0 ? "PARTIAL" : "NONE", layout.feasible() && (!document.input().requireComplete() || complete), termination,
                List.copyOf(metrics), layout, marker);
    }

    static StoredOptimizationJob transition(
            StoredOptimizationJob d,
            String state,
            String phase,
            String code,
            String message,
            OptimizationResult result
    ) {
        return d.transition(state, phase, code, message, result, System.currentTimeMillis());
    }

    static boolean isEvictableTerminal(StoredOptimizationJob doc) {
        if (doc == null || doc.job() == null) return false;
        return doc.job().terminal() || "LEASE_LOST".equals(doc.job().state());
    }

    static long terminalTimestampMillis(StoredOptimizationJob doc) {
        String raw = doc.job().finishedAt() != null ? doc.job().finishedAt() : doc.job().createdAt();
        if (raw == null) return 0L;
        try {
            return Instant.parse(raw).toEpochMilli();
        } catch (RuntimeException ignored) {
            return 0L;
        }
    }
}
