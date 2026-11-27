package com.example.cutdemotwo;

import com.example.cutdemotwo.algorithm.nesting.JavaGuillotineSolverEngine;
import com.example.cutdemotwo.algorithm.nesting.SolverFactory;
import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.cutting.SchedulingStudioService;
import com.example.cutdemotwo.business.model.DemandTemplate;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.persistence.FileInventoryStore;
import com.example.cutdemotwo.persistence.InventoryImport;
import com.example.cutdemotwo.persistence.JdbcInventoryStore;
import com.example.cutdemotwo.persistence.OptimizationTestDatabase;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.sql.DataSource;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 阶段 B 专项验收测试：
 * 验证模板域脱离库存全局锁（B1）、读写并行锁（B2）、Delta 定点增量持久化与增量账本（B3）及垂直拆解（B4）。
 */
@Tag("mysql-integration")
class PhaseBConcurrencyAndDeltaTests {

    @TempDir
    Path temp;

    private static DataSource newDatabase() {
        DataSource ds = OptimizationTestDatabase.create();
        Flyway.configure().dataSource(ds).load().migrate();
        return ds;
    }

    private static SolverFactory testSolver() {
        return new SolverFactory(List.of(new JavaGuillotineSolverEngine()));
    }

    private static DemandTemplate sampleTemplate(String id, String name) {
        return new DemandTemplate(
                id, id, name, "CURTAIN_2D", "RECT_2D", "阶段B测试模板",
                2000, 2000, "TC涤棉-B2026", List.of("标准"), Map.of("标准", 1), true,
                List.of(new DemandTemplate.PieceSpec(
                        "主片", "面布", 1, false, "STRICT_0",
                        Map.of("标准", new DemandTemplate.SizeGeometry(800, 1200, null))
                )),
                null
        );
    }

    @Test
    void templateWritesDoNotBumpInventoryRevisionOrConflictWithStockWritesInJdbcMode() throws Exception {
        DataSource ds = newDatabase();
        JdbcInventoryStore storeA = new JdbcInventoryStore(ds);
        JdbcInventoryStore storeB = new JdbcInventoryStore(ds);
        RemnantService invA = new RemnantService(storeA, true);
        // 触发一次库存写入建立基线
        invA.scrapRemnant("REM-202609-001", "基线写入");
        long revBefore = storeA.currentRevision();
        int ledgerBefore = storeA.load().ledger().size();
        int outboxBefore = storeA.load().outbox().size();

        SchedulingStudioService studioA = new SchedulingStudioService(invA, testSolver());
        RemnantService invB = new RemnantService(storeB, false);
        SchedulingStudioService studioB = new SchedulingStudioService(invB, testSolver());

        // 1. 单独增删改模板不推进库存 revision，不追加 ledger/outbox
        studioA.saveTemplate(sampleTemplate("TPL-B1-SOLO", "独立模板"));
        assertEquals(revBefore, storeA.currentRevision(), "写入需求模板不得推进库存全局 revision");
        assertEquals(ledgerBefore, storeA.load().ledger().size(), "写入需求模板不得写入库存账本");
        assertEquals(outboxBefore, storeA.load().outbox().size(), "写入需求模板不得写入 Outbox");
        assertEquals(1, studioB.listTemplates().size(), "另一节点应即时读到独立模板");

        // 2. 并发执行：12 次模板写/更新/删除 + 6 次母卷库存写，模板侧不得因库存提交而抛出 409 冲突，库存提交亦不得抹除并发模板
        ExecutorService pool = Executors.newFixedThreadPool(4);
        try {
            CountDownLatch start = new CountDownLatch(1);
            List<Future<?>> templateFutures = new ArrayList<>();
            for (int i = 0; i < 12; i++) {
                final int idx = i;
                templateFutures.add(pool.submit(() -> {
                    start.await();
                    studioB.saveTemplate(sampleTemplate("TPL-CONC-" + idx, "并发模板-" + idx));
                    return null;
                }));
            }
            Future<?> stockFuture = pool.submit(() -> {
                start.await();
                for (int i = 0; i < 6; i++) {
                    MotherRollInfo roll = new MotherRollInfo(
                            "ROLL-B1-" + i, "TC涤棉-B2026", "BATCH-B1", "供应商", "测试卷",
                            "白色", 200, "2026-11-26", 2000, 50000, "A-01");
                    invA.saveOrUpdateMotherRoll(roll);
                }
                return null;
            });
            start.countDown();
            for (Future<?> f : templateFutures) {
                f.get();
            }
            stockFuture.get();
        } finally {
            pool.shutdownNow();
        }

        // 3. 验证全部 13 个模板完整留存（未被并发库存 save 抹除），且删除生效
        var reopenedStudio = new SchedulingStudioService(new RemnantService(new JdbcInventoryStore(ds), false), testSolver());
        assertEquals(13, reopenedStudio.listTemplates().size(), "并发库存写入不得误删独立需求模板");
        assertTrue(Boolean.TRUE.equals(reopenedStudio.deleteTemplate("TPL-B1-SOLO").get("deleted")));
        assertEquals(12, reopenedStudio.listTemplates().size());
        assertEquals("BALANCED", invA.reconcileInventory().get("status"));
    }

    @Test
    void jdbcDemoInitAndImportRespectIndependentTemplates() {
        DataSource ds = newDatabase();
        JdbcInventoryStore store = new JdbcInventoryStore(ds);
        RemnantService inv = new RemnantService(store, false);
        SchedulingStudioService studio = new SchedulingStudioService(inv, testSolver());
        studio.saveTemplate(sampleTemplate("TPL-ONLY", "仅存模板"));
        assertEquals(0L, store.currentRevision(), "仅有模板时库存版本保持 0");

        // 已有模板时拒绝演示初始化与覆盖导入
        assertThrows(IllegalArgumentException.class, inv::initializeDemoInventory);
        Path srcFile = temp.resolve("legacy-with-tpl.json");
        var fileInv = new RemnantService(new FileInventoryStore(srcFile.toString()), true);
        new SchedulingStudioService(fileInv, testSolver()).saveTemplate(sampleTemplate("TPL-FROM-FILE", "旧文件模板"));
        assertThrows(IllegalStateException.class, () -> new InventoryImport(store, srcFile.toString()).run(null));

        // 空库导入旧 JSON 时完整保留历史模板，且后续库存修改不会抹除该模板
        DataSource emptyDs = newDatabase();
        JdbcInventoryStore emptyStore = new JdbcInventoryStore(emptyDs);
        new InventoryImport(emptyStore, srcFile.toString()).run(null);
        RemnantService importedInv = new RemnantService(emptyStore, false);
        SchedulingStudioService importedStudio = new SchedulingStudioService(importedInv, testSolver());
        assertEquals(1, importedStudio.listTemplates().size());
        assertEquals("TPL-FROM-FILE", importedStudio.listTemplates().get(0).id());
        importedInv.scrapRemnant("REM-202609-001", "导入后库存变更");
        assertEquals(1, importedStudio.listTemplates().size(), "导入后库存写操作不得抹除历史模板");
    }

    @Test
    void concurrentReadsRunInParallelAndCrossNodeRefreshDowngradesLockSafely() throws Exception {
        DataSource ds = newDatabase();
        JdbcInventoryStore delegateA = new JdbcInventoryStore(ds);
        JdbcInventoryStore storeB = new JdbcInventoryStore(ds);

        // 在 readLock 内部的 store.now() 处放置双线程并发屏障：若退化为排他 synchronized，必超时失败
        java.util.concurrent.atomic.AtomicBoolean barrierArmed = new java.util.concurrent.atomic.AtomicBoolean(false);
        CountDownLatch twoReadersInside = new CountDownLatch(2);
        CountDownLatch releaseReaders = new CountDownLatch(1);
        com.example.cutdemotwo.persistence.InventoryStore instrumentedStoreA = new com.example.cutdemotwo.persistence.InventoryStore() {
            @Override public com.example.cutdemotwo.persistence.InventorySnapshot load() { return delegateA.load(); }
            @Override public long save(com.example.cutdemotwo.persistence.InventorySnapshot snapshot) { return delegateA.save(snapshot); }
            @Override public boolean shared() { return true; }
            @Override public Long currentRevision() { return delegateA.currentRevision(); }
            @Override public String healthCheckError() { return delegateA.healthCheckError(); }
            @Override public boolean supportsIndependentTemplates() { return delegateA.supportsIndependentTemplates(); }
            @Override public List<DemandTemplate> loadTemplates() { return delegateA.loadTemplates(); }
            @Override public void upsertTemplate(DemandTemplate template) { delegateA.upsertTemplate(template); }
            @Override public boolean deleteTemplate(String id) { return delegateA.deleteTemplate(id); }
            @Override public long now() {
                if (barrierArmed.get()) {
                    twoReadersInside.countDown();
                    try {
                        twoReadersInside.await(3, java.util.concurrent.TimeUnit.SECONDS);
                        releaseReaders.await(3, java.util.concurrent.TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }
                return delegateA.now();
            }
        };

        RemnantService invA = new RemnantService(instrumentedStoreA, true);
        invA.scrapRemnant("REM-202609-001", "初始化版本");
        RemnantService invB = new RemnantService(storeB, false);

        ExecutorService pool = Executors.newFixedThreadPool(6);
        try {
            // 1. 验证两个只读查询真正同时持有读锁并行执行
            barrierArmed.set(true);
            Future<List<MotherRollInfo>> r1 = pool.submit(invA::getMotherRolls);
            Future<List<MotherRollInfo>> r2 = pool.submit(invA::getMotherRolls);
            assertTrue(twoReadersInside.await(3, java.util.concurrent.TimeUnit.SECONDS),
                    "双只读线程应通过 ReentrantReadWriteLock 并行进入读锁，不得互相串行阻塞");
            releaseReaders.countDown();
            List<MotherRollInfo> rolls1 = r1.get();
            List<MotherRollInfo> rolls2 = r2.get();
            barrierArmed.set(false);

            assertFalse(rolls1.isEmpty());
            assertEquals(rolls1.size(), rolls2.size());
            // 验证读返回的母卷为脱壳副本，外部修改不会污染内存活对象
            rolls1.get(0).setStorageLocation("外部恶意篡改");
            assertNotEquals("外部恶意篡改", invA.getMotherRoll(rolls1.get(0).getRollId()).getStorageLocation());

            // 2. 节点 A 推进版本后，节点 B 多线程并发触发只读刷新（写锁刷新 + 锁降级为读锁），不得死锁且均见到最新状态
            invA.scrapRemnant("REM-202609-002", "跨节点刷新测试");
            CountDownLatch refreshStart = new CountDownLatch(1);
            List<Future<Object>> readers = new ArrayList<>();
            for (int i = 0; i < 6; i++) {
                readers.add(pool.submit(() -> {
                    refreshStart.await();
                    assertNull(invB.scanOrGetById("REM-202609-002"));
                    return invB.getMotherRolls();
                }));
            }
            refreshStart.countDown();
            for (Future<Object> f : readers) {
                assertNotNull(f.get());
            }
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void jdbcDeltaCommitAvoidsFullTableScansAndKeepsIncrementalLedgerBalanced() {
        DataSource rawDs = newDatabase();
        List<String> capturedSql = java.util.Collections.synchronizedList(new ArrayList<>());
        javax.sql.DataSource spyDs = sqlRecordingDataSource(rawDs, capturedSql);

        JdbcInventoryStore store = new JdbcInventoryStore(spyDs);
        RemnantService inv = new RemnantService(store, true);
        // 首次写入将初始演示库落盘（revision 0 -> 1）并初始化账本与平衡索引
        inv.scrapRemnant("REM-202609-001", "首次基线落库");
        assertTrue(store.currentRevision() >= 1);

        // 1. 修改 1 条任务：应仅定点操作 cutdemo_revision / cutting_task / inventory_ledger(MAX+INSERT) / inventory_outbox(MAX+INSERT)
        capturedSql.clear();
        var task = inv.saveTask(new com.example.cutdemotwo.business.model.CuttingTask(
                null, "增量测试任务", "TC涤棉-B2026", "EXT-DELTA-1", 0L,
                List.of(new com.example.cutdemotwo.business.model.CuttingTask.Line(1, "主片", 800, 1000, 2, false))
        ));
        List<String> taskSql = new ArrayList<>(capturedSql);
        assertFalse(taskSql.isEmpty());
        for (String sql : taskSql) {
            String lower = sql.toLowerCase(java.util.Locale.ROOT);
            assertFalse(lower.contains("from mother_roll"), "改任务不得全表扫描 mother_roll: " + sql);
            assertFalse(lower.contains("from remnant_stock"), "改任务不得全表扫描 remnant_stock: " + sql);
            assertFalse(lower.contains("from cutting_plan"), "改任务不得扫描 cutting_plan: " + sql);
            assertFalse(lower.contains("from cut_report"), "改任务不得扫描 cut_report: " + sql);
            assertFalse(lower.contains("from scheduling_scheme"), "改任务不得扫描 scheduling_scheme: " + sql);
            assertFalse(lower.contains("select data_json from inventory_ledger"), "不得全表反序列化 inventory_ledger: " + sql);
            assertFalse(lower.contains("select data_json from inventory_outbox"), "不得全表反序列化 inventory_outbox: " + sql);
            assertFalse(lower.contains("from demand_template"), "库存提交不得扫描 demand_template: " + sql);
        }

        // 2. 纯非账本聚合写（创建排程方案候选 CuttingPlan）：连 ledger 与 outbox 都应零 SQL
        var req = new com.example.cutdemotwo.business.model.SolveRequest();
        req.setTaskId(task.id());
        req.setTaskRevision(task.revision());
        req.setFeedPortType("roll");
        req.setRollId("ROLL-2026-0920");
        req.setRollModel("TC涤棉-B2026");
        req.setRollW(2000);
        req.setRollL(1200);
        req.setTotalRollL(60000);
        req.setWindowStartY(5000);
        req.setAllowLongitudinal(false);
        req.setDemands(List.of(new com.example.cutdemotwo.business.model.PieceDemand(1, "主片", 800, 1000, 1, false)));
        var workflow = new com.example.cutdemotwo.business.cutting.CuttingWorkflowService(
                new SolverFactory(List.of(new com.example.cutdemotwo.algorithm.nesting.CrossCutSolverService())),
                inv,
                new com.example.cutdemotwo.algorithm.toolpath.ToolpathOptimizerService()
        );
        // 用矩形可解请求触发 rememberPlan
        req.setDemands(List.of(new com.example.cutdemotwo.business.model.PieceDemand(1, "主片", 2000, 1000, 1, false)));
        var task2 = inv.saveTask(new com.example.cutdemotwo.business.model.CuttingTask(
                null, "横切测试任务", "TC涤棉-B2026", "EXT-DELTA-2", 0L,
                List.of(new com.example.cutdemotwo.business.model.CuttingTask.Line(1, "主片", 2000, 1000, 2, false))
        ));
        req.setTaskId(task2.id());
        req.setTaskRevision(task2.revision());

        capturedSql.clear();
        var solved = workflow.solve(req);
        assertTrue(solved.isSuccess() && solved.getPlanId() != null);
        for (String sql : new ArrayList<>(capturedSql)) {
            String lower = sql.toLowerCase(java.util.Locale.ROOT);
            assertFalse(lower.contains("inventory_ledger"), "纯计划落库不应读写 inventory_ledger: " + sql);
            assertFalse(lower.contains("inventory_outbox"), "纯计划落库不应读写 inventory_outbox: " + sql);
            assertFalse(lower.contains("from mother_roll"), "纯计划落库不应扫描 mother_roll: " + sql);
        }

        // 3. 连续执行报工 -> 复检转料头 -> 撤销复检 -> 重启加载，验证增量账本与全量对账 100% BALANCED
        workflow.confirm(new com.example.cutdemotwo.business.model.CutReport(solved.getPlanId(), 1000, 1, List.of(), "A"));
        var disp = inv.disposeQuality(solved.getPlanId(), new com.example.cutdemotwo.business.model.QualityDisposition.Command(
                "delta-disposition-0001", 0, 1, "REMNANT", "边角瑕疵", "质检员",
                new com.example.cutdemotwo.business.model.QualityDisposition.Recovery(0, 0, 500, 500, "B-01", "RECOVERABLE")
        ));
        inv.revokeQualityDisposition(solved.getPlanId(), disp.id(),
                new RemnantService.RevokeDispositionCommand("delta-revoke-disp-0001", "复核误判", "质检主管"));

        assertEquals("BALANCED", inv.reconcileInventory().get("status"));
        RemnantService reopened = new RemnantService(new JdbcInventoryStore(rawDs), false);
        assertEquals("BALANCED", reopened.reconcileInventory().get("status"));
        assertEquals(Map.of("1", 1), reopened.completedQuantities(task2.id()));
    }

    @Test
    void modelDeepCopyAndEqualsContentStayInSyncWithDeclaredFields() {
        // 防回归守卫：若未来新增字段而忘记同步 deepCopy / equalsContent，此测试立即报红提醒
        assertEquals(32, MotherRollInfo.class.getDeclaredFields().length,
                "MotherRollInfo 字段数变更时请同步更新 copyWithRemnantStats / deepCopy / equalsContent");
        assertEquals(21, com.example.cutdemotwo.business.model.RemnantStock.class.getDeclaredFields().length,
                "RemnantStock 字段数变更时请同步更新 deepCopy / equalsContent");
        assertEquals(14, com.example.cutdemotwo.contracts.geometry.Defect.class.getDeclaredFields().length,
                "Defect 字段数变更时请同步更新 copy / equalsContent");
    }

    private static javax.sql.DataSource sqlRecordingDataSource(javax.sql.DataSource target, List<String> sqlLog) {
        return (javax.sql.DataSource) java.lang.reflect.Proxy.newProxyInstance(
                javax.sql.DataSource.class.getClassLoader(),
                new Class<?>[]{javax.sql.DataSource.class},
                (proxy, method, args) -> {
                    Object res = method.invoke(target, args);
                    if ("getConnection".equals(method.getName()) && res instanceof java.sql.Connection conn) {
                        return java.lang.reflect.Proxy.newProxyInstance(
                                java.sql.Connection.class.getClassLoader(),
                                new Class<?>[]{java.sql.Connection.class},
                                (cProxy, cMethod, cArgs) -> {
                                    if (("prepareStatement".equals(cMethod.getName()) || "prepareCall".equals(cMethod.getName()))
                                            && cArgs != null && cArgs.length > 0 && cArgs[0] instanceof String sql) {
                                        sqlLog.add(sql);
                                    }
                                    Object cRes = cMethod.invoke(conn, cArgs);
                                    if ("createStatement".equals(cMethod.getName()) && cRes instanceof java.sql.Statement stmt) {
                                        return java.lang.reflect.Proxy.newProxyInstance(
                                                java.sql.Statement.class.getClassLoader(),
                                                new Class<?>[]{java.sql.Statement.class},
                                                (sProxy, sMethod, sArgs) -> {
                                                    if (sMethod.getName().startsWith("execute") && sArgs != null
                                                            && sArgs.length > 0 && sArgs[0] instanceof String sql) {
                                                        sqlLog.add(sql);
                                                    }
                                                    return sMethod.invoke(stmt, sArgs);
                                                });
                                    }
                                    return cRes;
                                });
                    }
                    return res;
                });
    }
}
