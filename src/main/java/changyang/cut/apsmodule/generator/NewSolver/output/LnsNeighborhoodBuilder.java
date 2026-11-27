package changyang.cut.apsmodule.generator.NewSolver.output;

import changyang.cut.apsmodule.generator.NewSolver.config.SolverParameters;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverRuntimeProperties;
import changyang.cut.apsmodule.generator.NewSolver.output.LnsModelAndInstructionSupport.DemandKey;
import changyang.cut.apsmodule.generator.NewSolver.output.LnsModelAndInstructionSupport.Neighborhood;
import changyang.cut.apsmodule.generator.NewSolver.output.LnsModelAndInstructionSupport.PatternKey;
import changyang.cut.apsmodule.generator.NewSolver.output.LnsModelAndInstructionSupport.RollRecord;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Collectors;

/**
 * LocalNeighborhoodSequenceOptimizer 的邻域构造、切片与均衡花型富集。
 */
final class LnsNeighborhoodBuilder {

    private static final int DEFAULT_MAX_FREE_ORDERS = 10;
    private static final int DEFAULT_MAX_FREE_PATTERNS = 12;
    private static final int DEFAULT_MAX_FREE_CARS = 32;
    private static final int DEFAULT_MAX_SEED_COUNT = 4;
    private static final int DEFAULT_SHARED_WIDTH_DEPTH = 1;
    private static final int DEFAULT_MAX_SLICE_NEIGHBORHOODS = 20;
    private static final int DEFAULT_MAX_SLICE_CARS_PER_CONFIG = 8;

    private final SolverParameters params;

    LnsNeighborhoodBuilder(SolverParameters params) {
        this.params = params;
    }

    List<Neighborhood> buildNeighborhoods(List<RollRecord> rolls, int maxNeighborhoods) {
        Map<String, Set<String>> configsByKey = new LinkedHashMap<>();
        for (RollRecord roll : rolls) {
            for (String key : roll.demandCounts().keySet()) {
                configsByKey.computeIfAbsent(key, ignored -> new LinkedHashSet<>())
                        .add(roll.configSignature());
            }
        }

        List<String> fragmentedKeys = configsByKey.entrySet().stream()
                .filter(entry -> entry.getValue().size() > 1)
                .sorted(Comparator
                        .<Map.Entry<String, Set<String>>>comparingInt(entry -> entry.getValue().size()).reversed()
                        .thenComparing(Map.Entry::getKey))
                .map(Map.Entry::getKey)
                .toList();

        int heavyWidthMinCars = SolverRuntimeProperties.getInt("cutting.lns.heavyWidthMinCars", 0);
        if (heavyWidthMinCars > 0) {
            Map<Integer, Integer> carsByWidth = new HashMap<>();
            for (RollRecord roll : rolls) {
                for (Map.Entry<String, Integer> entry : roll.demandCounts().entrySet()) {
                    carsByWidth.merge(DemandKey.parse(entry.getKey()).width(), entry.getValue(), Integer::sum);
                }
            }
            List<String> heavyOnly = fragmentedKeys.stream()
                    .filter(key -> carsByWidth.getOrDefault(DemandKey.parse(key).width(), 0) >= heavyWidthMinCars)
                    .toList();
            if (!heavyOnly.isEmpty()) {
                fragmentedKeys = heavyOnly;
            }
        }

        List<Neighborhood> neighborhoods = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        addSlicedNeighborhoods(rolls, fragmentedKeys, neighborhoods, seen, maxNeighborhoods);
        int maxSeedCount = SolverRuntimeProperties.getInt("cutting.lns.maxSeedCount", DEFAULT_MAX_SEED_COUNT);
        for (int start = 0; start < fragmentedKeys.size() && neighborhoods.size() < maxNeighborhoods; start++) {
            for (int seedCount = 1; seedCount <= maxSeedCount
                    && start + seedCount <= fragmentedKeys.size()
                    && neighborhoods.size() < maxNeighborhoods; seedCount++) {
                List<String> seeds = fragmentedKeys.subList(start, start + seedCount);
                for (boolean expandSharedWidths : List.of(false, true)) {
                    Neighborhood neighborhood = buildNeighborhood(rolls, seeds, expandSharedWidths);
                    if (neighborhood == null) {
                        continue;
                    }
                    addNeighborhood(neighborhoods, seen, neighborhood, maxNeighborhoods);
                }
            }
        }
        return neighborhoods;
    }

    private void addSlicedNeighborhoods(List<RollRecord> rolls,
            List<String> fragmentedKeys,
            List<Neighborhood> neighborhoods,
            Set<String> seen,
            int maxNeighborhoods) {
        int sliceBudget = Math.min(
                SolverRuntimeProperties.getInt("cutting.lns.maxSliceNeighborhoods", DEFAULT_MAX_SLICE_NEIGHBORHOODS),
                maxNeighborhoods);
        int maxSliceCars = SolverRuntimeProperties.getInt(
                "cutting.lns.maxSliceCarsPerConfig", DEFAULT_MAX_SLICE_CARS_PER_CONFIG);

        for (String key : fragmentedKeys) {
            if (neighborhoods.size() >= sliceBudget || neighborhoods.size() >= maxNeighborhoods) {
                return;
            }

            Map<String, List<Integer>> indexesByConfig = new LinkedHashMap<>();
            for (RollRecord roll : rolls) {
                if (roll.demandCounts().containsKey(key)) {
                    indexesByConfig.computeIfAbsent(roll.configSignature(), ignored -> new ArrayList<>())
                            .add(roll.index());
                }
            }

            List<List<Integer>> configSlices = indexesByConfig.values().stream()
                    .filter(indexes -> !indexes.isEmpty())
                    .sorted(Comparator
                            .<List<Integer>>comparingInt(List::size).reversed()
                            .thenComparing(indexes -> indexes.get(0)))
                    .toList();
            if (configSlices.size() < 2) {
                continue;
            }

            for (int left = 0; left < configSlices.size(); left++) {
                for (int right = left + 1; right < configSlices.size(); right++) {
                    if (neighborhoods.size() >= sliceBudget || neighborhoods.size() >= maxNeighborhoods) {
                        return;
                    }
                    Set<Integer> selectedIndexes = new LinkedHashSet<>();
                    addLimitedIndexes(selectedIndexes, configSlices.get(left), maxSliceCars);
                    addLimitedIndexes(selectedIndexes, configSlices.get(right), maxSliceCars);
                    Neighborhood neighborhood = createNeighborhood(rolls, List.of(key), selectedIndexes);
                    if (neighborhood != null) {
                        addNeighborhood(neighborhoods, seen, neighborhood, maxNeighborhoods);
                    }
                }
            }
        }
    }

    private void addLimitedIndexes(Set<Integer> selectedIndexes, List<Integer> indexes, int limit) {
        for (int i = 0; i < indexes.size() && i < limit; i++) {
            selectedIndexes.add(indexes.get(i));
        }
    }

    private void addNeighborhood(List<Neighborhood> neighborhoods,
            Set<String> seen,
            Neighborhood neighborhood,
            int maxNeighborhoods) {
        if (neighborhoods.size() >= maxNeighborhoods) {
            return;
        }
        String signature = neighborhood.selectedRollIndexes().stream()
                .map(String::valueOf)
                .collect(Collectors.joining(","));
        if (seen.add(signature)) {
            neighborhoods.add(neighborhood);
        }
    }

    private Neighborhood buildNeighborhood(List<RollRecord> rolls, List<String> seedKeys,
            boolean expandSharedWidths) {
        Set<Integer> selectedIndexes = new LinkedHashSet<>();
        Set<String> seedSet = new HashSet<>(seedKeys);
        for (RollRecord roll : rolls) {
            if (roll.demandCounts().keySet().stream().anyMatch(seedSet::contains)) {
                selectedIndexes.add(roll.index());
            }
        }
        if (selectedIndexes.isEmpty()) {
            return null;
        }
        if (expandSharedWidths) {
            selectedIndexes = expandBySharedWidths(rolls, selectedIndexes);
        }

        return createNeighborhood(rolls, seedKeys, selectedIndexes);
    }

    private Neighborhood createNeighborhood(List<RollRecord> rolls, List<String> seedKeys,
            Set<Integer> selectedIndexes) {
        Map<String, Integer> freeDemand = new TreeMap<>();
        Map<String, PatternKey> patterns = new LinkedHashMap<>();
        List<RollRecord> selectedRolls = new ArrayList<>();
        int cars = 0;
        int waste = 0;
        for (int index : selectedIndexes) {
            RollRecord roll = rolls.get(index);
            selectedRolls.add(roll);
            cars++;
            waste += roll.pattern().waste();
            patterns.putIfAbsent(roll.pattern().signature(), roll.pattern());
            for (Map.Entry<String, Integer> entry : roll.demandCounts().entrySet()) {
                freeDemand.merge(entry.getKey(), entry.getValue(), Integer::sum);
            }
        }

        if (freeDemand.size() > maxFreeOrders()
                || patterns.size() > maxFreePatterns()
                || cars > maxFreeCars()) {
            return null;
        }
        addCompatiblePatterns(rolls, freeDemand, patterns);
        if (SolverRuntimeProperties.getBoolean("cutting.lns.enrichPatterns", false)) {
            for (PatternKey pk : generateBalancingPatterns(freeDemand, selectedRolls)) {
                patterns.putIfAbsent(pk.signature(), pk);
            }
        }
        return new Neighborhood(List.copyOf(seedKeys), selectedIndexes, freeDemand,
                new ArrayList<>(patterns.values()), List.copyOf(selectedRolls), cars, waste);
    }

    private Set<Integer> expandBySharedWidths(List<RollRecord> rolls, Set<Integer> selectedIndexes) {
        Set<Integer> expanded = new LinkedHashSet<>(selectedIndexes);
        int maxDepth = SolverRuntimeProperties.getInt("cutting.lns.sharedWidthDepth", DEFAULT_SHARED_WIDTH_DEPTH);
        int freeCarsCap = maxFreeCars();
        Map<String, Integer> rollCountByConfig = new HashMap<>();
        for (RollRecord roll : rolls) {
            rollCountByConfig.merge(roll.configSignature(), 1, Integer::sum);
        }
        for (int depth = 0; depth < maxDepth; depth++) {
            Set<Integer> activeWidths = widthsInSelectedRolls(rolls, expanded);
            List<RollRecord> candidates = rolls.stream()
                    .filter(roll -> !expanded.contains(roll.index()))
                    .filter(roll -> !(roll.demandCounts().size() == 1
                            && rollCountByConfig.getOrDefault(roll.configSignature(), 0) >= freeCarsCap))
                    .filter(roll -> overlapScore(roll, activeWidths) > 0)
                    .sorted(Comparator
                            .comparingInt((RollRecord roll) -> overlapScore(roll, activeWidths)).reversed()
                            .thenComparingInt(roll -> roll.demandCounts().size())
                            .thenComparingInt(RollRecord::index))
                    .toList();

            int freeOrdersCap = maxFreeOrders();
            int freePatternsCap = maxFreePatterns();
            Set<String> currentOrders = new HashSet<>();
            Set<String> currentPatterns = new HashSet<>();
            for (int index : expanded) {
                RollRecord existing = rolls.get(index);
                currentOrders.addAll(existing.demandCounts().keySet());
                currentPatterns.add(existing.pattern().signature());
            }

            boolean added = false;
            for (RollRecord roll : candidates) {
                if (expanded.size() >= freeCarsCap) {
                    break;
                }
                int newPatterns = currentPatterns.contains(roll.pattern().signature()) ? 0 : 1;
                if (currentPatterns.size() + newPatterns > freePatternsCap) {
                    continue;
                }
                int newOrders = 0;
                for (String key : roll.demandCounts().keySet()) {
                    if (!currentOrders.contains(key)) {
                        newOrders++;
                    }
                }
                if (currentOrders.size() + newOrders <= freeOrdersCap) {
                    expanded.add(roll.index());
                    currentOrders.addAll(roll.demandCounts().keySet());
                    currentPatterns.add(roll.pattern().signature());
                    added = true;
                }
            }
            if (!added) {
                break;
            }
        }
        return expanded;
    }

    private Set<Integer> widthsInSelectedRolls(List<RollRecord> rolls, Set<Integer> selectedIndexes) {
        Set<Integer> widths = new LinkedHashSet<>();
        for (int index : selectedIndexes) {
            widths.addAll(rolls.get(index).pattern().subRolls().keySet());
        }
        return widths;
    }

    private int overlapScore(RollRecord roll, Set<Integer> widths) {
        int score = 0;
        for (Integer width : roll.pattern().subRolls().keySet()) {
            if (widths.contains(width)) {
                score++;
            }
        }
        return score;
    }

    private void addCompatiblePatterns(List<RollRecord> rolls,
            Map<String, Integer> freeDemand,
            Map<String, PatternKey> patterns) {
        if (patterns.size() >= maxFreePatterns()) {
            return;
        }
        Set<Integer> freeWidths = freeDemand.keySet().stream()
                .map(DemandKey::parse)
                .map(DemandKey::width)
                .collect(Collectors.toCollection(LinkedHashSet::new));
        List<PatternKey> candidates = rolls.stream()
                .map(RollRecord::pattern)
                .filter(pattern -> !patterns.containsKey(pattern.signature()))
                .filter(pattern -> freeWidths.containsAll(pattern.subRolls().keySet()))
                .collect(Collectors.toMap(
                        PatternKey::signature,
                        pattern -> pattern,
                        (left, right) -> left,
                        LinkedHashMap::new))
                .values()
                .stream()
                .sorted(Comparator
                        .comparingInt((PatternKey pattern) -> pattern.subRolls().size()).reversed()
                        .thenComparingInt(PatternKey::waste)
                        .thenComparing(PatternKey::signature))
                .toList();
        for (PatternKey pattern : candidates) {
            if (patterns.size() >= maxFreePatterns()) {
                break;
            }
            patterns.put(pattern.signature(), pattern);
        }
    }

    private List<PatternKey> generateBalancingPatterns(Map<String, Integer> freeDemand,
            List<RollRecord> selectedRolls) {
        if (selectedRolls.isEmpty()) {
            return List.of();
        }
        int totalWidth = params.getTotalWidth();
        int minRw = SolverRuntimeProperties.getInt("cutting.lns.enrichMinPw", params.getMinRollWidth());
        int maxRw = SolverRuntimeProperties.getInt("cutting.lns.enrichMaxPw", params.getMaxRollWidth());
        int maxDistinct = params.getMaxDistinctWidths();
        int cap = SolverRuntimeProperties.getInt("cutting.lns.enrichCap", 60);
        int guard = Math.max(cap, SolverRuntimeProperties.getInt("cutting.lns.enrichGuard", 1500));
        PatternKey sample = selectedRolls.get(0).pattern();
        List<Integer> widths = freeDemand.keySet().stream()
                .map(DemandKey::parse)
                .map(DemandKey::width)
                .distinct()
                .sorted()
                .toList();
        List<PatternKey> all = new ArrayList<>();
        enumerateBalancingPatterns(widths, 0, new LinkedHashMap<>(), 0,
                minRw, maxRw, maxDistinct, totalWidth, sample, all, guard);
        if (all.size() <= cap) {
            return all;
        }
        all.sort(Comparator.comparingInt(PatternKey::patternWidth).thenComparing(PatternKey::signature));
        List<PatternKey> sampled = new ArrayList<>(cap);
        for (int i = 0; i < cap; i++) {
            sampled.add(all.get((int) ((long) i * all.size() / cap)));
        }
        return sampled;
    }

    private void enumerateBalancingPatterns(List<Integer> widths, int idx,
            Map<Integer, Integer> current, int sum, int minRw, int maxRw, int maxDistinct,
            int totalWidth, PatternKey sample, List<PatternKey> result, int cap) {
        if (result.size() >= cap) {
            return;
        }
        if (idx == widths.size()) {
            if (sum >= minRw && sum <= maxRw && !current.isEmpty()) {
                result.add(new PatternKey(sample.groupKey(), sum, sample.length(),
                        sample.surfaceTreatment(), sample.thickness(),
                        new LinkedHashMap<>(current), sum, totalWidth - sum));
            }
            return;
        }
        int w = widths.get(idx);
        int maxC = (maxRw - sum) / w;
        for (int c = 0; c <= maxC && result.size() < cap; c++) {
            if (c > 0) {
                if (!current.containsKey(w) && current.size() >= maxDistinct) {
                    break;
                }
                current.put(w, c);
            }
            enumerateBalancingPatterns(widths, idx + 1, current, sum + c * w,
                    minRw, maxRw, maxDistinct, totalWidth, sample, result, cap);
        }
        current.remove(w);
    }

    private int maxFreeOrders() {
        return SolverRuntimeProperties.getInt("cutting.lns.maxFreeOrders", DEFAULT_MAX_FREE_ORDERS);
    }

    private int maxFreePatterns() {
        return SolverRuntimeProperties.getInt("cutting.lns.maxFreePatterns", DEFAULT_MAX_FREE_PATTERNS);
    }

    private int maxFreeCars() {
        return SolverRuntimeProperties.getInt("cutting.lns.maxFreeCars", DEFAULT_MAX_FREE_CARS);
    }
}
