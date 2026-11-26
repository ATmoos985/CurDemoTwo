package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.DemandTemplate;
import com.example.cutdemotwo.business.model.ExecutionOrder;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;

/**
 * 排程工作室需求模板库与多维待排需求池协作者：
 * 仅通过 {@link CuttingStatePort} 进行受控事务读写，不接触底层可变状态容器。
 */
final class StudioDemandPoolService {
    private static final DateTimeFormatter TS_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private final CuttingStatePort statePort;

    StudioDemandPoolService(CuttingStatePort statePort) {
        this.statePort = statePort;
    }

    // ==================== 1. 需求模板库 ====================

    List<DemandTemplate> listTemplates() {
        List<DemandTemplate> list = new ArrayList<>(statePort.listTemplatesIndependent());
        list.sort(Comparator.comparing((DemandTemplate t) -> Objects.toString(t.updatedAt(), "")).reversed());
        return list;
    }

    DemandTemplate saveTemplate(DemandTemplate input) {
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
        return statePort.saveTemplateIndependent(normalized);
    }

    Map<String, Object> deleteTemplate(String id) {
        if (id == null || id.isBlank()) throw new IllegalArgumentException("请指定模板编号");
        String trimmed = id.trim();
        boolean deleted = statePort.deleteTemplateIndependent(trimmed);
        return Map.of("deleted", deleted, "id", trimmed);
    }

    // ==================== 2. 多维待排需求池 ====================

    List<Map<String, Object>> listDemandPool() {
        return statePort.inRead(tx -> {
            List<Map<String, Object>> out = new ArrayList<>();
            List<CuttingTask> tasks = new ArrayList<>(tx.listTasks());
            Collections.reverse(tasks);
            for (CuttingTask task : tasks) {
                out.add(buildDemandFamilyView(tx, task));
            }
            return out;
        });
    }

    Map<String, Object> getDemandFamily(String taskId) {
        return statePort.inRead(tx -> {
            CuttingTask task = tx.findTask(taskId)
                    .orElseThrow(() -> new IllegalArgumentException("需求族不存在: " + taskId));
            return buildDemandFamilyView(tx, task);
        });
    }

    Map<String, Object> saveOrMergeDemandFamily(StudioCommandContracts.SaveDemandFamilyInput cmd) {
        if (cmd == null || cmd.demands() == null || cmd.demands().isEmpty()) {
            throw new IllegalArgumentException("请至少提供 1 项有效需求明细");
        }
        return statePort.inWrite("DEMAND_ADJUSTMENT", cmd.mergeIntoTaskId() != null ? cmd.mergeIntoTaskId() : cmd.id(),
                "UNAUTHENTICATED_LOCAL", tx -> {
            CuttingTask saved = saveOrMergeTask(tx, cmd);
            return buildDemandFamilyView(tx, saved);
        });
    }

    CuttingTask saveOrMergeTask(CuttingStatePort.WriteTx tx, StudioCommandContracts.SaveDemandFamilyInput cmd) {
        String targetId = (cmd.mergeIntoTaskId() != null && !cmd.mergeIntoTaskId().isBlank())
                ? cmd.mergeIntoTaskId().trim()
                : (cmd.id() != null && !cmd.id().isBlank() ? cmd.id().trim() : null);
        CuttingTask existing = targetId != null ? tx.findTask(targetId).orElse(null) : null;
        boolean merging = cmd.mergeIntoTaskId() != null && !cmd.mergeIntoTaskId().isBlank() && existing != null;

        String dim = normalizeDimension(cmd.dimension(), null);
        if (existing != null) {
            dim = inferTaskDimension(existing);
        } else if (cmd.demands().stream().anyMatch(d -> d != null && d.shape() != null
                && ("POLYGON".equals(d.shape().type()) || d.shape().hasHoles()))) {
            dim = "CONTOUR_2D";
        }
        boolean isSlit = "SLITTING_1D".equals(dim);
        boolean hasPoly = "CONTOUR_2D".equals(dim)
                || cmd.demands().stream().anyMatch(d -> d != null && d.shape() != null
                && ("POLYGON".equals(d.shape().type()) || d.shape().hasHoles()));

        List<CuttingTask.Line> lines = new ArrayList<>();
        int nextLineId = 1;
        if (merging) {
            lines.addAll(existing.demands());
            nextLineId = lines.stream().mapToInt(CuttingTask.Line::id).max().orElse(0) + 1;
        }

        for (StudioCommandContracts.DemandLineView in : cmd.demands()) {
            if (in == null || in.quantity() <= 0) continue;
            int lineId = (!merging && in.id() != null && in.id() > 0) ? in.id() : nextLineId++;
            while (containsLineId(lines, lineId)) lineId = nextLineId++;

            NestingProblem.Shape shape = normalizeLineShape(in, isSlit, hasPoly);
            double w = shape != null ? shape.width() : (isSlit ? Math.rint(in.width()) : in.width());
            double l = shape != null ? shape.height() : (isSlit ? Math.rint(in.length()) : in.length());
            boolean allowRot = !isSlit && !hasPoly && Boolean.TRUE.equals(in.allowRotation());
            Boolean allowHalf = (!isSlit && hasPoly && Boolean.TRUE.equals(in.allowHalfTurn())) ? Boolean.TRUE : null;

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

        String dueDate = cmd.dueDate() != null ? blankToNull(cmd.dueDate()) : (existing != null ? existing.dueDate() : null);
        String priority = cmd.priority() != null ? blankToNull(cmd.priority()) : (existing != null ? existing.priority() : null);
        String customerName = cmd.customerName() != null ? blankToNull(cmd.customerName()) : (existing != null ? existing.customerName() : null);
        String kittingGroup = cmd.kittingGroup() != null ? blankToNull(cmd.kittingGroup()) : (existing != null ? existing.kittingGroup() : null);
        String requiredBatchNo = cmd.requiredBatchNo() != null ? blankToNull(cmd.requiredBatchNo()) : (existing != null ? existing.requiredBatchNo() : null);
        String requiredColor = cmd.requiredColor() != null ? blankToNull(cmd.requiredColor()) : (existing != null ? existing.requiredColor() : null);
        Boolean strictBatchMatch = cmd.strictBatchMatch() != null ? cmd.strictBatchMatch() : (existing != null ? existing.strictBatchMatch() : null);
        String machineId = cmd.machineId() != null ? blankToNull(cmd.machineId()) : (existing != null ? existing.machineId() : null);
        String shiftTeam = cmd.shiftTeam() != null ? blankToNull(cmd.shiftTeam()) : (existing != null ? existing.shiftTeam() : null);

        CuttingTask payload = new CuttingTask(
                existing != null ? existing.id() : null,
                name,
                model,
                extRef,
                existing != null ? existing.revision() : 0,
                lines,
                proc,
                isSlit ? CuttingTask.SLITTING_1D : null,
                slit,
                dueDate,
                priority,
                customerName,
                kittingGroup,
                requiredBatchNo,
                requiredColor,
                strictBatchMatch,
                machineId,
                shiftTeam,
                existing != null ? existing.sourceSchemeId() : null,
                existing != null ? existing.replenishIdempotencyKey() : null
        );
        return tx.saveTask(payload);
    }

    Map<String, Object> buildDemandFamilyView(CuttingStatePort.ReadView tx, CuttingTask task) {
        Map<String, Integer> completedMap = tx.completedQuantities(task.id());
        Map<String, Integer> plannedMap = plannedQuantitiesForTask(tx, task.id(), null);
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

        long activeSchemes = tx.listSchemes().stream()
                .filter(s -> s.involvesTask(task.id())
                        && !SchedulingScheme.STATE_CANCELLED.equals(s.state())
                        && !SchedulingScheme.STATE_REVERSED.equals(s.state()))
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
        view.put("dueDate", task.dueDate());
        view.put("priority", task.priority() != null ? task.priority() : CuttingTask.PRIORITY_NORMAL);
        view.put("customerName", task.customerName());
        view.put("kittingGroup", task.kittingGroup());
        view.put("requiredBatchNo", task.requiredBatchNo());
        view.put("requiredColor", task.requiredColor());
        view.put("strictBatchMatch", Boolean.TRUE.equals(task.strictBatchMatch()));
        view.put("machineId", task.machineId());
        view.put("shiftTeam", task.shiftTeam());
        if (task.sourceSchemeId() != null) {
            view.put("sourceSchemeId", task.sourceSchemeId());
        }
        view.put("lines", lineViews);
        return view;
    }

    /**
     * 计算任务内各需求行当前的「已排预占量 (plannedQty)」：
     * 合并活跃的 SchedulingScheme 预占（兼容单任务与跨任务多族合排 sourceAllocations）
     * 与独立未归属方案的 ExecutionOrder 预约，且扣除已报工确认的方案，绝不重复扣减。
     */
    Map<String, Integer> plannedQuantitiesForTask(CuttingStatePort.ReadView tx, String taskId, String exceptSchemeId) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        Set<String> coveredPlans = new HashSet<>();

        for (SchedulingScheme s : tx.listSchemes()) {
            if (Objects.equals(exceptSchemeId, s.id()) || !s.occupiesDemand() || !s.involvesTask(taskId)) {
                continue;
            }
            coveredPlans.addAll(s.linkedPlanIds());
            Map<String, Integer> alreadyReportedInScheme = new HashMap<>();
            for (String pid : s.linkedPlanIds()) {
                Map<String, Object> rec = tx.findReceipt(pid).orElse(null);
                if (rec == null || "REVERSED".equals(rec.get("status"))) continue;
                if (rec.get("taskDemandQuantities") instanceof Map<?, ?> multi) {
                    if (multi.get(taskId) instanceof Map<?, ?> taskDq) {
                        taskDq.forEach((k, v) -> alreadyReportedInScheme.merge(String.valueOf(k), ((Number) v).intValue(), Integer::sum));
                    }
                } else if (Objects.equals(taskId, rec.get("taskId"))
                        && rec.get("demandQuantities") instanceof Map<?, ?> dq) {
                    dq.forEach((k, v) -> alreadyReportedInScheme.merge(String.valueOf(k), ((Number) v).intValue(), Integer::sum));
                }
            }
            for (SchedulingScheme.TaskDemandAllocation alloc : s.effectiveAllocations()) {
                if (!Objects.equals(taskId, alloc.taskId())) continue;
                String lineKey = String.valueOf(alloc.lineId());
                int netPlanned = Math.max(0, alloc.quantity() - alreadyReportedInScheme.getOrDefault(lineKey, 0));
                if (netPlanned > 0) {
                    counts.merge(lineKey, netPlanned, Integer::sum);
                }
            }
        }

        long now = tx.operationTime();
        for (ExecutionOrder e : tx.listExecutions()) {
            if (taskId.equals(e.taskId()) && !coveredPlans.contains(e.planId()) && e.reserves(now)) {
                e.demandQuantities().forEach((lineId, qty) -> counts.merge(lineId, qty, Integer::sum));
            }
        }
        return counts;
    }

    // ==================== 规范化辅助 ====================

    static NestingProblem.Shape normalizeLineShape(StudioCommandContracts.DemandLineView in, boolean isSlit, boolean taskHasPolygon) {
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
            List<List<NestingProblem.Point>> shiftedHoles = List.of();
            if (in.shape().holes() != null && !in.shape().holes().isEmpty()) {
                List<List<NestingProblem.Point>> normalizedHoles = new ArrayList<>(in.shape().holes().size());
                for (List<NestingProblem.Point> hole : in.shape().holes()) {
                    if (hole == null || hole.size() < 3) continue;
                    normalizedHoles.add(hole.stream()
                            .map(pt -> new NestingProblem.Point(round1(pt.x() - minX), round1(pt.y() - minY)))
                            .toList());
                }
                shiftedHoles = normalizedHoles;
            }
            return new NestingProblem.Shape("POLYGON", round1(maxX - minX), round1(maxY - minY), shifted, shiftedHoles);
        }
        if (in.shape() != null && in.shape().hasHoles()) {
            double w = round1(in.shape().width() > 0 ? in.shape().width() : in.width());
            double h = round1(in.shape().height() > 0 ? in.shape().height() : in.length());
            List<List<NestingProblem.Point>> normalizedHoles = new ArrayList<>(in.shape().holes().size());
            for (List<NestingProblem.Point> hole : in.shape().holes()) {
                if (hole == null || hole.size() < 3) continue;
                normalizedHoles.add(hole.stream()
                        .map(pt -> new NestingProblem.Point(round1(pt.x()), round1(pt.y())))
                        .toList());
            }
            return new NestingProblem.Shape("POLYGON", w, h, List.of(
                    new NestingProblem.Point(0, 0),
                    new NestingProblem.Point(w, 0),
                    new NestingProblem.Point(w, h),
                    new NestingProblem.Point(0, h)
            ), normalizedHoles);
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

    static String inferTaskDimension(CuttingTask task) {
        if (task.slittingTask()) return "SLITTING_1D";
        boolean hasPoly = task.demands().stream().anyMatch(d -> d.shape() != null && "POLYGON".equals(d.shape().type()));
        return hasPoly ? "CONTOUR_2D" : "RECT_2D";
    }

    static String normalizeDimension(String dim, String category) {
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

    static String defaultCategoryForDimension(String dim) {
        return switch (dim) {
            case "SLITTING_1D" -> "SLITTING_1D";
            case "CONTOUR_2D" -> "DXF_GARMENT";
            default -> "CURTAIN_2D";
        };
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

    private static String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s.trim();
    }

    private static double round1(double v) {
        return Math.rint(v * 10.0) / 10.0;
    }
}
