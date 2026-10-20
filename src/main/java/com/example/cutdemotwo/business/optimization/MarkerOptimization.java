package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.algorithm.solver.SolverFactory;
import com.example.cutdemotwo.contracts.jobs.OptimizationRequest;
import com.example.cutdemotwo.contracts.jobs.OptimizationResult.*;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import java.util.*;
import java.util.function.BiFunction;
import java.util.function.Consumer;

/** Bounded fixed-width contour trials; misses are heuristics, never infeasibility proofs. */
final class MarkerOptimization {
    record Outcome(NestingResult layout, MarkerReport marker, String failureCode) {}

    static void validate(OptimizationRequest input) {
        var strategy = input.strategy();
        if (strategy == null) return;
        if (!"marker-shortening".equals(strategy.id()) || !"1".equals(strategy.version()))
            throw new OptimizationService.Failure("UNSUPPORTED_CONSTRAINT", "不支持的编排策略或版本", 422, false);
        if (strategy.maxTrials() < 1 || strategy.maxTrials() > 12)
            throw new OptimizationService.Failure("INVALID_INPUT", "唛架试排次数必须为 1–12", 400, false);
        if (!Boolean.TRUE.equals(input.requireComplete()) || !"CONTOUR".equals(input.problem().process().mode())
                || !"RECTANGLE".equals(input.problem().material().shape().type()))
            throw new OptimizationService.Failure("UNSUPPORTED_CONSTRAINT", "唛架缩长要求矩形门幅、轮廓工艺及完整齐套", 422, false);
    }

    static Outcome solve(OptimizationRequest input, SolverFactory factory, Consumer<String> progress) {
        return solve(input, factory::solve, progress);
    }

    // Test seam uses the same independently validated SolverFactory result contract.
    static Outcome solve(OptimizationRequest input, BiFunction<NestingProblem, Boolean, NestingResult> solve,
                         Consumer<String> progress) {
        validate(input);
        var original = input.problem();
        long started = System.nanoTime(), budget = original.timeLimitSeconds() * 1_000_000_000L;
        double high = original.height();
        // Rotated parts may use their shorter dimension along the feed direction.
        double low = Math.max(original.parts().stream().mapToDouble(p ->
                        p.allowRotation() ? Math.min(p.shape().height(), p.shape().width()) : p.shape().height()).max().orElse(0),
                original.parts().stream().mapToDouble(p -> p.shape().areaMm2() * p.quantity()).sum() / original.width());
        // Preserve every exclusion in every trial; never silently drop a defect beyond a shorter window.
        low = Math.max(low, original.material().exclusions().stream()
                .mapToDouble(e -> e.y() + .1).max().orElse(0));
        NestingResult best = null, latest = null;
        Double firstLength = null;
        double bestLength = Double.POSITIVE_INFINITY;
        String failureCode = null;
        var history = new ArrayList<Trial>();
        for (int i = 0; i < input.strategy().maxTrials(); i++) {
            if (Thread.currentThread().isInterrupted() || System.nanoTime() - started >= budget) break;
            double length = i == 0 ? high : Math.ceil((low + high) / 2 * 10) / 10;
            int seconds = Math.max(1, (int)((budget - (System.nanoTime() - started)) / 1_000_000_000L
                    / (input.strategy().maxTrials() - i)));
            var candidate = new NestingProblem(original.schemaVersion(), original.unit(),
                    new NestingProblem.Material(original.material().id(), NestingProblem.Shape.rectangle(original.width(), length),
                            original.material().exclusions(), original.material().continuesAfterRegion()),
                    original.parts(), original.process(), original.engine(), seconds);
            progress.accept("试排 " + (i + 1) + " / " + input.strategy().maxTrials() + "，长度 " + length + " mm");
            latest = solve.apply(candidate, input.allowFallback());
            boolean complete = complete(latest);
            double occupied = latest.placements().stream().mapToDouble(p -> p.y() + p.shape().height()).max().orElse(0);
            history.add(new Trial(i+1, length, complete ? occupied : null, latest.status(), complete,
                    latest.placements().size(), seconds, latest.elapsedMs(), latest.engine(), latest.engineVersion()));
            if (!Set.of("FEASIBLE", "NO_SOLUTION_FOUND", "CANCELLED").contains(latest.status())) failureCode = latest.status();
            if (complete) {
                if (firstLength == null) firstLength = occupied;
                if (best == null || occupied < bestLength) { best = latest; bestLength = occupied; }
                high = Math.min(length, occupied);
            } else {
                if (best == null || !"FEASIBLE".equals(latest.status()) && !"NO_SOLUTION_FOUND".equals(latest.status())) break;
                low = length;
            }
            if (high - low <= 10) break;
        }
        var chosen = best != null ? best : latest;
        if (chosen == null) chosen = NestingResult.failure("CANCELLED", "试排开始前已停止", original.engine(), original.engine(), null, 0);
        return new Outcome(chosen, new MarkerReport("1", firstLength, best == null ? null : bestLength,
                chosen.processingRegion() == null ? original.height() : chosen.processingRegion().height(), history, false), failureCode);
    }

    static boolean complete(NestingResult layout) {
        return layout.feasible() && !layout.fulfillment().isEmpty()
                && layout.fulfillment().stream().allMatch(row -> row.requested() == row.placed());
    }
}
