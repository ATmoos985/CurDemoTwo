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
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
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

    @Test
    void multiMaterialHandlesSubTenthMillimeterRemnantAndRollDimensionsGracefully() {
        FileInventoryStore store = new FileInventoryStore(temp.resolve("sub-tenth-precision.json").toString());
        RemnantService inv = new RemnantService(store, false);
        GlobalPlanningService planner = new GlobalPlanningService(inv, createSolver());

        MotherRollInfo roll = new MotherRollInfo(
                "ROLL-FRAC", "FRAC-M", "BAT-F", "织厂", "面料F", "灰", 200.0, "涤", 1500.0, 20000.0, "P-F");
        roll.setUsedLength(1234.57); // 非 0.1 mm 对齐的实切余长
        roll.setCurrentRemainingLength(18765.43);
        inv.saveOrUpdateMotherRoll(roll);

        RemnantStock rem = new RemnantStock(
                "REM-FRAC-1", 612.34, 1523.78, "A-01", "FRAC-M", "AVAILABLE", "ROLL-FRAC", false, "");
        rem.setBatchNo("BAT-F");
        inv.registerRemnant(rem);

        var res = planner.planMultiMaterial(new GlobalPlanningService.MultiMaterialPlanRequest(
                null, "FRAC-M", null, null, true, 5, null, 3000L, 4.0, 20.0,
                List.of(new GlobalPlanningService.DemandItem(1, "片A", 580, 740, 4, true, null, null))
        ));

        assertEquals(4, res.totalRequestedPieces());
        assertEquals(0, res.unplacedPieces());
        assertTrue(res.placedByRemnants() >= 1, "应保守对齐 0.1mm 格网并成功消耗非整数尾数料头");
        assertFalse(res.rollOptions().isEmpty());
    }

    // ==================== 5. 后端业务准确度专项强校验回归 ====================

    @Test
    void costSummaryAttributesCrossTaskReinspectionPerPieceAndMatchesCompletedQuantities() {
        Path stateFile = temp.resolve("cross-task-reinspection-cost.json");
        FileInventoryStore store = new FileInventoryStore(stateFile.toString());
        RemnantService inv = new RemnantService(store, false);
        SolverFactory solver = createSolver();
        SchedulingStudioService studio = new SchedulingStudioService(inv, solver, new ToolpathOptimizerService());
        ProductionCostAndProcurementService analytics = new ProductionCostAndProcurementService(inv);

        // 准备 2000mm 宽、40 元/m² 实价母卷
        MotherRollInfo roll = new MotherRollInfo(
                "ROLL-XTASK-1", "MODEL-XT", "BAT-XT", "织厂XT", "棉布", "藏青", 200.0, "全棉", 2000.0, 20000.0, "X-01");
        roll.setUnitPricePerSqm(40.0);
        inv.saveOrUpdateMotherRoll(roll);

        // 创建任务 A（2 片 500x1000）与任务 B（2 片 500x1000）
        CuttingTask taskA = inv.saveTask(new CuttingTask(
                null, "合排任务A", "MODEL-XT", "SO-XT-A", 0,
                List.of(new CuttingTask.Line(1, "A裁片", 500, 1000, 2, false))
        ));
        CuttingTask taskB = inv.saveTask(new CuttingTask(
                null, "合排任务B", "MODEL-XT", "SO-XT-B", 0,
                List.of(new CuttingTask.Line(1, "B裁片", 500, 1000, 2, false))
        ));

        // 通过排程工作台确认跨任务合排方案（4 片并排在 2000x1500 窗口中）并报工完工
        SchedulingScheme.Layout2DPayload layout = new SchedulingScheme.Layout2DPayload(
                List.of(
                        new SchedulingScheme.PlacementItem(1, 1, "A裁片", 0, 0, 500, 1000, 0, false, null, taskA.id(), 1),
                        new SchedulingScheme.PlacementItem(2, 1, "A裁片", 500, 0, 500, 1000, 0, false, null, taskA.id(), 1),
                        new SchedulingScheme.PlacementItem(3, 2, "B裁片", 1000, 0, 500, 1000, 0, false, null, taskB.id(), 1),
                        new SchedulingScheme.PlacementItem(4, 2, "B裁片", 1500, 0, 500, 1000, 0, false, null, taskB.id(), 1)
                ),
                List.of(),
                List.of()
        );
        Map<String, Object> confirmed = studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "IDEM-XTASK-SCHEME-1", "跨任务A+B合排方案", "RECT_2D", "DEFAULT", "JAVA_FAST", "Java直刀",
                null, null, null, "STOCK_ROLL", "ROLL-XTASK-1", null, "MODEL-XT",
                2000, 1500, 0.0, 1500, 0.0, 0.0, 66.67, 2.0, Boolean.TRUE,
                null, layout, null,
                List.of(
                        new SchedulingScheme.TaskDemandAllocation(taskA.id(), 1, 2),
                        new SchedulingScheme.TaskDemandAllocation(taskB.id(), 1, 2)
                )
        ));
        SchedulingScheme scheme = (SchedulingScheme) confirmed.get("scheme");
        String planId = scheme.linkedPlanIds().get(0);

        // 完工报工：4 片全部初次合格，实切 1500mm -> 总耗用 3.0 m²（120 元）
        studio.completeScheme(scheme.id(), new SchedulingStudioService.CompleteSchemeCommand(
                1500.0, List.of(), false, "X区", "班长王五"
        ));

        // 复检前基线：任务 A、B 各 2 片 / 1.0 m² / 60 元
        var beforeDisp = analytics.summarizeCosts(25.0, 0.7);
        var beforeA = beforeDisp.byTask().stream().filter(t -> t.taskId().equals(taskA.id())).findFirst().orElseThrow();
        var beforeB = beforeDisp.byTask().stream().filter(t -> t.taskId().equals(taskB.id())).findFirst().orElseThrow();
        assertEquals(2, beforeA.netGoodPieceCount());
        assertEquals(1.0, beforeA.netGoodAreaM2(), 0.001);
        assertEquals(2, beforeB.netGoodPieceCount());
        assertEquals(1.0, beforeB.netGoodAreaM2(), 0.001);

        // 仅对任务 A 的第 1 片（pieceId = 1）执行复检判废，并回收 400x500 (0.20 m²) 可用料头
        QualityDisposition disp = inv.disposeQuality(planId, new QualityDisposition.Command(
                "DISP-XTASK-A1-0001", 0, 1, "REMNANT", "任务A裁片边角油污判废回收", "质检员张敏",
                new QualityDisposition.Recovery(0, 0, 400, 500, "R-XT", "RECOVERABLE")
        ));

        // 校验内存态 + 从磁盘重载反序列化态（覆盖 ReportedPiece 与 Map 两条解析路径）完全一致
        RemnantService reloadedInv = new RemnantService(new FileInventoryStore(stateFile.toString()), false);
        ProductionCostAndProcurementService reloadedAnalytics = new ProductionCostAndProcurementService(reloadedInv);
        for (ProductionCostAndProcurementService svc : List.of(analytics, reloadedAnalytics)) {
            var afterDisp = svc.summarizeCosts(25.0, 0.7);
            var itemA = afterDisp.byTask().stream().filter(t -> t.taskId().equals(taskA.id())).findFirst().orElseThrow();
            var itemB = afterDisp.byTask().stream().filter(t -> t.taskId().equals(taskB.id())).findFirst().orElseThrow();

            // 任务 A 精确扣减 1 片（0.5 m²），复检回收 0.20 m² 残值 5.60 元精确归属任务 A
            int completedA = inv.completedQuantities(taskA.id()).values().stream().mapToInt(Integer::intValue).sum();
            int completedB = inv.completedQuantities(taskB.id()).values().stream().mapToInt(Integer::intValue).sum();
            assertEquals(1, completedA);
            assertEquals(2, completedB);
            assertEquals(completedA, itemA.netGoodPieceCount(), "任务 A 净良品件数必须与 completedQuantities 严格一致");
            assertEquals(completedB, itemB.netGoodPieceCount(), "任务 B 净良品件数不受任务 A 判废影响且与 completedQuantities 一致");

            assertEquals(0.5, itemA.netGoodAreaM2(), 0.001);
            assertEquals(1.5, itemA.totalConsumedAreaM2(), 0.001);
            assertEquals(0.2, itemA.recoveredRemnantAreaM2(), 0.001);
            assertEquals(0.8, itemA.wasteAreaM2(), 0.001);
            assertEquals(5.6, itemA.recoveredResidualValue(), 0.01);
            assertEquals(54.4, itemA.netEffectiveCost(), 0.01);

            // 任务 B 净良品、面积与成本纹丝不动
            assertEquals(1.0, itemB.netGoodAreaM2(), 0.001);
            assertEquals(1.5, itemB.totalConsumedAreaM2(), 0.001);
            assertEquals(0.0, itemB.recoveredRemnantAreaM2(), 0.001);
            assertEquals(0.5, itemB.wasteAreaM2(), 0.001);
            assertEquals(0.0, itemB.recoveredResidualValue(), 0.01);
            assertEquals(60.0, itemB.netEffectiveCost(), 0.01);

            // 整单汇总严格守恒
            assertEquals(afterDisp.summary().netGoodPieceCount(), itemA.netGoodPieceCount() + itemB.netGoodPieceCount());
            assertEquals(afterDisp.summary().netGoodAreaM2(), itemA.netGoodAreaM2() + itemB.netGoodAreaM2(), 0.001);
            assertEquals(afterDisp.summary().totalConsumedAreaM2(), itemA.totalConsumedAreaM2() + itemB.totalConsumedAreaM2(), 0.001);
            assertEquals(afterDisp.summary().recoveredRemnantAreaM2(), itemA.recoveredRemnantAreaM2() + itemB.recoveredRemnantAreaM2(), 0.001);
            assertEquals(afterDisp.summary().wasteAreaM2(), itemA.wasteAreaM2() + itemB.wasteAreaM2(), 0.001);
            assertEquals(afterDisp.summary().netEffectiveCost(), itemA.netEffectiveCost() + itemB.netEffectiveCost(), 0.01);
        }

        // 撤销任务 A 的复检处置 -> 任务 A 精准恢复 2 片，任务 B 始终 2 片
        inv.revokeQualityDisposition(planId, disp.id(),
                new RemnantService.RevokeDispositionCommand("REVOKE-XTASK-A1-01", "质检主管", "复检误判撤销"));
        var afterRevoke = analytics.summarizeCosts(25.0, 0.7);
        var revA = afterRevoke.byTask().stream().filter(t -> t.taskId().equals(taskA.id())).findFirst().orElseThrow();
        var revB = afterRevoke.byTask().stream().filter(t -> t.taskId().equals(taskB.id())).findFirst().orElseThrow();
        assertEquals(2, revA.netGoodPieceCount());
        assertEquals(1.0, revA.netGoodAreaM2(), 0.001);
        assertEquals(60.0, revA.netEffectiveCost(), 0.01);
        assertEquals(2, revB.netGoodPieceCount());
        assertEquals(1.0, revB.netGoodAreaM2(), 0.001);
        assertEquals("BALANCED", inv.reconcileInventory().get("status"));
    }

    @Test
    void procurementSuggestionsFilterNarrowAndIncompatibleBatchOrColorStock() {
        FileInventoryStore store = new FileInventoryStore(temp.resolve("procurement-filter.json").toString());
        RemnantService inv = new RemnantService(store, false);
        ProductionCostAndProcurementService analytics = new ProductionCostAndProcurementService(inv);

        // 1. 门幅与料头尺寸剔除（WIDE-ONLY）：需求 10 片 1800x1000（不旋转，共 18m²）
        //    在库：1200mm 窄卷 36m²（放不下 1800mm，必剔除）+ 1000x2000 小料头 2m²（放不下，必剔除）+ 2000mm 宽卷 10m²（可适配）
        inv.saveOrUpdateMotherRoll(new MotherRollInfo(
                "ROLL-WIDE-NARROW", "WIDE-ONLY", "BAT-W1", "织厂", "宽幅布", "灰", 200.0, "涤棉", 1200.0, 30000.0, "W-1"));
        inv.saveOrUpdateMotherRoll(new MotherRollInfo(
                "ROLL-WIDE-OK", "WIDE-ONLY", "BAT-W1", "织厂", "宽幅布", "灰", 200.0, "涤棉", 2000.0, 5000.0, "W-2"));
        inv.registerRemnant(new RemnantStock("REM-WIDE-SMALL", 1000, 2000, "W-R1", "WIDE-ONLY", "AVAILABLE", "ROLL-WIDE-NARROW", false, ""));
        inv.saveTask(new CuttingTask(
                null, "超宽幕布任务", "WIDE-ONLY", "SO-WIDE-1", 0,
                List.of(new CuttingTask.Line(1, "超宽帘", 1800, 1000, 10, false))
        ));

        // 2. 指定缸号与色号过滤（BATCH-FIXED）：要求 BAT-TARGET + 藏青，需求 20m²（10 片 1000x2000）
        //    在库：异缸 50m²（剔除）、同缸异色 50m²（剔除）、同缸同色母卷 8m² + 同缸同色料头 2m² + 异缸料头 10m²（剔除）
        inv.saveOrUpdateMotherRoll(new MotherRollInfo(
                "ROLL-BF-WRONG-BATCH", "BATCH-FIXED", "BAT-OTHER", "织厂", "色丁", "藏青", 200.0, "涤", 2000.0, 25000.0, "B-1"));
        inv.saveOrUpdateMotherRoll(new MotherRollInfo(
                "ROLL-BF-WRONG-COLOR", "BATCH-FIXED", "BAT-TARGET", "织厂", "色丁", "白色", 200.0, "涤", 2000.0, 25000.0, "B-2"));
        inv.saveOrUpdateMotherRoll(new MotherRollInfo(
                "ROLL-BF-MATCH", "BATCH-FIXED", "BAT-TARGET", "织厂", "色丁", "藏青", 200.0, "涤", 2000.0, 4000.0, "B-3"));
        RemnantStock remBfOk = new RemnantStock("REM-BF-OK", 1000, 2000, "B-R1", "BATCH-FIXED", "AVAILABLE", "ROLL-BF-MATCH", false, "");
        remBfOk.setBatchNo("BAT-TARGET");
        remBfOk.setColor("藏青");
        RemnantStock remBfWrong = new RemnantStock("REM-BF-WRONG", 2000, 5000, "B-R2", "BATCH-FIXED", "AVAILABLE", "ROLL-BF-WRONG-BATCH", false, "");
        remBfWrong.setBatchNo("BAT-OTHER");
        remBfWrong.setColor("藏青");
        inv.registerRemnant(remBfOk);
        inv.registerRemnant(remBfWrong);
        inv.saveTask(new CuttingTask(
                null, "指定缸色任务", "BATCH-FIXED", "SO-BF-1", 0,
                List.of(new CuttingTask.Line(1, "门帘", 1000, 2000, 10, false)),
                null, null, null, null, null, null, null, "BAT-TARGET", "藏青", Boolean.TRUE, null, null, null, null
        ));

        // 3. 强同缸无固定缸号（STRICT-BATCH）：strictBatchMatch=true，需求 30m²（15 片 1000x2000）
        //    在库：无缸号卷 40m²（必剔除）+ BAT-X 20m² + BAT-Y 18m²（严禁跨缸拼接成 38m²，单缸最大仅 20m² -> 必报 CRITICAL）
        inv.saveOrUpdateMotherRoll(new MotherRollInfo(
                "ROLL-SB-NOBATCH", "STRICT-BATCH", "", "织厂", "全棉", "米白", 200.0, "全棉", 2000.0, 20000.0, "S-1"));
        inv.saveOrUpdateMotherRoll(new MotherRollInfo(
                "ROLL-SB-X", "STRICT-BATCH", "BAT-X", "织厂", "全棉", "米白", 200.0, "全棉", 2000.0, 10000.0, "S-2"));
        inv.saveOrUpdateMotherRoll(new MotherRollInfo(
                "ROLL-SB-Y", "STRICT-BATCH", "BAT-Y", "织厂", "全棉", "米白", 200.0, "全棉", 2000.0, 9000.0, "S-3"));
        inv.saveTask(new CuttingTask(
                null, "强同缸单任务", "STRICT-BATCH", "SO-SB-1", 0,
                List.of(new CuttingTask.Line(1, "窗帘", 1000, 2000, 15, false)),
                null, null, null, null, null, null, null, null, null, Boolean.TRUE, null, null, null, null
        ));

        // 4. 混合无强约束兼容（MIXED-RELAXED）：任务 1 要求 BAT-1（需求 4m²），任务 2 无约束（需求 4m²），在库 BAT-1(6m²) + BAT-2(6m²) 均应可用
        inv.saveOrUpdateMotherRoll(new MotherRollInfo(
                "ROLL-MX-1", "MIXED-RELAXED", "BAT-1", "织厂", "涤棉", "蓝", 200.0, "涤棉", 1500.0, 4000.0, "M-1"));
        inv.saveOrUpdateMotherRoll(new MotherRollInfo(
                "ROLL-MX-2", "MIXED-RELAXED", "BAT-2", "织厂", "涤棉", "蓝", 200.0, "涤棉", 1500.0, 4000.0, "M-2"));
        inv.saveTask(new CuttingTask(
                null, "混合任务1", "MIXED-RELAXED", "SO-MX-1", 0,
                List.of(new CuttingTask.Line(1, "片1", 1000, 1000, 4, false)),
                null, null, null, null, null, null, null, "BAT-1", null, null, null, null, null, null
        ));
        inv.saveTask(new CuttingTask(
                null, "混合任务2", "MIXED-RELAXED", "SO-MX-2", 0,
                List.of(new CuttingTask.Line(1, "片2", 1000, 1000, 4, false))
        ));

        var result = analytics.suggestProcurement(10.0, 50.0);
        Map<String, ProductionCostAndProcurementService.ProcurementSuggestionItem> byModel = new LinkedHashMap<>();
        result.items().forEach(it -> byModel.put(it.materialModel(), it));

        // 校验 WIDE-ONLY
        var wideItem = byModel.get("WIDE-ONLY");
        assertNotNull(wideItem);
        assertEquals("CRITICAL", wideItem.alertLevel());
        assertEquals(18.0, wideItem.demandAreaM2(), 0.01);
        assertEquals(10.0, wideItem.availableRollAreaM2(), 0.01, "1200mm 窄卷应被彻底剔除");
        assertEquals(0.0, wideItem.availableRemnantAreaM2(), 0.01, "1000x2000 不可适配料头应被彻底剔除");
        assertEquals(10.0, wideItem.netAvailableAreaM2(), 0.01);
        assertEquals(9.8, wideItem.shortageAreaM2(), 0.01);
        assertTrue(wideItem.recommendedWidthMm() >= 1800.0);

        // 校验 BATCH-FIXED
        var batchItem = byModel.get("BATCH-FIXED");
        assertNotNull(batchItem);
        assertEquals("CRITICAL", batchItem.alertLevel());
        assertEquals(8.0, batchItem.availableRollAreaM2(), 0.01, "仅匹配 BAT-TARGET 且藏青色母卷可计入");
        assertEquals(2.0, batchItem.availableRemnantAreaM2(), 0.01, "仅匹配 BAT-TARGET 且藏青色料头可计入");
        assertEquals(10.0, batchItem.netAvailableAreaM2(), 0.01);
        assertEquals(12.0, batchItem.shortageAreaM2(), 0.01);

        // 校验 STRICT-BATCH
        var strictItem = byModel.get("STRICT-BATCH");
        assertNotNull(strictItem);
        assertEquals("CRITICAL", strictItem.alertLevel());
        assertEquals(20.0, strictItem.availableRollAreaM2(), 0.01, "无缸号卷必剔除且严禁跨缸拼接 BAT-X 与 BAT-Y");
        assertEquals(20.0, strictItem.netAvailableAreaM2(), 0.01);
        assertEquals(13.0, strictItem.shortageAreaM2(), 0.01);

        // 校验 MIXED-RELAXED（向后兼容）
        var mixedItem = byModel.get("MIXED-RELAXED");
        assertNotNull(mixedItem);
        assertEquals("SUFFICIENT", mixedItem.alertLevel());
        assertEquals(12.0, mixedItem.availableRollAreaM2(), 0.01);
        assertEquals(0.0, mixedItem.shortageAreaM2(), 0.01);
    }

    @Test
    void multiMaterialAllowsRotatedContourPiecesInRemnantsAndRollsWhileGuardingDisabledRotation() {
        FileInventoryStore store = new FileInventoryStore(temp.resolve("contour-rotation-prefilter.json").toString());
        RemnantService inv = new RemnantService(store, false);
        GlobalPlanningService planning = new GlobalPlanningService(inv, createSolver());

        // 场景 A：宽小于长的异形裁片（500x900），料头为宽 1000 x 长 600（不旋转放不下，90° 旋转后 900x500 可放入）
        RemnantStock remWideShort = new RemnantStock(
                "REM-CONTOUR-ROT", 1000, 600, "R-ROT", "POLY-ROT-REM", "AVAILABLE", null, false, "");
        inv.registerRemnant(remWideShort);

        NestingProblem.Shape tallLShape = new NestingProblem.Shape("POLYGON", 500, 900, List.of(
                new NestingProblem.Point(0, 0),
                new NestingProblem.Point(500, 0),
                new NestingProblem.Point(500, 300),
                new NestingProblem.Point(250, 300),
                new NestingProblem.Point(250, 900),
                new NestingProblem.Point(0, 900)
        ));

        var remRotatedRes = planning.planMultiMaterial(new GlobalPlanningService.MultiMaterialPlanRequest(
                null, "POLY-ROT-REM", null, null, true, 5, null, 5000L, 0.0, 0.0,
                List.of(new GlobalPlanningService.DemandItem(1, "长L异形片", 500, 900, 1, true, null, tallLShape))
        ));
        assertEquals(1, remRotatedRes.placedByRemnants(), "允许 90° 旋转的异形裁片应通过预筛并成功排入 1000x600 料头");
        assertEquals(0, remRotatedRes.unplacedPieces());

        // 对照：关闭旋转时同一异形片严禁排入 1000x600 料头
        var remFixedRes = planning.planMultiMaterial(new GlobalPlanningService.MultiMaterialPlanRequest(
                null, "POLY-ROT-REM", null, null, true, 5, null, 5000L, 0.0, 0.0,
                List.of(new GlobalPlanningService.DemandItem(1, "禁转长L异形片", 500, 900, 1, false, null, tallLShape))
        ));
        assertEquals(0, remFixedRes.placedByRemnants(), "禁转异形裁片长 900 超过料头长 600，绝不能误排入");
        assertEquals(1, remFixedRes.unplacedPieces());

        // 场景 B：宽大于门幅的异形裁片（900x500），母卷门幅仅 600mm（不旋转放不下，90° 旋转后宽 500 <= 600 可放入）
        inv.saveOrUpdateMotherRoll(new MotherRollInfo(
                "ROLL-NARROW-POLY", "POLY-ROT-ROLL", "BAT-PR", "织厂", "针织", "黑", 180.0, "全棉", 600.0, 5000.0, "P-ROT"));
        NestingProblem.Shape wideLShape = new NestingProblem.Shape("POLYGON", 900, 500, List.of(
                new NestingProblem.Point(0, 0),
                new NestingProblem.Point(900, 0),
                new NestingProblem.Point(900, 250),
                new NestingProblem.Point(300, 250),
                new NestingProblem.Point(300, 500),
                new NestingProblem.Point(0, 500)
        ));

        var rollRotatedRes = planning.planMultiMaterial(new GlobalPlanningService.MultiMaterialPlanRequest(
                null, "POLY-ROT-ROLL", null, null, false, 0, null, 5000L, 0.0, 0.0,
                List.of(new GlobalPlanningService.DemandItem(1, "宽L异形片", 900, 500, 2, true, null, wideLShape))
        ));
        assertEquals(2, rollRotatedRes.placedByRoll(), "允许 90° 旋转的 900x500 异形片应成功排入 600mm 门幅母卷");
        assertEquals(0, rollRotatedRes.unplacedPieces());
        assertEquals(1, rollRotatedRes.rollOptions().size());
        assertTrue(rollRotatedRes.rollOptions().get(0).feasible());
        assertTrue(rollRotatedRes.rollOptions().get(0).recommended());

        // 对照：关闭旋转时 900mm 宽异形片不能排入 600mm 窄幅卷
        var rollFixedRes = planning.planMultiMaterial(new GlobalPlanningService.MultiMaterialPlanRequest(
                null, "POLY-ROT-ROLL", null, null, false, 0, null, 5000L, 0.0, 0.0,
                List.of(new GlobalPlanningService.DemandItem(1, "禁转宽L异形片", 900, 500, 2, false, null, wideLShape))
        ));
        assertEquals(0, rollFixedRes.placedByRoll(), "禁转 900mm 宽异形片绝不能放入 600mm 门幅母卷");
        assertEquals(2, rollFixedRes.unplacedPieces());
    }

    @Test
    void windowDefectsPreservesBoundary20mmExclusionZonesAcrossStationEdges() {
        FileInventoryStore store = new FileInventoryStore(temp.resolve("boundary-20mm-defect.json").toString());
        RemnantService inv = new RemnantService(store, false);
        SolverFactory solver = createSolver();
        CuttingWorkflowService workflow = new CuttingWorkflowService(solver, inv, new ToolpathOptimizerService());
        GlobalPlanningService planning = new GlobalPlanningService(inv, solver);

        // 准备 1000mm 宽实卷，并登记两个实体完全在工位 [1000, 2000] 之外 5mm、但带 20mm 安全边距跨入工位各 15mm 的边界疵点
        MotherRollInfo roll = new MotherRollInfo(
                "ROLL-EDGE-20", "EDGE-M", "BAT-E1", "织厂", "遮光布", "米色", 260.0, "涤", 1000.0, 5000.0, "E-01");
        roll.setDefects(List.of(
                new Defect(101, 0, 985, 1000, 10, 20, "EDGE", "上边界疵点", 4, 4, "MANUAL", "MUST_AVOID", "距起点外5mm带20mm安全边距"),
                new Defect(102, 0, 2005, 1000, 10, 20, "EDGE", "下边界疵点", 4, 4, "MANUAL", "MUST_AVOID", "距终点外5mm带20mm安全边距")
        ));
        inv.saveOrUpdateMotherRoll(roll);

        CuttingTask fitTask = inv.saveTask(new CuttingTask(
                null, "边界避疵可排任务", "EDGE-M", "SO-EDGE-FIT", 0,
                List.of(new CuttingTask.Line(1, "避疵安全片", 1000, 960, 1, false))
        ));

        // 1. 通过 CuttingWorkflowService.solve 走通 windowDefects：校验 960mm 裁片成功避开两端 15mm 禁区，且两端禁区完整保留
        SolveRequest fitReq = new SolveRequest();
        fitReq.setSolver("javaguillotine");
        fitReq.setTaskId(fitTask.id());
        fitReq.setTaskRevision(fitTask.revision());
        fitReq.setRollId("ROLL-EDGE-20");
        fitReq.setRollModel("EDGE-M");
        fitReq.setRollW(1000);
        fitReq.setRollL(1000);
        fitReq.setTotalRollL(5000);
        fitReq.setWindowStartY(1000);
        fitReq.setAllowLongitudinal(true);
        fitReq.setDemands(List.of(new PieceDemand(1, "避疵安全片", 1000, 960, 1, false)));

        SolveResponse fitRes = workflow.solve(fitReq);
        assertTrue(fitRes.isSuccess(), "在净安全区 970mm 内排 960mm 裁片应成功: " + fitRes.getMessage());
        assertEquals(2, fitReq.getDefects().size(), "两个窗外 5mm + 20mm 边距的边界疵点均不得被 windowDefects 丢弃");
        Defect topProjected = fitReq.getDefects().stream().filter(d -> d.getId() == 101).findFirst().orElseThrow();
        Defect botProjected = fitReq.getDefects().stream().filter(d -> d.getId() == 102).findFirst().orElseThrow();
        assertEquals(0.0, topProjected.getY(), 0.001);
        assertEquals(15.0, topProjected.getH(), 0.001);
        assertEquals(0.0, topProjected.getMargin(), 0.001);
        assertEquals(985.0, botProjected.getY(), 0.001);
        assertEquals(15.0, botProjected.getH(), 0.001);
        assertEquals(0.0, botProjected.getMargin(), 0.001);

        PlacedPiece placed = fitRes.getPieces().get(0);
        assertTrue(placed.getY() >= 15.0 - 0.001, "裁片起点必须避开前端 15mm 边界禁区，实际 y=" + placed.getY());
        assertTrue(placed.getY() + placed.getL() <= 985.0 + 0.001,
                "裁片末端必须避开尾部 15mm 边界禁区，实际 endY=" + (placed.getY() + placed.getL()));

        // 2. 若裁片为 980mm（> 970mm 净安全区），因两端边界禁区被保留，严禁侵入禁区排入
        CuttingTask tightTask = inv.saveTask(new CuttingTask(
                null, "边界禁区超长拦截任务", "EDGE-M", "SO-EDGE-TIGHT", 0,
                List.of(new CuttingTask.Line(1, "超长干涉片", 1000, 980, 1, false))
        ));
        SolveRequest tightReq = new SolveRequest();
        tightReq.setSolver("javaguillotine");
        tightReq.setTaskId(tightTask.id());
        tightReq.setTaskRevision(tightTask.revision());
        tightReq.setRollId("ROLL-EDGE-20");
        tightReq.setRollModel("EDGE-M");
        tightReq.setRollW(1000);
        tightReq.setRollL(1000);
        tightReq.setTotalRollL(5000);
        tightReq.setWindowStartY(1000);
        tightReq.setAllowLongitudinal(true);
        tightReq.setDemands(List.of(new PieceDemand(1, "超长干涉片", 1000, 980, 1, false)));

        SolveResponse tightRes = workflow.solve(tightReq);
        assertTrue(!tightRes.isSuccess() || tightRes.getPieces().isEmpty(),
                "保留两端 15mm 边界禁区后 1000mm 工位仅剩 970mm，980mm 裁片绝不能违规排入");

        // 3. 同步验证 GlobalPlanningService.sliceDefectsForWindow 对仅剩 [1000, 2000] 区间母卷同样不丢弃 20mm 边界疵点
        MotherRollInfo planRoll = new MotherRollInfo(
                "ROLL-EDGE-PLAN", "EDGE-PLAN-M", "BAT-E2", "织厂", "遮光布", "米色", 260.0, "涤", 1000.0, 2000.0, "E-02");
        planRoll.setUsedLength(1000.0);
        planRoll.setCurrentRemainingLength(1000.0);
        planRoll.setDefects(List.of(
                new Defect(201, 0, 985, 1000, 10, 20),
                new Defect(202, 0, 2005, 1000, 10, 20)
        ));
        inv.saveOrUpdateMotherRoll(planRoll);

        var planRes = planning.planMultiMaterial(new GlobalPlanningService.MultiMaterialPlanRequest(
                null, "EDGE-PLAN-M", null, null, false, 0, List.of("ROLL-EDGE-PLAN"), 4000L, 0.0, 0.0,
                List.of(new GlobalPlanningService.DemandItem(1, "边界超长片", 1000, 980, 1, false, null, null))
        ));
        assertEquals(0, planRes.placedByRoll(), "联排 sliceDefectsForWindow 同样必须保留边界 20mm 禁区，拦截 980mm 裁片");
        assertEquals(1, planRes.unplacedPieces());
    }

    @Test
    void demandPoolAndSchemeMaterializationPreserveContourShapeHoles() {
        Path stateFile = temp.resolve("contour-holes-roundtrip.json");
        FileInventoryStore store = new FileInventoryStore(stateFile.toString());
        RemnantService inv = new RemnantService(store, false);
        SolverFactory solver = createSolver();
        SchedulingStudioService studio = new SchedulingStudioService(inv, solver, new ToolpathOptimizerService());

        // 准备在库合格母卷
        inv.saveOrUpdateMotherRoll(new MotherRollInfo(
                "ROLL-HOLE-1", "HOLE-MAT", "BAT-H1", "织厂", "工业帆布", "灰", 300.0, "帆布", 1200.0, 10000.0, "H-01"));

        // 带偏移原点的带孔异形多边形（外轮廓 [10,20]..[610,520] -> 归零后 600x500；内孔 [110,120]..[310,320] -> 归零后 [100,100]..[300,300]）
        NestingProblem.Shape rawShapeWithHole = new NestingProblem.Shape(
                "POLYGON", 600, 500,
                List.of(
                        new NestingProblem.Point(10, 20),
                        new NestingProblem.Point(610, 20),
                        new NestingProblem.Point(610, 520),
                        new NestingProblem.Point(10, 520)
                ),
                List.of(List.of(
                        new NestingProblem.Point(110, 120),
                        new NestingProblem.Point(310, 120),
                        new NestingProblem.Point(310, 320),
                        new NestingProblem.Point(110, 320)
                ))
        );

        Map<String, Object> savedFamily = studio.saveOrMergeDemandFamily(new SchedulingStudioService.SaveDemandFamilyCommand(
                null, null, "带孔法兰片需求族", "HOLE-MAT", "ORD-HOLE-01", "CONTOUR_2D",
                2000.0, 0.0, 0.0, null, null, null, null, null, null,
                List.of(new SchedulingStudioService.DemandLineInput(
                        1, "带孔法兰片", 600, 500, 1, false, null, null, null, null, rawShapeWithHole))
        ));
        String taskId = (String) savedFamily.get("id");

        // 1. 立即取回及磁盘重载后均须完整无损保留平移归零后的 shape.holes
        RemnantService reloadedInv = new RemnantService(new FileInventoryStore(stateFile.toString()), false);
        SchedulingStudioService reloadedStudio = new SchedulingStudioService(reloadedInv, solver, new ToolpathOptimizerService());
        for (SchedulingStudioService svc : List.of(studio, reloadedStudio)) {
            Map<String, Object> fetched = svc.getDemandFamily(taskId);
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> lines = (List<Map<String, Object>>) fetched.get("lines");
            assertEquals(1, lines.size());
            NestingProblem.Shape storedShape = (NestingProblem.Shape) lines.get(0).get("shape");
            assertNotNull(storedShape);
            assertEquals("POLYGON", storedShape.type());
            assertEquals(600.0, storedShape.width(), 0.001);
            assertEquals(500.0, storedShape.height(), 0.001);
            assertEquals(1, storedShape.holes().size(), "需求池保存与读取必须完整保留 shape.holes");
            List<NestingProblem.Point> hole = storedShape.holes().get(0);
            assertEquals(4, hole.size());
            assertEquals(new NestingProblem.Point(100.0, 100.0), hole.get(0));
            assertEquals(new NestingProblem.Point(300.0, 300.0), hole.get(2));
            // 净面积 = 600*500 - 200*200 = 260000 mm²
            assertEquals(260000.0, storedShape.areaMm2(), 0.01);
        }

        // 2. 方案确认与实卷物化：即使传入的 PlacementItem 省略了 holes，落库方案与底层 CuttingPlan 也须完整保留内孔
        NestingProblem.Shape outerOnlyShape = new NestingProblem.Shape("POLYGON", 600, 500, List.of(
                new NestingProblem.Point(0, 0),
                new NestingProblem.Point(600, 0),
                new NestingProblem.Point(600, 500),
                new NestingProblem.Point(0, 500)
        ));
        Map<String, Object> confirmed = studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "IDEM-HOLE-SCHEME-1", "带孔方案实卷落库", "CONTOUR_2D", "DEFAULT", "deepnest", "自主异形",
                taskId, "带孔法兰片需求族", "ORD-HOLE-01", "STOCK_ROLL", "ROLL-HOLE-1", null, "HOLE-MAT",
                1200, 1000, 0.0, 500, 0.0, 0.0, 43.33, 0.26, Boolean.TRUE,
                null,
                new SchedulingScheme.Layout2DPayload(
                        List.of(new SchedulingScheme.PlacementItem(1, 1, "带孔法兰片", 0, 0, 600, 500, 0, false, outerOnlyShape)),
                        List.of(), List.of()
                ),
                null
        ));
        SchedulingScheme scheme = (SchedulingScheme) confirmed.get("scheme");
        NestingProblem.Shape schemePlacedShape = scheme.layout2D().placements().get(0).shape();
        assertNotNull(schemePlacedShape);
        assertEquals(1, schemePlacedShape.holes().size(), "确认落库的 SchedulingScheme.layout2D.placements 必须保留内孔");
        assertEquals(new NestingProblem.Point(100.0, 100.0), schemePlacedShape.holes().get(0).get(0));

        // 校验底层物化 CuttingPlan 也完整携带 shape.holes
        var plan = inv.getPlan(scheme.linkedPlanIds().get(0));
        NestingProblem.Shape materializedShape = plan.result().getPieces().get(0).getShape();
        assertNotNull(materializedShape);
        assertEquals(1, materializedShape.holes().size(), "物化落库的 CuttingPlan 裁片必须完整保留 shape.holes");
        assertEquals(260000.0, materializedShape.areaMm2(), 0.01);
    }
}
