package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.persistence.InventoryConflictException;

import java.util.*;
import java.util.function.BiPredicate;

/**
 * 母卷区间互斥校验、车次起始区段探测与 1D 分切槽位匹配辅助类。
 */
final class StudioRollSlotAllocator {

    record SlittingSlot(String taskId, CuttingTask.Line line, int localDemandId) {}

    private StudioRollSlotAllocator() {}

    static void assertRollIntervalFree(
            CuttingStatePort.ReadView tx,
            MotherRollInfo roll,
            double startY,
            double lengthMm,
            String exceptSchemeId
    ) {
        if (!Double.isFinite(startY) || startY < 0) {
            throw new IllegalArgumentException("母卷起切位置无效: " + startY);
        }
        if (startY < roll.getUsedLength() - 0.001) {
            throw new InventoryConflictException("起切位置 Y=" + round1(startY) + "mm 落入母卷 " + roll.getRollId()
                    + " 已切割区域 [0, " + round1(roll.getUsedLength()) + "mm]");
        }
        double endY = startY + lengthMm;
        if (endY > roll.getTotalLength() + 0.001) {
            throw new IllegalArgumentException("母卷 " + roll.getRollId() + " 剩余连续可用长度不足（需 " + round1(lengthMm)
                    + " mm，起切位置 Y=" + round1(startY) + " mm，总长 " + round1(roll.getTotalLength()) + " mm）");
        }
        for (Map<String, Object> r : tx.listReceipts()) {
            if ("REVERSED".equals(r.get("status")) || !"roll".equals(r.get("feedPortType")) || !roll.getRollId().equals(r.get("rollId"))) {
                continue;
            }
            double s = ((Number) r.get("windowStartY")).doubleValue();
            double e = s + ((Number) r.get("actualCutLen")).doubleValue();
            if (Math.min(endY, e) - Math.max(startY, s) > 0.001) {
                throw new InventoryConflictException("母卷 " + roll.getRollId() + " 区间 [" + round1(startY) + ", " + round1(endY)
                        + "mm] 与已报工切割区 [" + round1(s) + ", " + round1(e) + "mm] 重叠");
            }
        }
        for (SchedulingScheme sc : tx.listSchemes()) {
            if (Objects.equals(exceptSchemeId, sc.id()) || !sc.occupiesRoll(roll.getRollId())) {
                continue;
            }
            double s = sc.windowStartY();
            double e = s + sc.occupiedLengthMm();
            if (Math.min(endY, e) - Math.max(startY, s) > 0.001) {
                throw new InventoryConflictException("母卷 " + roll.getRollId() + " 区间 [" + round1(startY) + ", " + round1(endY)
                        + "mm] 与活跃排程方案 " + sc.id() + " 预占区 [" + round1(s) + ", " + round1(e) + "mm] 重叠");
            }
        }
    }

    static double findAvailableCarStart(
            CuttingStatePort.ReadView tx,
            MotherRollInfo roll,
            double fromY,
            double carLen,
            List<PlacedPiece> strips,
            boolean avoidDefects,
            String exceptSchemeId,
            List<double[]> allocatedCarIntervals
    ) {
        double y = fromY;
        List<double[]> blocked = collectRollOccupiedIntervals(tx, roll, exceptSchemeId);
        blocked.addAll(allocatedCarIntervals);
        blocked.sort(Comparator.comparingDouble(a -> a[0]));

        List<Defect> defs = (avoidDefects && roll.getDefects() != null) ? roll.getDefects() : List.of();
        for (int guard = 0; guard < 300 && y + carLen <= roll.getTotalLength() + 0.001; guard++) {
            double candidateY = y;
            double candidateEnd = candidateY + carLen;

            // 先跳过与其他方案/报工/已排车次重叠的区间
            double[] overlap = blocked.stream()
                    .filter(iv -> Math.min(candidateEnd, iv[1]) - Math.max(candidateY, iv[0]) > 0.001)
                    .findFirst().orElse(null);
            if (overlap != null) {
                y = Math.max(y + 10, overlap[1]);
                continue;
            }

            // 再跳过与本车分切条冲突的 MUST_AVOID 疵点
            Defect hit = defs.stream().filter(d -> {
                if ("PENETRABLE".equalsIgnoreCase(d.getAvoidanceStrategy())) return false;
                double m = d.getMargin();
                double dx0 = Math.max(0, d.getX() - m), dx1 = Math.min(roll.getWidth(), d.getX() + d.getW() + m);
                double dy0 = Math.max(0, d.getY() - m), dy1 = Math.min(roll.getTotalLength(), d.getY() + d.getH() + m);
                if (dy1 <= candidateY + 0.001 || dy0 >= candidateEnd - 0.001) return false;
                return strips.stream().anyMatch(s -> s.getX() + s.getW() > dx0 + 0.001 && s.getX() < dx1 - 0.001);
            }).findFirst().orElse(null);
            if (hit == null) return candidateY;
            y = Math.max(y + 10, hit.getY() + hit.getH() + hit.getMargin());
        }
        return y;
    }

    static List<double[]> collectRollOccupiedIntervals(CuttingStatePort.ReadView tx, MotherRollInfo roll, String exceptSchemeId) {
        List<double[]> intervals = new ArrayList<>();
        if (roll.getUsedLength() > 0) intervals.add(new double[]{0, roll.getUsedLength()});
        for (Map<String, Object> r : tx.listReceipts()) {
            if (!"REVERSED".equals(r.get("status")) && "roll".equals(r.get("feedPortType")) && roll.getRollId().equals(r.get("rollId"))) {
                double s = ((Number) r.get("windowStartY")).doubleValue();
                double l = ((Number) r.get("actualCutLen")).doubleValue();
                intervals.add(new double[]{s, s + l});
            }
        }
        for (SchedulingScheme sc : tx.listSchemes()) {
            if (!Objects.equals(exceptSchemeId, sc.id()) && sc.occupiesRoll(roll.getRollId())) {
                intervals.add(new double[]{sc.windowStartY(), sc.windowStartY() + sc.occupiedLengthMm()});
            }
        }
        return intervals;
    }

    static double nextAvailableRollStart(CuttingStatePort.ReadView tx, MotherRollInfo roll, double neededLen, String exceptSchemeId) {
        List<double[]> intervals = collectRollOccupiedIntervals(tx, roll, exceptSchemeId);
        intervals.sort(Comparator.comparingDouble(a -> a[0]));
        double cursor = roll.getUsedLength();
        for (double[] iv : intervals) {
            if (iv[1] <= cursor + 0.001) continue;
            if (iv[0] - cursor >= neededLen - 0.001) return cursor;
            cursor = Math.max(cursor, iv[1]);
        }
        return cursor;
    }

    static SlittingSlot resolveSlotForOrderId(
            Map<String, SlittingSlot> slotsByKey,
            String primaryTaskId,
            String orderId,
            int fallbackWidthMm,
            String surfaceTreatment,
            Map<String, Integer> remaining
    ) {
        if (orderId != null && !orderId.isBlank()) {
            String clean = orderId.trim();
            if (slotsByKey.containsKey(clean)) return slotsByKey.get(clean);
            String withPrimary = primaryTaskId + ":" + clean;
            if (slotsByKey.containsKey(withPrimary)) return slotsByKey.get(withPrimary);
            // 兼容跨任务合排时算法用 localDemandId（1-based 数字）作为 orderId 的情况
            try {
                int numericId = Integer.parseInt(clean);
                for (SlittingSlot slot : slotsByKey.values()) {
                    if (slot.localDemandId() == numericId) return slot;
                }
            } catch (NumberFormatException ignored) {
                // 非数字 orderId，继续按宽度兜底
            }
        }
        if (fallbackWidthMm > 0) {
            return pickByPredicate(slotsByKey, (k, slot) -> matchesSlittingSlot(slot, fallbackWidthMm, surfaceTreatment), remaining);
        }
        return null;
    }

    static SlittingSlot pickSlittingSlot(
            Map<String, SlittingSlot> rawSlots,
            int widthMm,
            String surfaceTreatment,
            Map<String, Integer> patternAllocQuota,
            Map<String, Integer> fulfillmentRemaining,
            Map<String, Integer> globalRemaining
    ) {
        // 先尝试带明确 patternAllocQuota 的精确配额分配
        if (patternAllocQuota != null) {
            return pickByPredicate(rawSlots, (key, slot) ->
                    patternAllocQuota.getOrDefault(key, 0) > 0 && matchesSlittingSlot(slot, widthMm, surfaceTreatment),
                    patternAllocQuota);
        }
        // 次选 fulfillmentRemaining 中仍有配额且表面处理与宽度匹配的行
        if (!fulfillmentRemaining.isEmpty()) {
            SlittingSlot hit = pickByPredicate(rawSlots, (key, slot) ->
                    fulfillmentRemaining.getOrDefault(key, 0) > 0 && matchesSlittingSlot(slot, widthMm, surfaceTreatment),
                    fulfillmentRemaining);
            if (hit != null) return hit;
        }
        // 最后在同表面处理同宽度有剩余需求的行中匹配
        return pickByPredicate(rawSlots, (key, slot) ->
                globalRemaining.getOrDefault(key, 0) > 0 && matchesSlittingSlot(slot, widthMm, surfaceTreatment),
                globalRemaining);
    }

    private static SlittingSlot pickByPredicate(
            Map<String, SlittingSlot> map,
            BiPredicate<String, SlittingSlot> pred,
            Map<String, Integer> score
    ) {
        SlittingSlot best = null;
        int bestScore = Integer.MIN_VALUE;
        for (Map.Entry<String, SlittingSlot> e : map.entrySet()) {
            if (!pred.test(e.getKey(), e.getValue())) continue;
            int sc = score == null ? 0 : score.getOrDefault(e.getKey(), 0);
            if (sc > bestScore) {
                bestScore = sc;
                best = e.getValue();
            }
        }
        return best;
    }

    private static boolean matchesSlittingSlot(SlittingSlot slot, int widthMm, String surfaceTreatment) {
        CuttingTask.Line line = slot.line();
        if (Math.abs(line.width() - widthMm) >= 0.5) return false;
        if (surfaceTreatment != null && !surfaceTreatment.isBlank()
                && line.surfaceTreatment() != null && !line.surfaceTreatment().isBlank()) {
            return surfaceTreatment.trim().equalsIgnoreCase(line.surfaceTreatment().trim());
        }
        return true;
    }

    private static double round1(double v) {
        return Math.rint(v * 10.0) / 10.0;
    }
}
