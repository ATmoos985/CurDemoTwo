package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.algorithm.api.NestingSolver;
import com.example.cutdemotwo.contracts.jobs.OptimizationRequest;
import com.example.cutdemotwo.contracts.jobs.OptimizationResult.*;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import java.util.*;
import java.util.function.BiFunction;
import java.util.function.Consumer;
import java.util.function.Function;

/** Bounded fixed-width contour trials; misses are heuristics, never infeasibility proofs. */
final class MarkerOptimization {
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(MarkerOptimization.class);
    record Outcome(NestingResult layout, MarkerReport marker, String failureCode) {}

    static void validate(OptimizationRequest input) {
        var strategy = input.strategy();
        if (strategy == null) return;
        if (!"marker-shortening".equals(strategy.id()) || !("1".equals(strategy.version()) || "2".equals(strategy.version())))
            throw new OptimizationService.Failure("UNSUPPORTED_CONSTRAINT", "不支持的编排策略或版本", 422, false);
        if (strategy.maxTrials() < 1 || strategy.maxTrials() > 12)
            throw new OptimizationService.Failure("INVALID_INPUT", "唛架试排次数必须为 1–12", 400, false);
        if (!Boolean.TRUE.equals(input.requireComplete()) || !"CONTOUR".equals(input.nestingProblem().process().mode())
                || !"RECTANGLE".equals(input.nestingProblem().material().shape().type()))
            throw new OptimizationService.Failure("UNSUPPORTED_CONSTRAINT", "唛架缩长要求矩形门幅、轮廓工艺及完整齐套", 422, false);
        var limits = strategy.gapFillLimits();
        if (limits != null) {
            var ids = new HashSet<Integer>();
            input.nestingProblem().parts().forEach(part -> ids.add(part.id()));
            if (!"2".equals(strategy.version()) || limits.isEmpty() || limits.size() > 80 ||
                    !ids.containsAll(limits.keySet()) || limits.values().stream().anyMatch(n -> n == null || n < 1 || n > 80))
                throw new OptimizationService.Failure("INVALID_INPUT", "补片限额须使用策略 2 的现有裁片，每种为 1–80 片，最多 80 种", 400, false);
        }
    }

    static Outcome solve(OptimizationRequest input, NestingSolver factory, Consumer<String> progress) {
        return solve(input, factory::solve, factory, progress);
    }

    // Test seam uses the same independently validated NestingSolver result contract.
    static Outcome solve(OptimizationRequest input, BiFunction<NestingProblem, Boolean, NestingResult> solve,
                         Consumer<String> progress) {
        return solve(input, solve, null, progress);
    }

    private static Outcome solve(OptimizationRequest input, BiFunction<NestingProblem, Boolean, NestingResult> solve,
                                 NestingSolver refiner, Consumer<String> progress) {
        validate(input);
        var original = input.nestingProblem();
        long started = System.nanoTime();
        boolean compact = "2".equals(input.strategy().version()) && refiner != null
                && input.strategy().maxTrials() > 1 && original.timeLimitSeconds() > 1;
        Optional<Function<NestingProblem, NestingResult>> strip = Optional.empty();
        if (compact && input.strategy().maxTrials() >= 3 && original.timeLimitSeconds() >= 5)
            strip = refiner.stripSearch(original, input.allowFallback());
        long jobDeadline = started + original.timeLimitSeconds() * 1_000_000_000L;
        long fillBudget = input.strategy().gapFillLimits() != null && original.timeLimitSeconds() >= 6 ? 1_000_000_000L : 0;
        long deadline = jobDeadline - fillBudget;
        long budget = deadline - started - ((compact ? 1 : 0) + (strip.isPresent() ? 3 : 0)) * 1_000_000_000L;
        int searchTrials = input.strategy().maxTrials() - (compact ? 1 : 0) - (strip.isPresent() ? 1 : 0);
        double high = original.height();
        // Rotated parts may use their shorter dimension along the feed direction.
        double low = Math.max(original.parts().stream().mapToDouble(p ->
                        p.allowRotation() ? Math.min(p.shape().height(), p.shape().width()) : p.shape().height()).max().orElse(0),
                original.parts().stream().mapToDouble(p -> p.shape().areaMm2() * p.quantity()).sum() / original.width());
        // Preserve every exclusion in every trial; never silently drop a defect beyond a shorter window.
        low = Math.max(low, original.material().exclusions().stream()
                .mapToDouble(e -> e.y() + .1).max().orElse(0));
        NestingResult best = null, latest = null;
        NestingProblem bestProblem = null;
        Double firstLength = null;
        double bestLength = Double.POSITIVE_INFINITY;
        String failureCode = null;
        var history = new ArrayList<Trial>();
        for (int i = 0; i < searchTrials; i++) {
            if (Thread.currentThread().isInterrupted() || System.nanoTime() - started >= budget) break;
            double length = i == 0 ? high : Math.ceil((low + high) / 2 * 10) / 10;
            int seconds = Math.max(1, (int)((budget - (System.nanoTime() - started)) / 1_000_000_000L
                    / (searchTrials - i)));
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
                if (best == null || occupied < bestLength) { best = latest; bestLength = occupied; bestProblem = candidate; }
                high = Math.min(length, occupied);
            } else {
                if (best == null || !"FEASIBLE".equals(latest.status()) && !"NO_SOLUTION_FOUND".equals(latest.status())) break;
                low = length;
            }
            if (high - low <= 10) break;
        }
        int stripSeconds = (int)Math.min(3, (deadline - System.nanoTime() - 1_000_000_000L) / 1_000_000_000L);
        if (strip.isPresent() && latest != null && !"CANCELLED".equals(latest.status()) && failureCode == null
                && !Thread.currentThread().isInterrupted() && stripSeconds >= 1) {
            var candidate = new NestingProblem(original.schemaVersion(), original.unit(), original.material(), original.parts(),
                    original.process(), original.engine(), stripSeconds);
            progress.accept("固定门幅，直接搜索更短的齐套唛架");
            var direct = strip.get().apply(candidate);
            boolean all = complete(direct);
            Double occupied = all ? direct.placements().stream().mapToDouble(p -> p.y() + p.shape().height()).max().orElse(0) : null;
            history.add(new Trial(history.size() + 1, candidate.height(), occupied, direct.status(), all,
                    direct.placements().size(), stripSeconds, direct.elapsedMs(), direct.engine(), direct.engineVersion(), "STRIP_SEARCH"));
            if (all && occupied < bestLength) {
                if (firstLength == null) firstLength = occupied;
                best = direct; bestLength = occupied; bestProblem = candidate;
            }
        }
        if (compact && best != null && failureCode == null && !Thread.currentThread().isInterrupted() && System.nanoTime() < deadline) {
            progress.accept("压紧齐套裁片，复核实际唛架长度");
            long start = System.nanoTime();
            try {
                var refinement = refiner.compactMarker(bestProblem, best, Math.min(deadline, start + 1_000_000_000L));
                if (refinement.isPresent()) {
                    var refined = refinement.get();
                    double occupied = refined.placements().stream().mapToDouble(p -> p.y() + p.shape().height()).max().orElse(0);
                    if (complete(refined) && occupied < bestLength) { best = refined; bestLength = occupied; }
                    history.add(new Trial(history.size() + 1, bestProblem.height(), bestLength, best.status(), true,
                            best.placements().size(), 1, (System.nanoTime() - start) / 1_000_000, best.engine(), best.engineVersion(), "COMPACTION"));
                }
            } catch (java.util.concurrent.CancellationException stopped) {
                // Preserve the complete validated incumbent when the refinement is interrupted.
                Thread.currentThread().interrupt();
            } catch (RuntimeException failed) {
                log.warn("Marker compaction failed; keeping the verified incumbent", failed);
            }
        }
        var chosen = best != null ? best : latest;
        if (chosen == null) chosen = NestingResult.failure("CANCELLED", "试排开始前已停止", original.engine(), original.engine(), null, 0);
        List<NestingResult.Placement> extras = null;
        if (input.strategy().gapFillLimits() != null && best != null && refiner != null && failureCode == null
                && !Thread.currentThread().isInterrupted() && System.nanoTime() < jobDeadline) {
            progress.accept("在齐套唛架空隙内试排同款备片");
            try {
                extras = refiner.fillMarkerGaps(bestProblem, best, input.strategy().gapFillLimits(),
                        Math.min(jobDeadline, System.nanoTime() + 1_000_000_000L));
            } catch (java.util.concurrent.CancellationException stopped) {
                Thread.currentThread().interrupt();
            } catch (RuntimeException failed) {
                log.warn("Marker gap fill failed; keeping the verified complete kit", failed);
            }
        }
        return new Outcome(chosen, new MarkerReport(input.strategy().version(), firstLength, best == null ? null : bestLength,
                chosen.processingRegion() == null ? original.height() : chosen.processingRegion().height(), history, false, extras), failureCode);
    }

    static boolean complete(NestingResult layout) {
        return layout.feasible() && !layout.fulfillment().isEmpty()
                && layout.fulfillment().stream().allMatch(row -> row.requested() == row.placed());
    }
}
