package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.algorithm.api.NestingSolver;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.ExecutionOrder;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import com.fasterxml.jackson.annotation.JsonInclude;
import org.springframework.stereotype.Service;

import java.util.*;

/**
 * 多料头 + 多母卷全局联合排产服务（纯规划、只读零库存写入）：
 * <ul>
 *   <li>严格通过 {@link CuttingStatePort#inRead} 拉取不可变在库材料快照并及时释放读锁，绝不在锁内调用求解器；</li>
 *   <li>严格通过 {@link NestingSolver}（{@code algorithm/api}）进行试排，绝不直接依赖具体求解实现类；</li>
 *   <li>阶段一：按匹配度与可用面积筛选并排序兼容料头，执行真正的迭代接力排料（逐块扣减剩余需求池）；</li>
 *   <li>阶段二：若仍有剩余需求，按门幅去重择优或基于指定候选母卷逐卷试算最省料切长与综合利用率，并标出最佳推荐母卷。</li>
 * </ul>
 */
@Service
public class GlobalPlanningService {
    private static final int DEFAULT_MAX_REMNANTS = 6;
    private static final int MAX_REMNANTS_CAP = 20;
    private static final int MAX_ROLL_WIDTH_CANDIDATES = 8;
    private static final long DEFAULT_TIME_BUDGET_MS = 6000L;
    private static final long MIN_TIME_BUDGET_MS = 500L;
    private static final long MAX_TIME_BUDGET_MS = 30000L;
    private static final int MAX_TOTAL_PIECES = 10000;

    private final RemnantService remnantService;
    private final CuttingStatePort statePort;
    private final NestingSolver nestingSolver;

    public GlobalPlanningService(RemnantService remnantService, NestingSolver nestingSolver) {
        this.remnantService = Objects.requireNonNull(remnantService, "remnantService");
        this.statePort = remnantService;
        this.nestingSolver = Objects.requireNonNull(nestingSolver, "nestingSolver");
    }

    // ==================== 请求与响应契约 ====================

    public record DemandItem(
            Integer id,
            String name,
            double width,
            double length,
            int quantity,
            Boolean allowRotation,
            Boolean allowHalfTurn,
            NestingProblem.Shape shape
    ) {}

    public record MultiMaterialPlanRequest(
            String taskId,
            String materialModel,
            String requiredBatchNo,
            String requiredColor,
            Boolean preferRemnants,
            Integer maxRemnants,
            List<String> candidateRollIds,
            Long timeBudgetMs,
            Double pieceGapMm,
            Double trimStartMm,
            List<DemandItem> demands
    ) {}

    public record AllocatedItem(int demandId, String name, int quantity) {}

    public record RemnantAllocation(
            String remnantId,
            double widthMm,
            double lengthMm,
            double utilizationPct,
            int placedCount,
            double piecesAreaM2,
            List<AllocatedItem> allocatedItems
    ) {}

    public record RollOption(
            String rollId,
            double widthMm,
            double availableLengthMm,
            double estimatedCutLengthMm,
            double utilizationPct,
            int placedCount,
            boolean feasible,
            boolean recommended
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record MultiMaterialPlanResult(
            String materialModel,
            int totalRequestedPieces,
            int placedByRemnants,
            int placedByRoll,
            int unplacedPieces,
            List<RemnantAllocation> remnantAllocations,
            List<RollOption> rollOptions,
            double totalSavedAreaM2,
            long elapsedMs,
            List<String> warnings
    ) {}

    // ==================== 内部只读快照数据结构 ====================

    private record NormalizedDemand(
            int id,
            String name,
            double width,
            double length,
            int quantity,
            boolean allowRotation,
            Boolean allowHalfTurn,
            NestingProblem.Shape shape,
            double areaMm2
    ) {}

    private record RemnantSnapshot(
            String id,
            String materialModel,
            String batchNo,
            String color,
            double width,
            double length,
            double areaM2,
            boolean hasDefect,
            List<Defect> defects
    ) {}

    private record RollSnapshot(
            String rollId,
            String materialModel,
            String batchNo,
            String color,
            double width,
            double totalLength,
            double startY,
            double availableLengthMm,
            List<Defect> defects
    ) {}

    private record PlanningContext(
            String materialModel,
            boolean isContour,
            double pieceGapMm,
            double trimStartMm,
            List<NormalizedDemand> demands,
            List<RemnantSnapshot> candidateRemnants,
            List<RollSnapshot> candidateRolls,
            List<String> warnings
    ) {}

    // ==================== 主入口 ====================

    public MultiMaterialPlanResult planMultiMaterial(MultiMaterialPlanRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("多材料联合排产请求不能为空");
        }
        long startNanos = System.nanoTime();
        boolean preferRemnants = !Boolean.FALSE.equals(request.preferRemnants());
        int maxRemnants = request.maxRemnants() == null
                ? DEFAULT_MAX_REMNANTS
                : Math.max(0, Math.min(MAX_REMNANTS_CAP, request.maxRemnants()));
        long budgetMs = request.timeBudgetMs() == null
                ? DEFAULT_TIME_BUDGET_MS
                : Math.max(MIN_TIME_BUDGET_MS, Math.min(MAX_TIME_BUDGET_MS, request.timeBudgetMs()));
        if (request.pieceGapMm() != null) {
            NestingProblem.Process.validatePieceGap(request.pieceGapMm());
        }
        if (request.trimStartMm() != null && (!Double.isFinite(request.trimStartMm()) || request.trimStartMm() < 0)) {
            throw new IllegalArgumentException("起切修齐长度 trimStartMm 不能为负数");
        }

        // 1. 仅在极短的只读事务中拷贝所有相关材料与任务上下文，绝不在读锁内调用求解器
        PlanningContext ctx = loadReadOnlyContext(request, preferRemnants);
        List<String> warnings = new ArrayList<>(ctx.warnings());

        int totalRequested = ctx.demands().stream().mapToInt(NormalizedDemand::quantity).sum();
        if (totalRequested == 0) {
            return new MultiMaterialPlanResult(
                    ctx.materialModel(), 0, 0, 0, 0,
                    List.of(), List.of(), 0.0, elapsedMillis(startNanos), List.copyOf(warnings)
            );
        }

        Map<Integer, NormalizedDemand> demandById = new LinkedHashMap<>();
        Map<Integer, Integer> remainingQty = new LinkedHashMap<>();
        for (NormalizedDemand d : ctx.demands()) {
            demandById.put(d.id(), d);
            remainingQty.put(d.id(), d.quantity());
        }

        long deadlineNanos = startNanos + budgetMs * 1_000_000L;
        long remnantDeadlineNanos = startNanos + (long) (budgetMs * 0.60) * 1_000_000L;

        // 2. 阶段一：多料头迭代接力排料（每块料头真实试排后扣减剩余需求池）
        List<RemnantAllocation> remnantAllocations = new ArrayList<>();
        int placedByRemnants = 0;
        double totalSavedAreaM2 = 0.0;

        if (preferRemnants && maxRemnants > 0 && !ctx.candidateRemnants().isEmpty()) {
            List<RemnantSnapshot> sortedRemnants = rankRemnants(ctx.candidateRemnants(), ctx.demands(), ctx.isContour());
            int evalLimit = Math.min(sortedRemnants.size(), Math.max(maxRemnants * 2, 12));
            int evaluated = 0;

            for (RemnantSnapshot rem : sortedRemnants) {
                if (remnantAllocations.size() >= maxRemnants) break;
                if (evaluated >= evalLimit) break;
                if (sumValues(remainingQty) == 0) break;
                if (System.nanoTime() >= remnantDeadlineNanos && !remnantAllocations.isEmpty()) {
                    warnings.add("料头接力排料已达阶段预算上限，剩余需求转入母卷对比阶段");
                    break;
                }
                List<NormalizedDemand> activeDemands = currentRemainingDemands(ctx.demands(), remainingQty);
                if (!canFitAny(rem.width(), rem.length(), activeDemands, ctx.isContour(), ctx.pieceGapMm())) {
                    continue;
                }
                evaluated++;

                long remBudgetMs = Math.max(400L, (remnantDeadlineNanos - System.nanoTime()) / 1_000_000L);
                int timeLimitSec = Math.max(1, (int) Math.min(2L, (remBudgetMs + 999L) / 1000L));
                NestingResult res = solveForMaterial(
                        rem.id(), rem.width(), rem.length(), rem.defects(),
                        activeDemands, ctx.isContour(), true, ctx.pieceGapMm(), 0.0, timeLimitSec
                );
                if (!res.feasible() || res.placements() == null || res.placements().isEmpty()) {
                    continue;
                }

                // 统计并按剩余需求池做防御性上限收敛
                Map<Integer, Integer> placedMap = new LinkedHashMap<>();
                for (NestingResult.Placement p : res.placements()) {
                    int remLeft = remainingQty.getOrDefault(p.demandId(), 0);
                    int curPlaced = placedMap.getOrDefault(p.demandId(), 0);
                    if (curPlaced < remLeft) {
                        placedMap.put(p.demandId(), curPlaced + 1);
                    }
                }
                int batchPlaced = sumValues(placedMap);
                if (batchPlaced <= 0) continue;

                double batchPiecesAreaM2 = 0.0;
                List<AllocatedItem> allocatedItems = new ArrayList<>();
                for (Map.Entry<Integer, Integer> entry : placedMap.entrySet()) {
                    int did = entry.getKey();
                    int qty = entry.getValue();
                    NormalizedDemand d = demandById.get(did);
                    if (d == null || qty <= 0) continue;
                    remainingQty.put(did, Math.max(0, remainingQty.getOrDefault(did, 0) - qty));
                    batchPiecesAreaM2 += d.areaMm2() * qty / 1_000_000.0;
                    allocatedItems.add(new AllocatedItem(did, d.name(), qty));
                }

                double utilPct = rem.areaM2() > 0 ? Math.min(100.0, batchPiecesAreaM2 / rem.areaM2() * 100.0) : 0.0;
                remnantAllocations.add(new RemnantAllocation(
                        rem.id(),
                        round1(rem.width()),
                        round1(rem.length()),
                        round2(utilPct),
                        batchPlaced,
                        round4(batchPiecesAreaM2),
                        List.copyOf(allocatedItems)
                ));
                placedByRemnants += batchPlaced;
                totalSavedAreaM2 += batchPiecesAreaM2;
            }
        }

        // 3. 阶段二：若仍有未满足需求，逐母卷/门幅试算最省料方案并排序推荐
        int remainingTotal = sumValues(remainingQty);
        List<RollOption> rollOptions = new ArrayList<>();
        int placedByRoll = 0;

        if (remainingTotal > 0) {
            List<NormalizedDemand> remainingDemands = currentRemainingDemands(ctx.demands(), remainingQty);
            if (ctx.candidateRolls().isEmpty()) {
                warnings.add("未找到满足型号与防色差条件且有净可用余长的合格在库母卷");
            } else {
                List<RollTrialOutcome> trials = new ArrayList<>();
                for (int idx = 0; idx < ctx.candidateRolls().size(); idx++) {
                    RollSnapshot roll = ctx.candidateRolls().get(idx);
                    if (idx > 0 && System.nanoTime() >= deadlineNanos) {
                        warnings.add("母卷对比试算达到总时间预算，部分备选门幅未继续试排");
                        break;
                    }
                    long leftMs = Math.max(500L, (deadlineNanos - System.nanoTime()) / 1_000_000L);
                    int perRollSec = Math.max(1, (int) Math.min(2L, (leftMs + 999L) / 1000L));
                    trials.add(evaluateRoll(roll, remainingDemands, remainingTotal, ctx.isContour(),
                            ctx.pieceGapMm(), ctx.trimStartMm(), perRollSec, deadlineNanos));
                }

                // 排序：可齐套优先 > 排入件数多优先 > 预计消耗面积最小（最省料） > 利用率最高 > rollId
                trials.sort(Comparator
                        .comparing(RollTrialOutcome::feasible).reversed()
                        .thenComparing(Comparator.comparingInt(RollTrialOutcome::placedCount).reversed())
                        .thenComparingDouble(RollTrialOutcome::estimatedConsumedAreaMm2)
                        .thenComparing(Comparator.comparingDouble(RollTrialOutcome::utilizationPct).reversed())
                        .thenComparing(RollTrialOutcome::rollId));

                for (int i = 0; i < trials.size(); i++) {
                    RollTrialOutcome t = trials.get(i);
                    boolean recommended = (i == 0 && t.placedCount() > 0);
                    if (recommended) {
                        placedByRoll = t.placedCount();
                    }
                    rollOptions.add(new RollOption(
                            t.rollId(),
                            round1(t.widthMm()),
                            round1(t.availableLengthMm()),
                            round1(t.estimatedCutLengthMm()),
                            round2(t.utilizationPct()),
                            t.placedCount(),
                            t.feasible(),
                            recommended
                    ));
                }
            }
        }

        int unplacedPieces = Math.max(0, totalRequested - placedByRemnants - placedByRoll);
        if (unplacedPieces > 0 && !rollOptions.isEmpty() && rollOptions.stream().noneMatch(RollOption::feasible)) {
            warnings.add("当前候选母卷无法一次齐套排入全部剩余 " + remainingTotal + " 件裁片，已优先推荐排入最多且最省料的母卷");
        }

        return new MultiMaterialPlanResult(
                ctx.materialModel(),
                totalRequested,
                placedByRemnants,
                placedByRoll,
                unplacedPieces,
                List.copyOf(remnantAllocations),
                List.copyOf(rollOptions),
                round4(totalSavedAreaM2),
                elapsedMillis(startNanos),
                List.copyOf(warnings)
        );
    }

    // ==================== 只读上下文快照拉取 ====================

    private PlanningContext loadReadOnlyContext(MultiMaterialPlanRequest request, boolean preferRemnants) {
        return statePort.inRead(tx -> {
            List<String> warnings = new ArrayList<>();
            CuttingTask task = null;
            if (blankToNull(request.taskId()) != null) {
                task = tx.findTask(request.taskId().trim())
                        .orElseThrow(() -> new IllegalArgumentException("任务不存在: " + request.taskId().trim()));
                if (task.slittingTask()) {
                    throw new IllegalArgumentException("任务「" + task.name() + "」为一维分切任务，请使用一维分切求解工作流");
                }
            }

            String targetModel = firstNonBlank(request.materialModel(), task != null ? task.materialModel() : null);
            String reqBatch = firstNonBlank(request.requiredBatchNo(), task != null ? task.requiredBatchNo() : null);
            String reqColor = firstNonBlank(request.requiredColor(), task != null ? task.requiredColor() : null);

            double pieceGapMm = request.pieceGapMm() != null
                    ? request.pieceGapMm()
                    : (task != null && task.process() != null ? task.process().pieceGap() : 0.0);
            double trimStartMm = request.trimStartMm() != null
                    ? request.trimStartMm()
                    : (task != null && task.process() != null ? task.process().trimStart() : 0.0);

            List<NormalizedDemand> demands = resolveDemands(tx, request, task, warnings);
            boolean isContour = demands.stream().anyMatch(d -> d.shape() != null && "POLYGON".equals(d.shape().type()));
            if (isContour && trimStartMm > 0) {
                // 异形模式下 trimStart 以排斥区表达，保持合法
            }

            // 读取在库所有母卷、料头与活跃方案（均在同一个 inRead 锁内）
            List<MotherRollInfo> allRolls = remnantService.getMotherRolls();
            List<RemnantStock> allRemnants = remnantService.getAllRemnants();
            List<SchedulingScheme> allSchemes = tx.listSchemes();
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
            List<RemnantSnapshot> candidateRemnants = new ArrayList<>();
            if (preferRemnants) {
                for (RemnantStock rem : allRemnants) {
                    if (!"AVAILABLE".equalsIgnoreCase(rem.getStatus())) continue;
                    if (lockedRemnants.contains(rem.getId())) continue;
                    MotherRollInfo sourceRoll = rem.getSourceRollId() != null ? rollMap.get(rem.getSourceRollId()) : null;
                    String remModel = firstNonBlank(rem.getMaterialBatch(), sourceRoll != null ? sourceRoll.getRollModel() : null);
                    if (targetModel != null && (remModel == null || !targetModel.equalsIgnoreCase(remModel))) {
                        continue;
                    }
                    String actualBatch = firstNonBlank(rem.getBatchNo(), sourceRoll != null ? sourceRoll.getBatchNo() : null);
                    String actualColor = firstNonBlank(rem.getColor(), sourceRoll != null ? sourceRoll.getColor() : null);
                    if (!matchesBatchAndColorFilter(tx, task, sourceRoll, rem, reqBatch, reqColor, actualBatch, actualColor)) {
                        continue;
                    }
                    if (rem.isHasDefect() && (rem.getDefects() == null || rem.getDefects().isEmpty())) {
                        warnings.add("已跳过带疵但未登记疵点坐标的料头：" + rem.getId());
                        continue;
                    }
                    if (rem.getWidth() <= 0 || rem.getLength() <= 0) continue;
                    candidateRemnants.add(new RemnantSnapshot(
                            rem.getId(),
                            remModel,
                            actualBatch,
                            actualColor,
                            rem.getWidth(),
                            rem.getLength(),
                            rem.getArea(),
                            rem.isHasDefect(),
                            copyDefects(rem.getDefects())
                    ));
                }
            }

            // 筛选兼容在库母卷
            List<RollSnapshot> candidateRolls = selectCandidateRolls(
                    tx, task, request.candidateRollIds(), targetModel, reqBatch, reqColor,
                    allRolls, rollMap, lockedRollsByExec, rollOccupiedLen, rollMaxPlannedEndY, warnings
            );

            return new PlanningContext(
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

    private List<NormalizedDemand> resolveDemands(
            CuttingStatePort.ReadView tx,
            MultiMaterialPlanRequest request,
            CuttingTask task,
            List<String> warnings
    ) {
        List<NormalizedDemand> out = new ArrayList<>();
        if (request.demands() != null && !request.demands().isEmpty()) {
            Set<Integer> usedIds = new HashSet<>();
            int autoId = 1;
            long totalCount = 0;
            for (DemandItem item : request.demands()) {
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
                out.add(new NormalizedDemand(
                        id,
                        blankToNull(item.name()) != null ? item.name().trim() : ("裁片 #" + id),
                        w, l, item.quantity(),
                        Boolean.TRUE.equals(item.allowRotation()),
                        Boolean.TRUE.equals(item.allowHalfTurn()) ? Boolean.TRUE : null,
                        shape,
                        areaMm2
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
            out.add(new NormalizedDemand(
                    line.id(),
                    line.name(),
                    line.width(),
                    line.length(),
                    open,
                    line.allowRotation(),
                    line.allowHalfTurn(),
                    line.shape(),
                    areaMm2
            ));
        }
        if (out.isEmpty()) {
            warnings.add("任务「" + task.name() + "」当前已无待排余量 (openQty=0)");
        }
        return out;
    }

    private List<RollSnapshot> selectCandidateRolls(
            CuttingStatePort.ReadView tx,
            CuttingTask task,
            List<String> explicitRollIds,
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

        List<RollSnapshot> eligible = new ArrayList<>();
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
                    blankToNull(roll.getBatchNo()), blankToNull(roll.getColor()))) {
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
            eligible.add(new RollSnapshot(
                    roll.getRollId(),
                    roll.getRollModel(),
                    blankToNull(roll.getBatchNo()),
                    blankToNull(roll.getColor()),
                    roll.getWidth(),
                    roll.getTotalLength(),
                    startY,
                    availableLen,
                    copyDefects(roll.getDefects())
            ));
        }

        if (hasExplicit) {
            return eligible;
        }

        // 未指定 candidateRollIds 时，按不同门幅去重择优（每个门幅挑出余长最充裕、疵点最少的代表卷）
        Map<Long, List<RollSnapshot>> byWidthBucket = new LinkedHashMap<>();
        for (RollSnapshot r : eligible) {
            long widthKey = Math.round(r.width() * 10.0);
            byWidthBucket.computeIfAbsent(widthKey, k -> new ArrayList<>()).add(r);
        }
        List<RollSnapshot> deduped = new ArrayList<>();
        for (List<RollSnapshot> group : byWidthBucket.values()) {
            group.sort(Comparator
                    .comparingInt((RollSnapshot r) -> r.defects().size())
                    .thenComparing(Comparator.comparingDouble(RollSnapshot::availableLengthMm).reversed())
                    .thenComparing(RollSnapshot::rollId));
            deduped.add(group.get(0));
        }
        deduped.sort(Comparator.comparingDouble(RollSnapshot::width).thenComparing(RollSnapshot::rollId));
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

    // ==================== 阶段一排序与阶段二母卷试算 ====================

    private List<RemnantSnapshot> rankRemnants(
            List<RemnantSnapshot> remnants,
            List<NormalizedDemand> demands,
            boolean isContour
    ) {
        List<RemnantSnapshot> ranked = new ArrayList<>(remnants);
        ranked.sort((a, b) -> {
            // 1. 匹配度评分（能放下的需求行种数 + 无疵加分 + 幅宽贴合度）高者优先
            int scoreCmp = Double.compare(remnantMatchScore(b, demands, isContour), remnantMatchScore(a, demands, isContour));
            if (scoreCmp != 0) return scoreCmp;
            // 2. 同等匹配度下优先消纳较小可用面积的合适料头，避免切碎大块好料头
            int areaCmp = Double.compare(a.areaM2(), b.areaM2());
            if (areaCmp != 0) return areaCmp;
            return a.id().compareTo(b.id());
        });
        return ranked;
    }

    private double remnantMatchScore(RemnantSnapshot rem, List<NormalizedDemand> demands, boolean isContour) {
        int fitLines = 0;
        double bestWidthFit = 0.0;
        for (NormalizedDemand d : demands) {
            boolean fitsNormal = d.width() <= rem.width() + 0.001 && d.length() <= rem.length() + 0.001;
            boolean fitsRot = !isContour && d.allowRotation()
                    && d.length() <= rem.width() + 0.001 && d.width() <= rem.length() + 0.001;
            if (fitsNormal || fitsRot) {
                fitLines++;
                double usedW = fitsNormal ? d.width() : d.length();
                double ratio = Math.min(1.0, usedW / rem.width());
                bestWidthFit = Math.max(bestWidthFit, ratio);
            }
        }
        if (fitLines == 0) return -1.0;
        double defectBonus = rem.hasDefect() ? 0.0 : 2.0;
        return fitLines * 10.0 + defectBonus + bestWidthFit;
    }

    private record RollTrialOutcome(
            String rollId,
            double widthMm,
            double availableLengthMm,
            double estimatedCutLengthMm,
            double estimatedConsumedAreaMm2,
            double utilizationPct,
            int placedCount,
            boolean feasible
    ) {}

    private RollTrialOutcome evaluateRoll(
            RollSnapshot roll,
            List<NormalizedDemand> demands,
            int remainingTotal,
            boolean isContour,
            double pieceGapMm,
            double trimStartMm,
            int perRollSec,
            long deadlineNanos
    ) {
        double availLen = roll.availableLengthMm();
        if (availLen <= trimStartMm + 1.0 || !canFitAny(roll.width(), availLen - trimStartMm, demands, isContour, pieceGapMm)) {
            return new RollTrialOutcome(roll.rollId(), roll.width(), availLen, 0.0, Double.POSITIVE_INFINITY, 0.0, 0, false);
        }

        double totalDemandAreaMm2 = demands.stream().mapToDouble(d -> d.areaMm2() * d.quantity()).sum();
        double maxPieceDimL = demands.stream().mapToDouble(d -> {
            if (!isContour && d.allowRotation()) {
                return Math.min(d.length(), d.width());
            }
            return d.length();
        }).max().orElse(0.0);
        double maxRawL = demands.stream().mapToDouble(NormalizedDemand::length).max().orElse(0.0);
        double sumPieceLen = demands.stream().mapToDouble(d -> (Math.max(d.length(), d.width()) + pieceGapMm) * d.quantity()).sum();

        double theoreticalMinLen = Math.max(trimStartMm + maxPieceDimL, trimStartMm + totalDemandAreaMm2 / roll.width());
        double initWindowLen = Math.min(availLen, Math.max(
                trimStartMm + maxRawL + pieceGapMm,
                Math.ceil((trimStartMm + (totalDemandAreaMm2 / roll.width()) * 1.30 + maxRawL * 0.5) / 10.0) * 10.0
        ));
        initWindowLen = Math.max(initWindowLen, Math.min(availLen, trimStartMm + maxPieceDimL + 10.0));

        NestingResult best = solveForMaterial(
                roll.rollId(), roll.width(), initWindowLen,
                sliceDefectsForWindow(roll.defects(), roll.startY(), initWindowLen),
                demands, isContour, false, pieceGapMm, trimStartMm, perRollSec
        );
        int bestPlaced = countPlaced(best);
        double bestCutLen = bestPlaced > 0 ? computeOccupiedLengthMm(best, demands, isContour, pieceGapMm, trimStartMm) : 0.0;

        // 若首次紧凑窗口未能全齐套且卷上还有剩余长度，自动扩大窗口重排一次
        if (bestPlaced < remainingTotal && initWindowLen < availLen - 1.0 && System.nanoTime() < deadlineNanos) {
            double expandedLen = Math.min(availLen, Math.max(initWindowLen * 2.0, trimStartMm + sumPieceLen + 500.0));
            NestingResult expanded = solveForMaterial(
                    roll.rollId(), roll.width(), expandedLen,
                    sliceDefectsForWindow(roll.defects(), roll.startY(), expandedLen),
                    demands, isContour, false, pieceGapMm, trimStartMm, perRollSec
            );
            int expPlaced = countPlaced(expanded);
            if (expPlaced > bestPlaced) {
                best = expanded;
                bestPlaced = expPlaced;
                bestCutLen = computeOccupiedLengthMm(expanded, demands, isContour, pieceGapMm, trimStartMm);
            }
        }

        // 若已全齐套，执行最多 2 次确定性二分缩长，精确比出不同门幅的最省料真实切长
        boolean feasible = bestPlaced >= remainingTotal;
        if (feasible && bestCutLen > theoreticalMinLen + 40.0) {
            double high = bestCutLen;
            double low = theoreticalMinLen;
            for (int iter = 0; iter < 2 && high - low > 30.0 && System.nanoTime() < deadlineNanos; iter++) {
                double mid = Math.floor((high + low) * 0.5 / 10.0) * 10.0;
                if (mid <= trimStartMm + 1.0 || mid >= high - 1.0) break;
                NestingResult trial = solveForMaterial(
                        roll.rollId(), roll.width(), mid,
                        sliceDefectsForWindow(roll.defects(), roll.startY(), mid),
                        demands, isContour, false, pieceGapMm, trimStartMm, 1
                );
                if (countPlaced(trial) >= remainingTotal) {
                    double trialLen = computeOccupiedLengthMm(trial, demands, isContour, pieceGapMm, trimStartMm);
                    if (trialLen < bestCutLen) {
                        best = trial;
                        bestCutLen = trialLen;
                    }
                    high = Math.min(mid, trialLen);
                } else {
                    low = mid;
                }
            }
        }

        if (bestPlaced <= 0 || bestCutLen <= 0) {
            return new RollTrialOutcome(roll.rollId(), roll.width(), availLen, 0.0, Double.POSITIVE_INFINITY, 0.0, 0, false);
        }

        double placedAreaMm2 = computePlacedAreaMm2(best, demands);
        double consumedAreaMm2 = roll.width() * bestCutLen;
        double utilPct = consumedAreaMm2 > 0 ? Math.min(100.0, placedAreaMm2 / consumedAreaMm2 * 100.0) : 0.0;
        return new RollTrialOutcome(
                roll.rollId(),
                roll.width(),
                availLen,
                bestCutLen,
                consumedAreaMm2,
                utilPct,
                bestPlaced,
                feasible
        );
    }

    // ==================== 统一通过 algorithm/api/NestingSolver 试排 ====================

    private NestingResult solveForMaterial(
            String materialId,
            double width,
            double length,
            List<Defect> defects,
            List<NormalizedDemand> demands,
            boolean isContour,
            boolean isRemnant,
            double pieceGapMm,
            double trimStartMm,
            int timeLimitSeconds
    ) {
        double matW = floor1(width);
        double matL = floor1(length);
        double effTrim = isRemnant ? 0.0 : ceil1(Math.max(0.0, trimStartMm));
        double effGap = ceil1(Math.max(0.0, pieceGapMm));
        if (demands.isEmpty() || matW <= 0 || matL <= 0 || (!isRemnant && effTrim >= matL)) {
            return NestingResult.failure("NO_SOLUTION_FOUND", "有效加工区不足", "auto", 0);
        }

        List<NestingProblem.Exclusion> exclusions = new ArrayList<>();
        for (Defect d : defects) {
            if (d == null || d.getW() <= 0 || d.getH() <= 0) continue;
            if (isContour) {
                double x = floor1(Math.max(0.0, d.getX() - d.getMargin()));
                double y = floor1(Math.max(0.0, d.getY() - d.getMargin()));
                double right = Math.min(matW, ceil1(d.getX() + d.getW() + d.getMargin()));
                double bottom = Math.min(matL, ceil1(d.getY() + d.getH() + d.getMargin()));
                double w = round1(right - x);
                double h = round1(bottom - y);
                if (w > 0 && h > 0 && x < matW && y < matL) {
                    exclusions.add(new NestingProblem.Exclusion(
                            exclusions.size() + 1, x, y,
                            NestingProblem.Shape.rectangle(w, h), 0.0
                    ));
                }
            } else {
                double x = floor1(Math.max(0.0, d.getX()));
                double y = floor1(Math.max(0.0, d.getY()));
                double right = Math.min(matW, ceil1(d.getX() + d.getW()));
                double bottom = Math.min(matL, ceil1(d.getY() + d.getH()));
                double w = round1(right - x);
                double h = round1(bottom - y);
                double margin = ceil1(Math.max(0.0, d.getMargin()));
                if (w > 0 && h > 0 && x < matW && y < matL) {
                    exclusions.add(new NestingProblem.Exclusion(
                            exclusions.size() + 1,
                            x, y, NestingProblem.Shape.rectangle(w, h), margin,
                            d.getSeverity(), d.getAvoidanceStrategy()
                    ));
                }
            }
        }

        if (isContour) {
            if (effTrim > 0 && effTrim < matL) {
                exclusions.add(new NestingProblem.Exclusion(
                        exclusions.size() + 1, 0.0, 0.0,
                        NestingProblem.Shape.rectangle(matW, effTrim), 0.0
                ));
            }
            List<NestingProblem.Part> parts = demands.stream()
                    .map(d -> new NestingProblem.Part(
                            d.id(),
                            d.name(),
                            d.shape() != null ? d.shape() : NestingProblem.Shape.rectangle(ceil1(d.width()), ceil1(d.length())),
                            d.quantity(),
                            d.allowRotation(),
                            d.allowHalfTurn()
                    ))
                    .toList();
            NestingProblem problem = new NestingProblem(
                    "1", "mm",
                    new NestingProblem.Material(materialId, NestingProblem.Shape.rectangle(matW, matL), exclusions, false),
                    parts,
                    new NestingProblem.Process("CONTOUR", "SHEET", "left-top", "none", 0.0, 0.0, 0.0, 0.0,
                            "MAXIMIZE_PIECE_AREA", effGap),
                    resolveAvailableEngine(true),
                    timeLimitSeconds
            );
            try {
                return nestingSolver.solve(problem, true);
            } catch (IllegalArgumentException rejected) {
                return NestingResult.failure("NO_SOLUTION_FOUND", rejected.getMessage(), "auto", 0);
            }
        }

        // 矩形直刀（GUILLOTINE）：参照 FabricSolveAdapter 通过扩边等价实现 pieceGapMm（统一保守量化至 0.1 mm）
        double pad = effGap > 0 ? effGap : 0.0;
        List<NestingProblem.Part> parts = demands.stream()
                .map(d -> new NestingProblem.Part(
                        d.id(),
                        d.name(),
                        NestingProblem.Shape.rectangle(round1(ceil1(d.width()) + pad), round1(ceil1(d.length()) + pad)),
                        d.quantity(),
                        d.allowRotation()
                ))
                .toList();
        NestingProblem.Material material = new NestingProblem.Material(
                materialId,
                NestingProblem.Shape.rectangle(round1(matW + pad), round1(matL + pad)),
                exclusions,
                !isRemnant
        );
        NestingProblem.Process process = new NestingProblem.Process(
                "GUILLOTINE",
                isRemnant ? "SHEET" : "CONTINUOUS",
                "right-top",
                "horizontal",
                effTrim,
                200.0,
                300.0,
                0.0,
                "MAXIMIZE_PIECE_AREA",
                0.0
        );
        NestingProblem problem = new NestingProblem("1", "mm", material, parts, process,
                resolveAvailableEngine(false), timeLimitSeconds);
        try {
            return nestingSolver.solve(problem, true);
        } catch (IllegalArgumentException rejected) {
            return NestingResult.failure("NO_SOLUTION_FOUND", rejected.getMessage(), "auto", 0);
        }
    }

    /** 严格通过 NestingSolver.capabilities() 选择已就绪的可用引擎，兼容原生就绪与纯 Java 降级环境。 */
    private String resolveAvailableEngine(boolean isContour) {
        var caps = nestingSolver.capabilities();
        if (caps == null || caps.isEmpty()) return "auto";
        String requiredMode = isContour ? "CONTOUR" : "GUILLOTINE";
        String preferred = isContour ? "deepnest" : "javaguillotine";
        String nativePreferred = isContour ? "packingsolver-irregular" : "packingsolver";
        String fallbackId = null;
        for (var cap : caps) {
            if (!cap.available() || cap.modes() == null || !cap.modes().contains(requiredMode)) continue;
            if (nativePreferred.equalsIgnoreCase(cap.id())) return cap.id();
            if (preferred.equalsIgnoreCase(cap.id())) fallbackId = cap.id();
            else if (fallbackId == null) fallbackId = cap.id();
        }
        return fallbackId != null ? fallbackId : "auto";
    }

    // ==================== 辅助方法 ====================

    private static List<NormalizedDemand> currentRemainingDemands(
            List<NormalizedDemand> base,
            Map<Integer, Integer> remainingQty
    ) {
        List<NormalizedDemand> active = new ArrayList<>();
        for (NormalizedDemand d : base) {
            int rem = remainingQty.getOrDefault(d.id(), 0);
            if (rem > 0) {
                active.add(new NormalizedDemand(
                        d.id(), d.name(), d.width(), d.length(), rem,
                        d.allowRotation(), d.allowHalfTurn(), d.shape(), d.areaMm2()
                ));
            }
        }
        return active;
    }

    private static boolean canFitAny(
            double matW,
            double matL,
            List<NormalizedDemand> demands,
            boolean isContour,
            double pieceGapMm
    ) {
        if (matW <= 0 || matL <= 0) return false;
        for (NormalizedDemand d : demands) {
            if (d.width() <= matW + 0.001 && d.length() <= matL + 0.001) return true;
            if (!isContour && d.allowRotation() && d.length() <= matW + 0.001 && d.width() <= matL + 0.001) return true;
        }
        return false;
    }

    private static int countPlaced(NestingResult result) {
        if (result == null || !result.feasible() || result.placements() == null) return 0;
        return result.placements().size();
    }

    private static double computeOccupiedLengthMm(
            NestingResult result,
            List<NormalizedDemand> demands,
            boolean isContour,
            double pieceGapMm,
            double trimStartMm
    ) {
        if (result == null || !result.feasible() || result.placements() == null || result.placements().isEmpty()) {
            return 0.0;
        }
        Map<Integer, NormalizedDemand> map = new HashMap<>();
        for (NormalizedDemand d : demands) map.put(d.id(), d);

        double maxEndY = trimStartMm;
        double pad = (!isContour && pieceGapMm > 0) ? pieceGapMm : 0.0;
        for (NestingResult.Placement p : result.placements()) {
            double h = p.shape() != null ? p.shape().height() : 0.0;
            if (pad > 0) {
                NormalizedDemand d = map.get(p.demandId());
                if (d != null) {
                    boolean rotated = (p.rotationDegrees() % 180) != 0;
                    h = rotated ? d.width() : d.length();
                } else {
                    h = Math.max(0.0, h - pad);
                }
            }
            maxEndY = Math.max(maxEndY, p.y() + h);
        }
        return maxEndY;
    }

    private static double computePlacedAreaMm2(NestingResult result, List<NormalizedDemand> demands) {
        if (result == null || !result.feasible() || result.placements() == null) return 0.0;
        Map<Integer, NormalizedDemand> map = new HashMap<>();
        for (NormalizedDemand d : demands) map.put(d.id(), d);
        double area = 0.0;
        for (NestingResult.Placement p : result.placements()) {
            NormalizedDemand d = map.get(p.demandId());
            if (d != null) {
                area += d.areaMm2();
            } else if (p.shape() != null) {
                area += p.shape().areaMm2();
            }
        }
        return area;
    }

    private static List<Defect> sliceDefectsForWindow(List<Defect> defects, double startY, double windowLen) {
        if (defects == null || defects.isEmpty()) return List.of();
        double endY = startY + windowLen;
        List<Defect> sliced = new ArrayList<>();
        for (Defect d : defects) {
            if (d == null) continue;
            double defTop = d.getY() - d.getMargin();
            double defBottom = d.getY() + d.getH() + d.getMargin();
            if (defBottom <= startY || defTop >= endY) continue;
            double localY = Math.max(0.0, d.getY() - startY);
            double localBottom = Math.min(windowLen, d.getY() + d.getH() - startY);
            double localH = localBottom - localY;
            if (localH <= 0) continue;
            sliced.add(new Defect(
                    d.getId(), d.getX(), localY, d.getW(), localH, d.getMargin(),
                    d.getDefectType(), d.getTypeName(), d.getSeverity(), d.getPoints(),
                    d.getDetectionSource(), d.getAvoidanceStrategy(), d.getDescription()
            ));
        }
        return sliced;
    }

    private static List<Defect> copyDefects(List<Defect> defects) {
        if (defects == null || defects.isEmpty()) return List.of();
        List<Defect> copy = new ArrayList<>(defects.size());
        for (Defect d : defects) {
            if (d == null) continue;
            copy.add(new Defect(
                    d.getId(), d.getX(), d.getY(), d.getW(), d.getH(), d.getMargin(),
                    d.getDefectType(), d.getTypeName(), d.getSeverity(), d.getPoints(),
                    d.getDetectionSource(), d.getAvoidanceStrategy(), d.getDescription()
            ));
        }
        return List.copyOf(copy);
    }

    static Map<String, Integer> computePlannedQuantities(CuttingStatePort.ReadView tx, String taskId) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        Set<String> coveredPlans = new HashSet<>();
        for (SchedulingScheme s : tx.listSchemes()) {
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

    private static int sumValues(Map<?, Integer> map) {
        int s = 0;
        for (Integer v : map.values()) if (v != null) s += v;
        return s;
    }

    private static long elapsedMillis(long startNanos) {
        return Math.max(0L, (System.nanoTime() - startNanos) / 1_000_000L);
    }

    private static String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s.trim();
    }

    private static String firstNonBlank(String a, String b) {
        String x = blankToNull(a);
        return x != null ? x : blankToNull(b);
    }

    private static double round1(double v) {
        return Math.rint(v * 10.0) / 10.0;
    }

    private static double floor1(double v) {
        if (!Double.isFinite(v)) return 0.0;
        return Math.floor(v * 10.0 + 1e-9) / 10.0;
    }

    private static double ceil1(double v) {
        if (!Double.isFinite(v)) return 0.0;
        return Math.ceil(v * 10.0 - 1e-9) / 10.0;
    }

    private static double round2(double v) {
        return Math.rint(v * 100.0) / 100.0;
    }

    private static double round4(double v) {
        return Math.rint(v * 10000.0) / 10000.0;
    }
}
