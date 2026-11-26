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
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 阶段 B 专项验收测试：
 * 验证模板域脱离库存全局锁（B1）、读写并行锁（B2）、Delta 定点增量持久化与增量账本（B3）及垂直拆解（B4）。
 */
class PhaseBConcurrencyAndDeltaTests {

    @TempDir
    Path temp;

    private static JdbcDataSource newH2Database() {
        JdbcDataSource h2 = new JdbcDataSource();
        h2.setURL("jdbc:h2:mem:" + UUID.randomUUID() + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        Flyway.configure().dataSource(h2).load().migrate();
        return h2;
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
        JdbcDataSource ds = newH2Database();
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
        JdbcDataSource ds = newH2Database();
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
        JdbcDataSource emptyDs = newH2Database();
        JdbcInventoryStore emptyStore = new JdbcInventoryStore(emptyDs);
        new InventoryImport(emptyStore, srcFile.toString()).run(null);
        RemnantService importedInv = new RemnantService(emptyStore, false);
        SchedulingStudioService importedStudio = new SchedulingStudioService(importedInv, testSolver());
        assertEquals(1, importedStudio.listTemplates().size());
        assertEquals("TPL-FROM-FILE", importedStudio.listTemplates().get(0).id());
        importedInv.scrapRemnant("REM-202609-001", "导入后库存变更");
        assertEquals(1, importedStudio.listTemplates().size(), "导入后库存写操作不得抹除历史模板");
    }
}
