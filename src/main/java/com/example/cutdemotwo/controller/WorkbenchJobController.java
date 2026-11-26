package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.business.cutting.WorkbenchJobContextService;
import com.example.cutdemotwo.business.optimization.OptimizationService;
import com.example.cutdemotwo.config.AuthContext;
import com.example.cutdemotwo.contracts.jobs.OptimizationJob;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.io.InputStream;
import java.net.URI;
import java.util.UUID;

@RestController
@RequestMapping("/api/v2/workbench")
public class WorkbenchJobController {
    private final WorkbenchJobContextService sources;

    public WorkbenchJobController(WorkbenchJobContextService sources) { this.sources = sources; }

    /** Principal is assigned by the security filter. The anonymous owner is independent of its session cookie. */
    public static String actor(HttpServletRequest request) {
        var principal = AuthContext.current();
        if (principal == null) throw new OptimizationService.Failure("UNAUTHORIZED", "缺少工作台身份", 401, false);
        if (principal.authenticated()) return "user:" + principal.username();
        var session = request.getSession();
        synchronized (session) {
            var key = "cutdemo.workbench.owner";
            String owner = (String) session.getAttribute(key);
            if (owner == null) {
                owner = "local:" + UUID.randomUUID();
                session.setAttribute(key, owner);
            }
            return owner;
        }
    }

    @PostMapping(value = "/tasks/{taskId}/optimization-jobs", consumes = "application/json")
    public ResponseEntity<WorkbenchJobContextService.Accepted> submit(@PathVariable String taskId,
            @RequestHeader(value = "Idempotency-Key", required = false) String key,
            HttpServletRequest request, InputStream body) {
        var input = OptimizationController.decode(body, WorkbenchJobContextService.Submission.class);
        var accepted = sources.submit(taskId, actor(request), key, input);
        return ResponseEntity.accepted().location(URI.create("/api/v2/optimization-jobs/" + accepted.job().id()))
                .header("Retry-After", "1").body(accepted);
    }
}
