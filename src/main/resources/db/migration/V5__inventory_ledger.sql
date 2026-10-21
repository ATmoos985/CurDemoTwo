CREATE TABLE inventory_ledger (
    id VARCHAR(128) PRIMARY KEY,
    entry_sequence BIGINT NOT NULL UNIQUE,
    transaction_id VARCHAR(128) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    aggregate_type VARCHAR(32) NOT NULL,
    aggregate_id VARCHAR(256) NOT NULL,
    occurred_at BIGINT NOT NULL,
    data_json LONGTEXT NOT NULL
);
CREATE INDEX idx_ledger_aggregate ON inventory_ledger(aggregate_type,aggregate_id,entry_sequence);
CREATE INDEX idx_ledger_transaction ON inventory_ledger(transaction_id);
