package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.config.OperationAuditService;
import com.example.cutdemotwo.config.OperationAuditStore;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 全站操作审计检索控制器（仅管理员访问）：支持按单据、操作人、主体类型、动作与时间范围分页检索。
 */
@RestController
@RequestMapping("/api/v2/audit-logs")
public class AuditLogController {
    private final OperationAuditService auditService;

    public AuditLogController(OperationAuditService auditService) {
        this.auditService = auditService;
    }

    @GetMapping
    public OperationAuditStore.AuditPage query(
            @RequestParam(value = "actor", required = false) String actor,
            @RequestParam(value = "actorType", required = false) String actorType,
            @RequestParam(value = "action", required = false) String action,
            @RequestParam(value = "targetType", required = false) String targetType,
            @RequestParam(value = "targetId", required = false) String targetId,
            @RequestParam(value = "outcome", required = false) String outcome,
            @RequestParam(value = "from", required = false) Long from,
            @RequestParam(value = "to", required = false) Long to,
            @RequestParam(value = "page", defaultValue = "0") int page,
            @RequestParam(value = "size", defaultValue = "20") int size
    ) {
        return auditService.query(new OperationAuditStore.AuditQuery(
                actor, actorType, action, targetType, targetId, outcome, from, to, page, size
        ));
    }
}
