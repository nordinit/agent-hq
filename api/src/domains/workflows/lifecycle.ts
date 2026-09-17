import { getDb } from '../../db/client';
import { insertRuntimeLog } from '../../lib/runtimeTenantScope';
import { writeProjectAudit } from '../../lib/projectAudit';
import { type Db } from "../../db/adapter/types";

export type WorkflowStatus = 'planning' | 'planned' | 'active' | 'paused' | 'complete' | 'closed';

/** Audit actor for the unattended time/run-limit completions driven by checkWorkflowCompletion. */
export const WORKFLOW_SCHEDULER_ACTOR = 'system:workflow-scheduler';

interface WorkflowRecord {
  id: number;
  project_id: number;
  name: string;
  goal: string;
  workflow_type: string;
  status: 'planning' | 'planned' | 'active' | 'paused' | 'complete' | 'closed';
  length_kind: 'time' | 'runs';
  length_value: string;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

function parseLengthToMs(value: string): number | null {
  const match = /^(\d+)([wdhm])$/.exec(value.trim().toLowerCase());
  if (!match) return null;
  const n = parseInt(match[1], 10);
  switch (match[2]) {
    case 'w': return n * 7 * 24 * 60 * 60 * 1000;
    case 'd': return n * 24 * 60 * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
    case 'm': return n * 60 * 1000;
    default: return null;
  }
}

export function resolveWorkflowTypeOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return value.length > 0 ? value : null;
}

export async function workflowTypeExists(db: Db, workflowType: string): Promise<boolean> {
  const row = await db.get(`SELECT key FROM workflow_types WHERE key = ? LIMIT 1`, workflowType);
  return Boolean(row);
}

export function normalizeWorkflowStatus(raw: unknown): WorkflowStatus {
  const status = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!status) return 'planning';
  if (status === 'planned') return 'planning';
  if (status === 'planning' || status === 'active' || status === 'paused' || status === 'complete' || status === 'closed') {
    return status;
  }
  throw new Error(`Invalid workflow status "${raw}". Valid values: planning, planned, active, paused, complete, closed`);
}

/**
 * Completing is the terminal end of an operating cycle: it stamps ended_at and stands down the
 * workflow's agents. `actor` is threaded through because completing is now reachable from MCP as
 * well as the canvas — an agent-initiated complete has to be as attributable as an operator's,
 * and until it carried an audit row this was the least traceable write in the lifecycle. The
 * scheduler paths below pass their own actor rather than inheriting an operator's.
 */
export async function completeWorkflow(
  workflowId: number,
  actor = 'api',
  note?: string,
): Promise<void> {
  const db = getDb();
  const workflow = await db.get('SELECT * FROM workflows WHERE id = ?', workflowId) as WorkflowRecord | undefined;
  if (!workflow || workflow.status === 'complete') return;

  await db.run(`
    UPDATE workflows SET status = 'complete', ended_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?
  `, workflowId);

  const paused = await db.run(`
    UPDATE agents SET enabled = 0 WHERE workflow_id = ?
  `, workflowId);

  await writeProjectAudit(db, workflow.project_id, 'workflow', workflowId, 'updated', actor, {
        status: { old: workflow.status, new: 'complete' },
        ...(note ? { note } : {}),
      });

  await insertRuntimeLog(db, {
        projectId: workflow.project_id,
        jobTitle: `Workflow: ${workflow.name}`,
        level: 'info',
        message: `Workflow "${workflow.name}" (id=${workflowId}) completed. ${paused.changes} job(s) paused.`,
      });

  console.log(`[workflows] Workflow ${workflowId} "${workflow.name}" completed. ${paused.changes} job(s) paused.`);

}

export async function checkWorkflowCompletion(): Promise<void> {
  const db = getDb();
  const activeWorkflows = await db.all(`
    SELECT * FROM workflows WHERE status = 'active'
  `) as WorkflowRecord[];

  for (const workflow of activeWorkflows) {
    if (!workflow.started_at) continue;

    if (workflow.length_kind === 'time') {
      const durationMs = parseLengthToMs(workflow.length_value);
      if (durationMs === null) continue;
      const startedMs = new Date(workflow.started_at).getTime();
      if (Date.now() >= startedMs + durationMs) {
        console.log(`[workflows] Workflow ${workflow.id} "${workflow.name}" time limit reached, completing.`);
        await completeWorkflow(workflow.id, WORKFLOW_SCHEDULER_ACTOR, `Time limit reached (${workflow.length_value}).`);
      }
    } else if (workflow.length_kind === 'runs') {
      const maxRuns = parseInt(workflow.length_value, 10);
      if (Number.isNaN(maxRuns)) continue;
      const row = await db.get(`
        SELECT COUNT(*) as cnt
        FROM job_instances ji
        JOIN agents a ON a.id = ji.agent_id
        WHERE a.workflow_id = ?
          AND ji.status IN ('done', 'failed')
      `, workflow.id) as { cnt: number };
      if (row.cnt >= maxRuns) {
        console.log(`[workflows] Workflow ${workflow.id} "${workflow.name}" run limit reached (${row.cnt}/${maxRuns}), completing.`);
        await completeWorkflow(workflow.id, WORKFLOW_SCHEDULER_ACTOR, `Run limit reached (${row.cnt}/${maxRuns}).`);
      }
    }
  }
}
