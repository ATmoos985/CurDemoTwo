package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.business.optimization.WorkbenchComparisonService;
import com.example.cutdemotwo.contracts.jobs.OptimizationResult;
import com.example.cutdemotwo.contracts.jobs.WorkbenchComparison;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v2/workbench/tasks/{taskId}")
public class WorkbenchComparisonController {
    private final WorkbenchComparisonService comparisons;

    public WorkbenchComparisonController(WorkbenchComparisonService comparisons) {
        this.comparisons = comparisons;
    }

    @GetMapping("/result-comparison")
    public ResponseEntity<WorkbenchComparison> compare(@PathVariable String taskId, @RequestParam String leftId,
            @RequestParam String rightId, HttpServletRequest request) {
        var comparison = comparisons.compare(taskId, leftId, rightId, WorkbenchJobController.actor(request));
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(comparison);
    }

    @GetMapping("/results/{resultId}")
    public ResponseEntity<OptimizationResult> drawing(@PathVariable String taskId, @PathVariable String resultId,
            HttpServletRequest request) {
        var drawing = comparisons.drawing(taskId, resultId, WorkbenchJobController.actor(request));
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .header("X-Rect-Gap-Padding-Mm", Double.toString(drawing.rectGapPaddingMm())).body(drawing.result());
    }
}
