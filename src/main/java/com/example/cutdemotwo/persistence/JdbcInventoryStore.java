package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.model.*;
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
    private final ObjectMapper json = new ObjectMapper();
    public JdbcInventoryStore(DataSource dataSource) {
        jdbc = new JdbcTemplate(dataSource);
        transaction = new TransactionTemplate(new DataSourceTransactionManager(dataSource));
    }
    @Override public boolean shared() { return true; }
    @Override public InventorySnapshot load() {
        return transaction.execute(status -> {
            Map<String, Object> meta = jdbc.queryForMap("SELECT revision, remnant_seq, defect_seq FROM cutdemo_revision WHERE id = 1 FOR UPDATE");
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
            return new InventorySnapshot(rolls, remnants, receipts, ((Number)meta.get("remnant_seq")).intValue(),
                    ((Number)meta.get("defect_seq")).intValue(), tasks, plans, revision);
        });
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
