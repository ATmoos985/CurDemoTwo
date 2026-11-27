package changyang.cut.apsmodule.generator.NewSolver.mip;

import com.google.ortools.linearsolver.MPConstraint;
import com.google.ortools.linearsolver.MPObjective;
import com.google.ortools.linearsolver.MPSolver;
import com.google.ortools.linearsolver.MPVariable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

import changyang.cut.apsmodule.generator.NewSolver.mip.UnifiedSetPartitionSolver.Column;
import changyang.cut.apsmodule.generator.NewSolver.mip.UnifiedSetPartitionSolver.FixedColumn;
import changyang.cut.apsmodule.generator.NewSolver.mip.UnifiedSetPartitionSolver.LpDuals;

/**
 * 统一 set-partition 的 GLOP LP 松弛与定长列展开工具。
 */
final class UnifiedSetPartitionLpRelaxation {

    private static final Logger log = LoggerFactory.getLogger(UnifiedSetPartitionLpRelaxation.class);

    private UnifiedSetPartitionLpRelaxation() {
    }

    static LpDuals solveLpRelaxation(List<Column> pool,
            Map<String, Integer> demand,
            int exactCars,
            int wasteCap,
            int totalWidth) {
        Map<String, Column> bySig = new LinkedHashMap<>();
        for (Column column : pool) {
            if (UnifiedSetPartitionSolver.supportOf(column, demand) >= 1) {
                bySig.putIfAbsent(column.signature(), column);
            }
        }
        List<Column> columns = new ArrayList<>(bySig.values());
        MPSolver solver = MPSolver.createSolver("GLOP");
        if (solver == null) {
            return null;
        }
        int n = columns.size();
        MPVariable[] c = new MPVariable[n];
        for (int j = 0; j < n; j++) {
            c[j] = solver.makeNumVar(0, UnifiedSetPartitionSolver.supportOf(columns.get(j), demand), "c_" + j);
        }
        Map<String, MPConstraint> demandConstraints = new LinkedHashMap<>();
        for (Map.Entry<String, Integer> e : demand.entrySet()) {
            demandConstraints.put(e.getKey(),
                    solver.makeConstraint(e.getValue(), e.getValue(), "d_" + e.getKey()));
        }
        for (int j = 0; j < n; j++) {
            for (Map.Entry<String, Integer> use : columns.get(j).demandUse().entrySet()) {
                demandConstraints.get(use.getKey()).setCoefficient(c[j], use.getValue());
            }
        }
        MPConstraint carsConstraint = solver.makeConstraint(exactCars, exactCars, "cars");
        MPConstraint wasteConstraint = solver.makeConstraint(0, wasteCap, "waste");
        for (int j = 0; j < n; j++) {
            carsConstraint.setCoefficient(c[j], 1);
            wasteConstraint.setCoefficient(c[j], totalWidth - columns.get(j).patternWidth());
        }
        MPObjective objective = solver.objective();
        for (int j = 0; j < n; j++) {
            objective.setCoefficient(c[j], 1.0 / UnifiedSetPartitionSolver.supportOf(columns.get(j), demand));
        }
        objective.setMinimization();
        MPSolver.ResultStatus status = solver.solve();
        if (status != MPSolver.ResultStatus.OPTIMAL) {
            log.warn("UnifiedSP LP relaxation returned {}", status);
            return new LpDuals(Map.of(), 0, 0, Double.NaN, status.toString());
        }
        Map<String, Double> demandDuals = new LinkedHashMap<>();
        for (Map.Entry<String, MPConstraint> e : demandConstraints.entrySet()) {
            demandDuals.put(e.getKey(), e.getValue().dualValue());
        }
        log.info("UnifiedSP LP relaxation: columns={} objective={} (组数下界) carsDual={} wasteDual={}",
                n, objective.value(), carsConstraint.dualValue(), wasteConstraint.dualValue());
        return new LpDuals(demandDuals, carsConstraint.dualValue(), wasteConstraint.dualValue(),
                objective.value(), status.toString());
    }

    static List<FixedColumn> expandFixedColumns(List<Column> pool,
            Map<String, Integer> demand, int exactCars, boolean includeSupportLevel) {
        Map<String, Column> bySig = new LinkedHashMap<>();
        for (Column column : pool) {
            if (UnifiedSetPartitionSolver.supportOf(column, demand) >= 1) {
                bySig.putIfAbsent(column.signature(), column);
            }
        }
        Map<String, FixedColumn> byKey = new LinkedHashMap<>();
        for (Column column : bySig.values()) {
            int support = Math.min(exactCars, UnifiedSetPartitionSolver.supportOf(column, demand));
            TreeSet<Integer> levels = new TreeSet<>();
            for (Map.Entry<String, Integer> use : column.demandUse().entrySet()) {
                int q = demand.getOrDefault(use.getKey(), 0);
                if (q % use.getValue() == 0) {
                    int exhaust = q / use.getValue();
                    if (exhaust >= 1 && exhaust <= support) {
                        levels.add(exhaust);
                        if (exhaust % 2 == 0 && exhaust >= 2) {
                            levels.add(exhaust / 2);
                        }
                    }
                }
            }
            if (includeSupportLevel) {
                levels.add(support);
            }
            for (Integer level : new ArrayList<>(levels)) {
                if (level % 2 != 0 && level > 1) {
                    levels.add(level - 1);
                }
            }
            for (int c : levels) {
                FixedColumn fixed = new FixedColumn(column, c);
                byKey.putIfAbsent(fixed.key(), fixed);
            }
        }
        return new ArrayList<>(byKey.values());
    }

    static LpDuals solveFixedLpRelaxation(List<FixedColumn> pool,
            Map<String, Integer> demand,
            int exactCars,
            int wasteCap,
            int totalWidth,
            double oddWeight) {
        Map<String, FixedColumn> byKey = new LinkedHashMap<>();
        for (FixedColumn fixed : pool) {
            if (fixed.count() >= 1 && UnifiedSetPartitionSolver.supportOf(fixed.column(), demand) >= fixed.count()) {
                byKey.putIfAbsent(fixed.key(), fixed);
            }
        }
        List<FixedColumn> columns = new ArrayList<>(byKey.values());
        MPSolver solver = MPSolver.createSolver("GLOP");
        if (solver == null) {
            return null;
        }
        int n = columns.size();
        MPVariable[] y = new MPVariable[n];
        for (int j = 0; j < n; j++) {
            FixedColumn fixed = columns.get(j);
            int repeats = Math.max(1, UnifiedSetPartitionSolver.supportOf(fixed.column(), demand) / fixed.count());
            y[j] = solver.makeNumVar(0, repeats, "y_" + j);
        }
        Map<String, MPConstraint> demandConstraints = new LinkedHashMap<>();
        for (Map.Entry<String, Integer> e : demand.entrySet()) {
            demandConstraints.put(e.getKey(),
                    solver.makeConstraint(e.getValue(), e.getValue(), "d_" + e.getKey()));
        }
        for (int j = 0; j < n; j++) {
            FixedColumn fixed = columns.get(j);
            for (Map.Entry<String, Integer> use : fixed.column().demandUse().entrySet()) {
                demandConstraints.get(use.getKey())
                        .setCoefficient(y[j], (double) use.getValue() * fixed.count());
            }
        }
        MPConstraint carsConstraint = solver.makeConstraint(exactCars, exactCars, "cars");
        MPConstraint wasteConstraint = solver.makeConstraint(0, wasteCap, "waste");
        MPObjective objective = solver.objective();
        for (int j = 0; j < n; j++) {
            FixedColumn fixed = columns.get(j);
            carsConstraint.setCoefficient(y[j], fixed.count());
            wasteConstraint.setCoefficient(y[j],
                    (double) fixed.count() * (totalWidth - fixed.column().patternWidth()));
            objective.setCoefficient(y[j], 1.0 + (fixed.count() % 2 != 0 ? oddWeight : 0.0));
        }
        objective.setMinimization();
        MPSolver.ResultStatus status = solver.solve();
        if (status != MPSolver.ResultStatus.OPTIMAL) {
            log.warn("UnifiedSP fixed-length LP relaxation returned {}", status);
            return new LpDuals(Map.of(), 0, 0, Double.NaN, status.toString());
        }
        Map<String, Double> demandDuals = new LinkedHashMap<>();
        for (Map.Entry<String, MPConstraint> e : demandConstraints.entrySet()) {
            demandDuals.put(e.getKey(), e.getValue().dualValue());
        }
        log.info("UnifiedSP fixed-length LP: columns={} objective={} (组数下界) carsDual={} wasteDual={}",
                n, objective.value(), carsConstraint.dualValue(), wasteConstraint.dualValue());
        return new LpDuals(demandDuals, carsConstraint.dualValue(), wasteConstraint.dualValue(),
                objective.value(), status.toString());
    }
}
