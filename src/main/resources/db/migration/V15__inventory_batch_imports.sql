CREATE TABLE inventory_batch_import (
    id VARCHAR(128) PRIMARY KEY,
    import_type VARCHAR(32) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    request_hash VARCHAR(64) NOT NULL,
    posted_at BIGINT NOT NULL,
    inventory_revision BIGINT NOT NULL,
    data_json LONGTEXT NOT NULL
);
CREATE INDEX idx_batch_import_type_rev ON inventory_batch_import(import_type, inventory_revision);
