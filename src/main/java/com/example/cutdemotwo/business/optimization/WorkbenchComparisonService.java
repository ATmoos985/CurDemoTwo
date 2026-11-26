package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.business.cutting.WorkbenchJobContextService;
import com.example.cutdemotwo.contracts.jobs.*;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.stream.Stream;

@Service
public class WorkbenchComparisonService {
    private static final String LENGTH_BASIS = "从归档工位起点至主裁片或补片最远净边的预测占长，直刀扣除间距外扩，单位 mm，保留两位小数";
    private final OptimizationService jobs;
    private final WorkbenchJobContextService contexts;

    public WorkbenchComparisonService(OptimizationService jobs, WorkbenchJobContextService contexts) {
        this.jobs = jobs;
        this.contexts = contexts;
    }

    public WorkbenchComparison compare(String taskId, String leftId, String rightId, String actor) {
        if (leftId == null || rightId == null || leftId.isBlank() || rightId.isBlank() || leftId.equals(rightId)) {
            throw new OptimizationService.Failure("INVALID_INPUT", "请选择两份不同的归档排料结果", 400, false);
        }
        var leftSource = contexts.authorize(taskId, leftId, actor);
        var rightSource = contexts.authorize(taskId, rightId, actor);
        var left = jobs.workbenchArchive(leftId);
        var right = jobs.workbenchArchive(rightId);
        return compareArchives(taskId, leftSource, left, rightSource, right);
    }

    public record Drawing(OptimizationResult result, double rectGapPaddingMm) {}

    public Drawing drawing(String taskId, String resultId, String actor) {
        var source = contexts.authorize(taskId, resultId, actor);
        return new Drawing(jobs.workbenchArchive(resultId).result(), source.rectGapPaddingMm());
    }

    static WorkbenchComparison compareArchives(String taskId, WorkbenchJobSource leftSource, StoredOptimizationJob left,
            WorkbenchJobSource rightSource, StoredOptimizationJob right) {
        var hardDifferences = ResultComparisons.hardConstraintDifferences(left.input(), right.input());
        var differences = contextDifferences(leftSource, rightSource);
        boolean sameContext = differences.isEmpty();
        differences.addAll(hardDifferences);
        var leftSide = side(left, leftSource);
        var rightSide = side(right, rightSource);
        var metrics = ResultComparisons.compareMetrics(leftSide.metrics(), rightSide.metrics(), hardDifferences.isEmpty())
                .stream().map(metric -> new WorkbenchComparison.MetricDelta(
                metric.name(), metric.left(), metric.right(), sameContext ? metric.rightMinusLeft() : null,
                sameContext ? metric.status() : "DIFFERENT_CONTEXT")).toList();
        return new WorkbenchComparison(taskId, leftSide, rightSide, differences.isEmpty(), List.copyOf(differences),
                metrics, compareLength(leftSide, rightSide, sameContext, hardDifferences.isEmpty()));
    }

    private static List<String> contextDifferences(WorkbenchJobSource a, WorkbenchJobSource b) {
        var differences = new ArrayList<String>();
        difference(differences, "taskRevision", a.taskRevision(), b.taskRevision());
        difference(differences, "materialType", a.materialType(), b.materialType());
        difference(differences, "materialId", a.materialId(), b.materialId());
        difference(differences, "materialRevision", a.materialRevision(), b.materialRevision());
        difference(differences, "physicalWidthMm", a.physicalWidthMm(), b.physicalWidthMm());
        difference(differences, "windowStartMm", a.windowStartMm(), b.windowStartMm());
        difference(differences, "windowLengthMm", a.windowLengthMm(), b.windowLengthMm());
        difference(differences, "rectGapPaddingMm", a.rectGapPaddingMm(), b.rectGapPaddingMm());
        difference(differences, "sourceLines", a.sourceLines(), b.sourceLines());
        return differences;
    }

    private static void difference(List<String> differences, String field, Object a, Object b) {
        if (!Objects.equals(a, b)) differences.add("context." + field);
    }

    private static WorkbenchComparison.Side side(StoredOptimizationJob archived, WorkbenchJobSource source) {
        var result = archived.result();
        var mainCounts = new HashMap<Integer, Integer>();
        for (var placement : result.layout().placements()) mainCounts.merge(placement.demandId(), 1, Integer::sum);
        var demands = new ArrayList<WorkbenchComparison.Demand>();
        int requested = 0;
        int placed = 0;
        for (var part : archived.input().nestingProblem().parts()) {
            // Use verified main placements. Sparse or absent fulfillment rows never hide a requested line.
            int count = mainCounts.getOrDefault(part.id(), 0);
            if (count > part.quantity()) throw inconsistentArchive();
            mainCounts.remove(part.id());
            demands.add(new WorkbenchComparison.Demand(part.id(), source.sourceLines().get(part.id()), part.name(),
                    part.quantity(), count, part.quantity() - count));
            requested += part.quantity();
            placed += count;
        }
        if (!mainCounts.isEmpty()) throw inconsistentArchive();
        String status = placed == 0 ? "NONE" : placed == requested ? "COMPLETE" : "PARTIAL";
        if (!status.equals(result.fulfillmentStatus())) throw inconsistentArchive();
        var material = new WorkbenchComparison.MaterialWindow(source.materialType(), source.materialId(),
                source.materialRevision(), source.physicalWidthMm(), source.windowStartMm(), source.windowLengthMm(), source.taskRevision());
        return new WorkbenchComparison.Side(result.id(), result.inputHash(), result.fulfillmentStatus(),
                requested, placed, requested - placed, List.copyOf(demands), occupiedLength(result, source.rectGapPaddingMm()),
                LENGTH_BASIS, source.rectGapPaddingMm(), material, physicalMetrics(result, source));
    }

    private static OptimizationService.Failure inconsistentArchive() {
        return new OptimizationService.Failure("INCONSISTENT_ARCHIVE", "归档主裁片与原始需求或齐套状态不一致，请重新求解", 409, false);
    }

    private static List<OptimizationResult.Metric> physicalMetrics(OptimizationResult result, WorkbenchJobSource source) {
        double gap = source.rectGapPaddingMm();
        if (gap == 0) return result.metrics();
        // The rectangle engine solves an expanded problem. Its archived area includes the artificial border
        // on each part and on the window. Only the workbench projection knows the verified physical dimensions.
        double area = result.layout().placements().stream()
                .mapToDouble(p -> (p.shape().width() - gap) * (p.shape().height() - gap)).sum();
        double windowArea = source.physicalWidthMm() * source.windowLengthMm();
        return result.metrics().stream().map(m -> "processingAreaUtilization".equals(m.name())
                ? new OptimizationResult.Metric(m.name(), area / windowArea * 100, "%", area, windowArea,
                        "还原直刀外扩后的主裁片净面积 ÷ 物理加工窗口面积，不含补片", "workbench-physical-1")
                : m).toList();
    }

    private static Double occupiedLength(OptimizationResult result, double padding) {
        if (!"PASSED".equals(result.validationStatus()) || !result.layout().feasible()) return null;
        var spare = result.marker() == null ? null : result.marker().gapFillPlacements();
        var placements = result.layout().placements().stream();
        if (spare != null) placements = Stream.concat(placements, spare.stream());
        // Archived placement dimensions already reflect rotation. The common rectangle gap is added once per axis.
        var end = placements.mapToDouble(p -> p.y() + p.shape().height() - padding).max();
        if (end.isEmpty() || !Double.isFinite(end.getAsDouble()) || end.getAsDouble() <= 0) return null;
        return hundredths(end.getAsDouble());
    }

    private static double hundredths(double mm) {
        return Math.round(mm * 100.0) / 100.0;
    }

    private static WorkbenchComparison.LengthComparison compareLength(WorkbenchComparison.Side left, WorkbenchComparison.Side right,
            boolean sameContext, boolean sameConstraints) {
        if (!sameContext) return unavailable("DIFFERENT_CONTEXT", "工单、材料或工位的归档上下文不同，不能计算节省量");
        if (!sameConstraints) return unavailable("DIFFERENT_CONSTRAINTS", "两份归档输入的裁切硬约束不同，不能计算节省量");
        if (!complete(left) || !complete(right)) return unavailable("INCOMPLETE", "至少一案未满足本次提交的全部需求，不能计算齐套用布节省量");
        if (left.occupiedLengthMm() == null || right.occupiedLengthMm() == null) {
            return unavailable("UNAVAILABLE", "归档结果缺少已验证的几何占长");
        }
        double delta = hundredths(right.occupiedLengthMm() - left.occupiedLengthMm());
        String shorter = delta == 0 ? null : delta > 0 ? left.resultId() : right.resultId();
        return new WorkbenchComparison.LengthComparison("COMPARABLE", shorter, Math.abs(delta), LENGTH_BASIS,
                delta == 0 ? "两案均满足本次需求，预测占长相同" : "两案均满足本次需求，可按同一工位和口径比较预测占长");
    }

    static boolean complete(WorkbenchComparison.Side side) {
        return "COMPLETE".equals(side.fulfillmentStatus()) && side.requested() > 0 && side.unplaced() == 0;
    }

    private static WorkbenchComparison.LengthComparison unavailable(String status, String reason) {
        return new WorkbenchComparison.LengthComparison(status, null, null, LENGTH_BASIS, reason);
    }
}
