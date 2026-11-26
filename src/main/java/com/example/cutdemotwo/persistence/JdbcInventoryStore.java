package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.ExecutionOrder;
import com.example.cutdemotwo.business.model.InventoryTransfer;
import com.example.cutdemotwo.business.model.InventoryEvent;
import com.example.cutdemotwo.business.model.InventoryCount;
import com.example.cutdemotwo.business.model.InventoryLedgerEntry;
import com.example.cutdemotwo.business.model.InventoryReceiptDocument;
import com.example.cutdemotwo.business.model.MaterialIssueDocument;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.DemandTemplate;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.QualityReleaseDocument;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import javax.sql.DataSource;
import java.util.*;
import java.util.function.Function;

/** A revision CAS and all changed aggregate rows commit in the same database transaction. */
public class JdbcInventoryStore implements InventoryStore {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final TransactionTemplate readOnlyTransaction;
    private final boolean mysql;
    private final ObjectMapper json = new ObjectMapper();
    public JdbcInventoryStore(DataSource dataSource) {
        jdbc = new JdbcTemplate(dataSource);
        mysql = "MySQL".equals(jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<String>)
                connection -> connection.getMetaData().getDatabaseProductName()));
        var txManager = new DataSourceTransactionManager(dataSource);
        transaction = new TransactionTemplate(txManager);
        readOnlyTransaction = new TransactionTemplate(txManager);
        readOnlyTransaction.setReadOnly(true);
    }
    @Override public long now() {
        if (mysql) return Objects.requireNonNull(jdbc.queryForObject("SELECT UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000", Long.class));
        return Objects.requireNonNull(jdbc.queryForObject("SELECT CURRENT_TIMESTAMP(3)", java.sql.Timestamp.class)).getTime();
    }
    @Override public boolean shared() { return true; }

    /** 轻量无锁查询当前版本号，避免只读请求与健康检查触发 FOR UPDATE 行锁。 */
    @Override public Long currentRevision() {
        List<Long> rows = jdbc.query("SELECT revision FROM cutdemo_revision WHERE id = 1", (rs, idx) -> rs.getLong(1));
        return rows.isEmpty() ? 0L : rows.get(0);
    }

    /** 轻量无锁数据库连通性与版本行探针。 */
    @Override public String healthCheckError() {
        try {
            jdbc.queryForObject("SELECT 1", Integer.class);
            return null;
        } catch (Exception e) {
            return "数据库连接不可用: " + e.getMessage();
        }
    }

    /** 需求模板与库存账本正交，独立直写 demand_template 表，不竞争 cutdemo_revision 行锁。 */
    @Override public boolean supportsIndependentTemplates() { return true; }

    @Override public List<DemandTemplate> loadTemplates() {
        return readOnlyTransaction.execute(status -> rows("demand_template", DemandTemplate.class));
    }

    @Override public void upsertTemplate(DemandTemplate template) {
        Objects.requireNonNull(template, "需求模板不能为空");
        String serialized = json.writeValueAsString(template);
        transaction.executeWithoutResult(status -> {
            int updated = jdbc.update(
                    "UPDATE demand_template SET dimension = ?, material_model = ?, data_json = ? WHERE id = ?",
                    template.dimension(), template.materialModel(), serialized, template.id());
            if (updated == 0) {
                Long nextOrder = jdbc.queryForObject(
                        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM demand_template", Long.class);
                try {
                    jdbc.update(
                            "INSERT INTO demand_template (sort_order, dimension, material_model, data_json, id) VALUES (?, ?, ?, ?, ?)",
                            nextOrder == null ? 0L : nextOrder, template.dimension(), template.materialModel(), serialized, template.id());
                } catch (org.springframework.dao.DuplicateKeyException dup) {
                    jdbc.update(
                            "UPDATE demand_template SET dimension = ?, material_model = ?, data_json = ? WHERE id = ?",
                            template.dimension(), template.materialModel(), serialized, template.id());
                }
            }
        });
    }

    @Override public boolean deleteTemplate(String id) {
        if (id == null || id.isBlank()) return false;
        Integer deleted = transaction.execute(status ->
                jdbc.update("DELETE FROM demand_template WHERE id = ?", id.trim()));
        return deleted != null && deleted > 0;
    }

    @Override public InventorySnapshot load() {
        return readOnlyTransaction.execute(status -> {
            Map<String, Object> meta = jdbc.queryForMap("SELECT revision, remnant_seq, defect_seq FROM cutdemo_revision WHERE id = 1");
            long revision = ((Number)meta.get("revision")).longValue();
            if (revision == 0) return null;
            List<MotherRollInfo> rolls = rows("mother_roll", MotherRollInfo.class);
            List<RemnantStock> remnants = rows("remnant_stock", RemnantStock.class);
            Map<String, CuttingTask> tasks = new LinkedHashMap<>();
            rows("cutting_task", CuttingTask.class).forEach(t -> tasks.put(t.id(), t));
            Map<String, CuttingPlan> plans = new LinkedHashMap<>();
            rows("cutting_plan", CuttingPlan.class).forEach(p -> plans.put(p.id(), p));
            Map<String, Map<String, Object>> receipts = new LinkedHashMap<>();
            jdbc.query("SELECT id, data_json FROM cut_report ORDER BY sort_order", rs -> {
                receipts.put(rs.getString("id"), json.readValue(rs.getString("data_json"), new TypeReference<Map<String, Object>>() {}));
            });
            Map<String,ExecutionOrder> executions=new LinkedHashMap<>();
            rows("execution_order",ExecutionOrder.class).forEach(e->executions.put(e.id(),e));
            Map<String,DemandTemplate> templates=new LinkedHashMap<>();
            rows("demand_template",DemandTemplate.class).forEach(t->templates.put(t.id(),t));
            Map<String,SchedulingScheme> schemes=new LinkedHashMap<>();
            rows("scheduling_scheme",SchedulingScheme.class).forEach(s->schemes.put(s.id(),s));
            return new InventorySnapshot(rolls, remnants, receipts, ((Number)meta.get("remnant_seq")).intValue(),
                    ((Number)meta.get("defect_seq")).intValue(), tasks, plans, revision, executions, ledger(), transfers(),
                    outbox(), counts(), templates, schemes, qualityReleases(), inventoryReceipts(), materialIssues());
        });
    }
    private Map<String,QualityReleaseDocument> qualityReleases() {
        var result=new LinkedHashMap<String,QualityReleaseDocument>();
        jdbc.query("SELECT id,data_json FROM quality_release_document ORDER BY inventory_revision,id", rs -> {
            result.put(rs.getString(1),json.readValue(rs.getString(2),QualityReleaseDocument.class));
        });
        return result;
    }
    private Map<String,InventoryReceiptDocument> inventoryReceipts() {
        var result=new LinkedHashMap<String,InventoryReceiptDocument>();
        jdbc.query("SELECT id,data_json FROM inventory_receipt_document ORDER BY inventory_revision,id", rs -> {
            result.put(rs.getString(1),json.readValue(rs.getString(2),InventoryReceiptDocument.class));
        });
        return result;
    }
    private Map<String,MaterialIssueDocument> materialIssues() {
        var result=new LinkedHashMap<String,MaterialIssueDocument>();
        jdbc.query("SELECT id,data_json FROM material_issue_document ORDER BY inventory_revision,id", rs -> {
            result.put(rs.getString(1),json.readValue(rs.getString(2),MaterialIssueDocument.class));
        });
        return result;
    }
    private Map<String,InventoryCount> counts() {
        var result=new LinkedHashMap<String,InventoryCount>();
        jdbc.query("SELECT id,data_json FROM inventory_count ORDER BY inventory_revision,id", rs -> {
            result.put(rs.getString(1),json.readValue(rs.getString(2),InventoryCount.class));
        });
        return result;
    }
    private List<InventoryEvent> outbox() {
        return jdbc.query("SELECT data_json FROM inventory_outbox ORDER BY event_sequence",
                (rs,index)->json.readValue(rs.getString(1),InventoryEvent.class));
    }
    private Map<String,InventoryTransfer> transfers() {
        var result=new LinkedHashMap<String,InventoryTransfer>();
        jdbc.query("SELECT id,data_json FROM inventory_transfer ORDER BY inventory_revision,id", rs -> {
            result.put(rs.getString(1),json.readValue(rs.getString(2),InventoryTransfer.class));
        });
        return result;
    }
    private List<InventoryLedgerEntry> ledger() {
        return jdbc.query("SELECT data_json FROM inventory_ledger ORDER BY entry_sequence",
                (rs,index) -> json.readValue(rs.getString(1),InventoryLedgerEntry.class));
    }
    private <T> List<T> rows(String table, Class<T> type) {
        return jdbc.query("SELECT data_json FROM " + table + " ORDER BY sort_order", (rs, index) -> json.readValue(rs.getString(1), type));
    }
    @Override public long save(InventorySnapshot snapshot) {
        return Objects.requireNonNull(transaction.execute(status -> {
            int changed = jdbc.update("UPDATE cutdemo_revision SET revision = revision + 1, remnant_seq = ?, defect_seq = ? WHERE id = 1 AND revision = ?",
                    snapshot.remnantSeq(), snapshot.defectSeq(), snapshot.revision());
            if (changed != 1) throw new InventoryConflictException();
            sync("mother_roll", List.of("material_model", "remaining_mm", "used_mm"), snapshot.rolls(), MotherRollInfo::getRollId,
                    r -> Arrays.asList(r.getRollModel(), r.getCurrentRemainingLength(), r.getUsedLength()));
            sync("remnant_stock", List.of("source_roll_id", "parent_remnant_id", "status", "width_mm", "length_mm"), snapshot.remnants(), RemnantStock::getId,
                    r -> Arrays.asList(r.getSourceRollId(), r.getParentRemnantId(), r.getStatus(), r.getWidth(), r.getLength()));
            sync("cutting_task", List.of("revision", "material_model"), values(snapshot.tasks()), CuttingTask::id,
                    t -> Arrays.asList(t.revision(), t.materialModel()));
            sync("cutting_plan", List.of("task_id", "status"), values(snapshot.plans()), CuttingPlan::id,
                    p -> Arrays.asList(p.request().getTaskId(), p.status()));
            sync("cut_report", List.of("task_id", "roll_id", "source_remnant_id", "status"), values(snapshot.receipts()), r -> r.get("planId").toString(),
                    r -> Arrays.asList(r.get("taskId"), r.get("rollId"), r.get("sourceRemnantId"), r.getOrDefault("status", "CONFIRMED")));
            sync("execution_order", List.of("idempotency_key","plan_id","task_id","material_type","material_id","state","version","expires_at"),
                    values(snapshot.executions()),ExecutionOrder::id,
                    e->Arrays.asList(e.idempotencyKey(),e.planId(),e.taskId(),e.materialType(),e.materialId(),e.state(),e.version(),e.expiresAt()));
            // 仅在冷库/全量导入（revision == 0）时携带模板落库；常规库存提交不覆盖独立管理的 demand_template 表
            if (snapshot.revision() == 0 && snapshot.templates() != null && !snapshot.templates().isEmpty()) {
                sync("demand_template", List.of("dimension","material_model"),
                        values(snapshot.templates()),DemandTemplate::id,
                        t->Arrays.asList(t.dimension(),t.materialModel()));
            }
            sync("scheduling_scheme", List.of("task_id","roll_id","state","dimension"),
                    values(snapshot.schemes()),SchedulingScheme::id,
                    s->Arrays.asList(s.taskId(),s.rollId(),s.state(),s.dimension()));
            var posted=transfers();
            InventoryTransfer.requireAppendOnly(posted,snapshot.transfers());
            for(var document:snapshot.transfers().values())if(!posted.containsKey(document.id()))
                jdbc.update("INSERT INTO inventory_transfer (id,idempotency_key,posted_at,inventory_revision,data_json) VALUES (?,?,?,?,?)",
                        document.id(),document.idempotencyKey(),document.postedAt(),document.inventoryRevision(),json.writeValueAsString(document));
            var counted=counts();
            InventoryCount.requireAppendOnly(counted,snapshot.counts());
            for(var document:snapshot.counts().values())if(!counted.containsKey(document.id()))
                jdbc.update("INSERT INTO inventory_count (id,idempotency_key,posted_at,inventory_revision,data_json) VALUES (?,?,?,?,?)",
                        document.id(),document.idempotencyKey(),document.postedAt(),document.inventoryRevision(),json.writeValueAsString(document));
            var released=qualityReleases();
            QualityReleaseDocument.requireAppendOnly(released,snapshot.qualityReleases());
            for(var document:snapshot.qualityReleases().values())if(!released.containsKey(document.id()))
                jdbc.update("INSERT INTO quality_release_document (id,idempotency_key,remnant_id,decision,posted_at,inventory_revision,data_json) VALUES (?,?,?,?,?,?,?)",
                        document.id(),document.idempotencyKey(),document.remnantId(),document.decision(),document.postedAt(),document.inventoryRevision(),json.writeValueAsString(document));
            var invReceipts=inventoryReceipts();
            InventoryReceiptDocument.requireAppendOnly(invReceipts,snapshot.inventoryReceipts());
            for(var document:snapshot.inventoryReceipts().values())if(!invReceipts.containsKey(document.id()))
                jdbc.update("INSERT INTO inventory_receipt_document (id,idempotency_key,supplier_name,delivery_note_no,posted_at,inventory_revision,data_json) VALUES (?,?,?,?,?,?,?)",
                        document.id(),document.idempotencyKey(),document.supplierName(),document.deliveryNoteNo(),document.postedAt(),document.inventoryRevision(),json.writeValueAsString(document));
            var matIssues=materialIssues();
            MaterialIssueDocument.requireAppendOnly(matIssues,snapshot.materialIssues());
            for(var document:snapshot.materialIssues().values())if(!matIssues.containsKey(document.id()))
                jdbc.update("INSERT INTO material_issue_document (id,idempotency_key,direction,roll_id,machine_id,posted_at,inventory_revision,data_json) VALUES (?,?,?,?,?,?,?,?)",
                        document.id(),document.idempotencyKey(),document.direction(),document.rollId(),document.machineId(),document.postedAt(),document.inventoryRevision(),json.writeValueAsString(document));
            var previous = ledger();
            InventoryLedgerEntry.requireAppendOnly(previous,snapshot.ledger());
            for (var entry : snapshot.ledger().subList(previous.size(),snapshot.ledger().size())) {
                jdbc.update("INSERT INTO inventory_ledger (id,entry_sequence,transaction_id,event_type,aggregate_type,aggregate_id,occurred_at,data_json) VALUES (?,?,?,?,?,?,?,?)",
                        entry.id(),entry.sequence(),entry.transactionId(),entry.eventType(),entry.aggregateType(),entry.aggregateId(),
                        entry.occurredAt(),json.writeValueAsString(entry));
            }
            var events=outbox();
            InventoryEvent.requireAppendOnly(events,snapshot.outbox());
            for(var event:snapshot.outbox().subList(events.size(),snapshot.outbox().size()))
                jdbc.update("INSERT INTO inventory_outbox (id,event_sequence,inventory_revision,data_json) VALUES (?,?,?,?)",
                        event.id(),event.sequence(),event.inventoryRevision(),json.writeValueAsString(event));
            return snapshot.revision() + 1;
        }));
    }
    private static <T> Collection<T> values(Map<String, T> map) { return map == null ? List.of() : map.values(); }

    // Table/column names come only from the constants above; all business values are bound parameters.
    private <T> void sync(String table, List<String> columns, Collection<T> items, Function<T, String> key, Function<T, List<Object>> fields) {
        Map<String, String> existing = new HashMap<>();
        Map<String, Long> order = new HashMap<>();
        jdbc.query("SELECT id, sort_order, data_json FROM " + table, rs -> {
            existing.put(rs.getString(1), rs.getString(3)); order.put(rs.getString(1), rs.getLong(2));
        });
        List<String> allColumns = new ArrayList<>(List.of("sort_order")); allColumns.addAll(columns); allColumns.add("data_json");
        String update = "UPDATE " + table + " SET " + String.join(", ", allColumns.stream().map(c -> c + " = ?").toList()) + " WHERE id = ?";
        String insert = "INSERT INTO " + table + " (" + String.join(", ", allColumns) + ", id) VALUES (" + String.join(", ", Collections.nCopies(allColumns.size() + 1, "?")) + ")";
        long index = 0;
        for (T item : items) {
            String id = key.apply(item); String serialized = json.writeValueAsString(item);
            String previous = existing.remove(id);
            if (serialized.equals(previous) && Objects.equals(order.get(id), index)) { index++; continue; }
            List<Object> args = new ArrayList<>(); args.add(index++); args.addAll(fields.apply(item)); args.add(serialized); args.add(id);
            jdbc.update(previous == null ? insert : update, args.toArray());
        }
        for (String removed : existing.keySet()) jdbc.update("DELETE FROM " + table + " WHERE id = ?", removed);
    }
}
