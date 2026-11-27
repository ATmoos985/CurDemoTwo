CREATE TABLE sys_user (
    username VARCHAR(64) PRIMARY KEY,
    display_name VARCHAR(128) NOT NULL,
    role VARCHAR(32) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    token_version BIGINT NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    last_login_at BIGINT,
    password_updated_at BIGINT
);
CREATE INDEX idx_sys_user_role_enabled ON sys_user(role, enabled);

CREATE TABLE sys_token_revocation (
    jti VARCHAR(128) PRIMARY KEY,
    actor_type VARCHAR(16) NOT NULL,
    subject_id VARCHAR(128) NOT NULL,
    reason VARCHAR(128),
    revoked_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
);
CREATE INDEX idx_token_revocation_expires ON sys_token_revocation(expires_at);
CREATE INDEX idx_token_revocation_subject ON sys_token_revocation(actor_type, subject_id);

CREATE TABLE sys_agent_credential (
    agent_id VARCHAR(128) PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    owner_username VARCHAR(64) NOT NULL,
    scopes_json LONGTEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    token_version BIGINT NOT NULL DEFAULT 1,
    description VARCHAR(512),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    expires_at BIGINT,
    revoked_at BIGINT,
    last_used_at BIGINT
);
CREATE INDEX idx_agent_owner_enabled ON sys_agent_credential(owner_username, enabled);

CREATE TABLE operation_audit_log (
    id VARCHAR(128) PRIMARY KEY,
    occurred_at BIGINT NOT NULL,
    actor VARCHAR(128) NOT NULL,
    actor_type VARCHAR(16) NOT NULL,
    actor_role VARCHAR(32),
    agent_id VARCHAR(128),
    action VARCHAR(64) NOT NULL,
    target_type VARCHAR(64),
    target_id VARCHAR(128),
    http_method VARCHAR(16),
    request_path VARCHAR(256),
    outcome VARCHAR(16) NOT NULL,
    http_status INTEGER,
    trace_id VARCHAR(64),
    client_ip VARCHAR(64),
    detail_json LONGTEXT
);
CREATE INDEX idx_audit_occurred_at ON operation_audit_log(occurred_at);
CREATE INDEX idx_audit_actor_time ON operation_audit_log(actor, occurred_at);
CREATE INDEX idx_audit_action_time ON operation_audit_log(action, occurred_at);
CREATE INDEX idx_audit_target_time ON operation_audit_log(target_type, target_id, occurred_at);
CREATE INDEX idx_audit_actor_type_time ON operation_audit_log(actor_type, occurred_at);
