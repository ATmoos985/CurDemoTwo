ALTER TABLE workbench_scheme_draft ADD COLUMN batch_group_id VARCHAR(128);
ALTER TABLE workbench_scheme_draft ADD COLUMN sequence_index INTEGER;
ALTER TABLE workbench_scheme_draft ADD COLUMN confirmed_scheme_id VARCHAR(128);
ALTER TABLE workbench_scheme_draft ADD COLUMN confirmed_by VARCHAR(128);
ALTER TABLE workbench_scheme_draft ADD COLUMN confirmed_at BIGINT;
ALTER TABLE workbench_scheme_draft ADD COLUMN discarded_by VARCHAR(128);
ALTER TABLE workbench_scheme_draft ADD COLUMN discarded_at BIGINT;
ALTER TABLE workbench_scheme_draft ADD COLUMN discard_reason VARCHAR(512);
ALTER TABLE workbench_scheme_draft ADD COLUMN updated_at BIGINT;

CREATE INDEX idx_workbench_draft_status_expires ON workbench_scheme_draft(status, expires_at);
CREATE INDEX idx_workbench_draft_batch ON workbench_scheme_draft(batch_group_id, sequence_index);
CREATE INDEX idx_workbench_draft_status_issued ON workbench_scheme_draft(status, issued_at);
