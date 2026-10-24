-- MCP configuration edits now enqueue only the OpenClaw agents whose effective configuration they
-- can change. Migration 37 enqueued every OpenClaw agent on any edit, and after an API restart or
-- gateway reconnect each sync is a gateway-wide plugins.reload: one server credential change
-- reloaded ~18 agents, invalidated in-flight sessions and retained ~700 MB of gateway heap.
DROP TRIGGER openclaw_mcp_assignment_changed ON agent_mcp_assignments;
DROP TRIGGER openclaw_mcp_policy_changed ON agent_mcp_capability_policies;
DROP TRIGGER openclaw_mcp_server_changed ON mcp_servers;
DROP TRIGGER openclaw_mcp_team_assignment_changed ON team_mcp_assignments;
DROP TRIGGER openclaw_mcp_team_member_changed ON team_members;
DROP TRIGGER openclaw_mcp_team_changed ON teams;
DROP TRIGGER openclaw_mcp_agent_created ON agents;
DROP TRIGGER openclaw_mcp_agent_changed ON agents;
DROP FUNCTION enqueue_openclaw_mcp_sync();

CREATE FUNCTION enqueue_openclaw_mcp_sync_agents(agent_ids BIGINT[]) RETURNS void LANGUAGE sql AS $$
  INSERT INTO openclaw_mcp_sync_queue (agent_id)
    SELECT id FROM agents WHERE id = ANY(agent_ids) AND runtime_type = 'openclaw' AND deleted_at IS NULL
  ON CONFLICT (agent_id) DO UPDATE SET revision = openclaw_mcp_sync_queue.revision + 1,
    attempts = 0, retry_at = now(), error = NULL;
$$;

-- Assignment, capability policy and team membership rows each name the one agent they configure.
CREATE FUNCTION enqueue_openclaw_mcp_sync_for_agent_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM enqueue_openclaw_mcp_sync_agents(ARRAY[NEW.agent_id]);
  ELSIF TG_OP = 'DELETE' THEN PERFORM enqueue_openclaw_mcp_sync_agents(ARRAY[OLD.agent_id]);
  ELSE PERFORM enqueue_openclaw_mcp_sync_agents(ARRAY[OLD.agent_id, NEW.agent_id]);
  END IF;
  RETURN NULL;
END;
$$;

-- A team's servers reach every member; a disabled member or team is resynced so it loses them.
CREATE FUNCTION enqueue_openclaw_mcp_sync_for_team(team_ids BIGINT[]) RETURNS void LANGUAGE sql AS $$
  SELECT enqueue_openclaw_mcp_sync_agents(ARRAY(SELECT agent_id FROM team_members WHERE team_id = ANY(team_ids)));
$$;

CREATE FUNCTION enqueue_openclaw_mcp_sync_for_team_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM enqueue_openclaw_mcp_sync_for_team(ARRAY[NEW.team_id]);
  ELSIF TG_OP = 'DELETE' THEN PERFORM enqueue_openclaw_mcp_sync_for_team(ARRAY[OLD.team_id]);
  ELSE PERFORM enqueue_openclaw_mcp_sync_for_team(ARRAY[OLD.team_id, NEW.team_id]);
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION enqueue_openclaw_mcp_sync_for_team_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM enqueue_openclaw_mcp_sync_for_team(ARRAY[NEW.id]);
  RETURN NULL;
END;
$$;

-- Same reach as findAgentIdsWithEffectiveMcpServer(). A deleted server's assignments cascade and
-- enqueue through their own triggers.
CREATE FUNCTION enqueue_openclaw_mcp_sync_for_server() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE server_id BIGINT := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
BEGIN
  PERFORM enqueue_openclaw_mcp_sync_agents(ARRAY(
    SELECT agent_id FROM agent_mcp_assignments WHERE mcp_server_id = server_id
    UNION
    SELECT tm.agent_id FROM team_mcp_assignments tma
      JOIN teams te ON te.id = tma.team_id
      JOIN team_members tm ON tm.team_id = te.id
    WHERE tma.mcp_server_id = server_id AND tma.enabled = 1 AND tm.enabled = 1
      AND te.enabled = 1 AND te.deleted_at IS NULL));
  RETURN NULL;
END;
$$;

-- MCP credentials require a workspace owned by one agent, so moving an agent can unblock or block
-- the agents on its old and new workspace.
CREATE FUNCTION enqueue_openclaw_mcp_sync_for_agent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM enqueue_openclaw_mcp_sync_agents(ARRAY(
      SELECT id FROM agents WHERE id = NEW.id OR workspace_path = NEW.workspace_path));
  ELSE
    PERFORM enqueue_openclaw_mcp_sync_agents(ARRAY(
      SELECT id FROM agents WHERE id = NEW.id OR workspace_path IN (OLD.workspace_path, NEW.workspace_path)));
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER openclaw_mcp_assignment_written AFTER INSERT OR DELETE ON agent_mcp_assignments
  FOR EACH ROW EXECUTE FUNCTION enqueue_openclaw_mcp_sync_for_agent_row();
CREATE TRIGGER openclaw_mcp_assignment_changed AFTER UPDATE ON agent_mcp_assignments
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION enqueue_openclaw_mcp_sync_for_agent_row();
CREATE TRIGGER openclaw_mcp_policy_written AFTER INSERT OR DELETE ON agent_mcp_capability_policies
  FOR EACH ROW EXECUTE FUNCTION enqueue_openclaw_mcp_sync_for_agent_row();
CREATE TRIGGER openclaw_mcp_policy_changed AFTER UPDATE ON agent_mcp_capability_policies
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION enqueue_openclaw_mcp_sync_for_agent_row();
CREATE TRIGGER openclaw_mcp_team_member_written AFTER INSERT OR DELETE ON team_members
  FOR EACH ROW EXECUTE FUNCTION enqueue_openclaw_mcp_sync_for_agent_row();
CREATE TRIGGER openclaw_mcp_team_member_changed AFTER UPDATE ON team_members
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION enqueue_openclaw_mcp_sync_for_agent_row();
CREATE TRIGGER openclaw_mcp_team_assignment_written AFTER INSERT OR DELETE ON team_mcp_assignments
  FOR EACH ROW EXECUTE FUNCTION enqueue_openclaw_mcp_sync_for_team_assignment();
CREATE TRIGGER openclaw_mcp_team_assignment_changed AFTER UPDATE ON team_mcp_assignments
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION enqueue_openclaw_mcp_sync_for_team_assignment();
CREATE TRIGGER openclaw_mcp_team_changed AFTER UPDATE OF enabled, deleted_at ON teams
  FOR EACH ROW WHEN (OLD.enabled IS DISTINCT FROM NEW.enabled OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION enqueue_openclaw_mcp_sync_for_team_row();
CREATE TRIGGER openclaw_mcp_server_written AFTER INSERT OR DELETE ON mcp_servers
  FOR EACH ROW EXECUTE FUNCTION enqueue_openclaw_mcp_sync_for_server();
CREATE TRIGGER openclaw_mcp_server_changed AFTER UPDATE ON mcp_servers
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION enqueue_openclaw_mcp_sync_for_server();
CREATE TRIGGER openclaw_mcp_agent_created AFTER INSERT ON agents
  FOR EACH ROW EXECUTE FUNCTION enqueue_openclaw_mcp_sync_for_agent();
CREATE TRIGGER openclaw_mcp_agent_changed AFTER UPDATE OF workspace_path, openclaw_agent_id, runtime_type, session_key, enabled, deleted_at ON agents
  FOR EACH ROW WHEN (OLD.workspace_path IS DISTINCT FROM NEW.workspace_path
    OR OLD.openclaw_agent_id IS DISTINCT FROM NEW.openclaw_agent_id OR OLD.runtime_type IS DISTINCT FROM NEW.runtime_type
    OR OLD.session_key IS DISTINCT FROM NEW.session_key OR OLD.enabled IS DISTINCT FROM NEW.enabled
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION enqueue_openclaw_mcp_sync_for_agent();
