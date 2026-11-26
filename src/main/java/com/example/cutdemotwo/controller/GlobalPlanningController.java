package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.business.cutting.GarmentLayPlanService;
import com.example.cutdemotwo.business.cutting.GlobalPlanningService;
import com.example.cutdemotwo.business.cutting.ProductionCostAndProcurementService;
import org.springframework.web.bind.annotation.*;

/**
 * 全局联合排产、服装自动分床与生产成本/采购分析 REST 控制器（全只读纯计算与台账聚合，绝不写库存）：
 * <ul>
 *   <li>{@code POST /api/v2/planning/multi-material}：多料头接力 + 多母卷门幅对比联合排产；</li>
 *   <li>{@code POST /api/v2/planning/cut-plan}：服装订单颜色×尺码多床自动分床；</li>
 *   <li>{@code GET  /api/v2/analytics/cost-summary}：订单与材质型号实绩成本核算；</li>
 *   <li>{@code GET  /api/v2/analytics/procurement-suggestions}：跨订单安全库存预警与备料采购建议。</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/v2")
public class GlobalPlanningController {
    private final GlobalPlanningService globalPlanningService;
    private final GarmentLayPlanService garmentLayPlanService;
    private final ProductionCostAndProcurementService costAndProcurementService;

    public GlobalPlanningController(
            GlobalPlanningService globalPlanningService,
            GarmentLayPlanService garmentLayPlanService,
            ProductionCostAndProcurementService costAndProcurementService
    ) {
        this.globalPlanningService = globalPlanningService;
        this.garmentLayPlanService = garmentLayPlanService;
        this.costAndProcurementService = costAndProcurementService;
    }

    /** 多料头 + 多母卷全局联合排产（纯规划零库存写入）。 */
    @PostMapping("/planning/multi-material")
    public GlobalPlanningService.MultiMaterialPlanResult planMultiMaterial(
            @RequestBody GlobalPlanningService.MultiMaterialPlanRequest request
    ) {
        return globalPlanningService.planMultiMaterial(request);
    }

    /** 服装订单颜色×尺码多床自动分床（Cut Plan / Lay Planning，纯计算）。 */
    @PostMapping("/planning/cut-plan")
    public GarmentLayPlanService.CutPlanResult generateCutPlan(
            @RequestBody GarmentLayPlanService.CutPlanRequest request
    ) {
        return garmentLayPlanService.generateCutPlan(request);
    }

    /** 订单与型号实绩成本核算（只读聚合）。 */
    @GetMapping("/analytics/cost-summary")
    public ProductionCostAndProcurementService.CostSummaryResult getCostSummary(
            @RequestParam(defaultValue = "25.0") double defaultUnitPricePerSqm,
            @RequestParam(defaultValue = "0.7") double remnantResidualFactor
    ) {
        return costAndProcurementService.summarizeCosts(defaultUnitPricePerSqm, remnantResidualFactor);
    }

    /** 跨订单安全库存与备料采购建议（只读聚合）。 */
    @GetMapping("/analytics/procurement-suggestions")
    public ProductionCostAndProcurementService.ProcurementSuggestionsResult getProcurementSuggestions(
            @RequestParam(defaultValue = "15.0") double safetyBufferPct,
            @RequestParam(defaultValue = "50.0") double defaultRollLengthM
    ) {
        return costAndProcurementService.suggestProcurement(safetyBufferPct, defaultRollLengthM);
    }
}
