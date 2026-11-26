package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.*;
import com.example.cutdemotwo.persistence.InventorySnapshot;
import tools.jackson.databind.*;
import tools.jackson.databind.node.ObjectNode;
import java.util.*;

/** Accounting projection and append generation only; no HTTP, solver or independent writes. */
public final class InventoryJournal {
    private static final ObjectMapper JSON = new ObjectMapper();
    private InventoryJournal() {}

    private record Balance(String type, String id, String value) {}
    private static String canonical(Object value) {
        return JSON.writeValueAsString(sorted(JSON.valueToTree(value)));
    }
    private static Object sorted(JsonNode value) {
        if (value.isObject()) {
            var map = new TreeMap<String,Object>();
            value.properties().forEach(e -> map.put(e.getKey(), sorted(e.getValue())));
            return map;
        }
        if (value.isArray()) {
            var list = new ArrayList<Object>(); value.forEach(v -> list.add(sorted(v))); return list;
        }
        return value;
    }
    private static void put(Map<String,Balance> result, String type, String id, Object value) {
        result.put(type + "/" + id, new Balance(type, id, canonical(value)));
    }
    private static Map<String,Balance> balances(InventorySnapshot snapshot) {
        var result = new TreeMap<String,Balance>();
        for (var roll : snapshot.rolls()) {
            ObjectNode value = JSON.valueToTree(roll);
            // Derived UI counters are not material facts and may be refreshed by read endpoints.
            value.remove("remnantCount"); value.remove("remnantTotalArea");
            put(result,"ROLL",roll.getRollId(),value);
        }
        for (var remnant : snapshot.remnants()) put(result,"REMNANT",remnant.getId(),remnant);
        if (snapshot.receipts() != null)
            snapshot.receipts().forEach((id,receipt) -> put(result,"REPORT",id,receipt));
        if (snapshot.tasks() != null) for (var task : snapshot.tasks().values()) {
            var completed = new HashMap<String,Integer>();
            if (snapshot.receipts() != null) for (var receipt : snapshot.receipts().values()) {
                if ("REVERSED".equals(receipt.get("status"))) continue;
                boolean multiTask = receipt.get("taskDemandQuantities") instanceof Map<?,?>;
                if (multiTask) {
                    Map<?,?> multi = (Map<?,?>) receipt.get("taskDemandQuantities");
                    if (!(multi.get(task.id()) instanceof Map<?,?> quantities)) continue;
                    quantities.forEach((id,n) -> completed.merge(id.toString(), ((Number)n).intValue(), Integer::sum));
                    Map<?,?> pieceSources = receipt.get("pieceSources") instanceof Map<?,?> ps ? ps : null;
                    if (pieceSources != null && receipt.get("qualityDispositions") instanceof List<?> events) for (var raw : events) {
                        var event = JSON.convertValue(raw,QualityDisposition.class);
                        if (event.hasRevocation() || !"QUALIFIED".equals(event.originalOutcome())) continue;
                        Object srcObj = pieceSources.get(String.valueOf(event.command().pieceId()));
                        if (srcObj == null) srcObj = pieceSources.get(event.command().pieceId());
                        if (srcObj instanceof Map<?,?> srcMap && Objects.equals(task.id(), srcMap.get("taskId"))
                                && srcMap.get("lineId") instanceof Number ln) {
                            completed.merge(String.valueOf(ln.intValue()), -1, Integer::sum);
                        }
                    }
                } else {
                    if (!task.id().equals(receipt.get("taskId"))) continue;
                    if (receipt.get("demandQuantities") instanceof Map<?,?> quantities)
                        quantities.forEach((id,n) -> completed.merge(id.toString(), ((Number)n).intValue(), Integer::sum));
                    if (receipt.get("qualityDispositions") instanceof List<?> events) for (var raw : events) {
                        var event = JSON.convertValue(raw,QualityDisposition.class);
                        if (event.hasRevocation()) continue;
                        if ("QUALIFIED".equals(event.originalOutcome()))
                            completed.merge(String.valueOf(event.demandId()),-1,Integer::sum);
                    }
                }
            }
            for (var line : task.demands()) put(result,"DEMAND",task.id()+"/"+line.id(),
                    Map.of("taskId",task.id(),"materialModel",task.materialModel(),"line",line,
                            "completed",completed.getOrDefault(String.valueOf(line.id()),0)));
        }
        snapshot.transfers().forEach((id,document)->put(result,"TRANSFER",id,document));
        snapshot.counts().forEach((id,document)->put(result,"COUNT",id,document));
        snapshot.qualityReleases().forEach((id,document)->put(result,"QUALITY_RELEASE",id,document));
        snapshot.inventoryReceipts().forEach((id,document)->put(result,"INVENTORY_RECEIPT",id,document));
        snapshot.materialIssues().forEach((id,document)->put(result,"MATERIAL_ISSUE",id,document));
        return result;
    }

    /**
     * 已校验通过的账本平衡索引：
     * 绑定当前已提交的 revision 与 ledger 长度；冷启动或跨节点刷新后强制重算并重放验证以拦截外部篡改，
     * 同一节点连续写入时仅对脏聚合计算增量差值，将单次记账复杂度由 O(N + L) 降至 O(k)。
     */
    static final class BalanceIndex {
        private final Map<String, Balance> balances;
        private long revision;
        private int ledgerSize;

        private BalanceIndex(Map<String, Balance> balances, long revision, int ledgerSize) {
            this.balances = balances;
            this.revision = revision;
            this.ledgerSize = ledgerSize;
        }

        boolean matches(long currentRevision, int currentLedgerSize) {
            return this.revision == currentRevision && this.ledgerSize == currentLedgerSize;
        }
    }

    /** 增量记账结果：包含更新后的不可变账本列表与待提交成功后才生效的增量平衡补丁。 */
    record AppendOutcome(
            List<InventoryLedgerEntry> ledger,
            BalanceIndex baseIndex,
            Map<String, Balance> balancePatches,
            long nextRevision
    ) {
        void commitIndex() {
            if (baseIndex == null) return;
            for (var entry : balancePatches.entrySet()) {
                if (entry.getValue() == null) baseIndex.balances.remove(entry.getKey());
                else baseIndex.balances.put(entry.getKey(), entry.getValue());
            }
            baseIndex.revision = nextRevision;
            baseIndex.ledgerSize = ledger.size();
        }
    }

    /** 本次写事务中可能影响账本的脏聚合键集合（不含 plans/executions/schemes/templates）。 */
    record DirtyLedgerKeys(
            Set<String> rollIds,
            Set<String> remnantIds,
            Set<String> receiptIds,
            Set<String> taskIds,
            Set<String> transferIds,
            Set<String> countIds,
            Set<String> qualityReleaseIds,
            Set<String> inventoryReceiptIds,
            Set<String> materialIssueIds,
            Set<String> affectedReceiptTaskIds
    ) {
        boolean isEmpty() {
            return rollIds.isEmpty() && remnantIds.isEmpty() && receiptIds.isEmpty() && taskIds.isEmpty()
                    && transferIds.isEmpty() && countIds.isEmpty() && qualityReleaseIds.isEmpty()
                    && inventoryReceiptIds.isEmpty() && materialIssueIds.isEmpty() && affectedReceiptTaskIds.isEmpty();
        }
    }

    private static Balance balanceForRoll(MotherRollInfo roll) {
        ObjectNode value = JSON.valueToTree(roll);
        // Derived UI counters are not material facts and may be refreshed by read endpoints.
        value.remove("remnantCount");
        value.remove("remnantTotalArea");
        return new Balance("ROLL", roll.getRollId(), canonical(value));
    }

    private static Map<String, Balance> balancesForTask(CuttingTask task, Map<String, Map<String, Object>> receipts) {
        var result = new TreeMap<String, Balance>();
        if (task == null) return result;
        var completed = new HashMap<String, Integer>();
        if (receipts != null) {
            for (var receipt : receipts.values()) {
                if ("REVERSED".equals(receipt.get("status"))) continue;
                boolean multiTask = receipt.get("taskDemandQuantities") instanceof Map<?, ?>;
                if (multiTask) {
                    Map<?, ?> multi = (Map<?, ?>) receipt.get("taskDemandQuantities");
                    if (!(multi.get(task.id()) instanceof Map<?, ?> quantities)) continue;
                    quantities.forEach((id, n) -> completed.merge(id.toString(), ((Number) n).intValue(), Integer::sum));
                    Map<?, ?> pieceSources = receipt.get("pieceSources") instanceof Map<?, ?> ps ? ps : null;
                    if (pieceSources != null && receipt.get("qualityDispositions") instanceof List<?> events) {
                        for (var raw : events) {
                            var event = JSON.convertValue(raw, QualityDisposition.class);
                            if (event.hasRevocation() || !"QUALIFIED".equals(event.originalOutcome())) continue;
                            Object srcObj = pieceSources.get(String.valueOf(event.command().pieceId()));
                            if (srcObj == null) srcObj = pieceSources.get(event.command().pieceId());
                            if (srcObj instanceof Map<?, ?> srcMap && Objects.equals(task.id(), srcMap.get("taskId"))
                                    && srcMap.get("lineId") instanceof Number ln) {
                                completed.merge(String.valueOf(ln.intValue()), -1, Integer::sum);
                            }
                        }
                    }
                } else {
                    if (!task.id().equals(receipt.get("taskId"))) continue;
                    if (receipt.get("demandQuantities") instanceof Map<?, ?> quantities)
                        quantities.forEach((id, n) -> completed.merge(id.toString(), ((Number) n).intValue(), Integer::sum));
                    if (receipt.get("qualityDispositions") instanceof List<?> events) {
                        for (var raw : events) {
                            var event = JSON.convertValue(raw, QualityDisposition.class);
                            if (event.hasRevocation()) continue;
                            if ("QUALIFIED".equals(event.originalOutcome()))
                                completed.merge(String.valueOf(event.demandId()), -1, Integer::sum);
                        }
                    }
                }
            }
        }
        for (var line : task.demands()) {
            put(result, "DEMAND", task.id() + "/" + line.id(),
                    Map.of("taskId", task.id(), "materialModel", task.materialModel(), "line", line,
                            "completed", completed.getOrDefault(String.valueOf(line.id()), 0)));
        }
        return result;
    }

    static Set<String> receiptTaskIds(Map<String, Object> receipt) {
        if (receipt == null) return Set.of();
        var ids = new LinkedHashSet<String>();
        if (receipt.get("taskId") instanceof String s && !s.isBlank()) ids.add(s);
        if (receipt.get("taskDemandQuantities") instanceof Map<?, ?> multi) {
            for (Object k : multi.keySet()) {
                if (k != null && !k.toString().isBlank()) ids.add(k.toString());
            }
        }
        return ids;
    }

    /**
     * 增量账本追加：
     * - 当已有已校验 BalanceIndex 且账本已初始化时，仅重算本次脏聚合键的 Balance，O(k) 生成账本条目；
     * - 当首次冷启动、跨节点刷新后或尚未初始化 MIGRATION_OPENING 时，自动回退一次全量校验并建好 BalanceIndex。
     */
    static AppendOutcome appendIncremental(
            BalanceIndex cachedIndex,
            long beforeRevision,
            List<InventoryLedgerEntry> beforeLedger,
            java.util.function.Supplier<InventorySnapshot> beforeSnapshotSupplier,
            Map<String, MotherRollInfo> afterRolls,
            Map<String, RemnantStock> afterRemnants,
            Map<String, Map<String, Object>> afterReceipts,
            Map<String, CuttingTask> afterTasks,
            Map<String, InventoryTransfer> afterTransfers,
            Map<String, InventoryCount> afterCounts,
            Map<String, QualityReleaseDocument> afterQualityReleases,
            Map<String, InventoryReceiptDocument> afterInventoryReceipts,
            Map<String, MaterialIssueDocument> afterMaterialIssues,
            DirtyLedgerKeys dirty,
            String action,
            String businessId,
            String actor,
            long now
    ) {
        // 1. 尚无有效基线或未建迁移期初：执行一次完整基线建立与防篡改重放校验
        BalanceIndex index = cachedIndex;
        List<InventoryLedgerEntry> entries = new ArrayList<>(beforeLedger);
        if (entries.isEmpty()) {
            var old = balances(beforeSnapshotSupplier.get());
            String opening = UUID.randomUUID().toString();
            add(entries, opening, "MIGRATION_OPENING", "CHECKPOINT", "opening", null, List.of(), "SYSTEM_MIGRATION",
                    now, beforeRevision, beforeRevision, List.of(), null, "{\"schemaVersion\":1}");
            for (var balance : old.values()) {
                add(entries, opening, "MIGRATION_OPENING", balance.type(), balance.id(),
                        null, List.of(), "SYSTEM_MIGRATION", now, beforeRevision, beforeRevision, List.of(), null, balance.value());
            }
            index = new BalanceIndex(new TreeMap<>(old), beforeRevision, entries.size());
        } else if (index == null || !index.matches(beforeRevision, beforeLedger.size())) {
            var old = balances(beforeSnapshotSupplier.get());
            var issues = replayIssues(entries, old);
            if (!issues.isEmpty()) throw new IllegalStateException("库存与流水不一致，拒绝继续记账：" + issues.get(0));
            index = new BalanceIndex(new TreeMap<>(old), beforeRevision, entries.size());
        }

        // 2. 纯排程/执行态变更（未触碰 9 类账本聚合）：跳过所有 canonical 计算与账本写入
        if (dirty.isEmpty()) {
            return new AppendOutcome(List.copyOf(entries), index, Map.of(), beforeRevision + 1);
        }

        // 3. 仅针对本次脏聚合计算变更后的候选 Balance
        var candidateKeys = new TreeSet<String>();
        var currentSubset = new HashMap<String, Balance>();

        for (String id : dirty.rollIds()) {
            String key = "ROLL/" + id;
            candidateKeys.add(key);
            MotherRollInfo roll = afterRolls.get(id);
            if (roll != null) currentSubset.put(key, balanceForRoll(roll));
        }
        for (String id : dirty.remnantIds()) {
            String key = "REMNANT/" + id;
            candidateKeys.add(key);
            RemnantStock rem = afterRemnants.get(id);
            if (rem != null) currentSubset.put(key, new Balance("REMNANT", id, canonical(rem)));
        }
        for (String id : dirty.receiptIds()) {
            String key = "REPORT/" + id;
            candidateKeys.add(key);
            Map<String, Object> rec = afterReceipts.get(id);
            if (rec != null) currentSubset.put(key, new Balance("REPORT", id, canonical(rec)));
        }
        var dirtyTaskIds = new LinkedHashSet<>(dirty.taskIds());
        dirtyTaskIds.addAll(dirty.affectedReceiptTaskIds());
        for (String taskId : dirtyTaskIds) {
            String prefix = "DEMAND/" + taskId + "/";
            for (String existingKey : index.balances.keySet()) {
                if (existingKey.startsWith(prefix)) candidateKeys.add(existingKey);
            }
            CuttingTask task = afterTasks.get(taskId);
            if (task != null) {
                var taskBalances = balancesForTask(task, afterReceipts);
                candidateKeys.addAll(taskBalances.keySet());
                currentSubset.putAll(taskBalances);
            }
        }
        for (String id : dirty.transferIds()) {
            String key = "TRANSFER/" + id;
            candidateKeys.add(key);
            var doc = afterTransfers.get(id);
            if (doc != null) currentSubset.put(key, new Balance("TRANSFER", id, canonical(doc)));
        }
        for (String id : dirty.countIds()) {
            String key = "COUNT/" + id;
            candidateKeys.add(key);
            var doc = afterCounts.get(id);
            if (doc != null) currentSubset.put(key, new Balance("COUNT", id, canonical(doc)));
        }
        for (String id : dirty.qualityReleaseIds()) {
            String key = "QUALITY_RELEASE/" + id;
            candidateKeys.add(key);
            var doc = afterQualityReleases.get(id);
            if (doc != null) currentSubset.put(key, new Balance("QUALITY_RELEASE", id, canonical(doc)));
        }
        for (String id : dirty.inventoryReceiptIds()) {
            String key = "INVENTORY_RECEIPT/" + id;
            candidateKeys.add(key);
            var doc = afterInventoryReceipts.get(id);
            if (doc != null) currentSubset.put(key, new Balance("INVENTORY_RECEIPT", id, canonical(doc)));
        }
        for (String id : dirty.materialIssueIds()) {
            String key = "MATERIAL_ISSUE/" + id;
            candidateKeys.add(key);
            var doc = afterMaterialIssues.get(id);
            if (doc != null) currentSubset.put(key, new Balance("MATERIAL_ISSUE", id, canonical(doc)));
        }

        final BalanceIndex effectiveIndex = index;
        var changedReports = candidateKeys.stream()
                .filter(k -> k.startsWith("REPORT/") && !Objects.equals(effectiveIndex.balances.get(k), currentSubset.get(k)))
                .map(k -> k.substring("REPORT/".length()))
                .toList();
        var patches = new LinkedHashMap<String, Balance>();
        String transaction = UUID.randomUUID().toString();
        for (String key : candidateKeys) {
            var a = index.balances.get(key);
            var b = currentSubset.get(key);
            if (Objects.equals(a, b)) continue;
            patches.put(key, b);
            var identity = b == null ? a : b;
            var sources = changedReports.stream().filter(id -> touches(identity, afterReceipts.get(id))).toList();
            List<String> reverses = "REPORT_REVERSE".equals(action) ? entries.stream()
                    .filter(e -> e.aggregateType().equals(identity.type()) && e.aggregateId().equals(identity.id())
                            && (e.sourceReportIds().contains(businessId) || "MIGRATION_OPENING".equals(e.eventType())))
                    .map(InventoryLedgerEntry::id).toList()
                    : "QUALITY_DISPOSITION_REVOKE".equals(action) ? entries.stream()
                    .filter(e -> e.aggregateType().equals(identity.type()) && e.aggregateId().equals(identity.id())
                            && "QUALITY_DISPOSITION".equals(e.eventType())
                            && (e.sourceReportIds().contains(businessId) || Objects.equals(e.businessId(), businessId)))
                    .map(InventoryLedgerEntry::id).toList()
                    : List.of();
            String event = "ROLL_RECEIPT_OR_UPDATE".equals(action)
                    ? (a == null ? "ROLL_RECEIPT" : "ROLL_ARCHIVE_UPDATE") : action;
            add(entries, transaction, event, identity.type(), identity.id(), businessId, sources, actor, now,
                    beforeRevision, beforeRevision + 1, reverses, a == null ? null : a.value(), b == null ? null : b.value());
        }
        return new AppendOutcome(List.copyOf(entries), index, patches, beforeRevision + 1);
    }

    /** Only called inside the existing inventory mutation. Opening records never invent past transactions. */
    public static List<InventoryLedgerEntry> append(InventorySnapshot before, InventorySnapshot after,
            String action, String businessId, String actor, long now) {
        var entries = new ArrayList<>(before.ledger());
        var old = balances(before); var current = balances(after);
        if (entries.isEmpty()) {
            String opening = UUID.randomUUID().toString();
            add(entries,opening,"MIGRATION_OPENING","CHECKPOINT","opening",null,List.of(),"SYSTEM_MIGRATION",
                    now,before.revision(),before.revision(),List.of(),null,"{\"schemaVersion\":1}");
            for (var balance : old.values()) add(entries,opening,"MIGRATION_OPENING",balance.type(),balance.id(),
                    null,List.of(),"SYSTEM_MIGRATION",now,before.revision(),before.revision(),List.of(),null,balance.value());
        } else {
            var issues = replayIssues(entries,old);
            if (!issues.isEmpty()) throw new IllegalStateException("库存与流水不一致，拒绝继续记账：" + issues.get(0));
        }
        var keys = new TreeSet<>(old.keySet()); keys.addAll(current.keySet());
        var reports = keys.stream().filter(k -> k.startsWith("REPORT/") && !Objects.equals(old.get(k),current.get(k)))
                .map(k -> k.substring("REPORT/".length())).toList();
        String transaction = UUID.randomUUID().toString();
        for (String key : keys) {
            var a=old.get(key); var b=current.get(key);
            if (Objects.equals(a,b)) continue;
            var identity=b==null?a:b;
            var sources=reports.stream().filter(id -> touches(identity,after.receipts().get(id))).toList();
            List<String> reverses = "REPORT_REVERSE".equals(action) ? entries.stream()
                    .filter(e -> e.aggregateType().equals(identity.type()) && e.aggregateId().equals(identity.id())
                            && (e.sourceReportIds().contains(businessId) || "MIGRATION_OPENING".equals(e.eventType())))
                    .map(InventoryLedgerEntry::id).toList()
                    : "QUALITY_DISPOSITION_REVOKE".equals(action) ? entries.stream()
                    .filter(e -> e.aggregateType().equals(identity.type()) && e.aggregateId().equals(identity.id())
                            && "QUALITY_DISPOSITION".equals(e.eventType())
                            && (e.sourceReportIds().contains(businessId) || Objects.equals(e.businessId(), businessId)))
                    .map(InventoryLedgerEntry::id).toList()
                    : List.of();
            String event = "ROLL_RECEIPT_OR_UPDATE".equals(action)
                    ? (a==null?"ROLL_RECEIPT":"ROLL_ARCHIVE_UPDATE") : action;
            add(entries,transaction,event,identity.type(),identity.id(),businessId,sources,actor,now,
                    before.revision(),after.revision()+1,reverses,a==null?null:a.value(),b==null?null:b.value());
        }
        return List.copyOf(entries);
    }
    private static boolean touches(Balance balance,Map<String,Object> receipt) {
        if(receipt==null)return false;
        return switch(balance.type()) {
            case "REPORT" -> balance.id().equals(receipt.get("planId"));
            case "ROLL" -> balance.id().equals(receipt.get("rollId"));
            case "DEMAND" -> {
                var demand=JSON.readTree(balance.value());
                String taskId = demand.get("taskId").asString();
                String line = String.valueOf(demand.get("line").get("id").asInt());
                if (receipt.get("taskDemandQuantities") instanceof Map<?,?> multi) {
                    yield multi.get(taskId) instanceof Map<?,?> counts && counts.containsKey(line);
                }
                yield taskId.equals(receipt.get("taskId"))
                        && (receipt.get("demandQuantities") instanceof Map<?,?> counts && counts.containsKey(line));
            }
            case "REMNANT" -> {
                boolean found=balance.id().equals(receipt.get("sourceRemnantId"));
                if(receipt.get("derivedRemnants") instanceof List<?> children)
                    found |= children.stream().anyMatch(child -> balance.id().equals(JSON.valueToTree(child).get("id").asString()));
                if(receipt.get("qualityDispositions") instanceof List<?> events)
                    found |= events.stream().anyMatch(raw -> balance.id().equals(JSON.convertValue(raw,QualityDisposition.class).remnantId()));
                yield found;
            }
            default -> false;
        };
    }
    private static void add(List<InventoryLedgerEntry> entries,String transaction,String action,String type,String id,
            String business,List<String> reports,String actor,long now,long before,long after,List<String> reverses,String a,String b) {
        entries.add(new InventoryLedgerEntry(UUID.randomUUID().toString(),entries.size()+1L,transaction,action,type,id,
                business==null?transaction:business,reports,actor,now,before,after,reverses,a,b));
    }

    private static List<Map<String,Object>> replayIssues(List<InventoryLedgerEntry> entries,Map<String,Balance> current) {
        var issues=new ArrayList<Map<String,Object>>();
        var replay=new TreeMap<String,String>();
        long sequence=0;
        for(var entry:entries) {
            if(entry.sequence()!=++sequence) issues.add(Map.of("code","SEQUENCE_GAP","entryId",entry.id()));
            if("CHECKPOINT".equals(entry.aggregateType()))continue;
            String key=entry.aggregateType()+"/"+entry.aggregateId();
            if(!Objects.equals(replay.get(key),entry.beforeJson()))
                issues.add(Map.of("code","BROKEN_HISTORY","aggregate",key,"entryId",entry.id()));
            if(entry.afterJson()==null)replay.remove(key);else replay.put(key,entry.afterJson());
        }
        var keys=new TreeSet<>(replay.keySet());keys.addAll(current.keySet());
        for(String key:keys)if(!Objects.equals(replay.get(key),current.containsKey(key)?current.get(key).value():null))
            issues.add(Map.of("code","BALANCE_MISMATCH","aggregate",key));
        return issues;
    }
    public static Map<String,Object> reconcile(InventorySnapshot snapshot) {
        if(snapshot.ledger().isEmpty())return Map.of("status","NOT_INITIALIZED","revision",snapshot.revision(),
                "entryCount",0,"issues",List.of(),"message","尚未建立迁移期初；下一次成功业务写入将原子建立，查询不写库");
        var balances=balances(snapshot);
        var issues=replayIssues(snapshot.ledger(),balances);
        for(var balance:balances.values()) {
            var value=JSON.readTree(balance.value());
            if("DEMAND".equals(balance.type())) {
                int completed=value.get("completed").asInt(), quantity=value.get("line").get("quantity").asInt();
                if(completed<0 || completed>quantity)issues.add(Map.of("code","DEMAND_OUT_OF_RANGE","aggregate",balance.id()));
            }
            if("ROLL".equals(balance.type())) {
                double total=value.get("totalLength").asDouble(),used=value.get("usedLength").asDouble(),
                        remaining=value.get("currentRemainingLength").asDouble();
                double scrapped=value.has("scrappedLengthMm") && value.get("scrappedLengthMm").isNumber()
                        ? value.get("scrappedLengthMm").asDouble() : 0.0;
                boolean isScrapped=value.has("inspectionStatus") && "SCRAPPED".equals(value.get("inspectionStatus").asString());
                if(!Double.isFinite(total+used+remaining+scrapped) || used<0 || remaining<0 || scrapped<0
                        || (isScrapped && remaining>.001) || (!isScrapped && scrapped>.001)
                        || Math.abs(total-used-remaining-scrapped)>.001)
                    issues.add(Map.of("code","ROLL_LENGTH_MISMATCH","aggregate",balance.id()));
            }
        }
        var areaChecks=new ArrayList<Map<String,Object>>();
        for(var receipt:snapshot.receipts().values()) {
            if("REVERSED".equals(receipt.get("status")))continue;
            String id=receipt.get("planId").toString();
            if(!(receipt.get("usedArea") instanceof Number) || !(receipt.get("pieceArea") instanceof Number)
                    || !(receipt.get("remArea") instanceof Number) || !(receipt.get("wasteArea") instanceof Number)) {
                issues.add(Map.of("code","HISTORICAL_AREA_UNAVAILABLE","reportId",id));continue;
            }
            double used=((Number)receipt.get("usedArea")).doubleValue(),good=((Number)receipt.get("pieceArea")).doubleValue(),
                    remnant=((Number)receipt.get("remArea")).doubleValue(),waste=((Number)receipt.get("wasteArea")).doubleValue(),
                    rejected=receipt.get("rejectedArea") instanceof Number n?n.doubleValue():0;
            if(receipt.get("qualityDispositions") instanceof List<?> events)for(var raw:events) {
                var event=JSON.convertValue(raw,QualityDisposition.class);
                if(event.hasRevocation())continue;
                double area=event.pieceAreaMm2()/1_000_000, recovered=event.recoveredAreaMm2()/1_000_000;
                if("QUALIFIED".equals(event.originalOutcome())) {good-=area;waste+=area;}
                else if("REJECTED".equals(event.originalOutcome()))rejected-=area;
                remnant+=recovered;waste-=recovered;
            }
            double otherWaste=waste-rejected,delta=used-good-remnant-rejected-otherWaste;
            if(!Double.isFinite(used+good+remnant+rejected+otherWaste) || Math.abs(delta)>1e-6
                    || Math.min(Math.min(good,remnant),Math.min(rejected,otherWaste)) < -1e-6)
                issues.add(Map.of("code","REPORT_AREA_MISMATCH","reportId",id));
            areaChecks.add(Map.of("reportId",id,"unit","m2","consumed",used,"qualified",good,
                    "rejected",rejected,"recovered",remnant,"otherWasteAndLoss",otherWaste,"difference",delta));
        }
        return Map.of("status",issues.isEmpty()?"BALANCED":"MISMATCH","revision",snapshot.revision(),
                "entryCount",snapshot.ledger().size(),"aggregateCount",balances.size(),"issues",issues,"areas",areaChecks);
    }
}
