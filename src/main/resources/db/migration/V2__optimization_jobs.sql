CREATE TABLE optimization_dispatch (
    id INTEGER PRIMARY KEY,
    worker_limit INTEGER,
    queue_limit INTEGER,
    archive_limit INTEGER
);
INSERT INTO optimization_dispatch (id) VALUES (1);

CREATE TABLE optimization_job (
    id VARCHAR(36) PRIMARY KEY,
    key_digest VARCHAR(64) NOT NULL UNIQUE,
    state VARCHAR(32) NOT NULL,
    created_at BIGINT NOT NULL,
    token BIGINT NOT NULL,
    owner_id VARCHAR(64),
    lease_until BIGINT,
    deadline_at BIGINT,
    document_json LONGTEXT NOT NULL
);
CREATE INDEX idx_optimization_queue ON optimization_job(state, created_at);
CREATE TABLE optimization_attempt (
    job_id VARCHAR(36) NOT NULL,
    token BIGINT NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    started_at BIGINT NOT NULL,
    finished_at BIGINT,
    outcome VARCHAR(32) NOT NULL,
    PRIMARY KEY (job_id, token),
    FOREIGN KEY (job_id) REFERENCES optimization_job(id)
);
CREATE TABLE optimization_result (
    job_id VARCHAR(36) PRIMARY KEY,
    token BIGINT NOT NULL,
    result_json LONGTEXT NOT NULL,
    FOREIGN KEY (job_id, token) REFERENCES optimization_attempt(job_id, token)
);
