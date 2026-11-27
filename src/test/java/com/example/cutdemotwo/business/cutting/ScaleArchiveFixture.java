package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.CutReport;
import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.ExecutionOrder;
import com.example.cutdemotwo.business.model.InventoryCount;
import com.example.cutdemotwo.business.model.InventoryEvent;
import com.example.cutdemotwo.business.model.InventoryLedgerEntry;
import com.example.cutdemotwo.business.model.InventoryReceiptDocument;
import com.example.cutdemotwo.business.model.InventoryTransfer;
import com.example.cutdemotwo.business.model.MaterialIssueDocument;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.PieceDemand;
import com.example.cutdemotwo.business.model.QualityReleaseDocument;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.business.model.SolveResponse;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;

import javax.sql.DataSource;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * M3 热冷数据分离规模化压测 Fixture（仅用于测试，利用真实模型与 InventoryJournal 规范摘要写入历史冷归档）。
 */
public final class ScaleArchiveFixture {
    private static final ObjectMapper JSON = new ObjectMapper();

    private ScaleArchiveFixture() {}

    public record SeedStats(long totalRows, long totalJsonBytes, String firstColdPlanId, String coldRollId, int hotRolls, int hotRemnants, int hotTasks) {}

    public static SeedStats populateColdArchive(DataSource ds, int reportCount, int planPaddingSegments) {
        JdbcTemplate jdbc = new JdbcTemplate(ds);
        TransactionTemplate tx = new TransactionTemplate(new DataSourceTransactionManager(ds));
        return tx.execute(status -> {
            long now = 1_760_000_000_000L;
            String openingTx = UUID.randomUUID().toString();
            long seq = 0L;
            long outSeq = 0L;
            long totalJsonBytes = 0L;
            long totalRows = 0L;

            int coldRollCount = 300;
            int hotRollCount = 5;
            int coldRemnantCount = 300;
            int hotRemnantCount = 5;
            int coldTaskCount = Math.max(100, reportCount / 10);
            int hotTaskCount = 5;
            int docCount = Math.max(500, reportCount / 4);
            int coldPlanCount = Math.max(1000, reportCount / 2);

            List<Object[]> rollBatch = new ArrayList<>(500);
            List<Object[]> remBatch = new ArrayList<>(500);
            List<Object[]> taskBatch = new ArrayList<>(500);
            List<Object[]> planBatch = new ArrayList<>(500);
            List<Object[]> reportBatch = new ArrayList<>(500);
            List<Object[]> reportLinkBatch = new ArrayList<>(500);
            List<Object[]> execBatch = new ArrayList<>(500);
            List<Object[]> schemeBatch = new ArrayList<>(500);
            List<Object[]> transferBatch = new ArrayList<>(500);
            List<Object[]> transferLinkBatch = new ArrayList<>(500);
            List<Object[]> countBatch = new ArrayList<>(500);
            List<Object[]> countLinkBatch = new ArrayList<>(500);
            List<Object[]> releaseBatch = new ArrayList<>(500);
            List<Object[]> receiptBatch = new ArrayList<>(500);
            List<Object[]> receiptLinkBatch = new ArrayList<>(500);
            List<Object[]> issueBatch = new ArrayList<>(500);
            List<Object[]> ledgerBatch = new ArrayList<>(500);
            List<Object[]> outboxBatch = new ArrayList<>(500);

            InventoryLedgerEntry cp = new InventoryLedgerEntry(
                    UUID.randomUUID().toString(), ++seq, openingTx, "MIGRATION_OPENING",
                    "CHECKPOINT", "opening", openingTx, List.of(), "SYSTEM_MIGRATION",
                    now, 1L, 1L, List.of(), null, "{\"schemaVersion\":1}");
            String cpJson = JSON.writeValueAsString(cp);
            ledgerBatch.add(new Object[]{cp.id(), cp.sequence(), cp.transactionId(), cp.eventType(), cp.aggregateType(), cp.aggregateId(), cp.occurredAt(), cpJson});
            totalJsonBytes += cpJson.length();

            String coldRollSampleId = "COLD-ROLL-0001";
            for (int i = 1; i <= coldRollCount; i++) {
                String id = String.format("COLD-ROLL-%04d", i);
                MotherRollInfo r = new MotherRollInfo(id, "TC涤棉-COLD", "BAT-C-" + (i % 10), "历史织厂",
                        "压测冷母卷", "藏青", 240.0, "100%涤纶", 2000, 60000, "COLD-BAY");
                r.setUsedLength(60000);
                r.setCurrentRemainingLength(0);
                r.setInspectionStatus("PASSED");
                String raw = JSON.writeValueAsString(r);
                totalJsonBytes += raw.length();
                rollBatch.add(new Object[]{id, i - 1L, r.getRollModel(), r.getCurrentRemainingLength(), r.getUsedLength(), raw});
                var bal = InventoryJournal.balanceForRoll(r);
                seq = addOpeningLedger(ledgerBatch, openingTx, seq, "ROLL", id, bal.value(), now);
                totalRows++;
            }
            for (int i = 1; i <= hotRollCount; i++) {
                String id = String.format("HOT-ROLL-%04d", i);
                MotherRollInfo r = new MotherRollInfo(id, "TC涤棉-HOT", "BAT-H-" + i, "活跃织厂",
                        "活跃热母卷", "藏青", 240.0, "100%涤纶", 2000, 60000, "HOT-BAY");
                r.setUsedLength(5000);
                r.setCurrentRemainingLength(55000);
                r.setInspectionStatus("PASSED");
                String raw = JSON.writeValueAsString(r);
                totalJsonBytes += raw.length();
                rollBatch.add(new Object[]{id, (long) coldRollCount + i - 1L, r.getRollModel(), r.getCurrentRemainingLength(), r.getUsedLength(), raw});
                var bal = InventoryJournal.balanceForRoll(r);
                seq = addOpeningLedger(ledgerBatch, openingTx, seq, "ROLL", id, bal.value(), now);
                totalRows++;
            }

            for (int i = 1; i <= coldRemnantCount; i++) {
                String id = String.format("COLD-REM-%04d", i);
                RemnantStock rem = new RemnantStock(id, 1000, 1200, "COLD-LOC", "TC涤棉-COLD", "USED", coldRollSampleId, false, "冷料头");
                String raw = JSON.writeValueAsString(rem);
                totalJsonBytes += raw.length();
                remBatch.add(new Object[]{id, i - 1L, rem.getSourceRollId(), rem.getParentRemnantId(), rem.getStatus(), rem.getWidth(), rem.getLength(), raw});
                seq = addOpeningLedger(ledgerBatch, openingTx, seq, "REMNANT", id, InventoryJournal.canonical(rem), now);
                totalRows++;
            }
            for (int i = 1; i <= hotRemnantCount; i++) {
                String id = String.format("HOT-REM-%04d", i);
                RemnantStock rem = new RemnantStock(id, 1200, 1800, "HOT-LOC", "TC涤棉-HOT", "AVAILABLE", "HOT-ROLL-0001", false, "活跃料头");
                String raw = JSON.writeValueAsString(rem);
                totalJsonBytes += raw.length();
                remBatch.add(new Object[]{id, (long) coldRemnantCount + i - 1L, rem.getSourceRollId(), rem.getParentRemnantId(), rem.getStatus(), rem.getWidth(), rem.getLength(), raw});
                seq = addOpeningLedger(ledgerBatch, openingTx, seq, "REMNANT", id, InventoryJournal.canonical(rem), now);
                totalRows++;
            }

            // 预生成 20 个 ReportOutput.ReportedPiece 模拟真实几何/报工大载荷
            List<ReportOutput.ReportedPiece> twentyPieces = new ArrayList<>(20);
            List<PlacedPiece> heavyPieces = new ArrayList<>(planPaddingSegments);
            for (int p = 1; p <= 20; p++) {
                twentyPieces.add(new ReportOutput.ReportedPiece(p, 1, "主片-" + p, 0, (p - 1) * 100.0, 800, 1000, "QUALIFIED", "", null, 0));
            }
            for (int p = 1; p <= planPaddingSegments; p++) {
                heavyPieces.add(new PlacedPiece(p, "块-" + p + "-历史归档大载荷几何记录填充文本-" + "G".repeat(160),
                        (p % 10) * 180.0, (p / 10) * 180.0, 160.0, 160.0, false, 1));
            }

            List<CuttingTask> coldTasks = new ArrayList<>(coldTaskCount);
            for (int i = 1; i <= coldTaskCount; i++) {
                String tid = String.format("COLD-TASK-%04d", i);
                CuttingTask t = new CuttingTask(tid, "已完工冷任务-" + i, "TC涤棉-COLD", "EXT-C-" + i, 1L,
                        List.of(new CuttingTask.Line(1, "主片", 800, 1000, 10, false)));
                coldTasks.add(t);
                String raw = JSON.writeValueAsString(t);
                totalJsonBytes += raw.length();
                taskBatch.add(new Object[]{tid, i - 1L, t.revision(), t.materialModel(), raw});
                totalRows++;
            }
            for (int i = 1; i <= hotTaskCount; i++) {
                String tid = String.format("HOT-TASK-%04d", i);
                CuttingTask t = new CuttingTask(tid, "活跃待排任务-" + i, "TC涤棉-HOT", "EXT-H-" + i, 1L,
                        List.of(new CuttingTask.Line(1, "主片", 800, 1000, 10, false)));
                String raw = JSON.writeValueAsString(t);
                totalJsonBytes += raw.length();
                taskBatch.add(new Object[]{tid, (long) coldTaskCount + i - 1L, t.revision(), t.materialModel(), raw});
                var map = InventoryJournal.balancesForTask(t, Map.of());
                for (var bal : map.values()) {
                    seq = addOpeningLedger(ledgerBatch, openingTx, seq, bal.type(), bal.id(), bal.value(), now);
                }
                totalRows++;
            }

            String firstColdPlanId = null;
            for (int i = 1; i <= coldPlanCount; i++) {
                String pid = String.format("COLD-PLAN-%05d", i);
                String tid = String.format("COLD-TASK-%04d", ((i - 1) % coldTaskCount) + 1);
                SolveRequest req = new SolveRequest();
                req.setTaskId(tid);
                req.setTaskRevision(1L);
                req.setRollId(coldRollSampleId);
                req.setRollModel("TC涤棉-COLD");
                req.setRollW(2000);
                req.setRollL(5000);
                req.setFeedPortType("roll");
                req.setDemands(List.of(new PieceDemand(1, "主片", 800, 1000, 1, false)));
                SolveResponse resp = new SolveResponse();
                resp.setSuccess(true);
                resp.setPlanId(pid);
                resp.setRollW(2000);
                resp.setRollL(5000);
                resp.setFeedPortType("roll");
                resp.setDeductLen(1000);
                resp.setTotalArea(2.0);
                resp.setPieceArea(1.5);
                resp.setRemArea(0.3);
                resp.setWasteArea(0.2);
                resp.setPieces(heavyPieces);
                CuttingPlan cpObj = new CuttingPlan(pid, req, resp, "b-" + i, "REPORTED", "2026-01-01T10:00:00");
                String raw = JSON.writeValueAsString(cpObj);
                totalJsonBytes += raw.length();
                planBatch.add(new Object[]{pid, i - 1L, tid, "REPORTED", raw});
                totalRows++;
                if (planBatch.size() >= 250) totalJsonBytes += flushPlans(jdbc, planBatch);
            }

            // 2000+ cut_report：每个冷任务恰好关联 10 条（每条完成数量=1，合计10=task需求量，确保任务完全进入冷态）
            Map<String, Map<String, Map<String, Object>>> receiptsByColdTask = new LinkedHashMap<>();
            for (int i = 1; i <= reportCount; i++) {
                String pid = String.format("COLD-REPORT-PLAN-%05d", i);
                if (firstColdPlanId == null) firstColdPlanId = pid;
                int taskIdx = ((i - 1) / 10) % coldTaskCount;
                String tid = coldTasks.get(taskIdx).id();
                String rid = String.format("COLD-ROLL-%04d", ((i - 1) % coldRollCount) + 1);
                Map<String, Object> receipt = new LinkedHashMap<>();
                receipt.put("planId", pid);
                receipt.put("taskId", tid);
                receipt.put("taskRevision", 1L);
                receipt.put("feedPortType", "roll");
                receipt.put("rollId", rid);
                receipt.put("rollModel", "TC涤棉-COLD");
                receipt.put("status", "CONFIRMED");
                receipt.put("confirmedAt", "2026-01-01 10:00:00");
                receipt.put("usedArea", 2.0);
                receipt.put("pieceArea", 1.5);
                receipt.put("remArea", 0.3);
                receipt.put("wasteArea", 0.2);
                receipt.put("rejectedArea", 0.0);
                receipt.put("finishedPieceCount", 20);
                receipt.put("demandQuantities", Map.of("1", 1));
                receipt.put("pieceResults", twentyPieces);
                receipt.put("payloadNote", "历史只增冷报工归档载荷-" + i + "-" + "X".repeat(256));
                String raw = JSON.writeValueAsString(receipt);
                totalJsonBytes += raw.length();
                reportBatch.add(new Object[]{pid, i - 1L, tid, rid, null, "CONFIRMED", raw});
                reportLinkBatch.add(new Object[]{pid, tid});
                receiptsByColdTask.computeIfAbsent(tid, k -> new LinkedHashMap<>()).put(pid, receipt);
                seq = addOpeningLedger(ledgerBatch, openingTx, seq, "REPORT", pid, InventoryJournal.canonical(receipt), now);

                InventoryEvent ev = new InventoryEvent("OUTBOX-" + i, ++outSeq, "1", "INTERNAL",
                        "CUT_REPORT", pid, now, 1L, List.of());
                String evJson = JSON.writeValueAsString(ev);
                totalJsonBytes += evJson.length();
                outboxBatch.add(new Object[]{ev.id(), ev.sequence(), ev.inventoryRevision(), evJson});
                totalRows += 2;

                if (reportBatch.size() >= 250) {
                    jdbc.batchUpdate("INSERT INTO cut_report (id,sort_order,task_id,roll_id,source_remnant_id,status,data_json) VALUES (?,?,?,?,?,?,?)", reportBatch);
                    reportBatch.clear();
                    jdbc.batchUpdate("INSERT INTO cut_report_task_link (report_id,task_id) VALUES (?,?)", reportLinkBatch);
                    reportLinkBatch.clear();
                }
                if (ledgerBatch.size() >= 500) {
                    totalJsonBytes += flushLedger(jdbc, ledgerBatch);
                }
                if (outboxBatch.size() >= 500) {
                    jdbc.batchUpdate("INSERT INTO inventory_outbox (id,event_sequence,inventory_revision,data_json) VALUES (?,?,?,?)", outboxBatch);
                    outboxBatch.clear();
                }
            }

            // 为每个冷任务写入对应的 DEMAND 期初账本
            for (CuttingTask ct : coldTasks) {
                var tMap = InventoryJournal.balancesForTask(ct, receiptsByColdTask.getOrDefault(ct.id(), Map.of()));
                for (var bal : tMap.values()) {
                    seq = addOpeningLedger(ledgerBatch, openingTx, seq, bal.type(), bal.id(), bal.value(), now);
                    if (ledgerBatch.size() >= 500) totalJsonBytes += flushLedger(jdbc, ledgerBatch);
                }
            }

            // 终态执行单与终态排程方案
            for (int i = 1; i <= 200; i++) {
                String eid = String.format("COLD-EXEC-%04d", i);
                ExecutionOrder ex = new ExecutionOrder(eid, "key-ex-" + i, "COLD-PLAN-00001", "COLD-TASK-0001",
                        "ST-1", "roll", coldRollSampleId, Map.of("1", 1), "REPORTED", 2L, now, null, List.of());
                String exRaw = JSON.writeValueAsString(ex);
                totalJsonBytes += exRaw.length();
                execBatch.add(new Object[]{eid, i - 1L, ex.idempotencyKey(), ex.planId(), ex.taskId(), ex.materialType(), ex.materialId(), ex.state(), ex.version(), ex.expiresAt(), exRaw});

                String sid = String.format("COLD-SCHEME-%04d", i);
                SchedulingScheme sc = new SchedulingScheme(
                        sid, "key-sc-" + i, "冷归档方案-" + i, "2D", "SC-1", "ST-1", "常规",
                        "COLD-TASK-0001", "已完工冷任务-1", "EXT-C-1", "EXISTING_ROLL", coldRollSampleId, null, "TC涤棉-COLD",
                        2000, 1000, 0, 1000, 0, 0, 75.0, 1.5, 1, 1, 0, true,
                        Map.of("1", 1), List.of("COLD-PLAN-00001"), null, "COMPLETED",
                        null, null, null, null, "2026-01-01", "2026-01-01", "2026-01-01", null, null, List.of(), null);
                String scRaw = JSON.writeValueAsString(sc);
                totalJsonBytes += scRaw.length();
                schemeBatch.add(new Object[]{sid, i - 1L, sc.taskId(), sc.rollId(), sc.state(), sc.dimension(), scRaw});
                totalRows += 2;
            }

            // 5 张只增单据表各 docCount 条
            for (int i = 1; i <= docCount; i++) {
                String trId = String.format("COLD-TR-%05d", i);
                InventoryTransfer tr = new InventoryTransfer(trId, "tr-key-" + i,
                        new InventoryTransfer.Command(1L, "COLD-DEST", "冷归档移库-" + "T".repeat(128), "OP",
                                List.of(new InventoryTransfer.Material("roll", coldRollSampleId))),
                        now, 1L, List.of(new InventoryTransfer.Line("roll", coldRollSampleId, "A", "B")));
                String trRaw = JSON.writeValueAsString(tr);
                totalJsonBytes += trRaw.length();
                transferBatch.add(new Object[]{trId, tr.idempotencyKey(), now, 1L, trRaw});
                transferLinkBatch.add(new Object[]{trId, "roll", coldRollSampleId});
                seq = addOpeningLedger(ledgerBatch, openingTx, seq, "TRANSFER", trId, InventoryJournal.canonical(tr), now);

                String cntId = String.format("COLD-CNT-%05d", i);
                InventoryCount cnt = new InventoryCount(cntId, "cnt-key-" + i,
                        new InventoryCount.Command(1L, "冷盘点-" + "C".repeat(128), "OP", List.of()),
                        now, 1L, List.of(new InventoryCount.Line("roll", coldRollSampleId, 2000, 0, "PASSED", 2000, 0, "PASSED", 0, 60000, 60000, 60000)));
                String cntRaw = JSON.writeValueAsString(cnt);
                totalJsonBytes += cntRaw.length();
                countBatch.add(new Object[]{cntId, cnt.idempotencyKey(), now, 1L, cntRaw});
                countLinkBatch.add(new Object[]{cntId, "roll", coldRollSampleId, 1L});
                seq = addOpeningLedger(ledgerBatch, openingTx, seq, "COUNT", cntId, InventoryJournal.canonical(cnt), now);

                String qrId = String.format("COLD-QR-%05d", i);
                QualityReleaseDocument qr = new QualityReleaseDocument(qrId, "qr-key-" + i, "COLD-REM-0001",
                        QualityReleaseDocument.DECISION_RELEASE_AVAILABLE, "QUARANTINED", "AVAILABLE", "QA", "冷放行", now, 1L);
                String qrRaw = JSON.writeValueAsString(qr);
                totalJsonBytes += qrRaw.length();
                releaseBatch.add(new Object[]{qrId, qr.idempotencyKey(), qr.remnantId(), qr.decision(), now, 1L, qrRaw});
                seq = addOpeningLedger(ledgerBatch, openingTx, seq, "QUALITY_RELEASE", qrId, InventoryJournal.canonical(qr), now);

                String recId = String.format("COLD-IR-%05d", i);
                InventoryReceiptDocument rec = new InventoryReceiptDocument(recId, "ir-key-" + i, "历史供应商", "DN-" + i, "OP", "冷入库", now, 1L,
                        List.of(new InventoryReceiptDocument.Line(coldRollSampleId, "TC涤棉-COLD", "65/35涤棉", "藏青", "BAT-C", 2000, 60000, 240, 1.5, "COLD-BAY", "PASSED", "QA")));
                String recRaw = JSON.writeValueAsString(rec);
                totalJsonBytes += recRaw.length();
                receiptBatch.add(new Object[]{recId, rec.idempotencyKey(), rec.supplierName(), rec.deliveryNoteNo(), now, 1L, recRaw});
                receiptLinkBatch.add(new Object[]{recId, coldRollSampleId});
                seq = addOpeningLedger(ledgerBatch, openingTx, seq, "INVENTORY_RECEIPT", recId, InventoryJournal.canonical(rec), now);

                String issId = String.format("COLD-MI-%05d", i);
                MaterialIssueDocument iss = new MaterialIssueDocument(issId, "mi-key-" + i, MaterialIssueDocument.DIRECTION_ISSUE,
                        coldRollSampleId, "TC涤棉-COLD", "BAT-C", "M-1", "A", "OP", "COLD-BAY", "M-1", 0, "冷发料", now, 1L);
                String issRaw = JSON.writeValueAsString(iss);
                totalJsonBytes += issRaw.length();
                issueBatch.add(new Object[]{issId, iss.idempotencyKey(), iss.direction(), iss.rollId(), iss.machineId(), now, 1L, issRaw});
                seq = addOpeningLedger(ledgerBatch, openingTx, seq, "MATERIAL_ISSUE", issId, InventoryJournal.canonical(iss), now);

                totalRows += 5;
                if (ledgerBatch.size() >= 500) totalJsonBytes += flushLedger(jdbc, ledgerBatch);
                if (transferBatch.size() >= 250) {
                    flushDocs(jdbc, transferBatch, transferLinkBatch, countBatch, countLinkBatch, releaseBatch, receiptBatch, receiptLinkBatch, issueBatch);
                }
            }

            if (!rollBatch.isEmpty()) jdbc.batchUpdate("INSERT INTO mother_roll (id,sort_order,material_model,remaining_mm,used_mm,data_json) VALUES (?,?,?,?,?,?)", rollBatch);
            if (!remBatch.isEmpty()) jdbc.batchUpdate("INSERT INTO remnant_stock (id,sort_order,source_roll_id,parent_remnant_id,status,width_mm,length_mm,data_json) VALUES (?,?,?,?,?,?,?,?)", remBatch);
            if (!taskBatch.isEmpty()) jdbc.batchUpdate("INSERT INTO cutting_task (id,sort_order,revision,material_model,data_json) VALUES (?,?,?,?,?)", taskBatch);
            if (!planBatch.isEmpty()) totalJsonBytes += flushPlans(jdbc, planBatch);
            if (!reportBatch.isEmpty()) {
                jdbc.batchUpdate("INSERT INTO cut_report (id,sort_order,task_id,roll_id,source_remnant_id,status,data_json) VALUES (?,?,?,?,?,?,?)", reportBatch);
                jdbc.batchUpdate("INSERT INTO cut_report_task_link (report_id,task_id) VALUES (?,?)", reportLinkBatch);
            }
            if (!execBatch.isEmpty()) jdbc.batchUpdate("INSERT INTO execution_order (id,sort_order,idempotency_key,plan_id,task_id,material_type,material_id,state,version,expires_at,data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)", execBatch);
            if (!schemeBatch.isEmpty()) jdbc.batchUpdate("INSERT INTO scheduling_scheme (id,sort_order,task_id,roll_id,state,dimension,data_json) VALUES (?,?,?,?,?,?,?)", schemeBatch);
            flushDocs(jdbc, transferBatch, transferLinkBatch, countBatch, countLinkBatch, releaseBatch, receiptBatch, receiptLinkBatch, issueBatch);
            if (!ledgerBatch.isEmpty()) totalJsonBytes += flushLedger(jdbc, ledgerBatch);
            if (!outboxBatch.isEmpty()) jdbc.batchUpdate("INSERT INTO inventory_outbox (id,event_sequence,inventory_revision,data_json) VALUES (?,?,?,?)", outboxBatch);

            jdbc.update("UPDATE cutdemo_revision SET revision = 1, remnant_seq = 100, defect_seq = 100 WHERE id = 1");
            totalRows += seq;
            return new SeedStats(totalRows, totalJsonBytes, firstColdPlanId, coldRollSampleId, hotRollCount, hotRemnantCount, hotTaskCount);
        });
    }

    private static long addOpeningLedger(List<Object[]> batch, String txId, long seq, String type, String id, String afterJson, long now) {
        InventoryLedgerEntry e = new InventoryLedgerEntry(
                UUID.randomUUID().toString(), ++seq, txId, "MIGRATION_OPENING",
                type, id, txId, List.of(), "SYSTEM_MIGRATION", now, 1L, 1L, List.of(), null, afterJson);
        batch.add(new Object[]{e.id(), e.sequence(), e.transactionId(), e.eventType(), e.aggregateType(), e.aggregateId(), e.occurredAt(), JSON.writeValueAsString(e)});
        return seq;
    }

    private static long flushPlans(JdbcTemplate jdbc, List<Object[]> planBatch) {
        if (planBatch.isEmpty()) return 0L;
        jdbc.batchUpdate("INSERT INTO cutting_plan (id,sort_order,task_id,status,data_json) VALUES (?,?,?,?,?)", planBatch);
        planBatch.clear();
        return 0L;
    }

    private static long flushLedger(JdbcTemplate jdbc, List<Object[]> ledgerBatch) {
        if (ledgerBatch.isEmpty()) return 0L;
        long bytes = 0L;
        for (Object[] row : ledgerBatch) bytes += row[7].toString().length();
        jdbc.batchUpdate("INSERT INTO inventory_ledger (id,entry_sequence,transaction_id,event_type,aggregate_type,aggregate_id,occurred_at,data_json) VALUES (?,?,?,?,?,?,?,?)", ledgerBatch);
        ledgerBatch.clear();
        return bytes;
    }

    private static void flushDocs(
            JdbcTemplate jdbc,
            List<Object[]> transferBatch, List<Object[]> transferLinkBatch,
            List<Object[]> countBatch, List<Object[]> countLinkBatch,
            List<Object[]> releaseBatch,
            List<Object[]> receiptBatch, List<Object[]> receiptLinkBatch,
            List<Object[]> issueBatch
    ) {
        if (!transferBatch.isEmpty()) {
            jdbc.batchUpdate("INSERT INTO inventory_transfer (id,idempotency_key,posted_at,inventory_revision,data_json) VALUES (?,?,?,?,?)", transferBatch);
            transferBatch.clear();
            jdbc.batchUpdate("INSERT INTO inventory_transfer_material_link (transfer_id,material_type,material_id) VALUES (?,?,?)", transferLinkBatch);
            transferLinkBatch.clear();
        }
        if (!countBatch.isEmpty()) {
            jdbc.batchUpdate("INSERT INTO inventory_count (id,idempotency_key,posted_at,inventory_revision,data_json) VALUES (?,?,?,?,?)", countBatch);
            countBatch.clear();
            jdbc.batchUpdate("INSERT INTO inventory_count_material_link (count_id,material_type,material_id,inventory_revision) VALUES (?,?,?,?)", countLinkBatch);
            countLinkBatch.clear();
        }
        if (!releaseBatch.isEmpty()) {
            jdbc.batchUpdate("INSERT INTO quality_release_document (id,idempotency_key,remnant_id,decision,posted_at,inventory_revision,data_json) VALUES (?,?,?,?,?,?,?)", releaseBatch);
            releaseBatch.clear();
        }
        if (!receiptBatch.isEmpty()) {
            jdbc.batchUpdate("INSERT INTO inventory_receipt_document (id,idempotency_key,supplier_name,delivery_note_no,posted_at,inventory_revision,data_json) VALUES (?,?,?,?,?,?,?)", receiptBatch);
            receiptBatch.clear();
            jdbc.batchUpdate("INSERT INTO inventory_receipt_roll_link (receipt_id,roll_id) VALUES (?,?)", receiptLinkBatch);
            receiptLinkBatch.clear();
        }
        if (!issueBatch.isEmpty()) {
            jdbc.batchUpdate("INSERT INTO material_issue_document (id,idempotency_key,direction,roll_id,machine_id,posted_at,inventory_revision,data_json) VALUES (?,?,?,?,?,?,?,?)", issueBatch);
            issueBatch.clear();
        }
    }
}
