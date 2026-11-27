package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.contracts.jobs.WorkbenchSchemeDraft;

import java.util.List;
import java.util.Optional;
import java.util.function.UnaryOperator;

/** 工作台待人工确认草案持久化存储接口；与实物库存台账及库存 revision 完全解耦。 */
public interface WorkbenchDraftStore extends AutoCloseable {

    record DraftQuery(
            String status,
            String taskId,
            String batchGroupId,
            int page,
            int size
    ) {}

    record DraftPage(
            List<WorkbenchSchemeDraft> items,
            long total,
            int page,
            int size,
            long pendingCount
    ) {}

    enum TransitionOutcome {
        UPDATED,
        NOT_FOUND,
        EXPIRED,
        CONFLICT_STATE
    }

    record TransitionResult(
            TransitionOutcome outcome,
            WorkbenchSchemeDraft draft
    ) {}

    WorkbenchSchemeDraft save(WorkbenchSchemeDraft draft);

    List<WorkbenchSchemeDraft> saveAll(List<WorkbenchSchemeDraft> drafts);

    Optional<WorkbenchSchemeDraft> find(String draftId);

    List<WorkbenchSchemeDraft> listByTask(String taskId);

    DraftPage query(DraftQuery query, long nowMs);

    TransitionResult transitionFromPending(String draftId, long nowMs, UnaryOperator<WorkbenchSchemeDraft> updater);

    int expireAndPurge(long nowMs, long purgeBeforeMs);

    List<String> listCleanupCandidateIds(long nowMs, long purgeBeforeMs);

    int expireOrPurgeSingle(String draftId, long nowMs, long purgeBeforeMs);

    @Override
    default void close() {}
}
