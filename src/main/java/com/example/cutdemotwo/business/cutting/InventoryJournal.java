package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.*;
import com.example.cutdemotwo.persistence.InventorySnapshot;
import com.example.cutdemotwo.persistence.InventoryStore;
import tools.jackson.databind.*;
import tools.jackson.databind.node.ObjectNode;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.*;

/** Accounting projection and append generation only; no HTTP, solver or independent writes. */
public final class InventoryJournal {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int STREAM_BATCH_SIZE = 500;

    private InventoryJournal() {}

    record Balance(String type, String id, String value) {}

    static String canonical(Object value) {
        return JSON.writeValueAsString(sorted(JSON.valueToTree(value)));
    }

    private static Object sorted(JsonNode value) {
        if (value.isObject()) {
            var map = new TreeMap<String, Object>();
            value.properties().forEach(e -> map.put(e.getKey(), sorted(e.getValue())));
            return map;
        }
        if (value.isArray()) {
            var list = new ArrayList<Object>();
            value.forEach(v -> list.add(sorted(v)));
            return list;
        }
        return value;
    }

    private static void put(Map<String, Balance> result, String type, String id, Object value) {
        result.put(type + "/" + id, new Balance(type, id, canonical(value)));
    }

    private static Map<String, Balance> balances(InventorySnapshot snapshot) {
        var result = new TreeMap<String, Balance>();
        for (var roll : snapshot.rolls()) {
            result.put("ROLL/" + roll.getRollId(), balanceForRoll(roll));
        }
        for (var remnant : snapshot.remnants()) put(result, "REMNANT", remnant.getId(), remnant);
        if (snapshot.receipts() != null)
            snapshot.receipts().forEach((id, receipt) -> put(result, "REPORT", id, receipt));
        if (snapshot.tasks() != null) for (var task : snapshot.tasks().values()) {
            result.putAll(balancesForTask(task, snapshot.receipts()));
        }
        snapshot.transfers().forEach((id, document) -> put(result, "TRANSFER", id, document));
        snapshot.counts().forEach((id, document) -> put(result, "COUNT", id, document));
        snapshot.qualityReleases().forEach((id, document) -> put(result, "QUALITY_RELEASE", id, document));
        snapshot.inventoryReceipts().forEach((id, document) -> put(result, "INVENTORY_RECEIPT", id, document));
        snapshot.materialIssues().forEach((id, document) -> put(result, "MATERIAL_ISSUE", id, document));
        return result;
    }

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

    static Balance balanceForRoll(MotherRollInfo roll) {
        ObjectNode value = JSON.valueToTree(roll);
        value.remove("remnantCount");
        value.remove("remnantTotalArea");
        return new Balance("ROLL", roll.getRollId(), canonical(value));
    }

    static void accumulateCompletedForTask(Map<String, Object> receipt, String taskId, Map<String, Integer> completed) {
        if ("REVERSED".equals(receipt.get("status"))) return;
        boolean multiTask = receipt.get("taskDemandQuantities") instanceof Map<?, ?>;
        if (multiTask) {
            Map<?, ?> multi = (Map<?, ?>) receipt.get("taskDemandQuantities");
            if (!(multi.get(taskId) instanceof Map<?, ?> quantities)) return;
            quantities.forEach((id, n) -> completed.merge(id.toString(), ((Number) n).intValue(), Integer::sum));
            Map<?, ?> pieceSources = receipt.get("pieceSources") instanceof Map<?, ?> ps ? ps : null;
            if (pieceSources != null && receipt.get("qualityDispositions") instanceof List<?> events) {
                for (var raw : events) {
                    var event = JSON.convertValue(raw, QualityDisposition.class);
                    if (event.hasRevocation() || !"QUALIFIED".equals(event.originalOutcome())) continue;
                    Object srcObj = pieceSources.get(String.valueOf(event.command().pieceId()));
                    if (srcObj == null) srcObj = pieceSources.get(event.command().pieceId());
                    if (srcObj instanceof Map<?, ?> srcMap && Objects.equals(taskId, srcMap.get("taskId"))
                            && srcMap.get("lineId") instanceof Number ln) {
                        completed.merge(String.valueOf(ln.intValue()), -1, Integer::sum);
                    }
                }
            }
        } else {
            if (!taskId.equals(receipt.get("taskId"))) return;
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

    static Map<String, Balance> balancesForTask(CuttingTask task, Map<String, Map<String, Object>> receipts) {
        var result = new TreeMap<String, Balance>();
        if (task == null) return result;
        var completed = new HashMap<String, Integer>();
        if (receipts != null) {
            for (var receipt : receipts.values()) {
                accumulateCompletedForTask(receipt, task.id(), completed);
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
     * 热冷分离增量账本追加（JDBC 模式）：
     * 绝不构建全库 BalanceIndex，也绝不重放全量 inventory_ledger；
     * 仅对本次脏聚合键从存储索引点查最新 after_json 校验防篡改，复杂度 O(k log L)。
     */
    static List<InventoryLedgerEntry> appendDeltaIncremental(
            InventoryStore store,
            long beforeRevision,
            long beforeLedgerSize,
            java.util.function.Supplier<InventorySnapshot> beforeFullSnapshotSupplier,
            Map<String, MotherRollInfo> beforeRolls,
            Map<String, RemnantStock> beforeRemnants,
            Map<String, Map<String, Object>> beforeReceipts,
            Map<String, CuttingTask> beforeTasks,
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
        List<InventoryLedgerEntry> appended = new ArrayList<>();
        long nextSeq = beforeLedgerSize;

        if (beforeLedgerSize == 0L) {
            InventorySnapshot openSnap = beforeRevision == 0L ? beforeFullSnapshotSupplier.get()
                    : Objects.requireNonNullElseGet(store.load(), beforeFullSnapshotSupplier);
            var old = balances(openSnap);
            String opening = UUID.randomUUID().toString();
            appended.add(new InventoryLedgerEntry(UUID.randomUUID().toString(), ++nextSeq, opening,
                    "MIGRATION_OPENING", "CHECKPOINT", "opening", opening, List.of(), "SYSTEM_MIGRATION",
                    now, beforeRevision, beforeRevision, List.of(), null, "{\"schemaVersion\":1}"));
            for (var balance : old.values()) {
                appended.add(new InventoryLedgerEntry(UUID.randomUUID().toString(), ++nextSeq, opening,
                        "MIGRATION_OPENING", balance.type(), balance.id(), opening, List.of(), "SYSTEM_MIGRATION",
                        now, beforeRevision, beforeRevision, List.of(), null, balance.value()));
            }
        }

        if (dirty.isEmpty()) {
            return List.copyOf(appended);
        }

        var candidateKeys = new TreeSet<String>();
        var beforeSubset = new HashMap<String, Balance>();
        var afterSubset = new HashMap<String, Balance>();

        for (String id : dirty.rollIds()) {
            String key = "ROLL/" + id;
            candidateKeys.add(key);
            if (beforeRolls.get(id) != null) beforeSubset.put(key, balanceForRoll(beforeRolls.get(id)));
            if (afterRolls.get(id) != null) afterSubset.put(key, balanceForRoll(afterRolls.get(id)));
        }
        for (String id : dirty.remnantIds()) {
            String key = "REMNANT/" + id;
            candidateKeys.add(key);
            if (beforeRemnants.get(id) != null) beforeSubset.put(key, new Balance("REMNANT", id, canonical(beforeRemnants.get(id))));
            if (afterRemnants.get(id) != null) afterSubset.put(key, new Balance("REMNANT", id, canonical(afterRemnants.get(id))));
        }
        for (String id : dirty.receiptIds()) {
            String key = "REPORT/" + id;
            candidateKeys.add(key);
            if (beforeReceipts.get(id) != null) beforeSubset.put(key, new Balance("REPORT", id, canonical(beforeReceipts.get(id))));
            if (afterReceipts.get(id) != null) afterSubset.put(key, new Balance("REPORT", id, canonical(afterReceipts.get(id))));
        }

        var dirtyTaskIds = new LinkedHashSet<>(dirty.taskIds());
        dirtyTaskIds.addAll(dirty.affectedReceiptTaskIds());
        for (String taskId : dirtyTaskIds) {
            CuttingTask bTask = beforeTasks.get(taskId);
            if (bTask == null && beforeRevision > 0L) {
                bTask = store.findCuttingTask(taskId).map(e -> e.value()).orElse(null);
            }
            CuttingTask aTask = afterTasks.get(taskId);
            if (aTask == null && !dirty.taskIds().contains(taskId)) aTask = bTask;

            Map<String, Map<String, Object>> baseTaskReceipts = new LinkedHashMap<>();
            if (bTask != null || dirty.affectedReceiptTaskIds().contains(taskId)) {
                for (Map<String, Object> dbRec : store.findCutReportsByTaskId(taskId)) {
                    Object pid = dbRec.get("planId");
                    if (pid != null) baseTaskReceipts.put(pid.toString(), dbRec);
                }
            }
            Map<String, Map<String, Object>> beforeTaskRecs = new LinkedHashMap<>(baseTaskReceipts);
            for (String rid : dirty.receiptIds()) {
                Map<String, Object> bRec = beforeReceipts.get(rid);
                if (bRec != null && receiptTaskIds(bRec).contains(taskId)) beforeTaskRecs.put(rid, bRec);
                else beforeTaskRecs.remove(rid);
            }
            Map<String, Map<String, Object>> afterTaskRecs = new LinkedHashMap<>(baseTaskReceipts);
            for (String rid : dirty.receiptIds()) {
                Map<String, Object> aRec = afterReceipts.get(rid);
                if (aRec != null && receiptTaskIds(aRec).contains(taskId)) afterTaskRecs.put(rid, aRec);
                else afterTaskRecs.remove(rid);
            }

            var bBalances = balancesForTask(bTask, beforeTaskRecs);
            var aBalances = balancesForTask(aTask, afterTaskRecs);
            candidateKeys.addAll(bBalances.keySet());
            candidateKeys.addAll(aBalances.keySet());
            beforeSubset.putAll(bBalances);
            afterSubset.putAll(aBalances);
        }

        for (String id : dirty.transferIds()) {
            String key = "TRANSFER/" + id;
            candidateKeys.add(key);
            if (afterTransfers.get(id) != null) afterSubset.put(key, new Balance("TRANSFER", id, canonical(afterTransfers.get(id))));
        }
        for (String id : dirty.countIds()) {
            String key = "COUNT/" + id;
            candidateKeys.add(key);
            if (afterCounts.get(id) != null) afterSubset.put(key, new Balance("COUNT", id, canonical(afterCounts.get(id))));
        }
        for (String id : dirty.qualityReleaseIds()) {
            String key = "QUALITY_RELEASE/" + id;
            candidateKeys.add(key);
            if (afterQualityReleases.get(id) != null) afterSubset.put(key, new Balance("QUALITY_RELEASE", id, canonical(afterQualityReleases.get(id))));
        }
        for (String id : dirty.inventoryReceiptIds()) {
            String key = "INVENTORY_RECEIPT/" + id;
            candidateKeys.add(key);
            if (afterInventoryReceipts.get(id) != null) afterSubset.put(key, new Balance("INVENTORY_RECEIPT", id, canonical(afterInventoryReceipts.get(id))));
        }
        for (String id : dirty.materialIssueIds()) {
            String key = "MATERIAL_ISSUE/" + id;
            candidateKeys.add(key);
            if (afterMaterialIssues.get(id) != null) afterSubset.put(key, new Balance("MATERIAL_ISSUE", id, canonical(afterMaterialIssues.get(id))));
        }

        var changedReports = candidateKeys.stream()
                .filter(k -> k.startsWith("REPORT/") && !Objects.equals(beforeSubset.get(k), afterSubset.get(k)))
                .map(k -> k.substring("REPORT/".length()))
                .toList();

        // 若此前处于 beforeLedgerSize == 0 刚在上面建完期初，用 appended 中的期初记录校验即可，无需再查空库
        Map<String, String> openingSnapshotMap = beforeLedgerSize == 0L ? new HashMap<>() : null;
        if (openingSnapshotMap != null) {
            for (InventoryLedgerEntry oe : appended) {
                if (!"CHECKPOINT".equals(oe.aggregateType())) {
                    openingSnapshotMap.put(oe.aggregateType() + "/" + oe.aggregateId(), oe.afterJson());
                }
            }
        }

        String transaction = UUID.randomUUID().toString();
        for (String key : candidateKeys) {
            Balance a = beforeSubset.get(key);
            Balance b = afterSubset.get(key);
            if (Objects.equals(a, b)) continue;
            Balance identity = b == null ? a : b;
            String expectedBefore = a == null ? null : a.value();
            String latestRecorded = openingSnapshotMap != null
                    ? openingSnapshotMap.get(key)
                    : store.findLatestAggregateAfterJson(identity.type(), identity.id()).orElse(null);
            if (!Objects.equals(latestRecorded, expectedBefore)) {
                throw new IllegalStateException("库存与流水不一致，拒绝继续记账：" + key);
            }
            var sources = changedReports.stream().filter(id -> touches(identity, afterReceipts.get(id))).toList();
            List<String> reverses = ("REPORT_REVERSE".equals(action) || "QUALITY_DISPOSITION_REVOKE".equals(action))
                    ? findReversalsWithFallback(store, appended, identity.type(), identity.id(), businessId,
                    "QUALITY_DISPOSITION_REVOKE".equals(action))
                    : List.of();
            String event = "ROLL_RECEIPT_OR_UPDATE".equals(action)
                    ? (a == null ? "ROLL_RECEIPT" : "ROLL_ARCHIVE_UPDATE") : action;
            appended.add(new InventoryLedgerEntry(
                    UUID.randomUUID().toString(), ++nextSeq, transaction, event,
                    identity.type(), identity.id(), businessId == null ? transaction : businessId,
                    sources, actor, now, beforeRevision, beforeRevision + 1,
                    reverses, expectedBefore, b == null ? null : b.value()
            ));
        }
        return List.copyOf(appended);
    }

    private static List<String> findReversalsWithFallback(
            InventoryStore store, List<InventoryLedgerEntry> appended, String type, String id,
            String businessId, boolean dispositionRevoke
    ) {
        List<String> ids = new ArrayList<>(store.findReversalLedgerIds(type, id, businessId, dispositionRevoke));
        for (InventoryLedgerEntry e : appended) {
            if (!e.aggregateType().equals(type) || !e.aggregateId().equals(id)) continue;
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

    /** 流式全量对账（JDBC 热冷分离专用）：全程以 32B SHA-256 摘要替代全库大 JSON 字符串，适配 -Xmx256m。 */
    public static Map<String, Object> reconcileStreaming(InventoryStore store, long currentRevision) {
        long entryCount = store.countLedgerEntries();
        if (entryCount == 0L) {
            return Map.of("status", "NOT_INITIALIZED", "revision", currentRevision,
                    "entryCount", 0, "issues", List.of(),
                    "message", "尚未建立迁移期初；下一次成功业务写入将原子建立，查询不写库");
        }
        var issues = new ArrayList<Map<String, Object>>();
        var replayHashes = new HashMap<String, String>();
        long[] expectedSeq = {0L};
        store.streamLedgerEntries(STREAM_BATCH_SIZE, batch -> {
            for (var entry : batch) {
                if (entry.sequence() != ++expectedSeq[0]) {
                    issues.add(Map.of("code", "SEQUENCE_GAP", "entryId", entry.id()));
                }
                if ("CHECKPOINT".equals(entry.aggregateType())) continue;
                String key = entry.aggregateType() + "/" + entry.aggregateId();
                String expectedBeforeHash = sha256OrNull(entry.beforeJson());
                if (!Objects.equals(replayHashes.get(key), expectedBeforeHash)) {
                    issues.add(Map.of("code", "BROKEN_HISTORY", "aggregate", key, "entryId", entry.id()));
                }
                if (entry.afterJson() == null) replayHashes.remove(key);
                else replayHashes.put(key, sha256OrNull(entry.afterJson()));
            }
        });

        int[] aggregateCount = {0};
        store.streamMotherRolls(STREAM_BATCH_SIZE, batch -> {
            for (var roll : batch) {
                aggregateCount[0]++;
                Balance bal = balanceForRoll(roll);
                verifyHashMatch(replayHashes, "ROLL/" + roll.getRollId(), bal.value(), issues);
                checkRollLengthConservation(roll.getRollId(), bal.value(), issues);
            }
        });
        store.streamRemnants(STREAM_BATCH_SIZE, batch -> {
            for (var rem : batch) {
                aggregateCount[0]++;
                verifyHashMatch(replayHashes, "REMNANT/" + rem.getId(), canonical(rem), issues);
            }
        });
        var taskCompletedMap = new HashMap<String, Map<String, Integer>>();
        var areaChecks = new ArrayList<Map<String, Object>>();
        store.streamAllCutReports(STREAM_BATCH_SIZE, batch -> {
            for (var receipt : batch) {
                aggregateCount[0]++;
                String pid = Objects.toString(receipt.get("planId"), "");
                verifyHashMatch(replayHashes, "REPORT/" + pid, canonical(receipt), issues);
                for (String tid : receiptTaskIds(receipt)) {
                    accumulateCompletedForTask(receipt, tid, taskCompletedMap.computeIfAbsent(tid, k -> new HashMap<>()));
                }
                checkReceiptArea(receipt, issues, areaChecks);
            }
        });
        store.streamCuttingTasks(STREAM_BATCH_SIZE, batch -> {
            for (var task : batch) {
                Map<String, Integer> done = taskCompletedMap.getOrDefault(task.id(), Map.of());
                for (var line : task.demands()) {
                    aggregateCount[0]++;
                    int completed = done.getOrDefault(String.valueOf(line.id()), 0);
                    if (completed < 0 || completed > line.quantity()) {
                        issues.add(Map.of("code", "DEMAND_OUT_OF_RANGE", "aggregate", task.id() + "/" + line.id()));
                    }
                    String val = canonical(Map.of("taskId", task.id(), "materialModel", task.materialModel(),
                            "line", line, "completed", completed));
                    verifyHashMatch(replayHashes, "DEMAND/" + task.id() + "/" + line.id(), val, issues);
                }
            }
        });
        store.streamTransfers(STREAM_BATCH_SIZE, batch -> {
            for (var doc : batch) { aggregateCount[0]++; verifyHashMatch(replayHashes, "TRANSFER/" + doc.id(), canonical(doc), issues); }
        });
        store.streamCounts(STREAM_BATCH_SIZE, batch -> {
            for (var doc : batch) { aggregateCount[0]++; verifyHashMatch(replayHashes, "COUNT/" + doc.id(), canonical(doc), issues); }
        });
        store.streamQualityReleases(STREAM_BATCH_SIZE, batch -> {
            for (var doc : batch) { aggregateCount[0]++; verifyHashMatch(replayHashes, "QUALITY_RELEASE/" + doc.id(), canonical(doc), issues); }
        });
        store.streamInventoryReceipts(STREAM_BATCH_SIZE, batch -> {
            for (var doc : batch) { aggregateCount[0]++; verifyHashMatch(replayHashes, "INVENTORY_RECEIPT/" + doc.id(), canonical(doc), issues); }
        });
        store.streamMaterialIssues(STREAM_BATCH_SIZE, batch -> {
            for (var doc : batch) { aggregateCount[0]++; verifyHashMatch(replayHashes, "MATERIAL_ISSUE/" + doc.id(), canonical(doc), issues); }
        });
        for (String leftover : new TreeSet<>(replayHashes.keySet())) {
            issues.add(Map.of("code", "BALANCE_MISMATCH", "aggregate", leftover));
        }
        return Map.of("status", issues.isEmpty() ? "BALANCED" : "MISMATCH", "revision", currentRevision,
                "entryCount", entryCount, "aggregateCount", aggregateCount[0], "issues", issues, "areas", areaChecks);
    }

    private static void verifyHashMatch(Map<String, String> replayHashes, String key, String actualJson, List<Map<String, Object>> issues) {
        String expectedHash = replayHashes.remove(key);
        if (!Objects.equals(expectedHash, sha256OrNull(actualJson))) {
            issues.add(Map.of("code", "BALANCE_MISMATCH", "aggregate", key));
        }
    }

    private static String sha256OrNull(String text) {
        if (text == null) return null;
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] bytes = md.digest(text.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(bytes);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 不可用", e);
        }
    }

    private static void checkRollLengthConservation(String rollId, String jsonStr, List<Map<String, Object>> issues) {
        var value = JSON.readTree(jsonStr);
        double total = value.get("totalLength").asDouble(), used = value.get("usedLength").asDouble(),
                remaining = value.get("currentRemainingLength").asDouble();
        double scrapped = value.has("scrappedLengthMm") && value.get("scrappedLengthMm").isNumber()
                ? value.get("scrappedLengthMm").asDouble() : 0.0;
        boolean isScrapped = value.has("inspectionStatus") && "SCRAPPED".equals(value.get("inspectionStatus").asString());
        if (!Double.isFinite(total + used + remaining + scrapped) || used < 0 || remaining < 0 || scrapped < 0
                || (isScrapped && remaining > .001) || (!isScrapped && scrapped > .001)
                || Math.abs(total - used - remaining - scrapped) > .001) {
            issues.add(Map.of("code", "ROLL_LENGTH_MISMATCH", "aggregate", rollId));
        }
    }

    private static void checkReceiptArea(Map<String, Object> receipt, List<Map<String, Object>> issues, List<Map<String, Object>> areaChecks) {
        if ("REVERSED".equals(receipt.get("status"))) return;
        String id = receipt.get("planId").toString();
        if (!(receipt.get("usedArea") instanceof Number) || !(receipt.get("pieceArea") instanceof Number)
                || !(receipt.get("remArea") instanceof Number) || !(receipt.get("wasteArea") instanceof Number)) {
            issues.add(Map.of("code", "HISTORICAL_AREA_UNAVAILABLE", "reportId", id));
            return;
        }
        double used = ((Number) receipt.get("usedArea")).doubleValue(), good = ((Number) receipt.get("pieceArea")).doubleValue(),
                remnant = ((Number) receipt.get("remArea")).doubleValue(), waste = ((Number) receipt.get("wasteArea")).doubleValue(),
                rejected = receipt.get("rejectedArea") instanceof Number n ? n.doubleValue() : 0;
        if (receipt.get("qualityDispositions") instanceof List<?> events) for (var raw : events) {
            var event = JSON.convertValue(raw, QualityDisposition.class);
            if (event.hasRevocation()) continue;
            double area = event.pieceAreaMm2() / 1_000_000, recovered = event.recoveredAreaMm2() / 1_000_000;
            if ("QUALIFIED".equals(event.originalOutcome())) { good -= area; waste += area; }
            else if ("REJECTED".equals(event.originalOutcome())) rejected -= area;
            remnant += recovered;
            waste -= recovered;
        }
        double otherWaste = waste - rejected, delta = used - good - remnant - rejected - otherWaste;
        if (!Double.isFinite(used + good + remnant + rejected + otherWaste) || Math.abs(delta) > 1e-6
                || Math.min(Math.min(good, remnant), Math.min(rejected, otherWaste)) < -1e-6)
            issues.add(Map.of("code", "REPORT_AREA_MISMATCH", "reportId", id));
        areaChecks.add(Map.of("reportId", id, "unit", "m2", "consumed", used, "qualified", good,
                "rejected", rejected, "recovered", remnant, "otherWasteAndLoss", otherWaste, "difference", delta));
    }

    // ==================== 原有 File 模式全量增量/对账（完全向后兼容） ====================

    static AppendOutcome appendIncremental(
            BalanceIndex cachedIndex, long beforeRevision, List<InventoryLedgerEntry> beforeLedger,
            java.util.function.Supplier<InventorySnapshot> beforeSnapshotSupplier,
            Map<String, MotherRollInfo> afterRolls, Map<String, RemnantStock> afterRemnants,
            Map<String, Map<String, Object>> afterReceipts, Map<String, CuttingTask> afterTasks,
            Map<String, InventoryTransfer> afterTransfers, Map<String, InventoryCount> afterCounts,
            Map<String, QualityReleaseDocument> afterQualityReleases,
            Map<String, InventoryReceiptDocument> afterInventoryReceipts,
            Map<String, MaterialIssueDocument> afterMaterialIssues,
            DirtyLedgerKeys dirty, String action, String businessId, String actor, long now
    ) {
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
        if (dirty.isEmpty()) return new AppendOutcome(List.copyOf(entries), index, Map.of(), beforeRevision + 1);

        var candidateKeys = new TreeSet<String>();
        var currentSubset = new HashMap<String, Balance>();
        for (String id : dirty.rollIds()) {
            String key = "ROLL/" + id; candidateKeys.add(key);
            if (afterRolls.get(id) != null) currentSubset.put(key, balanceForRoll(afterRolls.get(id)));
        }
        for (String id : dirty.remnantIds()) {
            String key = "REMNANT/" + id; candidateKeys.add(key);
            if (afterRemnants.get(id) != null) currentSubset.put(key, new Balance("REMNANT", id, canonical(afterRemnants.get(id))));
        }
        for (String id : dirty.receiptIds()) {
            String key = "REPORT/" + id; candidateKeys.add(key);
            if (afterReceipts.get(id) != null) currentSubset.put(key, new Balance("REPORT", id, canonical(afterReceipts.get(id))));
        }
        var dirtyTaskIds = new LinkedHashSet<>(dirty.taskIds()); dirtyTaskIds.addAll(dirty.affectedReceiptTaskIds());
        for (String taskId : dirtyTaskIds) {
            String prefix = "DEMAND/" + taskId + "/";
            for (String existingKey : index.balances.keySet()) if (existingKey.startsWith(prefix)) candidateKeys.add(existingKey);
            CuttingTask task = afterTasks.get(taskId);
            if (task != null) { var tb = balancesForTask(task, afterReceipts); candidateKeys.addAll(tb.keySet()); currentSubset.putAll(tb); }
        }
        for (String id : dirty.transferIds()) { String k = "TRANSFER/" + id; candidateKeys.add(k); if (afterTransfers.get(id) != null) currentSubset.put(k, new Balance("TRANSFER", id, canonical(afterTransfers.get(id)))); }
        for (String id : dirty.countIds()) { String k = "COUNT/" + id; candidateKeys.add(k); if (afterCounts.get(id) != null) currentSubset.put(k, new Balance("COUNT", id, canonical(afterCounts.get(id)))); }
        for (String id : dirty.qualityReleaseIds()) { String k = "QUALITY_RELEASE/" + id; candidateKeys.add(k); if (afterQualityReleases.get(id) != null) currentSubset.put(k, new Balance("QUALITY_RELEASE", id, canonical(afterQualityReleases.get(id)))); }
        for (String id : dirty.inventoryReceiptIds()) { String k = "INVENTORY_RECEIPT/" + id; candidateKeys.add(k); if (afterInventoryReceipts.get(id) != null) currentSubset.put(k, new Balance("INVENTORY_RECEIPT", id, canonical(afterInventoryReceipts.get(id)))); }
        for (String id : dirty.materialIssueIds()) { String k = "MATERIAL_ISSUE/" + id; candidateKeys.add(k); if (afterMaterialIssues.get(id) != null) currentSubset.put(k, new Balance("MATERIAL_ISSUE", id, canonical(afterMaterialIssues.get(id)))); }

        final BalanceIndex effectiveIndex = index;
        var changedReports = candidateKeys.stream()
                .filter(k -> k.startsWith("REPORT/") && !Objects.equals(effectiveIndex.balances.get(k), currentSubset.get(k)))
                .map(k -> k.substring("REPORT/".length())).toList();
        var patches = new LinkedHashMap<String, Balance>();
        String transaction = UUID.randomUUID().toString();
        for (String key : candidateKeys) {
            var a = index.balances.get(key); var b = currentSubset.get(key);
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
                    .map(InventoryLedgerEntry::id).toList() : List.of();
            String event = "ROLL_RECEIPT_OR_UPDATE".equals(action) ? (a == null ? "ROLL_RECEIPT" : "ROLL_ARCHIVE_UPDATE") : action;
            add(entries, transaction, event, identity.type(), identity.id(), businessId, sources, actor, now,
                    beforeRevision, beforeRevision + 1, reverses, a == null ? null : a.value(), b == null ? null : b.value());
        }
        return new AppendOutcome(List.copyOf(entries), index, patches, beforeRevision + 1);
    }

    public static List<InventoryLedgerEntry> append(InventorySnapshot before, InventorySnapshot after,
            String action, String businessId, String actor, long now) {
        var entries = new ArrayList<>(before.ledger());
        var old = balances(before); var current = balances(after);
        if (entries.isEmpty()) {
            String opening = UUID.randomUUID().toString();
            add(entries, opening, "MIGRATION_OPENING", "CHECKPOINT", "opening", null, List.of(), "SYSTEM_MIGRATION",
                    now, before.revision(), before.revision(), List.of(), null, "{\"schemaVersion\":1}");
            for (var balance : old.values()) add(entries, opening, "MIGRATION_OPENING", balance.type(), balance.id(),
                    null, List.of(), "SYSTEM_MIGRATION", now, before.revision(), before.revision(), List.of(), null, balance.value());
        } else {
            var issues = replayIssues(entries, old);
            if (!issues.isEmpty()) throw new IllegalStateException("库存与流水不一致，拒绝继续记账：" + issues.get(0));
        }
        var keys = new TreeSet<>(old.keySet()); keys.addAll(current.keySet());
        var reports = keys.stream().filter(k -> k.startsWith("REPORT/") && !Objects.equals(old.get(k), current.get(k)))
                .map(k -> k.substring("REPORT/".length())).toList();
        String transaction = UUID.randomUUID().toString();
        for (String key : keys) {
            var a = old.get(key); var b = current.get(key);
            if (Objects.equals(a, b)) continue;
            var identity = b == null ? a : b;
            var sources = reports.stream().filter(id -> touches(identity, after.receipts().get(id))).toList();
            List<String> reverses = "REPORT_REVERSE".equals(action) ? entries.stream()
                    .filter(e -> e.aggregateType().equals(identity.type()) && e.aggregateId().equals(identity.id())
                            && (e.sourceReportIds().contains(businessId) || "MIGRATION_OPENING".equals(e.eventType())))
                    .map(InventoryLedgerEntry::id).toList()
                    : "QUALITY_DISPOSITION_REVOKE".equals(action) ? entries.stream()
                    .filter(e -> e.aggregateType().equals(identity.type()) && e.aggregateId().equals(identity.id())
                            && "QUALITY_DISPOSITION".equals(e.eventType())
                            && (e.sourceReportIds().contains(businessId) || Objects.equals(e.businessId(), businessId)))
                    .map(InventoryLedgerEntry::id).toList() : List.of();
            String event = "ROLL_RECEIPT_OR_UPDATE".equals(action) ? (a == null ? "ROLL_RECEIPT" : "ROLL_ARCHIVE_UPDATE") : action;
            add(entries, transaction, event, identity.type(), identity.id(), businessId, sources, actor, now,
                    before.revision(), after.revision() + 1, reverses, a == null ? null : a.value(), b == null ? null : b.value());
        }
        return List.copyOf(entries);
    }

    private static boolean touches(Balance balance, Map<String, Object> receipt) {
        if (receipt == null) return false;
        return switch (balance.type()) {
            case "REPORT" -> balance.id().equals(receipt.get("planId"));
            case "ROLL" -> balance.id().equals(receipt.get("rollId"));
            case "DEMAND" -> {
                var demand = JSON.readTree(balance.value());
                String taskId = demand.get("taskId").asString();
                String line = String.valueOf(demand.get("line").get("id").asInt());
                if (receipt.get("taskDemandQuantities") instanceof Map<?, ?> multi)
                    yield multi.get(taskId) instanceof Map<?, ?> counts && counts.containsKey(line);
                yield taskId.equals(receipt.get("taskId")) && (receipt.get("demandQuantities") instanceof Map<?, ?> counts && counts.containsKey(line));
            }
            case "REMNANT" -> {
                boolean found = balance.id().equals(receipt.get("sourceRemnantId"));
                if (receipt.get("derivedRemnants") instanceof List<?> children)
                    found |= children.stream().anyMatch(child -> balance.id().equals(JSON.valueToTree(child).get("id").asString()));
                if (receipt.get("qualityDispositions") instanceof List<?> events)
                    found |= events.stream().anyMatch(raw -> balance.id().equals(JSON.convertValue(raw, QualityDisposition.class).remnantId()));
                yield found;
            }
            default -> false;
        };
    }

    private static void add(List<InventoryLedgerEntry> entries, String transaction, String action, String type, String id,
            String business, List<String> reports, String actor, long now, long before, long after, List<String> reverses, String a, String b) {
        entries.add(new InventoryLedgerEntry(UUID.randomUUID().toString(), entries.size() + 1L, transaction, action, type, id,
                business == null ? transaction : business, reports, actor, now, before, after, reverses, a, b));
    }

    private static List<Map<String, Object>> replayIssues(List<InventoryLedgerEntry> entries, Map<String, Balance> current) {
        var issues = new ArrayList<Map<String, Object>>();
        var replay = new TreeMap<String, String>();
        long sequence = 0;
        for (var entry : entries) {
            if (entry.sequence() != ++sequence) issues.add(Map.of("code", "SEQUENCE_GAP", "entryId", entry.id()));
            if ("CHECKPOINT".equals(entry.aggregateType())) continue;
            String key = entry.aggregateType() + "/" + entry.aggregateId();
            if (!Objects.equals(replay.get(key), entry.beforeJson()))
                issues.add(Map.of("code", "BROKEN_HISTORY", "aggregate", key, "entryId", entry.id()));
            if (entry.afterJson() == null) replay.remove(key); else replay.put(key, entry.afterJson());
        }
        var keys = new TreeSet<>(replay.keySet()); keys.addAll(current.keySet());
        for (String key : keys) if (!Objects.equals(replay.get(key), current.containsKey(key) ? current.get(key).value() : null))
            issues.add(Map.of("code", "BALANCE_MISMATCH", "aggregate", key));
        return issues;
    }

    public static Map<String, Object> reconcile(InventorySnapshot snapshot) {
        if (snapshot.ledger().isEmpty()) return Map.of("status", "NOT_INITIALIZED", "revision", snapshot.revision(),
                "entryCount", 0, "issues", List.of(), "message", "尚未建立迁移期初；下一次成功业务写入将原子建立，查询不写库");
        var balances = balances(snapshot);
        var issues = replayIssues(snapshot.ledger(), balances);
        for (var balance : balances.values()) {
            var value = JSON.readTree(balance.value());
            if ("DEMAND".equals(balance.type())) {
                int completed = value.get("completed").asInt(), quantity = value.get("line").get("quantity").asInt();
                if (completed < 0 || completed > quantity) issues.add(Map.of("code", "DEMAND_OUT_OF_RANGE", "aggregate", balance.id()));
            }
            if ("ROLL".equals(balance.type())) checkRollLengthConservation(balance.id(), balance.value(), issues);
        }
        var areaChecks = new ArrayList<Map<String, Object>>();
        for (var receipt : snapshot.receipts().values()) checkReceiptArea(receipt, issues, areaChecks);
        return Map.of("status", issues.isEmpty() ? "BALANCED" : "MISMATCH", "revision", snapshot.revision(),
                "entryCount", snapshot.ledger().size(), "aggregateCount", balances.size(), "issues", issues, "areas", areaChecks);
    }
}
