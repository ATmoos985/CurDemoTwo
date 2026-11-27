package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;

import java.util.*;

/**
 * 母卷切割与疵点空间剖面图只读查询协作者：
 * 仅通过 {@link CuttingStatePort#inRead} 读取不可变快照投影，不执行任何状态写入。
 */
final class MotherRollSpatialMapQuery {

    private final CuttingStatePort statePort;

    MotherRollSpatialMapQuery(CuttingStatePort statePort) {
        this.statePort = statePort;
    }

    Map<String, Object> getMotherRollSpatialMap(String rollId) {
        return statePort.inRead(tx -> {
            MotherRollInfo roll = tx.findRoll(rollId)
                    .orElseThrow(() -> new IllegalArgumentException("母卷不存在: " + rollId));

            Map<String, SchedulingScheme> planToScheme = new HashMap<>();
            List<SchedulingScheme> allSchemes = tx.listSchemes();
            for (SchedulingScheme s : allSchemes) {
                for (String pid : s.linkedPlanIds()) {
                    planToScheme.put(pid, s);
                }
            }

            // 1. 已切割区域 (Cut Zones) — 来自所有有效实切回执（按母卷索引按需读取）
            List<Map<String, Object>> cutZones = new ArrayList<>();
            for (Map<String, Object> rawReceipt : tx.findCutReportsByRollId(rollId)) {
                if ("REVERSED".equals(rawReceipt.get("status"))) continue;
                if (!"roll".equals(rawReceipt.get("feedPortType")) || !rollId.equals(rawReceipt.get("rollId"))) continue;
                Map<String, Object> projected = tx.projectQuality(rawReceipt);
                String pid = Objects.toString(rawReceipt.get("planId"), "");
                String tid = Objects.toString(rawReceipt.get("taskId"), "");
                CuttingTask task = tx.findTask(tid).orElse(null);
                CuttingPlan plan = tx.findPlan(pid).orElse(null);
                SchedulingScheme scheme = planToScheme.get(pid);

                double startY = rawReceipt.get("windowStartY") instanceof Number n ? n.doubleValue() : 0;
                double len = rawReceipt.get("actualCutLen") instanceof Number n ? n.doubleValue() : 0;
                double endY = startY + len;

                List<String> derivedIds = new ArrayList<>();
                if (rawReceipt.get("derivedRemnants") instanceof List<?> drs) {
                    for (Object dr : drs) {
                        if (dr instanceof Map<?, ?> m && m.get("id") != null) derivedIds.add(m.get("id").toString());
                        else if (dr instanceof RemnantStock rs) derivedIds.add(rs.getId());
                    }
                }

                Map<String, Object> zone = new LinkedHashMap<>();
                zone.put("kind", "CUT_ZONE");
                zone.put("planId", pid);
                zone.put("schemeId", scheme != null ? scheme.id() : null);
                zone.put("title", scheme != null ? scheme.title() : (task != null ? task.name() : "历史实切工位"));
                zone.put("taskId", tid);
                zone.put("taskName", task != null ? task.name() : "独立裁切");
                zone.put("startY", round1(startY));
                zone.put("lengthMm", round1(len));
                zone.put("endY", round1(endY));
                zone.put("confirmedAt", rawReceipt.get("confirmedAt"));
                zone.put("pieceCount", projected.getOrDefault("netFinishedPieceCount", rawReceipt.getOrDefault("finishedPieceCount", 0)));
                zone.put("netUtilizationPct", projected.get("netUtilization") instanceof Number u ? round2(u.doubleValue()) : 0);
                zone.put("derivedRemnantIds", derivedIds);
                zone.put("pieces", plan != null && plan.result() != null ? plan.result().getPieces() : List.of());
                cutZones.add(zone);
            }
            cutZones.sort(Comparator.comparingDouble(z -> ((Number) z.get("startY")).doubleValue()));

            double maxCutEnd = cutZones.stream().mapToDouble(z -> ((Number) z.get("endY")).doubleValue()).max().orElse(0);
            if (roll.getUsedLength() > maxCutEnd + 1.0 && cutZones.isEmpty()) {
                Map<String, Object> openingCut = new LinkedHashMap<>();
                openingCut.put("kind", "OPENING_USED_ZONE");
                openingCut.put("planId", "OPENING-" + rollId);
                openingCut.put("schemeId", null);
                openingCut.put("title", "入档期初已裁切区段");
                openingCut.put("taskId", null);
                openingCut.put("taskName", "期初历史耗用");
                openingCut.put("startY", 0.0);
                openingCut.put("lengthMm", round1(roll.getUsedLength()));
                openingCut.put("endY", round1(roll.getUsedLength()));
                openingCut.put("confirmedAt", roll.getCreatedAt());
                openingCut.put("pieceCount", 0);
                openingCut.put("netUtilizationPct", null);
                openingCut.put("derivedRemnantIds", List.of());
                openingCut.put("pieces", List.of());
                cutZones.add(0, openingCut);
            }

            // 2. 排程预占区域 (Planned Zones)
            List<Map<String, Object>> plannedZones = new ArrayList<>();
            Set<String> coveredPlanIds = new HashSet<>();
            for (SchedulingScheme s : allSchemes) {
                if (!s.occupiesRoll(rollId)) continue;
                coveredPlanIds.addAll(s.linkedPlanIds());
                List<PlacedPiece> previewPieces = new ArrayList<>();
                if (!s.linkedPlanIds().isEmpty()) {
                    CuttingPlan firstPlan = tx.findPlan(s.linkedPlanIds().get(0)).orElse(null);
                    if (firstPlan != null && firstPlan.result() != null && firstPlan.result().getPieces() != null) {
                        previewPieces = firstPlan.result().getPieces();
                    }
                }
                Map<String, Object> pz = new LinkedHashMap<>();
                pz.put("kind", "PLANNED_ZONE");
                pz.put("schemeId", s.id());
                pz.put("planId", s.linkedPlanIds().isEmpty() ? null : s.linkedPlanIds().get(0));
                pz.put("title", s.title());
                pz.put("taskId", s.taskId());
                pz.put("taskName", s.taskName());
                pz.put("state", s.state());
                pz.put("startY", round1(s.windowStartY()));
                pz.put("lengthMm", round1(s.occupiedLengthMm()));
                pz.put("endY", round1(s.windowStartY() + s.occupiedLengthMm()));
                pz.put("pieceCount", s.placedCount());
                pz.put("utilizationPct", s.utilizationPct());
                pz.put("pieces", previewPieces);
                plannedZones.add(pz);
            }
            for (CuttingPlan p : tx.listPlans()) {
                if (!"PENDING".equals(p.status()) || coveredPlanIds.contains(p.id())) continue;
                if (!"roll".equals(p.request().getFeedPortType()) || !rollId.equals(p.request().getRollId())) continue;
                double startY = p.request().getWindowStartY();
                double len = p.result().getDeductLen() > 0 ? p.result().getDeductLen() : p.request().getRollL();
                CuttingTask t = p.request().getTaskId() != null ? tx.findTask(p.request().getTaskId()).orElse(null) : null;
                Map<String, Object> pz = new LinkedHashMap<>();
                pz.put("kind", "PLANNED_ZONE");
                pz.put("schemeId", null);
                pz.put("planId", p.id());
                pz.put("title", t != null ? t.name() : "待报工候选工位");
                pz.put("taskId", p.request().getTaskId());
                pz.put("taskName", t != null ? t.name() : "候选工位");
                pz.put("state", "PENDING");
                pz.put("startY", round1(startY));
                pz.put("lengthMm", round1(len));
                pz.put("endY", round1(startY + len));
                pz.put("pieceCount", p.result().getPieces() != null ? p.result().getPieces().size() : 0);
                pz.put("utilizationPct", p.result().getTotalArea() > 0 ? round2(p.result().getPieceArea() / p.result().getTotalArea() * 100) : 0);
                pz.put("pieces", p.result().getPieces() != null ? p.result().getPieces() : List.of());
                plannedZones.add(pz);
            }
            plannedZones.sort(Comparator.comparingDouble(z -> ((Number) z.get("startY")).doubleValue()));

            // 3. 计算剩余可用净区段 (Clean Available Spans)
            List<double[]> occupiedIntervals = new ArrayList<>();
            if (roll.getUsedLength() > 0) {
                occupiedIntervals.add(new double[]{0, roll.getUsedLength()});
            }
            for (Map<String, Object> cz : cutZones) {
                occupiedIntervals.add(new double[]{((Number) cz.get("startY")).doubleValue(), ((Number) cz.get("endY")).doubleValue()});
            }
            for (Map<String, Object> pz : plannedZones) {
                occupiedIntervals.add(new double[]{((Number) pz.get("startY")).doubleValue(), ((Number) pz.get("endY")).doubleValue()});
            }
            occupiedIntervals.sort(Comparator.comparingDouble(a -> a[0]));

            List<Map<String, Object>> cleanSpans = new ArrayList<>();
            double cursor = roll.getUsedLength();
            for (double[] iv : occupiedIntervals) {
                if (iv[1] <= cursor + 0.1) continue;
                if (iv[0] > cursor + 1.0) {
                    cleanSpans.add(buildCleanSpan(roll, cursor, iv[0]));
                }
                cursor = Math.max(cursor, iv[1]);
            }
            if (roll.getTotalLength() > cursor + 1.0) {
                cleanSpans.add(buildCleanSpan(roll, cursor, roll.getTotalLength()));
            }

            // 4. 名下全部派生料头
            List<RemnantStock> linkedRemnants = tx.listRemnantsBySourceRoll(rollId).stream()
                    .sorted(Comparator.comparing((RemnantStock rm) -> !"AVAILABLE".equals(rm.getStatus()))
                            .thenComparing(RemnantStock::getId))
                    .toList();

            double plannedTotalMm = plannedZones.stream().mapToDouble(z -> ((Number) z.get("lengthMm")).doubleValue()).sum();
            double netUnplannedMm = Math.max(0, roll.getCurrentRemainingLength() - plannedTotalMm);

            Map<String, Object> map = new LinkedHashMap<>();
            map.put("roll", roll);
            map.put("cutZones", cutZones);
            map.put("plannedZones", plannedZones);
            map.put("cleanSpans", cleanSpans);
            map.put("defects", roll.getDefects() != null ? roll.getDefects() : List.of());
            map.put("voidedDefects", roll.getVoidedDefects() != null ? roll.getVoidedDefects() : List.of());
            map.put("remnants", linkedRemnants);
            map.put("summary", Map.of(
                    "totalLengthMm", roll.getTotalLength(),
                    "usedLengthMm", roll.getUsedLength(),
                    "plannedLengthMm", round1(plannedTotalMm),
                    "remainingBookLengthMm", roll.getCurrentRemainingLength(),
                    "netAvailableToPlanMm", round1(netUnplannedMm),
                    "defectCount", roll.getDefects() != null ? roll.getDefects().size() : 0,
                    "availableRemnantCount", linkedRemnants.stream().filter(r -> "AVAILABLE".equals(r.getStatus())).count()
            ));
            return map;
        });
    }

    private Map<String, Object> buildCleanSpan(MotherRollInfo roll, double startY, double endY) {
        long defsInSpan = (roll.getDefects() == null ? List.<Defect>of() : roll.getDefects()).stream()
                .filter(d -> d.getY() < endY && d.getY() + d.getH() > startY)
                .count();
        Map<String, Object> span = new LinkedHashMap<>();
        span.put("startY", round1(startY));
        span.put("endY", round1(endY));
        span.put("lengthMm", round1(endY - startY));
        span.put("defectCount", defsInSpan);
        return span;
    }

    private static double round1(double v) {
        return Math.rint(v * 10.0) / 10.0;
    }

    private static double round2(double v) {
        return Math.rint(v * 100.0) / 100.0;
    }
}
