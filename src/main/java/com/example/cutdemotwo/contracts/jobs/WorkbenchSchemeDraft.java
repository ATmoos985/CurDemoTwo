package com.example.cutdemotwo.contracts.jobs;

import com.fasterxml.jackson.annotation.JsonIgnore;
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
        @JsonInclude(JsonInclude.Include.NON_NULL) Long snapshotMaterialRevision,
        @JsonInclude(JsonInclude.Include.NON_NULL) String batchGroupId,
        @JsonInclude(JsonInclude.Include.NON_NULL) Integer batchIndex,
        @JsonInclude(JsonInclude.Include.NON_NULL) Integer batchTotal,
        @JsonInclude(JsonInclude.Include.NON_NULL) String confirmedSchemeId,
        @JsonInclude(JsonInclude.Include.NON_NULL) String confirmedBy,
        @JsonInclude(JsonInclude.Include.NON_NULL) String confirmedAt,
        @JsonInclude(JsonInclude.Include.NON_NULL) String discardedBy,
        @JsonInclude(JsonInclude.Include.NON_NULL) String discardedAt,
        @JsonInclude(JsonInclude.Include.NON_NULL) String discardReason
) {
    public static final String STATUS_PENDING_CONFIRMATION = "PENDING_CONFIRMATION";
    public static final String STATUS_EXPIRED = "EXPIRED";
    public static final String STATUS_CONFIRMED = "CONFIRMED";
    public static final String STATUS_DISCARDED = "DISCARDED";

    public WorkbenchSchemeDraft {
        staleReasons = staleReasons == null ? List.of() : List.copyOf(staleReasons);
        riskChecks = riskChecks == null ? List.of() : List.copyOf(riskChecks);
    }

    /** 向后兼容 19 参构造器。 */
    public WorkbenchSchemeDraft(
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
            String note,
            Long snapshotTaskRevision,
            Long snapshotMaterialRevision
    ) {
        this(
                id,
                draftId,
                status,
                approvalToken,
                contentHash,
                issuedAt,
                expiresAt,
                ttlSeconds,
                requiresHumanConfirmation,
                inventoryMutated,
                stale,
                staleReasons,
                target,
                riskChecks,
                workbenchUrl,
                nextStep,
                note,
                snapshotTaskRevision,
                snapshotMaterialRevision,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null
        );
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

    @JsonIgnore
    public boolean isFinalized() {
        return STATUS_CONFIRMED.equals(status) || STATUS_DISCARDED.equals(status);
    }

    /** 按实时核验结果返回更新后的状态视图；已确认或已作废终态绝不被覆盖为 EXPIRED。 */
    public WorkbenchSchemeDraft withEvaluatedState(String nextStatus, boolean nextStale, List<String> nextStaleReasons) {
        String effectiveStatus = isFinalized() ? this.status : nextStatus;
        boolean effectiveStale = isFinalized() ? false : nextStale;
        List<String> effectiveReasons = isFinalized()
                ? List.of()
                : (nextStaleReasons == null ? List.of() : List.copyOf(nextStaleReasons));
        return new WorkbenchSchemeDraft(
                id,
                draftId,
                effectiveStatus,
                approvalToken,
                contentHash,
                issuedAt,
                expiresAt,
                ttlSeconds,
                true,
                false,
                effectiveStale,
                effectiveReasons,
                target,
                riskChecks,
                workbenchUrl,
                nextStep,
                note,
                snapshotTaskRevision,
                snapshotMaterialRevision,
                batchGroupId,
                batchIndex,
                batchTotal,
                confirmedSchemeId,
                confirmedBy,
                confirmedAt,
                discardedBy,
                discardedAt,
                discardReason
        );
    }

    /** 原子确认落库后的状态快照。 */
    public WorkbenchSchemeDraft withConfirmed(String schemeId, String actor, String confirmedAtIso) {
        return new WorkbenchSchemeDraft(
                id,
                draftId,
                STATUS_CONFIRMED,
                approvalToken,
                contentHash,
                issuedAt,
                expiresAt,
                ttlSeconds,
                true,
                false,
                false,
                List.of(),
                target,
                riskChecks,
                workbenchUrl,
                "草案已确认落库" + (schemeId != null && !schemeId.isBlank() ? "（关联方案 " + schemeId + "）" : "") + "，可在方案与工单页查看履约进度。",
                note,
                snapshotTaskRevision,
                snapshotMaterialRevision,
                batchGroupId,
                batchIndex,
                batchTotal,
                schemeId,
                actor,
                confirmedAtIso,
                null,
                null,
                null
        );
    }

    /** 原子作废后的状态快照（绝不扣减或恢复实物库存）。 */
    public WorkbenchSchemeDraft withDiscarded(String actor, String discardedAtIso, String reason) {
        return new WorkbenchSchemeDraft(
                id,
                draftId,
                STATUS_DISCARDED,
                approvalToken,
                contentHash,
                issuedAt,
                expiresAt,
                ttlSeconds,
                true,
                false,
                false,
                List.of(),
                target,
                riskChecks,
                workbenchUrl,
                "该草案已人工确认作废，仅关闭本次试排建议，未影响任何实物库存。",
                note,
                snapshotTaskRevision,
                snapshotMaterialRevision,
                batchGroupId,
                batchIndex,
                batchTotal,
                confirmedSchemeId,
                confirmedBy,
                confirmedAt,
                actor,
                discardedAtIso,
                reason
        );
    }
}
