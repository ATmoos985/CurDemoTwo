CREATE TABLE inventory_outbox (
    id VARCHAR(128) PRIMARY KEY,
    event_sequence BIGINT NOT NULL UNIQUE,
    inventory_revision BIGINT NOT NULL,
    data_json LONGTEXT NOT NULL
);
CREATE TABLE integration_delivery (
    consumer_id VARCHAR(128) PRIMARY KEY,
    version BIGINT NOT NULL,
    data_json LONGTEXT NOT NULL
);
