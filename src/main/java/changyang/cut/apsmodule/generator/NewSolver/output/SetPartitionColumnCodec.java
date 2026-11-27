package changyang.cut.apsmodule.generator.NewSolver.output;

import changyang.cut.apsmodule.generator.NewSolver.config.SolverParameters;
import changyang.cut.apsmodule.generator.NewSolver.mip.UnifiedSetPartitionSolver.Column;
import changyang.cut.apsmodule.generator.NewSolver.mip.UnifiedSetPartitionSolver.ColumnUse;
import changyang.cut.apsmodule.service.CuttingInstruction;
import changyang.cut.apsmodule.service.StationAssignment;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * SetPartitionRefiner 的指令与列编解码、归并排序及度量统计支持。
 */
final class SetPartitionColumnCodec {

    static final int SMALL_MAX_CARS = 5;

    record UseMetrics(int groups, int odd, int one, int small, int cars, int waste) {
    }

    private SetPartitionColumnCodec() {
    }

    static int compareMetrics(UseMetrics first, UseMetrics second) {
        int groups = Integer.compare(first.groups(), second.groups());
        if (groups != 0) {
            return groups;
        }
        int odd = Integer.compare(first.odd(), second.odd());
        if (odd != 0) {
            return odd;
        }
        int one = Integer.compare(first.one(), second.one());
        return one != 0 ? one : Integer.compare(first.small(), second.small());
    }

    static UseMetrics metrics(List<ColumnUse> uses, int totalWidth) {
        int cars = 0;
        int waste = 0;
        int odd = 0;
        int one = 0;
        int small = 0;
        for (ColumnUse use : uses) {
            cars += use.count();
            waste += use.count() * (totalWidth - use.column().patternWidth());
            if (use.count() % 2 != 0) {
                odd++;
            }
            if (use.count() == 1) {
                one++;
            }
            if (use.count() <= SMALL_MAX_CARS) {
                small++;
            }
        }
        return new UseMetrics(uses.size(), odd, one, small, cars, waste);
    }

    static Map<String, Integer> producedDemand(List<ColumnUse> uses) {
        Map<String, Integer> produced = new LinkedHashMap<>();
        for (ColumnUse use : uses) {
            for (Map.Entry<String, Integer> demandUse : use.column().demandUse().entrySet()) {
                produced.merge(demandUse.getKey(), use.count() * demandUse.getValue(), Integer::sum);
            }
        }
        return produced;
    }

    /** 花型实际母卷宽：pw 向上取整到 stepSize 并截到 [minRollWidth, maxRollWidth]。 */
    static int rollWidthFor(int patternWidth, SolverParameters params) {
        int step = Math.max(1, params.getStepSize());
        int rollWidth = (patternWidth + step - 1) / step * step;
        rollWidth = Math.max(rollWidth, params.getMinRollWidth());
        return Math.min(rollWidth, params.getMaxRollWidth());
    }

    /** 指令 → 列使用：按卷重放工位序号，连续同配置卷合并为一个块。 */
    static List<ColumnUse> extractColumnUses(List<CuttingInstruction> instructions) {
        List<ColumnUse> uses = new ArrayList<>();
        for (CuttingInstruction instruction : instructions) {
            if (instruction.getSubRolls() == null || instruction.getSubRolls().isEmpty()
                    || instruction.getStationAssignments() == null) {
                return null;
            }
            Map<Integer, ArrayDeque<String>> buckets = new LinkedHashMap<>();
            for (StationAssignment assignment : instruction.getStationAssignments()) {
                if (assignment.getMessageText() == null || assignment.getMessageText().isBlank()) {
                    return null;
                }
                buckets.computeIfAbsent(assignment.getWidth(), k -> new ArrayDeque<>())
                        .add(assignment.getMessageText());
            }
            String previousSig = null;
            Column previousColumn = null;
            int run = 0;
            for (int roll = 0; roll < instruction.getUsageCount(); roll++) {
                Map<Integer, List<String>> config = new TreeMap<>();
                for (Map.Entry<Integer, Integer> e : new TreeMap<>(instruction.getSubRolls()).entrySet()) {
                    List<String> messages = new ArrayList<>();
                    ArrayDeque<String> bucket = buckets.get(e.getKey());
                    for (int s = 0; s < e.getValue(); s++) {
                        if (bucket == null || bucket.isEmpty()) {
                            return null;
                        }
                        messages.add(bucket.poll());
                    }
                    config.put(e.getKey(), messages);
                }
                Column column = Column.of(instruction.getSubRolls(), config);
                String sig = column.signature();
                if (sig.equals(previousSig)) {
                    run++;
                } else {
                    if (run > 0) {
                        uses.add(new ColumnUse(previousColumn, run));
                    }
                    previousSig = sig;
                    previousColumn = column;
                    run = 1;
                }
            }
            if (run > 0) {
                uses.add(new ColumnUse(previousColumn, run));
            }
        }
        return uses;
    }

    /** 同签名块合并（c1+c2 恒不劣）+ 车数降序排定，作为最终块序。 */
    static List<ColumnUse> coalesceBySignature(List<ColumnUse> uses) {
        Map<String, ColumnUse> bySig = new LinkedHashMap<>();
        for (ColumnUse use : uses) {
            bySig.merge(use.column().signature(), use,
                    (a, b) -> new ColumnUse(a.column(), a.count() + b.count()));
        }
        List<ColumnUse> merged = new ArrayList<>(bySig.values());
        merged.sort(Comparator.comparingInt((ColumnUse u) -> -u.count())
                .thenComparing(u -> u.column().signature()));
        return merged;
    }

    /** 列使用 → 指令：一块一指令，工位序号按卷×宽度×工位铺开。 */
    static List<CuttingInstruction> toInstructions(List<ColumnUse> uses,
            CuttingInstruction template, SolverParameters params) {
        int totalWidth = params.getTotalWidth();
        List<CuttingInstruction> out = new ArrayList<>();
        for (ColumnUse use : uses) {
            CuttingInstruction instruction = new CuttingInstruction();
            instruction.setGroupKey(template.getGroupKey());
            instruction.setRollWidth(rollWidthFor(use.column().patternWidth(), params));
            instruction.setLength(template.getLength());
            instruction.setSurfaceTreatment(template.getSurfaceTreatment());
            instruction.setThickness(template.getThickness());
            instruction.setSubRolls(new LinkedHashMap<>(use.column().pattern()));
            instruction.setUsageCount(use.count());
            instruction.setPatternWidth(use.column().patternWidth());
            instruction.setWaste(totalWidth - use.column().patternWidth());
            List<StationAssignment> assignments = new ArrayList<>();
            for (int roll = 0; roll < use.count(); roll++) {
                for (Map.Entry<Integer, List<String>> e : use.column().config().entrySet()) {
                    for (String message : e.getValue()) {
                        assignments.add(new StationAssignment(e.getKey(), message));
                    }
                }
            }
            instruction.setStationAssignments(assignments);
            out.add(instruction);
        }
        return out;
    }
}
