package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.ExecutionOrder;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import org.springframework.stereotype.Service;

import java.util.*;

/**
 * 生产实绩成本核算与跨订单安全库存采购建议服务（纯只读聚合、零库存写入）：
 * <ul>
 *   <li>成本核算严格遵循 {@link InventoryJournal} 与 {@link CuttingStatePort.ReadView#projectQuality} 净良品口径：
 *       排除已撤销报工（REVERSED），计入未撤销复检判废扣减与复检转料头面积，忽略已撤销复检处置；</li>
 *   <li>母卷单价优先采用 {@code unitPricePerSqm}，其次由 {@code unitPricePerMeter / (width/1000)} 折算；
 *       缺失时回退至查询参数 {@code defaultUnitPricePerSqm} 并显式标记 {@code estimatedPricing = true}；</li>
 *   <li>跨订单安全库存采购建议按材质型号汇总「活跃任务未排余量 openQty + AWAITING_ROLL 待绑卷方案缺口」与
 *       「在库净可用母卷 + 净可用料头」，叠加安全缓冲输出分级预警与推荐采购门幅/米数/卷数。</li>
 * </ul>
 */
@Service
public class ProductionCostAndProcurementService {
    private static final String DEFAULT_CURRENCY = "CNY";
    private static final double DEFAULT_FALLBACK_WIDTH_MM = 1500.0;

    private final RemnantService remnantService;
    private final CuttingStatePort statePort;

    public ProductionCostAndProcurementService(RemnantService remnantService) {
        this.remnantService = Objects.requireNonNull(remnantService, "remnantService");
        this.statePort = remnantService;
    }

    // ==================== 1. 实绩成本核算契约 ====================

    public record CostTotals(
            int totalReports,
            double totalConsumedAreaM2,
            double netGoodAreaM2,
            int netGoodPieceCount,
            double recoveredRemnantAreaM2,
            double wasteAreaM2,
            double totalMaterialCost,
            double recoveredResidualValue,
            double netEffectiveCost,
            double wasteCost,
            double avgCostPerGoodSqm,
            double avgCostPerGoodPiece,
            double estimatedWeightKg,
            boolean estimatedPricing
    ) {}

    public record TaskCostItem(
            String taskId,
            String taskName,
            String materialModel,
            int reportCount,
            double totalConsumedAreaM2,
            double netGoodAreaM2,
            int netGoodPieceCount,
            double recoveredRemnantAreaM2,
            double wasteAreaM2,
            double totalMaterialCost,
            double recoveredResidualValue,
            double netEffectiveCost,
            double wasteCost,
            double avgCostPerGoodSqm,
            double avgCostPerGoodPiece,
            boolean estimatedPricing
    ) {}

    public record MaterialModelCostItem(
            String materialModel,
            int reportCount,
            double totalConsumedAreaM2,
            double netGoodAreaM2,
            int netGoodPieceCount,
            double recoveredRemnantAreaM2,
            double wasteAreaM2,
            double totalMaterialCost,
            double recoveredResidualValue,
            double netEffectiveCost,
            double wasteCost,
            double avgCostPerGoodSqm,
            double estimatedWeightKg,
            boolean estimatedPricing
    ) {}

    public record CostSummaryResult(
            String currency,
            double defaultUnitPricePerSqm,
            double remnantResidualFactor,
            boolean estimatedPricing,
            CostTotals summary,
            List<TaskCostItem> byTask,
            List<MaterialModelCostItem> byMaterialModel
    ) {}

    // ==================== 2. 采购备料建议契约 ====================

    public record ProcurementSuggestionItem(
            String materialModel,
            double demandAreaM2,
            double requiredWithBufferAreaM2,
            double availableRollAreaM2,
            double availableRemnantAreaM2,
            double netAvailableAreaM2,
            double shortageAreaM2,
            double recommendedWidthMm,
            double recommendedLengthM,
            int recommendedRolls,
            String alertLevel,
            int pendingTaskCount,
            List<String> activeBatches
    ) {}

    public record ProcurementSuggestionsResult(
            double safetyBufferPct,
            double defaultRollLengthM,
            int totalModels,
            int shortageModels,
            List<ProcurementSuggestionItem> items
    ) {}

    // ==================== 1. 实绩成本核算实现 ====================

    public CostSummaryResult summarizeCosts(double defaultUnitPricePerSqm, double remnantResidualFactor) {
        if (!Double.isFinite(defaultUnitPricePerSqm) || defaultUnitPricePerSqm < 0) {
            throw new IllegalArgumentException("默认每平米单价 defaultUnitPricePerSqm 必须为非负有限数值");
        }
        if (!Double.isFinite(remnantResidualFactor) || remnantResidualFactor < 0.0 || remnantResidualFactor > 1.0) {
            throw new IllegalArgumentException("回收料头残值系数 remnantResidualFactor 必须在 0.0 至 1.0 之间");
        }

        return statePort.inRead(tx -> {
            Map<String, MotherRollInfo> rollById = new HashMap<>();
            for (MotherRollInfo roll : remnantService.getMotherRolls()) {
                rollById.put(roll.getRollId(), roll);
            }
            Map<String, RemnantStock> remnantById = new HashMap<>();
            for (RemnantStock rem : remnantService.getAllRemnants()) {
                remnantById.put(rem.getId(), rem);
            }
            Map<String, CuttingTask> taskById = new HashMap<>();
            for (CuttingTask t : tx.listTasks()) {
                taskById.put(t.id(), t);
            }

            CostAccumulator grand = new CostAccumulator();
            Map<String, TaskAccumulator> taskAccs = new LinkedHashMap<>();
            Map<String, CostAccumulator> modelAccs = new LinkedHashMap<>();

            for (Map<String, Object> raw : tx.listReceipts()) {
                if ("REVERSED".equals(raw.get("status"))) continue;
                if (!(raw.get("usedArea") instanceof Number) || !(raw.get("pieceArea") instanceof Number)) continue;

                Map<String, Object> projected = tx.projectQuality(raw);
                double consumedArea = numberOf(projected.get("usedArea"));
                double netGoodArea = Math.max(0.0, numberOf(projected.get("netPieceArea")));
                int netGoodPieces = Math.max(0, intOf(projected.get("netFinishedPieceCount")));
                double recoveredRemArea = Math.max(0.0, numberOf(projected.get("netRemArea")));
                double wasteArea = Math.max(0.0, numberOf(projected.get("netWasteArea")));

                String planId = Objects.toString(raw.get("planId"), "");
                CuttingPlan plan = tx.findPlan(planId).orElse(null);
                String rollId = raw.get("rollId") != null ? raw.get("rollId").toString() : null;
                String sourceRemnantId = raw.get("sourceRemnantId") != null ? raw.get("sourceRemnantId").toString() : null;
                RemnantStock sourceRemnant = sourceRemnantId != null ? remnantById.get(sourceRemnantId) : null;
                MotherRollInfo roll = rollId != null ? rollById.get(rollId) : null;
                if (roll == null && sourceRemnant != null && sourceRemnant.getSourceRollId() != null) {
                    roll = rollById.get(sourceRemnant.getSourceRollId());
                }

                // 解析单价与是否估算标记
                PricingResolution pricing = resolveUnitPricePerSqm(roll, defaultUnitPricePerSqm);
                double pricePerSqm = pricing.pricePerSqm();
                boolean estimated = pricing.estimated();

                double materialCost = consumedArea * pricePerSqm;
                double residualValue = recoveredRemArea * pricePerSqm * remnantResidualFactor;
                double netEffectiveCost = Math.max(0.0, materialCost - residualValue);
                double wasteCost = wasteArea * pricePerSqm;
                double grammage = (roll != null && roll.getGrammage() > 0) ? roll.getGrammage() : 0.0;
                double weightKg = grammage > 0 ? consumedArea * grammage / 1000.0 : 0.0;

                String primaryTaskId = raw.get("taskId") != null ? raw.get("taskId").toString() : null;
                CuttingTask primaryTask = primaryTaskId != null ? taskById.get(primaryTaskId) : null;
                String materialModel = resolveMaterialModel(primaryTask, plan, roll, sourceRemnant);

                grand.add(1, consumedArea, netGoodArea, netGoodPieces, recoveredRemArea, wasteArea,
                        materialCost, residualValue, netEffectiveCost, wasteCost, weightKg, estimated);
                modelAccs.computeIfAbsent(materialModel, k -> new CostAccumulator())
                        .add(1, consumedArea, netGoodArea, netGoodPieces, recoveredRemArea, wasteArea,
                                materialCost, residualValue, netEffectiveCost, wasteCost, weightKg, estimated);

                // 分任务归集（兼容跨任务多族合排按件数权重分摊，保证分任务合计与总览严格守恒）
                Map<String, Integer> taskWeights = extractTaskWeights(raw, primaryTaskId);
                if (taskWeights.size() <= 1) {
                    String tid = taskWeights.isEmpty() ? "UNASSIGNED" : taskWeights.keySet().iterator().next();
                    CuttingTask taskObj = taskById.get(tid);
                    String tName = taskObj != null ? taskObj.name() : "独立裁切";
                    String tModel = taskObj != null && blankToNull(taskObj.materialModel()) != null
                            ? taskObj.materialModel() : materialModel;
                    taskAccs.computeIfAbsent(tid, k -> new TaskAccumulator(tid, tName, tModel))
                            .acc.add(1, consumedArea, netGoodArea, netGoodPieces, recoveredRemArea, wasteArea,
                                    materialCost, residualValue, netEffectiveCost, wasteCost, weightKg, estimated);
                } else {
                    int totalWeight = taskWeights.values().stream().mapToInt(Integer::intValue).sum();
                    if (totalWeight <= 0) totalWeight = taskWeights.size();
                    for (Map.Entry<String, Integer> entry : taskWeights.entrySet()) {
                        String tid = entry.getKey();
                        double share = (double) Math.max(1, entry.getValue()) / totalWeight;
                        CuttingTask taskObj = taskById.get(tid);
                        String tName = taskObj != null ? taskObj.name() : tid;
                        String tModel = taskObj != null && blankToNull(taskObj.materialModel()) != null
                                ? taskObj.materialModel() : materialModel;
                        int pieceShare = (int) Math.round(netGoodPieces * share);
                        taskAccs.computeIfAbsent(tid, k -> new TaskAccumulator(tid, tName, tModel))
                                .acc.add(1,
                                        consumedArea * share,
                                        netGoodArea * share,
                                        pieceShare,
                                        recoveredRemArea * share,
                                        wasteArea * share,
                                        materialCost * share,
                                        residualValue * share,
                                        netEffectiveCost * share,
                                        wasteCost * share,
                                        weightKg * share,
                                        estimated);
                    }
                }
            }

            CostTotals totals = new CostTotals(
                    grand.reports,
                    round4(grand.consumedArea),
                    round4(grand.netGoodArea),
                    grand.netGoodPieces,
                    round4(grand.recoveredRemArea),
                    round4(grand.wasteArea),
                    round2(grand.materialCost),
                    round2(grand.residualValue),
                    round2(grand.netEffectiveCost),
                    round2(grand.wasteCost),
                    round2(grand.netGoodArea > 0 ? grand.netEffectiveCost / grand.netGoodArea : 0.0),
                    round2(grand.netGoodPieces > 0 ? grand.netEffectiveCost / grand.netGoodPieces : 0.0),
                    round3(grand.weightKg),
                    grand.estimatedPricing
            );

            List<TaskCostItem> byTask = taskAccs.values().stream()
                    .map(t -> new TaskCostItem(
                            t.taskId,
                            t.taskName,
                            t.materialModel,
                            t.acc.reports,
                            round4(t.acc.consumedArea),
                            round4(t.acc.netGoodArea),
                            t.acc.netGoodPieces,
                            round4(t.acc.recoveredRemArea),
                            round4(t.acc.wasteArea),
                            round2(t.acc.materialCost),
                            round2(t.acc.residualValue),
                            round2(t.acc.netEffectiveCost),
                            round2(t.acc.wasteCost),
                            round2(t.acc.netGoodArea > 0 ? t.acc.netEffectiveCost / t.acc.netGoodArea : 0.0),
                            round2(t.acc.netGoodPieces > 0 ? t.acc.netEffectiveCost / t.acc.netGoodPieces : 0.0),
                            t.acc.estimatedPricing
                    ))
                    .sorted(Comparator.comparingDouble(TaskCostItem::totalMaterialCost).reversed()
                            .thenComparing(TaskCostItem::taskId))
                    .toList();

            List<MaterialModelCostItem> byModel = modelAccs.entrySet().stream()
                    .map(e -> {
                        CostAccumulator a = e.getValue();
                        return new MaterialModelCostItem(
                                e.getKey(),
                                a.reports,
                                round4(a.consumedArea),
                                round4(a.netGoodArea),
                                a.netGoodPieces,
                                round4(a.recoveredRemArea),
                                round4(a.wasteArea),
                                round2(a.materialCost),
                                round2(a.residualValue),
                                round2(a.netEffectiveCost),
                                round2(a.wasteCost),
                                round2(a.netGoodArea > 0 ? a.netEffectiveCost / a.netGoodArea : 0.0),
                                round3(a.weightKg),
                                a.estimatedPricing
                        );
                    })
                    .sorted(Comparator.comparingDouble(MaterialModelCostItem::totalMaterialCost).reversed()
                            .thenComparing(MaterialModelCostItem::materialModel))
                    .toList();

            return new CostSummaryResult(
                    DEFAULT_CURRENCY,
                    round2(defaultUnitPricePerSqm),
                    round4(remnantResidualFactor),
                    grand.estimatedPricing,
                    totals,
                    byTask,
                    byModel
            );
        });
    }

    // ==================== 2. 跨订单安全库存与采购建议实现 ====================

    public ProcurementSuggestionsResult suggestProcurement(double safetyBufferPct, double defaultRollLengthM) {
        if (!Double.isFinite(safetyBufferPct) || safetyBufferPct < 0.0 || safetyBufferPct > 100.0) {
            throw new IllegalArgumentException("工艺与安全缓冲比例 safetyBufferPct 必须在 0 至 100 之间");
        }
        if (!Double.isFinite(defaultRollLengthM) || defaultRollLengthM <= 0.0 || defaultRollLengthM > 10000.0) {
            throw new IllegalArgumentException("默认单卷长度 defaultRollLengthM 必须在 (0, 10000] 米之间");
        }

        return statePort.inRead(tx -> {
            List<MotherRollInfo> allRolls = remnantService.getMotherRolls();
            List<RemnantStock> allRemnants = remnantService.getAllRemnants();
            List<SchedulingScheme> allSchemes = tx.listSchemes();
            List<CuttingTask> allTasks = tx.listTasks();
            List<ExecutionOrder> allExecutions = tx.listExecutions();
            long now = tx.operationTime();

            Map<String, MotherRollInfo> rollById = new HashMap<>();
            for (MotherRollInfo r : allRolls) rollById.put(r.getRollId(), r);

            // 预计算活跃方案与执行单锁定
            Set<String> lockedRemnants = new HashSet<>();
            Set<String> lockedRollsByExec = new HashSet<>();
            Map<String, Double> rollOccupiedByScheme = new HashMap<>();

            for (SchedulingScheme s : allSchemes) {
                if (!s.isMaterialLockActive()) continue;
                if ("REMNANT".equals(s.materialMode()) && s.remnantId() != null) {
                    lockedRemnants.add(s.remnantId());
                }
                if ("STOCK_ROLL".equals(s.materialMode()) && s.rollId() != null && s.occupiedLengthMm() > 0) {
                    rollOccupiedByScheme.merge(s.rollId(), s.occupiedLengthMm(), Double::sum);
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

            Map<String, ModelBucket> buckets = new LinkedHashMap<>();

            // A. 需求侧：汇总所有活跃任务的未排余量 (openQty)
            for (CuttingTask task : allTasks) {
                String model = blankToNull(task.materialModel());
                if (model == null) continue;
                Map<String, Integer> completed = tx.completedQuantities(task.id());
                Map<String, Integer> planned = GlobalPlanningService.computePlannedQuantities(tx, task.id());

                double taskOpenAreaM2 = 0.0;
                double taskMaxWidthMm = 0.0;
                for (CuttingTask.Line line : task.demands()) {
                    String key = String.valueOf(line.id());
                    int open = Math.max(0, line.quantity() - completed.getOrDefault(key, 0) - planned.getOrDefault(key, 0));
                    if (open <= 0) continue;
                    double pieceAreaM2 = line.shape() != null
                            ? line.shape().areaMm2() / 1_000_000.0
                            : (line.width() * line.length()) / 1_000_000.0;
                    taskOpenAreaM2 += open * pieceAreaM2;
                    double minNeededW = line.allowRotation() ? Math.min(line.width(), line.length()) : line.width();
                    taskMaxWidthMm = Math.max(taskMaxWidthMm, minNeededW);
                }
                if (taskOpenAreaM2 > 1e-9) {
                    ModelBucket b = buckets.computeIfAbsent(model, ModelBucket::new);
                    b.demandAreaM2 += taskOpenAreaM2;
                    b.pendingTaskIds.add(task.id());
                    b.maxRequiredWidthMm = Math.max(b.maxRequiredWidthMm, taskMaxWidthMm);
                    if (blankToNull(task.requiredBatchNo()) != null) {
                        b.activeBatches.add(task.requiredBatchNo().trim());
                    }
                }
            }

            // B. 需求侧：汇总 AWAITING_ROLL 方案缺口（已占 plannedQty 但尚未绑实卷，属于实打实的待备料需求）
            for (SchedulingScheme s : allSchemes) {
                if (!SchedulingScheme.STATE_AWAITING_ROLL.equals(s.state())) continue;
                String model = firstNonBlank(
                        s.suggestedRoll() != null ? s.suggestedRoll().materialModel() : null,
                        s.materialModel()
                );
                if (model == null) continue;
                double schemeAreaM2;
                double suggestedW = 0.0;
                if (s.suggestedRoll() != null && s.suggestedRoll().widthMm() > 0 && s.suggestedRoll().minLengthMm() > 0) {
                    suggestedW = s.suggestedRoll().widthMm();
                    schemeAreaM2 = suggestedW * s.suggestedRoll().minLengthMm() / 1_000_000.0;
                } else if (s.widthMm() > 0 && s.occupiedLengthMm() > 0) {
                    suggestedW = s.widthMm();
                    schemeAreaM2 = suggestedW * s.occupiedLengthMm() / 1_000_000.0;
                } else {
                    schemeAreaM2 = Math.max(0.0, s.pieceAreaM2());
                }
                if (schemeAreaM2 <= 1e-9) continue;

                ModelBucket b = buckets.computeIfAbsent(model, ModelBucket::new);
                b.demandAreaM2 += schemeAreaM2;
                if (suggestedW > 0) {
                    b.suggestedRollWidthMm = Math.max(b.suggestedRollWidthMm, suggestedW);
                }
                List<String> involved = s.involvedTaskIds();
                if (!involved.isEmpty()) {
                    b.pendingTaskIds.addAll(involved);
                } else {
                    b.pendingTaskIds.add("SCHEME:" + s.id());
                }
            }

            // C. 供给侧：汇总在库净可用母卷面积与缸号/门幅分布（同时记录所有非报废卷门幅供缺料推荐参考）
            Map<String, List<Double>> knownRollWidthsByModel = new HashMap<>();
            for (MotherRollInfo roll : allRolls) {
                String model = blankToNull(roll.getRollModel());
                if (model == null) continue;
                if (!"SCRAPPED".equalsIgnoreCase(roll.getInspectionStatus()) && roll.getWidth() > 0) {
                    knownRollWidthsByModel.computeIfAbsent(model, k -> new ArrayList<>()).add(roll.getWidth());
                }
                if (!"PASSED".equalsIgnoreCase(roll.getInspectionStatus())) continue;
                if (lockedRollsByExec.contains(roll.getRollId())) continue;
                double netLenMm = Math.max(0.0, roll.getCurrentRemainingLength() - rollOccupiedByScheme.getOrDefault(roll.getRollId(), 0.0));
                if (netLenMm <= 0 || roll.getWidth() <= 0) continue;

                ModelBucket b = buckets.computeIfAbsent(model, ModelBucket::new);
                double areaM2 = roll.getWidth() * netLenMm / 1_000_000.0;
                b.availableRollAreaM2 += areaM2;
                b.stockWidthsMm.add(roll.getWidth());
                if (blankToNull(roll.getBatchNo()) != null) {
                    b.activeBatches.add(roll.getBatchNo().trim());
                }
            }

            // D. 供给侧：汇总在库净可用料头面积
            for (RemnantStock rem : allRemnants) {
                if (!"AVAILABLE".equalsIgnoreCase(rem.getStatus())) continue;
                if (lockedRemnants.contains(rem.getId())) continue;
                MotherRollInfo sourceRoll = rem.getSourceRollId() != null ? rollById.get(rem.getSourceRollId()) : null;
                String model = firstNonBlank(rem.getMaterialBatch(), sourceRoll != null ? sourceRoll.getRollModel() : null);
                if (model == null) continue;
                double areaM2 = rem.getArea();
                if (areaM2 <= 0) continue;

                ModelBucket b = buckets.computeIfAbsent(model, ModelBucket::new);
                b.availableRemnantAreaM2 += areaM2;
                String batch = firstNonBlank(rem.getBatchNo(), sourceRoll != null ? sourceRoll.getBatchNo() : null);
                if (batch != null) {
                    b.activeBatches.add(batch);
                }
            }

            // E. 生成分级预警与推荐采购规格
            List<ProcurementSuggestionItem> items = new ArrayList<>(buckets.size());
            int shortageModels = 0;
            double factor = 1.0 + safetyBufferPct / 100.0;

            for (ModelBucket b : buckets.values()) {
                double demandArea = b.demandAreaM2;
                double requiredWithBuffer = demandArea * factor;
                double netAvailable = b.availableRollAreaM2 + b.availableRemnantAreaM2;
                double shortage = Math.max(0.0, requiredWithBuffer - netAvailable);

                String alertLevel;
                if (demandArea > 1e-6 && netAvailable < demandArea - 1e-6) {
                    alertLevel = "CRITICAL";
                } else if (shortage > 1e-6) {
                    alertLevel = "WARNING";
                } else {
                    alertLevel = "SUFFICIENT";
                }
                if (shortage > 1e-6) {
                    shortageModels++;
                }

                double recWidthMm = resolveRecommendedWidthMm(b, knownRollWidthsByModel.getOrDefault(b.materialModel, List.of()));
                double recLengthM = shortage > 1e-6 ? shortage / (recWidthMm / 1000.0) : 0.0;
                int recRolls = shortage > 1e-6 ? Math.max(1, (int) Math.ceil(recLengthM / defaultRollLengthM)) : 0;

                items.add(new ProcurementSuggestionItem(
                        b.materialModel,
                        round3(demandArea),
                        round3(requiredWithBuffer),
                        round3(b.availableRollAreaM2),
                        round3(b.availableRemnantAreaM2),
                        round3(netAvailable),
                        round3(shortage),
                        round1(recWidthMm),
                        round2(recLengthM),
                        recRolls,
                        alertLevel,
                        b.pendingTaskIds.size(),
                        List.copyOf(b.activeBatches)
                ));
            }

            items.sort(Comparator
                    .comparingInt((ProcurementSuggestionItem it) -> alertRank(it.alertLevel()))
                    .thenComparing(Comparator.comparingDouble(ProcurementSuggestionItem::shortageAreaM2).reversed())
                    .thenComparing(Comparator.comparingDouble(ProcurementSuggestionItem::demandAreaM2).reversed())
                    .thenComparing(ProcurementSuggestionItem::materialModel));

            return new ProcurementSuggestionsResult(
                    round2(safetyBufferPct),
                    round2(defaultRollLengthM),
                    items.size(),
                    shortageModels,
                    List.copyOf(items)
            );
        });
    }

    // ==================== 内部辅助类与函数 ====================

    private record PricingResolution(double pricePerSqm, boolean estimated) {}

    private static PricingResolution resolveUnitPricePerSqm(MotherRollInfo roll, double defaultUnitPricePerSqm) {
        if (roll != null) {
            if (roll.getUnitPricePerSqm() != null && Double.isFinite(roll.getUnitPricePerSqm()) && roll.getUnitPricePerSqm() >= 0) {
                return new PricingResolution(roll.getUnitPricePerSqm(), false);
            }
            if (roll.getUnitPricePerMeter() != null && Double.isFinite(roll.getUnitPricePerMeter())
                    && roll.getUnitPricePerMeter() >= 0 && roll.getWidth() > 0) {
                return new PricingResolution(roll.getUnitPricePerMeter() / (roll.getWidth() / 1000.0), false);
            }
        }
        return new PricingResolution(defaultUnitPricePerSqm, true);
    }

    private static String resolveMaterialModel(
            CuttingTask task,
            CuttingPlan plan,
            MotherRollInfo roll,
            RemnantStock sourceRemnant
    ) {
        if (task != null && blankToNull(task.materialModel()) != null) return task.materialModel().trim();
        if (plan != null && plan.request() != null && blankToNull(plan.request().getRollModel()) != null) {
            return plan.request().getRollModel().trim();
        }
        if (roll != null && blankToNull(roll.getRollModel()) != null) return roll.getRollModel().trim();
        if (sourceRemnant != null && blankToNull(sourceRemnant.getMaterialBatch()) != null) {
            return sourceRemnant.getMaterialBatch().trim();
        }
        return "未分类材质";
    }

    private static Map<String, Integer> extractTaskWeights(Map<String, Object> receipt, String primaryTaskId) {
        Map<String, Integer> weights = new LinkedHashMap<>();
        if (receipt.get("taskDemandQuantities") instanceof Map<?, ?> multi && !multi.isEmpty()) {
            for (Map.Entry<?, ?> entry : multi.entrySet()) {
                if (entry.getKey() == null) continue;
                int sum = 0;
                if (entry.getValue() instanceof Map<?, ?> lines) {
                    for (Object v : lines.values()) {
                        if (v instanceof Number n) sum += Math.max(0, n.intValue());
                    }
                }
                weights.put(entry.getKey().toString(), Math.max(1, sum));
            }
            if (!weights.isEmpty()) return weights;
        }
        if (blankToNull(primaryTaskId) != null) {
            weights.put(primaryTaskId.trim(), 1);
        }
        return weights;
    }

    private static double resolveRecommendedWidthMm(ModelBucket b, List<Double> knownRollWidthsMm) {
        if (b.suggestedRollWidthMm > 0) {
            return Math.max(b.suggestedRollWidthMm, roundUp100(b.maxRequiredWidthMm));
        }
        // 优先从在库可用门幅，其次从非报废历史/待检卷门幅中寻找满足 maxRequiredWidthMm 的主流门幅
        List<Double> candidateWidths = !b.stockWidthsMm.isEmpty() ? b.stockWidthsMm : knownRollWidthsMm;
        if (candidateWidths != null && !candidateWidths.isEmpty()) {
            Map<Long, Integer> freq = new LinkedHashMap<>();
            for (double w : candidateWidths) {
                if (w + 0.001 >= b.maxRequiredWidthMm) {
                    freq.merge(Math.round(w * 10.0), 1, Integer::sum);
                }
            }
            if (!freq.isEmpty()) {
                long bestKey = freq.entrySet().stream()
                        .max(Comparator.<Map.Entry<Long, Integer>>comparingInt(Map.Entry::getValue)
                                .thenComparingLong(Map.Entry::getKey))
                        .map(Map.Entry::getKey)
                        .orElse(0L);
                if (bestKey > 0) return bestKey / 10.0;
            }
            double maxStockW = candidateWidths.stream().mapToDouble(Double::doubleValue).max().orElse(0.0);
            if (maxStockW >= b.maxRequiredWidthMm) return maxStockW;
        }
        if (b.maxRequiredWidthMm > 0) {
            return Math.max(DEFAULT_FALLBACK_WIDTH_MM, roundUp100(b.maxRequiredWidthMm));
        }
        return DEFAULT_FALLBACK_WIDTH_MM;
    }

    private static double roundUp100(double mm) {
        if (mm <= 0) return 0.0;
        return Math.ceil(mm / 100.0) * 100.0;
    }

    private static int alertRank(String alertLevel) {
        return switch (alertLevel) {
            case "CRITICAL" -> 0;
            case "WARNING" -> 1;
            default -> 2;
        };
    }

    private static final class CostAccumulator {
        int reports;
        double consumedArea;
        double netGoodArea;
        int netGoodPieces;
        double recoveredRemArea;
        double wasteArea;
        double materialCost;
        double residualValue;
        double netEffectiveCost;
        double wasteCost;
        double weightKg;
        boolean estimatedPricing;

        void add(int reportDelta, double consumed, double good, int pieces, double rem, double waste,
                 double matCost, double resVal, double netCost, double wCost, double wtKg, boolean estimated) {
            this.reports += reportDelta;
            this.consumedArea += consumed;
            this.netGoodArea += good;
            this.netGoodPieces += pieces;
            this.recoveredRemArea += rem;
            this.wasteArea += waste;
            this.materialCost += matCost;
            this.residualValue += resVal;
            this.netEffectiveCost += netCost;
            this.wasteCost += wCost;
            this.weightKg += wtKg;
            if (estimated) this.estimatedPricing = true;
        }
    }

    private static final class TaskAccumulator {
        final String taskId;
        final String taskName;
        final String materialModel;
        final CostAccumulator acc = new CostAccumulator();

        TaskAccumulator(String taskId, String taskName, String materialModel) {
            this.taskId = taskId;
            this.taskName = taskName;
            this.materialModel = materialModel;
        }
    }

    private static final class ModelBucket {
        final String materialModel;
        double demandAreaM2;
        double availableRollAreaM2;
        double availableRemnantAreaM2;
        double maxRequiredWidthMm;
        double suggestedRollWidthMm;
        final List<Double> stockWidthsMm = new ArrayList<>();
        final Set<String> pendingTaskIds = new LinkedHashSet<>();
        final Set<String> activeBatches = new TreeSet<>();

        ModelBucket(String materialModel) {
            this.materialModel = materialModel;
        }
    }

    private static double numberOf(Object value) {
        return value instanceof Number n ? n.doubleValue() : 0.0;
    }

    private static int intOf(Object value) {
        return value instanceof Number n ? n.intValue() : 0;
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

    private static double round2(double v) {
        return Math.rint(v * 100.0) / 100.0;
    }

    private static double round3(double v) {
        return Math.rint(v * 1000.0) / 1000.0;
    }

    private static double round4(double v) {
        return Math.rint(v * 10000.0) / 10000.0;
    }
}
