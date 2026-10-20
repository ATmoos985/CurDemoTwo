CREATE TABLE execution_order (
    id VARCHAR(128) PRIMARY KEY,
    sort_order BIGINT NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    plan_id VARCHAR(128) NOT NULL,
    task_id VARCHAR(128) NOT NULL,
    material_type VARCHAR(16) NOT NULL,
    material_id VARCHAR(128) NOT NULL,
    state VARCHAR(32) NOT NULL,
    version BIGINT NOT NULL,
    expires_at BIGINT,
    data_json LONGTEXT NOT NULL
);
CREATE INDEX idx_execution_material ON execution_order(material_type, material_id, state);
CREATE INDEX idx_execution_task ON execution_order(task_id, state);
CREATE INDEX idx_execution_plan ON execution_order(plan_id);
