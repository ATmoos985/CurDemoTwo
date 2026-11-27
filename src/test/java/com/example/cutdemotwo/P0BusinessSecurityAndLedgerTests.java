package com.example.cutdemotwo;

import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.algorithm.nesting.CrossCutSolverService;
import com.example.cutdemotwo.algorithm.nesting.JavaGuillotineSolverEngine;
import com.example.cutdemotwo.algorithm.nesting.SolverFactory;
import com.example.cutdemotwo.algorithm.toolpath.ToolpathOptimizerService;
import com.example.cutdemotwo.business.cutting.CuttingWorkflowService;
import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.cutting.SchedulingStudioService;
import com.example.cutdemotwo.business.model.CutReport;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.DemandTemplate;
import com.example.cutdemotwo.business.model.ExecutionOrder;
import com.example.cutdemotwo.business.model.InventoryCount;
import com.example.cutdemotwo.business.model.InventoryTransfer;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.PieceDemand;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.controller.FabricCutController;
import com.example.cutdemotwo.persistence.FileInventoryStore;
import com.example.cutdemotwo.persistence.InventoryConflictException;
import com.example.cutdemotwo.persistence.InventorySnapshot;
import com.example.cutdemotwo.persistence.InventoryStore;
import com.example.cutdemotwo.persistence.JdbcInventoryStore;
import com.example.cutdemotwo.persistence.OptimizationTestDatabase;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.HttpStatus;

import javax.sql.DataSource;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 覆盖 P0-2 / P0-5 / P0-6 / P0-7 / P0-8 全量业务账本、锁机制、持久化优化与四重物化校验回归测试。
 */
@Tag("mysql-integration")
class P0BusinessSecurityAndLedgerTests {
    @TempDir
    Path temp;

    private SolverFactory solver() {
        return new SolverFactory(List.of(new CrossCutSolverService(), new JavaGuillotineSolverEngine()));
    }

    // ==================== P0-2：无锁版本探测、快照确定性顺序与健康探针降级 ====================

    @Test
    void refreshSkipsFullLoadWhenRemoteRevisionUnchangedAndHealthReportsStorageFailure() {
        DataSource ds = OptimizationTestDatabase.create();
        Flyway.configure().dataSource(ds).load().migrate();
        JdbcInventoryStore delegate = new JdbcInventoryStore(ds);

        AtomicInteger loadCount = new AtomicInteger();
        AtomicReference<String> injectedHealthErr = new AtomicReference<>(null);
        InventoryStore spyStore = new InventoryStore() {
            @Override public InventorySnapshot load() { loadCount.incrementAndGet(); return delegate.load(); }
            @Override public long save(InventorySnapshot snapshot) { return delegate.save(snapshot); }
            @Override public boolean shared() { return true; }
            @Override public long now() { return delegate.now(); }
            @Override public Long currentRevision() { return delegate.currentRevision(); }
            @Override public String healthCheckError() {
                return injectedHealthErr.get() != null ? injectedHealthErr.get() : delegate.healthCheckError();
            }
        };

        RemnantService inv = new RemnantService(spyStore, true);
        inv.scrapRemnant("REM-202609-001", "seed write");
        int loadsAfterWrite = loadCount.get();

        // 连续只读查询：版本号未变，不应再次触发全库 load()
        inv.getMotherRolls();
        inv.getAvailableRemnants();
        inv.listTasks();
        assertEquals(loadsAfterWrite, loadCount.get(), "版本未变化时 refresh 必须跳过全库 load()");

        // 健康探针不触发全库 load()，健康时返回 200 UP
        var controller = new FabricCutController(solver(), inv, null, List.of());
        var okHealth = controller.health();
        assertEquals(HttpStatus.OK, okHealth.getStatusCode());
        assertEquals("UP", okHealth.getBody().get("status"));
        assertEquals("UP", okHealth.getBody().get("storageStatus"));
        assertEquals(loadsAfterWrite, loadCount.get(), "/api/health 绝不能触发全库 load()");

        // 存储故障时必须真实返回 503 DOWN，严禁假 200 UP
        injectedHealthErr.set("MySQL connection refused");
        var downHealth = controller.health();
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, downHealth.getStatusCode());
        assertEquals("DOWN", downHealth.getBody().get("status"));
        assertEquals("DOWN", downHealth.getBody().get("storageStatus"));
        assertTrue(String.valueOf(downHealth.getBody().get("storageError")).contains("MySQL connection refused"));
    }

    @Test
    void inventorySnapshotPreservesDeterministicInsertionOrder() {
        Map<String, DemandTemplate> templates = new LinkedHashMap<>();
        for (int i = 1; i <= 5; i++) {
            String id = "TPL-ORDER-" + i;
            templates.put(id, new DemandTemplate(id, id, "模板" + i, "CURTAIN_2D", "RECT_2D", "",
                    2000, 2000, "MAT", List.of("S"), Map.of("S", 1), true, List.of(), null));
        }
        InventorySnapshot snap = new InventorySnapshot(
                List.of(), List.of(), Map.of(), 1, 1, Map.of(), Map.of(), 1L,
                Map.of(), List.of(), Map.of(), List.of(), Map.of(), templates, Map.of()
        );
        assertEquals(List.of("TPL-ORDER-1", "TPL-ORDER-2", "TPL-ORDER-3", "TPL-ORDER-4", "TPL-ORDER-5"),
                List.copyOf(snap.templates().keySet()));
    }

    // ==================== P0-5：初始化判空补全 & MES 单事务原子回滚 ====================

    @Test
    void demoInitializationRejectsStoreContainingOnlyTemplates() {
        var store = new FileInventoryStore(temp.resolve("only-tpl.json").toString());
        var inv = new RemnantService(store, false);
        var studio = new SchedulingStudioService(inv, solver());
        studio.saveTemplate(new DemandTemplate("TPL-EXIST", "E", "已存模板", "CURTAIN_2D", "RECT_2D", "",
                2000, 2000, "M", List.of("S"), Map.of("S", 1), true,
                List.of(new DemandTemplate.PieceSpec("片", null, 1, false, "STRICT_0", Map.of("S", new DemandTemplate.SizeGeometry(500, 500, null)))), null));
        assertThrows(IllegalArgumentException.class, inv::initializeDemoInventory);
    }

    @Test
    void mesFeedbackAtomicallyRollsBackBindingWhenCompletionFails() {
        var inv = new RemnantService(temp.resolve("mes-atomic.json").toString());
        var studio = new SchedulingStudioService(inv, solver());
        var fam = studio.saveOrMergeDemandFamily(new SchedulingStudioService.SaveDemandFamilyCommand(
                null, null, "MES原子事务任务", "TC涤棉-B2026", "MES-WO-ATOMIC", "RECT_2D",
                2000.0, 0.0, 0.0, null, null, null, null, null, null,
                List.of(new SchedulingStudioService.DemandLineInput(1, "主片", 800, 1000, 1, false, null, null, null, null, null))
        ));
        String taskId = (String) fam.get("id");
        SchedulingScheme.Layout2DPayload layout = new SchedulingScheme.Layout2DPayload(
                List.of(new SchedulingScheme.PlacementItem(1, 1, "主片", 0, 0, 800, 1000, 0, false, null)),
                List.of(), List.of()
        );
        var confirmed = studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "IDEM-MES-ATOMIC", "虚拟卷方案", "RECT_2D", "DEFAULT", "JAVA_FAST", "直刀",
                taskId, null, "MES-WO-ATOMIC", "VIRTUAL_ROLL", null, null, "TC涤棉-B2026",
                2000, 1200, null, 1000, 0, 0, 40.0, 0.8, false, null, layout, null
        ));
        String schemeId = ((SchedulingScheme) confirmed.get("scheme")).id();

        // 传入非法实切长（100mm 短于裁片末端 1000mm）：绑卷 + 完工在同一事务中必须整体回滚，不得残留已绑卷的 READY_TO_CUT 状态
        assertThrows(IllegalArgumentException.class, () -> studio.receiveMesFeedback(
                new SchedulingStudioService.MesFeedbackCommand(schemeId, "MES-FAIL-1", "ROLL-2026-0920", 100.0, List.of(), true, "A")
        ));
        SchedulingScheme afterFail = (SchedulingScheme) studio.getSchemeDetail(schemeId).get("scheme");
        assertEquals(SchedulingScheme.STATE_AWAITING_ROLL, afterFail.state(), "失败后方案必须回滚到 AWAITING_ROLL");
        assertNull(afterFail.rollId(), "失败后不得残留绑卷记录");
        assertTrue(afterFail.linkedPlanIds().isEmpty(), "失败后不得残留孤立 CuttingPlan");
        assertEquals(55000.0, inv.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength(), 0.01);
    }

    // ==================== P0-6：双轨预约锁统一、料头互斥、区间重叠与非重叠共存 ====================

    @Test
    @SuppressWarnings("unchecked")
    void activeSchemeReservationsBlockTransferCountResetScrapTaskEditLegacyReportAndOverlap() {
        var inv = new RemnantService(temp.resolve("dual-lock.json").toString());
        var studio = new SchedulingStudioService(inv, solver());
        var workflow = new CuttingWorkflowService(solver(), inv, new ToolpathOptimizerService());

        var fam = studio.saveOrMergeDemandFamily(new SchedulingStudioService.SaveDemandFamilyCommand(
                null, null, "双轨锁任务", "TC涤棉-B2026", null, "RECT_2D",
                3000.0, 0.0, 0.0, null, null, null, null, null, null,
                List.of(new SchedulingStudioService.DemandLineInput(1, "片A", 1000, 1000, 4, false, null, null, null, null, null))
        ));
        String taskId = (String) fam.get("id");

        // 1. 方案 A 锁定母卷 ROLL-2026-0920 区间 [5000, 6000]
        var layoutA = new SchedulingScheme.Layout2DPayload(
                List.of(new SchedulingScheme.PlacementItem(1, 1, "片A", 0, 0, 1000, 1000, 0, false, null)),
                List.of(), List.of()
        );
        var resA = studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "IDEM-LOCK-A", "锁卷方案A", "RECT_2D", "DEFAULT", "JAVA_FAST", "直刀",
                taskId, null, null, "STOCK_ROLL", "ROLL-2026-0920", null, "TC涤棉-B2026",
                2000, 1000, 5000.0, 1000, 0, 0, 50.0, 1.0, false, null, layoutA, null
        ));
        String schemeA = ((SchedulingScheme) resA.get("scheme")).id();

        // 2. 方案 B 锁定在库料头 REM-202609-001 (2000x1600)
        var resB = studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "IDEM-LOCK-B", "锁料头方案B", "RECT_2D", "DEFAULT", "JAVA_FAST", "直刀",
                taskId, null, null, "REMNANT", null, "REM-202609-001", "TC涤棉-B2026",
                2000, 1600, 0.0, 1000, 0, 0, 31.25, 1.0, false, null, layoutA, null
        ));
        String schemeB = ((SchedulingScheme) resB.get("scheme")).id();

        long rev = ((Number) inv.transferOptions().get("revision")).longValue();

        // 移库、盘点、重置、料头报废/领用/改状态、任务编辑全部被拦截 409
        assertThrows(InventoryConflictException.class, () -> inv.transferInventory("TR-LOCK-01",
                new InventoryTransfer.Command(rev, "库位Z", "测试", "甲", List.of(new InventoryTransfer.Material("roll", "ROLL-2026-0920")))));
        assertThrows(InventoryConflictException.class, () -> inv.transferInventory("TR-LOCK-02",
                new InventoryTransfer.Command(rev, "库位Z", "测试", "甲", List.of(new InventoryTransfer.Material("remnant", "REM-202609-001")))));
        assertThrows(InventoryConflictException.class, () -> inv.countInventory("CNT-LOCK-01",
                new InventoryCount.Command(rev, "盘点", "甲", List.of(new InventoryCount.Observation("roll", "ROLL-2026-0920", true, 2000, 55000)))));
        assertThrows(InventoryConflictException.class, () -> inv.resetRoll("ROLL-2026-0920"));
        assertThrows(InventoryConflictException.class, () -> inv.scrapRemnant("REM-202609-001", "破损"));
        assertThrows(InventoryConflictException.class, () -> inv.consumeRemnant("REM-202609-001"));
        assertThrows(InventoryConflictException.class, () -> inv.updateStatus("REM-202609-001", "QUARANTINED"));

        CuttingTask loadedTask = inv.getTask(taskId);
        assertThrows(InventoryConflictException.class, () -> inv.saveTask(new CuttingTask(
                loadedTask.id(), "篡改名", loadedTask.materialModel(), loadedTask.externalRef(),
                loadedTask.revision(), loadedTask.demands(), loadedTask.process()
        )));

        // 料头互斥：另一方案企图重复绑定 REM-202609-001 -> 409
        assertThrows(InventoryConflictException.class, () -> studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "IDEM-LOCK-REM-DUP", "抢料头", "RECT_2D", "DEFAULT", "JAVA_FAST", "直刀",
                taskId, null, null, "REMNANT", null, "REM-202609-001", "TC涤棉-B2026",
                2000, 1600, 0.0, 1000, 0, 0, 31.25, 1.0, false, null, layoutA, null
        )));

        // 母卷 requestedStartY 与方案 A [5000, 6000] 重叠（如 5500）-> 409
        assertThrows(InventoryConflictException.class, () -> studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "IDEM-LOCK-OVERLAP", "区间重叠方案", "RECT_2D", "DEFAULT", "JAVA_FAST", "直刀",
                taskId, null, null, "STOCK_ROLL", "ROLL-2026-0920", null, "TC涤棉-B2026",
                2000, 1000, 5500.0, 1000, 0, 0, 50.0, 1.0, false, null, layoutA, null
        )));

        // 旧任务汇总 taskSummaries 必须同步反映双轨预约（已预占 2 件，剩余可排 2 件）
        Map<String, Object> summary = inv.taskSummaries().stream()
                .filter(s -> taskId.equals(((CuttingTask) s.get("task")).id()))
                .findFirst().orElseThrow();
        assertEquals(2, summary.get("reserved"));
        assertEquals(2, summary.get("availableToPlan"));
        assertEquals("EXECUTION_PENDING", summary.get("status"));
        assertEquals(2, ((List<?>) summary.get("materialReservations")).size());

        // 旧执行单与旧报工入口不得抢占已被方案锁定的母卷
        SolveRequest legacyReq = new SolveRequest();
        legacyReq.setRollId("ROLL-2026-0920");
        legacyReq.setAllowLongitudinal(false);
        legacyReq.setRollL(1000);
        legacyReq.setWindowStartY(6500);
        legacyReq.setDemands(List.of(new PieceDemand(1, "旧入口", 2000, 1000, 1, false)));
        var legacyPlan = workflow.solve(legacyReq);
        assertThrows(InventoryConflictException.class, () -> workflow.confirm(new CutReport(legacyPlan.getPlanId(), 1000, 1, List.of(), "A")));

        // 同卷不重叠区间的另一方案 C [6500, 7500] 可合法创建，且方案 A 与 C 均可顺利完工（互不死锁）
        var resC = studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "IDEM-LOCK-C", "同卷非重叠方案C", "RECT_2D", "DEFAULT", "JAVA_FAST", "直刀",
                taskId, null, null, "STOCK_ROLL", "ROLL-2026-0920", null, "TC涤棉-B2026",
                2000, 1000, 6500.0, 1000, 0, 0, 50.0, 1.0, false, null, layoutA, null
        ));
        String schemeC = ((SchedulingScheme) resC.get("scheme")).id();
        assertEquals(SchedulingScheme.STATE_COMPLETED, ((SchedulingScheme) studio.completeScheme(schemeA, null).get("scheme")).state());
        assertEquals(SchedulingScheme.STATE_COMPLETED, ((SchedulingScheme) studio.completeScheme(schemeC, null).get("scheme")).state());
        assertEquals(SchedulingScheme.STATE_COMPLETED, ((SchedulingScheme) studio.completeScheme(schemeB, null).get("scheme")).state());
        assertEquals("BALANCED", inv.reconcileInventory().get("status"));
    }

    // ==================== P0-7：跨任务多族合排全链路（确认 -> 作废 -> 重排 -> 判废完工 -> 冲销） ====================

    @Test
    @SuppressWarnings("unchecked")
    void multiTaskMergedSchemeSupportsConfirmCancelPartialScrapCompleteAndReverse() {
        var inv = new RemnantService(temp.resolve("multi-task.json").toString());
        var studio = new SchedulingStudioService(inv, solver());

        var famA = studio.saveOrMergeDemandFamily(new SchedulingStudioService.SaveDemandFamilyCommand(
                null, null, "订单族A", "TC涤棉-B2026", "SO-A", "RECT_2D",
                3000.0, 0.0, 0.0, null, null, null, null, null, null,
                List.of(new SchedulingStudioService.DemandLineInput(1, "A窗帘", 800, 900, 4, false, null, null, null, null, null))
        ));
        var famB = studio.saveOrMergeDemandFamily(new SchedulingStudioService.SaveDemandFamilyCommand(
                null, null, "订单族B", "TC涤棉-B2026", "SO-B", "RECT_2D",
                3000.0, 0.0, 0.0, null, null, null, null, null, null,
                List.of(new SchedulingStudioService.DemandLineInput(1, "B窗帘", 900, 900, 2, false, null, null, null, null, null))
        ));
        String taskA = (String) famA.get("id");
        String taskB = (String) famB.get("id");
        assertEquals(2, inv.listTasks().size());

        // 合排 2 件 A + 2 件 B（共 4 件）在同一张 2000x2000 图纸上
        var layout = new SchedulingScheme.Layout2DPayload(
                List.of(
                        new SchedulingScheme.PlacementItem(1, 1, "A窗帘", 0, 0, 800, 900, 0, false, null),
                        new SchedulingScheme.PlacementItem(2, 1, "A窗帘", 800, 0, 800, 900, 0, false, null),
                        new SchedulingScheme.PlacementItem(3, 2, "B窗帘", 0, 900, 900, 900, 0, false, null),
                        new SchedulingScheme.PlacementItem(4, 2, "B窗帘", 900, 900, 900, 900, 0, false, null)
                ),
                List.of(), List.of()
        );
        var allocs = List.of(
                new SchedulingScheme.TaskDemandAllocation(taskA, 1, 2),
                new SchedulingScheme.TaskDemandAllocation(taskB, 1, 2)
        );

        // 1. 确认合排方案：绝不创建孤立第 3 个 CuttingTask
        var confirm1 = studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "IDEM-MULTI-1", "A+B合排初版", "RECT_2D", "DEFAULT", "JAVA_FAST", "直刀",
                null, null, null, "VIRTUAL_ROLL", null, null, "TC涤棉-B2026",
                2000, 1800, null, 1800, 0, 0, 85.0, 3.06, false, null, layout, null, allocs
        ));
        assertEquals(2, inv.listTasks().size(), "多族合排绝不能创建孤立重复 CuttingTask");
        String scheme1Id = ((SchedulingScheme) confirm1.get("scheme")).id();
        assertEquals(2, ((Number) studio.getDemandFamily(taskA).get("plannedTotal")).intValue());
        assertEquals(2, ((Number) studio.getDemandFamily(taskA).get("openTotal")).intValue());
        assertEquals(2, ((Number) studio.getDemandFamily(taskB).get("plannedTotal")).intValue());
        assertEquals(0, ((Number) studio.getDemandFamily(taskB).get("openTotal")).intValue());

        // 2. 作废合排方案：两族待排需求同步释放
        studio.cancelScheme(scheme1Id, "重新合排");
        assertEquals(4, ((Number) studio.getDemandFamily(taskA).get("openTotal")).intValue());
        assertEquals(2, ((Number) studio.getDemandFamily(taskB).get("openTotal")).intValue());

        // 3. 重新合排并直接锁定在库母卷（避开 8500 处疵点，用 16000 起切）
        var confirm2 = studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "IDEM-MULTI-2", "A+B合排实卷版", "RECT_2D", "DEFAULT", "JAVA_FAST", "直刀",
                null, null, null, "STOCK_ROLL", "ROLL-2026-0920", null, "TC涤棉-B2026",
                2000, 1800, 16000.0, 1800, 0, 0, 85.0, 3.06, true, null, layout, null, allocs
        ));
        SchedulingScheme scheme2 = (SchedulingScheme) confirm2.get("scheme");
        assertEquals(SchedulingScheme.STATE_READY_TO_CUT, scheme2.state());
        assertEquals(1, studio.listSchemes("READY_TO_CUT", taskB).size());

        // 4. 完工过账并判废裁片 #1（归属任务 A）：A 完成 1 件留 3 件待排，B 完成 2 件留 0 件待排
        var completed = studio.completeScheme(scheme2.id(),
                new SchedulingStudioService.CompleteSchemeCommand(null, List.of(1), true, "余料架", "王工"));
        assertEquals(SchedulingScheme.STATE_COMPLETED, ((SchedulingScheme) completed.get("scheme")).state());
        assertEquals(1, ((Number) studio.getDemandFamily(taskA).get("completedTotal")).intValue());
        assertEquals(3, ((Number) studio.getDemandFamily(taskA).get("openTotal")).intValue());
        assertEquals(2, ((Number) studio.getDemandFamily(taskB).get("completedTotal")).intValue());
        assertEquals(0, ((Number) studio.getDemandFamily(taskB).get("openTotal")).intValue());
        assertEquals("BALANCED", inv.reconcileInventory().get("status"));

        // 5. 冲销报工：方案变为 REVERSED，任务 A 与 B 完成量同步归零、需求全部释回
        String planId = scheme2.linkedPlanIds().get(0);
        inv.reverseReport(planId, "合排整单误报冲销");
        assertEquals(SchedulingScheme.STATE_REVERSED, ((SchedulingScheme) studio.getSchemeDetail(scheme2.id()).get("scheme")).state());
        assertEquals(0, ((Number) studio.getDemandFamily(taskA).get("completedTotal")).intValue());
        assertEquals(4, ((Number) studio.getDemandFamily(taskA).get("openTotal")).intValue());
        assertEquals(0, ((Number) studio.getDemandFamily(taskB).get("completedTotal")).intValue());
        assertEquals(2, ((Number) studio.getDemandFamily(taskB).get("openTotal")).intValue());
        assertEquals("BALANCED", inv.reconcileInventory().get("status"));
    }

    // ==================== P0-8：虚拟画布碰撞/间距/修边校验、禁止篡改旋转、1D 禁丢车与工艺校验 ====================

    @Test
    void materializationRejectsOverlapGapTrimViolationUnauthorizedRotationAndSilent1DCarDrop() {
        var inv = new RemnantService(temp.resolve("p0-8.json").toString());
        var studio = new SchedulingStudioService(inv, solver());

        var fam = studio.saveOrMergeDemandFamily(new SchedulingStudioService.SaveDemandFamilyCommand(
                null, null, "严格工艺族", "TC涤棉-B2026", null, "RECT_2D",
                3000.0, 50.0, 20.0, null, null, null, null, null, null,
                List.of(new SchedulingStudioService.DemandLineInput(1, "不可旋片", 600, 900, 4, false, null, null, null, null, null))
        ));
        String taskId = (String) fam.get("id");

        // 1. 虚拟母卷两片重叠 -> 拒绝
        var overlapLayout = new SchedulingScheme.Layout2DPayload(
                List.of(
                        new SchedulingScheme.PlacementItem(1, 1, "不可旋片", 0, 50, 600, 900, 0, false, null),
                        new SchedulingScheme.PlacementItem(2, 1, "不可旋片", 300, 50, 600, 900, 0, false, null)
                ), List.of(), List.of()
        );
        assertThrows(IllegalArgumentException.class, () -> studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "IDEM-OVLP", "重叠", "RECT_2D", "DEFAULT", "JAVA_FAST", "直刀",
                taskId, null, null, "VIRTUAL_ROLL", null, null, "TC涤棉-B2026",
                2000, 1500, null, 1000, 50, 0, 50, 1.08, false, null, overlapLayout, null
        )));

        // 2. 虚拟母卷侵入 trimStartMm=50 -> 拒绝
        var trimLayout = new SchedulingScheme.Layout2DPayload(
                List.of(new SchedulingScheme.PlacementItem(1, 1, "不可旋片", 0, 10, 600, 900, 0, false, null)),
                List.of(), List.of()
        );
        assertThrows(IllegalArgumentException.class, () -> studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "IDEM-TRIM", "侵入修边", "RECT_2D", "DEFAULT", "JAVA_FAST", "直刀",
                taskId, null, null, "VIRTUAL_ROLL", null, null, "TC涤棉-B2026",
                2000, 1500, null, 1000, 50, 0, 50, 0.54, false, null, trimLayout, null
        )));

        // 3. 虚拟母卷违反 pieceGapMm=20（实际间距仅 5mm）-> 拒绝
        var gapLayout = new SchedulingScheme.Layout2DPayload(
                List.of(
                        new SchedulingScheme.PlacementItem(1, 1, "不可旋片", 0, 50, 600, 900, 0, false, null),
                        new SchedulingScheme.PlacementItem(2, 1, "不可旋片", 605, 50, 600, 900, 0, false, null)
                ), List.of(), List.of()
        );
        assertThrows(IllegalArgumentException.class, () -> studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "IDEM-GAP", "间距不足", "RECT_2D", "DEFAULT", "JAVA_FAST", "直刀",
                taskId, null, null, "VIRTUAL_ROLL", null, null, "TC涤棉-B2026",
                2000, 1500, null, 1000, 50, 20, 50, 1.08, false, null, gapLayout, null
        )));

        // 4. 越权 90° 旋转：直接拒绝，且绝不反向篡改 CuttingTask 的 allowRotation=false
        var rotLayout = new SchedulingScheme.Layout2DPayload(
                List.of(new SchedulingScheme.PlacementItem(1, 1, "不可旋片", 0, 50, 900, 600, 90, false, null)),
                List.of(), List.of()
        );
        assertThrows(IllegalArgumentException.class, () -> studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "IDEM-ROT", "越权旋转", "RECT_2D", "DEFAULT", "JAVA_FAST", "直刀",
                taskId, null, null, "STOCK_ROLL", "ROLL-2026-0920", null, "TC涤棉-B2026",
                2000, 1000, 5000.0, 900, 50, 0, 50, 0.54, false, null, rotLayout, null
        )));
        assertFalse(inv.getTask(taskId).demands().get(0).allowRotation(), "绝不允许反向篡改原任务旋转许可");

        // 5. 1D 物化母卷余长只够放 1 车而方案需 2 车 -> 必须报错拒绝，严禁静默丢车
        MotherRollInfo shortRoll = new MotherRollInfo(
                "ROLL-SHORT-1D", "短膜-2000", "BAT-S", "厂", "膜", "白", 100, "PET", 2000, 3000, "库位S"
        );
        inv.saveOrUpdateMotherRoll(shortRoll);
        var slitFam = studio.saveOrMergeDemandFamily(new SchedulingStudioService.SaveDemandFamilyCommand(
                null, null, "短卷分切族", "短膜-2000", null, "SLITTING_1D",
                null, 0.0, 0.0, 10, 10, 1800, 2000, 10, 5,
                List.of(new SchedulingStudioService.DemandLineInput(1, "条1", 900, 2000, 4, false, null, null, null, "哑面", null))
        ));
        String slitTaskId = (String) slitFam.get("id");
        // 2 车 × 2000mm = 4000mm > 短卷总长 3000mm
        var tooLongSlit = new SchedulingScheme.Slitting1DPayload(
                10, 10, 1800, 2000, 10, 5, 2000, 2, 0, 0,
                List.of(new SchedulingScheme.SlittingPatternItem(
                        "P1", 2000, 2, 1800, 180, List.of(new SchedulingScheme.StationItem(900, 2)),
                        "哑面", List.of(new SchedulingScheme.SlittingAllocationItem("1", 4))
                )),
                List.of(new SchedulingScheme.SlittingFulfillmentItem("1", "条1", 900, 4, 4, 0, 0))
        );
        assertThrows(IllegalArgumentException.class, () -> studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "IDEM-1D-SHORT", "超长分切", "SLITTING_1D", "MIN_CARS", "QUALITY", "OR-Tools",
                slitTaskId, null, null, "STOCK_ROLL", "ROLL-SHORT-1D", null, "短膜-2000",
                2000, 4000, 0.0, 4000, 0, 0, 90.0, 7.2, false, null, null, tooLongSlit
        )));
        // 验证整事务回滚，无残留方案和待排扣减
        assertEquals(4, ((Number) studio.getDemandFamily(slitTaskId).get("openTotal")).intValue());

        // 6. 1D 表面处理工艺冲突（方案写"亮面"，订单为"哑面"）-> 必须报错拒绝
        MotherRollInfo longRoll = new MotherRollInfo(
                "ROLL-LONG-1D", "短膜-2000", "BAT-L", "厂", "膜", "白", 100, "PET", 2000, 10000, "库位L"
        );
        inv.saveOrUpdateMotherRoll(longRoll);
        var badSurfaceSlit = new SchedulingScheme.Slitting1DPayload(
                10, 10, 1800, 2000, 10, 5, 2000, 2, 0, 0,
                List.of(new SchedulingScheme.SlittingPatternItem(
                        "P1", 2000, 2, 1800, 180, List.of(new SchedulingScheme.StationItem(900, 2)),
                        "亮面", List.of(new SchedulingScheme.SlittingAllocationItem("1", 4))
                )),
                List.of(new SchedulingScheme.SlittingFulfillmentItem("1", "条1", 900, 4, 4, 0, 0))
        );
        assertThrows(IllegalArgumentException.class, () -> studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "IDEM-1D-SURF", "工艺错配", "SLITTING_1D", "MIN_CARS", "QUALITY", "OR-Tools",
                slitTaskId, null, null, "STOCK_ROLL", "ROLL-LONG-1D", null, "短膜-2000",
                2000, 4000, 0.0, 4000, 0, 0, 90.0, 7.2, false, null, null, badSurfaceSlit
        )));
    }

    @Test
    @SuppressWarnings("unchecked")
    void mesAuthRequiredWithoutTokenReturns503AndContourValidateLayoutDetectsDefectCollision() {
        var inv = new RemnantService(temp.resolve("contour-validate.json").toString());
        var studio = new SchedulingStudioService(inv, solver(), new ToolpathOptimizerService());
        var controller = new com.example.cutdemotwo.controller.StudioWorkflowController(studio);
        org.springframework.test.util.ReflectionTestUtils.setField(controller, "mesAuthRequired", true);
        org.springframework.test.util.ReflectionTestUtils.setField(controller, "mesToken", "");
        var ex = assertThrows(org.springframework.web.server.ResponseStatusException.class,
                () -> controller.getMesDispatchPackage("Bearer any-token", "SCH-1"));
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, ex.getStatusCode());

        // 异形轮廓手调校验：合法时返回轮廓刀路，碰撞疵点时返回 feasible=false + 明确错误
        NestingProblem.Shape poly = new NestingProblem.Shape("POLYGON", 500, 600, List.of(
                new NestingProblem.Point(0, 0),
                new NestingProblem.Point(500, 0),
                new NestingProblem.Point(460, 600),
                new NestingProblem.Point(40, 600)
        ));
        var validContour = studio.validateManualLayout(new SchedulingStudioService.ValidateLayoutRequest(
                1500, 1200, 0, 0, true, null, null, 0.0,
                List.of(new Defect(99, 900, 100, 100, 100, 10)),
                List.of(new SchedulingScheme.PlacementItem(1, 1, "异形片", 20, 20, 500, 600, 0, false, poly)),
                List.of(new SchedulingStudioService.DemandLineInput(1, "异形片", 500, 600, 1, false, false, null, null, null, poly))
        ));
        assertEquals(Boolean.TRUE, validContour.get("feasible"), () -> "合法异形应通过: " + validContour);
        assertEquals(4, ((List<?>) validContour.get("cuts")).size(), "四边形轮廓应重建 4 条轮廓边刀路");

        var hitDefect = studio.validateManualLayout(new SchedulingStudioService.ValidateLayoutRequest(
                1500, 1200, 0, 0, true, null, null, 0.0,
                List.of(new Defect(99, 200, 200, 100, 100, 10)),
                List.of(new SchedulingScheme.PlacementItem(1, 1, "异形片", 20, 20, 500, 600, 0, false, poly)),
                List.of(new SchedulingStudioService.DemandLineInput(1, "异形片", 500, 600, 1, false, false, null, null, null, poly))
        ));
        assertEquals(Boolean.FALSE, hitDefect.get("feasible"));
        assertTrue(((List<String>) hitDefect.get("errors")).stream().anyMatch(e -> e.contains("疵点")));
    }
}
