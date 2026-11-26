CREATE TABLE quality_release_document (
    id VARCHAR(128) PRIMARY KEY,
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    remnant_id VARCHAR(128) NOT NULL,
    decision VARCHAR(32) NOT NULL,
    posted_at BIGINT NOT NULL,
    inventory_revision BIGINT NOT NULL,
    data_json LONGTEXT NOT NULL
);
CREATE INDEX idx_quality_release_remnant ON quality_release_document(remnant_id);

CREATE TABLE inventory_receipt_document (
    id VARCHAR(128) PRIMARY KEY,
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    supplier_name VARCHAR(255) NOT NULL,
    delivery_note_no VARCHAR(128) NOT NULL,
    posted_at BIGINT NOT NULL,
    inventory_revision BIGINT NOT NULL,
    data_json LONGTEXT NOT NULL
);
CREATE INDEX idx_inventory_receipt_delivery ON inventory_receipt_document(delivery_note_no);

CREATE TABLE material_issue_document (
    id VARCHAR(128) PRIMARY KEY,
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    direction VARCHAR(32) NOT NULL,
    roll_id VARCHAR(128) NOT NULL,
    machine_id VARCHAR(128),
    posted_at BIGINT NOT NULL,
    inventory_revision BIGINT NOT NULL,
    data_json LONGTEXT NOT NULL
);
CREATE INDEX idx_material_issue_roll ON material_issue_document(roll_id);
