CREATE TABLE cutdemo_revision (
    id INTEGER PRIMARY KEY,
    revision BIGINT NOT NULL,
    remnant_seq INTEGER NOT NULL,
    defect_seq INTEGER NOT NULL
);
INSERT INTO cutdemo_revision (id, revision, remnant_seq, defect_seq) VALUES (1, 0, 10, 20);

CREATE TABLE mother_roll (
    id VARCHAR(128) PRIMARY KEY,
    sort_order BIGINT NOT NULL,
    material_model VARCHAR(255),
    remaining_mm DOUBLE NOT NULL,
    used_mm DOUBLE NOT NULL,
    data_json LONGTEXT NOT NULL
);
CREATE TABLE remnant_stock (
    id VARCHAR(128) PRIMARY KEY,
    sort_order BIGINT NOT NULL,
    source_roll_id VARCHAR(128),
    parent_remnant_id VARCHAR(128),
    status VARCHAR(32) NOT NULL,
    width_mm DOUBLE NOT NULL,
    length_mm DOUBLE NOT NULL,
    data_json LONGTEXT NOT NULL
);
CREATE INDEX idx_remnant_source ON remnant_stock(source_roll_id);
CREATE INDEX idx_remnant_parent ON remnant_stock(parent_remnant_id);
CREATE TABLE cutting_task (
    id VARCHAR(128) PRIMARY KEY,
    sort_order BIGINT NOT NULL,
    revision BIGINT NOT NULL,
    material_model VARCHAR(255) NOT NULL,
    data_json LONGTEXT NOT NULL
);
CREATE TABLE cutting_plan (
    id VARCHAR(128) PRIMARY KEY,
    sort_order BIGINT NOT NULL,
    task_id VARCHAR(128),
    status VARCHAR(32) NOT NULL,
    data_json LONGTEXT NOT NULL
);
CREATE INDEX idx_plan_task ON cutting_plan(task_id, status);
CREATE TABLE cut_report (
    id VARCHAR(128) PRIMARY KEY,
    sort_order BIGINT NOT NULL,
    task_id VARCHAR(128),
    roll_id VARCHAR(128),
    source_remnant_id VARCHAR(128),
    status VARCHAR(32) NOT NULL,
    data_json LONGTEXT NOT NULL
);
CREATE INDEX idx_report_task ON cut_report(task_id);
CREATE INDEX idx_report_roll ON cut_report(roll_id);
