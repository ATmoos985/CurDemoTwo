package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.algorithm.api.NestingSolver;
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
    private static final long DEFAULT_TIME_BUDGET_MS = 6000L;
    private static final long MIN_TIME_BUDGET_MS = 500L;
    private static final long MAX_TIME_BUDGET_MS = 30000L;

    private final GlobalPlanningSnapshotSupport snapshotSupport;
    private final GlobalPlanningSolverSupport solverSupport;

    public GlobalPlanningService(RemnantService remnantService, NestingSolver nestingSolver) {
        this.snapshotSupport = new GlobalPlanningSnapshotSupport(remnantService);
        this.solverSupport = new GlobalPlanningSolverSupport(nestingSolver);
    }

    // ==================== 请求与响应契约 ====================

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record DemandItem(
            Integer id,
            String name,
            double width,
            double length,
            int quantity,
            Boolean allowRotation,
            Boolean allowHalfTurn,
            NestingProblem.Shape shape,
            String sourceTaskId,
            Integer sourceLineId
    ) {
        public DemandItem(
                Integer id,
                String name,
                double width,
                double length,
                int quantity,
                Boolean allowRotation,
                Boolean allowHalfTurn,
                NestingProblem.Shape shape
        ) {
            this(id, name, width, length, quantity, allowRotation, allowHalfTurn, shape, null, null);
        }
    }

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
            List<DemandItem> demands,
            Boolean continueAcrossRolls
    ) {
        public MultiMaterialPlanRequest(
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
        ) {
            this(taskId, materialModel, requiredBatchNo, requiredColor, preferRemnants, maxRemnants,
                    candidateRollIds, timeBudgetMs, pieceGapMm, trimStartMm, demands, null);
        }
    }

    public record AllocatedItem(int demandId, String name, int quantity) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PlacementSnapshot(
            int id,
            int demandId,
            String name,
            double x,
            double y,
            double w,
            double l,
            int rotationDegrees,
            boolean rotated,
            List<NestingProblem.Point> polygon,
            List<List<NestingProblem.Point>> holes,
            String sourceTaskId,
            Integer sourceLineId
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record RemnantAllocation(
            String remnantId,
            double widthMm,
            double lengthMm,
            double utilizationPct,
            int placedCount,
            double piecesAreaM2,
            List<AllocatedItem> allocatedItems,
            List<PlacementSnapshot> placements,
            List<Defect> defects,
            String materialModel,
            String batchNo,
            String color
    ) {
        public RemnantAllocation(
                String remnantId,
                double widthMm,
                double lengthMm,
                double utilizationPct,
                int placedCount,
                double piecesAreaM2,
                List<AllocatedItem> allocatedItems
        ) {
            this(remnantId, widthMm, lengthMm, utilizationPct, placedCount, piecesAreaM2, allocatedItems,
                    List.of(), List.of(), null, null, null);
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record RollOption(
            String rollId,
            double widthMm,
            double availableLengthMm,
            double estimatedCutLengthMm,
            double utilizationPct,
            int placedCount,
            boolean feasible,
            boolean recommended,
            Double windowStartY,
            Double totalLengthMm,
            List<PlacementSnapshot> placements,
            List<Defect> defects,
            String rollModel,
            String batchNo,
            String color,
            Integer relayOrder,
            List<AllocatedItem> allocatedItems
    ) {
        public RollOption(
                String rollId,
                double widthMm,
                double availableLengthMm,
                double estimatedCutLengthMm,
                double utilizationPct,
                int placedCount,
                boolean feasible,
                boolean recommended
        ) {
            this(rollId, widthMm, availableLengthMm, estimatedCutLengthMm, utilizationPct, placedCount,
                    feasible, recommended, null, null, List.of(), List.of(), null, null, null, null, null);
        }

        public RollOption(
                String rollId,
                double widthMm,
                double availableLengthMm,
                double estimatedCutLengthMm,
                double utilizationPct,
                int placedCount,
                boolean feasible,
                boolean recommended,
                Double windowStartY,
                Double totalLengthMm,
                List<PlacementSnapshot> placements,
                List<Defect> defects,
                String rollModel,
                String batchNo,
                String color
        ) {
            this(rollId, widthMm, availableLengthMm, estimatedCutLengthMm, utilizationPct, placedCount,
                    feasible, recommended, windowStartY, totalLengthMm, placements, defects,
                    rollModel, batchNo, color, null, null);
        }
    }

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
        GlobalPlanningModels.PlanningContext ctx = snapshotSupport.loadReadOnlyContext(
                request.taskId(),
                request.materialModel(),
                request.requiredBatchNo(),
                request.requiredColor(),
                preferRemnants,
                request.candidateRollIds(),
                request.pieceGapMm(),
                request.trimStartMm(),
                toDemandSpecs(request.demands()),
                Boolean.TRUE.equals(request.continueAcrossRolls())
        );
        List<String> warnings = new ArrayList<>(ctx.warnings());

        int totalRequested = ctx.demands().stream().mapToInt(GlobalPlanningModels.NormalizedDemand::quantity).sum();
        if (totalRequested == 0) {
            return new MultiMaterialPlanResult(
                    ctx.materialModel(), 0, 0, 0, 0,
                    List.of(), List.of(), 0.0, elapsedMillis(startNanos), List.copyOf(warnings)
            );
        }

        Map<Integer, GlobalPlanningModels.NormalizedDemand> demandById = new LinkedHashMap<>();
        Map<Integer, Integer> remainingQty = new LinkedHashMap<>();
        for (GlobalPlanningModels.NormalizedDemand d : ctx.demands()) {
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
            List<GlobalPlanningModels.RemnantSnapshot> sortedRemnants = solverSupport.rankRemnants(ctx.candidateRemnants(), ctx.demands());
            int evalLimit = Math.min(sortedRemnants.size(), Math.max(maxRemnants * 2, 12));
            int evaluated = 0;

            for (GlobalPlanningModels.RemnantSnapshot rem : sortedRemnants) {
                if (remnantAllocations.size() >= maxRemnants) break;
                if (evaluated >= evalLimit) break;
                if (GlobalPlanningModels.sumValues(remainingQty) == 0) break;
                if (System.nanoTime() >= remnantDeadlineNanos && !remnantAllocations.isEmpty()) {
                    warnings.add("料头接力排料已达阶段预算上限，剩余需求转入母卷对比阶段");
                    break;
                }
                List<GlobalPlanningModels.NormalizedDemand> activeDemands = GlobalPlanningSolverSupport.currentRemainingDemands(ctx.demands(), remainingQty);
                if (!GlobalPlanningSolverSupport.canFitAny(rem.width(), rem.length(), activeDemands, ctx.pieceGapMm())) {
                    continue;
                }
                evaluated++;

                long remBudgetMs = Math.max(400L, (remnantDeadlineNanos - System.nanoTime()) / 1_000_000L);
                int timeLimitSec = Math.max(1, (int) Math.min(2L, (remBudgetMs + 999L) / 1000L));
                NestingResult res = solverSupport.solveForMaterial(
                        rem.id(), rem.width(), rem.length(), rem.defects(),
                        activeDemands, ctx.isContour(), true, ctx.pieceGapMm(), 0.0, timeLimitSec
                );
                if (!res.feasible() || res.placements() == null || res.placements().isEmpty()) {
                    continue;
                }

                // 统计并按剩余需求池做防御性上限收敛（同步保留真实排布坐标，保证 placements 与 placedCount 严格守恒）
                Map<Integer, Integer> placedMap = new LinkedHashMap<>();
                List<NestingResult.Placement> acceptedRaw = new ArrayList<>();
                for (NestingResult.Placement p : res.placements()) {
                    int remLeft = remainingQty.getOrDefault(p.demandId(), 0);
                    int curPlaced = placedMap.getOrDefault(p.demandId(), 0);
                    if (curPlaced < remLeft) {
                        placedMap.put(p.demandId(), curPlaced + 1);
                        acceptedRaw.add(p);
                    }
                }
                int batchPlaced = GlobalPlanningModels.sumValues(placedMap);
                if (batchPlaced <= 0) continue;

                double batchPiecesAreaM2 = 0.0;
                List<AllocatedItem> allocatedItems = new ArrayList<>();
                for (Map.Entry<Integer, Integer> entry : placedMap.entrySet()) {
                    int did = entry.getKey();
                    int qty = entry.getValue();
                    GlobalPlanningModels.NormalizedDemand d = demandById.get(did);
                    if (d == null || qty <= 0) continue;
                    remainingQty.put(did, Math.max(0, remainingQty.getOrDefault(did, 0) - qty));
                    batchPiecesAreaM2 += d.areaMm2() * qty / 1_000_000.0;
                    allocatedItems.add(new AllocatedItem(did, d.name(), qty));
                }

                List<PlacementSnapshot> remPlacements = toPlacementSnapshots(GlobalPlanningSolverSupport.toPlacementDataList(
                        acceptedRaw, demandById, ctx.isContour(), ctx.pieceGapMm(), rem.width(), rem.length()
                ));
                double utilPct = rem.areaM2() > 0 ? Math.min(100.0, batchPiecesAreaM2 / rem.areaM2() * 100.0) : 0.0;
                remnantAllocations.add(new RemnantAllocation(
                        rem.id(),
                        GlobalPlanningModels.round1(rem.width()),
                        GlobalPlanningModels.round1(rem.length()),
                        GlobalPlanningModels.round2(utilPct),
                        batchPlaced,
                        GlobalPlanningModels.round4(batchPiecesAreaM2),
                        List.copyOf(allocatedItems),
                        remPlacements,
                        GlobalPlanningModels.copyDefects(rem.defects()),
                        GlobalPlanningModels.blankToNull(rem.materialModel()),
                        GlobalPlanningModels.blankToNull(rem.batchNo()),
                        GlobalPlanningModels.blankToNull(rem.color())
                ));
                placedByRemnants += batchPlaced;
                totalSavedAreaM2 += batchPiecesAreaM2;
            }
        }

        // 3. 阶段二：若仍有未满足需求，按单卷推荐或跨卷连续接力试算
        int remainingTotal = GlobalPlanningModels.sumValues(remainingQty);
        List<RollOption> rollOptions = new ArrayList<>();
        int placedByRoll = 0;

        if (remainingTotal > 0) {
            if (ctx.candidateRolls().isEmpty()) {
                warnings.add("未找到满足型号与防色差条件且有净可用余长的合格在库母卷");
            } else if (Boolean.TRUE.equals(request.continueAcrossRolls())) {
                MultiMaterialRollRelayHelper.RelayOutcome<GlobalPlanningModels.RollTrialOutcome> relay =
                        MultiMaterialRollRelayHelper.planAcrossRolls(
                                ctx.candidateRolls(),
                                GlobalPlanningModels.RollSnapshot::rollId,
                                remainingQty,
                                deadlineNanos,
                                warnings,
                                (roll, remMap, activeTotal, perRollSec) -> {
                                    List<GlobalPlanningModels.NormalizedDemand> activeDemands =
                                            GlobalPlanningSolverSupport.currentRemainingDemands(ctx.demands(), remMap);
                                    GlobalPlanningModels.RollTrialOutcome outcome = solverSupport.evaluateRoll(
                                            roll, activeDemands, activeTotal, ctx.isContour(),
                                            ctx.pieceGapMm(), ctx.trimStartMm(), perRollSec, deadlineNanos
                                    );
                                    List<Integer> placedDemandIds = outcome.placements().stream()
                                            .map(GlobalPlanningModels.PlacementData::demandId)
                                            .toList();
                                    return new MultiMaterialRollRelayHelper.RelayTrial<>(
                                            outcome,
                                            outcome.rollId(),
                                            outcome.feasible(),
                                            outcome.placedCount(),
                                            outcome.estimatedConsumedAreaMm2(),
                                            outcome.utilizationPct(),
                                            placedDemandIds
                                    );
                                }
                        );
                placedByRoll = relay.placedByRoll();
                for (MultiMaterialRollRelayHelper.RelayEntry<GlobalPlanningModels.RollTrialOutcome> entry : relay.entries()) {
                    List<AllocatedItem> allocated = null;
                    if (entry.allocatedCounts() != null && !entry.allocatedCounts().isEmpty()) {
                        allocated = entry.allocatedCounts().entrySet().stream()
                                .map(e -> {
                                    GlobalPlanningModels.NormalizedDemand d = demandById.get(e.getKey());
                                    return new AllocatedItem(e.getKey(), d != null ? d.name() : ("裁片 #" + e.getKey()), e.getValue());
                                })
                                .toList();
                    }
                    rollOptions.add(toRollOption(entry.payload(), entry.recommended(), entry.relayOrder(), allocated));
                }
            } else {
                List<GlobalPlanningModels.NormalizedDemand> remainingDemands =
                        GlobalPlanningSolverSupport.currentRemainingDemands(ctx.demands(), remainingQty);
                List<GlobalPlanningModels.RollTrialOutcome> trials = new ArrayList<>();
                for (int idx = 0; idx < ctx.candidateRolls().size(); idx++) {
                    GlobalPlanningModels.RollSnapshot roll = ctx.candidateRolls().get(idx);
                    if (idx > 0 && System.nanoTime() >= deadlineNanos) {
                        warnings.add("母卷对比试算达到总时间预算，部分备选门幅未继续试排");
                        break;
                    }
                    long leftMs = Math.max(500L, (deadlineNanos - System.nanoTime()) / 1_000_000L);
                    int perRollSec = Math.max(1, (int) Math.min(2L, (leftMs + 999L) / 1000L));
                    trials.add(solverSupport.evaluateRoll(roll, remainingDemands, remainingTotal, ctx.isContour(),
                            ctx.pieceGapMm(), ctx.trimStartMm(), perRollSec, deadlineNanos));
                }

                // 排序：可齐套优先 > 排入件数多优先 > 预计消耗面积最小（最省料） > 利用率最高 > rollId
                trials.sort(Comparator
                        .comparing(GlobalPlanningModels.RollTrialOutcome::feasible).reversed()
                        .thenComparing(Comparator.comparingInt(GlobalPlanningModels.RollTrialOutcome::placedCount).reversed())
                        .thenComparingDouble(GlobalPlanningModels.RollTrialOutcome::estimatedConsumedAreaMm2)
                        .thenComparing(Comparator.comparingDouble(GlobalPlanningModels.RollTrialOutcome::utilizationPct).reversed())
                        .thenComparing(GlobalPlanningModels.RollTrialOutcome::rollId));

                for (int i = 0; i < trials.size(); i++) {
                    GlobalPlanningModels.RollTrialOutcome t = trials.get(i);
                    boolean recommended = (i == 0 && t.placedCount() > 0);
                    if (recommended) {
                        placedByRoll = t.placedCount();
                    }
                    rollOptions.add(toRollOption(t, recommended, null, null));
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
                GlobalPlanningModels.round4(totalSavedAreaM2),
                elapsedMillis(startNanos),
                List.copyOf(warnings)
        );
    }

    static Map<String, Integer> computePlannedQuantities(CuttingStatePort.ReadView tx, String taskId) {
        return GlobalPlanningSnapshotSupport.computePlannedQuantities(tx, taskId);
    }

    private static List<GlobalPlanningModels.DemandSpec> toDemandSpecs(List<DemandItem> items) {
        if (items == null) return null;
        List<GlobalPlanningModels.DemandSpec> out = new ArrayList<>(items.size());
        for (DemandItem item : items) {
            if (item == null) {
                out.add(null);
            } else {
                out.add(new GlobalPlanningModels.DemandSpec(
                        item.id(), item.name(), item.width(), item.length(), item.quantity(),
                        item.allowRotation(), item.allowHalfTurn(), item.shape(),
                        item.sourceTaskId(), item.sourceLineId()
                ));
            }
        }
        return out;
    }

    private static List<PlacementSnapshot> toPlacementSnapshots(List<GlobalPlanningModels.PlacementData> dataList) {
        if (dataList == null || dataList.isEmpty()) return List.of();
        List<PlacementSnapshot> out = new ArrayList<>(dataList.size());
        for (GlobalPlanningModels.PlacementData d : dataList) {
            out.add(new PlacementSnapshot(
                    d.id(), d.demandId(), d.name(), d.x(), d.y(), d.w(), d.l(),
                    d.rotationDegrees(), d.rotated(), d.polygon(), d.holes(),
                    d.sourceTaskId(), d.sourceLineId()
            ));
        }
        return List.copyOf(out);
    }

    private static RollOption toRollOption(
            GlobalPlanningModels.RollTrialOutcome t,
            boolean recommended,
            Integer relayOrder,
            List<AllocatedItem> allocatedItems
    ) {
        return new RollOption(
                t.rollId(),
                GlobalPlanningModels.round1(t.widthMm()),
                GlobalPlanningModels.round1(t.availableLengthMm()),
                GlobalPlanningModels.round1(t.estimatedCutLengthMm()),
                GlobalPlanningModels.round2(t.utilizationPct()),
                t.placedCount(),
                t.feasible(),
                recommended,
                GlobalPlanningModels.cleanCoord(t.windowStartY()),
                GlobalPlanningModels.round1(t.totalLengthMm()),
                toPlacementSnapshots(t.placements()),
                t.defects(),
                GlobalPlanningModels.blankToNull(t.rollModel()),
                GlobalPlanningModels.blankToNull(t.batchNo()),
                GlobalPlanningModels.blankToNull(t.color()),
                relayOrder,
                allocatedItems
        );
    }

    private static long elapsedMillis(long startNanos) {
        return Math.max(0L, (System.nanoTime() - startNanos) / 1_000_000L);
    }
}
