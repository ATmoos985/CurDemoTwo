package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.business.workbench.WorkbenchComparisonService;
import com.example.cutdemotwo.business.workbench.WorkbenchDraftService;
import com.example.cutdemotwo.business.workbench.WorkbenchPlanOrchestrator;
import com.example.cutdemotwo.config.AuthContext;
import com.example.cutdemotwo.config.TraceIdFilter;
import com.example.cutdemotwo.contracts.jobs.OptimizationFailure;
import com.example.cutdemotwo.contracts.jobs.WorkbenchComparison;
import com.example.cutdemotwo.contracts.jobs.WorkbenchSchemeDraft;
import org.slf4j.MDC;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.net.URI;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 工作台编排求解、同口径双方案对比、结果上下文与持久化待确认草案控制器。
 * 全接口均不修改或扣减任何实物库存。
 */
@RestController
@RequestMapping("/api/v2/workbench")
public class WorkbenchOrchestrationController {

    private final WorkbenchPlanOrchestrator orchestrator;
    private final WorkbenchComparisonService comparisonService;
    private final WorkbenchDraftService draftService;

    public WorkbenchOrchestrationController(
            WorkbenchPlanOrchestrator orchestrator,
            WorkbenchComparisonService comparisonService,
            WorkbenchDraftService draftService
    ) {
        this.orchestrator = orchestrator;
        this.comparisonService = comparisonService;
        this.draftService = draftService;
    }

    /** 1) 按任务剩余待排量与指定材料一键装配并提交 2D/1D 试排作业（返回 202）。 */
    @PostMapping(value = "/tasks/{taskId}/plan-jobs", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<WorkbenchPlanOrchestrator.PlanJobAccepted> submitPlanJob(
            @PathVariable String taskId,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody(required = false) WorkbenchPlanOrchestrator.PlanTaskRequest body
    ) {
        String actor = AuthContext.username();
        WorkbenchPlanOrchestrator.PlanJobAccepted accepted = orchestrator.submitPlanJob(taskId, body, idempotencyKey, actor);
        return ResponseEntity.accepted()
                .location(URI.create("/api/v2/optimization-jobs/" + accepted.job().id()))
                .header("Retry-After", "1")
                .body(accepted);
    }

    /** 2) 同口径比较同一任务下的两份已归档排料结果（返回 200）。 */
    @GetMapping("/tasks/{taskId}/result-comparison")
    public WorkbenchComparison compareResults(
            @PathVariable String taskId,
            @RequestParam(defaultValue = "") String leftId,
            @RequestParam(defaultValue = "") String rightId
    ) {
        return comparisonService.compare(taskId, leftId, rightId);
    }

    /** 3) 查询归档结果的完整工作台上下文，供前端深链载入与 MCP 渲染预览（返回 200）。 */
    @GetMapping("/results/{resultId}/context")
    public WorkbenchComparisonService.ResultContext getResultContext(@PathVariable String resultId) {
        return comparisonService.getResultContext(resultId);
    }

    /** 4) 创建持久化待人工确认草案（绝不扣减实物库存，返回 201）。 */
    @PostMapping(value = "/drafts", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<WorkbenchSchemeDraft> createDraft(
            @RequestBody(required = false) WorkbenchDraftService.CreateDraftRequest body
    ) {
        WorkbenchSchemeDraft draft = draftService.createDraft(body);
        return ResponseEntity.created(URI.create("/api/v2/workbench/drafts/" + draft.draftId()))
                .body(draft);
    }

    /** 5) 查询持久化草案并动态重算过期（EXPIRED）与库存/任务版本漂移（stale）（返回 200）。 */
    @GetMapping("/drafts/{draftId}")
    public WorkbenchSchemeDraft getDraft(@PathVariable String draftId) {
        return draftService.getDraft(draftId);
    }

    @ExceptionHandler(OptimizationFailure.class)
    public ResponseEntity<Map<String, Object>> handleFailure(OptimizationFailure error) {
        String traceId = MDC.get(TraceIdFilter.MDC_KEY);
        if (traceId == null || traceId.isBlank()) {
            traceId = UUID.randomUUID().toString();
        }
        var builder = ResponseEntity.status(error.status)
                .contentType(MediaType.APPLICATION_JSON)
                .header("Cache-Control", "no-store");
        if (error.retryable) {
            builder.header("Retry-After", "1");
        }
        return builder.body(Map.of(
                "code", error.code,
                "message", error.getMessage(),
                "fieldErrors", List.of(),
                "traceId", traceId,
                "retryable", error.retryable,
                "details", Map.of()
        ));
    }
}
