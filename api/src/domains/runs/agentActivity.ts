import type { RequestHandler } from 'express';
import type { Db } from '../../db/adapter/types';
import { getDb } from '../../db/client';
import { parseAgentRunIdentity, type AgentRunIdentity } from '../../lib/agentRunIdentity';
import type { McpApiIdentity } from '../../lib/mcpApiAuth';

/** Serialized on the instance row, the same lock the watchdog takes to expire it. */
export async function recordAgentActivity(
  db: Db,
  identity: Pick<McpApiIdentity, 'agentId' | 'tenantId'>,
  run: AgentRunIdentity,
): Promise<boolean> {
  const result = await db.run(`
    UPDATE job_instances ji
    SET first_agent_call_at = COALESCE(first_agent_call_at, to_char(clock_timestamp() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS.MS')),
        last_agent_call_at = to_char(clock_timestamp() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS.MS')
    WHERE ji.id = ? AND ji.durable_run_id = ? AND ji.agent_id = ? AND ji.tenant_id = ?
      AND ji.status IN ('queued', 'dispatched', 'running') AND ji.stop_requested_at IS NULL
      AND (ji.task_id IS NULL OR EXISTS (
        SELECT 1 FROM tasks t WHERE t.id = ji.task_id AND t.tenant_id = ji.tenant_id
          AND t.active_instance_id = ji.id
      ))
  `, run.instanceId, run.durableRunId, identity.agentId, identity.tenantId);
  return result.changes > 0;
}

/** Install after authentication and scope authorization; operator calls never count. */
export const recordInboundAgentActivity: RequestHandler = (req, _res, next) => {
  const identity = req.mcpIdentity;
  const run = parseAgentRunIdentity(req.get('x-agent-hq-instance-id'), req.get('x-agent-hq-durable-run-id'));
  // MCP discovery/preflight is server startup, not an agent executing a tool.
  if (!identity || !run || req.path.startsWith('/mcp/')) return next();
  void recordAgentActivity(getDb(), identity, run).then(() => next(), next);
};
