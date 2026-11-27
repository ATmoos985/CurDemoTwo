package com.example.cutdemotwo;

import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.cutting.ScaleArchiveFixture;
import com.example.cutdemotwo.business.workbench.WorkbenchTaskViewSupport;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.InventoryTransfer;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.persistence.InventoryConflictException;
import com.example.cutdemotwo.persistence.JdbcInventoryStore;
import com.example.cutdemotwo.persistence.OptimizationTestDatabase;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import tools.jackson.databind.json.JsonMapper;

import javax.sql.DataSource;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

@Tag("mysql-integration")
class HotColdMemoryScaleTests {

    @Test
    void coldStartAndRefreshSkipAppendOnlyHistoryTablesAndLargePlans() {
        DataSource rawDs = OptimizationTestDatabase.create();
        Flyway.configure().dataSource(rawDs).cleanDisabled(true).load().migrate();

        var stats = ScaleArchiveFixture.populateColdArchive(rawDs, 2000, 30);
        assertTrue(stats.totalRows() >= 12_000, "预置冷记录数应 >= 12000，实际: " + stats.totalRows());

        List<String> capturedSql = Collections.synchronizedList(new ArrayList<>());
        DataSource spyDs = sqlRecordingDataSource(rawDs, capturedSql);

        RemnantService coldStarted = new RemnantService(new JdbcInventoryStore(spyDs), false);
        List<String> bootSql = new ArrayList<>(capturedSql);
        assertFalse(bootSql.isEmpty());
        for (String sql : bootSql) {
            String lower = sql.toLowerCase(Locale.ROOT);
            assertFalse(lower.contains("from inventory_transfer"), "冷启动不得扫 inventory_transfer: " + sql);
            assertFalse(lower.contains("from inventory_count ") || lower.endsWith("from inventory_count"),
                    "冷启动不得扫 inventory_count: " + sql);
            assertFalse(lower.contains("from quality_release_document"), "冷启动不得扫 quality_release_document: " + sql);
            assertFalse(lower.contains("from inventory_receipt_document"), "冷启动不得扫 inventory_receipt_document: " + sql);
            assertFalse(lower.contains("from material_issue_document"), "冷启动不得扫 material_issue_document: " + sql);
            assertFalse(lower.contains("select data_json from inventory_ledger"), "冷启动不得反序列化 inventory_ledger: " + sql);
            assertFalse(lower.contains("select data_json from inventory_outbox"), "冷启动不得反序列化 inventory_outbox: " + sql);
            if (lower.contains("from mother_roll") && !lower.contains("max(sort_order)")) {
                assertTrue(lower.contains("remaining_mm > 0.001") || lower.contains("where id in"),
                        "冷启动仅允许加载活跃/被引用的母卷，不得全表扫 mother_roll: " + sql);
            }
            if (lower.contains("from cutting_plan") && !lower.contains("max(sort_order)")) {
                assertTrue(lower.contains("status = 'pending'") || lower.contains("where id in"),
                        "冷启动仅允许加载 PENDING 或被引用的计划，不得全表扫 cutting_plan: " + sql);
            }
        }

        // 热池仅含活跃 5 母卷 / 5 料头，未将 300 冷母卷与 300 冷料头装入内存
        assertEquals(stats.hotRolls(), new JdbcInventoryStore(rawDs).loadHotSnapshot().hotRolls().size());
        assertEquals(stats.hotRemnants(), coldStarted.getAvailableRemnants().size());
        assertEquals(2000L, coldStarted.outboxCount());
        assertEquals("BALANCED", coldStarted.reconcileInventory().get("status"));

        // 另一节点新增活跃任务，触发本节点跨节点刷新：同样严禁全表扫只增历史表与冷计划
        RemnantService writer = new RemnantService(new JdbcInventoryStore(rawDs), false);
        writer.saveTask(new CuttingTask(null, "新增热任务", "TC涤棉-HOT", "EXT-REFRESH-1", 0L,
                List.of(new CuttingTask.Line(1, "主片", 500, 600, 2, false))));

        capturedSql.clear();
        assertEquals(stats.hotRemnants(), coldStarted.getAvailableRemnants().size());
        for (String sql : new ArrayList<>(capturedSql)) {
            String lower = sql.toLowerCase(Locale.ROOT);
            assertFalse(lower.contains("from inventory_transfer"), "跨节点刷新不得扫 inventory_transfer: " + sql);
            assertFalse(lower.contains("select data_json from inventory_ledger"), "跨节点刷新不得扫 inventory_ledger: " + sql);
            assertFalse(lower.contains("select data_json from inventory_outbox"), "跨节点刷新不得扫 inventory_outbox: " + sql);
        }
        assertEquals("BALANCED", coldStarted.reconcileInventory().get("status"));
    }

    @Test
    void concurrentWritesAndPagedQueriesUnderLargeColdArchiveStayBalanced() throws Exception {
        DataSource ds = OptimizationTestDatabase.create();
        Flyway.configure().dataSource(ds).cleanDisabled(true).load().migrate();
        var stats = ScaleArchiveFixture.populateColdArchive(ds, 2000, 25);

        RemnantService nodeA = new RemnantService(new JdbcInventoryStore(ds), false);
        RemnantService nodeB = new RemnantService(new JdbcInventoryStore(ds), false);

        var pool = Executors.newFixedThreadPool(6);
        try {
            CountDownLatch start = new CountDownLatch(1);
            List<Future<?>> futures = new ArrayList<>();
            for (int t = 0; t < 3; t++) {
                final int workerId = t;
                RemnantService writer = (workerId % 2 == 0) ? nodeA : nodeB;
                futures.add(pool.submit(() -> {
                    start.await();
                    for (int k = 0; k < 5; k++) {
                        int attempt = 0;
                        while (true) {
                            try {
                                String rollId = "CONC-ROLL-" + workerId + "-" + k;
                                MotherRollInfo roll = new MotherRollInfo(rollId, "TC涤棉-HOT", 2000, 30000, 0, 0);
                                writer.saveOrUpdateMotherRoll(roll);
                                break;
                            } catch (InventoryConflictException retry) {
                                if (++attempt >= 8) throw retry;
                            }
                        }
                    }
                    return null;
                }));
            }
            for (int r = 0; r < 3; r++) {
                final int readerId = r;
                RemnantService reader = (readerId % 2 == 0) ? nodeB : nodeA;
                futures.add(pool.submit(() -> {
                    start.await();
                    for (int k = 0; k < 5; k++) {
                        var reports = reader.reconciliationReports(20, k * 20, "ALL", null);
                        assertEquals(20, ((List<?>) reports.get("items")).size());
                        var ledgerPage = reader.inventoryLedger(null, null, 0L, 50);
                        assertEquals(50, ((List<?>) ledgerPage.get("items")).size());
                        assertEquals(50, reader.outboxPage(0L, 50).size());
                    }
                    return null;
                }));
            }
            start.countDown();
            for (Future<?> f : futures) {
                f.get(30, TimeUnit.SECONDS);
            }
        } finally {
            pool.shutdownNow();
        }

        // 冷数据回源：nodeA 创建完整任务+方案+报工并使该任务完结淘汰出热池；nodeB 热池中无该冷回执，通过冷回源直接冲销验证不误删邻近冷数据
        MotherRollInfo dedicatedRoll = new MotherRollInfo("COLD-SRC-ROLL-01", "TC涤棉-HOT", 2000, 10000, 0, 0);
        nodeA.saveOrUpdateMotherRoll(dedicatedRoll);
        CuttingTask finishedTask = nodeA.saveTask(new CuttingTask(null, "冷回源待冲销任务", "TC涤棉-HOT", "EXT-COLD-REV-1", 0L,
                List.of(new CuttingTask.Line(1, "主片", 2000, 1000, 1, false))));
        var workflowA = new com.example.cutdemotwo.business.cutting.CuttingWorkflowService(
                new com.example.cutdemotwo.algorithm.nesting.SolverFactory(
                        List.of(new com.example.cutdemotwo.algorithm.nesting.CrossCutSolverService())),
                nodeA,
                new com.example.cutdemotwo.algorithm.toolpath.ToolpathOptimizerService());
        var req = new com.example.cutdemotwo.business.model.SolveRequest();
        req.setTaskId(finishedTask.id());
        req.setTaskRevision(finishedTask.revision());
        req.setRollId(dedicatedRoll.getRollId());
        req.setRollModel("TC涤棉-HOT");
        req.setRollW(2000);
        req.setRollL(1200);
        req.setTotalRollL(10000);
        req.setWindowStartY(0);
        req.setAllowLongitudinal(false);
        req.setFeedPortType("roll");
        req.setDemands(List.of(new com.example.cutdemotwo.business.model.PieceDemand(1, "主片", 2000, 1000, 1, false)));
        var solved = workflowA.solve(req);
        assertTrue(solved.isSuccess());
        workflowA.confirm(new com.example.cutdemotwo.business.model.CutReport(solved.getPlanId(), 1000, 1, List.of(), "HOT-BAY"));

        // nodeB 刷新后该已完结任务与回执不在热池，调用 reverseReport 触发冷回源并冲销
        Map<String, Object> reversed = nodeB.reverseReport(solved.getPlanId(), "热冷回源复核冲销");
        assertEquals("REVERSED", reversed.get("status"));

        // 热移库（写单据表后校验冷单据总数未丢、账本守恒）
        var tr = nodeB.transferInventory("hot-cold-tr-1",
                new InventoryTransfer.Command((Long) nodeB.healthStatus().get("revision"),
                        "HOT-BAY-2", "并发后移库校验", "OP-1",
                        List.of(new InventoryTransfer.Material("roll", "HOT-ROLL-0001"))));
        assertNotNull(tr.id());

        RemnantService reopened = new RemnantService(new JdbcInventoryStore(ds), false);
        assertEquals("BALANCED", reopened.reconcileInventory().get("status"));
        assertTrue(reopened.listInventoryReceipts().size() >= 500);
    }

    @Test
    void subJvm256MbHeapStressTestSurvives20kHistoryRows(@TempDir Path tempDir) throws Exception {
        DataSource ds = resolveCrossProcessDatabase(tempDir);
        Flyway.configure().dataSource(ds).cleanDisabled(true).load().migrate();

        // 构造 >= 20,000 条记录且总 JSON > 60MB
        var stats = ScaleArchiveFixture.populateColdArchive(ds, 4000, 120);
        assertTrue(stats.totalRows() >= 20_000, "规模压测记录总数应 >= 20000，实际: " + stats.totalRows());
        assertTrue(stats.totalJsonBytes() >= 60_000_000L,
                "规模压测总 JSON 体积应 >= 60MB，实际: " + (stats.totalJsonBytes() / (1024 * 1024)) + "MB");

        String jdbcUrl;
        String user = "";
        String pass = "";
        if (ds instanceof DriverManagerDataSource dmds) {
            jdbcUrl = dmds.getUrl();
            user = dmds.getUsername() == null ? "" : dmds.getUsername();
            pass = dmds.getPassword() == null ? "" : dmds.getPassword();
        } else {
            throw new IllegalStateException("未预期的 DataSource 类型: " + ds.getClass());
        }

        String javaBin = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        String classpath = System.getProperty("java.class.path");
        ProcessBuilder pb = new ProcessBuilder(
                javaBin,
                "-Xms64m",
                "-Xmx256m",
                "-XX:+ExitOnOutOfMemoryError",
                "-cp", classpath,
                SubJvmProbe.class.getName(),
                jdbcUrl, user, pass
        );
        pb.redirectErrorStream(true);
        Process proc = pb.start();
        StringBuilder output = new StringBuilder();
        try (BufferedReader br = new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) {
                output.append(line).append('\n');
            }
        }
        boolean finished = proc.waitFor(120, TimeUnit.SECONDS);
        if (!finished) {
            proc.destroyForcibly();
            fail("256MB 子 JVM 压测超时:\n" + output);
        }
        assertEquals(0, proc.exitValue(), "256MB 子 JVM 压测失败(exit=" + proc.exitValue() + "):\n" + output);
        assertTrue(output.toString().contains("PROBE_OK"), "256MB 子 JVM 未输出 PROBE_OK:\n" + output);
    }

    @Test
    void partialUsedNewMotherRollConservesLengthAndNeverTriggersMismatch() {
        DataSource ds = OptimizationTestDatabase.create();
        Flyway.configure().dataSource(ds).cleanDisabled(true).load().migrate();
        RemnantService inv = new RemnantService(new JdbcInventoryStore(ds), false);

        // 1. 客户端新建母卷，仅设置 totalLength=50000 与 usedLength=12000，currentRemainingLength<=0
        MotherRollInfo partialRoll = new MotherRollInfo("ROLL-PARTIAL-01", "TC涤棉-P1", 2000, 50000, 0, 0);
        partialRoll.setUsedLength(12000);
        partialRoll.setCurrentRemainingLength(0);
        MotherRollInfo saved = inv.saveOrUpdateMotherRoll(partialRoll);

        assertEquals(38000.0, saved.getCurrentRemainingLength(), 0.001);
        assertEquals(12000.0, saved.getUsedLength(), 0.001);
        assertEquals("BALANCED", inv.reconcileInventory().get("status"));

        // 2. 传入矛盾参数 (total=50000, used=10000, remaining=35000) 必须被拒绝
        MotherRollInfo invalidRoll = new MotherRollInfo("ROLL-BAD-01", "TC涤棉-P1", 2000, 50000, 0, 0);
        invalidRoll.setUsedLength(10000);
        invalidRoll.setCurrentRemainingLength(35000);
        assertThrows(IllegalArgumentException.class, () -> inv.saveOrUpdateMotherRoll(invalidRoll));

        // 3. 禁止通过档案更新将已有在库母卷的质检状态直接修改为 SCRAPPED，且对账保持 BALANCED
        MotherRollInfo scrapViaUpdate = new MotherRollInfo("ROLL-PARTIAL-01", "TC涤棉-P1", 2000, 50000, 0, 0);
        scrapViaUpdate.setInspectionStatus("SCRAPPED");
        assertThrows(IllegalArgumentException.class, () -> inv.saveOrUpdateMotherRoll(scrapViaUpdate));
        assertEquals("PASSED", inv.getMotherRoll("ROLL-PARTIAL-01").getInspectionStatus());

        // 4. 新建母卷也必须严格对齐账本报废守恒不变量
        MotherRollInfo newScrappedWithRem = new MotherRollInfo("ROLL-NEW-SCRAP-BAD", "TC涤棉-P1", 2000, 50000, 0, 0);
        newScrappedWithRem.setInspectionStatus("SCRAPPED");
        newScrappedWithRem.setCurrentRemainingLength(50000.0);
        assertThrows(IllegalArgumentException.class, () -> inv.saveOrUpdateMotherRoll(newScrappedWithRem));

        MotherRollInfo newPassedWithScrapLen = new MotherRollInfo("ROLL-NEW-PASSED-SCRAP-BAD", "TC涤棉-P1", 2000, 50000, 0, 0);
        newPassedWithScrapLen.setInspectionStatus("PASSED");
        newPassedWithScrapLen.setCurrentRemainingLength(45000.0);
        newPassedWithScrapLen.setScrappedLengthMm(5000.0);
        assertThrows(IllegalArgumentException.class, () -> inv.saveOrUpdateMotherRoll(newPassedWithScrapLen));

        assertEquals("BALANCED", inv.reconcileInventory().get("status"));
    }

    /** 跨进程压测专用库：若外部提供 MySQL 则使用独立 MySQL schema；否则使用临时目录文件 H2（避免内存库无法跨进程共享）。 */
    private static DataSource resolveCrossProcessDatabase(Path tempDir) {
        String mysqlUrl = System.getProperty("cutdemo.test.mysql.url");
        if (mysqlUrl != null && !mysqlUrl.isBlank()) {
            return OptimizationTestDatabase.create();
        }
        String dbFile = tempDir.resolve("hotcold_256m_probe").toAbsolutePath().toString().replace('\\', '/');
        DriverManagerDataSource ds = new DriverManagerDataSource();
        ds.setDriverClassName("org.h2.Driver");
        ds.setUrl("jdbc:h2:file:" + dbFile + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE");
        ds.setUsername("sa");
        ds.setPassword("");
        return ds;
    }

    /** 独立 -Xmx256m 子进程探针入口 */
    public static final class SubJvmProbe {
        public static void main(String[] args) {
            long t0 = System.currentTimeMillis();
            com.zaxxer.hikari.HikariConfig cfg = new com.zaxxer.hikari.HikariConfig();
            cfg.setJdbcUrl(args[0]);
            if (args.length > 1 && !args[1].isEmpty()) cfg.setUsername(args[1]);
            if (args.length > 2 && !args[2].isEmpty()) cfg.setPassword(args[2]);
            if (args[0].contains(":mysql:")) cfg.setDriverClassName("com.mysql.cj.jdbc.Driver");
            else cfg.setDriverClassName("org.h2.Driver");
            cfg.setMaximumPoolSize(4);

            try (com.zaxxer.hikari.HikariDataSource ds = new com.zaxxer.hikari.HikariDataSource(cfg)) {
                RemnantService service = new RemnantService(new JdbcInventoryStore(ds), false);
                System.out.println("[SubJvmProbe] boot ms=" + (System.currentTimeMillis() - t0));
                for (int i = 0; i < 50; i++) {
                    MotherRollInfo roll = new MotherRollInfo("PROBE-ROLL-" + i, "TC涤棉-HOT", 2000, 40000, 0, 0);
                    service.saveOrUpdateMotherRoll(roll);
                }
                System.out.println("[SubJvmProbe] 50 writes ms=" + (System.currentTimeMillis() - t0));
                for (int i = 0; i < 50; i++) {
                    var page = service.reconciliationReports(20, (i % 10) * 20, "ALL", null);
                    if (((List<?>) page.get("items")).isEmpty()) throw new IllegalStateException("分页结果为空");
                    service.inventoryLedger(null, null, i * 20L, 20);
                    service.outboxPage(i * 20L, 20);
                }
                System.out.println("[SubJvmProbe] 50 paged queries ms=" + (System.currentTimeMillis() - t0));
                Map<String, Object> recon = service.reconcileInventory();
                if (!"BALANCED".equals(recon.get("status"))) {
                    throw new IllegalStateException("对账未平衡: " + recon);
                }
                System.gc();
                long usedMb = (Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory()) / (1024 * 1024);
                long maxMb = Runtime.getRuntime().maxMemory() / (1024 * 1024);
                System.out.println("PROBE_OK usedHeapMb=" + usedMb + " maxHeapMb=" + maxMb
                        + " totalMs=" + (System.currentTimeMillis() - t0)
                        + " entryCount=" + recon.get("entryCount") + " aggregateCount=" + recon.get("aggregateCount"));
            }
        }
    }

    @Test
    void likeWildcardAndReconciliationPaginationDoNotScanFullColdSchemes() {
        DataSource rawDs = OptimizationTestDatabase.create();
        Flyway.configure().dataSource(rawDs).cleanDisabled(true).load().migrate();

        JdbcTemplate jdbc = new JdbcTemplate(rawDs);
        JsonMapper mapper = JsonMapper.builder().build();

        // 1. 预置 220 条冷 COMPLETED 排程方案与 3 条关联的 cut_report
        jdbc.update("UPDATE cutdemo_revision SET revision = 1 WHERE id = 1");
        int coldSchemeCount = 220;
        for (int i = 1; i <= coldSchemeCount; i++) {
            String sid = String.format("COLD-SCH-%04d", i);
            String tid = String.format("COLD-TASK-%04d", i);
            String pid = String.format("COLD-PLAN-%04d", i);
            SchedulingScheme sc = new SchedulingScheme(
                    sid, "IDEM-COLD-" + i, "冷方案-" + i, "RECT_2D", "SHORTEN", "S1", "策略",
                    tid, "冷任务-" + i, null, "VIRTUAL_ROLL", "COLD-ROLL-1", null, "MAT-COLD",
                    1500.0, 1000.0, 0.0, 500.0, 0.0, 0.0, 60.0, 0.45,
                    2, 2, 0, true, Map.of("1", 2), List.of(pid), null,
                    SchedulingScheme.STATE_COMPLETED, null, null, null, null,
                    "2026-01-01T00:00:00", null, "2026-01-02T00:00:00", null, null
            );
            jdbc.update(
                    "INSERT INTO scheduling_scheme (id, sort_order, task_id, roll_id, state, dimension, data_json) VALUES (?,?,?,?,?,?,?)",
                    sid, (long) i, tid, "COLD-ROLL-1", SchedulingScheme.STATE_COMPLETED, "RECT_2D", mapper.writeValueAsString(sc)
            );
            if (i <= 3) {
                Map<String, Object> receipt = new LinkedHashMap<>();
                receipt.put("planId", pid);
                receipt.put("taskId", tid);
                receipt.put("taskRevision", 1L);
                receipt.put("feedPortType", "roll");
                receipt.put("rollId", "COLD-ROLL-1");
                receipt.put("rollModel", "MAT-COLD");
                receipt.put("status", "CONFIRMED");
                receipt.put("confirmedAt", "2026-01-02T00:00:0" + i);
                receipt.put("usedArea", 2.0);
                receipt.put("pieceArea", 1.5);
                receipt.put("remArea", 0.3);
                receipt.put("wasteArea", 0.2);
                receipt.put("rejectedArea", 0.0);
                receipt.put("finishedPieceCount", 2);
                receipt.put("demandQuantities", Map.of("1", 2));
                jdbc.update(
                        "INSERT INTO cut_report (id, sort_order, task_id, roll_id, source_remnant_id, status, data_json) VALUES (?,?,?,?,?,?,?)",
                        pid, (long) i, tid, "COLD-ROLL-1", null, "CONFIRMED", mapper.writeValueAsString(receipt)
                );
                jdbc.update("INSERT INTO cut_report_task_link (report_id, task_id) VALUES (?,?)", pid, tid);
            }
        }

        List<String> capturedSql = Collections.synchronizedList(new ArrayList<>());
        AtomicInteger schemeRowsFetched = new AtomicInteger(0);
        DataSource spyDs = sqlAndRowCountingDataSource(rawDs, capturedSql, "scheduling_scheme", schemeRowsFetched);

        JdbcInventoryStore spyStore = new JdbcInventoryStore(spyDs);
        RemnantService service = new RemnantService(spyStore, false);

        // 2. 通配符 % 与 _ 幂等键查询：必须转义 ESCAPE '!' 且从 scheduling_scheme 拉取 0 行
        capturedSql.clear();
        schemeRowsFetched.set(0);
        assertTrue(spyStore.findSchemeByIdempotencyKey("%").isEmpty());
        assertTrue(spyStore.findSchemeByIdempotencyKey("IDEM_COLD%").isEmpty());
        assertEquals(0, schemeRowsFetched.get(), "通配符 %/_ 查询不得拉取并反序列化任何冷方案行");
        assertTrue(capturedSql.stream().anyMatch(s -> s.toUpperCase(Locale.ROOT).contains("ESCAPE '!'")),
                "LIKE 查询必须包含 ESCAPE '!' 转义");

        // 正常精确查询可命中单条（早停不拉 220 行）
        schemeRowsFetched.set(0);
        var exactHit = spyStore.findSchemeByIdempotencyKey("IDEM-COLD-15");
        assertTrue(exactHit.isPresent());
        assertEquals("COLD-SCH-0015", exactHit.get().id());
        assertTrue(schemeRowsFetched.get() <= 2, "精确幂等键查询应受控早停，实际读取行数: " + schemeRowsFetched.get());

        // 3. reconciliationReports(10, 0)：只应拉取当前页相关的极少数方案（<= 3 行），绝非全表 220 行
        capturedSql.clear();
        schemeRowsFetched.set(0);
        var page = service.reconciliationReports(10, 0, "ALL", null);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> items = (List<Map<String, Object>>) page.get("items");
        assertEquals(3, items.size());
        assertTrue(items.stream().allMatch(it -> it.get("schemeId") != null));
        assertTrue(schemeRowsFetched.get() <= 10,
                "reconciliationReports(10, 0) 拉取 scheduling_scheme 行数应 <= 10，实际: " + schemeRowsFetched.get());
        assertTrue(capturedSql.stream().noneMatch(s -> {
            String lower = s.toLowerCase(Locale.ROOT).trim();
            return lower.contains("from scheduling_scheme") && !lower.contains(" where ");
        }), "reconciliationReports 不得执行无 WHERE 的 scheduling_scheme 全表查询");
    }

    @Test
    void workbenchTaskSummaryAndPlannedQuantitiesDoNotScanFullColdSchemes() {
        DataSource rawDs = OptimizationTestDatabase.create();
        Flyway.configure().dataSource(rawDs).cleanDisabled(true).load().migrate();

        JdbcTemplate jdbc = new JdbcTemplate(rawDs);
        JsonMapper mapper = JsonMapper.builder().build();
        jdbc.update("UPDATE cutdemo_revision SET revision = 1 WHERE id = 1");

        // 1. 预置 220 条冷 COMPLETED 方案
        for (int i = 1; i <= 220; i++) {
            String sid = String.format("WB-COLD-SCH-%04d", i);
            String tid = String.format("WB-COLD-TASK-%04d", i);
            SchedulingScheme sc = new SchedulingScheme(
                    sid, "IDEM-WB-COLD-" + i, "冷方案-" + i, "RECT_2D", "SHORTEN", "S1", "策略",
                    tid, "冷任务-" + i, null, "VIRTUAL_ROLL", "WB-COLD-ROLL-1", null, "MAT-WB",
                    1500.0, 1000.0, 0.0, 500.0, 0.0, 0.0, 60.0, 0.45,
                    2, 2, 0, true, Map.of("1", 2), List.of("WB-COLD-PLAN-" + i), null,
                    SchedulingScheme.STATE_COMPLETED, null, null, null, null,
                    "2026-01-01T00:00:00", null, "2026-01-02T00:00:00", null, null
            );
            jdbc.update(
                    "INSERT INTO scheduling_scheme (id, sort_order, task_id, roll_id, state, dimension, data_json) VALUES (?,?,?,?,?,?,?)",
                    sid, (long) i, tid, "WB-COLD-ROLL-1", SchedulingScheme.STATE_COMPLETED, "RECT_2D", mapper.writeValueAsString(sc)
            );
        }

        // 2. 预置 1 个活跃任务（需求 10 件）和 1 个未完结活跃方案（预占 4 件）
        CuttingTask newTask = new CuttingTask(
                null, "工作台活跃测试任务", "MAT-WB", "EXT-WB-1", 0L,
                List.of(new CuttingTask.Line(1, "主片", 300.0, 400.0, 10, true))
        );
        RemnantService setup = new RemnantService(new JdbcInventoryStore(rawDs), false);
        String activeTaskId = setup.inWrite("ADD_TASK", "WB-ACT-TASK-1", "tester", tx -> {
            CuttingTask savedTask = tx.saveTask(newTask);
            SchedulingScheme activeScheme = new SchedulingScheme(
                    "WB-ACT-SCH-1", "IDEM-WB-ACT-1", "活跃方案", "RECT_2D", "SHORTEN", "S1", "策略",
                    savedTask.id(), "工作台活跃测试任务", "EXT-WB-1", "STOCK_ROLL", "WB-ACT-ROLL-1", null, "MAT-WB",
                    1500.0, 1000.0, 0.0, 400.0, 0.0, 0.0, 72.0, 0.48,
                    4, 10, 0, false, Map.of("1", 4), List.of(), null,
                    SchedulingScheme.STATE_READY_TO_CUT, null, null, null, null,
                    "2026-11-27T00:00:00", null, null, null, null
            );
            tx.putScheme(activeScheme);
            return savedTask.id();
        });

        List<String> capturedSql = Collections.synchronizedList(new ArrayList<>());
        AtomicInteger schemeRowsFetched = new AtomicInteger(0);
        DataSource spyDs = sqlAndRowCountingDataSource(rawDs, capturedSql, "scheduling_scheme", schemeRowsFetched);

        // 3. 热冷启动仅加载活跃方案（1 行）及 1 行 nextSortOrder 聚合行，绝不拉取 220 条冷方案
        RemnantService service = new RemnantService(new JdbcInventoryStore(spyDs), false);
        assertTrue(schemeRowsFetched.get() <= 2, "冷启动仅应加载活跃方案与 max(sort_order)，实际读取行数: " + schemeRowsFetched.get());

        // 4. 查询工作台任务预占量与任务摘要时，scheduling_scheme 必须读取 0 行且无全表查询
        capturedSql.clear();
        schemeRowsFetched.set(0);

        Map<String, Integer> planned = service.inRead(tx ->
                WorkbenchTaskViewSupport.plannedQuantitiesForTask(tx, activeTaskId));
        assertEquals(Map.of("1", 4), planned, "活跃方案预占量必须准确统计");

        Map<String, Object> summary = service.inRead(tx -> {
            CuttingTask task = tx.findTask(activeTaskId).orElseThrow();
            return WorkbenchTaskViewSupport.buildTaskSummary(tx, task);
        });
        assertEquals(10, summary.get("orderedTotal"));
        assertEquals(4, summary.get("plannedTotal"));
        assertEquals(6, summary.get("openTotal"));
        assertEquals(0, schemeRowsFetched.get(),
                "工作台任务视图计算 plannedQuantitiesForTask 时不得扫描任何 scheduling_scheme 行");
        assertTrue(capturedSql.stream().noneMatch(s -> s.toLowerCase(Locale.ROOT).contains("scheduling_scheme")),
                "工作台任务视图计算不应触发任何 scheduling_scheme SQL 查询: " + capturedSql);
    }

    private static DataSource sqlRecordingDataSource(DataSource target, List<String> sqlLog) {
        return sqlAndRowCountingDataSource(target, sqlLog, null, null);
    }

    private static DataSource sqlAndRowCountingDataSource(
            DataSource target,
            List<String> sqlLog,
            String watchedTable,
            AtomicInteger watchedTableRowCounter
    ) {
        return (DataSource) Proxy.newProxyInstance(
                DataSource.class.getClassLoader(),
                new Class<?>[]{DataSource.class},
                (proxy, method, args) -> {
                    Object res = method.invoke(target, args);
                    if ("getConnection".equals(method.getName()) && res instanceof Connection conn) {
                        return Proxy.newProxyInstance(
                                Connection.class.getClassLoader(),
                                new Class<?>[]{Connection.class},
                                (cProxy, cMethod, cArgs) -> {
                                    boolean isPrepare = "prepareStatement".equals(cMethod.getName()) || "prepareCall".equals(cMethod.getName());
                                    String prepSql = (isPrepare && cArgs != null && cArgs.length > 0 && cArgs[0] instanceof String s) ? s : null;
                                    if (prepSql != null) {
                                        sqlLog.add(prepSql);
                                    }
                                    Object cRes = cMethod.invoke(conn, cArgs);
                                    if (isPrepare && cRes instanceof PreparedStatement ps && prepSql != null
                                            && watchedTable != null && watchedTableRowCounter != null
                                            && prepSql.toLowerCase(Locale.ROOT).contains("from " + watchedTable)) {
                                        return Proxy.newProxyInstance(
                                                PreparedStatement.class.getClassLoader(),
                                                new Class<?>[]{PreparedStatement.class},
                                                (pProxy, pMethod, pArgs) -> {
                                                    Object pRes = pMethod.invoke(ps, pArgs);
                                                    if ("executeQuery".equals(pMethod.getName()) && pRes instanceof ResultSet rs) {
                                                        return countingResultSet(rs, watchedTableRowCounter);
                                                    }
                                                    return pRes;
                                                });
                                    }
                                    if ("createStatement".equals(cMethod.getName()) && cRes instanceof Statement stmt) {
                                        return Proxy.newProxyInstance(
                                                Statement.class.getClassLoader(),
                                                new Class<?>[]{Statement.class},
                                                (sProxy, sMethod, sArgs) -> {
                                                    String execSql = (sMethod.getName().startsWith("execute") && sArgs != null
                                                            && sArgs.length > 0 && sArgs[0] instanceof String sql) ? sql : null;
                                                    if (execSql != null) {
                                                        sqlLog.add(execSql);
                                                    }
                                                    Object sRes = sMethod.invoke(stmt, sArgs);
                                                    if ("executeQuery".equals(sMethod.getName()) && sRes instanceof ResultSet rs
                                                            && execSql != null && watchedTable != null && watchedTableRowCounter != null
                                                            && execSql.toLowerCase(Locale.ROOT).contains("from " + watchedTable)) {
                                                        return countingResultSet(rs, watchedTableRowCounter);
                                                    }
                                                    return sRes;
                                                });
                                    }
                                    return cRes;
                                });
                    }
                    return res;
                });
    }

    private static ResultSet countingResultSet(ResultSet target, AtomicInteger counter) {
        return (ResultSet) Proxy.newProxyInstance(
                ResultSet.class.getClassLoader(),
                new Class<?>[]{ResultSet.class},
                (proxy, method, args) -> {
                    Object res = method.invoke(target, args);
                    if ("next".equals(method.getName()) && Boolean.TRUE.equals(res)) {
                        counter.incrementAndGet();
                    }
                    return res;
                });
    }
}
