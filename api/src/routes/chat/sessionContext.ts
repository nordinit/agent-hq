import { getDb } from '../../db/client';
import { resolveAgentRowForSessionKey } from '../../domains/chat/sessions';
import { tableHasColumn } from '../../lib/durableRunIdentity';
import { resolveRuntimeTenantId } from '../../lib/runtimeTenantScope';
import { parseRunSessionKey } from '../../lib/sessionKeys';

export interface SessionContext {
  instanceId: number | null;
  durableRunId: string | null;
  agentId: number;
  sessionKey: string;
  tenantId: number | null;
}

export function resolveSessionContext(sessionKey: string): SessionContext | null {
  try {
    const db = getDb();
    const hook = parseRunSessionKey(sessionKey);
    if (hook) {
      const instanceId = hook.instanceId;
      const hasDurableRunId = tableHasColumn(db, 'job_instances', 'durable_run_id');
      const row = db.prepare(`SELECT agent_id${hasDurableRunId ? ', durable_run_id' : ''} FROM job_instances WHERE id = ?`)
        .get(instanceId) as { agent_id: number; durable_run_id?: string | null } | undefined;
      if (row) {
        return {
          instanceId,
          durableRunId: hook.durableRunId ?? row.durable_run_id ?? null,
          agentId: row.agent_id,
          sessionKey,
          tenantId: resolveRuntimeTenantId(db, { instanceId, agentId: row.agent_id }),
        };
      }
    }

    const hasDurableRunId = tableHasColumn(db, 'job_instances', 'durable_run_id');
    const hasRunStage = tableHasColumn(db, 'job_instances', 'run_stage');
    const row = db.prepare(
      `SELECT id, agent_id${hasDurableRunId ? ', durable_run_id' : ''}
       FROM job_instances
       WHERE session_key = ?${hasRunStage ? " AND COALESCE(run_stage, '') <> 'chat'" : ''}
       ORDER BY id DESC
       LIMIT 1`
    ).get(sessionKey) as { id: number; agent_id: number; durable_run_id?: string | null } | undefined;
    if (row) {
      return {
        instanceId: row.id,
        durableRunId: row.durable_run_id ?? null,
        agentId: row.agent_id,
        sessionKey,
        tenantId: resolveRuntimeTenantId(db, { instanceId: row.id, agentId: row.agent_id }),
      };
    }

    const agentRow = resolveAgentRowForSessionKey(sessionKey) as { id: number } | null;
    if (agentRow) {
      return {
        instanceId: null,
        durableRunId: null,
        agentId: agentRow.id,
        sessionKey,
        tenantId: resolveRuntimeTenantId(db, { agentId: agentRow.id }),
      };
    }

    return null;
  } catch {
    return null;
  }
}
