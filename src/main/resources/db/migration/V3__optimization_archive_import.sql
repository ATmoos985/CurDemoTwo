CREATE TABLE optimization_archive_import (
    id VARCHAR(64) PRIMARY KEY,
    source_path LONGTEXT NOT NULL,
    imported_at BIGINT NOT NULL,
    job_count INTEGER NOT NULL
);
CREATE TABLE optimization_archive_entry (
    import_id VARCHAR(64) NOT NULL,
    job_id VARCHAR(36) NOT NULL UNIQUE,
    original_json LONGTEXT NOT NULL,
    PRIMARY KEY (import_id, job_id),
    FOREIGN KEY (import_id) REFERENCES optimization_archive_import(id),
    FOREIGN KEY (job_id) REFERENCES optimization_job(id)
);
