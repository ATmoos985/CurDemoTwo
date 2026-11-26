CREATE TABLE workbench_scheme_draft (
    id VARCHAR(128) PRIMARY KEY,
    result_id VARCHAR(128) NOT NULL,
    task_id VARCHAR(128),
    material_type VARCHAR(32),
    material_id VARCHAR(128),
    status VARCHAR(32) NOT NULL,
    issued_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    data_json LONGTEXT NOT NULL
);
CREATE INDEX idx_workbench_draft_result ON workbench_scheme_draft(result_id);
CREATE INDEX idx_workbench_draft_task ON workbench_scheme_draft(task_id, issued_at);
