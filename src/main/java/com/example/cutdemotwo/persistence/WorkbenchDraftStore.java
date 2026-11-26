package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.contracts.jobs.WorkbenchSchemeDraft;

import java.util.List;
import java.util.Optional;

/** 工作台待人工确认草案持久化存储接口；与实物库存台账及库存 revision 完全解耦。 */
public interface WorkbenchDraftStore extends AutoCloseable {

    WorkbenchSchemeDraft save(WorkbenchSchemeDraft draft);

    Optional<WorkbenchSchemeDraft> find(String draftId);

    List<WorkbenchSchemeDraft> listByTask(String taskId);

    @Override
    default void close() {}
}
