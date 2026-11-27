package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.CutReport;
import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.ExecutionOrder;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.QualityDisposition;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.business.model.SolveResponse;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.geometry.RemnantPiece;
import com.example.cutdemotwo.persistence.InventoryConflictException;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.function.DoubleSupplier;
import java.util.function.Supplier;
import java.util.stream.Collectors;

/**
 * 现场执行单、切割计划、裁切报工、批次报工、冲销、复检处置/撤销与聚合对账垂直领域服务：
 * 仅依赖 InventoryStateKernel，与其他三个垂直领域服务保持零耦合。
 */
final class CuttingExecutionAndReportService {

    private final InventoryStateKernel kernel;
    private final DoubleSupplier toleranceSupplier;

    CuttingExecutionAndReportService(InventoryStateKernel kernel, DoubleSupplier toleranceSupplier) {
        this.kernel = kernel;
        this.toleranceSupplier = toleranceSupplier;
    }

    // ==================== 执行单 ====================

    ExecutionOrder createExecution(String key, ExecutionOrder.Create input) {
        if (key == null || !key.matches("[A-Za-z0-9._:-]{8,128}") || input == null || input.planId() == null
                || input.station() == null || input.station().isBlank() || input.station().length() > 100)
            throw new IllegalArgumentException("请提供有效幂等键、方案和 1–100 字工位");
        return kernel.mutate(() -> {
            for (var e : kernel.executions.values()) {
                if (e.idempotencyKey().equals(key)) {
                    if (!e.planId().equals(input.planId()) || !e.station().equals(input.station()))
                        throw new InventoryConflictException("同一幂等键已用于其他执行单内容");
                    return e;
                }
            }
            var plan = kernel.findOrLoadPlan(input.planId());
            if (plan == null || !"PENDING".equals(plan.status()) || plan.request().getTaskId() == null || plan.result().getPieces().isEmpty())
                throw new IllegalArgumentException("执行单必须关联有裁片且尚未报工的任务方案");
            if (kernel.executions.values().stream().anyMatch(e -> e.planId().equals(plan.id())
                    && !Set.of("CANCELLED", "EXPIRED").contains(e.effectiveState(kernel.currentOperationTime()))))
                throw new InventoryConflictException("该方案已有执行单，请查询已有执行单");
            var demandCounts = new LinkedHashMap<String, Integer>();
            plan.result().getPieces().forEach(piece -> {
                if (piece.getDemandId() == null) throw new IllegalArgumentException("裁片缺少需求身份");
                demandCounts.merge(String.valueOf(piece.getDemandId()), 1, Integer::sum);
            });
            var request = plan.request();
            boolean remnant = "remnant".equals(request.getFeedPortType());
            var e = new ExecutionOrder(UUID.randomUUID().toString(), key, plan.id(), request.getTaskId(), input.station(),
                    remnant ? "remnant" : "roll", remnant ? request.getSourceRemnantId() : request.getRollId(), demandCounts,
                    "DRAFT", 1, kernel.currentOperationTime(), null, List.of());
            kernel.executions.put(e.id(), e);
            return e;
        });
    }

    List<Map<String, Object>> executionOrders(String taskId) {
        return kernel.read(() -> executionOrdersInternal(taskId));
    }

    List<Map<String, Object>> executionOrdersInternal(String taskId) {
        Collection<ExecutionOrder> source = (taskId != null && kernel.store.supportsHotColdLoading())
                ? kernel.store.listTaskExecutions(taskId)
                : kernel.executions.values();
        return source.stream().filter(e -> taskId == null || taskId.equals(e.taskId()))
                .sorted(Comparator.comparingLong(ExecutionOrder::createdAt).thenComparing(ExecutionOrder::id))
                .map(this::executionView).toList();
    }

    Map<String, Object> executionOrder(String id) {
        return kernel.read(() -> executionView(requiredExecution(id)));
    }

    private Map<String, Object> executionView(ExecutionOrder e) {
        return CuttingExecutionProjectionHelper.buildExecutionView(e, kernel.currentOperationTime(), this::validateExecutionRelease);
    }

    private ExecutionOrder requiredExecution(String id) {
        var e = kernel.findOrLoadExecution(id);
        if (e == null) throw new IllegalArgumentException("执行单不存在");
        return e;
    }

    ExecutionOrder changeExecution(String id, String action, ExecutionOrder.Command command) {
        if (command == null || command.operationId() == null || !command.operationId().matches("[A-Za-z0-9._:-]{8,128}")
                || command.expectedVersion() < 1 || command.reason() == null || command.reason().length() > 500)
            throw new IllegalArgumentException("请提供操作幂等编号、执行单版本与不超过 500 字原因");
        if (!Set.of("release", "start", "cancel").contains(action)) throw new IllegalArgumentException("未知执行单操作");
        if ("release".equals(action) ? command.reservationSeconds() < 1 || command.reservationSeconds() > 86400 : command.reservationSeconds() != 0)
            throw new IllegalArgumentException("下达预约时长须为 1–86400 秒，其他操作填 0");
        if ("cancel".equals(action) && command.reason().isBlank()) throw new IllegalArgumentException("取消须填写原因");
        return kernel.mutate(() -> {
            var e = requiredExecution(id);
            for (var event : e.events()) {
                if (event.operationId().equals(command.operationId())) {
                    if (!event.action().equals(action) || event.expectedVersion() != command.expectedVersion()
                            || event.reservationSeconds() != command.reservationSeconds() || !event.reason().equals(command.reason()))
                        throw new InventoryConflictException("操作编号已绑定不同执行命令");
                    return e;
                }
            }
            if (e.version() != command.expectedVersion()) throw new InventoryConflictException("执行单版本已变化，请刷新");
            long now = kernel.currentOperationTime();
            String state = e.effectiveState(now);
            ExecutionOrder updated;
            switch (action) {
                case "release" -> {
                    if (!Set.of("DRAFT", "EXPIRED").contains(state)) throw new InventoryConflictException("只有待下达或预约已过期的执行单可以下达");
                    validateExecutionRelease(e);
                    updated = e.transition("RELEASED", now + command.reservationSeconds() * 1000L, action, command, now);
                }
                case "start" -> {
                    if (!"RELEASED".equals(state)) throw new InventoryConflictException("执行单尚未下达、预约已过期或已开工");
                    validateExecutionRelease(e);
                    updated = e.transition("RUNNING", null, action, command, now);
                }
                default -> {
                    if (!Set.of("DRAFT", "RELEASED", "EXPIRED").contains(state))
                        throw new InventoryConflictException("已开工不能取消或删除；请按实际产出报工");
                    updated = e.transition("CANCELLED", null, action, command, now);
                }
            }
            kernel.executions.put(id, updated);
            return updated;
        });
    }

    private void validateExecutionRelease(ExecutionOrder execution) {
        if (kernel.executions.values().stream().anyMatch(e -> !e.id().equals(execution.id()) && e.planId().equals(execution.planId()) && e.reserves(kernel.currentOperationTime())))
            throw new InventoryConflictException("同一方案已有其他有效执行单");
        var plan = kernel.findOrLoadPlan(execution.planId());
        if (plan == null || !"PENDING".equals(plan.status())) throw new InventoryConflictException("方案已失效或报工");
        kernel.prepareTaskSolveInternal(kernel.json.readValue(kernel.json.writeValueAsBytes(plan.request()), SolveRequest.class));
        if (!Objects.equals(plan.baseline(), kernel.materialFingerprintInternal(plan.request())))
            throw new InventoryConflictException("方案材料快照已变化，请重新排料");
        kernel.ensureMaterialNotReserved(execution.materialType(), execution.materialId(), execution.planId());
        if ("roll".equals(execution.materialType()) && !"PASSED".equals(kernel.findOrLoadRoll(execution.materialId()).getInspectionStatus()))
            throw new InventoryConflictException("母卷尚未检验合格，不能下达");
        var completed = kernel.completedQuantitiesInternal(execution.taskId());
        var reserved = kernel.reservedQuantities(execution.taskId(), execution.planId());
        var task = kernel.findOrLoadTask(execution.taskId());
        for (var entry : execution.demandQuantities().entrySet()) {
            var line = task.demands().stream().filter(d -> String.valueOf(d.id()).equals(entry.getKey())).findFirst()
                    .orElseThrow(() -> new InventoryConflictException("执行单需求已失效"));
            if (entry.getValue() > line.quantity() - completed.getOrDefault(entry.getKey(), 0) - reserved.getOrDefault(entry.getKey(), 0))
                throw new InventoryConflictException("需求已被其他执行单占用或已完成，不能重复下达");
        }
    }

    Map<String, Object> reportExecution(String id, CutReport report) {
        return kernel.mutate("CUT_REPORT", report == null ? null : report.planId(), "UNAUTHENTICATED_LOCAL", () -> {
            var e = requiredExecution(id);
            if (report == null || !e.planId().equals(report.planId())) throw new IllegalArgumentException("报工方案与执行单不一致");
            if (!Set.of("RUNNING", "REPORTED").contains(e.state())) throw new InventoryConflictException("执行单尚未开工或已终止");
            return confirmPlanInternal(report);
        });
    }

    private void validateExecutionReport(SolveRequest request, SolveResponse result, CutReport report) {
        boolean remnant = "remnant".equalsIgnoreCase(request.getFeedPortType());
        String matType = remnant ? "remnant" : "roll";
        String matId = remnant ? request.getSourceRemnantId() : request.getRollId();
        if (kernel.isMaterialReservedByExecution(matType, matId, report.planId()))
            throw new InventoryConflictException("材料已被其他执行单预约或正在加工，请先处理原执行单");
        if (remnant) {
            if (kernel.isMaterialReservedByScheme("remnant", matId, report.planId()))
                throw new InventoryConflictException("料头已被活跃排程方案预约或下发，请先完工或作废原排程方案");
        } else if (kernel.isPlanLinkedToActiveScheme(report.planId())) {
            if (kernel.isRollIntervalReservedByOtherScheme(matId, request.getWindowStartY(), report.actualCutLen(), report.planId()))
                throw new InventoryConflictException("本工位实切区间与其他活跃排程方案预占区间重叠");
        } else if (kernel.isMaterialReservedByScheme("roll", matId, null)) {
            throw new InventoryConflictException("母卷已被活跃排程方案预约或下发，禁止绕过排程方案直接报工");
        }
        var execution = kernel.executions.values().stream().filter(e -> e.planId().equals(report.planId()))
                .max(Comparator.comparing((ExecutionOrder e) -> "RUNNING".equals(e.state())).thenComparingLong(ExecutionOrder::createdAt));
        if (execution.isPresent()) {
            var e = execution.get();
            if (!"RUNNING".equals(e.state())) throw new InventoryConflictException("请通过已下达执行单开工后报工");
            var original = kernel.findOrLoadPlan(e.planId());
            if (original == null || !kernel.json.writeValueAsString(request).equals(kernel.json.writeValueAsString(original.request()))
                    || !kernel.json.writeValueAsString(result).equals(kernel.json.writeValueAsString(original.result())))
                throw new InventoryConflictException("执行报工不得替换已下达方案内容");
        }
    }

    private void finishExecution(String planId, String state) {
        kernel.executions.replaceAll((id, e) -> e.planId().equals(planId) && Set.of("RUNNING", "REPORTED").contains(e.state())
                ? e.transition(state, null, state.toLowerCase(),
                new ExecutionOrder.Command("system-" + state.toLowerCase() + "-" + planId, e.version(), 0, "报工事务"),
                kernel.currentOperationTime()) : e);
    }

    private double skippedCoverage(String rollId, double from, double to) {
        double covered = 0;
        Collection<Map<String, Object>> source = kernel.store.supportsHotColdLoading()
                ? kernel.store.findCutReportsByRollId(rollId) : kernel.receipts.values();
        for (Map<String, Object> receipt : source) {
            if ("REVERSED".equals(receipt.get("status")) || !"roll".equals(receipt.get("feedPortType")) || !Objects.equals(rollId, receipt.get("rollId"))) continue;
            if (!(receipt.get("undo") instanceof Map<?, ?> undo) || !(undo.get("skippedFrom") instanceof Number a) || !(undo.get("skipped") instanceof Number n)) continue;
            covered += Math.max(0, Math.min(to, a.doubleValue() + n.doubleValue()) - Math.max(from, a.doubleValue()));
        }
        return covered;
    }

    // ==================== 切割计划与调整 ====================

    void rememberPlan(CuttingPlan plan) {
        kernel.mutate(() -> {
            if (!Objects.equals(plan.baseline(), kernel.materialFingerprintInternal(plan.request())))
                throw new IllegalArgumentException("求解期间材料或疵点已更新，请重新排料");
            kernel.plans.put(plan.id(), kernel.json.readValue(kernel.json.writeValueAsBytes(plan), CuttingPlan.class));
            return null;
        });
    }

    CuttingPlan getPlan(String id) {
        return kernel.read(() -> {
            CuttingPlan plan = kernel.findOrLoadPlan(id);
            if (plan == null) throw new IllegalArgumentException("方案不存在");
            return plan;
        });
    }

    CuttingPlan rememberAdjustment(String parentId, String id, SolveResponse result) {
        return kernel.mutate(() -> {
            CuttingPlan existing = kernel.findOrLoadPlan(id);
            if (existing != null) {
                if (!Objects.equals(existing.parentPlanId(), parentId)
                        || !kernel.json.writeValueAsString(existing.result()).equals(kernel.json.writeValueAsString(result)))
                    throw new IllegalArgumentException("调整操作编号已用于其他内容，请重新校验");
                return existing;
            }
            kernel.ensurePlanNotExecuting(parentId);
            CuttingPlan parent = kernel.findOrLoadPlan(parentId);
            if (parent == null || !"PENDING".equals(parent.status())) throw new IllegalArgumentException("原方案已报工或取消，不能保存调整版");
            kernel.prepareTaskSolveInternal(parent.request());
            if (!Objects.equals(parent.baseline(), kernel.materialFingerprintInternal(parent.request())))
                throw new IllegalArgumentException("材料或疵点已变化，请重新装载并排料");
            CuttingPlan adjusted = new CuttingPlan(id, parent.request(), result, parent.baseline(), "PENDING",
                    LocalDateTime.now().toString(), parentId, parent.version() + 1);
            adjusted = kernel.json.readValue(kernel.json.writeValueAsBytes(adjusted), CuttingPlan.class);
            kernel.plans.put(parentId, parent.withStatus("CANCELLED"));
            kernel.plans.put(id, adjusted);
            return adjusted;
        });
    }

    List<CuttingPlan> taskPlans(String taskId) {
        return taskPlans(taskId, false);
    }

    List<CuttingPlan> taskPlans(String taskId, boolean summary) {
        return kernel.read(() -> {
            Collection<CuttingPlan> source = (taskId != null && kernel.store.supportsHotColdLoading())
                    ? kernel.store.listTaskPlans(taskId)
                    : kernel.plans.values().stream().filter(p -> Objects.equals(taskId, p.request().getTaskId())).toList();
            return source.stream()
                    .filter(p -> Objects.equals(taskId, p.request().getTaskId()))
                    .map(p -> summary ? summarizePlan(p) : p)
                    .toList();
        });
    }

    private CuttingPlan summarizePlan(CuttingPlan plan) {
        return CuttingExecutionProjectionHelper.summarizePlan(plan);
    }

    Map<String, String> planChecks(String taskId) {
        return kernel.read(() -> {
            CuttingTask task = kernel.findOrLoadTask(taskId);
            if (task == null) throw new IllegalArgumentException("切割任务不存在");
            Map<String, String> result = new LinkedHashMap<>();
            for (CuttingPlan plan : kernel.plans.values()) {
                if (!Objects.equals(taskId, plan.request().getTaskId()) || !"PENDING".equals(plan.status())) continue;
                String reason = null;
                try {
                    if (!Objects.equals(plan.baseline(), kernel.materialFingerprintInternal(plan.request())))
                        reason = "材料或疵点已更新（验疵、作废疵点或盘点），需重新计算";
                } catch (IllegalArgumentException missing) {
                    reason = "所用材料已不在库存，需重新选料计算";
                }
                if (reason == null && task.revision() != plan.request().getTaskRevision()) reason = "任务需求已改版，需重新计算";
                if (reason != null) result.put(plan.id(), reason);
            }
            return result;
        });
    }

    CuttingPlan changePlanStatus(String id, boolean restore) {
        return kernel.mutate(() -> {
            kernel.ensurePlanNotExecuting(id);
            CuttingPlan plan = kernel.findOrLoadPlan(id);
            if (plan == null || !Set.of("PENDING", "CANCELLED").contains(plan.status()))
                throw new IllegalArgumentException("已报工方案不能取消或恢复，请通过报工记录冲销");
            if (restore) {
                kernel.prepareTaskSolveInternal(plan.request());
                if (!Objects.equals(plan.baseline(), kernel.materialFingerprintInternal(plan.request())))
                    throw new IllegalArgumentException("材料或疵点已更新，请重新排料");
            }
            CuttingPlan updated = plan.withStatus(restore ? "PENDING" : "CANCELLED");
            kernel.plans.put(id, updated);
            return updated;
        });
    }

    Map<String, Object> planDetail(String id) {
        return kernel.read(() -> CuttingExecutionProjectionHelper.buildPlanDetail(
                getPlan(id), kernel.qualityProjection(kernel.findOrLoadReceipt(id))));
    }

    // ==================== 裁切报工、批次报工与冲销 ====================

    Map<String, Object> confirmPlan(CutReport report) {
        if (report == null || report.planId() == null) throw new IllegalArgumentException("请先取得方案编号");
        Map<String, Object> existing = kernel.read(() -> kernel.findOrLoadReceipt(report.planId()));
        if (existing != null) {
            if ("REVERSED".equals(existing.get("status"))) throw new IllegalArgumentException("该报工已冲销，请重新排料");
            kernel.verifyReportReplay(existing, report);
            return kernel.qualityProjection(existing);
        }
        return kernel.mutate("CUT_REPORT", report.planId(), "UNAUTHENTICATED_LOCAL", () -> confirmPlanInternal(report));
    }

    Map<String, Object> confirmPlanInternal(CutReport report) {
        return confirmPlanInternal(report, Set.of(), null, null);
    }

    Map<String, Object> confirmPlanInternal(CutReport report, Set<String> pendingBatchPlans) {
        return confirmPlanInternal(report, pendingBatchPlans, null, null);
    }

    Map<String, Object> confirmPlanInternal(
            CutReport report,
            Set<String> pendingBatchPlans,
            Map<String, Map<String, Integer>> taskDemandQuantities,
            Map<Integer, SchedulingScheme.TaskDemandAllocation> pieceSources
    ) {
        Map<String, Object> receipt = kernel.findOrLoadReceipt(report.planId());
        if (receipt != null) {
            if ("REVERSED".equals(receipt.get("status"))) throw new IllegalArgumentException("该报工已冲销，请重新排料");
            kernel.verifyReportReplay(receipt, report);
            return kernel.qualityProjection(receipt);
        }
        CuttingPlan plan = kernel.findOrLoadPlan(report.planId());
        if (plan == null || !"PENDING".equals(plan.status())) throw new IllegalArgumentException("方案不存在或已取消，请重新排料");
        if (!Objects.equals(plan.baseline(), kernel.materialFingerprintInternal(plan.request())))
            throw new IllegalArgumentException("材料或疵点已更新，请重新装载并排料");
        Map<String, Object> result = confirmInternal(plan.request(), plan.result(), report, pendingBatchPlans, taskDemandQuantities, pieceSources);
        kernel.plans.put(plan.id(), plan.withStatus("CONFIRMED"));
        return kernel.qualityProjection(result);
    }

    Map<String, Object> confirm(SolveRequest request, SolveResponse plan, CutReport report) {
        return kernel.mutate("CUT_REPORT", report.planId(), "UNAUTHENTICATED_LOCAL",
                () -> confirmInternal(request, plan, report, Set.of(), null, null));
    }

    Map<String, Object> confirm(SolveRequest request, SolveResponse plan, CutReport report, String baseline) {
        return kernel.mutate("CUT_REPORT", report.planId(), "UNAUTHENTICATED_LOCAL", () -> {
            if (!Objects.equals(baseline, kernel.materialFingerprintInternal(request)))
                throw new IllegalArgumentException("材料或疵点已更新，请重新装载并排料");
            return confirmInternal(request, plan, report, Set.of(), null, null);
        });
    }

    private void validateTaskReport(SolveRequest request, SolveResponse plan, ReportOutput result) {
        if (request.getTaskId() == null) return;
        CuttingTask task = kernel.findOrLoadTask(request.getTaskId());
        if (task == null || task.revision() != request.getTaskRevision()) throw new IllegalArgumentException("任务已更新，请重新载入需求");
        boolean remnant = "remnant".equals(request.getFeedPortType());
        var roll = kernel.findOrLoadRoll(request.getRollId());
        var stock = remnant ? kernel.findOrLoadRemnant(request.getSourceRemnantId()) : null;
        String model = remnant ? (stock == null ? null : stock.getMaterialBatch()) : (roll == null ? null : roll.getRollModel());
        if (!Objects.equals(task.materialModel(), model)) throw new IllegalArgumentException("材料型号与任务需求不一致");
        if (remnant && !Objects.equals(stock.getSourceRollId(), request.getRollId())) throw new IllegalArgumentException("料头来源母卷不一致");
        kernel.validateBatchAndColorInternal(task, roll, remnant ? stock : null);
        if (plan.getPieces().stream().anyMatch(p -> p.getDemandId() == null)) throw new IllegalArgumentException("裁片缺少需求归属");
        Map<Integer, Long> good = result.qualified().stream().collect(Collectors.groupingBy(p -> p.getDemandId(), Collectors.counting()));
        Map<String, Integer> completed = kernel.completedQuantitiesInternal(task.id());
        var reserved = kernel.reservedQuantities(task.id(), plan.getPlanId());
        for (var piece : plan.getPieces()) {
            var line = task.demands().stream().filter(d -> d.id() == piece.getDemandId()).findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("裁片缺少需求归属"));
            double w = piece.isRotated() ? line.length() : line.width(), l = piece.isRotated() ? line.width() : line.length();
            if (Math.abs(piece.getW() - w) > .001 || Math.abs(piece.getL() - l) > .001)
                throw new IllegalArgumentException("裁片尺寸与当前需求不一致");
            if (good.getOrDefault(line.id(), 0L) > line.quantity() - completed.getOrDefault(String.valueOf(line.id()), 0) - reserved.getOrDefault(String.valueOf(line.id()), 0))
                throw new IllegalArgumentException("合格裁片超过当前剩余需求，请刷新任务后核对");
        }
    }

    private Map<String, Object> confirmInternal(SolveRequest request, SolveResponse plan, CutReport report,
                                                Set<String> pendingBatchPlans,
                                                Map<String, Map<String, Integer>> taskDemandQuantities,
                                                Map<Integer, SchedulingScheme.TaskDemandAllocation> pieceSources) {
        Map<String, Object> old = kernel.findOrLoadReceipt(report.planId());
        if (old != null) {
            if ("REVERSED".equals(old.get("status"))) throw new IllegalArgumentException("该报工已撤回，请重新排料");
            kernel.verifyReportReplay(old, report);
            return old;
        }
        validateExecutionReport(request, plan, report);
        ReportOutput output = ReportOutput.resolve(plan, report);
        validateTaskReport(request, plan, output);
        boolean remnantFeed = "remnant".equalsIgnoreCase(request.getFeedPortType());
        MotherRollInfo roll = kernel.findOrLoadRoll(request.getRollId());
        RemnantStock parent = remnantFeed ? kernel.findOrLoadRemnant(request.getSourceRemnantId()) : null;
        if (remnantFeed && (parent == null || !"AVAILABLE".equals(parent.getStatus()))) {
            throw new IllegalArgumentException("原料头已不可用，请重新装载");
        }
        if (!remnantFeed && roll == null) throw new IllegalArgumentException("母卷不存在，请先从母卷档案装载");
        if (remnantFeed ? (Math.abs(parent.getWidth() - request.getRollW()) > 0.001 ||
                Math.abs(parent.getLength() - request.getRollL()) > 0.001) :
                Math.abs(roll.getWidth() - request.getRollW()) > 0.001) {
            throw new IllegalArgumentException("母料尺寸与库存档案不一致，请重新装载");
        }

        double len = report.actualCutLen();
        double used = remnantFeed ? 0 : roll.getUsedLength(), start0 = request.getWindowStartY();
        double skipped = remnantFeed ? 0 : Math.max(0, start0 - used);
        double consumed = remnantFeed ? 0 : start0 >= used - 0.001 ? skipped + len
                : Math.max(0, len - skippedCoverage(request.getRollId(), start0, start0 + len));
        if (remnantFeed ? len != 0 : (!Double.isFinite(len) || len <= 0 || len > request.getRollL() || consumed > roll.getCurrentRemainingLength() + 0.001)) {
            throw new IllegalArgumentException("实切长度无效或超过母卷剩余长度");
        }
        if (!remnantFeed) {
            double start = request.getWindowStartY();
            if (!Double.isFinite(start) || start < 0 || start + len > roll.getTotalLength()) {
                throw new IllegalArgumentException("红框实切区间超出母卷范围");
            }
            Map<String, Map<String, Object>> rollReports = new LinkedHashMap<>();
            if (kernel.store.supportsHotColdLoading()) {
                for (Map<String, Object> dbRec : kernel.store.findCutReportsByRollId(request.getRollId())) {
                    if (dbRec.get("planId") != null) rollReports.put(dbRec.get("planId").toString(), dbRec);
                }
            }
            rollReports.putAll(kernel.receipts);
            for (Map<String, Object> receipt : rollReports.values()) {
                if ("REVERSED".equals(receipt.get("status"))) continue;
                if (!request.getRollId().equals(receipt.get("rollId")) || !"roll".equals(receipt.get("feedPortType"))) continue;
                double oldStart = ((Number) receipt.get("windowStartY")).doubleValue();
                double oldEnd = oldStart + ((Number) receipt.get("actualCutLen")).doubleValue();
                double end = start + len;
                double noise = 4 * Math.max(Math.max(Math.ulp(start), Math.ulp(end)),
                        Math.max(Math.ulp(oldStart), Math.ulp(oldEnd)));
                if (Math.min(end, oldEnd) - Math.max(start, oldStart) > noise) {
                    boolean pendingConflict = pendingBatchPlans.contains(receipt.get("planId"));
                    throw new IllegalArgumentException(pendingConflict
                            ? "本工位实切区间与本批次待报工工位重叠，请核对工位位置和实切长度"
                            : "本工位实切区间与已报工区间重叠，请移动到未切区间");
                }
            }
        }
        double maxPieceY = output.cutPieces().stream().mapToDouble(p -> p.getY() + p.getL()).max().orElse(0);
        if (!remnantFeed && len + 0.001 < maxPieceY) throw new IllegalArgumentException("实切长度短于合格或异常裁片的末端");
        List<RemnantPiece> actual = report.actualRemnants() == null ? List.of() : report.actualRemnants();
        if (remnantFeed && !actual.isEmpty()) throw new IllegalArgumentException("料头只使用一次，剩余部分不再回收；请退回核对后重新报工");
        double remArea = 0;
        Set<String> seen = new HashSet<>();
        List<double[]> recoveredBounds = new ArrayList<>();
        double sourceLength = remnantFeed ? parent.getLength() : len;
        var recoveryCandidates = output.recoveryCandidates(plan, sourceLength);
        double tolRaw = toleranceSupplier.getAsDouble();
        double tolerance = Double.isFinite(tolRaw) ? Math.max(0, tolRaw) : 0;
        for (RemnantPiece item : actual) {
            if (item == null || item.getId() == null || !seen.add(item.getId())) throw new IllegalArgumentException("料头编号重复或为空");
            RemnantPiece proposed = recoveryCandidates.get(item.getId());
            if (proposed == null) throw new IllegalArgumentException("料头不属于当前排料或未切区域: " + item.getId());
            if (!Double.isFinite(item.getW()) || !Double.isFinite(item.getL()) || item.getW() <= 0 || item.getL() <= 0 ||
                    item.getW() > proposed.getW() + tolerance + 0.001 || item.getL() > proposed.getL() + tolerance + 0.001 ||
                    (proposed.isHasDefect() && !item.isHasDefect()) ||
                    proposed.getX() < 0 || proposed.getY() < 0 ||
                    proposed.getX() + item.getW() > request.getRollW() + 0.001 ||
                    proposed.getY() + item.getL() > sourceLength + 0.001) {
                throw new IllegalArgumentException("实测料头超出排料范围: " + item.getId());
            }
            boolean intersectsPiece = output.cutPieces().stream().anyMatch(piece -> overlaps(
                    proposed.getX(), proposed.getY(), item.getW(), item.getL(),
                    piece.getX(), piece.getY(), piece.getW(), piece.getL()));
            boolean intersectsRemnant = recoveredBounds.stream().anyMatch(bounds -> overlaps(
                    proposed.getX(), proposed.getY(), item.getW(), item.getL(),
                    bounds[0], bounds[1], bounds[2], bounds[3]));
            if (intersectsPiece || intersectsRemnant) {
                throw new IllegalArgumentException("实测料头与成品或其他料头重叠: " + item.getId());
            }
            recoveredBounds.add(new double[]{proposed.getX(), proposed.getY(), item.getW(), item.getL()});
            remArea += item.getW() * item.getL() / 1_000_000.0;
        }
        double sourceArea = (remnantFeed ? parent.getArea() : request.getRollW() * len / 1_000_000.0);
        if (output.qualifiedArea() + output.rejectedArea() + remArea > sourceArea + 0.001)
            throw new IllegalArgumentException("合格、异常裁片与料头面积超过实切用料面积");

        Map<String, Object> undo = new LinkedHashMap<>();
        if (remnantFeed) {
            undo.put("parentBefore", kernel.json.writeValueAsString(parent));
            parent.setStatus("CONSUMED");
            parent.setConsumedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
            undo.put("parentAfter", kernel.json.writeValueAsString(parent));
        } else {
            undo.put("remainingBefore", roll.getCurrentRemainingLength());
            undo.put("usedBefore", roll.getUsedLength());
            if (skipped > 0.001) {
                undo.put("skippedFrom", used);
                undo.put("skipped", skipped);
            }
            roll.setCurrentRemainingLength(roll.getCurrentRemainingLength() - consumed);
            roll.setUsedLength(roll.getUsedLength() + consumed);
            undo.put("remainingAfter", roll.getCurrentRemainingLength());
            undo.put("usedAfter", roll.getUsedLength());
        }
        List<RemnantStock> children = new ArrayList<>();
        List<Map<String, Object>> recoveredGeometry = new ArrayList<>();
        for (RemnantPiece item : actual) {
            if (item.getW() < request.getMinRemnantWidth() || item.getL() < request.getMinRemnantLength()) continue;
            RemnantPiece proposed = recoveryCandidates.get(item.getId());
            List<Defect> childDefects = new ArrayList<>();
            for (Defect defect : request.getDefects()) {
                double left = Math.max(proposed.getX(), defect.getSafeX());
                double top = Math.max(proposed.getY(), defect.getSafeY());
                double right = Math.min(proposed.getX() + item.getW(), defect.getSafeX() + defect.getSafeW());
                double bottom = Math.min(proposed.getY() + item.getL(), defect.getSafeY() + defect.getSafeH());
                if (right > left && bottom > top) {
                    childDefects.add(new Defect(defect.getId(), left - proposed.getX(), top - proposed.getY(),
                            right - left, bottom - top, 0, defect.getDefectType(), defect.getTypeName(),
                            defect.getSeverity(), defect.getPoints(), defect.getDetectionSource(),
                            defect.getAvoidanceStrategy(), defect.getDescription()));
                }
            }
            String id = "REM-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMM")) + "-" +
                    String.format("%03d", kernel.remnantSeq.incrementAndGet());
            RemnantStock child = new RemnantStock(id, item.getW(), item.getL(),
                    report.location() == null || report.location().isBlank() ? "现场料头架" : report.location(),
                    request.getRollModel(), item.isHasDefect() && childDefects.isEmpty() ? "QUARANTINED" : "AVAILABLE",
                    request.getRollId(), item.isHasDefect() || !childDefects.isEmpty(), item.getStatus());
            child.setDefects(childDefects);
            child.setParentRemnantId(remnantFeed ? parent.getId() : null);
            child.setGeneration(remnantFeed ? parent.getGeneration() + 1 : 1);
            kernel.inheritLineageMetadata(child, roll, parent);
            child.setCreatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
            kernel.remnantPool.put(id, child);
            children.add(child);
            recoveredGeometry.add(Map.of("id", id, "sourceCandidateId", proposed.getId(), "x", proposed.getX(), "y", proposed.getY(),
                    "w", item.getW(), "l", item.getL(), "area", child.getArea(), "hasDefect", child.isHasDefect()));
        }
        Map<String, Object> receipt = new LinkedHashMap<>();
        receipt.put("planId", report.planId());
        receipt.put("status", "CONFIRMED");
        receipt.put("undo", undo);
        receipt.put("taskId", request.getTaskId());
        receipt.put("sourceRemnantId", request.getSourceRemnantId());
        Map<String, Integer> quantities = new LinkedHashMap<>();
        output.qualified().forEach(p -> quantities.merge(String.valueOf(p.getDemandId()), 1, Integer::sum));
        receipt.put("demandQuantities", quantities);
        if (taskDemandQuantities != null && !taskDemandQuantities.isEmpty()) {
            receipt.put("taskDemandQuantities", taskDemandQuantities);
        }
        if (pieceSources != null && !pieceSources.isEmpty()) {
            Map<String, Map<String, Object>> serializedSources = new LinkedHashMap<>();
            pieceSources.forEach((pid, alloc) -> serializedSources.put(String.valueOf(pid),
                    Map.of("taskId", alloc.taskId(), "lineId", alloc.lineId())));
            receipt.put("pieceSources", serializedSources);
        }
        receipt.put("pieceResults", output.details());
        receipt.put("rejectedPieceCount", output.rejected().size());
        receipt.put("uncutPieceCount", output.uncut().size());
        receipt.put("rejectedArea", output.rejectedArea());
        receipt.put("rollId", request.getRollId());
        receipt.put("windowStartY", request.getWindowStartY());
        receipt.put("feedPortType", remnantFeed ? "remnant" : "roll");
        receipt.put("actualCutLen", len);
        receipt.put("remainingLength", roll == null ? null : roll.getCurrentRemainingLength());
        receipt.put("finishedPieceCount", report.finishedPieceCount());
        receipt.put("pieceArea", output.qualifiedArea());
        receipt.put("usedArea", sourceArea);
        receipt.put("processingArea", request.getRollW() * request.getRollL() / 1_000_000.0);
        double recoveredArea = children.stream().mapToDouble(RemnantStock::getArea).sum();
        receipt.put("remArea", recoveredArea);
        receipt.put("wasteArea", Math.max(0, sourceArea - output.qualifiedArea() - recoveredArea));
        receipt.put("utilization", sourceArea == 0 ? 0 : output.qualifiedArea() / sourceArea * 100);
        List<RemnantStock> frozenChildren = children.stream()
                .map(c -> kernel.json.convertValue(c, RemnantStock.class))
                .toList();
        receipt.put("derivedRemnants", frozenChildren);
        receipt.put("recoveredGeometry", recoveredGeometry);
        receipt.put("inventoryCountRevision", kernel.countRevision(remnantFeed ? "remnant" : "roll",
                remnantFeed ? request.getSourceRemnantId() : request.getRollId()));
        receipt.put("confirmedAt", LocalDateTime.now().toString());
        receipt.put("reportContent", kernel.json.writeValueAsString(report));
        kernel.receipts.put(report.planId(), receipt);
        finishExecution(report.planId(), "REPORTED");
        return receipt;
    }

    private static boolean overlaps(double x, double y, double w, double l,
                                    double otherX, double otherY, double otherW, double otherL) {
        return CuttingExecutionProjectionHelper.overlaps(x, y, w, l, otherX, otherY, otherW, otherL);
    }

    List<Map<String, Object>> reportBatch(List<CutReport> reports, boolean preview) {
        if (reports == null || reports.isEmpty() || reports.size() > 100)
            throw new IllegalArgumentException("请选择 1 至 100 个待报工工位");
        Supplier<List<Map<String, Object>>> command = () -> {
            Set<String> seen = new HashSet<>();
            Set<String> pendingBatchPlans = new HashSet<>();
            List<Map<String, Object>> result = new ArrayList<>();
            String taskId = null;
            for (CutReport report : reports) {
                if (report == null || report.planId() == null || !seen.add(report.planId()))
                    throw new IllegalArgumentException("待报工方案编号为空或重复");
                CuttingPlan plan = kernel.findOrLoadPlan(report.planId());
                if (plan == null || plan.request().getTaskId() == null)
                    throw new IllegalArgumentException("待报工方案不存在或未关联任务");
                if (taskId == null) taskId = plan.request().getTaskId();
                if (!taskId.equals(plan.request().getTaskId())) throw new IllegalArgumentException("集中报工必须属于同一任务");
                boolean alreadyReported = kernel.findOrLoadReceipt(report.planId()) != null;
                result.add(confirmPlanInternal(report, pendingBatchPlans));
                if (!alreadyReported) pendingBatchPlans.add(report.planId());
            }
            return result;
        };
        if (!preview) return kernel.mutate("CUT_REPORT_BATCH", null, "UNAUTHENTICATED_LOCAL", command);
        return kernel.withWriteLock(() -> {
            var backup = kernel.captureBackup();
            try {
                return command.get();
            } finally {
                kernel.restoreBackup(backup);
            }
        });
    }

    Map<String, Object> reverseReport(String planId, String reason) {
        if (reason == null || reason.isBlank() || reason.length() > 500)
            throw new IllegalArgumentException("请填写 1 至 500 字的撤回原因");
        return kernel.mutate("REPORT_REVERSE", planId, "UNAUTHENTICATED_LOCAL", () -> {
            Map<String, Object> receipt = kernel.findOrLoadReceipt(planId);
            if (receipt == null) throw new IllegalArgumentException("报工记录不存在");
            if ("REVERSED".equals(receipt.get("status"))) return receipt;
            String countedType = "remnant".equals(receipt.get("feedPortType")) ? "remnant" : "roll";
            String countedId = Objects.toString(receipt.get("remnant".equals(countedType) ? "sourceRemnantId" : "rollId"), "");
            long originalCount = receipt.get("inventoryCountRevision") instanceof Number n ? n.longValue() : 0;
            if (kernel.countRevision(countedType, countedId) != originalCount)
                throw new InventoryConflictException("材料已有后续盘点，不能用撤回覆盖实测库存");
            if (!kernel.qualityEvents(receipt).isEmpty())
                throw new IllegalArgumentException("报工已有复检处置，不能撤回原料耗用；请保留实际裁切事实");
            if (!(receipt.get("undo") instanceof Map<?, ?> undo))
                throw new IllegalArgumentException("历史报工没有撤回快照，请人工核对库存后处理");
            List<RemnantStock> children = new ArrayList<>();
            for (Object item : (List<?>) receipt.get("derivedRemnants")) {
                RemnantStock original = kernel.json.convertValue(item, RemnantStock.class);
                kernel.ensureMaterialNotReserved("remnant", original.getId(), null);
                if (kernel.countRevision("remnant", original.getId()) > 0)
                    throw new InventoryConflictException("派生料头已有盘点追溯，不能撤回原报工");
                RemnantStock current = kernel.findOrLoadRemnant(original.getId());
                if (current == null || !kernel.json.writeValueAsString(original).equals(kernel.json.writeValueAsString(current)))
                    throw new IllegalArgumentException("派生料头 " + original.getId() + " 已流转或修改，请先撤回后续操作");
                children.add(current);
            }
            boolean remnant = "remnant".equals(receipt.get("feedPortType"));
            kernel.ensureMaterialNotReserved(remnant ? "remnant" : "roll",
                    String.valueOf(receipt.get(remnant ? "sourceRemnantId" : "rollId")), null);
            if (remnant) {
                RemnantStock parent = kernel.findOrLoadRemnant(Objects.toString(receipt.get("sourceRemnantId"), null));
                if (parent == null || !kernel.json.writeValueAsString(parent).equals(undo.get("parentAfter")))
                    throw new IllegalArgumentException("原料头状态已变化，不能撤回此报工");
                RemnantStock original = kernel.json.readValue(undo.get("parentBefore").toString(), RemnantStock.class);
                kernel.remnantPool.put(original.getId(), original);
            } else {
                String targetRollId = Objects.toString(receipt.get("rollId"), "");
                boolean isLatest;
                if (kernel.store.supportsHotColdLoading()) {
                    var latestOpt = kernel.store.findLatestActiveCutReportForRoll(targetRollId);
                    isLatest = latestOpt.isPresent() && Objects.equals(planId, latestOpt.get().get("planId"));
                } else {
                    Map<String, Object> latest = null;
                    for (var candidate : kernel.receipts.values())
                        if (!"REVERSED".equals(candidate.get("status")) && "roll".equals(candidate.get("feedPortType"))
                                && Objects.equals(targetRollId, candidate.get("rollId"))) latest = candidate;
                    isLatest = (latest == receipt);
                }
                MotherRollInfo roll = kernel.findOrLoadRoll(targetRollId);
                if (!isLatest || roll == null ||
                        Math.abs(roll.getUsedLength() - ((Number) undo.get("usedAfter")).doubleValue()) > .001 ||
                        Math.abs(roll.getCurrentRemainingLength() - ((Number) undo.get("remainingAfter")).doubleValue()) > .001)
                    throw new IllegalArgumentException("母卷已有后续报工或库存变更，请从最近一次报工开始撤回");
                roll.setUsedLength(((Number) undo.get("usedBefore")).doubleValue());
                roll.setCurrentRemainingLength(((Number) undo.get("remainingBefore")).doubleValue());
            }
            children.forEach(child -> child.setStatus("REVERSED"));
            String reversedAt = LocalDateTime.now().toString();
            Map<String, Object> updatedReceipt = new LinkedHashMap<>(receipt);
            updatedReceipt.put("status", "REVERSED");
            updatedReceipt.put("reversedAt", reversedAt);
            updatedReceipt.put("reversalReason", reason.trim());
            kernel.receipts.put(planId, updatedReceipt);
            finishExecution(planId, "REVERSED");
            CuttingPlan plan = kernel.findOrLoadPlan(planId);
            if (plan != null) kernel.plans.put(planId, plan.withStatus("REVERSED"));
            if (kernel.store.supportsHotColdLoading()) {
                for (SchedulingScheme sc : kernel.store.findActiveSchemesByPlanId(planId)) {
                    kernel.findOrLoadScheme(sc.id());
                }
            }
            kernel.schemes.replaceAll((sid, sc) -> sc.linkedPlanIds().contains(planId)
                    && !SchedulingScheme.STATE_CANCELLED.equals(sc.state())
                    && !SchedulingScheme.STATE_REVERSED.equals(sc.state())
                    ? sc.withReversed(reversedAt, reason.trim())
                    : sc);
            return updatedReceipt;
        });
    }

    // ==================== 复检处置、受控撤销与聚合对账 ====================

    Map<String, Object> getReceipt(String planId) {
        return kernel.read(() -> kernel.qualityProjection(kernel.findOrLoadReceipt(planId)));
    }

    Map<String, Object> qualityReview(String planId) {
        return kernel.read(() -> {
            var receipt = kernel.findOrLoadReceipt(planId);
            if (receipt == null) throw new IllegalArgumentException("报工记录不存在");
            return kernel.qualityProjection(receipt);
        });
    }

    QualityDisposition disposeQuality(String planId, QualityDisposition.Command command) {
        QualityDispositionRules.validateCommand(command);
        return kernel.mutate("QUALITY_DISPOSITION", planId, "DECLARED:" + command.inspector(), () -> {
            var receipt = kernel.findOrLoadReceipt(planId);
            if (receipt == null) throw new IllegalArgumentException("报工记录不存在");
            var events = new ArrayList<>(kernel.qualityEvents(receipt));
            for (var event : events) {
                if (event.command().operationId().equals(command.operationId())) {
                    if (event.command().equals(command)) return event;
                    throw new InventoryConflictException("此操作编号已用于其他复检内容，请刷新记录");
                }
            }
            if (!"CONFIRMED".equals(receipt.get("status"))) throw new IllegalArgumentException("仅已确认报工可以复检处置");
            if (command.expectedRevision() != kernel.qualityRevisionOf(events)) throw new InventoryConflictException("复检记录已更新，请重新打开报工记录");
            if (events.stream().anyMatch(e -> !e.hasRevocation() && e.command().pieceId() == command.pieceId()))
                throw new InventoryConflictException("该裁片已处置，不能重复转料头或报废");
            if (!(receipt.get("pieceResults") instanceof List<?> pieces))
                throw new IllegalArgumentException("历史记录缺少逐件产出，不能自动复检处置");
            var piece = pieces.stream().map(p -> kernel.json.convertValue(p, ReportOutput.ReportedPiece.class))
                    .filter(p -> p.pieceId() == command.pieceId()).findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("裁片不属于此报工"));
            var request = getPlan(planId).request();
            double recovered = QualityDispositionRules.recoveredArea(command, piece, request.getMinRemnantWidth(), request.getMinRemnantLength());
            double area = piece.shape() == null ? piece.w() * piece.l() : piece.shape().areaMm2();
            String eventId = UUID.randomUUID().toString(), now = LocalDateTime.now().toString(), remnantId = null;
            if ("REMNANT".equals(command.disposition())) {
                var region = command.recovery();
                remnantId = "REM-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMM")) + "-"
                        + String.format("%03d", kernel.remnantSeq.incrementAndGet());
                boolean isolated = "QUARANTINED".equals(region.quality());
                var child = new RemnantStock(remnantId, region.width(), region.length(), region.location().trim(), request.getRollModel(),
                        isolated ? "QUARANTINED" : "AVAILABLE", request.getRollId(), isolated, command.reason().trim());
                var parent = kernel.findOrLoadRemnant(request.getSourceRemnantId());
                child.setParentRemnantId(parent == null ? null : parent.getId());
                child.setGeneration(parent == null ? 1 : parent.getGeneration() + 1);
                kernel.inheritLineageMetadata(child, kernel.findOrLoadRoll(request.getRollId()), parent);
                child.setCreatedAt(now);
                child.setSourceReportId(planId);
                child.setSourcePieceId(piece.pieceId());
                child.setQualityDispositionId(eventId);
                kernel.remnantPool.put(remnantId, child);
            }
            var event = new QualityDisposition(eventId, planId, command, piece.demandId(), piece.outcome(), area,
                    recovered, Math.max(0, area - recovered), remnantId, now);
            events.add(event);
            Map<String, Object> updatedReceipt = new LinkedHashMap<>(receipt);
            updatedReceipt.put("qualityDispositions", events);
            kernel.receipts.put(planId, updatedReceipt);
            return event;
        });
    }

    Map<String, Object> revokeQualityDisposition(String reportId, String dispositionId,
                                                 String idempotencyKey, String operatorInput, String reasonInput) {
        if (reportId == null || reportId.isBlank() || dispositionId == null || dispositionId.isBlank()) {
            throw new IllegalArgumentException("请提供有效的报工编号和复检处置编号");
        }
        String key = InventoryStateKernel.requireIdempotencyKey(idempotencyKey);
        String operator = InventoryStateKernel.requireText(operatorInput, 100, "请填写 1–100 字操作人");
        String reason = InventoryStateKernel.requireText(reasonInput, 500, "请填写 1–500 字撤销原因");
        String cleanReportId = reportId.trim();
        String cleanDispositionId = dispositionId.trim();

        Map<String, Object> result = kernel.mutate("QUALITY_DISPOSITION_REVOKE", cleanReportId, "DECLARED:" + operator, () -> {
            Map<String, Object> targetReceipt = kernel.findOrLoadReceipt(cleanReportId);
            if (targetReceipt != null) {
                for (QualityDisposition ev : kernel.qualityEvents(targetReceipt)) {
                    if (ev.hasRevocation() && key.equals(ev.revocation().idempotencyKey())) {
                        if (cleanDispositionId.equals(ev.id())
                                && operator.equals(ev.revocation().operator()) && reason.equals(ev.revocation().reason())) {
                            return buildRevokeDispositionPayload(targetReceipt);
                        }
                        throw new InventoryConflictException("同一幂等键已用于其他复检处置撤销内容");
                    }
                }
            }
            if (kernel.store.supportsHotColdLoading()) {
                var matchedOther = kernel.store.findCutReportByDispositionRevokeKey(key);
                if (matchedOther.isPresent()) {
                    throw new InventoryConflictException("同一幂等键已用于其他复检处置撤销内容");
                }
            } else {
                for (var entry : kernel.receipts.entrySet()) {
                    for (QualityDisposition ev : kernel.qualityEvents(entry.getValue())) {
                        if (ev.hasRevocation() && key.equals(ev.revocation().idempotencyKey())) {
                            throw new InventoryConflictException("同一幂等键已用于其他复检处置撤销内容");
                        }
                    }
                }
            }
            return null;
        }, () -> {
            Map<String, Object> receipt = kernel.findOrLoadReceipt(cleanReportId);
            if (receipt == null) throw new IllegalArgumentException("报工记录不存在: " + cleanReportId);
            if (!"CONFIRMED".equals(receipt.get("status"))) {
                throw new InventoryConflictException("仅已确认报工的复检处置允许撤销");
            }
            List<QualityDisposition> events = new ArrayList<>(kernel.qualityEvents(receipt));
            int targetIdx = -1;
            for (int i = 0; i < events.size(); i++) {
                if (cleanDispositionId.equals(events.get(i).id())) {
                    targetIdx = i;
                    break;
                }
            }
            if (targetIdx < 0) throw new IllegalArgumentException("复检处置记录不存在: " + cleanDispositionId);
            QualityDisposition target = events.get(targetIdx);
            if (target.hasRevocation()) {
                throw new InventoryConflictException("该复检处置已撤销，不可重复撤销");
            }

            RemnantStock derived = null;
            if (target.remnantId() != null && !target.remnantId().isBlank()) {
                derived = kernel.findOrLoadRemnant(target.remnantId());
                if (derived == null) {
                    throw new InventoryConflictException("派生回收料头缺失，无法撤销原复检处置");
                }
                String expectedStatus = (target.command().recovery() != null && "QUARANTINED".equals(target.command().recovery().quality()))
                        ? "QUARANTINED" : "AVAILABLE";
                if (!expectedStatus.equals(derived.getStatus())) {
                    throw new InventoryConflictException("派生回收料头 " + derived.getId() + " 状态已变更为 " + derived.getStatus() + "，无法撤销原复检处置");
                }
                kernel.ensureMaterialNotReserved("remnant", derived.getId(), null);
                String derivedId = derived.getId();
                if (kernel.countRevision("remnant", derivedId) > 0) {
                    throw new InventoryConflictException("派生回收料头 " + derivedId + " 已有盘点单追溯，无法撤销原复检处置");
                }
                boolean hasTransfer = kernel.store.supportsHotColdLoading()
                        ? kernel.store.hasTransferForMaterial("remnant", derivedId)
                        : kernel.transfers.values().stream().flatMap(t -> t.lines().stream())
                        .anyMatch(l -> "remnant".equals(l.type()) && derivedId.equals(l.id()));
                if (hasTransfer) {
                    throw new InventoryConflictException("派生回收料头 " + derivedId + " 已发生移库变更，无法撤销原复检处置");
                }
                boolean hasRelease = kernel.store.supportsHotColdLoading()
                        ? kernel.store.hasQualityReleaseForRemnant(derivedId)
                        : kernel.qualityReleases.values().stream().anyMatch(q -> derivedId.equals(q.remnantId()));
                if (hasRelease) {
                    throw new InventoryConflictException("派生回收料头 " + derivedId + " 已完成质量放行或判废，无法撤销原复检处置");
                }
                String expectedLoc = target.command().recovery() != null ? Objects.toString(target.command().recovery().location(), "").trim() : "";
                if (!expectedLoc.isEmpty() && !expectedLoc.equals(Objects.toString(derived.getLocation(), "").trim())) {
                    throw new InventoryConflictException("派生回收料头 " + derivedId + " 库位已变更，无法撤销原复检处置");
                }
            }

            if ("QUALIFIED".equals(target.originalOutcome())) {
                validateTaskCapacityForDispositionRevoke(receipt, target);
            }

            QualityDisposition revoked = target.withRevocation(new QualityDisposition.Revocation(
                    key, operator, reason, LocalDateTime.now().toString()
            ));
            events.set(targetIdx, revoked);
            Map<String, Object> updatedReceipt = new LinkedHashMap<>(receipt);
            updatedReceipt.put("qualityDispositions", events);
            kernel.receipts.put(cleanReportId, updatedReceipt);
            if (derived != null) {
                derived.setStatus("REVOKED");
                derived.setDefectDesc((InventoryStateKernel.blankToNull(derived.getDefectDesc()) != null ? derived.getDefectDesc() + " | " : "")
                        + "复检撤销作废(" + operator + "): " + reason);
            }
            return buildRevokeDispositionPayload(updatedReceipt);
        });

        result.put("revision", kernel.revision);
        return result;
    }

    private void validateTaskCapacityForDispositionRevoke(Map<String, Object> receipt, QualityDisposition target) {
        CuttingExecutionProjectionHelper.validateTaskCapacityForDispositionRevoke(
                receipt, target, kernel::findOrLoadTask, kernel::completedQuantitiesInternal);
    }

    private Map<String, Object> buildRevokeDispositionPayload(Map<String, Object> receipt) {
        return CuttingExecutionProjectionHelper.buildRevokeDispositionPayload(
                kernel.qualityProjection(receipt), receipt.get("taskId"),
                kernel::findOrLoadTask, kernel::completedQuantitiesInternal);
    }

    List<Map<String, Object>> taskReports(String taskId) {
        return kernel.read(() -> kernel.taskReportsInternal(taskId));
    }

    Map<String, Integer> completedQuantities(String taskId) {
        return kernel.read(() -> kernel.completedQuantitiesInternal(taskId));
    }

    Map<String, Object> reconciliationReports(int limit, int offset, String statusFilter, String taskIdFilter) {
        if (limit < 1 || limit > 200 || offset < 0) {
            throw new IllegalArgumentException("分页参数无效：limit 需在 1–200 之间，offset 不得为负");
        }
        return kernel.read(() -> ColdStateQueryBridge.buildReconciliationReportsPage(
                kernel.json,
                kernel.store,
                kernel.receipts,
                kernel.schemes,
                id -> java.util.Optional.ofNullable(kernel.findOrLoadTask(id)),
                id -> java.util.Optional.ofNullable(kernel.findOrLoadPlan(id)),
                id -> java.util.Optional.ofNullable(kernel.findOrLoadRoll(id)),
                id -> java.util.Optional.ofNullable(kernel.findOrLoadRemnant(id)),
                limit, offset, statusFilter, taskIdFilter
        ));
    }
}
