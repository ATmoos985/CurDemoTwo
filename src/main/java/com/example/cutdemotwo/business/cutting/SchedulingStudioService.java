package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.algorithm.api.NestingSolver;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.business.model.CutReport;
import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.DemandTemplate;
import com.example.cutdemotwo.business.model.ExecutionOrder;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.PieceDemand;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.business.model.SolveResponse;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.contracts.geometry.RemnantPiece;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.persistence.InventoryConflictException;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 统一搭切排程领域服务：
 * 串联「需求模板库 → 多维待排需求池 → 搭切方案冻结落库（虚拟新母卷 / 在库实卷）→ 实卷绑定 / 一键完工过账 / 母卷切割空间图 / MES 协同」。
 */
@Service
public class SchedulingStudioService {
    private static final DateTimeFormatter TS_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private final RemnantService inventory;
    private final NestingSolver solverFactory;

    public SchedulingStudioService(RemnantService inventory, NestingSolver solverFactory) {
        this.inventory = inventory;
        this.solverFactory = solverFactory;
    }

    // ==================== 1. 需求模板库 (Demand Templates) ====================

    public List<DemandTemplate> listTemplates() {
        return inventory.studioRead(() -> {
            List<DemandTemplate> list = new ArrayList<>(inventory.templateMap().values());
            list.sort(Comparator.comparing((DemandTemplate t) -> Objects.toString(t.updatedAt(), "")).reversed());
            return list;
        });
    }

    public DemandTemplate saveTemplate(DemandTemplate input) {
        if (input == null || input.name() == null || input.name().isBlank()) {
            throw new IllegalArgumentException("请填写需求模板名称");
        }
        if (input.pieces() == null || input.pieces().isEmpty()) {
            throw new IllegalArgumentException("需求模板至少包含 1 项组成部件");
        }
        if (!Double.isFinite(input.defaultWidthMm()) || input.defaultWidthMm() <= 0) {
            throw new IllegalArgumentException("预设标准门幅必须为正数");
        }
        String dim = normalizeDimension(input.dimension(), input.category());
        String id = (input.id() == null || input.id().isBlank())
                ? "TPL-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase()
                : input.id().trim();
        String code = (input.code() == null || input.code().isBlank()) ? id : input.code().trim();
        String model = (input.materialModel() == null || input.materialModel().isBlank())
                ? "MAT-" + code
                : input.materialModel().trim();
        List<String> sizes = (input.availableSizes() == null || input.availableSizes().isEmpty())
                ? List.of("标准规格")
                : input.availableSizes();
        Map<String, Integer> defaults = new LinkedHashMap<>();
        for (int i = 0; i < sizes.size(); i++) {
            String sz = sizes.get(i);
            int cnt = input.defaultSizeCounts() != null && input.defaultSizeCounts().containsKey(sz)
                    ? Math.max(0, input.defaultSizeCounts().get(sz))
                    : (i == 0 ? 1 : 0);
            defaults.put(sz, cnt);
        }
        String now = LocalDateTime.now().format(TS_FMT);
        DemandTemplate normalized = new DemandTemplate(
                id,
                code,
                input.name().trim(),
                input.category() == null || input.category().isBlank() ? defaultCategoryForDimension(dim) : input.category(),
                dim,
                Objects.toString(input.description(), ""),
                input.defaultWidthMm(),
                input.defaultLengthMm() > 0 ? input.defaultLengthMm() : 2000,
                model,
                sizes,
                defaults,
                true,
                input.pieces(),
                now
        );
        return inventory.studioMutate("SYSTEM_UPDATE", id, "UNAUTHENTICATED_LOCAL", () -> {
            inventory.templateMap().put(id, normalized);
            return normalized;
        });
    }

    public Map<String, Object> deleteTemplate(String id) {
        if (id == null || id.isBlank()) throw new IllegalArgumentException("请指定模板编号");
        return inventory.studioMutate("SYSTEM_UPDATE", id, "UNAUTHENTICATED_LOCAL", () -> {
            DemandTemplate removed = inventory.templateMap().remove(id.trim());
            return Map.of("deleted", removed != null, "id", id.trim());
        });
    }

    // ==================== 2. 多维待排需求池 (Demand Pool & Families) ====================

    public record SaveDemandFamilyCommand(
            String id,
            String mergeIntoTaskId,
            String name,
            String materialModel,
            String externalRef,
            String dimension,
            Double bedLengthMm,
            Double trimStartMm,
            Double pieceGapMm,
            Integer leftTrimMm,
            Integer rightTrimMm,
            Integer minWidthMm,
            Integer maxWidthMm,
            Integer widthStepMm,
            Integer totalOverCap,
            List<DemandLineInput> demands
    ) {}

    public record DemandLineInput(
            Integer id,
            String name,
            double width,
            double length,
            int quantity,
            Boolean allowRotation,
            Boolean allowHalfTurn,
            String sizeLabel,
            String sourceTemplateId,
            String surfaceTreatment,
            NestingProblem.Shape shape
    ) {}

    public List<Map<String, Object>> listDemandPool() {
        return inventory.studioRead(() -> {
            List<Map<String, Object>> out = new ArrayList<>();
            List<CuttingTask> tasks = new ArrayList<>(inventory.taskMap().values());
            Collections.reverse(tasks);
            for (CuttingTask task : tasks) {
                out.add(buildDemandFamilyViewInTx(task));
            }
            return out;
        });
    }

    public Map<String, Object> getDemandFamily(String taskId) {
        return inventory.studioRead(() -> {
            CuttingTask task = inventory.taskMap().get(taskId);
            if (task == null) throw new IllegalArgumentException("需求族不存在: " + taskId);
            return buildDemandFamilyViewInTx(task);
        });
    }

    public Map<String, Object> saveOrMergeDemandFamily(SaveDemandFamilyCommand cmd) {
        if (cmd == null || cmd.demands() == null || cmd.demands().isEmpty()) {
            throw new IllegalArgumentException("请至少提供 1 项有效需求明细");
        }
        return inventory.studioMutate("DEMAND_ADJUSTMENT", cmd.mergeIntoTaskId() != null ? cmd.mergeIntoTaskId() : cmd.id(),
                "UNAUTHENTICATED_LOCAL", () -> {
            CuttingTask saved = saveOrMergeTaskInTx(cmd);
            return buildDemandFamilyViewInTx(saved);
        });
    }

    private CuttingTask saveOrMergeTaskInTx(SaveDemandFamilyCommand cmd) {
        String targetId = (cmd.mergeIntoTaskId() != null && !cmd.mergeIntoTaskId().isBlank())
                ? cmd.mergeIntoTaskId().trim()
                : (cmd.id() != null && !cmd.id().isBlank() ? cmd.id().trim() : null);
        CuttingTask existing = targetId != null ? inventory.taskMap().get(targetId) : null;
        boolean merging = cmd.mergeIntoTaskId() != null && !cmd.mergeIntoTaskId().isBlank() && existing != null;

        String dim = normalizeDimension(cmd.dimension(), null);
        if (existing != null) {
            dim = inferTaskDimension(existing);
        } else if (cmd.demands().stream().anyMatch(d -> d != null && d.shape() != null && "POLYGON".equals(d.shape().type()))) {
            dim = "CONTOUR_2D";
        }
        boolean isSlit = "SLITTING_1D".equals(dim);
        boolean hasPoly = "CONTOUR_2D".equals(dim)
                || cmd.demands().stream().anyMatch(d -> d != null && d.shape() != null && "POLYGON".equals(d.shape().type()));

        List<CuttingTask.Line> lines = new ArrayList<>();
        int nextLineId = 1;
        if (merging) {
            lines.addAll(existing.demands());
            nextLineId = lines.stream().mapToInt(CuttingTask.Line::id).max().orElse(0) + 1;
        }

        for (DemandLineInput in : cmd.demands()) {
            if (in == null || in.quantity() <= 0) continue;
            int lineId = (!merging && in.id() != null && in.id() > 0) ? in.id() : nextLineId++;
            while (containsLineId(lines, lineId)) lineId = nextLineId++;

            NestingProblem.Shape shape = normalizeLineShape(in, isSlit, hasPoly);
            double w = shape != null ? shape.width() : (isSlit ? Math.rint(in.width()) : in.width());
            double l = shape != null ? shape.height() : (isSlit ? Math.rint(in.length()) : in.length());
            boolean allowRot = !isSlit && !hasPoly && Boolean.TRUE.equals(in.allowRotation());
            Boolean allowHalf = (!isSlit && hasPoly && Boolean.TRUE.equals(in.allowHalfTurn())) ? Boolean.TRUE : null;

            // Merge identical spec into existing line when merging into a family
            if (merging) {
                int matchIdx = findMergeableLineIndex(lines, in.name(), w, l, shape, allowRot, allowHalf);
                if (matchIdx >= 0) {
                    CuttingTask.Line old = lines.get(matchIdx);
                    lines.set(matchIdx, new CuttingTask.Line(
                            old.id(), old.name(), old.width(), old.length(),
                            old.quantity() + in.quantity(), old.allowRotation(), old.shape(),
                            old.allowHalfTurn(), old.sizeLabel(), old.sourceTemplateId(), old.surfaceTreatment()
                    ));
                    continue;
                }
            }

            lines.add(new CuttingTask.Line(
                    lineId,
                    (in.name() == null || in.name().isBlank()) ? ("规格 #" + lineId) : in.name().trim(),
                    w,
                    l,
                    in.quantity(),
                    allowRot,
                    shape,
                    allowHalf,
                    blankToNull(in.sizeLabel()),
                    blankToNull(in.sourceTemplateId()),
                    blankToNull(in.surfaceTreatment())
            ));
        }

        String name = existing != null && merging
                ? existing.name()
                : (cmd.name() == null || cmd.name().isBlank() ? "排程需求族 " + LocalDateTime.now().format(DateTimeFormatter.ofPattern("MMdd-HHmm")) : cmd.name().trim());
        String model = existing != null
                ? existing.materialModel()
                : (cmd.materialModel() == null || cmd.materialModel().isBlank() ? "STANDARD-MAT" : cmd.materialModel().trim());
        String extRef = cmd.externalRef() != null && !cmd.externalRef().isBlank()
                ? cmd.externalRef().trim()
                : (existing != null ? existing.externalRef() : null);

        double bedL = cmd.bedLengthMm() != null && cmd.bedLengthMm() > 0
                ? cmd.bedLengthMm()
                : (existing != null && existing.process() != null
                    ? existing.process().bedLength()
                    : Math.max(2000, lines.stream().mapToDouble(CuttingTask.Line::length).max().orElse(2000)));
        double trim = isSlit ? 0 : (cmd.trimStartMm() != null ? Math.max(0, cmd.trimStartMm())
                : (existing != null && existing.process() != null ? existing.process().trimStart() : 0));
        double gap = isSlit ? 0 : (cmd.pieceGapMm() != null ? Math.max(0, cmd.pieceGapMm())
                : (existing != null && existing.process() != null ? existing.process().pieceGap() : 0));

        CuttingTask.Process proc = new CuttingTask.Process(
                bedL,
                hasPoly ? 0 : trim,
                "left-top",
                isSlit ? "vertical" : "horizontal",
                lines.stream().anyMatch(CuttingTask.Line::allowRotation),
                true,
                gap
        );

        CuttingTask.Slitting slit = null;
        if (isSlit) {
            int maxLineW = (int) Math.ceil(lines.stream().mapToDouble(CuttingTask.Line::width).max().orElse(1000));
            int lt = cmd.leftTrimMm() != null ? Math.max(0, cmd.leftTrimMm())
                    : (existing != null && existing.slitting() != null ? existing.slitting().leftTrim() : 10);
            int rt = cmd.rightTrimMm() != null ? Math.max(0, cmd.rightTrimMm())
                    : (existing != null && existing.slitting() != null ? existing.slitting().rightTrim() : 10);
            int maxW = Math.max(maxLineW, cmd.maxWidthMm() != null && cmd.maxWidthMm() > 0
                    ? cmd.maxWidthMm()
                    : (existing != null && existing.slitting() != null ? existing.slitting().maxWidth() : Math.max(4400, maxLineW)));
            int minW = Math.min(maxW, Math.max(100, cmd.minWidthMm() != null && cmd.minWidthMm() > 0
                    ? cmd.minWidthMm()
                    : (existing != null && existing.slitting() != null ? existing.slitting().minWidth() : Math.min(maxLineW, (int) (maxW * 0.8)))));
            int step = cmd.widthStepMm() != null && cmd.widthStepMm() > 0 ? cmd.widthStepMm() : 10;
            if ((maxW - minW) / step > 1000) {
                step = Math.max(10, (int) Math.ceil((maxW - minW) / 900.0));
            }
            int overCap = cmd.totalOverCap() != null ? Math.max(0, cmd.totalOverCap()) : 20;
            slit = new CuttingTask.Slitting(lt, rt, minW, maxW, step, overCap);
        }

        CuttingTask payload = new CuttingTask(
                existing != null ? existing.id() : null,
                name,
                model,
                extRef,
                existing != null ? existing.revision() : 0,
                lines,
                proc,
                isSlit ? CuttingTask.SLITTING_1D : null,
                slit
        );
        return inventory.saveTaskInTx(payload);
    }

    private Map<String, Object> buildDemandFamilyViewInTx(CuttingTask task) {
        Map<String, Integer> completedMap = inventory.completedQuantitiesInTx(task.id());
        Map<String, Integer> plannedMap = plannedQuantitiesForTaskInTx(task.id(), null);
        String dimension = inferTaskDimension(task);

        int orderedTotal = 0;
        int plannedTotal = 0;
        int completedTotal = 0;
        int openTotal = 0;
        List<Map<String, Object>> lineViews = new ArrayList<>();

        for (CuttingTask.Line line : task.demands()) {
            String key = String.valueOf(line.id());
            int ordered = line.quantity();
            int completed = Math.max(0, completedMap.getOrDefault(key, 0));
            int planned = Math.max(0, plannedMap.getOrDefault(key, 0));
            int open = Math.max(0, ordered - completed - planned);

            orderedTotal += ordered;
            plannedTotal += planned;
            completedTotal += completed;
            openTotal += open;

            Map<String, Object> lv = new LinkedHashMap<>();
            lv.put("id", line.id());
            lv.put("name", line.name());
            lv.put("width", line.width());
            lv.put("length", line.length());
            lv.put("orderedQty", ordered);
            lv.put("plannedQty", planned);
            lv.put("completedQty", completed);
            lv.put("openQty", open);
            lv.put("allowRotation", line.allowRotation());
            lv.put("allowHalfTurn", Boolean.TRUE.equals(line.allowHalfTurn()));
            lv.put("sizeLabel", line.sizeLabel());
            lv.put("sourceTemplateId", line.sourceTemplateId());
            lv.put("surfaceTreatment", line.surfaceTreatment());
            lv.put("shape", line.shape());
            lineViews.add(lv);
        }

        long activeSchemes = inventory.schemeMap().values().stream()
                .filter(s -> task.id().equals(s.taskId()) && !SchedulingScheme.STATE_CANCELLED.equals(s.state()))
                .count();

        String status = completedTotal >= orderedTotal && orderedTotal > 0
                ? "COMPLETED"
                : openTotal == 0 && plannedTotal > 0
                ? "FULLY_PLANNED"
                : (plannedTotal > 0 || completedTotal > 0)
                ? "PARTIAL_PLANNED"
                : "OPEN";

        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", task.id());
        view.put("name", task.name());
        view.put("materialModel", task.materialModel());
        view.put("externalRef", task.externalRef());
        view.put("dimension", dimension);
        view.put("revision", task.revision());
        view.put("process", task.process());
        view.put("slitting", task.slitting());
        view.put("orderedTotal", orderedTotal);
        view.put("plannedTotal", plannedTotal);
        view.put("completedTotal", completedTotal);
        view.put("openTotal", openTotal);
        view.put("schemeCount", activeSchemes);
        view.put("status", status);
        view.put("lines", lineViews);
        return view;
    }

    /**
     * 计算任务内各需求行当前的「已排预占量 (plannedQty)」：
     * 合并活跃的 SchedulingScheme 预占与独立未归属方案的 ExecutionOrder 预约，且扣除已报工确认的方案，绝不重复扣减。
     */
    Map<String, Integer> plannedQuantitiesForTaskInTx(String taskId, String exceptSchemeId) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        Set<String> coveredPlans = new HashSet<>();

        for (SchedulingScheme s : inventory.schemeMap().values()) {
            if (!taskId.equals(s.taskId()) || Objects.equals(exceptSchemeId, s.id()) || !s.occupiesDemand()) {
                continue;
            }
            coveredPlans.addAll(s.linkedPlanIds());
            Map<String, Integer> alreadyReportedInScheme = new HashMap<>();
            for (String pid : s.linkedPlanIds()) {
                Map<String, Object> rec = inventory.receiptMap().get(pid);
                if (rec != null && !"REVERSED".equals(rec.get("status"))
                        && rec.get("demandQuantities") instanceof Map<?, ?> dq) {
                    dq.forEach((k, v) -> alreadyReportedInScheme.merge(String.valueOf(k), ((Number) v).intValue(), Integer::sum));
                }
            }
            s.allocatedDemands().forEach((lineId, qty) -> {
                int netPlanned = Math.max(0, qty - alreadyReportedInScheme.getOrDefault(lineId, 0));
                if (netPlanned > 0) {
                    counts.merge(lineId, netPlanned, Integer::sum);
                }
            });
        }

        long now = inventory.currentOperationTime();
        for (ExecutionOrder e : inventory.executionMap().values()) {
            if (taskId.equals(e.taskId()) && !coveredPlans.contains(e.planId()) && e.reserves(now)) {
                e.demandQuantities().forEach((lineId, qty) -> counts.merge(lineId, qty, Integer::sum));
            }
        }
        return counts;
    }

    // ==================== 3. 搭切后选定方案、绑实卷、完工过账与回滚 ====================

    public record ConfirmSchemeCommand(
            String idempotencyKey,
            String title,
            String dimension,
            String scenarioId,
            String strategyId,
            String strategyName,
            String taskId,
            String taskName,
            String externalOrderNo,
            String materialMode,
            String rollId,
            String remnantId,
            String materialModel,
            double widthMm,
            double canvasLengthMm,
            Double windowStartY,
            double occupiedLengthMm,
            double trimStartMm,
            double pieceGapMm,
            double utilizationPct,
            double pieceAreaM2,
            Boolean avoidDefects,
            List<DemandLineInput> demands,
            SchedulingScheme.Layout2DPayload layout2D,
            SchedulingScheme.Slitting1DPayload slitting1D
    ) {}

    public record BindRollCommand(
            String rollId,
            Boolean autoCreateRoll,
            Double newRollLengthMm,
            String storageLocation,
            Double windowStartY
    ) {}

    public record CompleteSchemeCommand(
            Double actualCutLenMm,
            List<Integer> rejectedPieceIds,
            Boolean recoverRemnants,
            String remnantLocation,
            String operator
    ) {}

    public List<Map<String, Object>> listSchemes(String stateFilter, String taskIdFilter) {
        return inventory.studioRead(() -> {
            List<SchedulingScheme> list = new ArrayList<>(inventory.schemeMap().values());
            Collections.reverse(list);
            List<Map<String, Object>> out = new ArrayList<>();
            for (SchedulingScheme s : list) {
                if (stateFilter != null && !stateFilter.isBlank() && !"ALL".equalsIgnoreCase(stateFilter)
                        && !stateFilter.equalsIgnoreCase(s.state())) {
                    continue;
                }
                if (taskIdFilter != null && !taskIdFilter.isBlank() && !taskIdFilter.equals(s.taskId())) {
                    continue;
                }
                out.add(enrichSchemeViewInTx(s));
            }
            return out;
        });
    }

    public Map<String, Object> getSchemeDetail(String id) {
        return inventory.studioRead(() -> {
            SchedulingScheme s = inventory.schemeMap().get(id);
            if (s == null) throw new IllegalArgumentException("排程方案不存在: " + id);
            return enrichSchemeViewInTx(s);
        });
    }

    public Map<String, Object> confirmScheme(ConfirmSchemeCommand cmd) {
        if (cmd == null) throw new IllegalArgumentException("方案确认请求不能为空");
        String idemKey = (cmd.idempotencyKey() == null || cmd.idempotencyKey().isBlank())
                ? "SCH-KEY-" + UUID.randomUUID()
                : cmd.idempotencyKey().trim();

        return inventory.studioMutate("DEMAND_ADJUSTMENT", idemKey, "UNAUTHENTICATED_LOCAL", () -> {
            for (SchedulingScheme existing : inventory.schemeMap().values()) {
                if (idemKey.equals(existing.idempotencyKey())) {
                    return enrichSchemeViewInTx(existing);
                }
            }

            String dim = normalizeDimension(cmd.dimension(), null);
            boolean isSlit = "SLITTING_1D".equals(dim);
            if (!isSlit && (cmd.layout2D() == null || cmd.layout2D().placements().isEmpty())) {
                throw new IllegalArgumentException("二维方案缺少已排入的裁片位置明细");
            }
            if (isSlit && (cmd.slitting1D() == null || cmd.slitting1D().patterns().isEmpty())) {
                throw new IllegalArgumentException("一维分切方案缺少分切组合明细");
            }

            String mode = (cmd.materialMode() == null || cmd.materialMode().isBlank())
                    ? "VIRTUAL_ROLL"
                    : cmd.materialMode().trim().toUpperCase();
            if ("FREE_CANVAS".equals(mode)) mode = "VIRTUAL_ROLL";
            if (!Set.of("VIRTUAL_ROLL", "STOCK_ROLL", "REMNANT").contains(mode)) {
                throw new IllegalArgumentException("投料模式仅支持 VIRTUAL_ROLL、STOCK_ROLL 或 REMNANT");
            }

            // 1. 解析或自动创建所属需求族 (CuttingTask)
            String effectiveMaterialModel = resolveSchemeMaterialModelInTx(cmd, mode);
            CuttingTask task = resolveOrCreateTaskForSchemeInTx(cmd, dim, effectiveMaterialModel);

            // 2. 核算本次扣减的待排需求 (allocatedDemands) 并校验不超出 openQty
            Map<String, Integer> completedMap = inventory.completedQuantitiesInTx(task.id());
            Map<String, Integer> plannedMap = plannedQuantitiesForTaskInTx(task.id(), null);
            Map<String, Integer> allocated = new LinkedHashMap<>();
            int placedCount = 0;
            int gapFillCount = 0;
            int requestedCount = task.demands().stream().mapToInt(CuttingTask.Line::quantity).sum();

            if (!isSlit) {
                Map<Integer, Integer> rawPlacedByDemand = new LinkedHashMap<>();
                for (SchedulingScheme.PlacementItem p : cmd.layout2D().placements()) {
                    placedCount++;
                    if (Boolean.TRUE.equals(p.gapFill())) {
                        gapFillCount++;
                    } else {
                        rawPlacedByDemand.merge(p.demandId(), 1, Integer::sum);
                    }
                }
                for (Map.Entry<Integer, Integer> entry : rawPlacedByDemand.entrySet()) {
                    String lineKey = String.valueOf(entry.getKey());
                    CuttingTask.Line line = task.demands().stream().filter(l -> l.id() == entry.getKey()).findFirst()
                            .orElseThrow(() -> new IllegalArgumentException("排布裁片引用的需求行不存在: #" + entry.getKey()));
                    int open = Math.max(0, line.quantity() - completedMap.getOrDefault(lineKey, 0) - plannedMap.getOrDefault(lineKey, 0));
                    if (entry.getValue() > open) {
                        throw new InventoryConflictException("需求「" + line.name() + "」当前剩余待排量为 " + open + "，小于方案排入量 " + entry.getValue());
                    }
                    allocated.put(lineKey, entry.getValue());
                }
                // 若包含同款补片且即将直接锁实卷生成 CuttingPlan，自动在未报工任务上补充备片行，确保 100% 图纸原样落库
                if (gapFillCount > 0 && completedMap.isEmpty()) {
                    task = appendGapFillLinesIfNeededInTx(task, cmd.layout2D());
                }
            } else {
                SchedulingScheme.Slitting1DPayload slit = cmd.slitting1D();
                placedCount = slit.fulfillment().stream().mapToInt(SchedulingScheme.SlittingFulfillmentItem::produced).sum();
                for (SchedulingScheme.SlittingFulfillmentItem f : slit.fulfillment()) {
                    CuttingTask.Line line = findSlittingLine(task, f);
                    if (line == null) continue;
                    String lineKey = String.valueOf(line.id());
                    int open = Math.max(0, line.quantity() - completedMap.getOrDefault(lineKey, 0) - plannedMap.getOrDefault(lineKey, 0));
                    int deduct = Math.min(open, Math.max(0, f.produced()));
                    if (deduct > 0) {
                        allocated.put(lineKey, deduct);
                    }
                }
                if (allocated.isEmpty()) {
                    throw new InventoryConflictException("当前分切需求族已无剩余待排量可扣减");
                }
            }

            String schemeId = "SCH-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("MMddHHmm"))
                    + "-" + UUID.randomUUID().toString().substring(0, 4).toUpperCase();
            String nowStr = LocalDateTime.now().format(TS_FMT);
            double occupiedLen = isSlit
                    ? (double) cmd.slitting1D().totalCars() * cmd.slitting1D().fixedLengthMm()
                    : Math.max(1, cmd.occupiedLengthMm());

            SchedulingScheme.SuggestedRollSpec suggestedRoll = new SchedulingScheme.SuggestedRollSpec(
                    task.materialModel(),
                    cmd.widthMm(),
                    Math.ceil(occupiedLen + Math.max(0, cmd.trimStartMm())),
                    isSlit ? cmd.slitting1D().totalCars() : 1
            );

            List<String> linkedPlans = List.of();
            double startY = 0;
            String boundRollId = null;
            String boundRemnantId = null;
            String initialState = SchedulingScheme.STATE_AWAITING_ROLL;

            if ("STOCK_ROLL".equals(mode)) {
                MotherRollInfo roll = inventory.rollMap().get(cmd.rollId());
                if (roll == null) throw new IllegalArgumentException("所选在库母卷不存在: " + cmd.rollId());
                if (!"PASSED".equals(roll.getInspectionStatus())) {
                    throw new IllegalArgumentException("母卷 " + roll.getRollId() + " 尚未验布合格，请先完成跑布验疵或选用合格母卷");
                }
                MaterializationResult mat = isSlit
                        ? materialize1DPlansOnRollInTx(task, roll, cmd.slitting1D(), Boolean.TRUE.equals(cmd.avoidDefects()), cmd.windowStartY(), null)
                        : materialize2DPlanOnMaterialInTx(task, roll, null, cmd.layout2D(), cmd.widthMm(), occupiedLen, cmd.trimStartMm(), cmd.pieceGapMm(), cmd.windowStartY(), null);
                linkedPlans = mat.planIds();
                startY = mat.startY();
                occupiedLen = mat.occupiedLengthMm();
                boundRollId = roll.getRollId();
                initialState = SchedulingScheme.STATE_READY_TO_CUT;
            } else if ("REMNANT".equals(mode)) {
                if (isSlit) throw new IllegalArgumentException("一维定长分切不支持单块料头出车，请选用母卷或虚拟新母卷");
                RemnantStock rem = inventory.remnantMap().get(cmd.remnantId());
                if (rem == null || !"AVAILABLE".equals(rem.getStatus())) {
                    throw new IllegalArgumentException("所选在库料头不可用: " + cmd.remnantId());
                }
                MaterializationResult mat = materialize2DPlanOnMaterialInTx(task, null, rem, cmd.layout2D(), rem.getWidth(), rem.getLength(), cmd.trimStartMm(), cmd.pieceGapMm(), 0.0, null);
                linkedPlans = mat.planIds();
                startY = 0;
                occupiedLen = rem.getLength();
                boundRollId = rem.getSourceRollId();
                boundRemnantId = rem.getId();
                initialState = SchedulingScheme.STATE_READY_TO_CUT;
            } else {
                // VIRTUAL_ROLL: 纯几何合法性核验（不依赖库存母卷，原样保存画布方案并生成备料建议）
                if (!isSlit) {
                    validateVirtual2DGeometry(cmd.layout2D(), cmd.widthMm(), Math.max(cmd.canvasLengthMm(), occupiedLen), cmd.pieceGapMm());
                }
            }

            boolean isComplete = allocated.values().stream().mapToInt(Integer::intValue).sum()
                    + completedMap.values().stream().mapToInt(Integer::intValue).sum()
                    + plannedMap.values().stream().mapToInt(Integer::intValue).sum() >= requestedCount;

            SchedulingScheme scheme = new SchedulingScheme(
                    schemeId,
                    idemKey,
                    (cmd.title() == null || cmd.title().isBlank())
                            ? (cmd.strategyName() + " (" + Math.round(cmd.widthMm()) + "mm)")
                            : cmd.title().trim(),
                    dim,
                    cmd.scenarioId(),
                    cmd.strategyId(),
                    cmd.strategyName() == null ? "智能优化方案" : cmd.strategyName(),
                    task.id(),
                    task.name(),
                    task.externalRef(),
                    mode,
                    boundRollId,
                    boundRemnantId,
                    task.materialModel(),
                    cmd.widthMm(),
                    Math.max(cmd.canvasLengthMm(), occupiedLen),
                    startY,
                    Math.round(occupiedLen * 10.0) / 10.0,
                    cmd.trimStartMm(),
                    cmd.pieceGapMm(),
                    cmd.utilizationPct(),
                    cmd.pieceAreaM2(),
                    placedCount,
                    requestedCount,
                    gapFillCount,
                    isComplete,
                    allocated,
                    linkedPlans,
                    null,
                    initialState,
                    suggestedRoll,
                    cmd.layout2D(),
                    cmd.slitting1D(),
                    null,
                    nowStr,
                    null,
                    null,
                    null,
                    null
            );

            inventory.schemeMap().put(scheme.id(), scheme);
            Map<String, Object> response = new LinkedHashMap<>(enrichSchemeViewInTx(scheme));
            response.put("demandFamily", buildDemandFamilyViewInTx(task));
            return response;
        });
    }

    /**
     * 将虚拟新母卷方案（AWAITING_ROLL）绑定到真实在库母卷（或按建议规格一键入库新母卷并绑定）。
     */
    public Map<String, Object> bindRollToScheme(String schemeId, BindRollCommand cmd) {
        if (schemeId == null || schemeId.isBlank()) throw new IllegalArgumentException("请指定排程方案编号");
        return inventory.studioMutate("ROLL_RECEIPT_OR_UPDATE", schemeId, "UNAUTHENTICATED_LOCAL", () -> {
            SchedulingScheme scheme = inventory.schemeMap().get(schemeId);
            if (scheme == null) throw new IllegalArgumentException("排程方案不存在: " + schemeId);
            if (SchedulingScheme.STATE_READY_TO_CUT.equals(scheme.state()) && Objects.equals(scheme.rollId(), cmd != null ? cmd.rollId() : null)) {
                return enrichSchemeViewInTx(scheme);
            }
            if (!SchedulingScheme.STATE_AWAITING_ROLL.equals(scheme.state())
                    && !(SchedulingScheme.STATE_DISPATCHED_MES.equals(scheme.state()) && scheme.linkedPlanIds().isEmpty())) {
                throw new InventoryConflictException("仅未绑定实卷的虚拟母卷方案可执行绑卷，当前状态：" + scheme.state());
            }

            CuttingTask task = inventory.taskMap().get(scheme.taskId());
            if (task == null) throw new IllegalArgumentException("方案关联的需求族不存在");

            MotherRollInfo roll;
            if (cmd != null && Boolean.TRUE.equals(cmd.autoCreateRoll())) {
                String newRollId = (cmd.rollId() == null || cmd.rollId().isBlank())
                        ? "ROLL-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("MMddHHmm")) + "-" + UUID.randomUUID().toString().substring(0, 3).toUpperCase()
                        : cmd.rollId().trim();
                double minReqLen = Math.max(5000, Math.ceil(scheme.occupiedLengthMm() + scheme.trimStartMm()));
                double totalLen = (cmd.newRollLengthMm() != null && cmd.newRollLengthMm() >= minReqLen)
                        ? cmd.newRollLengthMm()
                        : Math.max(minReqLen, Math.ceil(minReqLen / 1000.0) * 1000.0 + 10000);
                MotherRollInfo fresh = new MotherRollInfo(
                        newRollId,
                        task.materialModel(),
                        "BAT-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd")),
                        "按方案备料入库",
                        task.materialModel(),
                        "标准色",
                        220.0,
                        "标准材质",
                        scheme.widthMm(),
                        totalLen,
                        (cmd.storageLocation() == null || cmd.storageLocation().isBlank()) ? "裁床线边备料区 L-01" : cmd.storageLocation().trim()
                );
                fresh.setInspectionStatus("PASSED");
                fresh.setInspector("系统备料直通合格");
                fresh.setInspectionDate(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd")));
                roll = inventory.saveRollInTx(fresh);
            } else {
                if (cmd == null || cmd.rollId() == null || cmd.rollId().isBlank()) {
                    throw new IllegalArgumentException("请选择要绑定的在库母卷编号，或勾选按建议规格自动建卷");
                }
                roll = inventory.rollMap().get(cmd.rollId().trim());
                if (roll == null) throw new IllegalArgumentException("在库母卷不存在: " + cmd.rollId());
                if (!"PASSED".equals(roll.getInspectionStatus())) {
                    throw new IllegalArgumentException("母卷 " + roll.getRollId() + " 尚未验布合格，不能直接锁卷切割");
                }
                if (Math.abs(roll.getWidth() - scheme.widthMm()) > 1.0) {
                    throw new IllegalArgumentException("所选母卷幅宽 (" + roll.getWidth() + "mm) 与方案设定门幅 (" + scheme.widthMm() + "mm) 不一致");
                }
                // 若虚拟方案需求族尚未产生任何历史报工，且品号为临时品号，自动对齐到所绑实卷的真实品号
                if (!Objects.equals(task.materialModel(), roll.getRollModel())
                        && inventory.completedQuantitiesInTx(task.id()).isEmpty()) {
                    CuttingTask aligned = new CuttingTask(
                            task.id(), task.name(), roll.getRollModel(), task.externalRef(),
                            task.revision(), task.demands(), task.process(), task.problemType(), task.slitting()
                    );
                    task = inventory.saveTaskInTx(aligned);
                }
            }

            boolean isSlit = "SLITTING_1D".equals(scheme.dimension());
            if (!isSlit && scheme.gapFillCount() > 0 && inventory.completedQuantitiesInTx(task.id()).isEmpty()) {
                task = appendGapFillLinesIfNeededInTx(task, scheme.layout2D());
            }

            MaterializationResult mat = isSlit
                    ? materialize1DPlansOnRollInTx(task, roll, scheme.slitting1D(), true, cmd != null ? cmd.windowStartY() : null, scheme.id())
                    : materialize2DPlanOnMaterialInTx(task, roll, null, scheme.layout2D(), roll.getWidth(), scheme.occupiedLengthMm(), scheme.trimStartMm(), scheme.pieceGapMm(), cmd != null ? cmd.windowStartY() : null, scheme.id());

            SchedulingScheme updated = new SchedulingScheme(
                    scheme.id(), scheme.idempotencyKey(), scheme.title(), scheme.dimension(),
                    scheme.scenarioId(), scheme.strategyId(), scheme.strategyName(),
                    task.id(), task.name(), scheme.externalOrderNo(),
                    "STOCK_ROLL", roll.getRollId(), null, task.materialModel(),
                    roll.getWidth(), scheme.canvasLengthMm(), mat.startY(), mat.occupiedLengthMm(),
                    scheme.trimStartMm(), scheme.pieceGapMm(), scheme.utilizationPct(), scheme.pieceAreaM2(),
                    scheme.placedCount(), scheme.requestedCount(), scheme.gapFillCount(), scheme.complete(),
                    scheme.allocatedDemands(), mat.planIds(), null,
                    SchedulingScheme.STATE_DISPATCHED_MES.equals(scheme.state())
                            ? SchedulingScheme.STATE_DISPATCHED_MES
                            : SchedulingScheme.STATE_READY_TO_CUT,
                    scheme.suggestedRoll(),
                    scheme.layout2D(), scheme.slitting1D(), scheme.mesWorkOrderNo(),
                    scheme.createdAt(), scheme.dispatchedAt(), scheme.completedAt(), scheme.cancelledAt(), scheme.cancelReason()
            );
            inventory.schemeMap().put(scheme.id(), updated);
            return enrichSchemeViewInTx(updated);
        });
    }

    /**
     * 一键完工记账（或 MES 实切完工核销）：
     * 原子执行底层 CuttingPlan 报工，扣减实卷长度（转为已切割区域）、登记派生余料入库、将 plannedQty 结转为 completedQty。
     */
    public Map<String, Object> completeScheme(String schemeId, CompleteSchemeCommand cmd) {
        if (schemeId == null || schemeId.isBlank()) throw new IllegalArgumentException("请指定排程方案编号");
        return inventory.studioMutate("CUT_REPORT", schemeId, "UNAUTHENTICATED_LOCAL", () -> {
            SchedulingScheme scheme = inventory.schemeMap().get(schemeId);
            if (scheme == null) throw new IllegalArgumentException("排程方案不存在: " + schemeId);
            if (SchedulingScheme.STATE_COMPLETED.equals(scheme.state())) {
                return enrichSchemeViewInTx(scheme);
            }
            if (SchedulingScheme.STATE_AWAITING_ROLL.equals(scheme.state())) {
                throw new IllegalArgumentException("该方案使用的是虚拟新母卷，请先绑定在库实卷（或一键建卷绑定）后再执行完工过账");
            }
            if (SchedulingScheme.STATE_CANCELLED.equals(scheme.state())) {
                throw new InventoryConflictException("已作废方案不能执行完工过账");
            }
            if (scheme.linkedPlanIds().isEmpty()) {
                throw new IllegalArgumentException("方案缺少已锁定的机台切割计划明细");
            }

            Set<Integer> rejectedIds = (cmd != null && cmd.rejectedPieceIds() != null)
                    ? new HashSet<>(cmd.rejectedPieceIds())
                    : Set.of();
            boolean recoverRems = cmd == null || cmd.recoverRemnants() == null || cmd.recoverRemnants();
            String remLoc = (cmd != null && cmd.remnantLocation() != null && !cmd.remnantLocation().isBlank())
                    ? cmd.remnantLocation().trim()
                    : "裁床余料架 A-01";

            Set<String> batchReported = new HashSet<>();
            List<Map<String, Object>> receiptsOut = new ArrayList<>();

            for (String planId : scheme.linkedPlanIds()) {
                CuttingPlan plan = inventory.planMap().get(planId);
                if (plan == null) throw new IllegalArgumentException("底层切割计划缺失: " + planId);
                if ("CONFIRMED".equals(plan.status()) && inventory.receiptMap().containsKey(planId)) {
                    receiptsOut.add(inventory.projectQualityInTx(inventory.receiptMap().get(planId)));
                    batchReported.add(planId);
                    continue;
                }

                boolean remnantFeed = "remnant".equalsIgnoreCase(plan.request().getFeedPortType());
                double defaultCutLen = remnantFeed ? 0 : (plan.result().getDeductLen() > 0 ? plan.result().getDeductLen() : plan.request().getRollL());
                double actualCutLen = (!remnantFeed && cmd != null && cmd.actualCutLenMm() != null && scheme.linkedPlanIds().size() == 1)
                        ? cmd.actualCutLenMm()
                        : defaultCutLen;

                List<CutReport.PieceResult> pieceResults = new ArrayList<>();
                int qualifiedCount = 0;
                for (PlacedPiece pc : plan.result().getPieces()) {
                    boolean isRejected = rejectedIds.contains(pc.getId());
                    pieceResults.add(new CutReport.PieceResult(
                            pc.getId(),
                            isRejected ? "REJECTED" : "QUALIFIED",
                            isRejected ? "实切异常判废" : ""
                    ));
                    if (!isRejected) qualifiedCount++;
                }

                List<RemnantPiece> actualRemnants = new ArrayList<>();
                if (!remnantFeed && recoverRems && plan.result().getRemnants() != null) {
                    double minW = Math.max(150, plan.request().getMinRemnantWidth());
                    double minL = Math.max(150, plan.request().getMinRemnantLength());
                    for (RemnantPiece rp : plan.result().getRemnants()) {
                        if (rp.getW() >= minW && rp.getL() >= minL && rp.getY() + rp.getL() <= actualCutLen + 0.001) {
                            actualRemnants.add(new RemnantPiece(
                                    rp.getId(), rp.getStatus(), rp.getX(), rp.getY(),
                                    rp.getW(), rp.getL(), (rp.getW() * rp.getL()) / 1_000_000.0, rp.isHasDefect()
                            ));
                        }
                    }
                }

                CutReport report = new CutReport(planId, actualCutLen, qualifiedCount, actualRemnants, remLoc, pieceResults);
                Map<String, Object> confirmed = inventory.confirmPlanInTx(report, batchReported);
                receiptsOut.add(confirmed);
                batchReported.add(planId);
            }

            SchedulingScheme completedScheme = scheme.withCompleted(LocalDateTime.now().format(TS_FMT));
            inventory.schemeMap().put(scheme.id(), completedScheme);

            Map<String, Object> out = new LinkedHashMap<>(enrichSchemeViewInTx(completedScheme));
            out.put("receipts", receiptsOut);
            CuttingTask task = inventory.taskMap().get(scheme.taskId());
            if (task != null) {
                out.put("demandFamily", buildDemandFamilyViewInTx(task));
            }
            return out;
        });
    }

    /**
     * 作废未实切的排程方案：自动取消底层未报工计划，释放实卷预占区段，并将占用的 plannedQty 退回待排需求池 openQty。
     */
    public Map<String, Object> cancelScheme(String schemeId, String reason) {
        if (schemeId == null || schemeId.isBlank()) throw new IllegalArgumentException("请指定排程方案编号");
        String why = (reason == null || reason.isBlank()) ? "排料员手动取消方案重排" : reason.trim();
        return inventory.studioMutate("DEMAND_ADJUSTMENT", schemeId, "UNAUTHENTICATED_LOCAL", () -> {
            SchedulingScheme scheme = inventory.schemeMap().get(schemeId);
            if (scheme == null) throw new IllegalArgumentException("排程方案不存在: " + schemeId);
            if (SchedulingScheme.STATE_CANCELLED.equals(scheme.state())) {
                return enrichSchemeViewInTx(scheme);
            }
            if (SchedulingScheme.STATE_COMPLETED.equals(scheme.state())) {
                throw new InventoryConflictException("已完工记账方案不可直接作废；若发现裁片不良请使用「复检补排」功能");
            }
            for (String pid : scheme.linkedPlanIds()) {
                if (inventory.receiptMap().containsKey(pid) && !"REVERSED".equals(inventory.receiptMap().get(pid).get("status"))) {
                    throw new InventoryConflictException("方案包含已实切报工记录，无法直接作废");
                }
                CuttingPlan p = inventory.planMap().get(pid);
                if (p != null && "PENDING".equals(p.status())) {
                    inventory.planMap().put(pid, p.withStatus("CANCELLED"));
                }
            }
            SchedulingScheme cancelled = scheme.withCancelled(LocalDateTime.now().format(TS_FMT), why);
            inventory.schemeMap().put(scheme.id(), cancelled);
            Map<String, Object> out = new LinkedHashMap<>(enrichSchemeViewInTx(cancelled));
            CuttingTask task = inventory.taskMap().get(scheme.taskId());
            if (task != null) {
                out.put("demandFamily", buildDemandFamilyViewInTx(task));
            }
            return out;
        });
    }

    // ==================== 4. 母卷切割与疵点空间剖面图 (Mother Roll Spatial Map) ====================

    public Map<String, Object> getMotherRollSpatialMap(String rollId) {
        return inventory.studioRead(() -> {
            MotherRollInfo roll = inventory.rollMap().get(rollId);
            if (roll == null) throw new IllegalArgumentException("母卷不存在: " + rollId);

            // 关联 scheme 索引：planId -> SchedulingScheme
            Map<String, SchedulingScheme> planToScheme = new HashMap<>();
            for (SchedulingScheme s : inventory.schemeMap().values()) {
                for (String pid : s.linkedPlanIds()) {
                    planToScheme.put(pid, s);
                }
            }

            // 1. 已切割区域 (Cut Zones) — 来自所有有效实切回执
            List<Map<String, Object>> cutZones = new ArrayList<>();
            for (Map<String, Object> rawReceipt : inventory.receiptMap().values()) {
                if ("REVERSED".equals(rawReceipt.get("status"))) continue;
                if (!"roll".equals(rawReceipt.get("feedPortType")) || !rollId.equals(rawReceipt.get("rollId"))) continue;
                Map<String, Object> projected = inventory.projectQualityInTx(rawReceipt);
                String pid = Objects.toString(rawReceipt.get("planId"), "");
                String tid = Objects.toString(rawReceipt.get("taskId"), "");
                CuttingTask task = inventory.taskMap().get(tid);
                CuttingPlan plan = inventory.planMap().get(pid);
                SchedulingScheme scheme = planToScheme.get(pid);

                double startY = rawReceipt.get("windowStartY") instanceof Number n ? n.doubleValue() : 0;
                double len = rawReceipt.get("actualCutLen") instanceof Number n ? n.doubleValue() : 0;
                double endY = startY + len;

                List<String> derivedIds = new ArrayList<>();
                if (rawReceipt.get("derivedRemnants") instanceof List<?> drs) {
                    for (Object dr : drs) {
                        if (dr instanceof Map<?, ?> m && m.get("id") != null) derivedIds.add(m.get("id").toString());
                        else if (dr instanceof RemnantStock rs) derivedIds.add(rs.getId());
                    }
                }

                Map<String, Object> zone = new LinkedHashMap<>();
                zone.put("kind", "CUT_ZONE");
                zone.put("planId", pid);
                zone.put("schemeId", scheme != null ? scheme.id() : null);
                zone.put("title", scheme != null ? scheme.title() : (task != null ? task.name() : "历史实切工位"));
                zone.put("taskId", tid);
                zone.put("taskName", task != null ? task.name() : "独立裁切");
                zone.put("startY", round1(startY));
                zone.put("lengthMm", round1(len));
                zone.put("endY", round1(endY));
                zone.put("confirmedAt", rawReceipt.get("confirmedAt"));
                zone.put("pieceCount", projected.getOrDefault("netFinishedPieceCount", rawReceipt.getOrDefault("finishedPieceCount", 0)));
                zone.put("netUtilizationPct", projected.get("netUtilization") instanceof Number u ? round2(u.doubleValue()) : 0);
                zone.put("derivedRemnantIds", derivedIds);
                zone.put("pieces", plan != null && plan.result() != null ? plan.result().getPieces() : List.of());
                cutZones.add(zone);
            }
            cutZones.sort(Comparator.comparingDouble(z -> ((Number) z.get("startY")).doubleValue()));

            // 若母卷期初即带有 usedLength > 0 且无逐笔报工覆盖 [0, usedLength]，补一段期初已耗区提示，保证视觉与账面 100% 对齐
            double maxCutEnd = cutZones.stream().mapToDouble(z -> ((Number) z.get("endY")).doubleValue()).max().orElse(0);
            if (roll.getUsedLength() > maxCutEnd + 1.0 && cutZones.isEmpty()) {
                Map<String, Object> openingCut = new LinkedHashMap<>();
                openingCut.put("kind", "OPENING_USED_ZONE");
                openingCut.put("planId", "OPENING-" + rollId);
                openingCut.put("schemeId", null);
                openingCut.put("title", "入档期初已裁切区段");
                openingCut.put("taskId", null);
                openingCut.put("taskName", "期初历史耗用");
                openingCut.put("startY", 0.0);
                openingCut.put("lengthMm", round1(roll.getUsedLength()));
                openingCut.put("endY", round1(roll.getUsedLength()));
                openingCut.put("confirmedAt", roll.getCreatedAt());
                openingCut.put("pieceCount", 0);
                openingCut.put("netUtilizationPct", null);
                openingCut.put("derivedRemnantIds", List.of());
                openingCut.put("pieces", List.of());
                cutZones.add(0, openingCut);
            }

            // 2. 排程预占区域 (Planned Zones) — 来自活跃 SchedulingScheme 或未归属 PENDING CuttingPlan
            List<Map<String, Object>> plannedZones = new ArrayList<>();
            Set<String> coveredPlanIds = new HashSet<>();
            for (SchedulingScheme s : inventory.schemeMap().values()) {
                if (!s.occupiesRoll(rollId)) continue;
                coveredPlanIds.addAll(s.linkedPlanIds());
                List<PlacedPiece> previewPieces = new ArrayList<>();
                if (!s.linkedPlanIds().isEmpty()) {
                    CuttingPlan firstPlan = inventory.planMap().get(s.linkedPlanIds().get(0));
                    if (firstPlan != null && firstPlan.result() != null && firstPlan.result().getPieces() != null) {
                        previewPieces = firstPlan.result().getPieces();
                    }
                }
                Map<String, Object> pz = new LinkedHashMap<>();
                pz.put("kind", "PLANNED_ZONE");
                pz.put("schemeId", s.id());
                pz.put("planId", s.linkedPlanIds().isEmpty() ? null : s.linkedPlanIds().get(0));
                pz.put("title", s.title());
                pz.put("taskId", s.taskId());
                pz.put("taskName", s.taskName());
                pz.put("state", s.state());
                pz.put("startY", round1(s.windowStartY()));
                pz.put("lengthMm", round1(s.occupiedLengthMm()));
                pz.put("endY", round1(s.windowStartY() + s.occupiedLengthMm()));
                pz.put("pieceCount", s.placedCount());
                pz.put("utilizationPct", s.utilizationPct());
                pz.put("pieces", previewPieces);
                plannedZones.add(pz);
            }
            for (CuttingPlan p : inventory.planMap().values()) {
                if (!"PENDING".equals(p.status()) || coveredPlanIds.contains(p.id())) continue;
                if (!"roll".equals(p.request().getFeedPortType()) || !rollId.equals(p.request().getRollId())) continue;
                double startY = p.request().getWindowStartY();
                double len = p.result().getDeductLen() > 0 ? p.result().getDeductLen() : p.request().getRollL();
                CuttingTask t = p.request().getTaskId() != null ? inventory.taskMap().get(p.request().getTaskId()) : null;
                Map<String, Object> pz = new LinkedHashMap<>();
                pz.put("kind", "PLANNED_ZONE");
                pz.put("schemeId", null);
                pz.put("planId", p.id());
                pz.put("title", t != null ? t.name() : "待报工候选工位");
                pz.put("taskId", p.request().getTaskId());
                pz.put("taskName", t != null ? t.name() : "候选工位");
                pz.put("state", "PENDING");
                pz.put("startY", round1(startY));
                pz.put("lengthMm", round1(len));
                pz.put("endY", round1(startY + len));
                pz.put("pieceCount", p.result().getPieces() != null ? p.result().getPieces().size() : 0);
                pz.put("utilizationPct", p.result().getTotalArea() > 0 ? round2(p.result().getPieceArea() / p.result().getTotalArea() * 100) : 0);
                pz.put("pieces", p.result().getPieces() != null ? p.result().getPieces() : List.of());
                plannedZones.add(pz);
            }
            plannedZones.sort(Comparator.comparingDouble(z -> ((Number) z.get("startY")).doubleValue()));

            // 3. 计算剩余可用净区段 (Clean Available Spans)
            List<double[]> occupiedIntervals = new ArrayList<>();
            if (roll.getUsedLength() > 0) {
                occupiedIntervals.add(new double[]{0, roll.getUsedLength()});
            }
            for (Map<String, Object> cz : cutZones) {
                occupiedIntervals.add(new double[]{((Number) cz.get("startY")).doubleValue(), ((Number) cz.get("endY")).doubleValue()});
            }
            for (Map<String, Object> pz : plannedZones) {
                occupiedIntervals.add(new double[]{((Number) pz.get("startY")).doubleValue(), ((Number) pz.get("endY")).doubleValue()});
            }
            occupiedIntervals.sort(Comparator.comparingDouble(a -> a[0]));

            List<Map<String, Object>> cleanSpans = new ArrayList<>();
            double cursor = roll.getUsedLength();
            for (double[] iv : occupiedIntervals) {
                if (iv[1] <= cursor + 0.1) continue;
                if (iv[0] > cursor + 1.0) {
                    cleanSpans.add(buildCleanSpan(roll, cursor, iv[0]));
                }
                cursor = Math.max(cursor, iv[1]);
            }
            if (roll.getTotalLength() > cursor + 1.0) {
                cleanSpans.add(buildCleanSpan(roll, cursor, roll.getTotalLength()));
            }

            // 4. 名下全部派生料头
            List<RemnantStock> linkedRemnants = inventory.remnantMap().values().stream()
                    .filter(rm -> rollId.equalsIgnoreCase(rm.getSourceRollId()))
                    .sorted(Comparator.comparing((RemnantStock rm) -> !"AVAILABLE".equals(rm.getStatus()))
                            .thenComparing(RemnantStock::getId))
                    .toList();

            double plannedTotalMm = plannedZones.stream().mapToDouble(z -> ((Number) z.get("lengthMm")).doubleValue()).sum();
            double netUnplannedMm = Math.max(0, roll.getCurrentRemainingLength() - plannedTotalMm);

            Map<String, Object> map = new LinkedHashMap<>();
            map.put("roll", roll);
            map.put("cutZones", cutZones);
            map.put("plannedZones", plannedZones);
            map.put("cleanSpans", cleanSpans);
            map.put("defects", roll.getDefects() != null ? roll.getDefects() : List.of());
            map.put("voidedDefects", roll.getVoidedDefects() != null ? roll.getVoidedDefects() : List.of());
            map.put("remnants", linkedRemnants);
            map.put("summary", Map.of(
                    "totalLengthMm", roll.getTotalLength(),
                    "usedLengthMm", roll.getUsedLength(),
                    "plannedLengthMm", round1(plannedTotalMm),
                    "remainingBookLengthMm", roll.getCurrentRemainingLength(),
                    "netAvailableToPlanMm", round1(netUnplannedMm),
                    "defectCount", roll.getDefects() != null ? roll.getDefects().size() : 0,
                    "availableRemnantCount", linkedRemnants.stream().filter(r -> "AVAILABLE".equals(r.getStatus())).count()
            ));
            return map;
        });
    }

    private Map<String, Object> buildCleanSpan(MotherRollInfo roll, double startY, double endY) {
        long defsInSpan = (roll.getDefects() == null ? List.<Defect>of() : roll.getDefects()).stream()
                .filter(d -> d.getY() < endY && d.getY() + d.getH() > startY)
                .count();
        Map<String, Object> span = new LinkedHashMap<>();
        span.put("startY", round1(startY));
        span.put("endY", round1(endY));
        span.put("lengthMm", round1(endY - startY));
        span.put("defectCount", defsInSpan);
        return span;
    }

    // ==================== 5. MES 协同接口 (Orders / Dispatch Package / Feedback) ====================

    public record MesOrderSyncCommand(
            String mesWorkOrderNo,
            String name,
            String materialModel,
            String dimension,
            Double widthMm,
            List<DemandLineInput> demands
    ) {}

    public record MesFeedbackCommand(
            String schemeId,
            String mesReceiptNo,
            String scannedRollId,
            Double actualCutLenMm,
            List<Integer> rejectedPieceIds,
            Boolean recoverRemnants,
            String remnantLocation
    ) {}

    public Map<String, Object> syncMesOrder(MesOrderSyncCommand cmd) {
        if (cmd == null || cmd.mesWorkOrderNo() == null || cmd.mesWorkOrderNo().isBlank()) {
            throw new IllegalArgumentException("MES 工单号 (mesWorkOrderNo) 不能为空");
        }
        String wo = cmd.mesWorkOrderNo().trim();
        CuttingTask existing = inventory.studioRead(() ->
                inventory.taskMap().values().stream()
                        .filter(t -> wo.equals(t.externalRef()))
                        .findFirst().orElse(null)
        );
        if (existing != null) {
            return getDemandFamily(existing.id());
        }
        return saveOrMergeDemandFamily(new SaveDemandFamilyCommand(
                null,
                null,
                cmd.name() == null || cmd.name().isBlank() ? ("MES工单 · " + wo) : cmd.name().trim(),
                cmd.materialModel() == null || cmd.materialModel().isBlank() ? "MES-STD" : cmd.materialModel().trim(),
                wo,
                cmd.dimension(),
                null, 0.0, 0.0, 10, 10, null,
                cmd.widthMm() != null ? cmd.widthMm().intValue() : null,
                10, 20,
                cmd.demands()
        ));
    }

    public Map<String, Object> dispatchSchemeToMes(String schemeId, String mesWorkOrderNo) {
        return inventory.studioMutate("SYSTEM_UPDATE", schemeId, "MES_DISPATCHER", () -> {
            SchedulingScheme s = inventory.schemeMap().get(schemeId);
            if (s == null) throw new IllegalArgumentException("排程方案不存在: " + schemeId);
            if (SchedulingScheme.STATE_CANCELLED.equals(s.state())) {
                throw new InventoryConflictException("已作废方案不能下发 MES");
            }
            String wo = (mesWorkOrderNo != null && !mesWorkOrderNo.isBlank())
                    ? mesWorkOrderNo.trim()
                    : (s.externalOrderNo() != null && !s.externalOrderNo().isBlank() ? s.externalOrderNo() : "WO-" + s.id());
            SchedulingScheme next = SchedulingScheme.STATE_COMPLETED.equals(s.state())
                    ? s
                    : s.withDispatched(wo, LocalDateTime.now().format(TS_FMT));
            inventory.schemeMap().put(s.id(), next);
            return buildMesDispatchPackageInTx(next);
        });
    }

    public Map<String, Object> getMesDispatchPackage(String schemeId) {
        return inventory.studioRead(() -> {
            SchedulingScheme s = inventory.schemeMap().get(schemeId);
            if (s == null) throw new IllegalArgumentException("排程方案不存在: " + schemeId);
            return buildMesDispatchPackageInTx(s);
        });
    }

    public Map<String, Object> receiveMesFeedback(MesFeedbackCommand cmd) {
        if (cmd == null || cmd.schemeId() == null || cmd.schemeId().isBlank()) {
            throw new IllegalArgumentException("请提供回传的排程方案号 schemeId");
        }
        SchedulingScheme current = inventory.studioRead(() -> inventory.schemeMap().get(cmd.schemeId()));
        if (current == null) throw new IllegalArgumentException("排程方案不存在: " + cmd.schemeId());
        if (SchedulingScheme.STATE_COMPLETED.equals(current.state())) {
            return getSchemeDetail(current.id());
        }
        if (SchedulingScheme.STATE_AWAITING_ROLL.equals(current.state()) || current.linkedPlanIds().isEmpty()) {
            if (cmd.scannedRollId() == null || cmd.scannedRollId().isBlank()) {
                throw new IllegalArgumentException("虚拟母卷方案在 MES 完工回传时必须携带机台实扫母卷条码 scannedRollId");
            }
            bindRollToScheme(current.id(), new BindRollCommand(cmd.scannedRollId().trim(), false, null, null, null));
        }
        return completeScheme(current.id(), new CompleteSchemeCommand(
                cmd.actualCutLenMm(),
                cmd.rejectedPieceIds(),
                cmd.recoverRemnants(),
                cmd.remnantLocation(),
                "MES:" + Objects.toString(cmd.mesReceiptNo(), "CALLBACK")
        ));
    }

    private Map<String, Object> buildMesDispatchPackageInTx(SchedulingScheme s) {
        Map<String, Object> pkg = new LinkedHashMap<>();
        pkg.put("packageVersion", "2.0");
        pkg.put("schemeId", s.id());
        pkg.put("mesWorkOrderNo", s.mesWorkOrderNo() != null ? s.mesWorkOrderNo() : s.externalOrderNo());
        pkg.put("state", s.state());
        pkg.put("dimension", s.dimension());
        pkg.put("strategyName", s.strategyName());
        pkg.put("taskId", s.taskId());
        pkg.put("taskName", s.taskName());
        pkg.put("materialBinding", Map.of(
                "mode", s.materialMode(),
                "materialModel", s.materialModel(),
                "rollId", Objects.toString(s.rollId(), ""),
                "remnantId", Objects.toString(s.remnantId(), ""),
                "widthMm", s.widthMm(),
                "windowStartY", s.windowStartY(),
                "occupiedLengthMm", s.occupiedLengthMm(),
                "suggestedRoll", s.suggestedRoll() != null ? s.suggestedRoll() : Map.of()
        ));
        pkg.put("metrics", Map.of(
                "utilizationPct", s.utilizationPct(),
                "pieceAreaM2", s.pieceAreaM2(),
                "placedCount", s.placedCount(),
                "requestedCount", s.requestedCount()
        ));
        pkg.put("allocatedDemands", s.allocatedDemands());
        pkg.put("layout2D", s.layout2D());
        pkg.put("slitting1D", s.slitting1D());
        pkg.put("linkedPlanIds", s.linkedPlanIds());
        return pkg;
    }

    // ==================== Internal Materialization & Helpers ====================

    private record MaterializationResult(List<String> planIds, double startY, double occupiedLengthMm) {}

    private MaterializationResult materialize2DPlanOnMaterialInTx(
            CuttingTask task,
            MotherRollInfo roll,
            RemnantStock remnant,
            SchedulingScheme.Layout2DPayload layout,
            double widthMm,
            double occupiedLengthMm,
            double trimStartMm,
            double pieceGapMm,
            Double requestedStartY,
            String selfSchemeId
    ) {
        boolean remnantMode = remnant != null;
        double maxPieceEnd = layout.placements().stream()
                .mapToDouble(p -> p.y() + (p.shape() != null ? p.shape().height() : p.l()))
                .max().orElse(occupiedLengthMm);
        double effectiveLen = remnantMode
                ? remnant.getLength()
                : Math.max(Math.ceil(Math.max(occupiedLengthMm, maxPieceEnd) * 10.0) / 10.0, trimStartMm + 10);

        double startY = 0;
        if (!remnantMode) {
            startY = requestedStartY != null && requestedStartY >= roll.getUsedLength()
                    ? requestedStartY
                    : nextAvailableRollStartInTx(roll, effectiveLen, selfSchemeId);
            if (startY + effectiveLen > roll.getTotalLength() + 0.001) {
                throw new IllegalArgumentException("母卷 " + roll.getRollId() + " 剩余连续可用长度不足（需 " + round1(effectiveLen)
                        + " mm，起切位置 Y=" + round1(startY) + " mm，总长 " + round1(roll.getTotalLength()) + " mm）");
            }
        }

        boolean isContour = task.demands().stream().anyMatch(d -> d.shape() != null);
        Map<Integer, Integer> countByDemand = new LinkedHashMap<>();
        for (SchedulingScheme.PlacementItem p : layout.placements()) {
            countByDemand.merge(p.demandId(), 1, Integer::sum);
        }

        List<PieceDemand> reqDemands = new ArrayList<>();
        for (Map.Entry<Integer, Integer> e : countByDemand.entrySet()) {
            CuttingTask.Line line = task.demands().stream().filter(d -> d.id() == e.getKey()).findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("方案裁片缺少对应任务需求行: #" + e.getKey()));
            PieceDemand pd = new PieceDemand(line.id(), line.name(), line.width(), line.length(), e.getValue(), line.allowRotation());
            pd.setShape(line.shape());
            if (line.allowHalfTurn() != null) pd.setAllowHalfTurn(line.allowHalfTurn());
            // 若方案本身对异形件应用了 180° 倒顺排，或者矩形件应用了 90° 旋转，确保校验契约同步放行该合法方向
            boolean hasHalfTurnPlacement = layout.placements().stream()
                    .anyMatch(p -> p.demandId() == line.id() && Math.abs(p.rotationDegrees()) == 180);
            boolean has90Placement = layout.placements().stream()
                    .anyMatch(p -> p.demandId() == line.id() && (Math.abs(p.rotationDegrees()) % 180 == 90));
            if (isContour && hasHalfTurnPlacement) pd.setAllowHalfTurn(true);
            if (!isContour && has90Placement) pd.setAllowRotation(true);
            reqDemands.add(pd);
        }

        // 若任务中的需求行在方案中允许了旋转但原任务行未开旋转且尚无报工，同步更新任务行旋转许可
        task = syncTaskRotationPermissionsIfNeededInTx(task, reqDemands, isContour);

        SolveRequest solveReq = new SolveRequest();
        solveReq.setTaskId(task.id());
        solveReq.setTaskRevision(task.revision());
        solveReq.setFeedPortType(remnantMode ? "remnant" : "roll");
        solveReq.setRollId(remnantMode ? remnant.getSourceRollId() : roll.getRollId());
        solveReq.setSourceRemnantId(remnantMode ? remnant.getId() : null);
        solveReq.setRollModel(task.materialModel());
        solveReq.setRollW(widthMm);
        solveReq.setRollL(effectiveLen);
        solveReq.setTotalRollL(remnantMode ? remnant.getLength() : roll.getTotalLength());
        solveReq.setWindowStartY(remnantMode ? 0 : startY);
        solveReq.setTrimStart(isContour ? 0 : trimStartMm);
        solveReq.setPieceGap(pieceGapMm);
        solveReq.setCutOrigin("left-top");
        solveReq.setFirstStageOrientation("horizontal");
        solveReq.setAllowLongitudinal(true);
        solveReq.setAllowRotation(reqDemands.stream().anyMatch(PieceDemand::isAllowRotation));
        solveReq.setMinRemnantWidth(150);
        solveReq.setMinRemnantLength(150);
        solveReq.setTimeLimitSeconds(5);
        solveReq.setDemands(reqDemands);

        inventory.prepareTaskSolveInTx(solveReq);
        // 重新应用方案级的 180° / 90° 许可（prepareTaskSolveInTx 会按任务行重置）
        for (PieceDemand pd : solveReq.getDemands()) {
            CuttingTask.Line line = task.demands().stream().filter(d -> d.id() == pd.getId()).findFirst().orElseThrow();
            if (line.allowHalfTurn() != null) pd.setAllowHalfTurn(line.allowHalfTurn());
        }
        List<Defect> rawDefs = remnantMode
                ? (remnant.getDefects() == null ? List.of() : remnant.getDefects())
                : (roll.getDefects() == null ? List.of() : roll.getDefects());
        solveReq.setDefects(CuttingWorkflowService.windowDefects(rawDefs, remnantMode ? 0 : startY, effectiveLen, widthMm));

        List<PlacedPiece> pieces = new ArrayList<>();
        Set<Integer> usedPieceIds = new HashSet<>();
        int seqId = 1;
        for (SchedulingScheme.PlacementItem p : layout.placements()) {
            CuttingTask.Line line = task.demands().stream().filter(d -> d.id() == p.demandId()).findFirst().orElseThrow();
            int pid = p.id();
            if (pid <= 0 || !usedPieceIds.add(pid)) {
                while (!usedPieceIds.add(seqId)) {
                    seqId++;
                }
                pid = seqId;
            }
            seqId = Math.max(seqId, pid + 1);
            if (isContour) {
                NestingProblem.Shape placedShape = p.shape() != null ? p.shape() : line.shape();
                PlacedPiece pp = new PlacedPiece(
                        pid, line.name(), p.x(), p.y(),
                        placedShape.width(), placedShape.height(),
                        Math.abs(p.rotationDegrees()) % 180 != 0,
                        line.id()
                );
                pp.setShape(placedShape);
                pp.setRotationDegrees(((p.rotationDegrees() % 360) + 360) % 360);
                pieces.add(pp);
            } else {
                boolean rotated = (Math.abs(p.rotationDegrees()) % 180 != 0)
                        || (Math.abs(p.w() - line.length()) < 0.01 && Math.abs(p.l() - line.width()) < 0.01 && Math.abs(line.width() - line.length()) > 0.01);
                double pw = rotated ? line.length() : line.width();
                double pl = rotated ? line.width() : line.length();
                pieces.add(new PlacedPiece(pid, line.name(), round1(p.x()), round1(p.y()), pw, pl, rotated, line.id()));
            }
        }

        SolveResponse validated = FabricSolveAdapter.adjust(solverFactory, solveReq, pieces);
        if (!validated.isSuccess() || validated.getPieces() == null || validated.getPieces().isEmpty()) {
            throw new IllegalArgumentException(validated.getMessage() != null && !validated.getMessage().isBlank()
                    ? ("实卷几何/疵点校验未通过：" + validated.getMessage())
                    : "实卷区段内存在疵点干涉或边界越界，请更换母卷或开启实卷避疵重排");
        }

        String planId = UUID.randomUUID().toString();
        validated.setPlanId(planId);
        String baseline = inventory.materialFingerprintInTx(solveReq);
        CuttingPlan savedPlan = new CuttingPlan(planId, solveReq, validated, baseline, "PENDING", LocalDateTime.now().toString());
        inventory.planMap().put(planId, inventory.jsonMapper().readValue(inventory.jsonMapper().writeValueAsBytes(savedPlan), CuttingPlan.class));

        double finalLen = remnantMode ? remnant.getLength() : (validated.getDeductLen() > 0 ? validated.getDeductLen() : effectiveLen);
        return new MaterializationResult(List.of(planId), startY, finalLen);
    }

    private MaterializationResult materialize1DPlansOnRollInTx(
            CuttingTask task,
            MotherRollInfo roll,
            SchedulingScheme.Slitting1DPayload slit,
            boolean avoidDefects,
            Double requestedStartY,
            String selfSchemeId
    ) {
        double fixedLen = slit.fixedLengthMm();
        double cursorY = requestedStartY != null && requestedStartY >= roll.getUsedLength()
                ? requestedStartY
                : nextAvailableRollStartInTx(roll, fixedLen, selfSchemeId);
        double firstStartY = -1;
        double lastEndY = cursorY;

        // Track remaining open counts per line across cars
        Map<String, Integer> completed = inventory.completedQuantitiesInTx(task.id());
        Map<Integer, Integer> remainingByLine = new LinkedHashMap<>();
        for (CuttingTask.Line line : task.demands()) {
            int rem = Math.max(0, line.quantity() - completed.getOrDefault(String.valueOf(line.id()), 0));
            remainingByLine.put(line.id(), rem);
        }

        List<String> planIds = new ArrayList<>();
        for (SchedulingScheme.SlittingPatternItem pat : slit.patterns()) {
            int carLen = pat.lengthMm() > 0 ? pat.lengthMm() : (int) fixedLen;
            for (int rep = 0; rep < pat.repetitions(); rep++) {
                // Map stations to demand lines
                List<PlacedPiece> carPieces = new ArrayList<>();
                Map<Integer, Integer> carDemandCounts = new LinkedHashMap<>();
                double xCursor = slit.leftTrimMm();
                int pieceSeq = 1;

                for (SchedulingScheme.StationItem st : pat.stations()) {
                    for (int k = 0; k < st.countPerRepetition(); k++) {
                        CuttingTask.Line chosen = pickBestLineForWidth(task.demands(), st.widthMm(), remainingByLine);
                        if (chosen == null) continue;
                        int remBefore = remainingByLine.getOrDefault(chosen.id(), 0);
                        if (remBefore <= 0) continue; // 不把超出任务总订单量的超产条塞进严格校验的任务报工行
                        remainingByLine.put(chosen.id(), remBefore - 1);
                        carDemandCounts.merge(chosen.id(), 1, Integer::sum);
                        carPieces.add(new PlacedPiece(pieceSeq++, chosen.name(), xCursor, 0, chosen.width(), carLen, false, chosen.id()));
                        xCursor += chosen.width();
                    }
                }
                if (carPieces.isEmpty()) continue;

                double carStart = avoidDefects
                        ? findDefectFreeCarStart(roll, cursorY, carLen, carPieces)
                        : cursorY;
                if (carStart + carLen > roll.getTotalLength() + 0.001) {
                    if (planIds.isEmpty()) {
                        throw new IllegalArgumentException("母卷 " + roll.getRollId() + " 剩余长度不足以排入第 1 车（每车 " + carLen + "mm）");
                    }
                    break;
                }

                List<PieceDemand> reqDemands = new ArrayList<>();
                for (Map.Entry<Integer, Integer> entry : carDemandCounts.entrySet()) {
                    CuttingTask.Line line = task.demands().stream().filter(d -> d.id() == entry.getKey()).findFirst().orElseThrow();
                    reqDemands.add(new PieceDemand(line.id(), line.name(), line.width(), carLen, entry.getValue(), false));
                }

                SolveRequest req = new SolveRequest();
                req.setTaskId(task.id());
                req.setTaskRevision(task.revision());
                req.setFeedPortType("roll");
                req.setRollId(roll.getRollId());
                req.setRollModel(task.materialModel());
                req.setRollW(roll.getWidth());
                req.setRollL(carLen);
                req.setTotalRollL(roll.getTotalLength());
                req.setWindowStartY(carStart);
                req.setTrimStart(0);
                req.setPieceGap(0);
                req.setCutOrigin("left-top");
                req.setFirstStageOrientation("vertical");
                req.setAllowLongitudinal(true);
                req.setAllowRotation(false);
                req.setMinRemnantWidth(150);
                req.setMinRemnantLength(150);
                req.setTimeLimitSeconds(5);
                req.setDemands(reqDemands);

                inventory.prepareTaskSolveInTx(req);
                req.setDefects(CuttingWorkflowService.windowDefects(
                        roll.getDefects() == null ? List.of() : roll.getDefects(),
                        carStart, carLen, roll.getWidth()
                ));

                SolveResponse validated = FabricSolveAdapter.adjust(solverFactory, req, carPieces);
                if (!validated.isSuccess() || validated.getPieces().isEmpty()) {
                    throw new IllegalArgumentException("分切车次在母卷 Y=" + round1(carStart) + "mm 处未通过几何/疵点校验：" + Objects.toString(validated.getMessage(), ""));
                }
                String pid = UUID.randomUUID().toString();
                validated.setPlanId(pid);
                String baseline = inventory.materialFingerprintInTx(req);
                CuttingPlan cp = new CuttingPlan(pid, req, validated, baseline, "PENDING", LocalDateTime.now().toString());
                inventory.planMap().put(pid, inventory.jsonMapper().readValue(inventory.jsonMapper().writeValueAsBytes(cp), CuttingPlan.class));
                planIds.add(pid);

                if (firstStartY < 0) firstStartY = carStart;
                lastEndY = carStart + carLen;
                cursorY = lastEndY;
            }
        }

        if (planIds.isEmpty()) {
            throw new IllegalArgumentException("未能生成任何有效分切出车计划，请检查订单剩余量与母卷余长");
        }
        return new MaterializationResult(planIds, firstStartY, lastEndY - firstStartY);
    }

    private double findDefectFreeCarStart(MotherRollInfo roll, double fromY, double carLen, List<PlacedPiece> strips) {
        double y = fromY;
        List<Defect> defs = roll.getDefects() == null ? List.of() : roll.getDefects();
        for (int guard = 0; guard < 200 && y + carLen <= roll.getTotalLength(); guard++) {
            double candidateY = y;
            Defect hit = defs.stream().filter(d -> {
                double m = d.getMargin();
                double dx0 = Math.max(0, d.getX() - m), dx1 = Math.min(roll.getWidth(), d.getX() + d.getW() + m);
                double dy0 = Math.max(0, d.getY() - m), dy1 = Math.min(roll.getTotalLength(), d.getY() + d.getH() + m);
                if (dy1 <= candidateY + 0.001 || dy0 >= candidateY + carLen - 0.001) return false;
                return strips.stream().anyMatch(s -> s.getX() + s.getW() > dx0 + 0.001 && s.getX() < dx1 - 0.001);
            }).findFirst().orElse(null);
            if (hit == null) return candidateY;
            y = Math.max(y + 10, hit.getY() + hit.getH() + hit.getMargin());
        }
        return y;
    }

    private double nextAvailableRollStartInTx(MotherRollInfo roll, double neededLen, String exceptSchemeId) {
        List<double[]> intervals = new ArrayList<>();
        if (roll.getUsedLength() > 0) intervals.add(new double[]{0, roll.getUsedLength()});
        for (Map<String, Object> r : inventory.receiptMap().values()) {
            if (!"REVERSED".equals(r.get("status")) && "roll".equals(r.get("feedPortType")) && roll.getRollId().equals(r.get("rollId"))) {
                double s = ((Number) r.get("windowStartY")).doubleValue();
                double l = ((Number) r.get("actualCutLen")).doubleValue();
                intervals.add(new double[]{s, s + l});
            }
        }
        for (SchedulingScheme sc : inventory.schemeMap().values()) {
            if (!Objects.equals(exceptSchemeId, sc.id()) && sc.occupiesRoll(roll.getRollId())) {
                intervals.add(new double[]{sc.windowStartY(), sc.windowStartY() + sc.occupiedLengthMm()});
            }
        }
        intervals.sort(Comparator.comparingDouble(a -> a[0]));
        double cursor = roll.getUsedLength();
        for (double[] iv : intervals) {
            if (iv[1] <= cursor + 0.001) continue;
            if (iv[0] - cursor >= neededLen - 0.001) return cursor;
            cursor = Math.max(cursor, iv[1]);
        }
        return cursor;
    }

    private void validateVirtual2DGeometry(SchedulingScheme.Layout2DPayload layout, double widthMm, double heightMm, double gapMm) {
        if (widthMm <= 0 || heightMm <= 0) throw new IllegalArgumentException("画布门幅与长度必须为正数");
        for (SchedulingScheme.PlacementItem p : layout.placements()) {
            double pw = p.shape() != null ? p.shape().width() : p.w();
            double ph = p.shape() != null ? p.shape().height() : p.l();
            if (p.x() < -0.5 || p.y() < -0.5 || p.x() + pw > widthMm + 1.0 || p.y() + ph > heightMm + 1.0) {
                throw new IllegalArgumentException("裁片「" + p.name() + "」超出虚拟母卷画布边界");
            }
            if (p.shape() != null && "POLYGON".equals(p.shape().type())) {
                PolygonGeometry.validate(p.shape());
            }
        }
        voidGapRef(gapMm);
    }

    private static void voidGapRef(double ignored) {}

    private String resolveSchemeMaterialModelInTx(ConfirmSchemeCommand cmd, String mode) {
        if ("STOCK_ROLL".equals(mode) && cmd.rollId() != null) {
            MotherRollInfo roll = inventory.rollMap().get(cmd.rollId());
            if (roll != null && roll.getRollModel() != null && !roll.getRollModel().isBlank()) {
                return roll.getRollModel();
            }
        }
        if ("REMNANT".equals(mode) && cmd.remnantId() != null) {
            RemnantStock rem = inventory.remnantMap().get(cmd.remnantId());
            if (rem != null && rem.getMaterialBatch() != null && !rem.getMaterialBatch().isBlank()) {
                return rem.getMaterialBatch();
            }
        }
        if (cmd.materialModel() != null && !cmd.materialModel().isBlank()) {
            return cmd.materialModel().trim();
        }
        return "VIRTUAL-" + Math.round(cmd.widthMm());
    }

    private CuttingTask resolveOrCreateTaskForSchemeInTx(ConfirmSchemeCommand cmd, String dim, String effectiveModel) {
        if (cmd.taskId() != null && !cmd.taskId().isBlank()) {
            CuttingTask existing = inventory.taskMap().get(cmd.taskId().trim());
            if (existing == null) throw new IllegalArgumentException("关联的需求族不存在: " + cmd.taskId());
            if (!Objects.equals(existing.materialModel(), effectiveModel)
                    && ("STOCK_ROLL".equalsIgnoreCase(cmd.materialMode()) || "REMNANT".equalsIgnoreCase(cmd.materialMode()))
                    && inventory.completedQuantitiesInTx(existing.id()).isEmpty()) {
                CuttingTask aligned = new CuttingTask(
                        existing.id(), existing.name(), effectiveModel, existing.externalRef(),
                        existing.revision(), existing.demands(), existing.process(), existing.problemType(), existing.slitting()
                );
                return inventory.saveTaskInTx(aligned);
            }
            return existing;
        }
        if (cmd.demands() == null || cmd.demands().isEmpty()) {
            throw new IllegalArgumentException("请提供本次排程的需求明细或指定已有需求族编号");
        }
        SchedulingScheme.Slitting1DPayload slit = cmd.slitting1D();
        return saveOrMergeTaskInTx(new SaveDemandFamilyCommand(
                null,
                null,
                cmd.taskName() != null && !cmd.taskName().isBlank()
                        ? cmd.taskName().trim()
                        : ("排程需求 · " + (cmd.title() != null ? cmd.title() : LocalDateTime.now().format(DateTimeFormatter.ofPattern("MMdd-HHmm")))),
                effectiveModel,
                cmd.externalOrderNo(),
                dim,
                Math.max(500, cmd.occupiedLengthMm() + cmd.trimStartMm()),
                cmd.trimStartMm(),
                cmd.pieceGapMm(),
                slit != null ? slit.leftTrimMm() : 10,
                slit != null ? slit.rightTrimMm() : 10,
                slit != null ? slit.minWidthMm() : null,
                slit != null ? slit.maxWidthMm() : (int) Math.round(cmd.widthMm()),
                slit != null ? slit.widthStepMm() : 10,
                slit != null ? slit.totalOverCap() : 20,
                cmd.demands()
        ));
    }

    private CuttingTask appendGapFillLinesIfNeededInTx(CuttingTask task, SchedulingScheme.Layout2DPayload layout) {
        if (layout == null) return task;
        Map<Integer, Long> totalPlacedByDemand = layout.placements().stream()
                .collect(Collectors.groupingBy(SchedulingScheme.PlacementItem::demandId, Collectors.counting()));
        List<CuttingTask.Line> nextLines = new ArrayList<>(task.demands());
        boolean changed = false;
        for (int i = 0; i < nextLines.size(); i++) {
            CuttingTask.Line line = nextLines.get(i);
            long needed = totalPlacedByDemand.getOrDefault(line.id(), 0L);
            if (needed > line.quantity()) {
                nextLines.set(i, new CuttingTask.Line(
                        line.id(), line.name(), line.width(), line.length(),
                        (int) needed, line.allowRotation(), line.shape(),
                        line.allowHalfTurn(), line.sizeLabel(), line.sourceTemplateId(), line.surfaceTreatment()
                ));
                changed = true;
            }
        }
        if (!changed) return task;
        return inventory.saveTaskInTx(new CuttingTask(
                task.id(), task.name(), task.materialModel(), task.externalRef(),
                task.revision(), nextLines, task.process(), task.problemType(), task.slitting()
        ));
    }

    private CuttingTask syncTaskRotationPermissionsIfNeededInTx(CuttingTask task, List<PieceDemand> reqDemands, boolean isContour) {
        if (!inventory.completedQuantitiesInTx(task.id()).isEmpty()) return task;
        Map<Integer, PieceDemand> map = reqDemands.stream().collect(Collectors.toMap(PieceDemand::getId, d -> d, (a, b) -> a));
        List<CuttingTask.Line> updatedLines = new ArrayList<>();
        boolean changed = false;
        for (CuttingTask.Line line : task.demands()) {
            PieceDemand pd = map.get(line.id());
            boolean nextRot = line.allowRotation() || (!isContour && pd != null && pd.isAllowRotation());
            Boolean nextHalf = (Boolean.TRUE.equals(line.allowHalfTurn()) || (isContour && pd != null && Boolean.TRUE.equals(pd.getAllowHalfTurn())))
                    ? Boolean.TRUE : null;
            if (nextRot != line.allowRotation() || !Objects.equals(nextHalf, line.allowHalfTurn())) {
                changed = true;
                updatedLines.add(new CuttingTask.Line(
                        line.id(), line.name(), line.width(), line.length(), line.quantity(),
                        nextRot, line.shape(), nextHalf, line.sizeLabel(), line.sourceTemplateId(), line.surfaceTreatment()
                ));
            } else {
                updatedLines.add(line);
            }
        }
        if (!changed) return task;
        return inventory.saveTaskInTx(new CuttingTask(
                task.id(), task.name(), task.materialModel(), task.externalRef(),
                task.revision(), updatedLines, task.process(), task.problemType(), task.slitting()
        ));
    }

    private Map<String, Object> enrichSchemeViewInTx(SchedulingScheme s) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("scheme", s);
        MotherRollInfo roll = s.rollId() != null ? inventory.rollMap().get(s.rollId()) : null;
        if (roll != null) {
            map.put("rollInfo", Map.of(
                    "rollId", roll.getRollId(),
                    "rollModel", roll.getRollModel(),
                    "width", roll.getWidth(),
                    "totalLength", roll.getTotalLength(),
                    "usedLength", roll.getUsedLength(),
                    "remainingLength", roll.getCurrentRemainingLength(),
                    "storageLocation", Objects.toString(roll.getStorageLocation(), ""),
                    "defectCount", roll.getDefects() != null ? roll.getDefects().size() : 0
            ));
        }
        List<Map<String, Object>> planReceipts = new ArrayList<>();
        for (String pid : s.linkedPlanIds()) {
            Map<String, Object> r = inventory.receiptMap().get(pid);
            if (r != null && !"REVERSED".equals(r.get("status"))) {
                planReceipts.add(inventory.projectQualityInTx(r));
            }
        }
        map.put("receipts", planReceipts);
        boolean needsRoll = SchedulingScheme.STATE_AWAITING_ROLL.equals(s.state())
                || (SchedulingScheme.STATE_DISPATCHED_MES.equals(s.state()) && s.linkedPlanIds().isEmpty());
        map.put("canBindRoll", needsRoll);
        map.put("canComplete", !needsRoll && (SchedulingScheme.STATE_READY_TO_CUT.equals(s.state()) || SchedulingScheme.STATE_DISPATCHED_MES.equals(s.state())));
        map.put("canCancel", s.occupiesDemand() && planReceipts.isEmpty());
        return map;
    }

    private static CuttingTask.Line findSlittingLine(CuttingTask task, SchedulingScheme.SlittingFulfillmentItem f) {
        if (f.orderId() != null) {
            for (CuttingTask.Line l : task.demands()) {
                if (String.valueOf(l.id()).equals(f.orderId().trim())) return l;
            }
        }
        return task.demands().stream()
                .filter(l -> Math.abs(l.width() - f.widthMm()) < 0.5)
                .findFirst().orElse(null);
    }

    private static CuttingTask.Line pickBestLineForWidth(List<CuttingTask.Line> lines, int widthMm, Map<Integer, Integer> remaining) {
        return lines.stream()
                .filter(l -> Math.abs(l.width() - widthMm) < 0.5)
                .max(Comparator.comparingInt(l -> remaining.getOrDefault(l.id(), 0)))
                .orElse(null);
    }

    private static NestingProblem.Shape normalizeLineShape(DemandLineInput in, boolean isSlit, boolean taskHasPolygon) {
        if (isSlit) return null;
        if (in.shape() != null && "POLYGON".equals(in.shape().type()) && in.shape().vertices() != null && in.shape().vertices().size() >= 3) {
            List<NestingProblem.Point> pts = in.shape().vertices();
            double minX = pts.stream().mapToDouble(NestingProblem.Point::x).min().orElse(0);
            double minY = pts.stream().mapToDouble(NestingProblem.Point::y).min().orElse(0);
            double maxX = pts.stream().mapToDouble(NestingProblem.Point::x).max().orElse(in.width());
            double maxY = pts.stream().mapToDouble(NestingProblem.Point::y).max().orElse(in.length());
            List<NestingProblem.Point> shifted = pts.stream()
                    .map(pt -> new NestingProblem.Point(round1(pt.x() - minX), round1(pt.y() - minY)))
                    .toList();
            return new NestingProblem.Shape("POLYGON", round1(maxX - minX), round1(maxY - minY), shifted);
        }
        if (taskHasPolygon) {
            double w = round1(in.width());
            double h = round1(in.length());
            return new NestingProblem.Shape("POLYGON", w, h, List.of(
                    new NestingProblem.Point(0, 0),
                    new NestingProblem.Point(w, 0),
                    new NestingProblem.Point(w, h),
                    new NestingProblem.Point(0, h)
            ));
        }
        return null;
    }

    private static boolean containsLineId(List<CuttingTask.Line> lines, int id) {
        return lines.stream().anyMatch(l -> l.id() == id);
    }

    private static int findMergeableLineIndex(
            List<CuttingTask.Line> lines, String name, double w, double l,
            NestingProblem.Shape shape, boolean allowRot, Boolean allowHalf
    ) {
        for (int i = 0; i < lines.size(); i++) {
            CuttingTask.Line cur = lines.get(i);
            if (Objects.equals(cur.name(), name != null ? name.trim() : "")
                    && Math.abs(cur.width() - w) < 0.01
                    && Math.abs(cur.length() - l) < 0.01
                    && Objects.equals(cur.shape(), shape)
                    && cur.allowRotation() == allowRot
                    && Objects.equals(cur.allowHalfTurn(), allowHalf)) {
                return i;
            }
        }
        return -1;
    }

    private static String inferTaskDimension(CuttingTask task) {
        if (task.slittingTask()) return "SLITTING_1D";
        boolean hasPoly = task.demands().stream().anyMatch(d -> d.shape() != null && "POLYGON".equals(d.shape().type()));
        return hasPoly ? "CONTOUR_2D" : "RECT_2D";
    }

    private static String normalizeDimension(String dim, String category) {
        if ("SLITTING_1D".equalsIgnoreCase(dim) || "1D".equalsIgnoreCase(dim) || "SLITTING_1D".equalsIgnoreCase(category)) {
            return "SLITTING_1D";
        }
        if ("CONTOUR_2D".equalsIgnoreCase(dim) || "DXF_GARMENT".equalsIgnoreCase(category)) {
            return "CONTOUR_2D";
        }
        if ("RECT_2D".equalsIgnoreCase(dim) || "CURTAIN_2D".equalsIgnoreCase(category) || "BOARD_2D".equalsIgnoreCase(category)) {
            return "RECT_2D";
        }
        return "RECT_2D";
    }

    private static String defaultCategoryForDimension(String dim) {
        return switch (dim) {
            case "SLITTING_1D" -> "SLITTING_1D";
            case "CONTOUR_2D" -> "DXF_GARMENT";
            default -> "CURTAIN_2D";
        };
    }

    private static String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s.trim();
    }

    private static double round1(double v) {
        return Math.rint(v * 10.0) / 10.0;
    }

    private static double round2(double v) {
        return Math.rint(v * 100.0) / 100.0;
    }
}
