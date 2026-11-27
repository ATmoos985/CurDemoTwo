package changyang.cut.apsmodule.generator.NewSolver.output;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import changyang.cut.apsmodule.generator.NewSolver.config.SolverRuntimeProperties;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * LocalNeighborhoodSequenceOptimizer 的诊断行与汇总输出支持。
 */
final class LnsDiagnostics {

    private static final Logger log = LoggerFactory.getLogger(LnsDiagnostics.class);

    record DiagnosticRow(
            int iteration,
            int neighborhoodIndex,
            List<String> seeds,
            int freeOrders,
            int patterns,
            int cars,
            int columns,
            int beforeProxy,
            int afterProxy,
            int beforeGroups,
            int beforeOddCarGroups,
            int beforeSmallCarGroups,
            int beforeFragmentation,
            int afterGroups,
            int afterOddCarGroups,
            int afterSmallCarGroups,
            int afterFragmentation,
            boolean feasible,
            boolean valid,
            boolean unique,
            boolean visited,
            boolean guardOk,
            String status) {

        int proxyDelta() {
            return beforeProxy - afterProxy;
        }

        int groupDelta() {
            return beforeGroups - afterGroups;
        }

        int fragmentationDelta() {
            return beforeFragmentation - afterFragmentation;
        }

        int oddDelta() {
            return beforeOddCarGroups - afterOddCarGroups;
        }

        int smallDelta() {
            return beforeSmallCarGroups - afterSmallCarGroups;
        }
    }

    static final class Diagnostics {
        final boolean enabled;
        private final List<DiagnosticRow> rows = new ArrayList<>();

        private Diagnostics(boolean enabled) {
            this.enabled = enabled;
        }

        static Diagnostics create() {
            return new Diagnostics(SolverRuntimeProperties.getBoolean("cutting.lns.diagnostics", false));
        }

        void record(DiagnosticRow row) {
            if (enabled) {
                rows.add(row);
            }
        }

        void logSummary(SequenceGroupPostProcessor.GroupStats originalStats) {
            if (!enabled || rows.isEmpty()) {
                return;
            }
            long feasible = rows.stream().filter(DiagnosticRow::feasible).count();
            long valid = rows.stream().filter(DiagnosticRow::valid).count();
            long unique = rows.stream().filter(DiagnosticRow::unique).count();
            long guardBlocked = rows.stream()
                    .filter(row -> row.valid() && row.unique() && !row.guardOk())
                    .count();
            long proxyImproved = rows.stream()
                    .filter(row -> row.valid() && row.proxyDelta() > 0)
                    .count();
            long trueImproved = rows.stream()
                    .filter(row -> row.valid() && row.groupDelta() > 0)
                    .count();
            long proxyOnly = rows.stream()
                    .filter(row -> row.valid() && row.proxyDelta() > 0 && row.groupDelta() <= 0)
                    .count();
            int bestGroups = rows.stream()
                    .filter(DiagnosticRow::valid)
                    .mapToInt(DiagnosticRow::afterGroups)
                    .min()
                    .orElse(originalStats.groups());
            int bestOdd = rows.stream()
                    .filter(row -> row.valid() && row.afterGroups() == bestGroups)
                    .mapToInt(DiagnosticRow::afterOddCarGroups)
                    .min()
                    .orElse(Integer.MAX_VALUE);
            int bestSmall = rows.stream()
                    .filter(row -> row.valid()
                            && row.afterGroups() == bestGroups
                            && row.afterOddCarGroups() == bestOdd)
                    .mapToInt(DiagnosticRow::afterSmallCarGroups)
                    .min()
                    .orElse(Integer.MAX_VALUE);
            int bestFragmentation = rows.stream()
                    .filter(row -> row.valid()
                            && row.afterGroups() == bestGroups
                            && row.afterOddCarGroups() == bestOdd
                            && row.afterSmallCarGroups() == bestSmall)
                    .mapToInt(DiagnosticRow::afterFragmentation)
                    .min()
                    .orElse(Integer.MAX_VALUE);

            log.info("LNS diagnostics: rows={}, feasible={}, valid={}, unique={}, guardBlocked={}, proxyImproved={}, trueImproved={}, proxyOnly={}, bestGroups={}, bestOdd={}, bestSmall={}, bestFrag={}",
                    rows.size(), feasible, valid, unique, guardBlocked, proxyImproved, trueImproved, proxyOnly,
                    bestGroups, bestOdd, bestSmall, bestFragmentation);
            int topLimit = SolverRuntimeProperties.getInt("cutting.lns.diagnosticsTop", 8);
            logTop("LNS diagnostics best true moves", rows.stream()
                    .filter(row -> row.valid() && row.unique() && row.guardOk())
                    .sorted(Comparator
                            .comparingInt(DiagnosticRow::afterGroups)
                            .thenComparingInt(DiagnosticRow::afterOddCarGroups)
                            .thenComparingInt(DiagnosticRow::afterSmallCarGroups)
                            .thenComparingInt(DiagnosticRow::afterFragmentation)
                            .thenComparing(Comparator.comparingInt(DiagnosticRow::proxyDelta).reversed()))
                    .limit(topLimit)
                    .toList());
            logTop("LNS diagnostics guard-blocked moves", rows.stream()
                    .filter(row -> row.valid() && row.unique() && !row.guardOk())
                    .sorted(Comparator
                            .comparingInt(DiagnosticRow::afterGroups)
                            .thenComparingInt(DiagnosticRow::afterOddCarGroups)
                            .thenComparingInt(DiagnosticRow::afterSmallCarGroups)
                            .thenComparingInt(DiagnosticRow::afterFragmentation))
                    .limit(topLimit)
                    .toList());
            logTop("LNS diagnostics proxy-only moves", rows.stream()
                    .filter(row -> row.valid() && row.guardOk() && row.proxyDelta() > 0 && row.groupDelta() <= 0)
                    .sorted(Comparator
                            .comparingInt(DiagnosticRow::groupDelta)
                            .thenComparing(Comparator.comparingInt(DiagnosticRow::proxyDelta).reversed())
                            .thenComparingInt(DiagnosticRow::afterOddCarGroups)
                            .thenComparingInt(DiagnosticRow::afterSmallCarGroups)
                            .thenComparingInt(DiagnosticRow::afterFragmentation))
                    .limit(topLimit)
                    .toList());
        }

        private void logTop(String title, List<DiagnosticRow> selected) {
            if (selected.isEmpty()) {
                log.info("{}: none", title);
                return;
            }
            log.info("{}:", title);
            for (DiagnosticRow row : selected) {
                log.info("  iter={} n={} seeds={} groups {}->{} odd {}->{} small {}->{} frag {}->{} proxy {}->{} freeOrders={} patterns={} cars={} columns={} status={} unique={} visited={} guardOk={}",
                        row.iteration(),
                        row.neighborhoodIndex(),
                        row.seeds(),
                        row.beforeGroups(),
                        row.afterGroups(),
                        row.beforeOddCarGroups(),
                        row.afterOddCarGroups(),
                        row.beforeSmallCarGroups(),
                        row.afterSmallCarGroups(),
                        row.beforeFragmentation(),
                        row.afterFragmentation(),
                        row.beforeProxy(),
                        row.afterProxy(),
                        row.freeOrders(),
                        row.patterns(),
                        row.cars(),
                        row.columns(),
                        row.status(),
                        row.unique(),
                        row.visited(),
                        row.guardOk());
            }
        }
    }
}
