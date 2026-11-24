package com.example.cutdemotwo;

import com.example.cutdemotwo.algorithm.nesting.CrossCutSolverService;
import com.example.cutdemotwo.algorithm.nesting.DeepnestSolverEngine;
import com.example.cutdemotwo.algorithm.nesting.JavaGuillotineSolverEngine;
import com.example.cutdemotwo.algorithm.nesting.SolverFactory;
import com.example.cutdemotwo.algorithm.toolpath.ToolpathOptimizerService;
import com.example.cutdemotwo.business.cutting.CuttingWorkflowService;
import com.example.cutdemotwo.business.cutting.GarmentLayPlanService;
import com.example.cutdemotwo.business.cutting.GlobalPlanningService;
import com.example.cutdemotwo.business.cutting.ProductionCostAndProcurementService;
import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.cutting.SchedulingStudioService;
import com.example.cutdemotwo.business.model.CutReport;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.PieceDemand;
import com.example.cutdemotwo.business.model.QualityDisposition;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.business.model.SolveResponse;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.persistence.FileInventoryStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 第三波核心业务单元测试：
 * 覆盖多料头多母卷联合排产、服装多床自动分床、母卷单价持久化与复检净良品成本核算、跨订单安全库存与采购建议。
 */
class GlobalPlanningAndCostTests {

    @TempDir
    Path temp;

    private SolverFactory createSolver() {
        return new SolverFactory(List.of(
                new CrossCutSolverService(),
                new JavaGuillotineSolverEngine(),
                new DeepnestSolverEngine()
        ));
    }

    // ==================== 1. 多料头 + 多母卷全局联合排产 ====================

    @Test
    void multiMaterialRelayAcrossRemnantsAndCompareRollWidthsWithoutMutatingInventory() throws Exception {
        Path stateFile = temp.resolve("multi-material.json");
        FileInventoryStore store = new FileInventoryStore(stateFile.toString());
        RemnantService inv = new RemnantService(store, false);
        SolverFactory solver = createSolver();
        GlobalPlanningService planning = new GlobalPlanningService(inv, solver);
        SchedulingStudioService studio = new SchedulingStudioService(inv, solver, new ToolpathOptimizerService());

        // 准备 3 卷不同门幅/缸号母卷：
        // - ROLL-W1600 (1600mm, 同缸 BAT-A): 恰好并排 2 片 800mm 宽裁片，最省料！
        // - ROLL-W2200 (2200mm, 同缸 BAT-A): 只能并排 2 片，边角浪费大
        // - ROLL-W1600-OTHER (1600mm, 异缸 BAT-B): 应被缸号防色差过滤掉
        MotherRollInfo rollNarrow = new MotherRollInfo(
                "ROLL-W1600", "MODEL-TC", "BAT-A", "华联织厂", "涤棉布", "藏青", 240.0, "涤棉", 1600.0, 40000.0, "R-01");
        MotherRollInfo rollWide = new MotherRollInfo(
                "ROLL-W2200", "MODEL-TC", "BAT-A", "华联织厂", "涤棉布", "藏青", 240.0, "涤棉", 2200.0, 40000.0, "R-02");
        MotherRollInfo rollOtherBatch = new MotherRollInfo(
                "ROLL-W1600-B", "MODEL-TC", "BAT-B", "华联织厂", "涤棉布", "藏青", 240.0, "涤棉", 1600.0, 40000.0, "R-03");
        inv.saveOrUpdateMotherRoll(rollNarrow);
        inv.saveOrUpdateMotherRoll(rollWide);
        inv.saveOrUpdateMotherRoll(rollOtherBatch);

        // 准备 4 块料头：
        // - REM-A1 (850x1050, AVAILABLE, BAT-A): 可切 1 片 800x1000
        // - REM-A2 (850x2050, AVAILABLE, BAT-A): 可切 2 片 800x1000
        // - REM-QUAR (1000x2000, QUARANTINED, BAT-A): 隔离料头，严禁选中
        // - REM-LOCKED (1000x2000, AVAILABLE, BAT-A): 将被活跃方案锁定，严禁选中
        RemnantStock r1 = new RemnantStock("REM-A1", 850, 1050, "A-1", "MODEL-TC", "AVAILABLE", "ROLL-W1600", false, "");
        r1.setBatchNo("BAT-A");
        r1.setColor("藏青");
        RemnantStock r2 = new RemnantStock("REM-A2", 850, 2050, "A-2", "MODEL-TC", "AVAILABLE", "ROLL-W1600", false, "");
        r2.setBatchNo("BAT-A");
        r2.setColor("藏青");
        RemnantStock rQuar = new RemnantStock("REM-QUAR", 1000, 2000, "A-3", "MODEL-TC", "QUARANTINED", "ROLL-W1600", true, "隔离待复验");
        rQuar.setBatchNo("BAT-A");
        rQuar.setColor("藏青");
        RemnantStock rLocked = new RemnantStock("REM-LOCKED", 1000, 2000, "A-4", "MODEL-TC", "AVAILABLE", "ROLL-W1600", false, "");
        rLocked.setBatchNo("BAT-A");
        rLocked.setColor("藏青");
        inv.registerRemnant(r1);
        inv.registerRemnant(r2);
        inv.registerRemnant(rQuar);
        inv.registerRemnant(rLocked);

        // 锁定 REM-LOCKED 于活跃排程方案
        CuttingTask lockTask = inv.saveTask(new CuttingTask(
                null, "锁料占位任务", "MODEL-TC", "EXT-LOCK", 0,
                List.of(new CuttingTask.Line(1, "占位片", 500, 500, 1, false))
        ));
        studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "LOCK-REM-SCHEME-001", "锁定料头方案", "RECT_2D", "curtain", "auto", "自动",
                lockTask.id(), lockTask.name(), "EXT-LOCK", "REMNANT", null, "REM-LOCKED", "MODEL-TC",
                1000, 2000, 0.0, 500, 0, 0, 12.5, 0.25, Boolean.TRUE,
                List.of(new SchedulingStudioService.DemandLineInput(1, "占位片", 500, 500, 1, false, null, null, null, null, null)),
                new SchedulingScheme.Layout2DPayload(
                        List.of(new SchedulingScheme.PlacementItem(1, 1, "占位片", 0, 0, 500, 500, 0, false, null)),
                        List.of(), List.of()
                ),
                null
        ));

        byte[] snapshotBefore = Files.readAllBytes(stateFile);
        long revBefore = inv.healthStatus().get("revision") instanceof Number n ? n.longValue() : -1;

        // 发起 7 片 800x1000 的全局联合排产：
        // 预期：REM-A1(1片) + REM-A2(2片) 接力消纳 3 片，剩余 4 片进入母卷对比并推荐 1600mm 窄卷！
        GlobalPlanningService.MultiMaterialPlanResult res = planning.planMultiMaterial(
                new GlobalPlanningService.MultiMaterialPlanRequest(
                        null, "MODEL-TC", "BAT-A", "藏青",
                        true, 5, null, 6000L, 0.0, 0.0,
                        List.of(new GlobalPlanningService.DemandItem(1, "主片", 800, 1000, 7, false, null, null))
                )
        );

        assertEquals("MODEL-TC", res.materialModel());
        assertEquals(7, res.totalRequestedPieces());
        assertEquals(3, res.placedByRemnants(), "应由两块可用料头接力排入 3 片");
        assertEquals(4, res.placedByRoll(), "剩余 4 片应由推荐母卷完整排入");
        assertEquals(0, res.unplacedPieces());
        assertEquals(2, res.remnantAllocations().size());
        assertTrue(res.remnantAllocations().stream().noneMatch(a -> "REM-QUAR".equals(a.remnantId())));
        assertTrue(res.remnantAllocations().stream().noneMatch(a -> "REM-LOCKED".equals(a.remnantId())));
        assertEquals(3, res.remnantAllocations().stream().mapToInt(GlobalPlanningService.RemnantAllocation::placedCount).sum());
        assertEquals(2.4, res.totalSavedAreaM2(), 0.01);

        // 母卷对比应只包含 BAT-A 的两卷，且推荐更省料的 1600mm 卷
        assertEquals(2, res.rollOptions().size());
        assertTrue(res.rollOptions().stream().noneMatch(r -> "ROLL-W1600-B".equals(r.rollId())));
        GlobalPlanningService.RollOption bestRoll = res.rollOptions().stream()
                .filter(GlobalPlanningService.RollOption::recommended)
                .findFirst()
                .orElseThrow();
        assertEquals("ROLL-W1600", bestRoll.rollId());
        assertTrue(bestRoll.feasible());
        assertEquals(4, bestRoll.placedCount());
        assertTrue(bestRoll.utilizationPct() > 90.0);

        // 严守零库存写入不变量
        assertArrayEquals(snapshotBefore, Files.readAllBytes(stateFile));
        assertEquals(revBefore, ((Number) inv.healthStatus().get("revision")).longValue());
    }

    @Test
    void multiMaterialFromTaskOpenQtyAndContourShapes() {
        FileInventoryStore store = new FileInventoryStore(temp.resolve("multi-task.json").toString());
        RemnantService inv = new RemnantService(store, false);
        GlobalPlanningService planning = new GlobalPlanningService(inv, createSolver());

        MotherRollInfo roll = new MotherRollInfo(
                "ROLL-POLY", "GARMENT-01", "BAT-G1", "织厂", "全棉", "白色", 180.0, "全棉", 1500.0, 20000.0, "G-01");
        inv.saveOrUpdateMotherRoll(roll);

        NestingProblem.Shape lShape = new NestingProblem.Shape("POLYGON", 500, 600, List.of(
                new NestingProblem.Point(0, 0),
                new NestingProblem.Point(500, 0),
                new NestingProblem.Point(500, 250),
                new NestingProblem.Point(250, 250),
                new NestingProblem.Point(250, 600),
                new NestingProblem.Point(0, 600)
        ));
        CuttingTask task = inv.saveTask(new CuttingTask(
                null, "异形衣片任务", "GARMENT-01", "ORD-POLY-1", 0,
                List.of(new CuttingTask.Line(1, "L型衣片", 500, 600, 4, false, lShape, Boolean.TRUE, "M", null, null))
        ));

        GlobalPlanningService.MultiMaterialPlanResult res = planning.planMultiMaterial(
                new GlobalPlanningService.MultiMaterialPlanRequest(
                        task.id(), null, null, null,
                        false, 0, null, 5000L, 5.0, 0.0, null
                )
        );

        assertEquals("GARMENT-01", res.materialModel());
        assertEquals(4, res.totalRequestedPieces());
        assertEquals(0, res.placedByRemnants());
        assertEquals(4, res.placedByRoll());
        assertEquals(0, res.unplacedPieces());
        assertEquals(1, res.rollOptions().size());
        assertTrue(res.rollOptions().get(0).feasible());
        assertTrue(res.rollOptions().get(0).recommended());
    }

    // ==================== 2. 服装订单多床自动分床 ====================

    @Test
    void garmentCutPlanFindsSingleLayExactDivisionAndRespectsZeroOvercut() {
        GarmentLayPlanService service = new GarmentLayPlanService();

        // 场景 A：单码 150 件，最大 60 层、每版最多 4 件、0% 超裁 -> 确定性搜索应找到 50层 x 3件 = 1床零超裁最优解
        GarmentLayPlanService.CutPlanResult singleOptimal = service.generateCutPlan(
                new GarmentLayPlanService.CutPlanRequest(
                        "POLO-01", "藏青", 1500.0, 60, 4,
                        null, 40.0, 200.0,
                        Map.of("M", 150), null, 1.40, 82.0, 0.0
                )
        );
        assertEquals(1, singleOptimal.layCount(), "150=50*3 应只需 1 床");
        assertEquals(150, singleOptimal.totalOrderedGarments());
        assertEquals(150, singleOptimal.totalPlannedGarments());
        assertEquals(0, singleOptimal.overcutGarments());
        assertEquals(50, singleOptimal.lays().get(0).plies());
        assertEquals(3, singleOptimal.lays().get(0).ratio().get("M"));

        // 场景 B：多尺码非整除订单，0% 超裁，严格核对每尺码守恒
        Map<String, Integer> sizes = new LinkedHashMap<>();
        sizes.put("S", 35);
        sizes.put("M", 80);
        sizes.put("L", 95);
        sizes.put("XL", 40);
        Map<String, Double> unitAreas = Map.of("S", 1.25, "M", 1.38, "L", 1.50, "XL", 1.65);

        GarmentLayPlanService.CutPlanResult multiExact = service.generateCutPlan(
                new GarmentLayPlanService.CutPlanRequest(
                        "SHIRT-2026", "白色", 1500.0, 50, 6,
                        8000.0, 50.0, 220.0,
                        sizes, unitAreas, 1.45, 84.0, 0.0
                )
        );
        assertEquals(250, multiExact.totalOrderedGarments());
        assertEquals(250, multiExact.totalPlannedGarments());
        assertEquals(0, multiExact.overcutGarments());
        assertTrue(multiExact.layCount() >= 2 && multiExact.layCount() <= 4);
        assertTrue(multiExact.estimatedWeightKg() > 0);
        assertTrue(multiExact.averageEfficiencyPct() > 75.0 && multiExact.averageEfficiencyPct() <= 100.0);
        for (GarmentLayPlanService.LayItem lay : multiExact.lays()) {
            assertTrue(lay.plies() >= 1 && lay.plies() <= 50);
            assertTrue(lay.garmentsPerMarker() >= 1 && lay.garmentsPerMarker() <= 6);
            assertTrue(lay.estimatedMarkerLengthMm() <= 8000.0 + 0.1);
        }
        for (GarmentLayPlanService.SizeAuditItem audit : multiExact.sizeAudit()) {
            assertEquals(audit.ordered(), audit.planned());
            assertEquals(0, audit.delta());
        }
    }

    @Test
    void garmentCutPlanReducesLayCountWithinOvercutLimitAndValidatesMaxLayLength() {
        GarmentLayPlanService service = new GarmentLayPlanService();

        // 场景 C：49/100/100/50 共 299 件，允许 3% 超裁（<=8 件）时应直接优化为 1 床（50 层 x 1:2:2:1，仅超裁 1 件 S）
        Map<String, Integer> sizes = new LinkedHashMap<>();
        sizes.put("S", 49);
        sizes.put("M", 100);
        sizes.put("L", 100);
        sizes.put("XL", 50);
        GarmentLayPlanService.CutPlanResult withOvercut = service.generateCutPlan(
                new GarmentLayPlanService.CutPlanRequest(
                        "JACKET-9", "炭黑", 1600.0, 50, 6,
                        null, 40.0, 260.0,
                        sizes, null, 1.50, 82.0, 3.0
                )
        );
        assertEquals(1, withOvercut.layCount(), "允许 3% 超裁时应将 299 件收口为 1 床 300 件");
        assertEquals(300, withOvercut.totalPlannedGarments());
        assertEquals(1, withOvercut.overcutGarments());
        assertTrue(withOvercut.sizeAudit().stream().allMatch(a -> a.planned() >= a.ordered() && a.delta() >= 0));

        // 场景 D：台长连单件都放不下时应报错
        assertThrows(IllegalArgumentException.class, () -> service.generateCutPlan(
                new GarmentLayPlanService.CutPlanRequest(
                        "TENT-1", "军绿", 1000.0, 20, 4,
                        500.0, 40.0, 300.0,
                        Map.of("L", 10), null, 2.0, 80.0, 0.0
                )
        ));
    }

    // ==================== 3. 实绩成本核算与复检/撤销联动 ====================

    @Test
    void costSummaryTracksPricingModesReinspectionRecoveryRevocationAndReversal() {
        FileInventoryStore store = new FileInventoryStore(temp.resolve("cost.json").toString());
        RemnantService inv = new RemnantService(store, false);
        SolverFactory solver = createSolver();
        CuttingWorkflowService workflow = new CuttingWorkflowService(solver, inv, new ToolpathOptimizerService());
        ProductionCostAndProcurementService analytics = new ProductionCostAndProcurementService(inv);

        // 母卷 1：显式配置 unitPricePerSqm = 40 元/m²
        MotherRollInfo rollPricedSqm = new MotherRollInfo(
                "ROLL-COST-1", "MODEL-A", "BAT-1", "织厂A", "高支棉", "纯白", 250.0, "全棉", 2000.0, 30000.0, "C-1");
        rollPricedSqm.setUnitPricePerSqm(40.0);
        inv.saveOrUpdateMotherRoll(rollPricedSqm);

        // 验证通过独立副本更新母卷能保留/修改单价字段且账本对账保持 BALANCED（不原地篡改内存活对象）
        MotherRollInfo rollUpdate = new MotherRollInfo(
                "ROLL-COST-1", "MODEL-A", "BAT-1", "织厂A", "高支棉", "纯白", 250.0, "全棉", 2000.0, 30000.0, "C-1");
        rollUpdate.setUnitPricePerSqm(40.0);
        rollUpdate.setUnitPricePerMeter(80.0);
        inv.saveOrUpdateMotherRoll(rollUpdate);
        MotherRollInfo reloaded = inv.getMotherRoll("ROLL-COST-1");
        assertEquals(40.0, reloaded.getUnitPricePerSqm());
        assertEquals(80.0, reloaded.getUnitPricePerMeter());
        assertEquals("BALANCED", inv.reconcileInventory().get("status"));

        // 母卷 2：未配置单价，核算时回退 defaultUnitPricePerSqm 并标 estimatedPricing=true
        MotherRollInfo rollUnpriced = new MotherRollInfo(
                "ROLL-COST-2", "MODEL-B", "BAT-2", "织厂B", "涤棉", "深灰", 200.0, "涤棉", 2000.0, 30000.0, "C-2");
        inv.saveOrUpdateMotherRoll(rollUnpriced);

        CuttingTask taskA = inv.saveTask(new CuttingTask(
                null, "实价订单A", "MODEL-A", "SO-A", 0,
                List.of(new CuttingTask.Line(1, "门帘A", 1000, 1000, 4, false))
        ));
        CuttingTask taskB = inv.saveTask(new CuttingTask(
                null, "估价订单B", "MODEL-B", "SO-B", 0,
                List.of(new CuttingTask.Line(1, "门帘B", 1000, 1000, 2, false))
        ));

        // 报工 1（任务 A，使用 ROLL-COST-1 40元/m²）：切 2 片 1000x1000（共 2 m²），窗口实切 1500mm（消耗 3.0 m²）
        SolveRequest req1 = new SolveRequest();
        req1.setSolver("javaguillotine");
        req1.setTaskId(taskA.id());
        req1.setTaskRevision(taskA.revision());
        req1.setRollId("ROLL-COST-1");
        req1.setRollModel("MODEL-A");
        req1.setRollW(2000);
        req1.setRollL(1500);
        req1.setTotalRollL(30000);
        req1.setWindowStartY(0);
        req1.setAllowLongitudinal(true);
        req1.setDemands(List.of(new PieceDemand(1, "门帘A", 1000, 1000, 2, false)));
        SolveResponse plan1 = workflow.solve(req1);
        assertTrue(plan1.isSuccess(), plan1.getMessage());
        inv.confirmPlan(new CutReport(plan1.getPlanId(), 1500.0, 2, List.of(), "A区"));

        // 先验：仅 1 笔实价报工时，estimatedPricing 必须为 false
        var summaryBeforeDisp = analytics.summarizeCosts(25.0, 0.7);
        assertFalse(summaryBeforeDisp.estimatedPricing());
        assertEquals(1, summaryBeforeDisp.summary().totalReports());
        assertEquals(3.0, summaryBeforeDisp.summary().totalConsumedAreaM2(), 0.001);
        assertEquals(2.0, summaryBeforeDisp.summary().netGoodAreaM2(), 0.001);
        assertEquals(120.0, summaryBeforeDisp.summary().totalMaterialCost(), 0.01);
        assertEquals(120.0, summaryBeforeDisp.summary().netEffectiveCost(), 0.01);
        assertEquals(40.0, summaryBeforeDisp.summary().wasteCost(), 0.01);
        assertEquals(60.0, summaryBeforeDisp.summary().avgCostPerGoodSqm(), 0.01);

        // 对第 1 片良品执行复检判废并回收一块 600x800 (0.48 m²) 可用料头
        int firstPieceId = plan1.getPieces().get(0).getId();
        QualityDisposition disp = inv.disposeQuality(plan1.getPlanId(), new QualityDisposition.Command(
                "DISP-COST-TEST-0001", 0, firstPieceId, "REMNANT", "边角脏污裁切回收", "质检员李明",
                new QualityDisposition.Recovery(0, 0, 600, 800, "R-REC", "RECOVERABLE")
        ));

        // 复检后核对：消耗仍为 3.0 m²（120元），净良品降至 1.0 m²，回收 0.48 m²（残值 0.48*40*0.7=13.44元），净有效成本 106.56 元
        var summaryAfterDisp = analytics.summarizeCosts(25.0, 0.7);
        assertEquals(3.0, summaryAfterDisp.summary().totalConsumedAreaM2(), 0.001);
        assertEquals(1.0, summaryAfterDisp.summary().netGoodAreaM2(), 0.001);
        assertEquals(1, summaryAfterDisp.summary().netGoodPieceCount());
        assertEquals(0.48, summaryAfterDisp.summary().recoveredRemnantAreaM2(), 0.001);
        assertEquals(1.52, summaryAfterDisp.summary().wasteAreaM2(), 0.001);
        assertEquals(13.44, summaryAfterDisp.summary().recoveredResidualValue(), 0.01);
        assertEquals(106.56, summaryAfterDisp.summary().netEffectiveCost(), 0.01);
        assertEquals(60.8, summaryAfterDisp.summary().wasteCost(), 0.01);
        assertEquals(106.56, summaryAfterDisp.summary().avgCostPerGoodSqm(), 0.01);

        // 撤销该复检处置 -> 成本与净良品指标必须精准恢复至复检前！
        inv.revokeQualityDisposition(plan1.getPlanId(), disp.id(),
                new RemnantService.RevokeDispositionCommand("REVOKE-COST-001", "质检主管", "复核误判撤销"));
        var summaryAfterRevoke = analytics.summarizeCosts(25.0, 0.7);
        assertEquals(2.0, summaryAfterRevoke.summary().netGoodAreaM2(), 0.001);
        assertEquals(0.0, summaryAfterRevoke.summary().recoveredRemnantAreaM2(), 0.001);
        assertEquals(120.0, summaryAfterRevoke.summary().netEffectiveCost(), 0.01);

        // 报工 2（任务 B，未配单价 -> 回退 25 元/m²，estimatedPricing=true）
        SolveRequest req2 = new SolveRequest();
        req2.setSolver("javaguillotine");
        req2.setTaskId(taskB.id());
        req2.setTaskRevision(taskB.revision());
        req2.setRollId("ROLL-COST-2");
        req2.setRollModel("MODEL-B");
        req2.setRollW(2000);
        req2.setRollL(1000);
        req2.setTotalRollL(30000);
        req2.setWindowStartY(0);
        req2.setAllowLongitudinal(true);
        req2.setDemands(List.of(new PieceDemand(1, "门帘B", 1000, 1000, 2, false)));
        SolveResponse plan2 = workflow.solve(req2);
        assertTrue(plan2.isSuccess(), plan2.getMessage());
        inv.confirmPlan(new CutReport(plan2.getPlanId(), 1000.0, 2, List.of(), "B区"));

        var combined = analytics.summarizeCosts(25.0, 0.7);
        assertTrue(combined.estimatedPricing());
        assertEquals(2, combined.summary().totalReports());
        assertEquals(2, combined.byTask().size());
        assertEquals(2, combined.byMaterialModel().size());
        // 报工2 消耗 2.0 m² * 25 = 50 元，合计 120 + 50 = 170 元
        assertEquals(170.0, combined.summary().totalMaterialCost(), 0.01);
        assertTrue(combined.byTask().stream().anyMatch(t -> t.taskId().equals(taskA.id()) && !t.estimatedPricing()));
        assertTrue(combined.byTask().stream().anyMatch(t -> t.taskId().equals(taskB.id()) && t.estimatedPricing()));

        // 冲销报工 2 -> 总报工数回落为 1，estimatedPricing 恢复为 false
        inv.reverseReport(plan2.getPlanId(), "测试整单冲销");
        var afterReverse = analytics.summarizeCosts(25.0, 0.7);
        assertEquals(1, afterReverse.summary().totalReports());
        assertFalse(afterReverse.estimatedPricing());
        assertEquals(120.0, afterReverse.summary().totalMaterialCost(), 0.01);

        // 母卷 3：仅配置 unitPricePerMeter = 60.0 元/米（门幅 2000mm -> 折算 30.0 元/m²，实价非估算）
        MotherRollInfo rollPerMeter = new MotherRollInfo(
                "ROLL-COST-3", "MODEL-C", "BAT-3", "织厂C", "涤纶", "天蓝", 180.0, "涤纶", 2000.0, 20000.0, "C-3");
        rollPerMeter.setUnitPricePerMeter(60.0);
        inv.saveOrUpdateMotherRoll(rollPerMeter);
        SolveRequest req3 = new SolveRequest();
        req3.setSolver("javaguillotine");
        req3.setRollId("ROLL-COST-3");
        req3.setRollModel("MODEL-C");
        req3.setRollW(2000);
        req3.setRollL(1000);
        req3.setTotalRollL(20000);
        req3.setWindowStartY(0);
        req3.setAllowLongitudinal(true);
        req3.setDemands(List.of(new PieceDemand(1, "独立片", 1000, 1000, 2, false)));
        SolveResponse plan3 = workflow.solve(req3);
        assertTrue(plan3.isSuccess(), plan3.getMessage());
        inv.confirmPlan(new CutReport(plan3.getPlanId(), 1000.0, 2, List.of(), "C区"));

        var afterMeterRoll = analytics.summarizeCosts(25.0, 0.7);
        assertFalse(afterMeterRoll.estimatedPricing(), "每米单价折算应视为实价而非默认估价");
        assertEquals(2, afterMeterRoll.summary().totalReports());
        // 报工3 消耗 2.0 m² * 30 = 60 元，合计 120 + 60 = 180 元
        assertEquals(180.0, afterMeterRoll.summary().totalMaterialCost(), 0.01);
        assertEquals("BALANCED", inv.reconcileInventory().get("status"));
    }

    // ==================== 4. 跨订单安全库存与采购建议 ====================

    @Test
    void procurementSuggestionsClassifyCriticalWarningSufficientAndCountAwaitingRollSchemes() {
        FileInventoryStore store = new FileInventoryStore(temp.resolve("procurement.json").toString());
        RemnantService inv = new RemnantService(store, false);
        SolverFactory solver = createSolver();
        SchedulingStudioService studio = new SchedulingStudioService(inv, solver, new ToolpathOptimizerService());
        ProductionCostAndProcurementService analytics = new ProductionCostAndProcurementService(inv);

        // 型号 CRIT-M：需求 = 任务 openQty 40m² + AWAITING_ROLL 方案 20m² = 60m²；
        // 在库母卷 2000mm x 15000mm (30m²) + 可用料头 2000mm x 2500mm (5m²) = 35m² < 60m² -> CRITICAL
        MotherRollInfo rollCrit = new MotherRollInfo(
                "ROLL-CRIT", "CRIT-M", "BAT-C1", "织厂", "布C", "黑", 200.0, "棉", 2000.0, 15000.0, "P-1");
        inv.saveOrUpdateMotherRoll(rollCrit);
        RemnantStock remCrit = new RemnantStock("REM-CRIT", 2000, 2500, "P-R1", "CRIT-M", "AVAILABLE", "ROLL-CRIT", false, "");
        remCrit.setBatchNo("BAT-C1");
        inv.registerRemnant(remCrit);

        CuttingTask taskCrit = inv.saveTask(new CuttingTask(
                null, "紧缺任务", "CRIT-M", "PO-C1", 0,
                List.of(new CuttingTask.Line(1, "大帘", 2000, 2000, 15, false)),
                null, null, null, null, null, null, null, "BAT-C1", null, null, null, null, null, null
        ));
        // 选定其中 5 片为虚拟卷 AWAITING_ROLL（5 片转 plannedQty，方案占 2000mm x 10000mm = 20m²；其余 10 片保留 openQty = 40m²）
        studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "AWAIT-CRIT-001", "待绑卷虚拟方案", "RECT_2D", "curtain", "auto", "自动",
                taskCrit.id(), taskCrit.name(), "PO-C1", "VIRTUAL_ROLL", null, null, "CRIT-M",
                2000, 10000, 0.0, 10000, 0, 0, 100.0, 20.0, Boolean.TRUE,
                List.of(new SchedulingStudioService.DemandLineInput(1, "大帘", 2000, 2000, 5, false, null, null, null, null, null)),
                new SchedulingScheme.Layout2DPayload(
                        List.of(
                                new SchedulingScheme.PlacementItem(1, 1, "大帘", 0, 0, 2000, 2000, 0, false, null),
                                new SchedulingScheme.PlacementItem(2, 1, "大帘", 0, 2000, 2000, 2000, 0, false, null),
                                new SchedulingScheme.PlacementItem(3, 1, "大帘", 0, 4000, 2000, 2000, 0, false, null),
                                new SchedulingScheme.PlacementItem(4, 1, "大帘", 0, 6000, 2000, 2000, 0, false, null),
                                new SchedulingScheme.PlacementItem(5, 1, "大帘", 0, 8000, 2000, 2000, 0, false, null)
                        ),
                        List.of(), List.of()
                ),
                null
        ));

        // 型号 WARN-M：需求 100m²，加 15% 缓冲 = 115m²；在库 105m²（满足硬需求但低于缓冲） -> WARNING
        inv.saveOrUpdateMotherRoll(new MotherRollInfo(
                "ROLL-WARN", "WARN-M", "BAT-W1", "织厂", "布W", "灰", 200.0, "棉", 1500.0, 70000.0, "P-2"));
        inv.saveTask(new CuttingTask(
                null, "预警任务", "WARN-M", "PO-W1", 0,
                List.of(new CuttingTask.Line(1, "中帘", 1000, 2000, 50, false))
        ));

        // 型号 SUFF-M：需求 10m²，加 15% 缓冲 = 11.5m²；在库 60m² -> SUFFICIENT
        inv.saveOrUpdateMotherRoll(new MotherRollInfo(
                "ROLL-SUFF", "SUFF-M", "BAT-S1", "织厂", "布S", "白", 200.0, "棉", 2000.0, 30000.0, "P-3"));
        inv.saveTask(new CuttingTask(
                null, "充裕任务", "SUFF-M", "PO-S1", 0,
                List.of(new CuttingTask.Line(1, "小帘", 1000, 1000, 10, false))
        ));

        var result = analytics.suggestProcurement(15.0, 50.0);
        assertEquals(15.0, result.safetyBufferPct());
        assertEquals(50.0, result.defaultRollLengthM());
        assertEquals(3, result.totalModels());
        assertEquals(2, result.shortageModels());

        // 排序必须为 CRITICAL -> WARNING -> SUFFICIENT
        assertEquals("CRIT-M", result.items().get(0).materialModel());
        assertEquals("CRITICAL", result.items().get(0).alertLevel());
        assertEquals(60.0, result.items().get(0).demandAreaM2(), 0.01);
        assertEquals(69.0, result.items().get(0).requiredWithBufferAreaM2(), 0.01);
        assertEquals(30.0, result.items().get(0).availableRollAreaM2(), 0.01);
        assertEquals(5.0, result.items().get(0).availableRemnantAreaM2(), 0.01);
        assertEquals(35.0, result.items().get(0).netAvailableAreaM2(), 0.01);
        assertEquals(34.0, result.items().get(0).shortageAreaM2(), 0.01);
        assertEquals(2000.0, result.items().get(0).recommendedWidthMm(), 0.1);
        assertEquals(17.0, result.items().get(0).recommendedLengthM(), 0.01);
        assertEquals(1, result.items().get(0).recommendedRolls());
        assertEquals(1, result.items().get(0).pendingTaskCount());
        assertTrue(result.items().get(0).activeBatches().contains("BAT-C1"));

        assertEquals("WARN-M", result.items().get(1).materialModel());
        assertEquals("WARNING", result.items().get(1).alertLevel());
        assertEquals(10.0, result.items().get(1).shortageAreaM2(), 0.01);
        assertTrue(result.items().get(1).recommendedRolls() >= 1);

        assertEquals("SUFF-M", result.items().get(2).materialModel());
        assertEquals("SUFFICIENT", result.items().get(2).alertLevel());
        assertEquals(0.0, result.items().get(2).shortageAreaM2(), 0.001);
        assertEquals(0, result.items().get(2).recommendedRolls());
    }
}
