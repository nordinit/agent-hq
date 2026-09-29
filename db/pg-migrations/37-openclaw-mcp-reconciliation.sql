CREATE TABLE openclaw_mcp_reconciliation (
  target_key TEXT NOT NULL,
  agent_id BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  desired_revision TEXT NOT NULL,
  applied_revision TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'failed')),
  receipt_json TEXT,
  error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (target_key, agent_id)
);

-- Configuration changes and their pending work commit together. Store identifiers,
-- never credentials. Conservative fan-out also covers removals and team inheritance.
CREATE TABLE openclaw_mcp_sync_queue (
  agent_id BIGINT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error TEXT
);
CREATE FUNCTION enqueue_openclaw_mcp_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO openclaw_mcp_sync_queue (agent_id)
    SELECT id FROM agents WHERE runtime_type = 'openclaw' AND deleted_at IS NULL
  ON CONFLICT (agent_id) DO UPDATE SET revision = openclaw_mcp_sync_queue.revision + 1,
    attempts = 0, retry_at = now(), error = NULL;
  RETURN NULL;
END;
$$;
CREATE TRIGGER openclaw_mcp_assignment_changed AFTER INSERT OR UPDATE OR DELETE ON agent_mcp_assignments
  FOR EACH STATEMENT EXECUTE FUNCTION enqueue_openclaw_mcp_sync();
CREATE TRIGGER openclaw_mcp_policy_changed AFTER INSERT OR UPDATE OR DELETE ON agent_mcp_capability_policies
  FOR EACH STATEMENT EXECUTE FUNCTION enqueue_openclaw_mcp_sync();
CREATE TRIGGER openclaw_mcp_server_changed AFTER INSERT OR UPDATE OR DELETE ON mcp_servers
  FOR EACH STATEMENT EXECUTE FUNCTION enqueue_openclaw_mcp_sync();
CREATE TRIGGER openclaw_mcp_team_assignment_changed AFTER INSERT OR UPDATE OR DELETE ON team_mcp_assignments
  FOR EACH STATEMENT EXECUTE FUNCTION enqueue_openclaw_mcp_sync();
CREATE TRIGGER openclaw_mcp_team_member_changed AFTER INSERT OR UPDATE OR DELETE ON team_members
  FOR EACH STATEMENT EXECUTE FUNCTION enqueue_openclaw_mcp_sync();
CREATE TRIGGER openclaw_mcp_team_changed AFTER UPDATE OF enabled, deleted_at ON teams
  FOR EACH STATEMENT EXECUTE FUNCTION enqueue_openclaw_mcp_sync();
CREATE TRIGGER openclaw_mcp_agent_created AFTER INSERT ON agents
  FOR EACH STATEMENT EXECUTE FUNCTION enqueue_openclaw_mcp_sync();
CREATE TRIGGER openclaw_mcp_agent_changed AFTER UPDATE OF workspace_path, openclaw_agent_id, runtime_type, session_key, enabled, deleted_at ON agents
  FOR EACH STATEMENT EXECUTE FUNCTION enqueue_openclaw_mcp_sync();
