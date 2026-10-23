CREATE TABLE inventory_count (
    id VARCHAR(128) PRIMARY KEY,
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    posted_at BIGINT NOT NULL,
    inventory_revision BIGINT NOT NULL,
    data_json LONGTEXT NOT NULL
);
