package com.example.cutdemotwo.business.workbench;

import com.example.cutdemotwo.business.cutting.CuttingStatePort;
import com.example.cutdemotwo.business.optimization.OptimizationService;
import com.example.cutdemotwo.business.optimization.ResultComparisons;
import com.example.cutdemotwo.contracts.jobs.OptimizationFailure;
import com.example.cutdemotwo.contracts.jobs.OptimizationJob;
import com.example.cutdemotwo.contracts.jobs.OptimizationRequest;
import com.example.cutdemotwo.contracts.jobs.OptimizationResult;
import com.example.cutdemotwo.contracts.jobs.StoredOptimizationJob;
import com.example.cutdemotwo.contracts.jobs.WorkbenchComparison;
import com.example.cutdemotwo.contracts.jobs.WorkbenchJobSource;
import com.example.cutdemotwo.contracts.slitting.SlittingProblem;
import com.example.cutdemotwo.contracts.slitting.SlittingResult;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Stream;

/**
 * 工作台同口径双方案对比与结果上下文服务（独立上层无环子包）：
 * <ul>
 *   <li>单向依赖 {@link OptimizationService}、{@link ResultComparisons} 与 {@link CuttingStatePort}，严禁反向耦合；</li>
 *   <li>支持 2D 排料（含直刀 {@code rectGapPaddingMm} 外扩精确还原）与 1D 分切的同口径缺件及物理占长对比；</li>
 *   <li>严格执行“同上下文 + 同硬约束 + 双齐套才可算 savedLengthMm”规则，其余情况给出明确不可比原因。</li>
 * </ul>
 */
@Service
public class WorkbenchComparisonService {
    private static final String LENGTH_BASIS_2D = "从归档工位起点至主裁片或补片最远净边的预测占长，直刀扣除间距外扩，单位 mm，保留两位小数";
    private static final String LENGTH_BASIS_1D = "一维分切各车次定长乘以重复车次的累计拉布占长，单位 mm，保留两位小数";

    private final OptimizationService optimizationService;
    private final CuttingStatePort cuttingStatePort;

    public WorkbenchComparisonService(OptimizationService optimizationService, CuttingStatePort cuttingStatePort) {
        this.optimizationService = Objects.requireNonNull(optimizationService, "optimizationService");
        this.cuttingStatePort = Objects.requireNonNull(cuttingStatePort, "cuttingStatePort");
    }

    public record ResultContext(
            String resultId,
            OptimizationJob job,
            OptimizationRequest input,
            OptimizationResult result,
            WorkbenchJobSource source,
            Map<String, Object> taskSummary,
            String workbenchUrl
    ) {}

    /** 按同一任务对比两份已归档的排料结果。 */
    public WorkbenchComparison compare(String taskId, String leftId, String rightId) {
        if (taskId == null || taskId.isBlank()) {
            throw failure("INVALID_INPUT", "需求任务编号不能为空", 400);
        }
        if (leftId == null || rightId == null || leftId.isBlank() || rightId.isBlank() || leftId.equals(rightId)) {
            throw failure("INVALID_INPUT", "请选择两份不同的归档排料结果进行比较", 400);
        }
        String cleanTaskId = taskId.trim();
        StoredOptimizationJob left = requireTaskResult(cleanTaskId, leftId.trim());
        StoredOptimizationJob right = requireTaskResult(cleanTaskId, rightId.trim());
        return compareArchives(cleanTaskId, left.workbenchSource(), left, right.workbenchSource(), right);
    }

    /** 查询指定结果的完整工作台上下文，供前端深链与 MCP 渲染预览使用（绝不暴露幂等键）。 */
    public ResultContext getResultContext(String resultId) {
        if (resultId == null || resultId.isBlank()) {
            throw failure("INVALID_INPUT", "结果编号 resultId 不能为空", 400);
        }
        String cleanId = resultId.trim();
        StoredOptimizationJob doc = optimizationService.findJobWithSource(cleanId);
        if (doc == null) {
            throw failure("NOT_FOUND", "计算作业或排料结果不存在: " + cleanId, 404);
        }
        WorkbenchJobSource source = doc.workbenchSource();
        String taskId = source != null ? source.taskId() : null;
        Map<String, Object> taskSummary = null;
        if (taskId != null && !taskId.isBlank()) {
            taskSummary = cuttingStatePort.inRead(tx ->
                    tx.findTask(taskId).map(t -> WorkbenchTaskViewSupport.buildTaskSummary(tx, t)).orElse(null)
            );
        }
        String workbenchUrl = WorkbenchTaskViewSupport.buildWorkbenchUrl(taskId, cleanId, null);
        return new ResultContext(
                cleanId,
                doc.job(),
                doc.input(),
                doc.result(),
                source,
                taskSummary,
                workbenchUrl
        );
    }

    static WorkbenchComparison compareArchives(
            String taskId,
            WorkbenchJobSource leftSource,
            StoredOptimizationJob left,
            WorkbenchJobSource rightSource,
            StoredOptimizationJob right
    ) {
        List<String> contextDiffs = contextDifferences(leftSource, rightSource);
        List<String> hardDiffs = ResultComparisons.hardConstraintDifferences(left.input(), right.input());
        boolean sameContext = contextDiffs.isEmpty();
        boolean sameHardConstraints = hardDiffs.isEmpty();

        List<String> allDiffs = new ArrayList<>(contextDiffs.size() + hardDiffs.size());
        allDiffs.addAll(contextDiffs);
        allDiffs.addAll(hardDiffs);

        WorkbenchComparison.Side leftSide = buildSide(left, leftSource);
        WorkbenchComparison.Side rightSide = buildSide(right, rightSource);

        List<WorkbenchComparison.MetricDelta> metricDeltas = ResultComparisons
                .compareMetrics(leftSide.metrics(), rightSide.metrics(), sameHardConstraints)
                .stream()
                .map(m -> new WorkbenchComparison.MetricDelta(
                        m.name(),
                        m.left(),
                        m.right(),
                        sameContext ? m.rightMinusLeft() : null,
                        sameContext ? m.status() : "DIFFERENT_CONTEXT"
                ))
                .toList();

        WorkbenchComparison.LengthComparison lengthComparison = compareLength(
                leftSide, rightSide, sameContext, sameHardConstraints
        );

        return new WorkbenchComparison(
                taskId,
                leftSide,
                rightSide,
                allDiffs.isEmpty(),
                List.copyOf(allDiffs),
                metricDeltas,
                lengthComparison
        );
    }

    private StoredOptimizationJob requireTaskResult(String taskId, String resultId) {
        StoredOptimizationJob doc = optimizationService.findJobWithSource(resultId);
        if (doc == null) {
            throw failure("NOT_FOUND", "排料结果不存在: " + resultId, 404);
        }
        WorkbenchJobSource source = doc.workbenchSource();
        if (source == null || !taskId.equals(source.taskId())) {
            throw failure("NOT_FOUND", "任务 " + taskId + " 下未找到关联的工作台排料结果: " + resultId, 404);
        }
        if (doc.result() == null) {
            throw new OptimizationFailure("RESULT_NOT_AVAILABLE", "作业尚无已归档的验证结果，请稍后再试", 409, !doc.job().terminal());
        }
        return doc;
    }

    private static List<String> contextDifferences(WorkbenchJobSource a, WorkbenchJobSource b) {
        List<String> diffs = new ArrayList<>();
        diff(diffs, "taskRevision", a.taskRevision(), b.taskRevision());
        diff(diffs, "materialType", a.materialType(), b.materialType());
        diff(diffs, "materialId", a.materialId(), b.materialId());
        diff(diffs, "materialRevision", a.materialRevision(), b.materialRevision());
        diff(diffs, "physicalWidthMm", a.physicalWidthMm(), b.physicalWidthMm());
        diff(diffs, "windowStartMm", a.windowStartMm(), b.windowStartMm());
        diff(diffs, "windowLengthMm", a.windowLengthMm(), b.windowLengthMm());
        diff(diffs, "rectGapPaddingMm", a.rectGapPaddingMm(), b.rectGapPaddingMm());
        diff(diffs, "sourceLines", a.sourceLines(), b.sourceLines());
        return diffs;
    }

    private static void diff(List<String> diffs, String field, Object a, Object b) {
        if (!Objects.equals(a, b)) {
            diffs.add("context." + field);
        }
    }

    private static WorkbenchComparison.Side buildSide(StoredOptimizationJob archived, WorkbenchJobSource source) {
        OptimizationResult result = archived.result();
        String problemType = archived.input().problemType();
        if ("SLITTING_1D".equals(problemType)) {
            return buildSlittingSide(archived, source, result);
        }
        return buildNesting2DSide(archived, source, result);
    }

    private static WorkbenchComparison.Side buildNesting2DSide(
            StoredOptimizationJob archived,
            WorkbenchJobSource source,
            OptimizationResult result
    ) {
        if (result.layout() == null) {
            throw inconsistentArchive();
        }
        Map<Integer, Integer> mainCounts = new HashMap<>();
        for (var placement : result.layout().placements()) {
            mainCounts.merge(placement.demandId(), 1, Integer::sum);
        }
        List<WorkbenchComparison.Demand> demands = new ArrayList<>();
        int requested = 0;
        int placed = 0;
        for (var part : archived.input().nestingProblem().parts()) {
            int count = mainCounts.getOrDefault(part.id(), 0);
            if (count > part.quantity()) {
                throw inconsistentArchive();
            }
            mainCounts.remove(part.id());
            demands.add(new WorkbenchComparison.Demand(
                    part.id(),
                    source.sourceLines().get(part.id()),
                    part.name(),
                    part.quantity(),
                    count,
                    part.quantity() - count
            ));
            requested += part.quantity();
            placed += count;
        }
        if (!mainCounts.isEmpty()) {
            throw inconsistentArchive();
        }
        String status = placed == 0 ? "NONE" : (placed == requested ? "COMPLETE" : "PARTIAL");
        if (!status.equals(result.fulfillmentStatus())) {
            throw inconsistentArchive();
        }

        WorkbenchComparison.MaterialWindow window = new WorkbenchComparison.MaterialWindow(
                source.materialType(),
                source.materialId(),
                source.materialRevision(),
                source.physicalWidthMm(),
                source.windowStartMm(),
                source.windowLengthMm(),
                source.taskRevision()
        );
        return new WorkbenchComparison.Side(
                result.id(),
                result.inputHash(),
                "NESTING_2D",
                result.fulfillmentStatus(),
                requested,
                placed,
                requested - placed,
                demands,
                occupiedLength2D(result, source.rectGapPaddingMm()),
                LENGTH_BASIS_2D,
                source.rectGapPaddingMm(),
                window,
                physicalMetrics2D(result, source)
        );
    }

    private static WorkbenchComparison.Side buildSlittingSide(
            StoredOptimizationJob archived,
            WorkbenchJobSource source,
            OptimizationResult result
    ) {
        SlittingResult slitting = result.slitting();
        if (slitting == null) {
            throw inconsistentArchive();
        }
        Map<String, SlittingResult.Fulfillment> byOrderId = new HashMap<>();
        for (SlittingResult.Fulfillment f : slitting.fulfillment()) {
            byOrderId.put(f.orderId(), f);
        }
        List<WorkbenchComparison.Demand> demands = new ArrayList<>();
        int requested = 0;
        int placed = 0;
        int idx = 1;
        for (SlittingProblem.Order order : archived.input().slittingProblem().orders()) {
            SlittingResult.Fulfillment f = byOrderId.get(order.id());
            int prod = f == null ? 0 : Math.min(order.quantity(), Math.max(0, f.produced()));
            int missing = f == null ? order.quantity() : Math.max(0, f.missing());
            Integer lineId = source.sourceLines().get(idx);
            if (lineId == null) {
                lineId = tryParseInt(order.id());
            }
            demands.add(new WorkbenchComparison.Demand(
                    idx,
                    lineId,
                    order.id() + " (" + order.widthMm() + "×" + order.lengthMm() + "mm)",
                    order.quantity(),
                    prod,
                    missing
            ));
            requested += order.quantity();
            placed += Math.max(0, order.quantity() - missing);
            idx++;
        }

        Double totalFeedMm = null;
        if ("PASSED".equals(result.validationStatus()) && "FEASIBLE".equals(slitting.status()) && !slitting.patterns().isEmpty()) {
            double sum = 0.0;
            for (SlittingResult.Pattern p : slitting.patterns()) {
                sum += (double) p.lengthMm() * Math.max(0, p.repetitions());
            }
            if (Double.isFinite(sum) && sum > 0) {
                totalFeedMm = hundredths(sum);
            }
        }

        WorkbenchComparison.MaterialWindow window = new WorkbenchComparison.MaterialWindow(
                source.materialType(),
                source.materialId(),
                source.materialRevision(),
                source.physicalWidthMm(),
                source.windowStartMm(),
                source.windowLengthMm(),
                source.taskRevision()
        );
        return new WorkbenchComparison.Side(
                result.id(),
                result.inputHash(),
                "SLITTING_1D",
                result.fulfillmentStatus(),
                requested,
                placed,
                Math.max(0, requested - placed),
                demands,
                totalFeedMm,
                LENGTH_BASIS_1D,
                0.0,
                window,
                result.metrics()
        );
    }

    private static List<OptimizationResult.Metric> physicalMetrics2D(OptimizationResult result, WorkbenchJobSource source) {
        double gap = source.rectGapPaddingMm();
        if (gap <= 0.0) {
            return result.metrics();
        }
        double netPieceArea = result.layout().placements().stream()
                .mapToDouble(p -> Math.max(0.0, p.shape().width() - gap) * Math.max(0.0, p.shape().height() - gap))
                .sum();
        double windowArea = source.physicalWidthMm() * source.windowLengthMm();
        return result.metrics().stream()
                .map(m -> "processingAreaUtilization".equals(m.name()) && windowArea > 0
                        ? new OptimizationResult.Metric(
                        m.name(),
                        netPieceArea / windowArea * 100.0,
                        "%",
                        netPieceArea,
                        windowArea,
                        "还原直刀外扩后的主裁片净面积 ÷ 物理加工窗口面积，不含补片",
                        "workbench-physical-1")
                        : m)
                .toList();
    }

    private static Double occupiedLength2D(OptimizationResult result, double padding) {
        if (!"PASSED".equals(result.validationStatus()) || result.layout() == null || !result.layout().feasible()) {
            return null;
        }
        var spare = result.marker() == null ? null : result.marker().gapFillPlacements();
        var placements = result.layout().placements().stream();
        if (spare != null) {
            placements = Stream.concat(placements, spare.stream());
        }
        var maxEnd = placements.mapToDouble(p -> p.y() + p.shape().height() - padding).max();
        if (maxEnd.isEmpty() || !Double.isFinite(maxEnd.getAsDouble()) || maxEnd.getAsDouble() <= 0) {
            return null;
        }
        return hundredths(maxEnd.getAsDouble());
    }

    private static WorkbenchComparison.LengthComparison compareLength(
            WorkbenchComparison.Side left,
            WorkbenchComparison.Side right,
            boolean sameContext,
            boolean sameConstraints
    ) {
        String basis = "SLITTING_1D".equals(left.problemType()) && "SLITTING_1D".equals(right.problemType())
                ? LENGTH_BASIS_1D
                : LENGTH_BASIS_2D;
        if (!sameContext) {
            return unavailable("DIFFERENT_CONTEXT", basis, "工单、材料或工位的归档上下文不同，不能计算节省量");
        }
        if (!sameConstraints) {
            return unavailable("DIFFERENT_CONSTRAINTS", basis, "两份归档输入的裁切硬约束不同，不能计算节省量");
        }
        if (!isComplete(left) || !isComplete(right)) {
            return unavailable("INCOMPLETE", basis, "至少一案未满足本次提交的全部需求，不能计算齐套用布节省量");
        }
        if (left.occupiedLengthMm() == null || right.occupiedLengthMm() == null) {
            return unavailable("UNAVAILABLE", basis, "归档结果缺少已验证的几何占长");
        }
        double delta = hundredths(right.occupiedLengthMm() - left.occupiedLengthMm());
        String shorter = delta == 0.0 ? null : (delta > 0.0 ? left.resultId() : right.resultId());
        String reason = delta == 0.0
                ? "两案均满足本次需求，预测占长相同"
                : "两案均满足本次需求，可按同一工位和口径比较预测占长";
        return new WorkbenchComparison.LengthComparison("COMPARABLE", shorter, Math.abs(delta), basis, reason);
    }

    private static boolean isComplete(WorkbenchComparison.Side side) {
        return "COMPLETE".equals(side.fulfillmentStatus()) && side.requested() > 0 && side.unplaced() == 0;
    }

    private static WorkbenchComparison.LengthComparison unavailable(String status, String basis, String reason) {
        return new WorkbenchComparison.LengthComparison(status, null, null, basis, reason);
    }

    private static double hundredths(double mm) {
        return Math.round(mm * 100.0) / 100.0;
    }

    private static Integer tryParseInt(String raw) {
        if (raw == null || raw.isBlank()) return null;
        try {
            return Integer.parseInt(raw.trim());
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static OptimizationFailure inconsistentArchive() {
        return failure("INCONSISTENT_ARCHIVE", "归档主裁片与原始需求或齐套状态不一致，请重新求解", 409);
    }

    private static OptimizationFailure failure(String code, String message, int status) {
        return new OptimizationFailure(code, message, status, false);
    }
}
