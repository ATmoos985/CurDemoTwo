package com.example.cutdemotwo;

import com.example.cutdemotwo.algorithm.nesting.CrossCutSolverService;
import com.example.cutdemotwo.algorithm.nesting.JavaGuillotineSolverEngine;
import com.example.cutdemotwo.algorithm.nesting.SolverFactory;
import com.example.cutdemotwo.algorithm.toolpath.ToolpathOptimizerService;
import com.example.cutdemotwo.business.cutting.CuttingWorkflowService;
import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.cutting.SchedulingStudioService;
import com.example.cutdemotwo.business.model.CutReport;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.InventoryReceiptDocument;
import com.example.cutdemotwo.business.model.InventoryTransfer;
import com.example.cutdemotwo.business.model.MaterialIssueDocument;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.PieceDemand;
import com.example.cutdemotwo.business.model.QualityDisposition;
import com.example.cutdemotwo.business.model.QualityReleaseDocument;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.persistence.FileInventoryStore;
import com.example.cutdemotwo.persistence.InventoryConflictException;
import com.example.cutdemotwo.persistence.InventorySnapshot;
import com.example.cutdemotwo.persistence.JdbcInventoryStore;
import com.example.cutdemotwo.persistence.OptimizationTestDatabase;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 工厂生产闭环核心工作流与 File / Flyway V10 JDBC 持久化全链路测试：
 * 覆盖隔离料头放行、复检处置撤销、采购批量入库、车间领退料、母卷报废、缸号色号防呆、缩水率修复、生产主数据与同缸加急补片。
 */
@Tag("mysql-integration")
class FactoryClosureWorkflowTests {
    @TempDir
    Path temp;

    private SolverFactory solver() {
        return new SolverFactory(List.of(new CrossCutSolverService(), new JavaGuillotineSolverEngine()));
    }

    private DataSource createJdbcDatabase() {
        DataSource ds = OptimizationTestDatabase.create();
        Flyway.configure().dataSource(ds).load().migrate();
        return ds;
    }

    // ==================== 1. 隔离料头质量复验放行（File + JDBC + 不可变校验） ====================

    @Test
    void qualityReleaseTransitionsQuarantinedRemnantIdempotentlyAndKeepsLedgerBalanced() {
        FileInventoryStore store = new FileInventoryStore(temp.resolve("release.json").toString());
        RemnantService inv = new RemnantService(store, true);

        // 将两条料头置为隔离状态
        inv.updateStatus("REM-202609-001", "QUARANTINED");
        inv.updateStatus("REM-202609-002", "QUARANTINED");
        assertNull(inv.scanOrGetById("REM-202609-001"));

        // 1. 放行转为 AVAILABLE
        var cmd1 = new RemnantService.QualityReleaseCommand("QREL-KEY-001", "RELEASE_AVAILABLE", "质检员王芳", "复验色牢度与尺寸均达标");
        Map<String, Object> res1 = inv.releaseQuarantinedRemnant("REM-202609-001", cmd1);
        QualityReleaseDocument doc1 = (QualityReleaseDocument) res1.get("document");
        RemnantStock rem1 = (RemnantStock) res1.get("remnant");
        long revAfter1 = ((Number) res1.get("revision")).longValue();

        assertEquals("AVAILABLE", rem1.getStatus());
        assertEquals("QUARANTINED", doc1.fromStatus());
        assertEquals("AVAILABLE", doc1.toStatus());
        assertEquals(revAfter1, doc1.inventoryRevision());
        assertNotNull(inv.scanOrGetById("REM-202609-001"));
        assertEquals("BALANCED", inv.reconcileInventory().get("status"));

        // 2. 同幂等键同体安全重放，不推进版本、不重复写流水
        int ledgerBeforeReplay = store.load().ledger().size();
        Map<String, Object> replay1 = inv.releaseQuarantinedRemnant("REM-202609-001", cmd1);
        assertEquals(doc1, replay1.get("document"));
        assertEquals(revAfter1, ((Number) replay1.get("revision")).longValue());
        assertEquals(ledgerBeforeReplay, store.load().ledger().size());

        // 3. 同键异体 -> 409 冲突
        assertThrows(InventoryConflictException.class, () -> inv.releaseQuarantinedRemnant("REM-202609-001",
                new RemnantService.QualityReleaseCommand("QREL-KEY-001", "SCRAP", "质检员王芳", "不同内容")));

        // 4. 非隔离态料头（已 AVAILABLE）直接拒绝 409
        assertThrows(InventoryConflictException.class, () -> inv.releaseQuarantinedRemnant("REM-202609-001",
                new RemnantService.QualityReleaseCommand("QREL-KEY-002", "SCRAP", "质检员王芳", "尝试再操作")));

        // 5. 另一隔离料头执行 SCRAP 判废
        Map<String, Object> res2 = inv.releaseQuarantinedRemnant("REM-202609-002",
                new RemnantService.QualityReleaseCommand("QREL-KEY-003", "SCRAP", "质检员王芳", "复验油污无法清除"));
        assertEquals("SCRAPPED", ((RemnantStock) res2.get("remnant")).getStatus());
        assertEquals(2, inv.listQualityReleases().size());
        assertTrue(store.load().ledger().stream().anyMatch(e -> "QUALITY_RELEASE".equals(e.eventType())));
        assertTrue(inv.integrationEvents().stream().anyMatch(e -> "QUALITY_RELEASE".equals(e.action())));
        assertEquals("BALANCED", inv.reconcileInventory().get("status"));

        // 6. 重启后可完整恢复且文件存储拒绝篡改/删除已过账放行单
        RemnantService reopened = new RemnantService(store, false);
        assertEquals(2, reopened.listQualityReleases().size());
        InventorySnapshot snap = store.load();
        InventorySnapshot tampered = new InventorySnapshot(
                snap.rolls(), snap.remnants(), snap.receipts(), snap.remnantSeq(), snap.defectSeq(),
                snap.tasks(), snap.plans(), snap.revision(), snap.executions(), snap.ledger(),
                snap.transfers(), snap.outbox(), snap.counts(), snap.templates(), snap.schemes(),
                Map.of(), snap.inventoryReceipts(), snap.materialIssues()
        );
        assertThrows(IllegalStateException.class, () -> store.save(tampered));
    }

    // ==================== 2. 复检处置受控撤销（保留痕迹、恢复良品、派生料头作废、母卷消耗不变） ====================

    @Test
    @SuppressWarnings("unchecked")
    void revokeQualityDispositionRestoresGoodQuantityVoidsDerivedRemnantAndBlocksTamperedRemnant() {
        FileInventoryStore store = new FileInventoryStore(temp.resolve("revoke-disp.json").toString());
        RemnantService inv = new RemnantService(store, true);
        inv.voidDefect("ROLL-2026-0920", 3, "清空工位内干扰疵点");
        inv.voidDefect("ROLL-2026-0920", 4, "清空工位内干扰疵点");

        CuttingTask task = inv.saveTask(new CuttingTask(null, "复检撤销任务", "TC涤棉-B2026", "SO-REV-1", 0,
                List.of(new CuttingTask.Line(1, "主片", 2000, 1000, 10, false))));
        SolveRequest req = new SolveRequest();
        req.setTaskId(task.id());
        req.setTaskRevision(task.revision());
        req.setAllowLongitudinal(false);
        req.setRollL(10000);
        req.setWindowStartY(5000);
        req.setDemands(List.of(new PieceDemand(1, "主片", 2000, 1000, 10, false)));
        CuttingWorkflowService workflow = new CuttingWorkflowService(solver(), inv, new ToolpathOptimizerService());
        var solved = workflow.solve(req);
        String planId = solved.getPlanId();
        workflow.confirm(new CutReport(planId, 10000, 10, List.of(), "A-01"));

        double usedBefore = inv.getMotherRoll("ROLL-2026-0920").getUsedLength();
        double remainingBefore = inv.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength();

        // 对裁片 #1 做转料头复检处置，对裁片 #2 也做转料头复检处置
        QualityDisposition disp1 = inv.disposeQuality(planId, new QualityDisposition.Command(
                "op-disp-piece-000001", 0, 1, "REMNANT", "误判色污", "检验员甲",
                new QualityDisposition.Recovery(100, 100, 500, 500, "B-01", "RECOVERABLE")));
        QualityDisposition disp2 = inv.disposeQuality(planId, new QualityDisposition.Command(
                "op-disp-piece-000002", 1, 2, "REMNANT", "待检回收", "检验员甲",
                new QualityDisposition.Recovery(100, 100, 500, 500, "隔离区", "QUARANTINED")));

        // 验证派生料头自动继承父母卷的缸号与色号
        RemnantStock derived1 = inv.scanOrGetById(disp1.remnantId());
        assertNotNull(derived1);
        assertEquals("BAT-202609-A1", derived1.getBatchNo());
        assertEquals("藏青色 (PANTONE 19-4024)", derived1.getColor());
        assertEquals(Map.of("1", 8), inv.completedQuantities(task.id()));

        // 撤销处置 #1
        var revokeCmd1 = new RemnantService.RevokeDispositionCommand("REVOKE-KEY-001", "主管李强", "复核确认裁片合格，撤销误判");
        Map<String, Object> revokedRes = inv.revokeQualityDisposition(planId, disp1.id(), revokeCmd1);
        Map<String, Object> reportView = (Map<String, Object>) revokedRes.get("report");
        Map<String, Object> taskView = (Map<String, Object>) revokedRes.get("task");

        // 原始处置不删除，附加 revocation 痕迹
        List<QualityDisposition> allEvents = (List<QualityDisposition>) reportView.get("qualityDispositions");
        assertEquals(2, allEvents.size());
        assertTrue(allEvents.get(0).hasRevocation());
        assertEquals("主管李强", allEvents.get(0).revocation().operator());
        assertEquals(9, reportView.get("netFinishedPieceCount"));
        assertEquals(Map.of("1", 9), inv.completedQuantities(task.id()));
        assertEquals(9, taskView.get("completedTotal"));
        assertEquals(1, taskView.get("remaining"));

        // 派生料头转 REVOKED 不再可用，且母卷消耗绝对不变
        assertNull(inv.scanOrGetById(disp1.remnantId()));
        RemnantStock afterDerived1 = inv.getAllRemnants().stream().filter(r -> disp1.remnantId().equals(r.getId())).findFirst().orElseThrow();
        assertEquals("REVOKED", afterDerived1.getStatus());
        assertEquals(usedBefore, inv.getMotherRoll("ROLL-2026-0920").getUsedLength(), 1e-6);
        assertEquals(remainingBefore, inv.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength(), 1e-6);

        // 流水包含 QUALITY_DISPOSITION_REVOKE 且携带 reverses 反向关联，reconcileInventory 保持 BALANCED
        var snap = store.load();
        assertTrue(snap.ledger().stream().anyMatch(e -> "QUALITY_DISPOSITION_REVOKE".equals(e.eventType()) && !e.reverses().isEmpty()));
        assertEquals("BALANCED", inv.reconcileInventory().get("status"));

        // 幂等重放不升版本、同键异体 409、换键重复撤销 409
        long revAfterRevoke = ((Number) revokedRes.get("revision")).longValue();
        Map<String, Object> replay = inv.revokeQualityDisposition(planId, disp1.id(), revokeCmd1);
        assertEquals(revAfterRevoke, ((Number) replay.get("revision")).longValue());
        assertThrows(InventoryConflictException.class, () -> inv.revokeQualityDisposition(planId, disp1.id(),
                new RemnantService.RevokeDispositionCommand("REVOKE-KEY-001", "主管李强", "篡改原因")));
        assertThrows(InventoryConflictException.class, () -> inv.revokeQualityDisposition(planId, disp1.id(),
                new RemnantService.RevokeDispositionCommand("REVOKE-KEY-DUP", "主管李强", "再次撤销")));

        // 若派生料头已发生移库变更，则拦截撤销 409
        long curRev = ((Number) inv.transferOptions().get("revision")).longValue();
        inv.transferInventory("TR-MOVE-DERIVED-2", new InventoryTransfer.Command(
                curRev, "移库新仓", "转移隔离料头", "仓管", List.of(new InventoryTransfer.Material("remnant", disp2.remnantId()))));
        assertThrows(InventoryConflictException.class, () -> inv.revokeQualityDisposition(planId, disp2.id(),
                new RemnantService.RevokeDispositionCommand("REVOKE-KEY-002", "主管李强", "尝试撤销已移库派生料头")));
        assertEquals("BALANCED", inv.reconcileInventory().get("status"));
    }

    // ==================== 3. 采购批量入库 / 车间领退料 / 母卷级报废（含 JDBC V10 事务与不可变验真） ====================

    @Test
    @SuppressWarnings("unchecked")
    void receiptsIssuesAndRollScrapWorkAcrossJdbcV10WithRollbackAndAppendOnlyGuards() {
        DataSource ds = createJdbcDatabase();
        JdbcInventoryStore jdbcStore = new JdbcInventoryStore(ds);
        RemnantService inv = new RemnantService(jdbcStore, true);
        SchedulingStudioService studio = new SchedulingStudioService(inv, solver());

        // 1. 采购批量入库：直通 PASSED 缺检验员 -> 400
        assertThrows(IllegalArgumentException.class, () -> inv.receiveInventoryBatch(new RemnantService.InventoryReceiptCommand(
                "RCV-BAD-NO-INSP", "盛泽纺织厂", "DN-2026-001", "收货员周涛", "首批到货",
                List.of(new RemnantService.InventoryReceiptRollInput(
                        "ROLL-NEW-01", "棉麻-M1", "天然棉麻", "米灰", "DYELOT-88", 2000, 50000, 260.0, 2.5, "原料区 A-01", "PASSED", null
                ))
        )));

        // 2. 合法整批入库 2 卷（第 1 卷默认 PENDING，第 2 卷显式 PASSED 带检验员）
        var receiptCmd = new RemnantService.InventoryReceiptCommand(
                "RCV-OK-001", "盛泽纺织厂", "DN-2026-001", "收货员周涛", "首批大货入库",
                List.of(
                        new RemnantService.InventoryReceiptRollInput(
                                "ROLL-NEW-01", "棉麻-M1", "天然棉麻", "米灰", "DYELOT-88", 2000, 50000, 260.0, 2.5, "原料区 A-01", null, null
                        ),
                        new RemnantService.InventoryReceiptRollInput(
                                "ROLL-NEW-02", "棉麻-M1", "天然棉麻", "米灰", "DYELOT-88", 2000, 40000, 260.0, 2.2, "原料区 A-02", "PASSED", "质检员陈峰"
                        )
                )
        );
        Map<String, Object> rcvRes = inv.receiveInventoryBatch(receiptCmd);
        InventoryReceiptDocument rcvDoc = (InventoryReceiptDocument) rcvRes.get("document");
        List<MotherRollInfo> createdRolls = (List<MotherRollInfo>) rcvRes.get("createdRolls");
        assertEquals(2, createdRolls.size());
        assertEquals("PENDING", inv.getMotherRoll("ROLL-NEW-01").getInspectionStatus());
        assertEquals("PASSED", inv.getMotherRoll("ROLL-NEW-02").getInspectionStatus());
        assertEquals("质检员陈峰", inv.getMotherRoll("ROLL-NEW-02").getInspector());
        assertEquals(2.5, inv.getMotherRoll("ROLL-NEW-01").getShrinkageRate(), 1e-6);
        assertEquals("BALANCED", inv.reconcileInventory().get("status"));

        // 幂等重放 + 同键异体 409
        assertEquals(rcvDoc, inv.receiveInventoryBatch(receiptCmd).get("document"));
        assertThrows(InventoryConflictException.class, () -> inv.receiveInventoryBatch(new RemnantService.InventoryReceiptCommand(
                "RCV-OK-001", "其他厂", "DN-2026-001", "收货员周涛", "改供应商", receiptCmd.rolls()
        )));

        // 未放行 PENDING 待检卷禁止领料出库（防错拦截 409），放行后即可合法领用且对账保持 BALANCED
        assertThrows(InventoryConflictException.class, () -> inv.postMaterialIssue(new RemnantService.MaterialIssueCommand(
                "ISS-PENDING-BLOCK", "ISSUE", "ROLL-NEW-01", "CUTTER-01", "白班", "领料员赵敏", null, "试图领取待检卷"
        )));
        Map<String, Object> passRes = inv.completeMotherRollInspection("ROLL-NEW-01",
                new RemnantService.MotherRollInspectionCommand("PASSED", "质检员陈峰", "跑布验疵合格放行"));
        assertEquals("PASSED", ((MotherRollInfo) passRes.get("roll")).getInspectionStatus());
        assertEquals("质检员陈峰", ((MotherRollInfo) passRes.get("roll")).getInspector());
        assertEquals("BALANCED", inv.reconcileInventory().get("status"));

        // 3. 车间领料 ISSUE -> 更新机台、班组、库位
        var issueCmd = new RemnantService.MaterialIssueCommand(
                "ISS-KEY-001", "ISSUE", "ROLL-NEW-02", "CUTTER-02", "白班A组", "领料员赵敏", null, "2号裁床开机备料"
        );
        Map<String, Object> issueRes = inv.postMaterialIssue(issueCmd);
        MaterialIssueDocument issueDoc = (MaterialIssueDocument) issueRes.get("document");
        MotherRollInfo issuedRoll = (MotherRollInfo) issueRes.get("roll");
        assertEquals("CUTTER-02", issuedRoll.getIssuedMachineId());
        assertEquals("白班A组", issuedRoll.getIssuedShiftTeam());
        assertEquals("车间:CUTTER-02", issuedRoll.getStorageLocation());
        assertEquals("车间:CUTTER-02", issueDoc.toLocation());
        assertEquals("BALANCED", inv.reconcileInventory().get("status"));

        // 重复领料未先退料 -> 409
        assertThrows(InventoryConflictException.class, () -> inv.postMaterialIssue(new RemnantService.MaterialIssueCommand(
                "ISS-KEY-DUP", "ISSUE", "ROLL-NEW-02", "CUTTER-03", "夜班", "领料员赵敏", null, "试图抢料"
        )));

        // 若该卷被活跃排程方案锁定，则禁止退料与母卷报废（均拦截 409）
        var fam = studio.saveOrMergeDemandFamily(new SchedulingStudioService.SaveDemandFamilyCommand(
                null, null, "锁卷防护单", "棉麻-M1", "SO-LOCK", "RECT_2D",
                2000.0, 0.0, 0.0, null, null, null, null, null, null,
                List.of(new SchedulingStudioService.DemandLineInput(1, "帘片", 1000, 1000, 1, false, null, null, null, null, null))
        ));
        String taskId = (String) fam.get("id");
        var layout = new SchedulingScheme.Layout2DPayload(
                List.of(new SchedulingScheme.PlacementItem(1, 1, "帘片", 0, 0, 1000, 1000, 0, false, null)),
                List.of(), List.of()
        );
        var confirmed = studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "SCH-LOCK-RET", "实卷方案", "RECT_2D", "DEFAULT", "JAVA_FAST", "直刀",
                taskId, null, null, "STOCK_ROLL", "ROLL-NEW-02", null, "棉麻-M1",
                2000, 1000, 0.0, 1000, 0, 0, 50.0, 1.0, false, null, layout, null
        ));
        String schemeId = ((SchedulingScheme) confirmed.get("scheme")).id();

        assertThrows(InventoryConflictException.class, () -> inv.postMaterialIssue(new RemnantService.MaterialIssueCommand(
                "RET-LOCKED-1", "RETURN", "ROLL-NEW-02", null, null, "领料员赵敏", "原料区 A-02", "在制强退"
        )));
        assertThrows(InventoryConflictException.class, () -> inv.scrapMotherRoll("ROLL-NEW-02",
                new RemnantService.ScrapRollCommand("SCRAP-LOCKED-1", "主管", "在制强报废")));

        // 完工后（实切 1000mm，剩 39000mm）即可合法退料回库，再办理母卷级报废
        studio.completeScheme(schemeId, new SchedulingStudioService.CompleteSchemeCommand(1000.0, List.of(), false, null, "操作工"));
        Map<String, Object> retRes = inv.postMaterialIssue(new RemnantService.MaterialIssueCommand(
                "RET-OK-001", "RETURN", "ROLL-NEW-02", null, null, "领料员赵敏", "原料区 A-02", "完工余卷退库"
        ));
        MotherRollInfo returnedRoll = (MotherRollInfo) retRes.get("roll");
        assertNull(returnedRoll.getIssuedMachineId());
        assertEquals("原料区 A-02", returnedRoll.getStorageLocation());

        // 4. 母卷级报废：保留 usedLength=1000 与 totalLength=40000，清零剩余 39000 并记录 scrappedLengthMm=39000
        var scrapCmd = new RemnantService.ScrapRollCommand("SCRAP-OK-001", "品质经理", "余料受潮发霉整卷报废");
        Map<String, Object> scrapRes = inv.scrapMotherRoll("ROLL-NEW-02", scrapCmd);
        MotherRollInfo scrappedRoll = (MotherRollInfo) scrapRes.get("roll");
        assertEquals("SCRAPPED", scrappedRoll.getInspectionStatus());
        assertEquals(0.0, scrappedRoll.getCurrentRemainingLength(), 1e-6);
        assertEquals(1000.0, scrappedRoll.getUsedLength(), 1e-6);
        assertEquals(40000.0, scrappedRoll.getTotalLength(), 1e-6);
        assertEquals(39000.0, scrappedRoll.getScrappedLengthMm(), 1e-6);
        assertEquals("BALANCED", inv.reconcileInventory().get("status"));

        // 幂等重放 + 同键异体 409 + 已报废母卷禁止领料/重复报废
        assertEquals(scrapRes.get("revision"), inv.scrapMotherRoll("ROLL-NEW-02", scrapCmd).get("revision"));
        assertThrows(InventoryConflictException.class, () -> inv.scrapMotherRoll("ROLL-NEW-02",
                new RemnantService.ScrapRollCommand("SCRAP-OK-001", "品质经理", "改原因")));
        assertThrows(InventoryConflictException.class, () -> inv.postMaterialIssue(new RemnantService.MaterialIssueCommand(
                "ISS-AFTER-SCRAP", "ISSUE", "ROLL-NEW-02", "CUTTER-01", null, "领料员", null, "误领报废卷"
        )));

        // 5. JDBC V10 跨实例重启持久验证 + 不可变校验 + 数据库约束失败回滚
        RemnantService reopened = new RemnantService(new JdbcInventoryStore(ds), false);
        assertEquals(1, reopened.listInventoryReceipts().size());
        assertEquals(2, reopened.listMaterialIssues().size());
        assertEquals("SCRAPPED", reopened.getMotherRoll("ROLL-NEW-02").getInspectionStatus());
        assertEquals("BALANCED", reopened.reconcileInventory().get("status"));

        InventorySnapshot afterJdbc = jdbcStore.load();
        InventorySnapshot deletedIssue = new InventorySnapshot(
                afterJdbc.rolls(), afterJdbc.remnants(), afterJdbc.receipts(), afterJdbc.remnantSeq(), afterJdbc.defectSeq(),
                afterJdbc.tasks(), afterJdbc.plans(), afterJdbc.revision(), afterJdbc.executions(), afterJdbc.ledger(),
                afterJdbc.transfers(), afterJdbc.outbox(), afterJdbc.counts(), afterJdbc.templates(), afterJdbc.schemes(),
                afterJdbc.qualityReleases(), afterJdbc.inventoryReceipts(), Map.of()
        );
        assertThrows(IllegalStateException.class, () -> jdbcStore.save(deletedIssue));

        // 注入 DB 约束触发写入失败，验证整事务回滚
        new JdbcTemplate(ds).execute("ALTER TABLE material_issue_document ADD CONSTRAINT refuse_issue CHECK (idempotency_key <> 'ISS-ROLLBACK')");
        assertThrows(org.springframework.dao.DataAccessException.class, () -> reopened.postMaterialIssue(
                new RemnantService.MaterialIssueCommand("ISS-ROLLBACK", "ISSUE", "ROLL-NEW-01", "CUTTER-09", null, "甲", null, "回滚测试")
        ));
        assertNull(reopened.getMotherRoll("ROLL-NEW-01").getIssuedMachineId());
        assertEquals("BALANCED", reopened.reconcileInventory().get("status"));
    }

    // ==================== 4. 缩水率修复、缸号/色号防色差防呆、生产主数据与同缸加急补片 ====================

    @Test
    @SuppressWarnings("unchecked")
    void shrinkageUpdateBatchColorGuardAndUrgentSameBatchReplenishWorkEndToEnd() {
        RemnantService inv = new RemnantService(temp.resolve("batch-replenish.json").toString());
        SchedulingStudioService studio = new SchedulingStudioService(inv, solver());

        // 1. 修复母卷档案更新漏拷贝 shrinkageRate 的 bug
        MotherRollInfo rollCopy = inv.getMotherRoll("ROLL-2026-0920");
        MotherRollInfo updateReq = new MotherRollInfo(
                rollCopy.getRollId(), rollCopy.getRollModel(), rollCopy.getBatchNo(), rollCopy.getSupplier(),
                rollCopy.getMaterialName(), rollCopy.getColor(), rollCopy.getGrammage(), rollCopy.getComposition(),
                rollCopy.getWidth(), rollCopy.getTotalLength(), rollCopy.getStorageLocation()
        );
        updateReq.setShrinkageRate(3.25);
        updateReq.setInspectionStatus(rollCopy.getInspectionStatus());
        inv.saveOrUpdateMotherRoll(updateReq);
        assertEquals(3.25, inv.getMotherRoll("ROLL-2026-0920").getShrinkageRate(), 1e-6);

        // 准备同型号不同缸号/色号的另一母卷，用于防色差拦截测试
        MotherRollInfo otherBatchRoll = new MotherRollInfo(
                "ROLL-OTHER-BATCH", "TC涤棉-B2026", "BAT-9999-Z9", "其他染厂", "涤棉", "炭黑色",
                240.0, "涤棉", 2000, 30000, "原料库 R-09"
        );
        otherBatchRoll.setInspectionStatus("PASSED");
        inv.saveOrUpdateMotherRoll(otherBatchRoll);

        // 2. 创建带交期/优先级/客户/齐套组/机台/班组与指定缸号色号的强约束需求族
        Map<String, Object> fam = studio.saveOrMergeDemandFamily(new SchedulingStudioService.SaveDemandFamilyCommand(
                null, null, "酒店窗帘A栋加急单", "TC涤棉-B2026", "SO-VIP-001", "RECT_2D",
                3000.0, 0.0, 0.0, null, null, null, null, null, null,
                List.of(new SchedulingStudioService.DemandLineInput(1, "主帘", 800, 1000, 2, false, null, null, null, null, null)),
                "2026-12-05", "HIGH", "希尔顿工程部", "KIT-A01", "BAT-202609-A1", "藏青色 (PANTONE 19-4024)", true, "CUTTER-01", "白班A组"
        ));
        String taskId = (String) fam.get("id");
        assertEquals("2026-12-05", fam.get("dueDate"));
        assertEquals("HIGH", fam.get("priority"));
        assertEquals("希尔顿工程部", fam.get("customerName"));
        assertEquals("KIT-A01", fam.get("kittingGroup"));
        assertEquals("BAT-202609-A1", fam.get("requiredBatchNo"));
        assertEquals("藏青色 (PANTONE 19-4024)", fam.get("requiredColor"));
        assertEquals(Boolean.TRUE, fam.get("strictBatchMatch"));
        assertEquals("CUTTER-01", fam.get("machineId"));
        assertEquals("白班A组", fam.get("shiftTeam"));

        // 3. RemnantService 选料候选与准备排料防色差拦截
        SolveRequest probe = new SolveRequest();
        probe.setTaskId(taskId);
        probe.setTaskRevision(inv.getTask(taskId).revision());
        probe.setRollModel("TC涤棉-B2026");
        probe.setRollId("ROLL-OTHER-BATCH");
        probe.setFeedPortType("roll");
        probe.setRollW(2000);
        probe.setRollL(2000);
        probe.setWindowStartY(0);
        probe.setDemands(List.of(new PieceDemand(1, "主帘", 800, 1000, 2, false)));

        List<Map<String, Object>> candidates = inv.materialCandidates(probe);
        assertTrue(candidates.stream().noneMatch(c -> "ROLL-OTHER-BATCH".equals(c.get("id"))), "选料候选必须过滤缸号不匹配的母卷");
        assertTrue(candidates.stream().anyMatch(c -> "ROLL-2026-0920".equals(c.get("id"))));

        IllegalArgumentException prepErr = assertThrows(IllegalArgumentException.class, () -> inv.prepareTaskSolve(probe));
        assertTrue(prepErr.getMessage().contains("缸号不匹配"));

        // 4. SchedulingStudioService 确认方案与绑卷防色差拦截
        var layout = new SchedulingScheme.Layout2DPayload(
                List.of(
                        new SchedulingScheme.PlacementItem(1, 1, "主帘", 0, 0, 800, 1000, 0, false, null),
                        new SchedulingScheme.PlacementItem(2, 1, "主帘", 800, 0, 800, 1000, 0, false, null)
                ), List.of(), List.of()
        );
        assertThrows(IllegalArgumentException.class, () -> studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "SCH-BAD-BATCH", "错缸方案", "RECT_2D", "DEFAULT", "JAVA_FAST", "直刀",
                taskId, null, "SO-VIP-001", "STOCK_ROLL", "ROLL-OTHER-BATCH", null, "TC涤棉-B2026",
                2000, 1000, 0.0, 1000, 0, 0, 80.0, 1.6, false, null, layout, null
        )));

        // 虚拟母卷确认方案后，绑定错缸母卷也必须拦截
        var virtualRes = studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "SCH-VIRTUAL-OK", "虚拟方案", "RECT_2D", "DEFAULT", "JAVA_FAST", "直刀",
                taskId, null, "SO-VIP-001", "VIRTUAL_ROLL", null, null, "TC涤棉-B2026",
                2000, 1000, null, 1000, 0, 0, 80.0, 1.6, false, null, layout, null
        ));
        String schemeId = ((SchedulingScheme) virtualRes.get("scheme")).id();
        assertThrows(IllegalArgumentException.class, () -> studio.bindRollToScheme(schemeId,
                new SchedulingStudioService.BindRollCommand("ROLL-OTHER-BATCH", false, null, null, 0.0)));

        // 绑定同缸同色母卷 ROLL-2026-0920 成功，完工并判废 1 件（裁片 #1）
        studio.bindRollToScheme(schemeId, new SchedulingStudioService.BindRollCommand("ROLL-2026-0920", false, null, null, 5000.0));
        studio.completeScheme(schemeId, new SchedulingStudioService.CompleteSchemeCommand(1000.0, List.of(1), false, null, "裁剪工小张"));

        // 5. 一键创建同缸加急补片任务：自动继承母卷缸号/色号/型号、priority=URGENT、strictBatchMatch=true、缺口件数=1
        var repCmd = new SchedulingStudioService.ReplenishTaskCommand("REPL-KEY-001", "排程员周丽", "实切判废1片急补");
        Map<String, Object> repRes = studio.createReplenishTaskFromScheme(schemeId, repCmd);
        CuttingTask replenishTask = (CuttingTask) repRes.get("task");
        assertEquals(schemeId, repRes.get("sourceSchemeId"));
        assertEquals("URGENT", replenishTask.priority());
        assertEquals(Boolean.TRUE, replenishTask.strictBatchMatch());
        assertEquals("BAT-202609-A1", replenishTask.requiredBatchNo());
        assertEquals("藏青色 (PANTONE 19-4024)", replenishTask.requiredColor());
        assertEquals("TC涤棉-B2026", replenishTask.materialModel());
        assertEquals(1, replenishTask.demands().size());
        assertEquals(1, replenishTask.demands().get(0).quantity());
        assertEquals("BALANCED", inv.reconcileInventory().get("status"));

        // 幂等重放返回同一补片任务，不建重单
        Map<String, Object> repReplay = studio.createReplenishTaskFromScheme(schemeId, repCmd);
        assertEquals(replenishTask.id(), ((CuttingTask) repReplay.get("task")).id());
    }

    @Test
    void strictBatchMatchLocksEstablishedBatchAcrossSchemesAndIncludeQuarantinedExposesLostRemnants() {
        RemnantService inv = new RemnantService(temp.resolve("strict-batch-lost.json").toString());
        SchedulingStudioService studio = new SchedulingStudioService(inv, solver());

        MotherRollInfo rollB = new MotherRollInfo(
                "ROLL-STRICT-B", "TC涤棉-B2026", "BAT-SECOND-B2", "染厂B", "涤棉", "藏青色 (PANTONE 19-4024)",
                240.0, "涤棉", 2000, 30000, "原料库 R-B"
        );
        rollB.setInspectionStatus("PASSED");
        inv.saveOrUpdateMotherRoll(rollB);

        // 任务只开启 strictBatchMatch=true，不预先指定 requiredBatchNo
        Map<String, Object> fam = studio.saveOrMergeDemandFamily(new SchedulingStudioService.SaveDemandFamilyCommand(
                null, null, "同单同缸动态锁缸任务", "TC涤棉-B2026", "SO-STRICT-2", "RECT_2D",
                3000.0, 0.0, 0.0, null, null, null, null, null, null,
                List.of(new SchedulingStudioService.DemandLineInput(1, "门幅帘", 800, 1000, 2, false, null, null, null, null, null)),
                "2026-12-12", "URGENT", "客户X", "KIT-X", null, null, true, "CUT-05", "夜班"
        ));
        String taskId = (String) fam.get("id");
        var onePieceLayout = new SchedulingScheme.Layout2DPayload(
                List.of(new SchedulingScheme.PlacementItem(1, 1, "门幅帘", 0, 0, 800, 1000, 0, false, null)),
                List.of(), List.of()
        );
        // 首方案用 ROLL-2026-0920 (BAT-202609-A1) 锁定本单缸号
        studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "SCH-STRICT-1", "首方案锁A1缸", "RECT_2D", "DEFAULT", "JAVA_FAST", "直刀",
                taskId, null, null, "STOCK_ROLL", "ROLL-2026-0920", null, "TC涤棉-B2026",
                2000, 1000, 5000.0, 1000, 0, 0, 40.0, 0.8, false, null, onePieceLayout, null
        ));
        // 次方案试图混用 BAT-SECOND-B2 缸母卷 -> 必须拦截防色差
        IllegalArgumentException err = assertThrows(IllegalArgumentException.class, () -> studio.confirmScheme(
                new SchedulingStudioService.ConfirmSchemeCommand(
                        "SCH-STRICT-2", "混缸次方案", "RECT_2D", "DEFAULT", "JAVA_FAST", "直刀",
                        taskId, null, null, "STOCK_ROLL", "ROLL-STRICT-B", null, "TC涤棉-B2026",
                        2000, 1000, 0.0, 1000, 0, 0, 40.0, 0.8, false, null, onePieceLayout, null
                )
        ));
        assertTrue(err.getMessage().contains("同单同缸强约束拦截"));

        // 盘亏一条料头后，/api/remnants?includeQuarantined=true 应包含 LOST 与 QUARANTINED，默认不传则排除
        long rev = ((Number) inv.countOptions().get("revision")).longValue();
        inv.countInventory("CNT-LOST-001", new com.example.cutdemotwo.business.model.InventoryCount.Command(
                rev, "盘亏测试", "仓管", List.of(new com.example.cutdemotwo.business.model.InventoryCount.Observation(
                "remnant", "REM-202609-001", false, 2000, 0))
        ));
        inv.updateStatus("REM-202609-002", "QUARANTINED");

        var controller = new com.example.cutdemotwo.controller.FabricCutController(solver(), inv, null, List.of());
        var onlyAvail = controller.listRemnants(null, false, null, null);
        assertTrue(onlyAvail.stream().noneMatch(r -> "REM-202609-001".equals(r.getId()) || "REM-202609-002".equals(r.getId())));
        var withSpecial = controller.listRemnants(null, true, null, null);
        assertTrue(withSpecial.stream().anyMatch(r -> "REM-202609-001".equals(r.getId()) && "LOST".equals(r.getStatus())));
        assertTrue(withSpecial.stream().anyMatch(r -> "REM-202609-002".equals(r.getId()) && "QUARANTINED".equals(r.getStatus())));
        assertEquals("BALANCED", inv.reconcileInventory().get("status"));
    }
}
