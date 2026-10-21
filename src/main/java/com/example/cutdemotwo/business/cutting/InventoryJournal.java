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
                if (!task.id().equals(receipt.get("taskId")) || "REVERSED".equals(receipt.get("status"))) continue;
                if (receipt.get("demandQuantities") instanceof Map<?,?> quantities)
                    quantities.forEach((id,n) -> completed.merge(id.toString(), ((Number)n).intValue(), Integer::sum));
                if (receipt.get("qualityDispositions") instanceof List<?> events) for (var raw : events) {
                    var event = JSON.convertValue(raw,QualityDisposition.class);
                    if ("QUALIFIED".equals(event.originalOutcome()))
                        completed.merge(String.valueOf(event.demandId()),-1,Integer::sum);
                }
            }
            for (var line : task.demands()) put(result,"DEMAND",task.id()+"/"+line.id(),
                    Map.of("taskId",task.id(),"materialModel",task.materialModel(),"line",line,
                            "completed",completed.getOrDefault(String.valueOf(line.id()),0)));
        }
        return result;
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
                    .map(InventoryLedgerEntry::id).toList() : List.of();
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
                String line=String.valueOf(demand.get("line").get("id").asInt());
                yield demand.get("taskId").asString().equals(receipt.get("taskId"))
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
                if(!Double.isFinite(total+used+remaining) || used<0 || remaining<0 || Math.abs(total-used-remaining)>.001)
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
