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
export function recoveryLabel(recovery: McpRecovery): string {
  return recovery.state === 'attention' ? 'Recovery failed — needs attention' : 'Recovering tool configuration';
}
export async function assertRecoveryActive(db: Db, recoveryId?: number): Promise<number> {
  if (recoveryId == null) return 90_000;
  const remaining = await db.value<number>(`SELECT EXTRACT(EPOCH FROM (deadline_at - clock_timestamp())) * 1000
    FROM openclaw_mcp_recovery WHERE id = ? AND state = 'recovering' AND deadline_at > clock_timestamp()`, recoveryId);
  if (remaining == null || remaining <= 0) throw new Error('Recovery deadline reached; operator attention is required');
  return Math.max(1, Math.floor(remaining));
}
/** Also covers a process dying before its failure handler could create an incident. */
export async function restoreMcpRecoveries(db: Db): Promise<void> {
  await db.run(`INSERT INTO openclaw_mcp_recovery (target_key, agent_id, started_at, deadline_at, last_error)
    SELECT target_key, agent_id, updated_at, updated_at + interval '10 minutes',
      COALESCE(error, 'MCP configuration update was interrupted') FROM openclaw_mcp_reconciliation
    WHERE state = 'failed' OR (state = 'pending' AND operation_phase IN ('refresh', 'reload'))
    ON CONFLICT (target_key, agent_id) WHERE resolved_at IS NULL DO NOTHING`);
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
      : recovery.state === 'attention' ? 'Next owner: Operator. Inspect the agent recovery details and retry recovery.'
        : 'Next action: HQ is recovering the configuration; task dispatch is waiting.');
  await db.run(`INSERT INTO task_notes (tenant_id, task_id, author, content)
    SELECT tenant_id, id, 'Agent HQ', ? FROM tasks WHERE id = ?`, content, taskId);
  await writeTaskHistory(db, taskId, 'Agent HQ', 'mcp_recovery', null,
    JSON.stringify({ recovery_id: recovery.id, state: recovery.state, summary }));
}
export async function beginMcpRecovery(db: Db, target: string, agentId: number, error: string): Promise<McpRecovery> {
  return db.withTransaction(async tx => {
    // Same row lock as dispatch: registering a blocker and reserving work cannot race.
    await tx.get('SELECT id FROM agents WHERE id = ? FOR UPDATE', agentId);
    const recovery = await tx.get<McpRecovery>(`INSERT INTO openclaw_mcp_recovery (target_key, agent_id, last_error)
      VALUES (?, ?, ?) ON CONFLICT (target_key, agent_id) WHERE resolved_at IS NULL
      DO UPDATE SET last_error = EXCLUDED.last_error RETURNING *`, target, agentId, redactSensitiveRuntimeText(error).slice(0, 4000));
    if (!recovery) throw new Error('Could not record MCP recovery');
    await attachAssignedTasks(tx, recovery);
    return recovery;
  });
}
async function attachAssignedTasks(db: Db, recovery: McpRecovery) {
  const tasks = await db.all<{ id: number; status: string; tenant_id: number; workflow_id: number | null }>(`
    SELECT t.id, t.status, t.tenant_id, t.workflow_id FROM tasks t JOIN agents a ON a.id = ? AND a.tenant_id = t.tenant_id
    WHERE COALESCE(t.assigned_agent_id, t.agent_id) = a.id`, recovery.agent_id);
  const terminalByWorkflow = new Map<string, string[]>();
  for (const task of tasks) {
    const key = `${task.tenant_id}:${task.workflow_id}`;
    const terminal = terminalByWorkflow.get(key) ?? await listConfiguredTerminalStatuses(db, { workflowId: task.workflow_id, tenantId: task.tenant_id });
    terminalByWorkflow.set(key, terminal);
    if (!terminal.includes(task.status)) await attachRecoveryTask(db, recovery, task.id);
  }
}
async function notifyRecovery(db: Db, recovery: McpRecovery, resolved: boolean) {
  const agent = await db.get<{ name: string; tenant_id: number }>('SELECT name, tenant_id FROM agents WHERE id = ?', recovery.agent_id);
  if (!agent?.tenant_id) return null;
  const tasks = await db.all<{ id: number }>('SELECT task_id AS id FROM openclaw_mcp_recovery_tasks WHERE recovery_id = ? ORDER BY task_id', recovery.id);
  const title = resolved ? `${agent.name}'s tool configuration recovered` : `${agent.name}'s recovery has failed for 10 minutes`;
  const body = `${title}.\nAffected tasks: ${tasks.map(t => `#${t.id}`).join(', ') || 'None yet'}.\n`
    + (resolved ? 'Configuration verified. Eligible tasks can resume.' : `Attempts: ${recovery.attempts}. Latest error: ${recovery.last_error}\nTask dispatch is waiting. Operator: inspect the failure and retry recovery.`);
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
      await tx.run("UPDATE openclaw_mcp_recovery SET state = 'attention' WHERE id = ?", row.id);
      await attachAssignedTasks(tx, recovery);
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
