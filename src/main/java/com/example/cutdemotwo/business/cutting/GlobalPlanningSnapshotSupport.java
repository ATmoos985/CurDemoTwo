package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.ExecutionOrder;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;

import java.util.*;

/**
 * 全局联合排产只读上下文拉取与待排/已排数量统计协作者。
 */
final class GlobalPlanningSnapshotSupport {
    private static final int MAX_ROLL_WIDTH_CANDIDATES = 8;
    private static final int MAX_RELAY_ROLL_CANDIDATES = 12;
    private static final int MAX_TOTAL_PIECES = 10000;

    private final RemnantService remnantService;
    private final CuttingStatePort statePort;

    GlobalPlanningSnapshotSupport(RemnantService remnantService) {
        this.remnantService = Objects.requireNonNull(remnantService, "remnantService");
        this.statePort = remnantService;
    }

    GlobalPlanningModels.PlanningContext loadReadOnlyContext(
            String taskId,
            String materialModel,
            String requiredBatchNo,
            String requiredColor,
            boolean preferRemnants,
            List<String> candidateRollIds,
            Double pieceGapMmReq,
            Double trimStartMmReq,
            List<GlobalPlanningModels.DemandSpec> rawDemands,
            boolean continueAcrossRolls
    ) {
        return statePort.inRead(tx -> {
            List<String> warnings = new ArrayList<>();
            CuttingTask task = null;
            if (GlobalPlanningModels.blankToNull(taskId) != null) {
                task = tx.findTask(taskId.trim())
                        .orElseThrow(() -> new IllegalArgumentException("任务不存在: " + taskId.trim()));
                if (task.slittingTask()) {
                    throw new IllegalArgumentException("任务「" + task.name() + "」为一维分切任务，请使用一维分切求解工作流");
                }
            }

            String targetModel = GlobalPlanningModels.firstNonBlank(materialModel, task != null ? task.materialModel() : null);
            String reqBatch = GlobalPlanningModels.firstNonBlank(requiredBatchNo, task != null ? task.requiredBatchNo() : null);
            String reqColor = GlobalPlanningModels.firstNonBlank(requiredColor, task != null ? task.requiredColor() : null);

            double pieceGapMm = pieceGapMmReq != null
                    ? pieceGapMmReq
                    : (task != null && task.process() != null ? task.process().pieceGap() : 0.0);
            double trimStartMm = trimStartMmReq != null
                    ? trimStartMmReq
                    : (task != null && task.process() != null ? task.process().trimStart() : 0.0);

            List<GlobalPlanningModels.NormalizedDemand> demands = resolveDemands(tx, rawDemands, task, warnings);
            boolean isContour = demands.stream().anyMatch(d -> d.shape() != null
                    && ("POLYGON".equals(d.shape().type()) || d.shape().hasHoles()));
            if (isContour && trimStartMm > 0) {
                // 异形模式下 trimStart 以排斥区表达，保持合法
            }

            // 读取在库所有活跃母卷、可用料头与活跃方案（均在同一个 inRead 锁内，避免冷全表扫）
            List<MotherRollInfo> allRolls = remnantService.getActiveMotherRolls();
            List<RemnantStock> allRemnants = remnantService.getAvailableRemnants();
            List<SchedulingScheme> allSchemes = tx.listActiveSchemes();
            long now = tx.operationTime();
            List<ExecutionOrder> allExecutions = tx.listExecutions();

            Map<String, MotherRollInfo> rollMap = new LinkedHashMap<>();
            for (MotherRollInfo r : allRolls) {
                rollMap.put(r.getRollId(), r);
            }

            // 构建活跃方案占用索引
            Set<String> lockedRemnants = new HashSet<>();
            Set<String> lockedRollsByExec = new HashSet<>();
            Map<String, Double> rollOccupiedLen = new HashMap<>();
            Map<String, Double> rollMaxPlannedEndY = new HashMap<>();

            for (SchedulingScheme s : allSchemes) {
                if (!s.isMaterialLockActive()) continue;
                if ("REMNANT".equals(s.materialMode()) && s.remnantId() != null) {
                    lockedRemnants.add(s.remnantId());
                }
                if ("STOCK_ROLL".equals(s.materialMode()) && s.rollId() != null && s.occupiedLengthMm() > 0) {
                    rollOccupiedLen.merge(s.rollId(), s.occupiedLengthMm(), Double::sum);
                    rollMaxPlannedEndY.merge(s.rollId(), s.windowStartY() + s.occupiedLengthMm(), Math::max);
                }
            }
            for (ExecutionOrder e : allExecutions) {
                if (!e.reserves(now)) continue;
                if ("remnant".equalsIgnoreCase(e.materialType()) && e.materialId() != null) {
                    lockedRemnants.add(e.materialId());
                } else if ("roll".equalsIgnoreCase(e.materialType()) && e.materialId() != null) {
                    lockedRollsByExec.add(e.materialId());
                }
            }

            // 筛选可用兼容料头
            List<GlobalPlanningModels.RemnantSnapshot> candidateRemnants = new ArrayList<>();
            if (preferRemnants) {
                for (RemnantStock rem : allRemnants) {
                    if (!"AVAILABLE".equalsIgnoreCase(rem.getStatus())) continue;
                    if (lockedRemnants.contains(rem.getId())) continue;
                    MotherRollInfo sourceRoll = rem.getSourceRollId() != null
                            ? rollMap.computeIfAbsent(rem.getSourceRollId(), id -> tx.findRoll(id).orElse(null))
                            : null;
                    String remModel = GlobalPlanningModels.firstNonBlank(rem.getMaterialBatch(), sourceRoll != null ? sourceRoll.getRollModel() : null);
                    if (targetModel != null && (remModel == null || !targetModel.equalsIgnoreCase(remModel))) {
                        continue;
                    }
                    String actualBatch = GlobalPlanningModels.firstNonBlank(rem.getBatchNo(), sourceRoll != null ? sourceRoll.getBatchNo() : null);
                    String actualColor = GlobalPlanningModels.firstNonBlank(rem.getColor(), sourceRoll != null ? sourceRoll.getColor() : null);
                    if (!matchesBatchAndColorFilter(tx, task, sourceRoll, rem, reqBatch, reqColor, actualBatch, actualColor)) {
                        continue;
                    }
                    if (rem.isHasDefect() && (rem.getDefects() == null || rem.getDefects().isEmpty())) {
                        warnings.add("已跳过带疵但未登记疵点坐标的料头：" + rem.getId());
                        continue;
                    }
                    if (rem.getWidth() <= 0 || rem.getLength() <= 0) continue;
                    candidateRemnants.add(new GlobalPlanningModels.RemnantSnapshot(
                            rem.getId(),
                            remModel,
                            actualBatch,
                            actualColor,
                            rem.getWidth(),
                            rem.getLength(),
                            rem.getArea(),
                            rem.isHasDefect(),
                            GlobalPlanningModels.copyDefects(rem.getDefects())
                    ));
                }
            }

            // 筛选兼容在库母卷
            List<GlobalPlanningModels.RollSnapshot> candidateRolls = selectCandidateRolls(
                    tx, task, candidateRollIds, continueAcrossRolls,
                    targetModel, reqBatch, reqColor,
                    allRolls, rollMap, lockedRollsByExec, rollOccupiedLen, rollMaxPlannedEndY, warnings
            );

            return new GlobalPlanningModels.PlanningContext(
                    targetModel == null ? "" : targetModel,
                    isContour,
                    pieceGapMm,
                    trimStartMm,
                    List.copyOf(demands),
                    List.copyOf(candidateRemnants),
                    List.copyOf(candidateRolls),
                    List.copyOf(warnings)
            );
        });
    }

    private List<GlobalPlanningModels.NormalizedDemand> resolveDemands(
            CuttingStatePort.ReadView tx,
            List<GlobalPlanningModels.DemandSpec> rawDemands,
            CuttingTask task,
            List<String> warnings
    ) {
        List<GlobalPlanningModels.NormalizedDemand> out = new ArrayList<>();
        if (rawDemands != null && !rawDemands.isEmpty()) {
            Set<Integer> usedIds = new HashSet<>();
            int autoId = 1;
            long totalCount = 0;
            for (GlobalPlanningModels.DemandSpec item : rawDemands) {
                if (item == null) continue;
                int id = (item.id() != null && item.id() > 0) ? item.id() : autoId++;
                while (!usedIds.add(id)) {
                    id = autoId++;
                }
                if (item.quantity() <= 0) {
                    throw new IllegalArgumentException("需求件数必须为正整数：" + Objects.toString(item.name(), "#" + id));
                }
                NestingProblem.Shape shape = item.shape();
                double w = shape != null ? shape.width() : item.width();
                double l = shape != null ? shape.height() : item.length();
                if (!Double.isFinite(w) || w <= 0 || !Double.isFinite(l) || l <= 0) {
                    throw new IllegalArgumentException("需求尺寸必须为正有限数值：" + Objects.toString(item.name(), "#" + id));
                }
                if (shape != null) {
                    PolygonGeometry.validate(shape);
                }
                totalCount += item.quantity();
                if (totalCount > MAX_TOTAL_PIECES) {
                    throw new IllegalArgumentException("单次联合排产最多处理 " + MAX_TOTAL_PIECES + " 件裁片");
                }
                double areaMm2 = shape != null ? PolygonGeometry.area(shape) : w * l;
                out.add(new GlobalPlanningModels.NormalizedDemand(
                        id,
                        GlobalPlanningModels.blankToNull(item.name()) != null ? item.name().trim() : ("裁片 #" + id),
                        w, l, item.quantity(),
                        Boolean.TRUE.equals(item.allowRotation()),
                        Boolean.TRUE.equals(item.allowHalfTurn()) ? Boolean.TRUE : null,
                        shape,
                        areaMm2,
                        GlobalPlanningModels.blankToNull(item.sourceTaskId()),
                        item.sourceLineId()
                ));
            }
            if (out.isEmpty()) {
                throw new IllegalArgumentException("请至少提供 1 项有效需求明细");
            }
            return out;
        }

        if (task == null) {
            throw new IllegalArgumentException("请提供 taskId 或至少 1 项有效裁片需求 (demands)");
        }

        // 未显式传 demands 时，从任务的未排余量 (openQty) 提取
        Map<String, Integer> completed = tx.completedQuantities(task.id());
        Map<String, Integer> planned = computePlannedQuantities(tx, task.id());
        long totalCount = 0;
        for (CuttingTask.Line line : task.demands()) {
            String key = String.valueOf(line.id());
            int open = Math.max(0, line.quantity() - completed.getOrDefault(key, 0) - planned.getOrDefault(key, 0));
            if (open <= 0) continue;
            totalCount += open;
            if (totalCount > MAX_TOTAL_PIECES) {
                throw new IllegalArgumentException("任务未排需求超过单次联合排产上限 " + MAX_TOTAL_PIECES + " 件");
            }
            double areaMm2 = line.shape() != null ? PolygonGeometry.area(line.shape()) : line.width() * line.length();
            out.add(new GlobalPlanningModels.NormalizedDemand(
                    line.id(),
                    line.name(),
                    line.width(),
                    line.length(),
                    open,
                    line.allowRotation(),
                    line.allowHalfTurn(),
                    line.shape(),
                    areaMm2,
                    task.id(),
                    line.id()
            ));
        }
        if (out.isEmpty()) {
            warnings.add("任务「" + task.name() + "」当前已无待排余量 (openQty=0)");
        }
        return out;
    }

    private List<GlobalPlanningModels.RollSnapshot> selectCandidateRolls(
            CuttingStatePort.ReadView tx,
            CuttingTask task,
            List<String> explicitRollIds,
            boolean continueAcrossRolls,
            String targetModel,
            String reqBatch,
            String reqColor,
            List<MotherRollInfo> allRolls,
            Map<String, MotherRollInfo> rollMap,
            Set<String> lockedRollsByExec,
            Map<String, Double> rollOccupiedLen,
            Map<String, Double> rollMaxPlannedEndY,
            List<String> warnings
    ) {
        boolean hasExplicit = explicitRollIds != null && !explicitRollIds.isEmpty();
        List<MotherRollInfo> pool = new ArrayList<>();
        if (hasExplicit) {
            Set<String> seen = new LinkedHashSet<>();
            for (String id : explicitRollIds) {
                if (id == null || id.isBlank() || !seen.add(id.trim())) continue;
                MotherRollInfo roll = rollMap.get(id.trim());
                if (roll == null) {
                    warnings.add("指定候选母卷不存在：" + id.trim());
                    continue;
                }
                pool.add(roll);
            }
        } else {
            pool.addAll(allRolls);
        }

        List<GlobalPlanningModels.RollSnapshot> eligible = new ArrayList<>();
        for (MotherRollInfo roll : pool) {
            if (!"PASSED".equalsIgnoreCase(roll.getInspectionStatus())) {
                if (hasExplicit) warnings.add("指定母卷状态非合格（" + roll.getInspectionStatus() + "）：" + roll.getRollId());
                continue;
            }
            if (lockedRollsByExec.contains(roll.getRollId())) {
                if (hasExplicit) warnings.add("指定母卷已被执行单占用：" + roll.getRollId());
                continue;
            }
            if (!hasExplicit && targetModel != null
                    && (roll.getRollModel() == null || !targetModel.equalsIgnoreCase(roll.getRollModel()))) {
                continue;
            }
            if (!matchesBatchAndColorFilter(tx, task, roll, null, reqBatch, reqColor,
                    GlobalPlanningModels.blankToNull(roll.getBatchNo()), GlobalPlanningModels.blankToNull(roll.getColor()))) {
                if (hasExplicit) warnings.add("指定母卷不满足缸号/色号防色差条件：" + roll.getRollId());
                continue;
            }
            double occupied = rollOccupiedLen.getOrDefault(roll.getRollId(), 0.0);
            double netBookAvail = Math.max(0.0, roll.getCurrentRemainingLength() - occupied);
            double startY = Math.max(roll.getUsedLength(), rollMaxPlannedEndY.getOrDefault(roll.getRollId(), 0.0));
            double spanAvail = Math.max(0.0, roll.getTotalLength() - startY);
            double availableLen = Math.min(netBookAvail, spanAvail);
            if (availableLen <= 1.0 || roll.getWidth() <= 0) {
                if (hasExplicit) warnings.add("指定母卷净可用余长不足：" + roll.getRollId());
                continue;
            }
            eligible.add(new GlobalPlanningModels.RollSnapshot(
                    roll.getRollId(),
                    roll.getRollModel(),
                    GlobalPlanningModels.blankToNull(roll.getBatchNo()),
                    GlobalPlanningModels.blankToNull(roll.getColor()),
                    roll.getWidth(),
                    roll.getTotalLength(),
                    startY,
                    availableLen,
                    GlobalPlanningModels.copyDefects(roll.getDefects())
            ));
        }

        if (hasExplicit) {
            return eligible;
        }

        if (continueAcrossRolls) {
            eligible.sort(Comparator
                    .comparingInt((GlobalPlanningModels.RollSnapshot r) -> r.defects().size())
                    .thenComparing(Comparator.comparingDouble(GlobalPlanningModels.RollSnapshot::availableLengthMm).reversed())
                    .thenComparingDouble(GlobalPlanningModels.RollSnapshot::width)
                    .thenComparing(GlobalPlanningModels.RollSnapshot::rollId));
            return eligible.size() > MAX_RELAY_ROLL_CANDIDATES
                    ? eligible.subList(0, MAX_RELAY_ROLL_CANDIDATES)
                    : eligible;
        }

        // 未指定 candidateRollIds 且非跨卷接力时，按不同门幅去重择优（每个门幅挑出余长最充裕、疵点最少的代表卷）
        Map<Long, List<GlobalPlanningModels.RollSnapshot>> byWidthBucket = new LinkedHashMap<>();
        for (GlobalPlanningModels.RollSnapshot r : eligible) {
            long widthKey = Math.round(r.width() * 10.0);
            byWidthBucket.computeIfAbsent(widthKey, k -> new ArrayList<>()).add(r);
        }
        List<GlobalPlanningModels.RollSnapshot> deduped = new ArrayList<>();
        for (List<GlobalPlanningModels.RollSnapshot> group : byWidthBucket.values()) {
            group.sort(Comparator
                    .comparingInt((GlobalPlanningModels.RollSnapshot r) -> r.defects().size())
                    .thenComparing(Comparator.comparingDouble(GlobalPlanningModels.RollSnapshot::availableLengthMm).reversed())
                    .thenComparing(GlobalPlanningModels.RollSnapshot::rollId));
            deduped.add(group.get(0));
        }
        deduped.sort(Comparator.comparingDouble(GlobalPlanningModels.RollSnapshot::width).thenComparing(GlobalPlanningModels.RollSnapshot::rollId));
        if (deduped.size() > MAX_ROLL_WIDTH_CANDIDATES) {
            return deduped.subList(0, MAX_ROLL_WIDTH_CANDIDATES);
        }
        return deduped;
    }

    private boolean matchesBatchAndColorFilter(
            CuttingStatePort.ReadView tx,
            CuttingTask task,
            MotherRollInfo roll,
            RemnantStock remnant,
            String reqBatch,
            String reqColor,
            String actualBatch,
            String actualColor
    ) {
        if (task != null) {
            try {
                tx.validateBatchAndColorForTask(task, roll, remnant);
            } catch (IllegalArgumentException mismatch) {
                return false;
            }
        }
        if (reqBatch != null && (actualBatch == null || !reqBatch.equalsIgnoreCase(actualBatch))) {
            return false;
        }
        if (reqColor != null && (actualColor == null || !reqColor.equalsIgnoreCase(actualColor))) {
            return false;
        }
        return true;
    }

    static Map<String, Integer> computePlannedQuantities(CuttingStatePort.ReadView tx, String taskId) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        Set<String> coveredPlans = new HashSet<>();
        for (SchedulingScheme s : tx.listActiveSchemes()) {
            if (!s.occupiesDemand() || !s.involvesTask(taskId)) continue;
            coveredPlans.addAll(s.linkedPlanIds());
            Map<String, Integer> reported = new HashMap<>();
            for (String pid : s.linkedPlanIds()) {
                Map<String, Object> rec = tx.findReceipt(pid).orElse(null);
                if (rec == null || "REVERSED".equals(rec.get("status"))) continue;
                if (rec.get("taskDemandQuantities") instanceof Map<?, ?> multi) {
                    if (multi.get(taskId) instanceof Map<?, ?> taskDq) {
                        taskDq.forEach((k, v) -> reported.merge(String.valueOf(k), ((Number) v).intValue(), Integer::sum));
                    }
                } else if (Objects.equals(taskId, rec.get("taskId"))
                        && rec.get("demandQuantities") instanceof Map<?, ?> dq) {
                    dq.forEach((k, v) -> reported.merge(String.valueOf(k), ((Number) v).intValue(), Integer::sum));
                }
            }
            for (SchedulingScheme.TaskDemandAllocation alloc : s.effectiveAllocations()) {
                if (!Objects.equals(taskId, alloc.taskId())) continue;
                String lineKey = String.valueOf(alloc.lineId());
                int net = Math.max(0, alloc.quantity() - reported.getOrDefault(lineKey, 0));
                if (net > 0) counts.merge(lineKey, net, Integer::sum);
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
}
