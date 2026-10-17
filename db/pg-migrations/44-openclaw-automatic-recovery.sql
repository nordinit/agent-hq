CREATE TABLE openclaw_mcp_recovery (
  id BIGSERIAL PRIMARY KEY,
  target_key TEXT NOT NULL,
  agent_id BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'recovering' CHECK (state IN ('recovering', 'attention', 'resolved')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes',
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL,
  resolved_at TIMESTAMPTZ,
  escalation_notification_id BIGINT REFERENCES notification_records(id),
  resolution_notification_id BIGINT REFERENCES notification_records(id)
);
CREATE UNIQUE INDEX openclaw_mcp_recovery_active ON openclaw_mcp_recovery(target_key, agent_id) WHERE resolved_at IS NULL;
CREATE TABLE openclaw_mcp_recovery_tasks (
  recovery_id BIGINT NOT NULL REFERENCES openclaw_mcp_recovery(id) ON DELETE CASCADE,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (recovery_id, task_id)
);
CREATE TABLE notification_deliveries (
  id BIGSERIAL PRIMARY KEY,
  notification_id BIGINT NOT NULL REFERENCES notification_records(id) ON DELETE CASCADE,
  outlet TEXT NOT NULL CHECK (outlet = 'telegram'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent', 'disabled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_token TEXT,
  lease_until TIMESTAMPTZ,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  UNIQUE (notification_id, outlet)
);
CREATE INDEX notification_deliveries_pending ON notification_deliveries(next_attempt_at, id) WHERE state IN ('pending', 'sending');
-- Preserve the age of existing failures: deployment must not restart their deadline.
INSERT INTO openclaw_mcp_recovery (target_key, agent_id, started_at, deadline_at, last_error)
SELECT target_key, agent_id, updated_at, updated_at + interval '10 minutes',
  COALESCE(error, 'MCP configuration update was interrupted')
FROM openclaw_mcp_reconciliation
WHERE state = 'failed' OR (state = 'pending' AND operation_phase IN ('refresh', 'reload'));
