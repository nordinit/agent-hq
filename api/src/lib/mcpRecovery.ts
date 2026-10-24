import type { Db } from '../db/adapter/types';
import { listConfiguredTerminalStatuses } from '../domains/tasks/terminality';
import { writeTaskHistory } from '../domains/tasks/history';
import { createNotificationRecord } from './notifications';
import { redactSensitiveRuntimeText } from '../runtimes/sensitiveText';

export interface McpRecovery {
  id: number; target_key: string; agent_id: number;
  state: 'recovering' | 'attention' | 'resolved';
  started_at: string | Date; deadline_at: string | Date;
  attempts: number; last_error: string;
}
/** Must outlast a gateway restart: boots took 6-9 minutes under memory pressure, then a reload backlog. */
export function mcpRecoveryDeadlineMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const minutes = Number(env.AGENT_HQ_MCP_RECOVERY_DEADLINE_MINUTES);
  return Number.isSafeInteger(minutes) && minutes > 0 ? minutes : 30;
}
/**
 * Escalation alerts but never stops recovery: a gateway outage can outlast any deadline. After the
 * deadline, attempts back off to every 5 minutes for half an hour, then every 10 minutes.
 */
const ATTENTION_RETRY_INTERVAL_SQL = `CASE WHEN now() - deadline_at < interval '30 minutes'
  THEN interval '5 minutes' ELSE interval '10 minutes' END`;
/** Evaluated against the row's state before the update; attempts inside the deadline are a minute apart. */
export const NEXT_RECOVERY_ATTEMPT_SQL = `now() + CASE WHEN state = 'recovering' THEN interval '1 minute'
  ELSE ${ATTENTION_RETRY_INTERVAL_SQL} END`;
export function recoveryLabel(recovery: McpRecovery): string {
  return recovery.state === 'attention' ? 'Recovery failed — needs attention' : 'Recovering tool configuration';
}
export async function assertRecoveryActive(db: Db, recoveryId?: number): Promise<number> {
  if (recoveryId == null) return 90_000;
  const recovery = await db.get<{ state: McpRecovery['state']; remaining: number | string }>(`SELECT state,
    EXTRACT(EPOCH FROM (deadline_at - clock_timestamp())) * 1000 AS remaining
    FROM openclaw_mcp_recovery WHERE id = ? AND resolved_at IS NULL`, recoveryId);
  // An escalated incident has no deadline left; each retry gets the budget of an ordinary apply.
  if (recovery?.state === 'attention') return 90_000;
  const remaining = Number(recovery?.remaining);
  if (recovery?.state !== 'recovering' || !(remaining > 0)) throw new Error('Recovery deadline reached; operator attention is required');
  return Math.max(1, Math.floor(remaining));
}
/** Also covers a process dying before its failure handler could create an incident. */
export async function restoreMcpRecoveries(db: Db): Promise<void> {
  await db.run(`INSERT INTO openclaw_mcp_recovery (target_key, agent_id, started_at, deadline_at, last_error)
    SELECT target_key, agent_id, updated_at, updated_at + make_interval(mins => ?),
      COALESCE(error, 'MCP configuration update was interrupted') FROM openclaw_mcp_reconciliation
    WHERE state = 'failed' OR (state = 'pending' AND operation_phase IN ('refresh', 'reload'))
    ON CONFLICT (target_key, agent_id) WHERE resolved_at IS NULL DO NOTHING`, mcpRecoveryDeadlineMinutes());
}
export async function getAgentMcpRecovery(db: Db, agentId: number): Promise<McpRecovery | null> {
  return await db.get<McpRecovery>(`SELECT * FROM openclaw_mcp_recovery
    WHERE agent_id = ? AND resolved_at IS NULL ORDER BY started_at LIMIT 1`, agentId) ?? null;
}
export async function getTaskMcpRecovery(db: Db, task: Record<string, unknown>): Promise<McpRecovery | null> {
  if (task.active_instance_id != null) return null;
  const assigned = task.assigned_agent_id ?? task.agent_id;
  const recovery = await db.get<McpRecovery>(`SELECT r.* FROM openclaw_mcp_recovery r JOIN agents a ON a.id = r.agent_id
    WHERE r.resolved_at IS NULL AND a.tenant_id = ? AND (
      r.agent_id = ? OR (CAST(? AS bigint) IS NULL AND EXISTS (SELECT 1 FROM openclaw_mcp_recovery_tasks rt
        WHERE rt.recovery_id = r.id AND rt.task_id = ?))) ORDER BY r.started_at LIMIT 1`,
  task.tenant_id, assigned ?? null, assigned ?? null, task.id) ?? null;
  if (!recovery) return null;
  const terminal = await listConfiguredTerminalStatuses(db, {
    workflowId: task.workflow_id as number | null, tenantId: task.tenant_id as number | null,
  });
  return terminal.includes(String(task.status)) ? null : recovery;
}
export async function attachRecoveryTask(db: Db, recovery: McpRecovery, taskId: number): Promise<void> {
  const linked = await db.run(`INSERT INTO openclaw_mcp_recovery_tasks (recovery_id, task_id)
    SELECT ?, t.id FROM tasks t JOIN agents a ON a.id = ? AND a.tenant_id = t.tenant_id
    WHERE t.id = ? ON CONFLICT DO NOTHING`, recovery.id, recovery.agent_id, taskId);
  if (!linked.changes) return;
  await recoveryTaskNote(db, recovery, taskId, recoveryLabel(recovery));
}
async function recoveryTaskNote(db: Db, recovery: McpRecovery, taskId: number, summary: string) {
  const content = `Summary: ${summary}\n${recovery.state === 'resolved' ? 'Recovery' : 'Blocker'}: Agent #${recovery.agent_id} tool configuration recovery #${recovery.id}.\n`
    + `Started: ${new Date(recovery.started_at).toISOString()}\nDeadline: ${new Date(recovery.deadline_at).toISOString()}\n`
    + `Attempts: ${recovery.attempts}\nLatest error: ${recovery.last_error}\n`
    + (recovery.state === 'resolved' ? 'Next action: Normal dispatch eligibility checks apply.'
      : recovery.state === 'attention' ? 'Next owner: Operator. HQ keeps retrying every 5-10 minutes; inspect the agent recovery details or retry recovery now.'
        : 'Next action: HQ is recovering the configuration; task dispatch is waiting.');
  await db.run(`INSERT INTO task_notes (tenant_id, task_id, author, content)
    SELECT tenant_id, id, 'Agent HQ', ? FROM tasks WHERE id = ?`, content, taskId);
  await writeTaskHistory(db, taskId, 'Agent HQ', 'mcp_recovery', null,
    JSON.stringify({ recovery_id: recovery.id, state: recovery.state, summary }));
}
/**
 * Tasks are linked only when a dispatch path holds them back (attachRecoveryTask), so the incident
 * lists work that was actually ready to run rather than every open task the agent owns.
 */
export async function beginMcpRecovery(db: Db, target: string, agentId: number, error: string): Promise<McpRecovery> {
  return db.withTransaction(async tx => {
    // Same row lock as dispatch: registering a blocker and reserving work cannot race.
    await tx.get('SELECT id FROM agents WHERE id = ? FOR UPDATE', agentId);
    const recovery = await tx.get<McpRecovery>(`INSERT INTO openclaw_mcp_recovery (target_key, agent_id, last_error, deadline_at)
      VALUES (?, ?, ?, now() + make_interval(mins => ?)) ON CONFLICT (target_key, agent_id) WHERE resolved_at IS NULL
      DO UPDATE SET last_error = EXCLUDED.last_error RETURNING *`, target, agentId, redactSensitiveRuntimeText(error).slice(0, 4000),
    mcpRecoveryDeadlineMinutes());
    if (!recovery) throw new Error('Could not record MCP recovery');
    return recovery;
  });
}
async function notifyRecovery(db: Db, recovery: McpRecovery, resolved: boolean) {
  const agent = await db.get<{ name: string; tenant_id: number }>('SELECT name, tenant_id FROM agents WHERE id = ?', recovery.agent_id);
  if (!agent?.tenant_id) return null;
  const tasks = await db.all<{ id: number }>('SELECT task_id AS id FROM openclaw_mcp_recovery_tasks WHERE recovery_id = ? ORDER BY task_id', recovery.id);
  const minutes = Math.round((new Date(recovery.deadline_at).getTime() - new Date(recovery.started_at).getTime()) / 60_000);
  const title = resolved ? `${agent.name}'s tool configuration recovered` : `${agent.name}'s recovery has failed for ${minutes} minutes`;
  const body = `${title}.\nAffected tasks: ${tasks.map(t => `#${t.id}`).join(', ') || 'None yet'}.\n`
    + (resolved ? 'Configuration verified. Eligible tasks can resume.' : `Attempts: ${recovery.attempts}. Latest error: ${recovery.last_error}\nTask dispatch is waiting. HQ keeps retrying every 5-10 minutes. Operator: inspect the failure, or retry now with POST /api/v1/agents/${recovery.agent_id}/mcp-recovery/retry.`);
  const record = await createNotificationRecord(db, { tenantId: agent.tenant_id,
    type: resolved ? 'mcp_recovery_resolved' : 'mcp_recovery_failed', title, body,
    source: 'agent_hq_mcp_recovery', outlet: 'agent_hq', metadata: {
      recoveryId: recovery.id, agentId: recovery.agent_id, taskIds: tasks.map(t => t.id),
      links: [{ label: agent.name, href: `/agents/${recovery.agent_id}` }, ...tasks.map(t => ({ label: `Task #${t.id}`, href: `/tasks/${t.id}` }))],
    } });
  await db.run(`INSERT INTO notification_deliveries (notification_id, outlet) VALUES (?, 'telegram') ON CONFLICT DO NOTHING`, record.id);
  return record.id;
}
/** Independent of slow gateway operations; the durable deadline never moves on retry. */
export async function escalateMcpRecoveries(db: Db): Promise<void> {
  await db.withTransaction(async tx => {
    const rows = await tx.all<McpRecovery>(`SELECT * FROM openclaw_mcp_recovery
      WHERE resolved_at IS NULL AND deadline_at <= now() AND escalation_notification_id IS NULL
      ORDER BY deadline_at FOR UPDATE SKIP LOCKED LIMIT 32`);
    for (const row of rows) {
      const recovery: McpRecovery = { ...row, state: 'attention' };
      await tx.run(`UPDATE openclaw_mcp_recovery SET state = 'attention', next_attempt_at = now() + ${ATTENTION_RETRY_INTERVAL_SQL}
        WHERE id = ?`, row.id);
      const notificationId = await notifyRecovery(tx, recovery, false);
      await tx.run('UPDATE openclaw_mcp_recovery SET escalation_notification_id = ? WHERE id = ?', notificationId, row.id);
      const tasks = await tx.all<{ task_id: number }>('SELECT task_id FROM openclaw_mcp_recovery_tasks WHERE recovery_id = ?', row.id);
      for (const task of tasks) await recoveryTaskNote(tx, recovery, task.task_id, recoveryLabel(recovery));
    }
  });
}
export async function resolveMcpRecovery(db: Db, target: string, agentId: number): Promise<void> {
  await db.withTransaction(async tx => {
    const recovery = await tx.get<McpRecovery>(`UPDATE openclaw_mcp_recovery SET state = 'resolved', resolved_at = now()
      WHERE target_key = ? AND agent_id = ? AND resolved_at IS NULL RETURNING *`, target, agentId);
    if (!recovery) return;
    const notificationId = await notifyRecovery(tx, recovery, true);
    await tx.run('UPDATE openclaw_mcp_recovery SET resolution_notification_id = ? WHERE id = ?', notificationId, recovery.id);
    const tasks = await tx.all<{ task_id: number }>('SELECT task_id FROM openclaw_mcp_recovery_tasks WHERE recovery_id = ?', recovery.id);
    for (const task of tasks) await recoveryTaskNote(tx, recovery, task.task_id, 'Tool configuration recovered');
  });
}
/**
 * Operator retry of an escalated incident: an attempt now instead of at the next 5-10 minute retry,
 * and a fresh window whose failure alerts again. started_at and attempts keep the full history.
 */
export async function retryMcpRecovery(db: Db, agentId: number): Promise<McpRecovery[]> {
  return db.withTransaction(async tx => {
    const recoveries = await tx.all<McpRecovery>(`UPDATE openclaw_mcp_recovery SET state = 'recovering',
      deadline_at = now() + make_interval(mins => ?), next_attempt_at = now(), escalation_notification_id = NULL
      WHERE agent_id = ? AND resolved_at IS NULL AND (state = 'attention' OR deadline_at <= now()) RETURNING *`,
    mcpRecoveryDeadlineMinutes(), agentId);
    for (const recovery of recoveries) {
      const tasks = await tx.all<{ task_id: number }>('SELECT task_id FROM openclaw_mcp_recovery_tasks WHERE recovery_id = ?', recovery.id);
      for (const task of tasks) await recoveryTaskNote(tx, recovery, task.task_id, 'Operator retried tool configuration recovery');
    }
    return recoveries;
  });
}
