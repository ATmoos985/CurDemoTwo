package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.ExecutionOrder;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.persistence.InventoryConflictException;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * 切割任务、候选材料与推荐快照垂直领域服务：
 * 仅依赖 InventoryStateKernel，负责任务 CRUD/摘要、备选材料匹配、推荐基线快照与材料指纹查询。
 */
final class CuttingTaskDomainService {

    private final InventoryStateKernel kernel;

    CuttingTaskDomainService(InventoryStateKernel kernel) {
        this.kernel = kernel;
    }

    record DetachedRecommendation(long revision, List<RemnantStock> stocks) {}

    List<Defect> materialDefects(SolveRequest request) {
        return kernel.read(() -> {
            boolean remnant = "remnant".equalsIgnoreCase(request.getFeedPortType());
            List<Defect> source = remnant
                    ? Optional.ofNullable(kernel.findOrLoadRemnant(request.getSourceRemnantId())).map(RemnantStock::getDefects).orElse(null)
                    : Optional.ofNullable(kernel.findOrLoadRoll(request.getRollId())).map(MotherRollInfo::getDefects).orElse(null);
            if (source == null) throw new IllegalArgumentException("所选材料已不可用，请重新选料");
            return kernel.json.readValue(kernel.json.writeValueAsBytes(source),
                    new tools.jackson.core.type.TypeReference<List<Defect>>() {});
        });
    }

    String materialFingerprint(SolveRequest request) {
        return kernel.read(() -> kernel.materialFingerprintInternal(request));
    }

    CuttingTask getTask(String id) {
        return kernel.read(() -> {
            CuttingTask task = kernel.findOrLoadTask(id);
            if (task == null) throw new IllegalArgumentException("切割任务不存在");
            return task;
        });
    }

    List<CuttingTask> listTasks() {
        return kernel.read(() -> kernel.store.supportsHotColdLoading()
                ? kernel.store.listAllTasks()
                : new ArrayList<>(kernel.tasks.values()));
    }

    List<Map<String, Object>> taskSummaries() {
        return kernel.read(() -> {
            List<CuttingTask> allTasks = kernel.store.supportsHotColdLoading()
                    ? kernel.store.listAllTasks()
                    : new ArrayList<>(kernel.tasks.values());
            return allTasks.stream().map(task -> {
                Map<String, Integer> completedMap = kernel.completedQuantitiesInternal(task.id());
                int total = task.demands().stream().mapToInt(CuttingTask.Line::quantity).sum();
                int completed = task.demands().stream().mapToInt(line -> completedMap.getOrDefault(String.valueOf(line.id()), 0)).sum();
                List<CuttingPlan> taskPlanList = kernel.store.supportsHotColdLoading()
                        ? kernel.store.listTaskPlans(task.id())
                        : kernel.plans.values().stream().filter(p -> Objects.equals(task.id(), p.request().getTaskId())).toList();
                long pending = taskPlanList.stream().filter(plan -> Objects.equals(task.id(), plan.request().getTaskId())
                        && task.revision() == plan.request().getTaskRevision() && "PENDING".equals(plan.status())).count();
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("task", task);
                item.put("total", total);
                item.put("completed", completed);
                item.put("remaining", Math.max(0, total - completed));
                item.put("pendingCount", pending);
                item.put("reportCount", kernel.taskReportsInternal(task.id()).stream().filter(r -> !"REVERSED".equals(r.get("status"))).count());
                long now = kernel.currentOperationTime();
                var taskExecutions = (kernel.store.supportsHotColdLoading()
                        ? kernel.store.listTaskExecutions(task.id())
                        : kernel.executions.values().stream().filter(e -> e.taskId().equals(task.id())).toList());
                var active = taskExecutions.stream().filter(e -> e.reserves(now)).toList();
                var reserved = kernel.reservedQuantities(task.id(), null);
                int reservedCount = reserved.values().stream().mapToInt(Integer::intValue).sum();
                int available = task.demands().stream().mapToInt(line -> Math.max(0, line.quantity()
                        - completedMap.getOrDefault(String.valueOf(line.id()), 0)
                        - reserved.getOrDefault(String.valueOf(line.id()), 0))).sum();
                long running = active.stream().filter(e -> "RUNNING".equals(e.state())).count();
                Map<String, CuttingPlan> planMap = new LinkedHashMap<>();
                taskPlanList.forEach(p -> planMap.put(p.id(), p));
                long expired = total == completed ? 0 : taskExecutions.stream().filter(e -> "EXPIRED".equals(e.effectiveState(now)))
                        .filter(e -> planMap.containsKey(e.planId()) && "PENDING".equals(planMap.get(e.planId()).status())
                                && planMap.get(e.planId()).request().getTaskRevision() == task.revision())
                        .filter(e -> taskExecutions.stream().noneMatch(a -> a.planId().equals(e.planId())
                                && !Set.of("EXPIRED", "CANCELLED").contains(a.effectiveState(now))))
                        .map(ExecutionOrder::planId).distinct().count();
                var activeSchemes = kernel.schemes.values().stream().filter(s -> s.occupiesDemand() && s.involvesTask(task.id())).toList();
                String status = running > 0 ? "REPORT_PENDING" : total == completed ? "COMPLETED" : expired > 0 ? "ATTENTION" :
                        !active.isEmpty() || pending > 0 || !activeSchemes.isEmpty() ? "EXECUTION_PENDING" : "PLAN_PENDING";
                item.put("status", status);
                item.put("reserved", reservedCount);
                item.put("availableToPlan", available);
                item.put("runningCount", running);
                item.put("releasedCount", active.size() - running);
                item.put("expiredCount", expired);
                var matReservations = new ArrayList<Map<String, Object>>();
                active.forEach(e -> matReservations.add(Map.of("executionId", e.id(), "materialId", e.materialId(),
                        "materialType", e.materialType(), "station", e.station(), "state", e.effectiveState(now))));
                for (var s : activeSchemes) {
                    if (s.isMaterialLockActive() && ("STOCK_ROLL".equals(s.materialMode()) || "REMNANT".equals(s.materialMode()))) {
                        boolean rem = "REMNANT".equals(s.materialMode());
                        matReservations.add(Map.of("schemeId", s.id(),
                                "materialId", Objects.toString(rem ? s.remnantId() : s.rollId(), ""),
                                "materialType", rem ? "remnant" : "roll", "state", s.state()));
                    }
                }
                item.put("materialReservations", matReservations);
                item.put("nextAction", switch (status) {
                    case "REPORT_PENDING", "ATTENTION" -> "executions";
                    case "COMPLETED" -> "reports";
                    case "EXECUTION_PENDING" -> active.isEmpty() ? "plans" : "executions";
                    default -> "workspace";
                });
                return item;
            }).toList();
        });
    }

    Map<String, Object> buildTaskDetail(String id, List<Map<String, Object>> executionViews) {
        CuttingTask task = kernel.findOrLoadTask(id);
        if (task == null) throw new IllegalArgumentException("切割任务不存在");
        return Map.of(
                "task", task,
                "completed", kernel.completedQuantitiesInternal(id),
                "reserved", kernel.reservedQuantities(id, null),
                "reports", kernel.taskReportsInternal(id),
                "executions", executionViews
        );
    }

    CuttingTask saveTask(CuttingTask input) {
        return kernel.mutate("DEMAND_ADJUSTMENT", input == null ? null : input.id(), "UNAUTHENTICATED_LOCAL",
                () -> saveTaskInternal(input, null));
    }

    CuttingTask saveTaskInternal(CuttingTask input, String exceptSchemeId) {
        if (input == null || input.name() == null || input.name().isBlank() || input.materialModel() == null ||
                input.materialModel().isBlank() || input.demands() == null || input.demands().isEmpty() || input.demands().size() > 200)
            throw new IllegalArgumentException("请填写任务名称、材料型号和 1 至 200 项需求");
        String id = input.id() == null || input.id().isBlank() ? UUID.randomUUID().toString() : input.id();
        CuttingTask previous = kernel.findOrLoadTask(id);
        if (previous == null && input.id() != null && !input.id().isBlank()) throw new IllegalArgumentException("切割任务不存在");
        if (previous != null && previous.revision() != input.revision()) throw new IllegalArgumentException("任务已更新，请重新打开后编辑");
        Set<Integer> ids = new HashSet<>();
        CuttingTask.Process process = input.process();
        if (process != null) SolveRequest.validatePieceGap(process.pieceGap());
        if (process != null && (!Double.isFinite(process.bedLength()) || process.bedLength() <= 0 ||
                !Double.isFinite(process.trimStart()) || process.trimStart() < 0 ||
                !Set.of("left-top", "right-top", "left-bottom", "right-bottom").contains(String.valueOf(process.cutOrigin())) ||
                !Set.of("horizontal", "vertical").contains(String.valueOf(process.firstStageOrientation()))))
            throw new IllegalArgumentException("机台工艺参数无效");
        String type = input.problemType() == null || CuttingTask.NESTING_2D.equals(input.problemType()) ? null : input.problemType();
        if (type != null && !CuttingTask.SLITTING_1D.equals(type)) throw new IllegalArgumentException("任务类型只支持二维排料或一维分切");
        if (previous != null && !Objects.equals(previous.problemType(), type) && !kernel.completedQuantitiesInternal(id).isEmpty())
            throw new IllegalArgumentException("已有报工的任务不能更改任务类型");
        CuttingTask.Slitting slitting = type == null ? null : input.slitting();
        if (type != null) {
            if (slitting == null) throw new IllegalArgumentException("一维分切任务须填写切边与组合宽度");
            slitting.validate();
            for (CuttingTask.Line line : input.demands())
                if (line != null && (line.shape() != null || line.allowRotation() || line.width() != Math.rint(line.width())
                        || line.length() != Math.rint(line.length()) || line.width() > slitting.maxWidth() || line.length() > 1_000_000_000))
                    throw new IllegalArgumentException("一维需求为整数 mm 的分切宽度 × 卷长，不能旋转或使用轮廓，宽度不超过组合上限");
        }
        for (CuttingTask.Line line : input.demands()) {
            if (line != null && line.shape() != null) {
                com.example.cutdemotwo.algorithm.geometry.PolygonGeometry.validate(line.shape());
                if (line.width() != line.shape().width() || line.length() != line.shape().height())
                    throw new IllegalArgumentException("需求尺寸必须与轮廓外接尺寸一致");
            }
            if (line == null || line.id() <= 0 || !ids.add(line.id()) || line.name() == null || line.name().isBlank() ||
                    !Double.isFinite(line.width()) || !Double.isFinite(line.length()) || line.width() <= 0 || line.length() <= 0 ||
                    line.quantity() <= 0 || line.quantity() > 10000)
                throw new IllegalArgumentException("需求编号应唯一，尺寸和件数必须为正数，单项最多 10000 件");
        }
        String normalizedPriority = InventoryStateKernel.normalizePriority(input.priority());
        String normalizedDueDate = InventoryStateKernel.blankToNull(input.dueDate());
        String normalizedCustomer = InventoryStateKernel.blankToNull(input.customerName());
        String normalizedKitting = InventoryStateKernel.blankToNull(input.kittingGroup());
        String normalizedReqBatch = InventoryStateKernel.blankToNull(input.requiredBatchNo());
        String normalizedReqColor = InventoryStateKernel.blankToNull(input.requiredColor());
        Boolean normalizedStrictBatch = input.strictBatchMatch();
        String normalizedMachine = InventoryStateKernel.blankToNull(input.machineId());
        String normalizedShift = InventoryStateKernel.blankToNull(input.shiftTeam());
        String normalizedSourceScheme = InventoryStateKernel.blankToNull(input.sourceSchemeId());
        String normalizedReplenishKey = InventoryStateKernel.blankToNull(input.replenishIdempotencyKey());
        if (previous != null) {
            Map<String, Integer> completed = kernel.completedQuantitiesInternal(id);
            if (!completed.isEmpty() && !previous.materialModel().equals(input.materialModel()))
                throw new IllegalArgumentException("已有报工的任务不能更改材料型号");
            for (CuttingTask.Line old : previous.demands()) {
                int count = completed.getOrDefault(String.valueOf(old.id()), 0);
                if (count == 0) continue;
                CuttingTask.Line line = input.demands().stream().filter(d -> d.id() == old.id()).findFirst()
                        .orElseThrow(() -> new IllegalArgumentException("已报工需求不能删除"));
                if (!Objects.equals(line.shape(), old.shape()) || line.width() != old.width() || line.length() != old.length()
                        || !line.name().equals(old.name()) || line.quantity() < count)
                    throw new IllegalArgumentException("已报工需求的名称和尺寸不能修改，总件数不得小于已报工件数");
            }
            if (Objects.equals(previous.name(), input.name()) && Objects.equals(previous.materialModel(), input.materialModel()) &&
                    Objects.equals(previous.externalRef(), input.externalRef()) && Objects.equals(previous.process(), process) &&
                    Objects.equals(previous.problemType(), type) && Objects.equals(previous.slitting(), slitting) &&
                    Objects.equals(previous.dueDate(), normalizedDueDate) && Objects.equals(previous.priority(), normalizedPriority) &&
                    Objects.equals(previous.customerName(), normalizedCustomer) && Objects.equals(previous.kittingGroup(), normalizedKitting) &&
                    Objects.equals(previous.requiredBatchNo(), normalizedReqBatch) && Objects.equals(previous.requiredColor(), normalizedReqColor) &&
                    Objects.equals(previous.strictBatchMatch(), normalizedStrictBatch) && Objects.equals(previous.machineId(), normalizedMachine) &&
                    Objects.equals(previous.shiftTeam(), normalizedShift) && Objects.equals(previous.sourceSchemeId(), normalizedSourceScheme) &&
                    Objects.equals(previous.replenishIdempotencyKey(), normalizedReplenishKey) &&
                    previous.demands().equals(input.demands())) return previous;
        }
        if (previous != null && kernel.executions.values().stream().anyMatch(e -> e.taskId().equals(id) && e.reserves(kernel.currentOperationTime())))
            throw new InventoryConflictException("任务已有下达或执行中的需求，请完成报工或取消预约后编辑");
        if (previous != null && kernel.schemes.values().stream().anyMatch(s -> !Objects.equals(exceptSchemeId, s.id())
                && s.occupiesDemand() && s.involvesTask(id)))
            throw new InventoryConflictException("任务已有活跃排程方案占用，请先完工或作废对应方案后再编辑");
        CuttingTask task = new CuttingTask(id, input.name().trim(), input.materialModel().trim(), input.externalRef(),
                previous == null ? 1 : previous.revision() + 1, List.copyOf(input.demands()), process, type, slitting,
                normalizedDueDate, normalizedPriority, normalizedCustomer, normalizedKitting,
                normalizedReqBatch, normalizedReqColor, normalizedStrictBatch, normalizedMachine, normalizedShift,
                normalizedSourceScheme, normalizedReplenishKey);
        kernel.tasks.put(id, task);
        return task;
    }

    void prepareTaskSolve(SolveRequest request) {
        kernel.read(() -> {
            kernel.prepareTaskSolveInternal(request);
            return null;
        });
    }

    List<Map<String, Object>> materialCandidates(SolveRequest request) {
        return kernel.read(() -> materialCandidatesInternal(request));
    }

    private List<Map<String, Object>> materialCandidatesInternal(SolveRequest request) {
        if (request == null || request.getRollModel() == null || request.getDemands() == null)
            throw new IllegalArgumentException("请先填写材料型号和需求");
        CuttingTask task = request.getTaskId() != null ? kernel.findOrLoadTask(request.getTaskId()) : null;
        List<Map<String, Object>> result = new ArrayList<>();
        for (RemnantStock stock : kernel.getAvailableRemnantsInternal()) {
            if (!request.getRollModel().equals(stock.getMaterialBatch())) continue;
            if (task != null && !kernel.matchesBatchAndColor(task, kernel.findOrLoadRoll(stock.getSourceRollId()), stock)) continue;
            addCandidate(result, request, "remnant", stock.getId(), stock.getSourceRollId(),
                    stock.getWidth(), stock.getLength(), stock.getLocation(), stock.isHasDefect());
        }
        result.sort(Comparator.comparingDouble(c -> ((Number) c.get("width")).doubleValue() * ((Number) c.get("length")).doubleValue()));
        for (MotherRollInfo roll : kernel.motherRolls.values()) {
            if (!request.getRollModel().equals(roll.getRollModel()) || roll.getCurrentRemainingLength() <= 0
                    || "SCRAPPED".equalsIgnoreCase(roll.getInspectionStatus())) continue;
            if (task != null && !kernel.matchesBatchAndColor(task, roll, null)) continue;
            addCandidate(result, request, "roll", roll.getRollId(), roll.getRollId(),
                    roll.getWidth(), roll.getCurrentRemainingLength(), roll.getStorageLocation(), !roll.getDefects().isEmpty());
        }
        return result;
    }

    DetachedRecommendation recommendationSnapshot(SolveRequest request, Map<String, Integer> completedBaseline) {
        return kernel.read(() -> {
            if (request.getTaskId() != null) {
                var task = kernel.findOrLoadTask(request.getTaskId());
                if (task == null || task.revision() != request.getTaskRevision()
                        || !kernel.completedQuantitiesInternal(task.id()).equals(completedBaseline))
                    throw new InventoryConflictException("任务版本或已报工数量已变化，请重新打开任务后匹配料头");
            }
            var stocks = materialCandidatesInternal(request).stream().filter(c -> "remnant".equals(c.get("type")))
                    .map(c -> kernel.remnantPool.get(c.get("id")))
                    .sorted(Comparator.comparingDouble(RemnantStock::getArea).thenComparing(RemnantStock::getId))
                    .map(RemnantStock::deepCopy).toList();
            return new DetachedRecommendation(kernel.revision, stocks);
        });
    }

    void verifyRecommendationRevision(long expected) {
        kernel.read(() -> {
            if (kernel.revision != expected) throw new InventoryConflictException("试排期间库存或任务已变化，请刷新库存后重新计算推荐");
            return null;
        });
    }

    private void addCandidate(List<Map<String, Object>> result, SolveRequest request, String type, String id, String rollId,
                              double width, double length, String location, boolean defects) {
        long fit = request.getDemands().stream().filter(d -> d != null && d.getDemand() > 0 && d.getWidth() > 0 && d.getLength() > 0 &&
                ((d.getWidth() <= width && d.getLength() <= length && (ContourWorkflow.isContour(request) || request.isAllowLongitudinal() || Math.abs(d.getWidth() - width) < .001)) ||
                        ((request.isAllowRotation() || d.isAllowRotation()) && d.getLength() <= width && d.getWidth() <= length &&
                                (ContourWorkflow.isContour(request) || request.isAllowLongitudinal() || Math.abs(d.getLength() - width) < .001)))).count();
        if (fit == 0) return;
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("type", type);
        row.put("id", id);
        row.put("rollId", rollId);
        row.put("width", width);
        row.put("length", length);
        row.put("location", location);
        row.put("hasDefect", defects);
        row.put("fittingLines", fit);
        result.add(row);
    }
}
