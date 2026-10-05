-- Persist maintenance progress so restarting an API cannot erase uncertainty or retry limits.
-- Revisions are internal content digests; no MCP configuration or credentials are stored here.
ALTER TABLE openclaw_mcp_reconciliation
  ADD COLUMN materialized_revision TEXT,
  ADD COLUMN metadata_revision TEXT,
  ADD COLUMN runtime_revision TEXT,
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN retry_at TIMESTAMPTZ,
  ADD COLUMN recovery_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN operation_phase TEXT NOT NULL DEFAULT 'prepared'
    CHECK (operation_phase IN ('prepared', 'refresh', 'reload', 'verified'));

-- Old rows have no operation-phase evidence. Preserve uncertainty on upgrade.
UPDATE openclaw_mcp_reconciliation SET operation_phase = 'verified' WHERE state = 'applied';
UPDATE openclaw_mcp_reconciliation SET recovery_required = true, operation_phase = 'reload'
  WHERE state IN ('pending', 'failed');
