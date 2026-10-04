package com.example.cutdemotwo.service;

import com.example.cutdemotwo.model.Defect;
import com.example.cutdemotwo.model.CuttingTask;
import com.example.cutdemotwo.model.MotherRollInfo;
import com.example.cutdemotwo.model.RemnantStock;
import com.example.cutdemotwo.model.SolveRequest;
import com.example.cutdemotwo.model.SolveResponse;
import com.example.cutdemotwo.model.CutReport;
import com.example.cutdemotwo.model.RemnantPiece;
import com.example.cutdemotwo.model.CuttingPlan;
import com.example.cutdemotwo.persistence.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;

/**
 * 工业母卷与料头全生命周期档案服务 (Master Roll & Remnant Inventory Service)
 * 维护母卷物理规格、多道工序验布疵点、现场料头库存货架与代际派生血统
 */
@Service
public class RemnantService {

    private final Map<String, RemnantStock> remnantPool = new ConcurrentHashMap<>();
    private final Map<String, MotherRollInfo> motherRolls = new LinkedHashMap<>();
    private final AtomicInteger remnantSeq = new AtomicInteger(10);
    private final AtomicInteger defectSeq = new AtomicInteger(20);
    private final Map<String, Map<String, Object>> receipts = new LinkedHashMap<>();
    private final Map<String, CuttingTask> tasks = new LinkedHashMap<>();
    private final ObjectMapper json = new ObjectMapper();
    private final InventoryStore store;
    private final Map<String, CuttingPlan> plans = new LinkedHashMap<>();
    private long revision;
    private boolean accessing;
    @Value("${cutdemo.measurement.tolerance-mm:5}")
    private double measurementToleranceMm = 5;

    public RemnantService(String statePath) { this(new FileInventoryStore(statePath), true); }

    @org.springframework.beans.factory.annotation.Autowired
    public RemnantService(InventoryStore store, @Value("${cutdemo.seed-demo-data:}") String seedDemo) {
        this(store, seedDemo.isBlank() ? !store.shared() : Boolean.parseBoolean(seedDemo));
    }

    public RemnantService(InventoryStore store, boolean seedDemo) {
        this.store = store;
        InventorySnapshot loaded = store.load();
        if (loaded != null) restore(loaded);
        else if (seedDemo) { initMotherRolls(); initSampleRemnants(); }
    }

    public synchronized Map<String, Integer> initializeDemoInventory() {
        return mutate(() -> {
            if (!motherRolls.isEmpty() || !remnantPool.isEmpty() || !tasks.isEmpty() || !plans.isEmpty() || !receipts.isEmpty()) {
                throw new IllegalArgumentException("当前库已有业务数据，不能创建整套示例材料；请使用已有库存或单独准备演示库");
            }
            initMotherRolls();
            initSampleRemnants();
            motherRolls.values().forEach(roll -> roll.setStorageLocation("示例材料（非实物）"));
            remnantPool.values().forEach(remnant -> remnant.setLocation("示例料头（非实物）"));
            return Map.of("rolls", motherRolls.size(), "remnants", remnantPool.size());
        });
    }

    private InventorySnapshot snapshot() {
        return new InventorySnapshot(new ArrayList<>(motherRolls.values()), new ArrayList<>(remnantPool.values()),
                receipts, remnantSeq.get(), defectSeq.get(), tasks, plans, revision);
    }

    private void restore(InventorySnapshot snapshot) {
        motherRolls.clear(); snapshot.rolls().forEach(r -> motherRolls.put(r.getRollId(), r));
        remnantPool.clear(); snapshot.remnants().forEach(r -> remnantPool.put(r.getId(), r));
        receipts.clear(); receipts.putAll(snapshot.receipts());
        tasks.clear(); if (snapshot.tasks() != null) tasks.putAll(snapshot.tasks());
        plans.clear(); if (snapshot.plans() != null) plans.putAll(snapshot.plans());
        revision = snapshot.revision();
        remnantSeq.set(snapshot.remnantSeq()); defectSeq.set(snapshot.defectSeq());
    }

    /** One business command either persists every change or restores its entire before-image. */
    private <T> T mutate(java.util.function.Supplier<T> command) {
        refresh();
        byte[] before = json.writeValueAsBytes(snapshot());
        restore(json.readValue(before, InventorySnapshot.class));
        accessing = true;
        try {
            T result = command.get();
            save();
            return result;
        } catch (RuntimeException error) {
            restore(json.readValue(before, InventorySnapshot.class));
            throw error;
        } finally { accessing = false; }
    }

    private void refresh() {
        if (!accessing && store.shared()) {
            InventorySnapshot latest = store.load();
            if (latest != null && latest.revision() != revision) restore(latest);
        }
    }

    private <T> T read(java.util.function.Supplier<T> query) {
        if (accessing) return query.get();
        refresh(); accessing = true;
        try { return query.get(); } finally { accessing = false; }
    }

    public synchronized String materialFingerprint(SolveRequest request) {
        return read(() -> materialFingerprintInternal(request));
    }

    private String materialFingerprintInternal(SolveRequest request) {
        if ("remnant".equalsIgnoreCase(request.getFeedPortType())) {
            RemnantStock item = remnantPool.get(request.getSourceRemnantId());
            if (item == null) throw new IllegalArgumentException("料头不存在，请重新选料");
            return json.writeValueAsString(Arrays.asList(item.getId(), item.getWidth(), item.getLength(),
                    item.getMaterialBatch(), item.getSourceRollId(), item.isHasDefect(), item.getDefects()));
        }
        MotherRollInfo roll = motherRolls.get(request.getRollId());
        if (roll == null) throw new IllegalArgumentException("母卷不存在，请重新选料");
        return json.writeValueAsString(Arrays.asList(roll.getRollId(), roll.getWidth(), roll.getTotalLength(),
                roll.getRollModel(), roll.getBatchNo(), roll.getColor(), roll.getInspectionStatus(), roll.getDefects()));
    }

    private void save() {
        revision = store.save(snapshot());
    }

    public synchronized void rememberPlan(CuttingPlan plan) {
        mutate(() -> {
            if (!Objects.equals(plan.baseline(), materialFingerprintInternal(plan.request())))
                throw new IllegalArgumentException("求解期间材料或疵点已更新，请重新排料");
            plans.put(plan.id(), json.readValue(json.writeValueAsBytes(plan), CuttingPlan.class));
            return null;
        });
    }

    public synchronized CuttingPlan getPlan(String id) {
        return read(() -> {
            CuttingPlan plan = plans.get(id);
            if (plan == null) throw new IllegalArgumentException("方案不存在");
            return plan;
        });
    }

    public synchronized CuttingPlan rememberAdjustment(String parentId, String id, SolveResponse result) {
        return mutate(() -> {
            CuttingPlan existing = plans.get(id);
            if (existing != null) {
                if (!Objects.equals(existing.parentPlanId(), parentId) || !json.writeValueAsString(existing.result()).equals(json.writeValueAsString(result)))
                    throw new IllegalArgumentException("调整操作编号已用于其他内容，请重新校验");
                return existing;
            }
            CuttingPlan parent = plans.get(parentId);
            if (parent == null || !"PENDING".equals(parent.status())) throw new IllegalArgumentException("原方案已报工或取消，不能保存调整版");
            prepareTaskSolveInternal(parent.request());
            if (!Objects.equals(parent.baseline(), materialFingerprintInternal(parent.request())))
                throw new IllegalArgumentException("材料或疵点已变化，请重新装载并排料");
            CuttingPlan adjusted = new CuttingPlan(id, parent.request(), result, parent.baseline(), "PENDING",
                    java.time.LocalDateTime.now().toString(), parentId, parent.version()+1);
            adjusted = json.readValue(json.writeValueAsBytes(adjusted), CuttingPlan.class);
            plans.put(parentId, parent.withStatus("CANCELLED"));
            plans.put(id, adjusted);
            return adjusted;
        });
    }

    public synchronized List<CuttingPlan> taskPlans(String taskId) {
        return read(() -> plans.values().stream().filter(p -> Objects.equals(taskId, p.request().getTaskId())).toList());
    }

    public synchronized CuttingPlan changePlanStatus(String id, boolean restore) {
        return mutate(() -> {
            CuttingPlan plan = plans.get(id);
            if (plan == null || !Set.of("PENDING", "CANCELLED").contains(plan.status()))
                throw new IllegalArgumentException("已报工方案不能取消或恢复，请通过报工记录冲销");
            if (restore) {
                prepareTaskSolveInternal(plan.request());
                if (!Objects.equals(plan.baseline(), materialFingerprintInternal(plan.request())))
                    throw new IllegalArgumentException("材料或疵点已更新，请重新排料");
            }
            CuttingPlan updated = plan.withStatus(restore ? "PENDING" : "CANCELLED");
            plans.put(id, updated); return updated;
        });
    }

    public synchronized Map<String, Object> confirmPlan(CutReport report) {
        if (report == null || report.planId() == null) throw new IllegalArgumentException("请先取得方案编号");
        Map<String, Object> existing = read(() -> receipts.get(report.planId()));
        if (existing != null) {
            if ("REVERSED".equals(existing.get("status"))) throw new IllegalArgumentException("该报工已冲销，请重新排料");
            return existing;
        }
        return mutate(() -> {
            Map<String, Object> receipt = receipts.get(report.planId());
            if (receipt != null) {
                if ("REVERSED".equals(receipt.get("status"))) throw new IllegalArgumentException("该报工已冲销，请重新排料");
                return receipt;
            }
            CuttingPlan plan = plans.get(report.planId());
            if (plan == null || !"PENDING".equals(plan.status())) throw new IllegalArgumentException("方案不存在或已取消，请重新排料");
            if (!Objects.equals(plan.baseline(), materialFingerprintInternal(plan.request())))
                throw new IllegalArgumentException("材料或疵点已更新，请重新装载并排料");
            Map<String, Object> result = confirmInternal(plan.request(), plan.result(), report);
            plans.put(plan.id(), plan.withStatus("CONFIRMED"));
            return result;
        });
    }

    public synchronized Map<String, Object> getReceipt(String planId) { return read(() -> receipts.get(planId)); }

    public synchronized Map<String, Object> reverseReport(String planId, String reason) {
        if (reason == null || reason.isBlank() || reason.length() > 500)
            throw new IllegalArgumentException("请填写 1 至 500 字的撤回原因");
        return mutate(() -> {
            Map<String, Object> receipt = receipts.get(planId);
            if (receipt == null) throw new IllegalArgumentException("报工记录不存在");
            if ("REVERSED".equals(receipt.get("status"))) return receipt;
            if (!(receipt.get("undo") instanceof Map<?, ?> undo))
                throw new IllegalArgumentException("历史报工没有撤回快照，请人工核对库存后处理");
            List<RemnantStock> children = new ArrayList<>();
            for (Object item : (List<?>) receipt.get("derivedRemnants")) {
                RemnantStock original = json.convertValue(item, RemnantStock.class);
                RemnantStock current = remnantPool.get(original.getId());
                if (current == null || !json.writeValueAsString(original).equals(json.writeValueAsString(current)))
                    throw new IllegalArgumentException("派生料头 " + original.getId() + " 已流转或修改，请先撤回后续操作");
                children.add(current);
            }
            boolean remnant = "remnant".equals(receipt.get("feedPortType"));
            if (remnant) {
                RemnantStock parent = remnantPool.get(receipt.get("sourceRemnantId"));
                if (parent == null || !json.writeValueAsString(parent).equals(undo.get("parentAfter")))
                    throw new IllegalArgumentException("原料头状态已变化，不能撤回此报工");
                RemnantStock original = json.readValue(undo.get("parentBefore").toString(), RemnantStock.class);
                remnantPool.put(original.getId(), original);
            } else {
                // Unwind the latest operation on this roll; independent rolls remain unaffected.
                Map<String, Object> latest = null;
                for (var candidate : receipts.values())
                    if (!"REVERSED".equals(candidate.get("status")) && "roll".equals(candidate.get("feedPortType"))
                            && Objects.equals(receipt.get("rollId"), candidate.get("rollId"))) latest = candidate;
                MotherRollInfo roll = motherRolls.get(receipt.get("rollId"));
                if (latest != receipt || roll == null ||
                        Math.abs(roll.getUsedLength() - ((Number) undo.get("usedAfter")).doubleValue()) > .001 ||
                        Math.abs(roll.getCurrentRemainingLength() - ((Number) undo.get("remainingAfter")).doubleValue()) > .001)
                    throw new IllegalArgumentException("母卷已有后续报工或库存变更，请从最近一次报工开始撤回");
                roll.setUsedLength(((Number) undo.get("usedBefore")).doubleValue());
                roll.setCurrentRemainingLength(((Number) undo.get("remainingBefore")).doubleValue());
            }
            children.forEach(child -> child.setStatus("REVERSED"));
            receipt.put("status", "REVERSED");
            receipt.put("reversedAt", LocalDateTime.now().toString());
            receipt.put("reversalReason", reason.trim());
            CuttingPlan plan = plans.get(planId);
            if (plan != null) plans.put(planId, plan.withStatus("REVERSED"));
            return receipt;
        });
    }

    public synchronized List<Map<String, Object>> taskReports(String taskId) {
        return read(() -> taskReportsInternal(taskId));
    }

    private List<Map<String, Object>> taskReportsInternal(String taskId) {
        return receipts.values().stream().filter(r -> Objects.equals(taskId, r.get("taskId"))).toList();
    }

    public synchronized Map<String, Integer> completedQuantities(String taskId) {
        return read(() -> completedQuantitiesInternal(taskId));
    }

    private Map<String, Integer> completedQuantitiesInternal(String taskId) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (Map<String, Object> receipt : taskReports(taskId)) {
            if ("REVERSED".equals(receipt.get("status"))) continue;
            if (receipt.get("demandQuantities") instanceof Map<?, ?> output)
                output.forEach((id, n) -> counts.merge(id.toString(), ((Number) n).intValue(), Integer::sum));
        }
        return counts;
    }

    public synchronized List<CuttingTask> listTasks() { return read(() -> new ArrayList<>(tasks.values())); }

    /** Summaries and print snapshots are read from one inventory revision. */
    public synchronized List<Map<String, Object>> taskSummaries() {
        return read(() -> tasks.values().stream().map(task -> {
            Map<String, Integer> counts = completedQuantities(task.id());
            int total = task.demands().stream().mapToInt(CuttingTask.Line::quantity).sum();
            int completed = task.demands().stream().mapToInt(line -> counts.getOrDefault(String.valueOf(line.id()), 0)).sum();
            long pending = plans.values().stream().filter(plan -> Objects.equals(task.id(), plan.request().getTaskId())
                    && task.revision() == plan.request().getTaskRevision() && "PENDING".equals(plan.status())).count();
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("task", task); item.put("total", total); item.put("completed", completed);
            item.put("remaining", Math.max(0, total - completed)); item.put("pendingCount", pending);
            item.put("reportCount", taskReports(task.id()).stream().filter(r -> !"REVERSED".equals(r.get("status"))).count());
            return item;
        }).toList());
    }

    public synchronized Map<String, Object> planDetail(String id) {
        return read(() -> {
            CuttingPlan plan = getPlan(id);
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("id", plan.id()); detail.put("unit", "mm"); detail.put("coordinateSystem", "source-local-top-left");
            detail.put("request", plan.request()); detail.put("result", plan.result()); detail.put("status", plan.status());
            detail.put("createdAt", plan.createdAt()); detail.put("version", plan.version()); detail.put("parentPlanId", plan.parentPlanId());
            detail.put("receipt", receipts.get(id));
            return detail;
        });
    }

    public synchronized Map<String, Object> taskDetail(String id) {
        return read(() -> taskDetailInternal(id));
    }

    private Map<String, Object> taskDetailInternal(String id) {
        CuttingTask task = tasks.get(id);
        if (task == null) throw new IllegalArgumentException("切割任务不存在");
        return Map.of("task", task, "completed", completedQuantities(id), "reports", taskReports(id));
    }

    public synchronized CuttingTask saveTask(CuttingTask input) {
        return mutate(() -> saveTaskInternal(input));
    }

    private CuttingTask saveTaskInternal(CuttingTask input) {
        if (input == null || input.name() == null || input.name().isBlank() || input.materialModel() == null ||
                input.materialModel().isBlank() || input.demands() == null || input.demands().isEmpty() || input.demands().size() > 200)
            throw new IllegalArgumentException("请填写任务名称、材料型号和 1 至 200 项需求");
        String id = input.id() == null || input.id().isBlank() ? UUID.randomUUID().toString() : input.id();
        CuttingTask previous = tasks.get(id);
        if (previous == null && input.id() != null && !input.id().isBlank()) throw new IllegalArgumentException("切割任务不存在");
        if (previous != null && previous.revision() != input.revision()) throw new IllegalArgumentException("任务已更新，请重新打开后编辑");
        Set<Integer> ids = new HashSet<>();
        CuttingTask.Process process = input.process();
        if (process != null && (!Double.isFinite(process.bedLength()) || process.bedLength() <= 0 ||
                !Double.isFinite(process.trimStart()) || process.trimStart() < 0 ||
                !Set.of("left-top", "right-top", "left-bottom", "right-bottom").contains(String.valueOf(process.cutOrigin())) ||
                !Set.of("horizontal", "vertical").contains(String.valueOf(process.firstStageOrientation()))))
            throw new IllegalArgumentException("机台工艺参数无效");
        for (CuttingTask.Line line : input.demands()) {
            if (line == null || line.id() <= 0 || !ids.add(line.id()) || line.name() == null || line.name().isBlank() ||
                    !Double.isFinite(line.width()) || !Double.isFinite(line.length()) || line.width() <= 0 || line.length() <= 0 ||
                    line.quantity() <= 0 || line.quantity() > 10000)
                throw new IllegalArgumentException("需求编号应唯一，尺寸和件数必须为正数，单项最多 10000 件");
        }
        if (previous != null) {
            Map<String, Integer> completed = completedQuantities(id);
            if (!completed.isEmpty() && !previous.materialModel().equals(input.materialModel()))
                throw new IllegalArgumentException("已有报工的任务不能更改材料型号");
            for (CuttingTask.Line old : previous.demands()) {
                int count = completed.getOrDefault(String.valueOf(old.id()), 0);
                if (count == 0) continue;
                CuttingTask.Line line = input.demands().stream().filter(d -> d.id() == old.id()).findFirst()
                        .orElseThrow(() -> new IllegalArgumentException("已报工需求不能删除"));
                if (line.width() != old.width() || line.length() != old.length() || !line.name().equals(old.name()) || line.quantity() < count)
                    throw new IllegalArgumentException("已报工需求的名称和尺寸不能修改，总件数不得小于已报工件数");
            }
            if (Objects.equals(previous.name(), input.name()) && Objects.equals(previous.materialModel(), input.materialModel()) &&
                    Objects.equals(previous.externalRef(), input.externalRef()) && Objects.equals(previous.process(), process) &&
                    previous.demands().equals(input.demands())) return previous;
        }
        CuttingTask task = new CuttingTask(id, input.name().trim(), input.materialModel().trim(), input.externalRef(),
                previous == null ? 1 : previous.revision() + 1, List.copyOf(input.demands()), process);
        tasks.put(id, task);
        return task;
    }

    public synchronized void prepareTaskSolve(SolveRequest request) {
        read(() -> { prepareTaskSolveInternal(request); return null; });
    }

    private void prepareTaskSolveInternal(SolveRequest request) {
        if (request == null) throw new IllegalArgumentException("排料请求不能为空");
        if (request.getTaskId() == null) return; // Existing standalone solver API remains usable.
        CuttingTask task = tasks.get(request.getTaskId());
        if (task == null || task.revision() != request.getTaskRevision()) throw new IllegalArgumentException("任务已更新，请重新载入需求");
        boolean remnant = "remnant".equals(request.getFeedPortType());
        if (!remnant && !"roll".equals(request.getFeedPortType())) throw new IllegalArgumentException("无效的材料来源");
        MotherRollInfo roll = motherRolls.get(request.getRollId());
        RemnantStock stock = remnant ? remnantPool.get(request.getSourceRemnantId()) : null;
        if (remnant ? stock == null || !"AVAILABLE".equals(stock.getStatus()) : roll == null)
            throw new IllegalArgumentException("所选材料已不可用，请重新选料");
        String model = remnant ? stock.getMaterialBatch() : roll.getRollModel();
        if (!task.materialModel().equals(model)) throw new IllegalArgumentException("材料型号与任务需求不一致");
        double width = remnant ? stock.getWidth() : roll.getWidth();
        if (!Double.isFinite(request.getRollW()) || Math.abs(request.getRollW() - width) > .001 ||
                !Double.isFinite(request.getRollL()) || request.getRollL() <= 0 ||
                (remnant ? Math.abs(request.getRollL() - stock.getLength()) > .001 : request.getRollL() > roll.getCurrentRemainingLength()))
            throw new IllegalArgumentException("加工尺寸与所选材料库存不一致");
        double start = request.getWindowStartY();
        if (!Double.isFinite(start) || (remnant ? start != 0 : start < roll.getUsedLength() || start + request.getRollL() > roll.getTotalLength()))
            throw new IllegalArgumentException("工位超出母料可用范围，请重新装载");
        if (remnant && !Objects.equals(stock.getSourceRollId(), request.getRollId())) throw new IllegalArgumentException("料头来源母卷不一致");
        request.setRollModel(model);
        if (request.getDemands() == null || request.getDemands().isEmpty()) throw new IllegalArgumentException("没有待切需求");
        Map<String, Integer> counts = completedQuantities(task.id());
        Set<Integer> seen = new HashSet<>();
        for (var demand : request.getDemands()) {
            if (demand == null || !seen.add(demand.getId())) throw new IllegalArgumentException("排料需求编号重复或为空");
            CuttingTask.Line line = task.demands().stream().filter(d -> d.id() == demand.getId()).findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("需求不属于当前任务"));
            if (demand.getWidth() != line.width() || demand.getLength() != line.length() ||
                    demand.getDemand() <= 0 || demand.getDemand() > line.quantity() - counts.getOrDefault(String.valueOf(line.id()), 0))
                throw new IllegalArgumentException("需求尺寸或剩余数量已变化，请刷新任务后重新排料");
            demand.setName(line.name());
            demand.setAllowRotation(line.allowRotation());
        }
    }

    private void validateTaskReport(SolveRequest request, SolveResponse plan, ReportOutput result) {
        if (request.getTaskId() == null) return;
        CuttingTask task = tasks.get(request.getTaskId());
        if (task == null || task.revision() != request.getTaskRevision()) throw new IllegalArgumentException("任务已更新，请重新载入需求");
        boolean remnant = "remnant".equals(request.getFeedPortType());
        var roll = motherRolls.get(request.getRollId()); var stock = remnantPool.get(request.getSourceRemnantId() == null ? "" : request.getSourceRemnantId());
        String model = remnant ? (stock == null ? null : stock.getMaterialBatch()) : (roll == null ? null : roll.getRollModel());
        if (!Objects.equals(task.materialModel(), model)) throw new IllegalArgumentException("材料型号与任务需求不一致");
        if (remnant && !Objects.equals(stock.getSourceRollId(), request.getRollId())) throw new IllegalArgumentException("料头来源母卷不一致");
        if (plan.getPieces().stream().anyMatch(p -> p.getDemandId() == null)) throw new IllegalArgumentException("裁片缺少需求归属");
        Map<Integer, Long> good = result.qualified().stream().collect(Collectors.groupingBy(p -> p.getDemandId(), Collectors.counting()));
        Map<String, Integer> completed = completedQuantities(task.id());
        for (var piece : plan.getPieces()) {
            var line = task.demands().stream().filter(d -> d.id() == piece.getDemandId()).findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("裁片缺少需求归属"));
            double w = piece.isRotated() ? line.length() : line.width(), l = piece.isRotated() ? line.width() : line.length();
            if (Math.abs(piece.getW()-w) > .001 || Math.abs(piece.getL()-l) > .001)
                throw new IllegalArgumentException("裁片尺寸与当前需求不一致");
            if (good.getOrDefault(line.id(), 0L) > line.quantity() - completed.getOrDefault(String.valueOf(line.id()), 0))
                throw new IllegalArgumentException("合格裁片超过当前剩余需求，请刷新任务后核对");
        }
    }

    public synchronized List<Map<String, Object>> materialCandidates(SolveRequest request) {
        return read(() -> materialCandidatesInternal(request));
    }

    private List<Map<String, Object>> materialCandidatesInternal(SolveRequest request) {
        if (request == null || request.getRollModel() == null || request.getDemands() == null)
            throw new IllegalArgumentException("请先填写材料型号和需求");
        List<Map<String, Object>> result = new ArrayList<>();
        for (RemnantStock stock : getAvailableRemnants()) {
            if (!request.getRollModel().equals(stock.getMaterialBatch())) continue;
            addCandidate(result, request, "remnant", stock.getId(), stock.getSourceRollId(), stock.getWidth(), stock.getLength(), stock.getLocation(), stock.isHasDefect());
        }
        result.sort(Comparator.comparingDouble(c -> ((Number)c.get("width")).doubleValue() * ((Number)c.get("length")).doubleValue()));
        for (MotherRollInfo roll : motherRolls.values()) {
            if (!request.getRollModel().equals(roll.getRollModel()) || roll.getCurrentRemainingLength() <= 0) continue;
            addCandidate(result, request, "roll", roll.getRollId(), roll.getRollId(), roll.getWidth(), roll.getCurrentRemainingLength(), roll.getStorageLocation(), !roll.getDefects().isEmpty());
        }
        return result;
    }

    /** Detached read snapshot: trial nesting never holds the inventory lock or persists a plan. */
    public record RecommendationSnapshot(long revision, List<RemnantStock> stocks) {}

    public synchronized RecommendationSnapshot recommendationSnapshot(SolveRequest request, Map<String, Integer> completedBaseline) {
        return read(() -> {
            if (request.getTaskId() != null) {
                var task = tasks.get(request.getTaskId());
                if (task == null || task.revision() != request.getTaskRevision()
                        || !completedQuantities(task.id()).equals(completedBaseline))
                    throw new InventoryConflictException("任务版本或已报工数量已变化，请重新打开任务后匹配料头");
            }
            var stocks = materialCandidatesInternal(request).stream().filter(c -> "remnant".equals(c.get("type")))
                    .map(c -> remnantPool.get(c.get("id")))
                    .sorted(Comparator.comparingDouble(RemnantStock::getArea).thenComparing(RemnantStock::getId))
                    .map(stock -> json.readValue(json.writeValueAsBytes(stock), RemnantStock.class)).toList();
            return new RecommendationSnapshot(revision, stocks);
        });
    }

    public synchronized void verifyRecommendationRevision(long expected) {
        read(() -> {
            if (revision != expected) throw new InventoryConflictException("试排期间库存或任务已变化，请刷新库存后重新计算推荐");
            return null;
        });
    }

    private void addCandidate(List<Map<String, Object>> result, SolveRequest request, String type, String id, String rollId,
                              double width, double length, String location, boolean defects) {
        long fit = request.getDemands().stream().filter(d -> d != null && d.getDemand() > 0 && d.getWidth() > 0 && d.getLength() > 0 &&
                ((d.getWidth() <= width && d.getLength() <= length && (request.isAllowLongitudinal() || Math.abs(d.getWidth()-width) < .001)) ||
                 ((request.isAllowRotation() || d.isAllowRotation()) && d.getLength() <= width && d.getWidth() <= length &&
                  (request.isAllowLongitudinal() || Math.abs(d.getLength()-width) < .001)))).count();
        if (fit == 0) return;
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("type", type); row.put("id", id); row.put("rollId", rollId); row.put("width", width); row.put("length", length);
        row.put("location", location); row.put("hasDefect", defects); row.put("fittingLines", fit);
        result.add(row);
    }

    public synchronized Map<String, Object> confirm(SolveRequest request, SolveResponse plan, CutReport report) {
        return mutate(() -> confirmInternal(request, plan, report));
    }

    public synchronized Map<String, Object> confirm(SolveRequest request, SolveResponse plan, CutReport report, String baseline) {
        if (!Objects.equals(baseline, materialFingerprint(request)))
            throw new IllegalArgumentException("材料或疵点已更新，请重新装载并排料");
        return confirm(request, plan, report);
    }

    private Map<String, Object> confirmInternal(SolveRequest request, SolveResponse plan, CutReport report) {
        Map<String, Object> old = receipts.get(report.planId());
        if (old != null) {
            if ("REVERSED".equals(old.get("status"))) throw new IllegalArgumentException("该报工已撤回，请重新排料");
            return old;
        }
        ReportOutput output = ReportOutput.resolve(plan, report);
        validateTaskReport(request, plan, output);
        boolean remnantFeed = "remnant".equalsIgnoreCase(request.getFeedPortType());
        MotherRollInfo roll = motherRolls.get(request.getRollId());
        RemnantStock parent = remnantFeed ? remnantPool.get(request.getSourceRemnantId()) : null;
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
        if (remnantFeed ? len != 0 : (!Double.isFinite(len) || len <= 0 || len > request.getRollL() || len > roll.getCurrentRemainingLength())) {
            throw new IllegalArgumentException("实切长度无效或超过母卷剩余长度");
        }
        if (!remnantFeed) {
            double start = request.getWindowStartY();
            if (!Double.isFinite(start) || start < 0 || start + len > roll.getTotalLength()) {
                throw new IllegalArgumentException("红框实切区间超出母卷范围");
            }
            for (Map<String, Object> receipt : receipts.values()) {
                if ("REVERSED".equals(receipt.get("status"))) continue;
                if (!request.getRollId().equals(receipt.get("rollId")) || !"roll".equals(receipt.get("feedPortType"))) continue;
                double oldStart = ((Number) receipt.get("windowStartY")).doubleValue();
                double oldEnd = oldStart + ((Number) receipt.get("actualCutLen")).doubleValue();
                if (start < oldEnd && start + len > oldStart) throw new IllegalArgumentException("红框区域已实切确认，请移动到未切区间");
            }
        }
        double maxPieceY = output.cutPieces().stream().mapToDouble(p -> p.getY() + p.getL()).max().orElse(0);
        if (!remnantFeed && len + 0.001 < maxPieceY) throw new IllegalArgumentException("实切长度短于合格或异常裁片的末端");
        List<RemnantPiece> actual = report.actualRemnants() == null ? List.of() : report.actualRemnants();
        double remArea = 0;
        Set<String> seen = new HashSet<>();
        List<double[]> recoveredBounds = new ArrayList<>();
        double sourceLength = remnantFeed ? parent.getLength() : len;
        var recoveryCandidates = output.recoveryCandidates(plan, sourceLength);
        double tolerance = Double.isFinite(measurementToleranceMm) ? Math.max(0, measurementToleranceMm) : 0;
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
        if (output.qualifiedArea() + output.rejectedArea() + remArea > sourceArea + 0.001) throw new IllegalArgumentException("合格、异常裁片与料头面积超过实切用料面积");

        Map<String, Object> undo = new LinkedHashMap<>();
        if (remnantFeed) {
            undo.put("parentBefore", json.writeValueAsString(parent));
            parent.setStatus("CONSUMED");
            parent.setConsumedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
            undo.put("parentAfter", json.writeValueAsString(parent));
        } else {
            undo.put("remainingBefore", roll.getCurrentRemainingLength());
            undo.put("usedBefore", roll.getUsedLength());
            roll.setCurrentRemainingLength(roll.getCurrentRemainingLength() - len);
            roll.setUsedLength(roll.getUsedLength() + len);
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
                    String.format("%03d", remnantSeq.incrementAndGet());
            RemnantStock child = new RemnantStock(id, item.getW(), item.getL(),
                    report.location() == null || report.location().isBlank() ? "现场料头架" : report.location(),
                    request.getRollModel(), item.isHasDefect() && childDefects.isEmpty() ? "QUARANTINED" : "AVAILABLE",
                    request.getRollId(), item.isHasDefect() || !childDefects.isEmpty(), item.getStatus());
            child.setDefects(childDefects);
            child.setParentRemnantId(remnantFeed ? parent.getId() : null);
            child.setGeneration(remnantFeed ? parent.getGeneration() + 1 : 1);
            child.setCreatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
            remnantPool.put(id, child);
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
        receipt.put("derivedRemnants", children);
        receipt.put("recoveredGeometry", recoveredGeometry);
        receipt.put("confirmedAt", LocalDateTime.now().toString());
        receipts.put(report.planId(), receipt);
        return receipt;
    }

    public synchronized boolean resetRoll(String rollId) {
        return mutate(() -> resetRollInternal(rollId));
    }

    private boolean resetRollInternal(String rollId) {
        MotherRollInfo roll = motherRolls.get(rollId);
        if (roll == null) return false;
        if (receipts.values().stream().anyMatch(r -> rollId.equals(r.get("rollId")) && r.get("taskId") != null))
            throw new IllegalArgumentException("该母卷已有任务报工记录，不能通过演示重置清除");
        roll.setCurrentRemainingLength(roll.getTotalLength());
        roll.setUsedLength(0.0);
        receipts.entrySet().removeIf(e -> rollId.equals(e.getValue().get("rollId")));
        remnantPool.entrySet().removeIf(e -> rollId.equals(e.getValue().getSourceRollId()));
        if ("ROLL-2026-0920".equals(rollId)) {
            RemnantStock r1 = new RemnantStock("REM-202609-001", 2000, 1600, "库位 A-01-03", "TC涤棉-B2026",
                    "AVAILABLE", "ROLL-2026-0920", false, "完好可用短料 (Word 表1算例)");
            r1.setGeneration(1);
            r1.setQualityGrade("GRADE_A");
            r1.setCreatedAt("2026-09-20 14:30");
            remnantPool.put(r1.getId(), r1);

            RemnantStock r2 = new RemnantStock("REM-202609-002", 500, 4000, "库位 B-02-08", "TC涤棉-B2026",
                    "AVAILABLE", "ROLL-2026-0920", false, "右侧纵切可用长料头");
            r2.setGeneration(1);
            r2.setQualityGrade("GRADE_A");
            r2.setCreatedAt("2026-09-20 16:15");
            remnantPool.put(r2.getId(), r2);

            RemnantStock r3 = new RemnantStock("REM-202609-003", 500, 4000, "库位 D-DEF-01", "TC涤棉-B2026",
                    "AVAILABLE", "ROLL-2026-0920", true, "左侧带疵料头 (内部含瑕疵需避让)");
            r3.setGeneration(1);
            r3.setQualityGrade("GRADE_DEFECT");
            r3.setCreatedAt("2026-09-20 17:40");
            List<Defect> defs = new ArrayList<>();
            defs.add(new Defect(1, 200, 1500, 150, 600, 30, "HOLE", "破洞残留", 4, 4, "MANUAL_INSPECT", "MUST_AVOID", "料头内局部破洞"));
            r3.setDefects(defs);
            remnantPool.put(r3.getId(), r3);
        }
        return true;
    }

    private static boolean overlaps(double x, double y, double w, double l,
                                    double otherX, double otherY, double otherW, double otherL) {
        return x < otherX + otherW && x + w > otherX && y < otherY + otherL && y + l > otherY;
    }

    private void initMotherRolls() {
        // 母卷 1: ROLL-2026-0920 (TC涤棉)
        MotherRollInfo roll1 = new MotherRollInfo("ROLL-2026-0920", "TC涤棉-B2026", "BAT-202609-A1",
                "华联高新纺织印染有限公司", "65/35涤棉高密斜纹布", "藏青色 (PANTONE 19-4024)",
                240.0, "65%涤纶, 35%精梳棉", 2000, 60000, "原料立库 R-01-A03");
        roll1.setCurrentRemainingLength(55000);
        roll1.setUsedLength(5000);
        roll1.setInspectionStatus("PASSED");
        roll1.setInspector("AI-SCANNER-01 (视觉验布复核)");
        roll1.setInspectionDate("2026-09-20");

        // 录入 8 处纺织 4 分制标准疵点
        List<Defect> defs1 = new ArrayList<>();
        defs1.add(new Defect(1, 400, 1400, 200, 150, 20, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "织造破洞，4分制重疵，切断隔离"));
        defs1.add(new Defect(2, 1100, 3200, 160, 100, 20, "WEFT_DEFECT", "纬向抽纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "纱支抽纱，影响受力，强制避让"));
        defs1.add(new Defect(3, 200, 8500, 300, 200, 20, "STAIN", "油污渍斑", 2, 2, "MANUAL_INSPECT", "MUST_AVOID", "印染滴油污渍，避开合格裁片"));
        defs1.add(new Defect(4, 1500, 14200, 150, 400, 25, "WEFT_DEFECT", "断纬跳纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "织机断纬"));
        defs1.add(new Defect(5, 700, 22100, 100, 80, 15, "SLUB", "粗节结头", 1, 1, "AI_VISION_SCANNER", "PENETRABLE", "轻微粗节，允许落入带疵料头"));
        defs1.add(new Defect(6, 1200, 31500, 250, 180, 25, "HOLE", "撕裂破洞", 4, 4, "MANUAL_INSPECT", "MUST_AVOID", "落布撕破，必须切除隔离"));
        defs1.add(new Defect(7, 500, 45000, 400, 300, 20, "WEFT_DEFECT", "稀密档", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "纬密不匀条斑"));
        defs1.add(new Defect(8, 1600, 54200, 300, 150, 20, "SHADING", "边中色差", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "染色左中右色差"));
        roll1.setDefects(defs1);
        motherRolls.put(roll1.getRollId(), roll1);

        // 母卷 2: ROLL-2026-0921 (纯棉斜纹)
        MotherRollInfo roll2 = new MotherRollInfo("ROLL-2026-0921", "纯棉斜纹-C2026", "BAT-202609-B2",
                "魏桥纺织股份有限公司", "100%精梳纯棉斜纹", "米白色 (PANTONE 11-0601)",
                210.0, "100%精梳棉", 1800, 50000, "原料立库 R-02-B01");
        roll2.setCurrentRemainingLength(48000);
        roll2.setUsedLength(2000);
        roll2.setInspectionStatus("PASSED");
        roll2.setInspector("李师傅 (人工验布标定)");
        roll2.setInspectionDate("2026-09-21");

        List<Defect> defs2 = new ArrayList<>();
        defs2.add(new Defect(9, 300, 2500, 180, 120, 20, "STAIN", "黄斑水渍", 2, 2, "MANUAL_INSPECT", "MUST_AVOID", "水渍泛黄"));
        defs2.add(new Defect(10, 1200, 16800, 140, 200, 20, "HOLE", "织孔破损", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "织针损伤破洞"));
        defs2.add(new Defect(11, 800, 33000, 200, 100, 15, "SLUB", "棉结死棉", 1, 1, "AI_VISION_SCANNER", "PENETRABLE", "棉结"));
        roll2.setDefects(defs2);
        motherRolls.put(roll2.getRollId(), roll2);

        // 母卷 3: ROLL-2026-0922 (弹力牛津)
        MotherRollInfo roll3 = new MotherRollInfo("ROLL-2026-0922", "弹力牛津-O2026", "BAT-202609-C3",
                "盛泽东方丝绸纺织", "锦棉弹力牛津纺", "墨绿色 (PANTONE 19-5513)",
                280.0, "70%锦纶, 25%棉, 5%氨纶", 2200, 80000, "原料立库 R-03-C05");
        roll3.setCurrentRemainingLength(80000);
        roll3.setUsedLength(0);
        roll3.setInspectionStatus("PENDING");
        roll3.setInspector("待视觉上线");
        roll3.setInspectionDate("2026-09-21");

        List<Defect> defs3 = new ArrayList<>();
        defs3.add(new Defect(12, 1000, 12000, 250, 180, 20, "WEFT_DEFECT", "氨纶断丝", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "弹力氨纶丝断"));
        roll3.setDefects(defs3);
        motherRolls.put(roll3.getRollId(), roll3);

        MotherRollInfo curtain2d = new MotherRollInfo("ROLL-DEMO-2D", "窗帘样布-2D", "DEMO-2D",
                "演示样布", "窗帘矩形样布", "米白色", 220, "演示面料", 2000, 30000, "演示库位");
        curtain2d.setInspectionStatus("PASSED");
        curtain2d.setDefects(new ArrayList<>(List.of(new Defect(21, 200, 1500, 150, 600, 50,
                "HOLE", "带疵改宽区域", 4, 4, "MANUAL_INSPECT", "MUST_AVOID", "二维带疵点演示"))));
        motherRolls.put(curtain2d.getRollId(), curtain2d);

        // 真实布艺母卷 1: ROLL-REAL-893292 (2#A3A-Cream · 100m 卷装)
        MotherRollInfo real893292 = new MotherRollInfo("ROLL-REAL-893292", "2#A3A-Cream", "BAT-REAL-893292",
                "真实布艺供应链 (893292)", "窗帘高密提花雪尼尔 (2#A3A-Cream)", "米色 (Cream)",
                380.0, "100%涤纶高密遮光", 2800, 100000, "布艺成品库 A-08-01");
        real893292.setCurrentRemainingLength(100000);
        real893292.setUsedLength(0);
        real893292.setInspectionStatus("PASSED");
        real893292.setInspector("AI视觉验布机-03 (已复核)");
        real893292.setInspectionDate("2026-09-28");
        List<Defect> defs893292 = new ArrayList<>(List.of(
                new Defect(1, 2118.8, 3630.6, 144.1, 180.2, 20.0, "WEFT_DEFECT", "断纬跳纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "断纬跳纱，避让"),
                new Defect(2, 1084.7, 9729.0, 251.8, 107.1, 20.0, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "织造破洞，切断隔离"),
                new Defect(3, 914.7, 10595.8, 131.1, 242.7, 20.0, "STAIN", "油污渍斑", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "印染油污，必须避开"),
                new Defect(4, 918.1, 11466.1, 176.0, 141.0, 20.0, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "织造破洞，切断隔离"),
                new Defect(5, 1357.6, 14244.5, 261.4, 204.1, 20.0, "STAIN", "油污渍斑", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "印染油污，必须避开"),
                new Defect(6, 1674.6, 23417.1, 115.8, 129.8, 20.0, "WEFT_DEFECT", "断纬跳纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "断纬跳纱，避让"),
                new Defect(7, 163.9, 24621.8, 215.5, 199.8, 20.0, "STAIN", "油污渍斑", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "印染油污，必须避开"),
                new Defect(8, 2141.6, 54218.6, 254.6, 247.5, 20.0, "WEFT_DEFECT", "纬向抽纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "纱支抽纱，强制避让"),
                new Defect(9, 2155.3, 55782.6, 176.0, 157.1, 20.0, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "织造破洞，切断隔离"),
                new Defect(10, 724.4, 58663.5, 174.0, 115.6, 20.0, "WEFT_DEFECT", "纬向抽纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "纱支抽纱，强制避让"),
                new Defect(11, 472.8, 59798.8, 229.6, 183.6, 20.0, "SHADING", "边中色差", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "染色色差，不可做正面裁片"),
                new Defect(12, 738.6, 69580.5, 149.0, 158.6, 20.0, "SHADING", "边中色差", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "染色色差，不可做正面裁片"),
                new Defect(13, 848.5, 71027.9, 237.6, 117.3, 20.0, "SHADING", "边中色差", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "染色色差，不可做正面裁片"),
                new Defect(14, 855.7, 73455.8, 145.8, 85.5, 20.0, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "织造破洞，切断隔离"),
                new Defect(15, 1517.2, 73542.7, 113.2, 235.2, 20.0, "STAIN", "油污渍斑", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "印染油污，必须避开")
        ));
        real893292.setDefects(defs893292);
        motherRolls.put(real893292.getRollId(), real893292);

        // 真实布艺母卷 2: ROLL-REAL-893153 (2#1A-Off White · 100m 卷装)
        MotherRollInfo real893153 = new MotherRollInfo("ROLL-REAL-893153", "2#1A-Off White", "BAT-REAL-893153",
                "真实布艺供应链 (893153)", "工程高密垂感遮光布 (2#1A-Off White)", "米白 (Off White)",
                360.0, "100%高支密涤纶", 2800, 100000, "布艺成品库 A-08-02");
        real893153.setCurrentRemainingLength(100000);
        real893153.setUsedLength(0);
        real893153.setInspectionStatus("PASSED");
        real893153.setInspector("AI视觉验布机-02 (已复核)");
        real893153.setInspectionDate("2026-09-28");
        List<Defect> defs893153 = new ArrayList<>(List.of(
                new Defect(1, 1200.0, 4200.0, 180.0, 150.0, 20.0, "WEFT_DEFECT", "断纬跳纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "断纬跳纱避让"),
                new Defect(2, 600.0, 11500.0, 200.0, 120.0, 20.0, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "切断隔离破洞"),
                new Defect(3, 1800.0, 18200.0, 150.0, 220.0, 20.0, "STAIN", "油污渍斑", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "印染油污避开"),
                new Defect(4, 900.0, 27800.0, 160.0, 140.0, 20.0, "WEFT_DEFECT", "纬向抽纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "抽纱瑕疵"),
                new Defect(5, 2100.0, 35400.0, 220.0, 180.0, 20.0, "SHADING", "边中色差", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "色差瑕疵"),
                new Defect(6, 400.0, 44200.0, 130.0, 160.0, 20.0, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "破损点隔离"),
                new Defect(7, 1500.0, 52000.0, 190.0, 130.0, 20.0, "STAIN", "油污渍斑", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "油污斑块"),
                new Defect(8, 800.0, 61500.0, 240.0, 170.0, 20.0, "WEFT_DEFECT", "纬向抽纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "抽纱疵点"),
                new Defect(9, 1700.0, 71200.0, 150.0, 190.0, 20.0, "SHADING", "边中色差", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "色差条斑"),
                new Defect(10, 500.0, 80400.0, 180.0, 140.0, 20.0, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "织造破洞"),
                new Defect(11, 1300.0, 88900.0, 210.0, 160.0, 20.0, "WEFT_DEFECT", "断纬跳纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "跳纱瑕疵"),
                new Defect(12, 1900.0, 96500.0, 160.0, 200.0, 20.0, "STAIN", "油污渍斑", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "印染油污")
        ));
        real893153.setDefects(defs893153);
        motherRolls.put(real893153.getRollId(), real893153);
    }

    private void initSampleRemnants() {
        // 母卷 ROLL-2026-0920 切下的料头
        RemnantStock r1 = new RemnantStock("REM-202609-001", 2000, 1600, "库位 A-01-03", "TC涤棉-B2026",
                "AVAILABLE", "ROLL-2026-0920", false, "完好可用短料 (Word 表1算例)");
        r1.setGeneration(1);
        r1.setQualityGrade("GRADE_A");
        r1.setCreatedAt("2026-09-20 14:30");
        remnantPool.put(r1.getId(), r1);

        RemnantStock r2 = new RemnantStock("REM-202609-002", 500, 4000, "库位 B-02-08", "TC涤棉-B2026",
                "AVAILABLE", "ROLL-2026-0920", false, "右侧纵切可用长料头");
        r2.setGeneration(1);
        r2.setQualityGrade("GRADE_A");
        r2.setCreatedAt("2026-09-20 16:15");
        remnantPool.put(r2.getId(), r2);

        RemnantStock r3 = new RemnantStock("REM-202609-003", 500, 4000, "库位 D-DEF-01", "TC涤棉-B2026",
                "AVAILABLE", "ROLL-2026-0920", true, "左侧带疵料头 (内部含瑕疵需避让)");
        r3.setGeneration(1);
        r3.setQualityGrade("GRADE_DEFECT");
        r3.setCreatedAt("2026-09-20 17:40");
        List<Defect> defs = new ArrayList<>();
        defs.add(new Defect(1, 200, 1500, 150, 600, 30, "HOLE", "破洞残留", 4, 4, "MANUAL_INSPECT", "MUST_AVOID", "料头内局部破洞"));
        r3.setDefects(defs);
        remnantPool.put(r3.getId(), r3);

        // 母卷 ROLL-2026-0921 切下的料头
        RemnantStock r4 = new RemnantStock("REM-202609-004", 1800, 1200, "库位 C-01-05", "纯棉斜纹-C2026",
                "AVAILABLE", "ROLL-2026-0921", false, "纯棉完好短料");
        r4.setGeneration(1);
        r4.setQualityGrade("GRADE_A");
        r4.setCreatedAt("2026-09-21 09:00");
        remnantPool.put(r4.getId(), r4);

        RemnantStock r5 = new RemnantStock("REM-202609-005", 400, 3000, "库位 C-02-02", "纯棉斜纹-C2026",
                "AVAILABLE", "ROLL-2026-0921", false, "纯棉分条长料头");
        r5.setGeneration(1);
        r5.setQualityGrade("GRADE_A");
        r5.setCreatedAt("2026-09-21 09:20");
        remnantPool.put(r5.getId(), r5);
    }

    public synchronized List<MotherRollInfo> getMotherRolls() {
        return read(() -> getMotherRollsInternal());
    }

    private List<MotherRollInfo> getMotherRollsInternal() {
        List<MotherRollInfo> list = new ArrayList<>();
        for (MotherRollInfo info : motherRolls.values()) {
            List<RemnantStock> rollRemnants = getRemnantsByRollId(info.getRollId());
            double totalArea = rollRemnants.stream().mapToDouble(RemnantStock::getArea).sum();
            info.setRemnantCount(rollRemnants.size());
            info.setRemnantTotalArea(totalArea);
            list.add(info);
        }
        return list;
    }

    public synchronized MotherRollInfo getMotherRoll(String rollId) {
        return read(() -> getMotherRollInternal(rollId));
    }

    private MotherRollInfo getMotherRollInternal(String rollId) {
        if (rollId == null) return null;
        MotherRollInfo info = motherRolls.get(rollId);
        if (info != null) {
            List<RemnantStock> rollRemnants = getRemnantsByRollId(rollId);
            info.setRemnantCount(rollRemnants.size());
            info.setRemnantTotalArea(rollRemnants.stream().mapToDouble(RemnantStock::getArea).sum());
        }
        return info;
    }

    public synchronized MotherRollInfo saveOrUpdateMotherRoll(MotherRollInfo roll) {
        return mutate(() -> saveOrUpdateMotherRollInternal(roll));
    }

    private MotherRollInfo saveOrUpdateMotherRollInternal(MotherRollInfo roll) {
        if (roll == null || roll.getRollId() == null || roll.getRollId().trim().isEmpty()) {
            throw new IllegalArgumentException("母卷编号 (rollId) 不能为空！");
        }
        if (!Double.isFinite(roll.getWidth()) || !Double.isFinite(roll.getTotalLength()) ||
                roll.getWidth() <= 0 || roll.getTotalLength() <= 0) {
            throw new IllegalArgumentException("母卷幅宽和总长度必须大于零");
        }
        MotherRollInfo existing = motherRolls.get(roll.getRollId());
        if (existing != null) {
            if (Math.abs(existing.getWidth() - roll.getWidth()) > 0.001 ||
                    Math.abs(existing.getTotalLength() - roll.getTotalLength()) > 0.001) {
                throw new IllegalArgumentException("已登记母卷的物理尺寸不可直接覆盖");
            }
            existing.setRollModel(roll.getRollModel());
            existing.setBatchNo(roll.getBatchNo());
            existing.setSupplier(roll.getSupplier());
            existing.setMaterialName(roll.getMaterialName());
            existing.setColor(roll.getColor());
            existing.setGrammage(roll.getGrammage());
            existing.setComposition(roll.getComposition());
            existing.setWidth(roll.getWidth());
            existing.setRawWidth(roll.getRawWidth());
            existing.setTotalLength(roll.getTotalLength());
            existing.setStorageLocation(roll.getStorageLocation());
            existing.setInspectionStatus(roll.getInspectionStatus());
            if (roll.getDefects() != null && !roll.getDefects().isEmpty()) {
                existing.setDefects(roll.getDefects());
            }
            return existing;
        } else {
            if (roll.getCreatedAt() == null) {
                roll.setCreatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")));
            }
            if (roll.getCurrentRemainingLength() <= 0) {
                roll.setCurrentRemainingLength(roll.getTotalLength());
            }
            motherRolls.put(roll.getRollId(), roll);
            return roll;
        }
    }

    public synchronized Defect addDefectToRoll(String rollId, Defect defect) {
        return mutate(() -> addDefectToRollInternal(rollId, defect));
    }

    private Defect addDefectToRollInternal(String rollId, Defect defect) {
        MotherRollInfo roll = getMotherRoll(rollId);
        if (roll == null) {
            throw new IllegalArgumentException("未找到母卷: " + rollId);
        }
        if (defect == null || !Double.isFinite(defect.getX()) || !Double.isFinite(defect.getY()) ||
                !Double.isFinite(defect.getW()) || !Double.isFinite(defect.getH()) ||
                defect.getX() < 0 || defect.getY() < 0 || defect.getW() <= 0 || defect.getH() <= 0 ||
                defect.getX() + defect.getW() > roll.getWidth() ||
                defect.getY() + defect.getH() > roll.getTotalLength()) {
            throw new IllegalArgumentException("疵点坐标或尺寸超出母卷范围");
        }
        if (defect.getId() == 0) {
            defect.setId(defectSeq.incrementAndGet());
        }
        roll.getDefects().add(defect);
        return defect;
    }

    public synchronized boolean scrapRemnant(String id, String reason) {
        return mutate(() -> scrapRemnantInternal(id, reason));
    }

    private boolean scrapRemnantInternal(String id, String reason) {
        RemnantStock item = remnantPool.get(id);
        if (item == null) return false;
        item.setStatus("SCRAPPED");
        item.setDefectDesc((item.getDefectDesc() != null ? item.getDefectDesc() + " | " : "") + "已报废: " + reason);
        return true;
    }

    public synchronized List<RemnantStock> getAvailableRemnants() {
        return read(() -> getAvailableRemnantsInternal());
    }

    private List<RemnantStock> getAvailableRemnantsInternal() {
        return remnantPool.values().stream()
                .filter(r -> "AVAILABLE".equalsIgnoreCase(r.getStatus()))
                .sorted(Comparator.comparing(RemnantStock::getId))
                .collect(Collectors.toList());
    }

    public synchronized List<RemnantStock> getRemnantsByRollId(String rollId) {
        return read(() -> getRemnantsByRollIdInternal(rollId));
    }

    private List<RemnantStock> getRemnantsByRollIdInternal(String rollId) {
        if (rollId == null || rollId.trim().isEmpty() || "ALL".equalsIgnoreCase(rollId)) {
            return getAvailableRemnants();
        }
        String cleanRollId = rollId.trim();
        return remnantPool.values().stream()
                .filter(r -> "AVAILABLE".equalsIgnoreCase(r.getStatus()))
                .filter(r -> cleanRollId.equalsIgnoreCase(r.getSourceRollId()))
                .sorted(Comparator.comparing(RemnantStock::getId))
                .collect(Collectors.toList());
    }

    public synchronized List<RemnantStock> getAllRemnants() {
        return read(() -> getAllRemnantsInternal());
    }

    private List<RemnantStock> getAllRemnantsInternal() {
        return new ArrayList<>(remnantPool.values());
    }

    public synchronized RemnantStock scanOrGetById(String id) {
        return read(() -> scanOrGetByIdInternal(id));
    }

    private RemnantStock scanOrGetByIdInternal(String id) {
        if (id == null) return null;
        String cleanId = id.trim();
        RemnantStock direct = remnantPool.get(cleanId);
        if (direct != null && "AVAILABLE".equalsIgnoreCase(direct.getStatus())) {
            return direct;
        }
        for (RemnantStock r : remnantPool.values()) {
            if ("AVAILABLE".equalsIgnoreCase(r.getStatus()) &&
                    (r.getId().equalsIgnoreCase(cleanId) || r.getId().endsWith(cleanId))) {
                return r;
            }
        }
        return null;
    }

    public synchronized List<RemnantStock> matchRemnants(String rollId, double pieceW, double pieceL, boolean allowRotation) {
        return read(() -> matchRemnantsInternal(rollId, pieceW, pieceL, allowRotation));
    }

    private List<RemnantStock> matchRemnantsInternal(String rollId, double pieceW, double pieceL, boolean allowRotation) {
        List<RemnantStock> candidates = getRemnantsByRollId(rollId);
        List<RemnantStock> matched = new ArrayList<>();
        for (RemnantStock r : candidates) {
            if (r.isHasDefect()) continue;
            boolean fitsNormal = (r.getWidth() >= pieceW && r.getLength() >= pieceL);
            boolean fitsRotated = allowRotation && (r.getWidth() >= pieceL && r.getLength() >= pieceW);
            if (fitsNormal || fitsRotated) {
                matched.add(r);
            }
        }
        matched.sort(Comparator.comparingDouble(RemnantStock::getArea));
        return matched;
    }

    public synchronized RemnantStock registerRemnant(RemnantStock item) {
        return mutate(() -> registerRemnantInternal(item));
    }

    private RemnantStock registerRemnantInternal(RemnantStock item) {
        if (item == null || !Double.isFinite(item.getWidth()) || !Double.isFinite(item.getLength()) ||
                item.getWidth() <= 0 || item.getLength() <= 0) throw new IllegalArgumentException("料头宽长必须大于零");
        if (item.getId() == null || item.getId().trim().isEmpty()) {
            String dateStr = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMM"));
            item.setId("REM-" + dateStr + "-" + String.format("%03d", remnantSeq.incrementAndGet()));
        }
        if (remnantPool.containsKey(item.getId())) throw new IllegalArgumentException("料头编号已存在: " + item.getId());
        if (item.getCreatedAt() == null) {
            item.setCreatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
        }
        if (item.getStatus() == null) {
            item.setStatus("AVAILABLE");
        }
        remnantPool.put(item.getId(), item);
        return item;
    }

    public synchronized RemnantStock autoRegisterCutRemnant(String rollId, String parentRemnantId, double w, double l, boolean hasDefect, String desc) {
        return mutate(() -> autoRegisterCutRemnantInternal(rollId, parentRemnantId, w, l, hasDefect, desc));
    }

    private RemnantStock autoRegisterCutRemnantInternal(String rollId, String parentRemnantId, double w, double l, boolean hasDefect, String desc) {
        String dateStr = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMM"));
        String newId = "REM-" + dateStr + "-" + String.format("%03d", remnantSeq.incrementAndGet());
        if (parentRemnantId != null && !parentRemnantId.isEmpty()) {
            newId = parentRemnantId + "-SUB" + remnantSeq.get();
        }
        RemnantStock rs = new RemnantStock(newId, w, l, "现场料头架", rollId, "AVAILABLE", rollId, hasDefect, desc);
        rs.setParentRemnantId(parentRemnantId);
        rs.setGeneration(parentRemnantId != null ? 2 : 1);
        rs.setQualityGrade(hasDefect ? "GRADE_DEFECT" : "GRADE_A");
        rs.setCreatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
        remnantPool.put(rs.getId(), rs);
        return rs;
    }

    public synchronized boolean consumeRemnant(String id) {
        return mutate(() -> consumeRemnantInternal(id));
    }

    private boolean consumeRemnantInternal(String id) {
        if (id == null) return false;
        RemnantStock item = remnantPool.get(id);
        if (item != null) {
            item.setStatus("CONSUMED");
            item.setConsumedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
            return true;
        }
        return false;
    }

    public synchronized boolean updateStatus(String id, String status) {
        return mutate(() -> updateStatusInternal(id, status));
    }

    private boolean updateStatusInternal(String id, String status) {
        if (id == null) return false;
        RemnantStock item = remnantPool.get(id);
        if (item != null) {
            item.setStatus(status);
            return true;
        }
        return false;
    }
}
