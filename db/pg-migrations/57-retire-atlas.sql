-- Retire the built-in Atlas assistant. Setup help now comes from Claude or ChatGPT connected over
-- MCP, so nothing creates, looks up or chats with Atlas any more.
--
-- Each Atlas row (system_role 'atlas') is soft-deleted the way the product archives an agent that
-- history still references: its tool, MCP and assignment-rule links go, it is disabled, its
-- session key moves under deleted:<id>: and deleted_at is set. Its runs, chats and task history
-- stay readable. Its MCP keys are revoked, and system_role is cleared so no 'atlas' marker remains.
CREATE TEMPORARY TABLE retired_atlas_agents ON COMMIT DROP AS
  SELECT id, session_key FROM agents.agents WHERE system_role = 'atlas';

DELETE FROM agents.agent_tool_assignments WHERE agent_id IN (SELECT id FROM retired_atlas_agents);
DELETE FROM agents.agent_mcp_assignments WHERE agent_id IN (SELECT id FROM retired_atlas_agents);
DELETE FROM workflow.workflow_task_routing_rules WHERE agent_id IN (SELECT id FROM retired_atlas_agents);

UPDATE access.mcp_api_keys
SET enabled = 0,
    revoked_at = COALESCE(revoked_at, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')),
    updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
WHERE agent_id IN (SELECT id FROM retired_atlas_agents);

UPDATE agents.agents a
SET enabled = 0,
    status = 'idle',
    system_role = NULL,
    openclaw_agent_id = NULL,
    session_key = CASE
      WHEN r.session_key LIKE 'deleted:' || a.id || ':%' THEN r.session_key
      ELSE 'deleted:' || a.id || ':' || COALESCE(NULLIF(trim(r.session_key), ''), 'agent:' || a.id)
    END,
    deleted_at = COALESCE(a.deleted_at, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
FROM retired_atlas_agents r
WHERE a.id = r.id;
