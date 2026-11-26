package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.optimization.OptimizationService;
import com.example.cutdemotwo.contracts.jobs.OptimizationJob;
import com.example.cutdemotwo.contracts.jobs.OptimizationRequest;
import com.example.cutdemotwo.contracts.jobs.WorkbenchJobSource;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import org.springframework.stereotype.Service;

import java.util.HashSet;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

@Service
public class WorkbenchJobContextService {
    public record Context(String materialType, String materialId, double windowStartMm,
                          double physicalWidthMm, double windowLengthMm, double rectGapPaddingMm,
                          Map<Integer, Integer> sourceLines, String fallbackDraftId) {
        public Context(String materialType, String materialId, double windowStartMm, double physicalWidthMm,
                       double windowLengthMm, double rectGapPaddingMm, Map<Integer, Integer> sourceLines) {
            this(materialType, materialId, windowStartMm, physicalWidthMm, windowLengthMm, rectGapPaddingMm, sourceLines, null);
        }
    }
    public record Accepted(OptimizationJob job, String comparisonTaskId) {}
    public record Submission(OptimizationRequest request, Context context) {}

    private final RemnantService inventory;
    private final OptimizationService jobs;

    public WorkbenchJobContextService(RemnantService inventory, OptimizationService jobs) {
        this.inventory = inventory;
        this.jobs = jobs;
    }

    public Accepted submit(String taskId, String actor, String key, Submission submission) {
        if (submission == null || submission.context() == null || submission.request() == null
                || !(submission.request().problem() instanceof NestingProblem p)
                || !"NESTING_2D".equals(submission.request().problemType()) || p.material() == null
                || p.material().shape() == null || p.process() == null || p.parts().isEmpty()) {
            throw invalid("工作台来源仅适用于完整的二维求解输入");
        }
        var c = submission.context();
        if (actor == null || c.materialType() == null || !Double.isFinite(c.windowStartMm()) || c.windowStartMm() < 0
                || !(c.physicalWidthMm() > 0) || !(c.windowLengthMm() > 0) || !Double.isFinite(c.rectGapPaddingMm())
                || c.rectGapPaddingMm() < 0 || c.rectGapPaddingMm() > 100
                || (c.rectGapPaddingMm() > 0 && !"GUILLOTINE".equals(p.process().mode()))
                || !same(p.width(), c.physicalWidthMm() + c.rectGapPaddingMm())
                || !same(p.height(), c.windowLengthMm() + c.rectGapPaddingMm())) {
            throw invalid("输入的物理尺寸、裁切窗口与求解网格不匹配");
        }
        var lines = c.sourceLines() == null ? Map.<Integer, Integer>of() : c.sourceLines();
        boolean draft = isDraft(taskId);
        if (c.fallbackDraftId() != null && !isDraft(c.fallbackDraftId())) throw invalid("草稿来源编号无效");
        WorkbenchJobSource source = inventory.inRead(v -> {
            long taskRevision = 0;
            String boundTaskId = taskId;
            Map<Integer, Integer> boundLines = lines;
            if (draft) {
                if (!lines.isEmpty()) throw invalid("草稿不能声明正式工单行");
            } else {
                CuttingTask task = v.findTask(taskId).orElseThrow(WorkbenchJobContextService::hidden);
                if (task.slittingTask()) throw invalid("请选择二维需求工单");
                if (matchesLines(task, p, c.rectGapPaddingMm(), lines)) {
                    taskRevision = task.revision();
                } else {
                    if (c.fallbackDraftId() == null) throw invalid("裁片已不同于原工单行，请按草稿试算");
                    boundTaskId = c.fallbackDraftId();
                    boundLines = Map.of();
                }
            }
            long materialRevision = 0;
            String materialId = c.materialId();
            switch (c.materialType()) {
                case "FREE_CANVAS" -> {
                    if (materialId == null || materialId.isBlank() || materialId.length() > 160 || c.windowStartMm() != 0) {
                        throw invalid("虚拟材料信息无效");
                    }
                }
                case "STOCK_ROLL" -> {
                    var roll = v.findRoll(materialId).orElseThrow(WorkbenchJobContextService::hidden);
                    if (!same(roll.getWidth(), c.physicalWidthMm()) || c.windowStartMm() + .051 < roll.getUsedLength()
                            || c.windowStartMm() + c.windowLengthMm() > roll.getTotalLength() + .051) {
                        throw invalid("母卷尺寸或窗口已变化，请重新载入");
                    }
                    materialRevision = v.currentRevision();
                }
                case "REMNANT" -> {
                    var remnant = v.findRemnant(materialId).orElseThrow(WorkbenchJobContextService::hidden);
                    if (!same(remnant.getWidth(), c.physicalWidthMm()) || c.windowStartMm() != 0
                            || c.windowLengthMm() > remnant.getLength() + .051) throw invalid("料头尺寸或窗口已变化");
                    materialRevision = v.currentRevision();
                }
                default -> throw invalid("未知材料类型");
            }
            return new WorkbenchJobSource(boundTaskId, actor, taskRevision, c.materialType(), materialId, materialRevision,
                    c.physicalWidthMm(), c.windowStartMm(), c.windowLengthMm(), c.rectGapPaddingMm(), boundLines);
        });
        return new Accepted(jobs.submit(key, submission.request(), source), source.taskId());
    }

    private static boolean matchesLines(CuttingTask task, NestingProblem p, double padding, Map<Integer, Integer> lines) {
        var byId = task.demands().stream().collect(Collectors.toMap(CuttingTask.Line::id, Function.identity()));
        var assigned = new HashSet<Integer>();
        if (lines.size() != p.parts().size()) return false;
        for (var part : p.parts()) {
            Integer lineId = lines.get(part.id());
            var line = byId.get(lineId);
            if (line == null || !assigned.add(lineId) || part.shape() == null || part.quantity() < 1
                    || part.quantity() > line.quantity() || !java.util.Objects.equals(part.name(), line.name())
                    || (part.allowRotation() && !line.allowRotation())
                    || (Boolean.TRUE.equals(part.allowHalfTurn()) && !Boolean.TRUE.equals(line.allowHalfTurn()))
                    || part.rule() != null || !matchesOutline(part.shape(), line, padding)
                    || !same(part.shape().width() - padding, line.width())
                    || !same(part.shape().height() - padding, line.length())) {
                return false;
            }
        }
        return true;
    }

    private static boolean matchesOutline(NestingProblem.Shape actual, CuttingTask.Line line, double padding) {
        var original = line.shape() == null ? NestingProblem.Shape.rectangle(line.width(), line.length()) : line.shape();
        if (padding > 0) return "RECTANGLE".equals(actual.type()) && "RECTANGLE".equals(original.type())
                && !actual.hasHoles() && !original.hasHoles();
        var expected = PolygonGeometry.allRings(original);
        var submitted = PolygonGeometry.allRings(actual);
        if (submitted.size() != expected.size()) return false;
        for (int ring = 0; ring < expected.size(); ring++) {
            var a = expected.get(ring);
            var b = submitted.get(ring);
            if (a.size() != b.size()) return false;
            for (int i = 0; i < a.size(); i++) {
                if (!same(a.get(i).x(), b.get(i).x()) || !same(a.get(i).y(), b.get(i).y())) return false;
            }
        }
        return true;
    }

    private static boolean isDraft(String id) {
        return id != null && id.matches("scratch:[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}");
    }

    public WorkbenchJobSource authorize(String taskId, String resultId, String actor) {
        var source = jobs.workbenchSource(resultId);
        if (source == null || !source.taskId().equals(taskId) || !source.actor().equals(actor)) throw hidden();
        return source;
    }

    private static boolean same(double lhs, double rhs) {
        return Math.abs(lhs - rhs) <= .05000001; // Solver inputs are quantized to 0.1 mm.
    }

    private static OptimizationService.Failure invalid(String message) {
        return new OptimizationService.Failure("INVALID_WORKBENCH_SOURCE", message, 422, false);
    }

    private static OptimizationService.Failure hidden() {
        return new OptimizationService.Failure("NOT_FOUND", "工作台工单、材料或结果不可用", 404, false);
    }
}
