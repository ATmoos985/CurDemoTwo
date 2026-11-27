package com.example.cutdemotwo.business.cutting;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 多母卷连续接力规划辅助类（纯单向被 {@link GlobalPlanningService} 调用，绝不反向引用调用方类）：
 * 按贪心最优轮次逐卷试排剩余需求，每采纳一卷即真实扣减剩余需求并移除已用母卷。
 */
final class MultiMaterialRollRelayHelper {

    record RelayTrial<T>(
            T payload,
            String rollId,
            boolean feasible,
            int placedCount,
            double estimatedConsumedAreaMm2,
            double utilizationPct,
            List<Integer> placedDemandIds
    ) {}

    record RelayEntry<T>(
            T payload,
            String rollId,
            boolean recommended,
            Integer relayOrder,
            Map<Integer, Integer> allocatedCounts
    ) {}

    record RelayOutcome<T>(
            int placedByRoll,
            List<RelayEntry<T>> entries
    ) {}

    @FunctionalInterface
    interface RoundEvaluator<R, T> {
        RelayTrial<T> evaluate(R roll, Map<Integer, Integer> remainingQty, int activeTotal, int perRollSec);
    }

    private MultiMaterialRollRelayHelper() {}

    static <R, T> RelayOutcome<T> planAcrossRolls(
            List<R> candidateRolls,
            java.util.function.Function<R, String> rollIdExtractor,
            Map<Integer, Integer> remainingQty,
            long deadlineNanos,
            List<String> warnings,
            RoundEvaluator<R, T> evaluator
    ) {
        Comparator<RelayTrial<T>> comparator = Comparator
                .<RelayTrial<T>, Boolean>comparing(RelayTrial::feasible).reversed()
                .thenComparing(Comparator.<RelayTrial<T>>comparingInt(RelayTrial::placedCount).reversed())
                .thenComparingDouble(RelayTrial::estimatedConsumedAreaMm2)
                .thenComparing(Comparator.<RelayTrial<T>>comparingDouble(RelayTrial::utilizationPct).reversed())
                .thenComparing(RelayTrial::rollId);

        List<R> remainingPool = new ArrayList<>(candidateRolls);
        List<RelayEntry<T>> accepted = new ArrayList<>();
        Map<String, RelayEntry<T>> fallbacks = new LinkedHashMap<>();

        int placedByRoll = 0;
        int relayOrder = 1;

        while (sumValues(remainingQty) > 0 && !remainingPool.isEmpty()) {
            if (relayOrder > 1 && System.nanoTime() >= deadlineNanos) {
                warnings.add("多母卷连续接力已达总时间预算上限，部分剩余需求未继续接力试排");
                break;
            }
            int activeTotal = sumValues(remainingQty);
            if (activeTotal <= 0) {
                break;
            }

            List<RelayTrial<T>> roundTrials = new ArrayList<>();
            for (R roll : remainingPool) {
                if (!roundTrials.isEmpty() && System.nanoTime() >= deadlineNanos) {
                    break;
                }
                long leftMs = Math.max(500L, (deadlineNanos - System.nanoTime()) / 1_000_000L);
                int perRollSec = Math.max(1, (int) Math.min(2L, (leftMs + 999L) / 1000L));
                roundTrials.add(evaluator.evaluate(roll, Map.copyOf(remainingQty), activeTotal, perRollSec));
            }
            if (roundTrials.isEmpty()) {
                break;
            }

            roundTrials.sort(comparator);
            RelayTrial<T> winner = roundTrials.get(0);
            if (winner.placedCount() <= 0 || winner.placedDemandIds() == null || winner.placedDemandIds().isEmpty()) {
                for (RelayTrial<T> alt : roundTrials) {
                    fallbacks.putIfAbsent(alt.rollId(), new RelayEntry<>(alt.payload(), alt.rollId(), false, null, null));
                }
                break;
            }

            Map<Integer, Integer> placedMap = new LinkedHashMap<>();
            for (Integer demandId : winner.placedDemandIds()) {
                if (demandId == null) continue;
                int remLeft = remainingQty.getOrDefault(demandId, 0);
                int cur = placedMap.getOrDefault(demandId, 0);
                if (cur < remLeft) {
                    placedMap.put(demandId, cur + 1);
                }
            }

            int actualPlaced = 0;
            for (Map.Entry<Integer, Integer> e : placedMap.entrySet()) {
                int qty = e.getValue();
                if (qty <= 0) continue;
                remainingQty.put(e.getKey(), Math.max(0, remainingQty.getOrDefault(e.getKey(), 0) - qty));
                actualPlaced += qty;
            }
            if (actualPlaced <= 0) {
                break;
            }

            accepted.add(new RelayEntry<>(
                    winner.payload(),
                    winner.rollId(),
                    true,
                    relayOrder++,
                    Map.copyOf(placedMap)
            ));
            placedByRoll += actualPlaced;

            String usedRollId = winner.rollId();
            remainingPool.removeIf(r -> usedRollId.equals(rollIdExtractor.apply(r)));
            for (int i = 1; i < roundTrials.size(); i++) {
                RelayTrial<T> alt = roundTrials.get(i);
                fallbacks.putIfAbsent(alt.rollId(), new RelayEntry<>(alt.payload(), alt.rollId(), false, null, null));
            }
        }

        List<RelayEntry<T>> combined = new ArrayList<>(accepted);
        for (RelayEntry<T> entry : accepted) {
            fallbacks.remove(entry.rollId());
        }
        combined.addAll(fallbacks.values());
        return new RelayOutcome<>(placedByRoll, List.copyOf(combined));
    }

    private static int sumValues(Map<?, Integer> map) {
        int s = 0;
        for (Integer v : map.values()) {
            if (v != null) s += v;
        }
        return s;
    }
}
