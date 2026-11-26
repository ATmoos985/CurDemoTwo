package com.example.cutdemotwo.contracts.jobs;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/** 工作台待人工确认的持久化排料草案契约；创建与查询绝不修改或锁扣任何实物库存。 */
public record WorkbenchSchemeDraft(
        String id,
        String draftId,
        String status,
        String approvalToken,
        String contentHash,
        String issuedAt,
        String expiresAt,
        long ttlSeconds,
        boolean requiresHumanConfirmation,
        boolean inventoryMutated,
        boolean stale,
        List<String> staleReasons,
        Target target,
        List<RiskCheck> riskChecks,
        String workbenchUrl,
        String nextStep,
        @JsonInclude(JsonInclude.Include.NON_NULL) String note,
        @JsonInclude(JsonInclude.Include.NON_NULL) Long snapshotTaskRevision,
        @JsonInclude(JsonInclude.Include.NON_NULL) Long snapshotMaterialRevision
) {
    public static final String STATUS_PENDING_CONFIRMATION = "PENDING_CONFIRMATION";
    public static final String STATUS_EXPIRED = "EXPIRED";

    public WorkbenchSchemeDraft {
        staleReasons = staleReasons == null ? List.of() : List.copyOf(staleReasons);
        riskChecks = riskChecks == null ? List.of() : List.copyOf(riskChecks);
    }

    public record Target(
            String resultId,
            @JsonInclude(JsonInclude.Include.NON_NULL) String taskId,
            @JsonInclude(JsonInclude.Include.NON_NULL) String materialId,
            @JsonInclude(JsonInclude.Include.NON_NULL) String materialType
    ) {}

    public record RiskCheck(
            String code,
            boolean passed,
            String message
    ) {}

    /** 按实时核验结果返回更新后的状态视图，绝不改变草案原始内容哈希与人工确认门控标志。 */
    public WorkbenchSchemeDraft withEvaluatedState(String nextStatus, boolean nextStale, List<String> nextStaleReasons) {
        return new WorkbenchSchemeDraft(
                id,
                draftId,
                nextStatus,
                approvalToken,
                contentHash,
                issuedAt,
                expiresAt,
                ttlSeconds,
                true,
                false,
                nextStale,
                nextStaleReasons == null ? List.of() : List.copyOf(nextStaleReasons),
                target,
                riskChecks,
                workbenchUrl,
                nextStep,
                note,
                snapshotTaskRevision,
                snapshotMaterialRevision
        );
    }
}
