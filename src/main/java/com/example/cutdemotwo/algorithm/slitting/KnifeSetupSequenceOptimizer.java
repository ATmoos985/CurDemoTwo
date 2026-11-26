package com.example.cutdemotwo.algorithm.slitting;

import com.example.cutdemotwo.contracts.slitting.SlittingResult;

import java.util.*;

/**
 * 一维分切刀架换刀次数序列优化器。
 * 基于每车累计切刀坐标集合计算相邻两车的最少换刀/移刀次数，
 * 采用确定性多起点最近邻（Nearest Neighbor）+ 开路径 2-Opt 局部搜索重排车次序列，
 * 在不改变任何车次切条组合与履约的前提下最小化换刀总次数。
 */
public final class KnifeSetupSequenceOptimizer {
    private static final int MAX_MULTI_START = 32;

    private KnifeSetupSequenceOptimizer() {}

    /** 换刀排序结果：包含重排后的刀组序列及预计换刀总次数/节省次数。 */
    public record OptimizationOutcome(
            List<SlittingResult.Pattern> orderedPatterns,
            int originalKnifeChanges,
            int estimatedKnifeChanges,
            int knifeChangesSaved
    ) {
        public OptimizationOutcome {
            orderedPatterns = List.copyOf(orderedPatterns);
        }
    }

    public static OptimizationOutcome optimize(List<SlittingResult.Pattern> patterns) {
        return optimize(patterns, 0, 0);
    }

    public static OptimizationOutcome optimize(List<SlittingResult.Pattern> patterns, int leftTrimMm, int kerfMm) {
        if (patterns == null || patterns.isEmpty()) {
            return new OptimizationOutcome(List.of(), 0, 0, 0);
        }
        int n = patterns.size();
        if (n == 1) {
            return new OptimizationOutcome(patterns, 0, 0, 0);
        }

        List<Set<Integer>> knifeSets = new ArrayList<>(n);
        for (SlittingResult.Pattern pattern : patterns) {
            knifeSets.add(knifePositions(pattern, leftTrimMm, kerfMm));
        }

        int[][] dist = new int[n][n];
        for (int i = 0; i < n; i++) {
            for (int j = i + 1; j < n; j++) {
                int cost = transitionCost(knifeSets.get(i), knifeSets.get(j));
                dist[i][j] = cost;
                dist[j][i] = cost;
            }
        }

        int[] originalOrder = new int[n];
        for (int i = 0; i < n; i++) {
            originalOrder[i] = i;
        }
        int originalCost = pathCost(originalOrder, dist);

        // 两车之间代价对称，交换顺序不会降低换刀次数，保持原序。
        if (n == 2 || originalCost == 0) {
            return new OptimizationOutcome(patterns, originalCost, originalCost, 0);
        }

        int[] bestOrder = originalOrder.clone();
        int bestCost = originalCost;

        // 先对原序直接做一次 2-Opt，再结合多起点最近邻 + 2-Opt，保证结果绝不劣于原序且 100% 确定性。
        int[] fromOriginal = originalOrder.clone();
        int fromOriginalCost = improveWithTwoOpt(fromOriginal, dist, originalCost);
        if (fromOriginalCost < bestCost) {
            bestCost = fromOriginalCost;
            bestOrder = fromOriginal;
        }

        int[] starts = selectDeterministicStarts(n);
        for (int start : starts) {
            int[] candidate = nearestNeighborPath(start, dist);
            int candidateCost = pathCost(candidate, dist);
            candidateCost = improveWithTwoOpt(candidate, dist, candidateCost);
            if (candidateCost < bestCost) {
                bestCost = candidateCost;
                bestOrder = candidate;
                if (bestCost == 0) {
                    break;
                }
            }
        }

        if (bestCost >= originalCost) {
            return new OptimizationOutcome(patterns, originalCost, originalCost, 0);
        }

        List<SlittingResult.Pattern> reordered = new ArrayList<>(n);
        for (int idx : bestOrder) {
            reordered.add(patterns.get(idx));
        }
        return new OptimizationOutcome(reordered, originalCost, bestCost, originalCost - bestCost);
    }

    /**
     * 计算单车分切的累计切刀位置集合（单位 mm，从母卷左基准边 0 起算）。
     * 工位按宽幅升序确定性展开，左切边（>0）与每条切条的右切分界均记为刀位坐标。
     */
    public static Set<Integer> knifePositions(SlittingResult.Pattern pattern, int leftTrimMm, int kerfMm) {
        if (pattern == null || pattern.stations().isEmpty()) {
            return Set.of();
        }
        int safeLeftTrim = Math.max(0, leftTrimMm);
        int safeKerf = Math.max(0, kerfMm);

        List<SlittingResult.Station> sortedStations = new ArrayList<>(pattern.stations());
        sortedStations.sort(Comparator.comparingInt(SlittingResult.Station::widthMm));

        int totalStrips = 0;
        for (SlittingResult.Station s : sortedStations) {
            totalStrips += s.countPerRepetition();
        }

        Set<Integer> positions = new LinkedHashSet<>();
        int cursor = safeLeftTrim;
        if (safeLeftTrim > 0) {
            positions.add(safeLeftTrim);
        }
        int stripIdx = 0;
        for (SlittingResult.Station station : sortedStations) {
            for (int c = 0; c < station.countPerRepetition(); c++) {
                cursor += station.widthMm();
                positions.add(cursor);
                stripIdx++;
                if (stripIdx < totalStrips) {
                    cursor += safeKerf;
                }
            }
        }
        return Collections.unmodifiableSet(positions);
    }

    /**
     * 计算相邻两车之间的最少换刀/移刀操作次数：
     * 共有刀位保持不动，其余需移走旧刀或装入新刀，可滑动复用旧刀，故最少操作次数为 max(|A\B|, |B\A|)。
     * 该度量满足非负、对称性与三角不等式，适合 Open-TSP 与 2-Opt 反转增量更新。
     */
    public static int transitionCost(Set<Integer> from, Set<Integer> to) {
        if (from == null || from.isEmpty()) {
            return to == null ? 0 : to.size();
        }
        if (to == null || to.isEmpty()) {
            return from.size();
        }
        Set<Integer> smaller = from.size() <= to.size() ? from : to;
        Set<Integer> larger = from.size() <= to.size() ? to : from;
        int shared = 0;
        for (Integer pos : smaller) {
            if (larger.contains(pos)) {
                shared++;
            }
        }
        int removed = from.size() - shared;
        int added = to.size() - shared;
        return Math.max(removed, added);
    }

    private static int[] selectDeterministicStarts(int n) {
        if (n <= MAX_MULTI_START) {
            int[] starts = new int[n];
            for (int i = 0; i < n; i++) {
                starts[i] = i;
            }
            return starts;
        }
        int[] starts = new int[MAX_MULTI_START];
        for (int k = 0; k < MAX_MULTI_START; k++) {
            starts[k] = (int) ((long) k * (n - 1) / (MAX_MULTI_START - 1));
        }
        return starts;
    }

    private static int[] nearestNeighborPath(int start, int[][] dist) {
        int n = dist.length;
        int[] order = new int[n];
        boolean[] visited = new boolean[n];
        order[0] = start;
        visited[start] = true;
        int current = start;
        for (int step = 1; step < n; step++) {
            int bestNext = -1;
            int bestEdge = Integer.MAX_VALUE;
            for (int candidate = 0; candidate < n; candidate++) {
                if (!visited[candidate]) {
                    int edge = dist[current][candidate];
                    if (edge < bestEdge) {
                        bestEdge = edge;
                        bestNext = candidate;
                    }
                }
            }
            order[step] = bestNext;
            visited[bestNext] = true;
            current = bestNext;
        }
        return order;
    }

    /**
     * 开路径 2-Opt 局部搜索（对称距离矩阵下反转子区间 [i..j] 仅改变两端至多 2 条衔接边）。
     */
    private static int improveWithTwoOpt(int[] order, int[][] dist, int initialCost) {
        int n = order.length;
        int currentCost = initialCost;
        int maxPasses = Math.max(8, n * 4);
        for (int pass = 0; pass < maxPasses; pass++) {
            boolean improved = false;
            for (int i = 0; i < n - 1; i++) {
                for (int j = i + 1; j < n; j++) {
                    if (i == 0 && j == n - 1) {
                        // 反转整条路径在对称距离矩阵下代价不变，跳过。
                        continue;
                    }
                    int before = 0;
                    int after = 0;
                    if (i > 0) {
                        before += dist[order[i - 1]][order[i]];
                        after += dist[order[i - 1]][order[j]];
                    }
                    if (j + 1 < n) {
                        before += dist[order[j]][order[j + 1]];
                        after += dist[order[i]][order[j + 1]];
                    }
                    if (after < before) {
                        reverseRange(order, i, j);
                        currentCost -= (before - after);
                        improved = true;
                    }
                }
            }
            if (!improved || currentCost == 0) {
                break;
            }
        }
        return currentCost;
    }

    private static void reverseRange(int[] arr, int left, int right) {
        int l = left;
        int r = right;
        while (l < r) {
            int tmp = arr[l];
            arr[l] = arr[r];
            arr[r] = tmp;
            l++;
            r--;
        }
    }

    private static int pathCost(int[] order, int[][] dist) {
        int total = 0;
        for (int i = 0; i < order.length - 1; i++) {
            total += dist[order[i]][order[i + 1]];
        }
        return total;
    }
}
