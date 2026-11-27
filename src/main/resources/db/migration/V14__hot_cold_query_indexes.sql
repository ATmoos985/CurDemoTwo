CREATE TABLE cut_report_task_link (
    report_id VARCHAR(128) NOT NULL,
    task_id VARCHAR(128) NOT NULL,
    PRIMARY KEY (report_id, task_id)
);
CREATE INDEX idx_crtl_task ON cut_report_task_link(task_id, report_id);

CREATE TABLE inventory_transfer_material_link (
    transfer_id VARCHAR(128) NOT NULL,
    material_type VARCHAR(16) NOT NULL,
    material_id VARCHAR(128) NOT NULL,
    PRIMARY KEY (transfer_id, material_type, material_id)
);
CREATE INDEX idx_itml_mat ON inventory_transfer_material_link(material_type, material_id);

CREATE TABLE inventory_count_material_link (
    count_id VARCHAR(128) NOT NULL,
    material_type VARCHAR(16) NOT NULL,
    material_id VARCHAR(128) NOT NULL,
    inventory_revision BIGINT NOT NULL,
    PRIMARY KEY (count_id, material_type, material_id)
);
CREATE INDEX idx_icml_mat ON inventory_count_material_link(material_type, material_id, inventory_revision);

CREATE TABLE inventory_receipt_roll_link (
    receipt_id VARCHAR(128) NOT NULL,
    roll_id VARCHAR(128) NOT NULL,
    PRIMARY KEY (receipt_id, roll_id)
);
CREATE INDEX idx_irrl_roll ON inventory_receipt_roll_link(roll_id);

CREATE INDEX idx_report_status_sort ON cut_report(status, sort_order);
CREATE INDEX idx_transfer_rev_id ON inventory_transfer(inventory_revision, id);
CREATE INDEX idx_count_rev_id ON inventory_count(inventory_revision, id);
CREATE INDEX idx_qrel_rev_id ON quality_release_document(inventory_revision, id);
CREATE INDEX idx_ircv_rev_id ON inventory_receipt_document(inventory_revision, id);
CREATE INDEX idx_miss_rev_id ON material_issue_document(inventory_revision, id);
CREATE INDEX idx_plan_status_sort ON cutting_plan(status, sort_order);
CREATE INDEX idx_exec_state_sort ON execution_order(state, sort_order);
CREATE INDEX idx_scheme_state_sort ON scheduling_scheme(state, sort_order);
CREATE INDEX idx_roll_remaining ON mother_roll(remaining_mm);
CREATE INDEX idx_remnant_status ON remnant_stock(status);

INSERT INTO cut_report_task_link (report_id, task_id)
SELECT id, task_id FROM cut_report WHERE task_id IS NOT NULL AND task_id <> '';
