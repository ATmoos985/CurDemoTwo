CREATE TABLE demand_template (
    id VARCHAR(128) PRIMARY KEY,
    sort_order BIGINT NOT NULL,
    dimension VARCHAR(32) NOT NULL,
    material_model VARCHAR(255),
    data_json LONGTEXT NOT NULL
);

CREATE TABLE scheduling_scheme (
    id VARCHAR(128) PRIMARY KEY,
    sort_order BIGINT NOT NULL,
    task_id VARCHAR(128),
    roll_id VARCHAR(128),
    state VARCHAR(32) NOT NULL,
    dimension VARCHAR(32) NOT NULL,
    data_json LONGTEXT NOT NULL
);
CREATE INDEX idx_scheme_task ON scheduling_scheme(task_id, state);
CREATE INDEX idx_scheme_roll ON scheduling_scheme(roll_id, state);
