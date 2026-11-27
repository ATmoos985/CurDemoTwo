package com.example.cutdemotwo.persistence;

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
import com.example.cutdemotwo.business.model.QualityDisposition;
import com.example.cutdemotwo.business.model.QualityReleaseDocument;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.function.Consumer;

/**
 * JDBC 热冷数据分离与按需分页/点查协作者（仅属 persistence 层，绝不反向依赖 JdbcInventoryStore）。
 * 负责冷启动热池引导加载、V14 关联索引表写入维护、8 张历史只增表游标/分页/流式查询与冷对象点查。
 */
final class JdbcColdArchiveQueries {
    private static final TypeReference<Map<String, Object>> MAP_TYPE = new TypeReference<>() {};

    private final JdbcTemplate jdbc;
    private final TransactionTemplate readOnlyTransaction;
    private final ObjectMapper json;

    JdbcColdArchiveQueries(JdbcTemplate jdbc, TransactionTemplate readOnlyTransaction, ObjectMapper json) {
        this.jdbc = jdbc;
        this.readOnlyTransaction = readOnlyTransaction;
        this.json = json;
    }

    HotColdModels.HotInventoryBootstrap loadHotSnapshot() {
        return readOnlyTransaction.execute(status -> {
            Map<String, Object> meta = jdbc.queryForMap("SELECT revision, remnant_seq, defect_seq FROM cutdemo_revision WHERE id = 1");
            long revision = ((Number) meta.get("revision")).longValue();
            if (revision == 0) {
                return null;
            }
            Long maxLedgerSeq = jdbc.queryForObject("SELECT COALESCE(MAX(entry_sequence), 0) FROM inventory_ledger", Long.class);
            Long maxOutboxSeq = jdbc.queryForObject("SELECT COALESCE(MAX(event_sequence), 0) FROM inventory_outbox", Long.class);
            List<String> headIds = jdbc.query("SELECT id FROM inventory_outbox WHERE event_sequence = 1", (rs, i) -> rs.getString(1));
            String headId = headIds.isEmpty() ? null : headIds.get(0);

            List<HotColdModels.OrderedEntry<ExecutionOrder>> hotExecs = orderedRows(
                    "SELECT id, sort_order, data_json FROM execution_order WHERE state NOT IN ('REPORTED','CANCELLED','REVERSED','FAILED') ORDER BY sort_order",
                    ExecutionOrder.class);
            List<HotColdModels.OrderedEntry<SchedulingScheme>> hotSchemes = orderedRows(
                    "SELECT id, sort_order, data_json FROM scheduling_scheme WHERE state IN ('AWAITING_ROLL','READY_TO_CUT','DISPATCHED_MES') ORDER BY sort_order",
                    SchedulingScheme.class);
            List<HotColdModels.OrderedEntry<CuttingPlan>> hotPlans = orderedRows(
                    "SELECT id, sort_order, data_json FROM cutting_plan WHERE status = 'PENDING' ORDER BY sort_order",
                    CuttingPlan.class);

            Set<String> loadedPlanIds = new LinkedHashSet<>();
            hotPlans.forEach(p -> loadedPlanIds.add(p.id()));
            Set<String> extraPlanIds = new LinkedHashSet<>();
            hotExecs.forEach(e -> { if (!loadedPlanIds.contains(e.value().planId())) extraPlanIds.add(e.value().planId()); });
            hotSchemes.forEach(s -> {
                for (String pid : s.value().linkedPlanIds()) {
                    if (!loadedPlanIds.contains(pid)) extraPlanIds.add(pid);
                }
            });
            if (!extraPlanIds.isEmpty()) {
                hotPlans.addAll(loadOrderedByIds("cutting_plan", extraPlanIds, CuttingPlan.class));
            }

            List<HotColdModels.OrderedEntry<MotherRollInfo>> hotRolls = orderedRows(
                    "SELECT id, sort_order, data_json FROM mother_roll WHERE remaining_mm > 0.001 ORDER BY sort_order",
                    MotherRollInfo.class);
            List<HotColdModels.OrderedEntry<RemnantStock>> hotRemnants = orderedRows(
                    "SELECT id, sort_order, data_json FROM remnant_stock WHERE status IN ('AVAILABLE','QUARANTINED','LOST') ORDER BY sort_order",
                    RemnantStock.class);

            Set<String> loadedRollIds = new LinkedHashSet<>();
            hotRolls.forEach(r -> loadedRollIds.add(r.id()));
            Set<String> loadedRemnantIds = new LinkedHashSet<>();
            hotRemnants.forEach(r -> loadedRemnantIds.add(r.id()));

            Set<String> extraRollIds = new LinkedHashSet<>();
            Set<String> extraRemnantIds = new LinkedHashSet<>();
            Set<String> hotRefTaskIds = new LinkedHashSet<>();
            for (var e : hotExecs) {
                hotRefTaskIds.add(e.value().taskId());
                if ("roll".equalsIgnoreCase(e.value().materialType()) && !loadedRollIds.contains(e.value().materialId())) {
                    extraRollIds.add(e.value().materialId());
                } else if ("remnant".equalsIgnoreCase(e.value().materialType()) && !loadedRemnantIds.contains(e.value().materialId())) {
                    extraRemnantIds.add(e.value().materialId());
                }
            }
            for (var s : hotSchemes) {
                hotRefTaskIds.addAll(s.value().involvedTaskIds());
                if (s.value().rollId() != null && !loadedRollIds.contains(s.value().rollId())) extraRollIds.add(s.value().rollId());
                if (s.value().remnantId() != null && !loadedRemnantIds.contains(s.value().remnantId())) extraRemnantIds.add(s.value().remnantId());
            }
            for (var p : hotPlans) {
                if (p.value().request().getTaskId() != null) hotRefTaskIds.add(p.value().request().getTaskId());
                if ("PENDING".equals(p.value().status())) {
                    if (p.value().request().getRollId() != null && !loadedRollIds.contains(p.value().request().getRollId())) {
                        extraRollIds.add(p.value().request().getRollId());
                    }
                    if (p.value().request().getSourceRemnantId() != null && !loadedRemnantIds.contains(p.value().request().getSourceRemnantId())) {
                        extraRemnantIds.add(p.value().request().getSourceRemnantId());
                    }
                }
            }
            if (!extraRollIds.isEmpty()) hotRolls.addAll(loadOrderedByIds("mother_roll", extraRollIds, MotherRollInfo.class));
            if (!extraRemnantIds.isEmpty()) hotRemnants.addAll(loadOrderedByIds("remnant_stock", extraRemnantIds, RemnantStock.class));

            List<HotColdModels.OrderedEntry<CuttingTask>> hotTasks = loadHotTasks(hotRefTaskIds);
            Map<String, Long> activeCountRevisions = loadActiveCountRevisions(hotRolls, hotRemnants);

            return new HotColdModels.HotInventoryBootstrap(
                    revision,
                    ((Number) meta.get("remnant_seq")).intValue(),
                    ((Number) meta.get("defect_seq")).intValue(),
                    maxLedgerSeq == null ? 0L : maxLedgerSeq,
                    maxOutboxSeq == null ? 0L : maxOutboxSeq,
                    headId,
                    hotRolls, hotRemnants, hotTasks, hotPlans, hotExecs, hotSchemes,
                    activeCountRevisions,
                    nextSortOrder("mother_roll"),
                    nextSortOrder("remnant_stock"),
                    nextSortOrder("cutting_task"),
                    nextSortOrder("cutting_plan"),
                    nextSortOrder("cut_report"),
                    nextSortOrder("execution_order"),
                    nextSortOrder("scheduling_scheme")
            );
        });
    }

    private List<HotColdModels.OrderedEntry<CuttingTask>> loadHotTasks(Set<String> hotRefTaskIds) {
        List<HotColdModels.OrderedEntry<CuttingTask>> result = new ArrayList<>();
        int offset = 0;
        int batch = 100;
        while (true) {
            List<HotColdModels.OrderedEntry<CuttingTask>> page = jdbc.query(
                    "SELECT id, sort_order, data_json FROM cutting_task ORDER BY sort_order LIMIT ? OFFSET ?",
                    (rs, i) -> new HotColdModels.OrderedEntry<>(rs.getString(1), rs.getLong(2), json.readValue(rs.getString(3), CuttingTask.class)),
                    batch, offset
            );
            if (page.isEmpty()) break;
            List<HotColdModels.OrderedEntry<CuttingTask>> needCheck = new ArrayList<>();
            for (var item : page) {
                if (hotRefTaskIds.contains(item.id())) {
                    result.add(item);
                } else {
                    needCheck.add(item);
                }
            }
            if (!needCheck.isEmpty()) {
                Map<String, Map<String, Integer>> completedByTask = loadCompletedForTasks(needCheck.stream().map(HotColdModels.OrderedEntry::id).toList());
                for (var item : needCheck) {
                    CuttingTask task = item.value();
                    Map<String, Integer> done = completedByTask.getOrDefault(task.id(), Map.of());
                    boolean finished = !task.demands().isEmpty() && task.demands().stream()
                            .allMatch(line -> done.getOrDefault(String.valueOf(line.id()), 0) >= line.quantity());
                    if (!finished) {
                        result.add(item);
                    }
                }
            }
            if (page.size() < batch) break;
            offset += batch;
        }
        return result;
    }

    private Map<String, Map<String, Integer>> loadCompletedForTasks(List<String> taskIds) {
        if (taskIds.isEmpty()) return Map.of();
        String placeholders = String.join(",", Collections.nCopies(taskIds.size(), "?"));
        List<Object> args = new ArrayList<>(taskIds.size() * 2);
        args.addAll(taskIds);
        args.addAll(taskIds);
        Map<String, Map<String, Integer>> completedByTask = new HashMap<>();
        jdbc.query(
                "SELECT data_json FROM cut_report WHERE status <> 'REVERSED' AND (task_id IN (" + placeholders
                        + ") OR id IN (SELECT report_id FROM cut_report_task_link WHERE task_id IN (" + placeholders + ")))",
                rs -> {
                    Map<String, Object> receipt = json.readValue(rs.getString(1), MAP_TYPE);
                    for (String tid : taskIds) {
                        accumulateReceiptCompletion(receipt, tid, completedByTask.computeIfAbsent(tid, k -> new HashMap<>()));
                    }
                },
                args.toArray()
        );
        return completedByTask;
    }

    private void accumulateReceiptCompletion(Map<String, Object> receipt, String taskId, Map<String, Integer> target) {
        if ("REVERSED".equals(receipt.get("status"))) return;
        boolean multiTask = receipt.get("taskDemandQuantities") instanceof Map<?, ?>;
        if (multiTask) {
            Map<?, ?> multi = (Map<?, ?>) receipt.get("taskDemandQuantities");
            if (!(multi.get(taskId) instanceof Map<?, ?> quantities)) return;
            quantities.forEach((id, n) -> target.merge(id.toString(), ((Number) n).intValue(), Integer::sum));
            Map<?, ?> pieceSources = receipt.get("pieceSources") instanceof Map<?, ?> ps ? ps : null;
            if (pieceSources != null && receipt.get("qualityDispositions") instanceof List<?> events) {
                for (var raw : events) {
                    var event = json.convertValue(raw, QualityDisposition.class);
                    if (event.hasRevocation() || !"QUALIFIED".equals(event.originalOutcome())) continue;
                    Object srcObj = pieceSources.get(String.valueOf(event.command().pieceId()));
                    if (srcObj == null) srcObj = pieceSources.get(event.command().pieceId());
                    if (srcObj instanceof Map<?, ?> srcMap && Objects.equals(taskId, srcMap.get("taskId"))
                            && srcMap.get("lineId") instanceof Number ln) {
                        target.merge(String.valueOf(ln.intValue()), -1, Integer::sum);
                    }
                }
            }
        } else if (Objects.equals(taskId, receipt.get("taskId"))) {
            if (receipt.get("demandQuantities") instanceof Map<?, ?> quantities) {
                quantities.forEach((id, n) -> target.merge(id.toString(), ((Number) n).intValue(), Integer::sum));
            }
            if (receipt.get("qualityDispositions") instanceof List<?> events) {
                for (var raw : events) {
                    var event = json.convertValue(raw, QualityDisposition.class);
                    if (!event.hasRevocation() && "QUALIFIED".equals(event.originalOutcome())) {
                        target.merge(String.valueOf(event.demandId()), -1, Integer::sum);
                    }
                }
            }
        }
    }

    private Map<String, Long> loadActiveCountRevisions(
            List<HotColdModels.OrderedEntry<MotherRollInfo>> hotRolls,
            List<HotColdModels.OrderedEntry<RemnantStock>> hotRemnants
    ) {
        Map<String, Long> result = new HashMap<>();
        queryMaxCountRevisions("roll", hotRolls.stream().map(HotColdModels.OrderedEntry::id).toList(), result);
        queryMaxCountRevisions("remnant", hotRemnants.stream().map(HotColdModels.OrderedEntry::id).toList(), result);
        return result;
    }

    private void queryMaxCountRevisions(String type, List<String> ids, Map<String, Long> out) {
        for (int i = 0; i < ids.size(); i += 100) {
            List<String> chunk = ids.subList(i, Math.min(ids.size(), i + 100));
            String placeholders = String.join(",", Collections.nCopies(chunk.size(), "?"));
            List<Object> args = new ArrayList<>(chunk.size() + 1);
            args.add(type);
            args.addAll(chunk);
            jdbc.query(
                    "SELECT material_id, MAX(inventory_revision) FROM inventory_count_material_link WHERE material_type = ? AND material_id IN ("
                            + placeholders + ") GROUP BY material_id",
                    rs -> {
                        out.put(type + "/" + rs.getString(1), rs.getLong(2));
                    },
                    args.toArray()
            );
        }
    }

    void maintainCutReportLinks(String reportId, Map<String, Object> receipt) {
        jdbc.update("DELETE FROM cut_report_task_link WHERE report_id = ?", reportId);
        Set<String> taskIds = new LinkedHashSet<>();
        if (receipt.get("taskId") instanceof String s && !s.isBlank()) taskIds.add(s);
        if (receipt.get("taskDemandQuantities") instanceof Map<?, ?> multi) {
            for (Object k : multi.keySet()) {
                if (k != null && !k.toString().isBlank()) taskIds.add(k.toString());
            }
        }
        for (String tid : taskIds) {
            jdbc.update("INSERT INTO cut_report_task_link (report_id, task_id) VALUES (?, ?)", reportId, tid);
        }
    }

    void maintainTransferLinks(InventoryTransfer doc) {
        Set<String> seen = new LinkedHashSet<>();
        for (var line : doc.lines()) {
            if (seen.add(line.type() + "/" + line.id())) {
                jdbc.update("INSERT INTO inventory_transfer_material_link (transfer_id, material_type, material_id) VALUES (?, ?, ?)",
                        doc.id(), line.type(), line.id());
            }
        }
    }

    void maintainCountLinks(InventoryCount doc) {
        Set<String> seen = new LinkedHashSet<>();
        for (var line : doc.lines()) {
            if (seen.add(line.type() + "/" + line.id())) {
                jdbc.update("INSERT INTO inventory_count_material_link (count_id, material_type, material_id, inventory_revision) VALUES (?, ?, ?, ?)",
                        doc.id(), line.type(), line.id(), doc.inventoryRevision());
            }
        }
    }

    void maintainReceiptLinks(InventoryReceiptDocument doc) {
        Set<String> seen = new LinkedHashSet<>();
        for (var line : doc.lines()) {
            if (line.rollId() != null && seen.add(line.rollId())) {
                jdbc.update("INSERT INTO inventory_receipt_roll_link (receipt_id, roll_id) VALUES (?, ?)",
                        doc.id(), line.rollId());
            }
        }
    }

    // ==================== Ledger & Outbox 查询 ====================

    long countLedgerEntries() {
        Long count = jdbc.queryForObject("SELECT COALESCE(MAX(entry_sequence), 0) FROM inventory_ledger", Long.class);
        return count == null ? 0L : count;
    }

    Optional<String> findLatestAggregateAfterJson(String aggregateType, String aggregateId) {
        List<String> rows = jdbc.query(
                "SELECT entry_sequence, data_json FROM inventory_ledger WHERE aggregate_type = ? AND aggregate_id = ? ORDER BY entry_sequence DESC LIMIT 1",
                (rs, i) -> rs.getString(2),
                aggregateType, aggregateId
        );
        if (rows.isEmpty()) return Optional.empty();
        InventoryLedgerEntry entry = json.readValue(rows.get(0), InventoryLedgerEntry.class);
        return Optional.ofNullable(entry.afterJson());
    }

    List<String> findReversalLedgerIds(String aggregateType, String aggregateId, String businessId, boolean dispositionRevoke) {
        List<String> rows = jdbc.query(
                "SELECT entry_sequence, data_json FROM inventory_ledger WHERE aggregate_type = ? AND aggregate_id = ? ORDER BY entry_sequence ASC",
                (rs, i) -> rs.getString(2),
                aggregateType, aggregateId
        );
        List<String> ids = new ArrayList<>();
        for (String raw : rows) {
            InventoryLedgerEntry e = json.readValue(raw, InventoryLedgerEntry.class);
            if (dispositionRevoke) {
                if ("QUALITY_DISPOSITION".equals(e.eventType())
                        && (e.sourceReportIds().contains(businessId) || Objects.equals(e.businessId(), businessId))) {
                    ids.add(e.id());
                }
            } else if (e.sourceReportIds().contains(businessId) || "MIGRATION_OPENING".equals(e.eventType())) {
                ids.add(e.id());
            }
        }
        return ids;
    }

    Map<String, Object> queryLedgerPage(String aggregateType, String aggregateId, long after, int limit) {
        return readOnlyTransaction.execute(status -> {
            StringBuilder sql = new StringBuilder("SELECT entry_sequence, data_json FROM inventory_ledger WHERE entry_sequence > ?");
            List<Object> args = new ArrayList<>();
            args.add(after);
            if (aggregateType != null && !aggregateType.isBlank()) {
                sql.append(" AND aggregate_type = ?");
                args.add(aggregateType);
            }
            if (aggregateId != null && !aggregateId.isBlank()) {
                sql.append(" AND aggregate_id = ?");
                args.add(aggregateId);
            }
            sql.append(" ORDER BY entry_sequence ASC LIMIT ?");
            args.add(limit + 1);
            List<InventoryLedgerEntry> fetched = jdbc.query(sql.toString(),
                    (rs, i) -> json.readValue(rs.getString(2), InventoryLedgerEntry.class), args.toArray());
            boolean hasMore = fetched.size() > limit;
            List<InventoryLedgerEntry> items = hasMore ? fetched.subList(0, limit) : fetched;
            long nextCursor = items.isEmpty() ? after : items.get(items.size() - 1).sequence();
            Long rev = jdbc.queryForObject("SELECT revision FROM cutdemo_revision WHERE id = 1", Long.class);
            return Map.of("items", List.copyOf(items), "hasMore", hasMore, "nextCursor", nextCursor,
                    "revision", rev == null ? 0L : rev);
        });
    }

    void streamLedgerEntries(int batchSize, Consumer<List<InventoryLedgerEntry>> consumer) {
        streamBySequence("SELECT entry_sequence, data_json FROM inventory_ledger WHERE entry_sequence > ? ORDER BY entry_sequence ASC LIMIT ?",
                batchSize, raw -> json.readValue(raw, InventoryLedgerEntry.class), consumer);
    }

    long countOutboxEvents() {
        Long count = jdbc.queryForObject("SELECT COALESCE(MAX(event_sequence), 0) FROM inventory_outbox", Long.class);
        return count == null ? 0L : count;
    }

    Optional<String> findOutboxFirstEventId() {
        List<String> rows = jdbc.query("SELECT id FROM inventory_outbox WHERE event_sequence = 1", (rs, i) -> rs.getString(1));
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    Optional<InventoryEvent> findOutboxBySequence(long sequence) {
        List<InventoryEvent> rows = jdbc.query("SELECT data_json FROM inventory_outbox WHERE event_sequence = ?",
                (rs, i) -> json.readValue(rs.getString(1), InventoryEvent.class), sequence);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    List<InventoryEvent> queryOutboxPage(long after, int limit) {
        return jdbc.query("SELECT data_json FROM inventory_outbox WHERE event_sequence > ? ORDER BY event_sequence ASC LIMIT ?",
                (rs, i) -> json.readValue(rs.getString(1), InventoryEvent.class), after, limit);
    }

    // ==================== 5 类只增单据分页 / 幂等 / 存在性 / 流式 ====================

    <T> List<T> listDocumentPage(String table, Class<T> type, int limit, int offset) {
        return jdbc.query("SELECT data_json FROM " + table + " ORDER BY inventory_revision DESC, id ASC LIMIT ? OFFSET ?",
                (rs, i) -> json.readValue(rs.getString(1), type), limit, offset);
    }

    <T> Optional<T> findByIdempotencyKey(String table, Class<T> type, String key) {
        List<T> rows = jdbc.query("SELECT data_json FROM " + table + " WHERE idempotency_key = ? LIMIT 1",
                (rs, i) -> json.readValue(rs.getString(1), type), key);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    boolean hasTransferForMaterial(String type, String id) {
        Integer cnt = jdbc.queryForObject(
                "SELECT COUNT(*) FROM inventory_transfer_material_link WHERE material_type = ? AND material_id = ?",
                Integer.class, type, id);
        if (cnt != null && cnt > 0) return true;
        List<InventoryTransfer> rows = jdbc.query(
                "SELECT data_json FROM inventory_transfer WHERE data_json LIKE ? ESCAPE '!' LIMIT 20",
                (rs, i) -> json.readValue(rs.getString(1), InventoryTransfer.class), escapeLikePattern(id));
        return rows.stream().flatMap(t -> t.lines().stream())
                .anyMatch(l -> type.equals(l.type()) && id.equals(l.id()));
    }

    long findMaxCountRevision(String type, String id) {
        Long maxRev = jdbc.queryForObject(
                "SELECT COALESCE(MAX(inventory_revision), 0) FROM inventory_count_material_link WHERE material_type = ? AND material_id = ?",
                Long.class, type, id);
        if (maxRev != null && maxRev > 0) return maxRev;
        List<InventoryCount> rows = jdbc.query(
                "SELECT data_json FROM inventory_count WHERE data_json LIKE ? ESCAPE '!' ORDER BY inventory_revision DESC LIMIT 20",
                (rs, i) -> json.readValue(rs.getString(1), InventoryCount.class), escapeLikePattern(id));
        return rows.stream().filter(c -> c.lines().stream().anyMatch(l -> type.equals(l.type()) && id.equals(l.id())))
                .mapToLong(InventoryCount::inventoryRevision).max().orElse(0L);
    }

    boolean hasQualityReleaseForRemnant(String remnantId) {
        Integer cnt = jdbc.queryForObject("SELECT COUNT(*) FROM quality_release_document WHERE remnant_id = ?", Integer.class, remnantId);
        return cnt != null && cnt > 0;
    }

    boolean hasInventoryReceiptForRoll(String rollId) {
        Integer cnt = jdbc.queryForObject("SELECT COUNT(*) FROM inventory_receipt_roll_link WHERE roll_id = ?", Integer.class, rollId);
        if (cnt != null && cnt > 0) return true;
        List<InventoryReceiptDocument> rows = jdbc.query(
                "SELECT data_json FROM inventory_receipt_document WHERE data_json LIKE ? ESCAPE '!' LIMIT 20",
                (rs, i) -> json.readValue(rs.getString(1), InventoryReceiptDocument.class), escapeLikePattern(rollId));
        return rows.stream().flatMap(r -> r.lines().stream()).anyMatch(l -> rollId.equals(l.rollId()));
    }

    boolean hasMaterialIssueForRoll(String rollId) {
        Integer cnt = jdbc.queryForObject("SELECT COUNT(*) FROM material_issue_document WHERE roll_id = ?", Integer.class, rollId);
        return cnt != null && cnt > 0;
    }

    <T> void streamOrderedTable(String table, String orderColumn, Class<T> type, int batchSize, Consumer<List<T>> consumer) {
        int offset = 0;
        while (true) {
            List<T> page = jdbc.query("SELECT data_json FROM " + table + " ORDER BY " + orderColumn + ", id ASC LIMIT ? OFFSET ?",
                    (rs, i) -> json.readValue(rs.getString(1), type), batchSize, offset);
            if (page.isEmpty()) break;
            consumer.accept(page);
            if (page.size() < batchSize) break;
            offset += batchSize;
        }
    }

    // ==================== cut_report 与 4 张混合表 + 冷库存点查 ====================

    Optional<HotColdModels.OrderedEntry<Map<String, Object>>> findCutReport(String planId) {
        List<HotColdModels.OrderedEntry<Map<String, Object>>> rows = jdbc.query(
                "SELECT id, sort_order, data_json FROM cut_report WHERE id = ?",
                (rs, i) -> new HotColdModels.OrderedEntry<>(rs.getString(1), rs.getLong(2), json.readValue(rs.getString(3), MAP_TYPE)),
                planId
        );
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    List<Map<String, Object>> findCutReportsByRollId(String rollId) {
        return jdbc.query("SELECT data_json FROM cut_report WHERE roll_id = ? ORDER BY sort_order ASC",
                (rs, i) -> json.readValue(rs.getString(1), MAP_TYPE), rollId);
    }

    List<Map<String, Object>> findCutReportsByTaskId(String taskId) {
        return jdbc.query(
                "SELECT data_json FROM cut_report WHERE task_id = ? OR id IN (SELECT report_id FROM cut_report_task_link WHERE task_id = ?) ORDER BY sort_order ASC",
                (rs, i) -> json.readValue(rs.getString(1), MAP_TYPE), taskId, taskId);
    }

    HotColdModels.PagedSlice<Map<String, Object>> queryCutReportsPage(int limit, int offset, String statusFilter, String taskIdFilter) {
        return readOnlyTransaction.execute(status -> {
            StringBuilder where = new StringBuilder(" WHERE 1=1");
            List<Object> args = new ArrayList<>();
            if (statusFilter != null && !statusFilter.isBlank() && !"ALL".equalsIgnoreCase(statusFilter)) {
                where.append(" AND status = ?");
                args.add(statusFilter.trim().toUpperCase());
            }
            if (taskIdFilter != null && !taskIdFilter.isBlank()) {
                where.append(" AND (task_id = ? OR id IN (SELECT report_id FROM cut_report_task_link WHERE task_id = ?))");
                args.add(taskIdFilter.trim());
                args.add(taskIdFilter.trim());
            }
            Long totalObj = jdbc.queryForObject("SELECT COUNT(*) FROM cut_report" + where, Long.class, args.toArray());
            long total = totalObj == null ? 0L : totalObj;
            List<Object> pageArgs = new ArrayList<>(args);
            pageArgs.add(limit);
            pageArgs.add(offset);
            List<Map<String, Object>> items = jdbc.query(
                    "SELECT data_json FROM cut_report" + where + " ORDER BY sort_order DESC LIMIT ? OFFSET ?",
                    (rs, i) -> json.readValue(rs.getString(1), MAP_TYPE),
                    pageArgs.toArray()
            );
            return new HotColdModels.PagedSlice<>(items, total, limit, offset, offset + items.size() < total);
        });
    }

    void streamCutReports(boolean activeOnly, int batchSize, Consumer<List<Map<String, Object>>> consumer) {
        long lastSort = -1L;
        while (true) {
            String sql = activeOnly
                    ? "SELECT sort_order, data_json FROM cut_report WHERE status <> 'REVERSED' AND sort_order > ? ORDER BY sort_order ASC LIMIT ?"
                    : "SELECT sort_order, data_json FROM cut_report WHERE sort_order > ? ORDER BY sort_order ASC LIMIT ?";
            List<Map.Entry<Long, Map<String, Object>>> batch = jdbc.query(sql,
                    (rs, i) -> Map.entry(rs.getLong(1), json.readValue(rs.getString(2), MAP_TYPE)),
                    lastSort, batchSize);
            if (batch.isEmpty()) break;
            consumer.accept(batch.stream().map(Map.Entry::getValue).toList());
            lastSort = batch.get(batch.size() - 1).getKey();
            if (batch.size() < batchSize) break;
        }
    }

    Optional<Map<String, Object>> findLatestActiveCutReportForRoll(String rollId) {
        List<Map<String, Object>> rows = jdbc.query(
                "SELECT data_json FROM cut_report WHERE roll_id = ? AND status <> 'REVERSED' ORDER BY sort_order DESC LIMIT 1",
                (rs, i) -> json.readValue(rs.getString(1), MAP_TYPE), rollId);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    boolean hasAnyCutReportForRoll(String rollId) {
        Integer cnt = jdbc.queryForObject("SELECT COUNT(*) FROM cut_report WHERE roll_id = ?", Integer.class, rollId);
        return cnt != null && cnt > 0;
    }

    Optional<Map<String, Object>> findCutReportByDispositionRevokeKey(String idempotencyKey) {
        for (Map<String, Object> receipt : findCutReportsLike(idempotencyKey)) {
            if (receipt.get("qualityDispositions") instanceof List<?> list) {
                for (Object raw : list) {
                    var ev = json.convertValue(raw, QualityDisposition.class);
                    if (ev.hasRevocation() && idempotencyKey.equals(ev.revocation().idempotencyKey())) {
                        return Optional.of(receipt);
                    }
                }
            }
        }
        return Optional.empty();
    }

    <T> Optional<HotColdModels.OrderedEntry<T>> findOrderedById(String table, String id, Class<T> type) {
        List<HotColdModels.OrderedEntry<T>> rows = jdbc.query(
                "SELECT id, sort_order, data_json FROM " + table + " WHERE id = ?",
                (rs, i) -> new HotColdModels.OrderedEntry<>(rs.getString(1), rs.getLong(2), json.readValue(rs.getString(3), type)),
                id
        );
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    <T> List<T> listAllOrdered(String table, Class<T> type) {
        return jdbc.query("SELECT data_json FROM " + table + " ORDER BY sort_order ASC",
                (rs, i) -> json.readValue(rs.getString(1), type));
    }

    <T> List<T> findByColumn(String table, String column, String value, Class<T> type) {
        return jdbc.query("SELECT data_json FROM " + table + " WHERE " + column + " = ? ORDER BY sort_order ASC",
                (rs, i) -> json.readValue(rs.getString(1), type), value);
    }

    <T> Optional<HotColdModels.OrderedEntry<T>> findFirstMatching(
            String table, String needle, Class<T> type, java.util.function.Predicate<T> predicate
    ) {
        if (needle == null || needle.isBlank()) return Optional.empty();
        return jdbc.query(
                "SELECT id, sort_order, data_json FROM " + table + " WHERE data_json LIKE ? ESCAPE '!' ORDER BY sort_order ASC",
                (org.springframework.jdbc.core.ResultSetExtractor<Optional<HotColdModels.OrderedEntry<T>>>) rs -> {
                    while (rs.next()) {
                        T val = json.readValue(rs.getString(3), type);
                        if (predicate.test(val)) {
                            return Optional.of(new HotColdModels.OrderedEntry<>(rs.getString(1), rs.getLong(2), val));
                        }
                    }
                    return Optional.empty();
                },
                escapeLikePattern(needle)
        );
    }

    <T> void streamBySortOrder(String table, Class<T> type, int batchSize, Consumer<List<T>> consumer) {
        int offset = 0;
        while (true) {
            List<T> batch = jdbc.query("SELECT data_json FROM " + table + " ORDER BY sort_order ASC, id ASC LIMIT ? OFFSET ?",
                    (rs, i) -> json.readValue(rs.getString(1), type), batchSize, offset);
            if (batch.isEmpty()) break;
            consumer.accept(batch);
            if (batch.size() < batchSize) break;
            offset += batchSize;
        }
    }

    List<Map<String, Object>> findCutReportsLike(String needle) {
        if (needle == null || needle.isBlank()) return List.of();
        return jdbc.query(
                "SELECT data_json FROM cut_report WHERE data_json LIKE ? ESCAPE '!' ORDER BY sort_order DESC",
                (rs, i) -> json.readValue(rs.getString(1), MAP_TYPE),
                escapeLikePattern(needle)
        );
    }

    List<SchedulingScheme> findSchemesForPlanIds(Set<String> planIds, Set<String> taskIds) {
        if (planIds == null || planIds.isEmpty()) return List.of();
        return readOnlyTransaction.execute(status -> {
            Map<String, SchedulingScheme> byId = new LinkedHashMap<>();
            Set<String> remaining = new LinkedHashSet<>(planIds);
            if (taskIds != null && !taskIds.isEmpty()) {
                List<String> taskList = new ArrayList<>(taskIds);
                for (int i = 0; i < taskList.size(); i += 100) {
                    List<String> chunk = taskList.subList(i, Math.min(taskList.size(), i + 100));
                    String placeholders = String.join(",", Collections.nCopies(chunk.size(), "?"));
                    List<SchedulingScheme> found = jdbc.query(
                            "SELECT data_json FROM scheduling_scheme WHERE task_id IN (" + placeholders + ") ORDER BY sort_order ASC",
                            (rs, idx) -> json.readValue(rs.getString(1), SchedulingScheme.class),
                            chunk.toArray()
                    );
                    for (SchedulingScheme sc : found) {
                        byId.put(sc.id(), sc);
                        remaining.removeAll(sc.linkedPlanIds());
                    }
                }
            }
            for (String pid : new ArrayList<>(remaining)) {
                if (!remaining.contains(pid)) continue;
                SchedulingScheme matched = jdbc.query(
                        "SELECT data_json FROM scheduling_scheme WHERE data_json LIKE ? ESCAPE '!' ORDER BY sort_order ASC",
                        (org.springframework.jdbc.core.ResultSetExtractor<SchedulingScheme>) rs -> {
                            while (rs.next()) {
                                SchedulingScheme sc = json.readValue(rs.getString(1), SchedulingScheme.class);
                                if (sc.linkedPlanIds().contains(pid)) return sc;
                            }
                            return null;
                        },
                        escapeLikeJsonQuoted(pid)
                );
                if (matched != null) {
                    byId.put(matched.id(), matched);
                    remaining.removeAll(matched.linkedPlanIds());
                }
            }
            return List.copyOf(byId.values());
        });
    }

    List<SchedulingScheme> findActiveSchemesByPlanId(String planId) {
        if (planId == null || planId.isBlank()) return List.of();
        List<SchedulingScheme> rows = jdbc.query(
                "SELECT data_json FROM scheduling_scheme WHERE state NOT IN ('CANCELLED','REVERSED') AND data_json LIKE ? ESCAPE '!' ORDER BY sort_order ASC",
                (rs, i) -> json.readValue(rs.getString(1), SchedulingScheme.class),
                escapeLikeJsonQuoted(planId)
        );
        return rows.stream().filter(sc -> sc.linkedPlanIds().contains(planId)).toList();
    }

    List<SchedulingScheme> findSchemesByRollId(String rollId) {
        if (rollId == null || rollId.isBlank()) return List.of();
        return jdbc.query(
                "SELECT data_json FROM scheduling_scheme WHERE roll_id = ? ORDER BY sort_order ASC",
                (rs, i) -> json.readValue(rs.getString(1), SchedulingScheme.class),
                rollId
        );
    }

    List<SchedulingScheme> querySchemes(String stateFilter, String taskIdFilter) {
        StringBuilder sql = new StringBuilder("SELECT data_json FROM scheduling_scheme WHERE 1=1");
        List<Object> args = new ArrayList<>();
        if (stateFilter != null && !stateFilter.isBlank() && !"ALL".equalsIgnoreCase(stateFilter)) {
            sql.append(" AND state = ?");
            args.add(stateFilter.trim().toUpperCase(java.util.Locale.ROOT));
        }
        String cleanTaskId = (taskIdFilter == null || taskIdFilter.isBlank()) ? null : taskIdFilter.trim();
        if (cleanTaskId != null) {
            sql.append(" AND (task_id = ? OR data_json LIKE ? ESCAPE '!')");
            args.add(cleanTaskId);
            args.add(escapeLikeJsonQuoted(cleanTaskId));
        }
        sql.append(" ORDER BY sort_order ASC");
        List<SchedulingScheme> rows = jdbc.query(sql.toString(),
                (rs, i) -> json.readValue(rs.getString(1), SchedulingScheme.class),
                args.toArray());
        if (cleanTaskId != null) {
            return rows.stream().filter(s -> s.involvesTask(cleanTaskId)).toList();
        }
        return rows;
    }

    long countActiveSchemesForTask(String taskId) {
        if (taskId == null || taskId.isBlank()) return 0L;
        String clean = taskId.trim();
        Long cnt = jdbc.queryForObject(
                "SELECT COUNT(*) FROM scheduling_scheme WHERE state NOT IN ('CANCELLED','REVERSED') AND (task_id = ? OR data_json LIKE ? ESCAPE '!')",
                Long.class,
                clean,
                escapeLikeJsonQuoted(clean)
        );
        return cnt == null ? 0L : cnt;
    }

    List<MotherRollInfo> listMotherRollsPage(int limit, int offset) {
        return jdbc.query(
                "SELECT data_json FROM mother_roll ORDER BY sort_order ASC LIMIT ? OFFSET ?",
                (rs, i) -> json.readValue(rs.getString(1), MotherRollInfo.class),
                limit, offset
        );
    }

    static String escapeLikePattern(String needle) {
        if (needle == null || needle.isEmpty()) return "%%";
        return "%" + escapeLikeBody(needle) + "%";
    }

    private static String escapeLikeJsonQuoted(String literal) {
        return "%\"" + escapeLikeBody(literal) + "\"%";
    }

    private static String escapeLikeBody(String value) {
        StringBuilder sb = new StringBuilder(value.length() + 8);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '!' || c == '%' || c == '_') {
                sb.append('!');
            }
            sb.append(c);
        }
        return sb.toString();
    }

    private <T> List<HotColdModels.OrderedEntry<T>> orderedRows(String sql, Class<T> type) {
        return jdbc.query(sql, (rs, i) ->
                new HotColdModels.OrderedEntry<>(rs.getString(1), rs.getLong(2), json.readValue(rs.getString(3), type)));
    }

    private <T> List<HotColdModels.OrderedEntry<T>> loadOrderedByIds(String table, Set<String> ids, Class<T> type) {
        List<HotColdModels.OrderedEntry<T>> out = new ArrayList<>();
        List<String> list = new ArrayList<>(ids);
        for (int i = 0; i < list.size(); i += 100) {
            List<String> chunk = list.subList(i, Math.min(list.size(), i + 100));
            String placeholders = String.join(",", Collections.nCopies(chunk.size(), "?"));
            out.addAll(jdbc.query(
                    "SELECT id, sort_order, data_json FROM " + table + " WHERE id IN (" + placeholders + ") ORDER BY sort_order",
                    (rs, idx) -> new HotColdModels.OrderedEntry<>(rs.getString(1), rs.getLong(2), json.readValue(rs.getString(3), type)),
                    chunk.toArray()
            ));
        }
        return out;
    }

    private long nextSortOrder(String table) {
        Long val = jdbc.queryForObject("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM " + table, Long.class);
        return val == null ? 0L : val;
    }

    private <T> void streamBySequence(String sql, int batchSize, java.util.function.Function<String, T> mapper, Consumer<List<T>> consumer) {
        long cursor = 0L;
        while (true) {
            List<Map.Entry<Long, T>> batch = jdbc.query(sql,
                    (rs, i) -> Map.entry(rs.getLong(1), mapper.apply(rs.getString(2))),
                    cursor, batchSize);
            if (batch.isEmpty()) break;
            consumer.accept(batch.stream().map(Map.Entry::getValue).toList());
            cursor = batch.get(batch.size() - 1).getKey();
            if (batch.size() < batchSize) break;
        }
    }
}
