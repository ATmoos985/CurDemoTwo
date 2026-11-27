package changyang.cut.apsmodule.generator.NewSolver.mip;

import com.google.ortools.linearsolver.MPSolver;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Collectors;

import changyang.cut.apsmodule.generator.NewSolver.mip.UnifiedSetPartitionMipEngine.ObjectivePhase;

/**
 * 根治实验：A+B 合并的统一 set-partition 模型。
 *
 * <p>列 = (花型, 整车序号配置)，计数变量 c_j 直接决定块大小；启用列数 Σy 就是序号组数
 * ——组数第一次真正进入目标函数，而不是靠花型数/奇偶/对齐等代理指标（四条代理已全部
 * 实测证伪，见笔记 11）。奇偶做次级 tie-break（人工解剖：47 块里 45 块偶，唯二奇块是
 * 数学必然，见笔记 12）。
 *
 * <p>由 B6UnifiedSetPartitionTest（实验驱动）与 SetPartitionRefiner（质量模式精修段，
 * 微邻域残差注入）使用；快路径不经过本类。
 */
public class UnifiedSetPartitionSolver {

    /** 列：花型（宽度→条数）+ 整车配置（宽度→每工位序号，已排序）。 */
    public record Column(Map<Integer, Integer> pattern,
                         Map<Integer, List<String>> config,
                         int patternWidth) {

        public static Column of(Map<Integer, Integer> pattern, Map<Integer, List<String>> config) {
            Map<Integer, Integer> p = new TreeMap<>(pattern);
            Map<Integer, List<String>> g = new TreeMap<>();
            for (Map.Entry<Integer, List<String>> e : config.entrySet()) {
                List<String> messages = new ArrayList<>(e.getValue());
                messages.sort(String::compareTo);
                g.put(e.getKey(), List.copyOf(messages));
            }
            int pw = p.entrySet().stream().mapToInt(e -> e.getKey() * e.getValue()).sum();
            return new Column(p, g, pw);
        }

        public String signature() {
            return config.entrySet().stream()
                    .map(e -> e.getKey() + "=" + String.join(",", e.getValue()))
                    .collect(Collectors.joining("|"));
        }

        /** 该列每车对 (width|message) 需求的消耗量。 */
        public Map<String, Integer> demandUse() {
            Map<String, Integer> use = new LinkedHashMap<>();
            for (Map.Entry<Integer, List<String>> e : config.entrySet()) {
                for (String m : e.getValue()) {
                    use.merge(e.getKey() + "|" + m, 1, Integer::sum);
                }
            }
            return use;
        }
    }

    public record ColumnUse(Column column, int count) {
    }

    /** 定长列：c 固化进列的 (配置, 车数)——L10 琥珀灯裁决的主问题重构单元（笔记13）。 */
    public record FixedColumn(Column column, int count) {

        public String key() {
            return column.signature() + "#" + count;
        }
    }

    public record Result(List<ColumnUse> uses, int groups, int oddBlocks, int oneCarBlocks,
                         int smallBlocks, int cars, int waste, String status, double objectiveValue,
                         double bestBound, long nodes, long elapsedMs) {

        public Result(List<ColumnUse> uses, int groups, int oddBlocks, int smallBlocks,
                int cars, int waste, String status) {
            this(uses, groups, oddBlocks, countOneCarBlocks(uses), smallBlocks, cars, waste, status,
                    Double.NaN, Double.NaN, -1L, -1L);
        }

        private static int countOneCarBlocks(List<ColumnUse> uses) {
            return uses == null ? 0 : (int) uses.stream().filter(use -> use.count() == 1).count();
        }

        public double relativeGap() {
            if (!Double.isFinite(objectiveValue) || !Double.isFinite(bestBound)) {
                return Double.NaN;
            }
            return Math.abs(objectiveValue - bestBound)
                    / Math.max(1.0, Math.abs(objectiveValue));
        }

        public String signature() {
            return uses.stream()
                    .map(use -> use.column().signature() + "#" + use.count())
                    .sorted()
                    .collect(Collectors.joining("|"));
        }
    }

    public record LexicographicResult(Result result, List<Result> phases, boolean provenOptimal) {
    }

    /** Result of asking whether the current executable column pool admits at most K groups. */
    public record GroupCapResult(Result result, boolean feasible, boolean proven) {
    }

    /** Result of a pure feasibility solve under group, odd-block, and small-block caps. */
    public record MetricCapResult(Result result, boolean feasible, boolean proven) {
    }

    /** LP 松弛的对偶价：π(w|m) 需求、μ 车数、ν 废边，及 LP 目标值（组数下界）。 */
    public record LpDuals(Map<String, Double> demandDuals, double carsDual, double wasteDual,
                          double objective, String status) {

        /**
         * 列的 reduced cost：cost(=1/support) − Σπ·mult − μ − ν·wastePerCar。
         * 负值 ⇒ 该列会被定价拉入受限主问题。
         */
        public double reducedCost(Column column, Map<String, Integer> demand, int totalWidth) {
            int support = supportOf(column, demand);
            if (support < 1) {
                return Double.POSITIVE_INFINITY;
            }
            double value = 0.0;
            for (Map.Entry<String, Integer> use : column.demandUse().entrySet()) {
                value += demandDuals.getOrDefault(use.getKey(), 0.0) * use.getValue();
            }
            value += carsDual;
            value += wasteDual * (totalWidth - column.patternWidth());
            return 1.0 / support - value;
        }

        /**
         * 定长列 (config, c) 的 reduced cost：(1 + oddW·奇) − c·(Σπ·mult + μ + ν·wpc)。
         * 对 c 线性——定价子问题中 config 定型后，最优 c 在档位端点上取。
         */
        public double fixedReducedCost(Column column, int count, int totalWidth, double oddWeight) {
            double perCar = 0.0;
            for (Map.Entry<String, Integer> use : column.demandUse().entrySet()) {
                perCar += demandDuals.getOrDefault(use.getKey(), 0.0) * use.getValue();
            }
            perCar += carsDual;
            perCar += wasteDual * (totalWidth - column.patternWidth());
            return 1.0 + (count % 2 != 0 ? oddWeight : 0.0) - count * perCar;
        }
    }

    /**
     * @param pool      候选列池（按签名去重）
     * @param demand    (width|message) -> 需求卷数（精确覆盖）
     * @param exactCars 总车数（= 现有管线的最优车数，硬等式，得率锁死）
     * @param wasteCap  总废边上限（= 现有管线的最优废边，硬约束）
     * @param totalWidth 母卷总宽
     */
    public Result solve(List<Column> pool,
            Map<String, Integer> demand,
            int exactCars,
            int wasteCap,
            int totalWidth,
            long timeLimitMs,
            double oddWeight) {
        return solve(pool, demand, exactCars, wasteCap, totalWidth, timeLimitMs, oddWeight, List.of());
    }

    /**
     * @param warmStart 已知可行解（如人工方案/现有管线解），作为 SCIP hint 注入——
     *                  set-partition 千列规模下分支定界冷启动常在时限内找不到池中已有的
     *                  好组合（实测 180s 只到 54 组而人工 46 列就在池里），热启动后只做改进。
     */
    public Result solve(List<Column> pool,
            Map<String, Integer> demand,
            int exactCars,
            int wasteCap,
            int totalWidth,
            long timeLimitMs,
            double oddWeight,
            List<ColumnUse> warmStart) {
        return solve(pool, demand, exactCars, wasteCap, totalWidth, timeLimitMs, oddWeight,
                warmStart, null);
    }

    /**
     * Strict four-phase lexicographic solve: groups, odd blocks, one-car blocks, then small blocks.
     * Each phase must prove optimality before its incumbent can cap the next phase.
     */
    public LexicographicResult solveLexicographic(List<Column> pool,
            Map<String, Integer> demand,
            int exactCars,
            int wasteCap,
            int totalWidth,
            long timeLimitMsPerPhase,
            List<ColumnUse> warmStart) {
        return UnifiedSetPartitionMipEngine.solveLexicographic(
                pool, demand, exactCars, wasteCap, totalWidth, timeLimitMsPerPhase, warmStart);
    }

    /**
     * Checks a group-count boundary without changing the business objective.
     * FEASIBLE proves existence; INFEASIBLE proves non-existence only inside
     * the supplied normalized column pool. Other statuses are inconclusive.
     */
    public GroupCapResult checkGroupCap(List<Column> pool,
            Map<String, Integer> demand,
            int exactCars,
            int wasteCap,
            int totalWidth,
            int maxGroups,
            long timeLimitMs) {
        return checkGroupCap(pool, demand, exactCars, wasteCap, totalWidth,
                maxGroups, timeLimitMs, List.of());
    }

    public GroupCapResult checkGroupCap(List<Column> pool,
            Map<String, Integer> demand,
            int exactCars,
            int wasteCap,
            int totalWidth,
            int maxGroups,
            long timeLimitMs,
            List<ColumnUse> warmStart) {
        if (maxGroups < 0) {
            throw new IllegalArgumentException("maxGroups must be non-negative");
        }
        Result result = UnifiedSetPartitionMipEngine.solvePhase(
                pool, demand, exactCars, wasteCap, totalWidth,
                timeLimitMs, 0.0, warmStart, maxGroups, null, null, null,
                ObjectivePhase.FEASIBILITY, true);
        if (result == null) {
            return new GroupCapResult(null, false, false);
        }
        boolean feasible = MPSolver.ResultStatus.OPTIMAL.toString().equals(result.status())
                || MPSolver.ResultStatus.FEASIBLE.toString().equals(result.status());
        boolean proven = feasible
                || MPSolver.ResultStatus.INFEASIBLE.toString().equals(result.status());
        return new GroupCapResult(result, feasible, proven);
    }

    public MetricCapResult checkMetricCaps(List<Column> pool,
            Map<String, Integer> demand,
            int exactCars,
            int wasteCap,
            int totalWidth,
            int maxGroups,
            int maxOdd,
            int maxOne,
            int maxSmall,
            long timeLimitMs,
            List<ColumnUse> warmStart) {
        if (maxGroups < 0 || maxOdd < 0 || maxOne < 0 || maxSmall < 0) {
            throw new IllegalArgumentException("Metric caps must be non-negative");
        }
        Result result = UnifiedSetPartitionMipEngine.solvePhase(
                pool, demand, exactCars, wasteCap, totalWidth,
                timeLimitMs, 0.0, warmStart, maxGroups, maxOdd, maxOne, maxSmall,
                ObjectivePhase.FEASIBILITY, true);
        if (result == null) {
            return new MetricCapResult(null, false, false);
        }
        boolean feasible = MPSolver.ResultStatus.OPTIMAL.toString().equals(result.status())
                || MPSolver.ResultStatus.FEASIBLE.toString().equals(result.status());
        boolean proven = feasible
                || MPSolver.ResultStatus.INFEASIBLE.toString().equals(result.status());
        return new MetricCapResult(result, feasible, proven);
    }

    /**
     * Research-only feasibility check for the hard business metrics. Small blocks are
     * intentionally uncapped because they are subordinate to eliminating one-car blocks.
     * The node limit is the deterministic search budget; wall time is only a safety cap.
     */
    public MetricCapResult checkCoreMetricCapsByNodes(List<Column> pool,
            Map<String, Integer> demand,
            int exactCars,
            int wasteCap,
            int totalWidth,
            int maxGroups,
            int maxOdd,
            int maxOne,
            long nodeLimit,
            long safetyTimeLimitMs,
            List<ColumnUse> warmStart) {
        if (maxGroups < 0 || maxOdd < 0 || maxOne < 0) {
            throw new IllegalArgumentException("Core metric caps must be non-negative");
        }
        if (nodeLimit <= 0) {
            throw new IllegalArgumentException("nodeLimit must be positive");
        }
        Result result = UnifiedSetPartitionMipEngine.solvePhase(
                pool, demand, exactCars, wasteCap, totalWidth,
                safetyTimeLimitMs, 0.0, warmStart, maxGroups, maxOdd, maxOne, null,
                ObjectivePhase.FEASIBILITY, true, nodeLimit);
        if (result == null) {
            return new MetricCapResult(null, false, false);
        }
        boolean feasible = MPSolver.ResultStatus.OPTIMAL.toString().equals(result.status())
                || MPSolver.ResultStatus.FEASIBLE.toString().equals(result.status());
        boolean proven = feasible
                || MPSolver.ResultStatus.INFEASIBLE.toString().equals(result.status());
        return new MetricCapResult(result, feasible, proven);
    }

    /** Research polish: preserve proven/accepted group and odd caps, then minimize small blocks. */
    public Result minimizeSmallAtCaps(List<Column> pool,
            Map<String, Integer> demand,
            int exactCars,
            int wasteCap,
            int totalWidth,
            int maxGroups,
            int maxOdd,
            long timeLimitMs,
            List<ColumnUse> warmStart) {
        if (maxGroups < 0 || maxOdd < 0) {
            throw new IllegalArgumentException("Group and odd caps must be non-negative");
        }
        return UnifiedSetPartitionMipEngine.solvePhase(
                pool, demand, exactCars, wasteCap, totalWidth,
                timeLimitMs, 0.0, warmStart, maxGroups, maxOdd, null, null,
                ObjectivePhase.SMALL, true);
    }

    /** Preserve group and odd optima, then eliminate single-car blocks. */
    public Result minimizeOneCarAtCaps(List<Column> pool,
            Map<String, Integer> demand,
            int exactCars,
            int wasteCap,
            int totalWidth,
            int maxGroups,
            int maxOdd,
            long timeLimitMs,
            List<ColumnUse> warmStart) {
        if (maxGroups < 0 || maxOdd < 0) {
            throw new IllegalArgumentException("Group and odd caps must be non-negative");
        }
        return UnifiedSetPartitionMipEngine.solvePhase(
                pool, demand, exactCars, wasteCap, totalWidth,
                timeLimitMs, 0.0, warmStart, maxGroups, maxOdd, null, null,
                ObjectivePhase.ONE, true);
    }

    /**
     * @param maxGroups 非空时加硬约束 Σy ≤ maxGroups 且目标改为「odd 优先」（组数封顶后
     *                  专修奇偶）——字典序第二段：先 solve() 拿最少组数，再以其为帽调用本重载。
     */
    public Result solve(List<Column> pool,
            Map<String, Integer> demand,
            int exactCars,
            int wasteCap,
            int totalWidth,
            long timeLimitMs,
            double oddWeight,
            List<ColumnUse> warmStart,
            Integer maxGroups) {
        return UnifiedSetPartitionMipEngine.solvePhase(
                pool, demand, exactCars, wasteCap, totalWidth, timeLimitMs,
                oddWeight, warmStart, maxGroups, null, null, null,
                maxGroups == null
                        ? ObjectivePhase.GROUPS_WITH_ODD_TIEBREAK
                        : ObjectivePhase.ODD,
                false);
    }

    /**
     * 比例匹配贪心构造 warm start（模仿人工三板斧的装配顺序）。
     */
    public static List<ColumnUse> greedyAlignedWarmStart(List<Column> pool, Map<String, Integer> demand) {
        return StructuredColumnGenerator.greedyAlignedWarmStart(pool, demand);
    }

    /**
     * 带废边走廊守卫的版本。
     */
    public static List<ColumnUse> greedyAlignedWarmStart(List<Column> pool, Map<String, Integer> demand,
            int exactCars, int wasteCap, int totalWidth) {
        return StructuredColumnGenerator.greedyAlignedWarmStart(
                pool, demand, exactCars, wasteCap, totalWidth);
    }

    /**
     * 受限主问题的 LP 松弛（GLOP）。
     */
    public LpDuals solveLpRelaxation(List<Column> pool,
            Map<String, Integer> demand,
            int exactCars,
            int wasteCap,
            int totalWidth) {
        return UnifiedSetPartitionLpRelaxation.solveLpRelaxation(
                pool, demand, exactCars, wasteCap, totalWidth);
    }

    /**
     * 配置列 → 定长列展开。
     */
    public static List<FixedColumn> expandFixedColumns(List<Column> pool,
            Map<String, Integer> demand, int exactCars, boolean includeSupportLevel) {
        return UnifiedSetPartitionLpRelaxation.expandFixedColumns(
                pool, demand, exactCars, includeSupportLevel);
    }

    /**
     * 定长列受限主问题的 LP 松弛（GLOP）。
     */
    public LpDuals solveFixedLpRelaxation(List<FixedColumn> pool,
            Map<String, Integer> demand,
            int exactCars,
            int wasteCap,
            int totalWidth,
            double oddWeight) {
        return UnifiedSetPartitionLpRelaxation.solveFixedLpRelaxation(
                pool, demand, exactCars, wasteCap, totalWidth, oddWeight);
    }

    static int supportOf(Column column, Map<String, Integer> demand) {
        int support = Integer.MAX_VALUE;
        for (Map.Entry<String, Integer> use : column.demandUse().entrySet()) {
            Integer q = demand.get(use.getKey());
            if (q == null || q < use.getValue()) {
                return 0;
            }
            support = Math.min(support, q / use.getValue());
        }
        return support == Integer.MAX_VALUE ? 0 : support;
    }

    /**
     * 为每个花型枚举整车配置列。
     */
    public static List<Column> structuredColumns(Collection<Map<Integer, Integer>> patterns,
            Map<Integer, Map<String, Integer>> demandByWidth,
            int maxMessagesPerWidth,
            int maxOptionsPerWidth,
            int maxConfigsPerPattern) {
        return StructuredColumnGenerator.structuredColumns(
                patterns, demandByWidth, maxMessagesPerWidth, maxOptionsPerWidth, maxConfigsPerPattern);
    }

    /**
     * 配对导向的单宽度工位填充枚举。
     */
    public static List<List<String>> widthOptions(Map<String, Integer> demandByMessage,
            int slots, int bufferCount, int maxOptions) {
        return StructuredColumnGenerator.widthOptions(demandByMessage, slots, bufferCount, maxOptions);
    }
}
