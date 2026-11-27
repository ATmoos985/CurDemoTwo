package changyang.cut.apsmodule.generator.NewSolver.mip;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Collectors;

import changyang.cut.apsmodule.generator.NewSolver.mip.UnifiedSetPartitionSolver.Column;
import changyang.cut.apsmodule.generator.NewSolver.mip.UnifiedSetPartitionSolver.ColumnUse;

/**
 * 统一 set-partition 的贪心热启动与结构化列生成。
 */
final class StructuredColumnGenerator {

    private static final Logger log = LoggerFactory.getLogger(StructuredColumnGenerator.class);

    private StructuredColumnGenerator() {
    }

    static List<ColumnUse> greedyAlignedWarmStart(List<Column> pool, Map<String, Integer> demand) {
        return greedyAlignedWarmStart(pool, demand, Integer.MAX_VALUE, Integer.MAX_VALUE, 0);
    }

    static List<ColumnUse> greedyAlignedWarmStart(List<Column> pool, Map<String, Integer> demand,
            int exactCars, int wasteCap, int totalWidth) {
        int maxPw = pool.stream().mapToInt(Column::patternWidth).max().orElse(totalWidth);
        int minWastePerCar = Math.max(0, totalWidth - maxPw);
        Map<String, Integer> remaining = new LinkedHashMap<>(demand);
        List<ColumnUse> uses = new ArrayList<>();
        int usedCars = 0;
        int usedWaste = 0;
        while (remaining.values().stream().anyMatch(v -> v > 0) && usedCars < exactCars) {
            Column best = null;
            int bestCount = 0;
            long bestKey = -1;
            for (Column column : pool) {
                int count = Math.min(UnifiedSetPartitionSolver.supportOf(column, remaining), exactCars - usedCars);
                if (count < 1) {
                    continue;
                }
                int wastePerCar = Math.max(0, totalWidth - column.patternWidth());
                // 废边走廊：取 c 后，剩余 (exactCars-usedCars-c) 车即使全用最高pw也要能装下
                if (wastePerCar > minWastePerCar && wasteCap != Integer.MAX_VALUE) {
                    long budget = (long) wasteCap - usedWaste - (long) (exactCars - usedCars) * minWastePerCar;
                    int cFeasible = (int) (budget / (wastePerCar - minWastePerCar));
                    count = Math.min(count, cFeasible);
                    if (count < 1) {
                        continue;
                    }
                }
                int exhaust = 0;
                for (Map.Entry<String, Integer> e : column.demandUse().entrySet()) {
                    if (remaining.getOrDefault(e.getKey(), 0) == count * e.getValue()) {
                        exhaust++;
                    }
                }
                // 排序：同时耗尽数 → 单车废边小（pw 高）→ c 偶 → c 大
                long key = ((long) exhaust << 44)
                        | ((long) Math.max(0, 2047 - wastePerCar) << 33)
                        | ((count % 2 == 0 ? 1L : 0L) << 32)
                        | count;
                if (key > bestKey) {
                    bestKey = key;
                    best = column;
                    bestCount = count;
                }
            }
            if (best == null) {
                break;
            }
            uses.add(new ColumnUse(best, bestCount));
            usedCars += bestCount;
            usedWaste += bestCount * Math.max(0, totalWidth - best.patternWidth());
            for (Map.Entry<String, Integer> e : best.demandUse().entrySet()) {
                remaining.merge(e.getKey(), -bestCount * e.getValue(), Integer::sum);
            }
        }
        int leftover = remaining.values().stream().filter(v -> v > 0).mapToInt(Integer::intValue).sum();
        log.info("greedyAlignedWarmStart: columns={} cars={} waste={} oddBlocks={} leftoverRolls={}",
                uses.size(), usedCars, usedWaste,
                uses.stream().filter(u -> u.count() % 2 != 0).count(),
                leftover);
        return uses;
    }

    static List<Column> structuredColumns(Collection<Map<Integer, Integer>> patterns,
            Map<Integer, Map<String, Integer>> demandByWidth,
            int maxMessagesPerWidth,
            int maxOptionsPerWidth,
            int maxConfigsPerPattern) {
        Set<String> seenPatterns = new LinkedHashSet<>();
        List<Column> result = new ArrayList<>();
        for (Map<Integer, Integer> pattern : patterns) {
            String patternSig = new TreeMap<>(pattern).toString();
            if (!seenPatterns.add(patternSig)) {
                continue;
            }
            List<Integer> widths = new ArrayList<>(new TreeMap<>(pattern).keySet());
            List<List<List<String>>> optionsByWidth = new ArrayList<>();
            boolean feasible = true;
            for (int width : widths) {
                int slots = pattern.get(width);
                List<List<String>> options = widthOptions(
                        demandByWidth.getOrDefault(width, Map.of()),
                        slots, maxMessagesPerWidth, maxOptionsPerWidth);
                if (options.isEmpty()) {
                    feasible = false;
                    break;
                }
                optionsByWidth.add(options);
            }
            if (!feasible) {
                continue;
            }
            List<Map<Integer, List<String>>> configs = new ArrayList<>();
            crossProduct(widths, optionsByWidth, 0, new LinkedHashMap<>(), configs,
                    maxConfigsPerPattern);
            for (Map<Integer, List<String>> config : configs) {
                result.add(Column.of(pattern, config));
            }
        }
        return result;
    }

    static List<List<String>> widthOptions(Map<String, Integer> demandByMessage,
            int slots, int bufferCount, int maxOptions) {
        List<Map.Entry<String, Integer>> messages = demandByMessage.entrySet().stream()
                .filter(e -> e.getValue() > 0)
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed()
                        .thenComparing(Map.Entry::getKey))
                .toList();
        if (messages.isEmpty()) {
            return List.of();
        }

        // option 候选 + 排序键（ratioMatched, evenC, support）
        record Ranked(List<String> option, boolean ratioMatched, boolean evenC, int support) {
        }
        Map<String, Ranked> bySig = new LinkedHashMap<>();
        java.util.function.BiConsumer<List<String>, Boolean> add = (option, ratioMatched) -> {
            List<String> sorted = new ArrayList<>(option);
            sorted.sort(String::compareTo);
            String sig = String.join(",", sorted);
            if (bySig.containsKey(sig)) {
                return;
            }
            Map<String, Long> mult = sorted.stream()
                    .collect(Collectors.groupingBy(m -> m, Collectors.counting()));
            int support = Integer.MAX_VALUE;
            for (Map.Entry<String, Long> e : mult.entrySet()) {
                support = Math.min(support,
                        demandByMessage.getOrDefault(e.getKey(), 0) / e.getValue().intValue());
            }
            if (support < 1) {
                return;
            }
            bySig.put(sig, new Ranked(List.copyOf(sorted), ratioMatched,
                    support % 2 == 0, support));
        };

        // 1) 纯列：每个序号独占全部工位
        for (Map.Entry<String, Integer> m : messages) {
            if (m.getValue() >= slots) {
                List<String> option = new ArrayList<>();
                for (int s = 0; s < slots; s++) {
                    option.add(m.getKey());
                }
                add.accept(option, true);
            }
        }
        // 2) 两分比例匹配：slots = p1 + p2，q1/p1 == q2/p2（整除）
        for (int p1 = slots - 1; p1 >= 1; p1--) {
            int p2 = slots - p1;
            if (p1 < p2) {
                break;
            }
            for (Map.Entry<String, Integer> m1 : messages) {
                if (m1.getValue() % p1 != 0) {
                    continue;
                }
                int c1 = m1.getValue() / p1;
                for (Map.Entry<String, Integer> m2 : messages) {
                    if (m2.getKey().equals(m1.getKey()) || m2.getValue() % p2 != 0
                            || m2.getValue() / p2 != c1) {
                        continue;
                    }
                    List<String> option = new ArrayList<>();
                    for (int s = 0; s < p1; s++) {
                        option.add(m1.getKey());
                    }
                    for (int s = 0; s < p2; s++) {
                        option.add(m2.getKey());
                    }
                    add.accept(option, true);
                }
            }
        }
        // 3) 三分比例匹配（slots≥3）：p1+p2+p3，q_i/p_i 全相等
        if (slots >= 3) {
            for (int p1 = slots - 2; p1 >= 1; p1--) {
                for (int p2 = Math.min(p1, slots - p1 - 1); p2 >= 1; p2--) {
                    int p3 = slots - p1 - p2;
                    if (p3 < 1 || p3 > p2) {
                        continue;
                    }
                    for (Map.Entry<String, Integer> m1 : messages) {
                        if (m1.getValue() % p1 != 0) {
                            continue;
                        }
                        int c1 = m1.getValue() / p1;
                        for (Map.Entry<String, Integer> m2 : messages) {
                            if (m2.getKey().equals(m1.getKey()) || m2.getValue() % p2 != 0
                                    || m2.getValue() / p2 != c1) {
                                continue;
                            }
                            for (Map.Entry<String, Integer> m3 : messages) {
                                if (m3.getKey().equals(m1.getKey()) || m3.getKey().equals(m2.getKey())
                                        || m3.getValue() % p3 != 0 || m3.getValue() / p3 != c1) {
                                    continue;
                                }
                                List<String> option = new ArrayList<>();
                                for (int s = 0; s < p1; s++) {
                                    option.add(m1.getKey());
                                }
                                for (int s = 0; s < p2; s++) {
                                    option.add(m2.getKey());
                                }
                                for (int s = 0; s < p3; s++) {
                                    option.add(m3.getKey());
                                }
                                add.accept(option, true);
                            }
                        }
                    }
                }
            }
        }
        // 4) 缓冲组合：最大量的 bufferCount 个序号做填缝剂，与任意搭档成列（无比例要求）
        List<Map.Entry<String, Integer>> buffers = messages.subList(0, Math.min(bufferCount, messages.size()));
        if (slots >= 2) {
            for (Map.Entry<String, Integer> buf : buffers) {
                for (Map.Entry<String, Integer> partner : messages) {
                    if (partner.getKey().equals(buf.getKey())) {
                        continue;
                    }
                    for (int pBuf = 1; pBuf < slots; pBuf++) {
                        List<String> option = new ArrayList<>();
                        for (int s = 0; s < pBuf; s++) {
                            option.add(buf.getKey());
                        }
                        for (int s = 0; s < slots - pBuf; s++) {
                            option.add(partner.getKey());
                        }
                        add.accept(option, false);
                    }
                }
            }
        }

        List<List<String>> ratioMatched = new ArrayList<>();
        List<List<String>> buffered = new ArrayList<>();
        bySig.values().stream()
                .sorted(Comparator
                        .comparing(Ranked::ratioMatched, Comparator.reverseOrder())
                        .thenComparing(Ranked::evenC, Comparator.reverseOrder())
                        .thenComparing(Comparator.comparingInt(Ranked::support).reversed())
                        .thenComparing(r -> String.join(",", r.option())))
                .forEach(r -> (r.ratioMatched() ? ratioMatched : buffered).add(r.option()));
        List<List<String>> result = new ArrayList<>(ratioMatched);
        for (List<String> option : buffered) {
            if (result.size() >= ratioMatched.size() + maxOptions) {
                break;
            }
            result.add(option);
        }
        return result;
    }

    private static void crossProduct(List<Integer> widths,
            List<List<List<String>>> optionsByWidth,
            int index,
            Map<Integer, List<String>> current,
            List<Map<Integer, List<String>>> out,
            int cap) {
        if (out.size() >= cap) {
            return;
        }
        if (index == widths.size()) {
            out.add(new LinkedHashMap<>(current));
            return;
        }
        for (List<String> option : optionsByWidth.get(index)) {
            current.put(widths.get(index), option);
            crossProduct(widths, optionsByWidth, index + 1, current, out, cap);
            current.remove(widths.get(index));
            if (out.size() >= cap) {
                return;
            }
        }
    }
}
