package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.business.cutting.WorkbenchJobContextService;
import com.example.cutdemotwo.contracts.jobs.*;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import com.example.cutdemotwo.persistence.OptimizationJobStore;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class WorkbenchComparisonTests {
    private static final String TASK = "cut-order-1";
    private static final WorkbenchJobSource SOURCE = source("roll-1", 0);

    private static WorkbenchJobSource source(String roll, double start) {
        return new WorkbenchJobSource(TASK, "planner", 1, "STOCK_ROLL", roll, 11, 100, start, 250, 5, Map.of(1, 17));
    }

    private static StoredOptimizationJob archived(String id, int placed, double lastY, boolean allowRotation, boolean extra) {
        var padded = NestingProblem.Shape.rectangle(35, 25);
        var region = NestingProblem.Shape.rectangle(105, 255);
        var problem = new NestingProblem("1", "mm", new NestingProblem.Material("CANVAS", region, List.of(), false),
                List.of(new NestingProblem.Part(1, "左前片", padded, 2, allowRotation)),
                new NestingProblem.Process("GUILLOTINE", "SHEET", "left-top", "horizontal", 0, 20, 20, 0, "INPUT_ORDER"), "auto", 2);
        var input = new OptimizationRequest("2.0", "NESTING_2D", "request", problem, false, false);
        var placements = new java.util.ArrayList<NestingResult.Placement>();
        if (placed >= 1) placements.add(new NestingResult.Placement(1, 1, "左前片", 0, lastY, padded, 0));
        if (placed == 2) placements.add(new NestingResult.Placement(2, 1, "左前片", 0, 0, padded, 0));
        var layout = new NestingResult("1", "mm", "source-local-top-left", "FEASIBLE", "", "test", "1", 1,
                "CANVAS", region, placements, List.of(), List.of(),
                List.of(new NestingResult.Fulfillment(1, 2, placed, 2 - placed, "")), null, List.of(), "auto", null);
        var marker = extra ? new OptimizationResult.MarkerReport("1", 100d, 110d, 250, List.of(), false,
                List.of(new NestingResult.Placement(3, 1, "补片", 0, 90, padded, 0))) : null;
        var result = new OptimizationResult(id, id, "hash-" + id, "2.0", "PASSED",
                placed == 0 ? "NONE" : placed == 2 ? "COMPLETE" : "PARTIAL", true, "COMPLETED",
                List.of(new OptimizationResult.Metric("processingAreaUtilization", 25, "%", 500, 2000, "window", "1")), layout, marker);
        String now = Instant.now().toString();
        var job = new OptimizationJob(id, "2.0", "request", result.inputHash(), "SUCCEEDED", "VERIFY", now, now, now, 3, id, null, null);
        return new StoredOptimizationJob("key-" + id, input, job, result, SOURCE);
    }

    @Test void completeRectanglesUsePhysicalExtentsAndKeepMetricDefinitions() {
        var left = archived("a", 2, 40, false, false);
        var right = archived("b", 2, 60, false, false);
        var actual = WorkbenchComparisonService.compareArchives(TASK, SOURCE, left, SOURCE, right);
        assertEquals("COMPARABLE", actual.lengthComparison().status());
        assertEquals("a", actual.lengthComparison().shorterResultId());
        assertEquals(20d, actual.lengthComparison().savedLengthMm());
        assertEquals(60d, actual.left().occupiedLengthMm());
        assertEquals(80d, actual.right().occupiedLengthMm());
        assertEquals(17, actual.left().demands().get(0).sourceLineId());
        assertEquals("左前片", actual.left().demands().get(0).name());
        // Two real 30 x 20 mm pieces in a 100 x 250 mm physical window, not the padded 35 x 25 pieces.
        assertEquals(1200d, actual.metricDeltas().get(0).left().numerator());
        assertEquals(25000d, actual.metricDeltas().get(0).left().denominator());
        assertEquals(4.8d, actual.metricDeltas().get(0).left().value());
        assertEquals(25d, left.result().metrics().get(0).value()); // Raw archive remains unchanged.
        var tied = WorkbenchComparisonService.compareArchives(TASK, SOURCE, left, SOURCE, archived("b", 2, 40, false, false));
        assertEquals(0d, tied.lengthComparison().savedLengthMm());
        assertNull(tied.lengthComparison().shorterResultId());
    }

    @Test void emptyLayoutKeepsEveryRequestedPieceMissingAndHasNoLength() {
        var actual = WorkbenchComparisonService.compareArchives(TASK, SOURCE, archived("a", 0, 0, false, false),
                SOURCE, archived("b", 2, 60, false, false));
        assertEquals("NONE", actual.left().fulfillmentStatus());
        assertEquals(2, actual.left().demands().get(0).unplaced());
        assertNull(actual.left().occupiedLengthMm());
        assertEquals(0d, actual.left().metrics().get(0).numerator());
        assertNull(actual.lengthComparison().savedLengthMm());
    }

    @Test void differentCompletionRequirementsRemainExplicitEvenIfBothLayoutsAreComplete() {
        var a = archived("a", 2, 40, false, false);
        var b = archived("b", 2, 60, false, false);
        var base = b.input();
        var strict = new OptimizationRequest(base.schemaVersion(), base.problemType(), base.clientRequestId(),
                base.problem(), base.allowFallback(), true, base.strategy());
        var other = new StoredOptimizationJob(b.idempotencyKey(), strict, b.job(), b.result(), SOURCE);
        var actual = WorkbenchComparisonService.compareArchives(TASK, SOURCE, a, SOURCE, other);
        assertEquals(List.of("requireComplete"), actual.constraintDifferences());
        assertEquals("DIFFERENT_CONSTRAINTS", actual.lengthComparison().status());
        assertNull(actual.lengthComparison().savedLengthMm());
    }

    @Test void incompleteKitDoesNotEarnCreditFromSpareOrClaimSavings() {
        var comparison = WorkbenchComparisonService.compareArchives(TASK, SOURCE, archived("a", 1, 10, false, true),
                SOURCE, archived("b", 2, 45, false, false));
        assertEquals(110d, comparison.left().occupiedLengthMm());
        assertEquals(1, comparison.left().placed());
        assertEquals(1, comparison.left().demands().get(0).unplaced());
        assertEquals("INCOMPLETE", comparison.lengthComparison().status());
        assertNull(comparison.lengthComparison().savedLengthMm());
    }

    @Test void differentRealRollOrWindowBlocksDeltasEvenWithIdenticalCanvasInputs() {
        for (var other : List.of(source("roll-2", 0), source("roll-1", 500))) {
            var comparison = WorkbenchComparisonService.compareArchives(TASK, SOURCE, archived("a", 2, 40, false, false),
                    other, archived("b", 2, 60, false, false));
            assertFalse(comparison.sameConstraints());
            assertTrue(comparison.constraintDifferences().contains(other.windowStartMm() == 0 ? "context.materialId" : "context.windowStartMm"));
            assertEquals("DIFFERENT_CONTEXT", comparison.lengthComparison().status());
            assertNull(comparison.lengthComparison().savedLengthMm());
            assertNull(comparison.metricDeltas().get(0).delta());
        }
    }

    @Test void differentRotationRulesSuppressLengthAndMetricDeltas() {
        var comparison = WorkbenchComparisonService.compareArchives(TASK, SOURCE, archived("a", 2, 30, false, false),
                SOURCE, archived("b", 2, 40, true, false));
        assertTrue(comparison.constraintDifferences().contains("problem.parts"));
        assertEquals("DIFFERENT_CONSTRAINTS", comparison.lengthComparison().status());
        assertNull(comparison.lengthComparison().savedLengthMm());
        assertNull(comparison.metricDeltas().get(0).delta());
    }

    @Test void authorizationForBothArchivesPrecedesReadAndDrawingChecksItsOwnScope() {
        var jobs = mock(OptimizationService.class);
        var contexts = mock(WorkbenchJobContextService.class);
        var service = new WorkbenchComparisonService(jobs, contexts);
        when(contexts.authorize(TASK, "a", "planner")).thenReturn(SOURCE);
        when(contexts.authorize(TASK, "b", "planner")).thenThrow(new OptimizationService.Failure("NOT_FOUND", "不可见", 404, false));
        assertEquals(400, assertThrows(OptimizationService.Failure.class, () -> service.compare(TASK, "a", "a", "planner")).status);
        assertEquals(404, assertThrows(OptimizationService.Failure.class, () -> service.compare(TASK, "a", "b", "planner")).status);
        assertEquals(404, assertThrows(OptimizationService.Failure.class, () -> service.drawing(TASK, "b", "planner")).status);
        verifyNoInteractions(jobs);
        when(jobs.workbenchArchive("a")).thenReturn(archived("a", 2, 40, false, false));
        var drawing = service.drawing(TASK, "a", "planner");
        assertEquals(5d, drawing.rectGapPaddingMm());
        assertEquals("hash-a", drawing.result().inputHash());
    }

    @Test void expiredArchiveIsRejectedBeforePeriodicCleanupAndSlittingIsUnsupported() {
        var doc = archived("a", 2, 40, false, false);
        var oldJob = new OptimizationJob("old", "2.0", "request", "hash", "SUCCEEDED", "VERIFY",
                Instant.EPOCH.toString(), Instant.EPOCH.toString(), Instant.EPOCH.toString(), 2, "old", null, null);
        var old = new StoredOptimizationJob("old-key", doc.input(), oldJob, doc.result());
        var slitting = new OptimizationRequest("2.0", "SLITTING_1D", "", null, false, true);
        var other = new StoredOptimizationJob("1d-key", slitting, doc.job(), doc.result());
        var store = mock(OptimizationJobStore.class);
        when(store.load()).thenReturn(List.of(old, other));
        try (var jobs = new OptimizationService(null, null, store, 1, 1, 4)) {
            assertEquals(404, assertThrows(OptimizationService.Failure.class, () -> jobs.workbenchArchive("old")).status);
            assertEquals(400, assertThrows(OptimizationService.Failure.class, () -> jobs.workbenchArchive("a")).status);
        }
    }
}
