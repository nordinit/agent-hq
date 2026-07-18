import type Database from 'better-sqlite3';
import { getDb } from '../../db/client';
import { buildDispatchMessage, dispatchInstance } from '../runs';
import { buildCompletionContractInstructions } from '../../services/contracts';
import { createDurableRunId, tableHasColumn } from '../../lib/durableRunIdentity';
import { insertRuntimeLog } from '../../lib/runtimeTenantScope';

export type SprintStatus = 'planning' | 'planned' | 'active' | 'paused' | 'complete' | 'closed';

interface SprintRecord {
  id: number;
  project_id: number;
  name: string;
  goal: string;
  sprint_type: string;
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

export function resolveSprintTypeOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return value.length > 0 ? value : null;
}

export function sprintTypeExists(db: Database.Database, sprintType: string): boolean {
  const row = db.prepare(`SELECT key FROM sprint_types WHERE key = ? LIMIT 1`).get(sprintType);
  return Boolean(row);
}

export function normalizeSprintStatus(raw: unknown): SprintStatus {
  const status = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!status) return 'planning';
  if (status === 'planned') return 'planning';
  if (status === 'planning' || status === 'active' || status === 'paused' || status === 'complete' || status === 'closed') {
    return status;
  }
  throw new Error(`Invalid sprint status "${raw}". Valid values: planning, planned, active, paused, complete, closed`);
}

export function completeSprint(sprintId: number): void {
  const db = getDb();
  const sprint = db.prepare('SELECT * FROM sprints WHERE id = ?').get(sprintId) as SprintRecord | undefined;
  if (!sprint || sprint.status === 'complete') return;

  db.prepare(`
    UPDATE sprints SET status = 'complete', ended_at = datetime('now') WHERE id = ?
  `).run(sprintId);

  const paused = db.prepare(`
    UPDATE agents SET enabled = 0 WHERE sprint_id = ?
  `).run(sprintId);

  insertRuntimeLog(db, {
    projectId: sprint.project_id,
    jobTitle: `Sprint: ${sprint.name}`,
    level: 'info',
    message: `Sprint "${sprint.name}" (id=${sprintId}) completed. ${paused.changes} job(s) paused.`,
  });

  console.log(`[sprints] Sprint ${sprintId} "${sprint.name}" completed. ${paused.changes} job(s) paused.`);

  const sprintJobs = db.prepare(`
    SELECT a.*, a.model as agent_model
    FROM agents a
    WHERE a.sprint_id = ?
  `).all(sprintId) as Array<Record<string, unknown>>;

  for (const job of sprintJobs) {
    const sprintSummaryModel = (job.agent_model ?? null) as string | null;
    const jobInstructions = typeof job.job_instructions === 'string' ? job.job_instructions : '';
    const sessionKey = typeof job.session_key === 'string' ? job.session_key : '';
    console.log(
      `[sprints] Sprint summary model resolution — agent="${job.name}"`
      + ` agent.model=${job.agent_model ?? 'null'}`
      + ` effective=${sprintSummaryModel ?? 'gateway-default'}`,
    );

    const supportsDurableRunId = tableHasColumn(db, 'job_instances', 'durable_run_id');
    const instanceResult = supportsDurableRunId
      ? db.prepare(`
          INSERT INTO job_instances (agent_id, status, durable_run_id) VALUES (?, 'queued', ?)
        `).run(job.id, createDurableRunId())
      : db.prepare(`
          INSERT INTO job_instances (agent_id, status) VALUES (?, 'queued')
        `).run(job.id);
    const instanceId = instanceResult.lastInsertRowid as number;

    let message = buildDispatchMessage({
      jobInstructions,
      sprintGoal: sprint.goal || null,
      summaryRequest: `The sprint "${sprint.name}" has ended. Please summarize: (1) what tasks you completed this sprint, (2) what tasks remain unfinished, and (3) any current blockers. Keep it concise.`,
    });
    message += `\n\n${buildCompletionContractInstructions({ instanceId })}`;

    dispatchInstance({
      instanceId,
      agentId: job.id as number,
      jobTitle: `Sprint Review: ${sprint.name}`,
      sessionKey,
      openclawAgentId: (job.openclaw_agent_id as string | null | undefined) ?? null,
      message,
      model: sprintSummaryModel,
      preferredProvider: (job.preferred_provider as string | null | undefined) ?? null,
      providerConnectionId: (job.provider_connection_id as number | null | undefined) ?? null,
      hooksUrl: (job.hooks_url as string | null | undefined) ?? null,
      hooksAuthHeader: (job.hooks_auth_header as string | null | undefined) ?? null,
      runtimeType: (job.runtime_type as string | null | undefined) ?? null,
      runtimeConfig: (job.runtime_config as Record<string, unknown> | null | undefined) ?? null,
    }).catch((err: Error) => {
      console.error(`[sprints] Failed to dispatch summary for job ${job.id}:`, err.message);
    });
  }
}

export function checkSprintCompletion(): void {
  const db = getDb();
  const activeSprints = db.prepare(`
    SELECT * FROM sprints WHERE status = 'active'
  `).all() as SprintRecord[];

  for (const sprint of activeSprints) {
    if (!sprint.started_at) continue;

    if (sprint.length_kind === 'time') {
      const durationMs = parseLengthToMs(sprint.length_value);
      if (durationMs === null) continue;
      const startedMs = new Date(sprint.started_at).getTime();
      if (Date.now() >= startedMs + durationMs) {
        console.log(`[sprints] Sprint ${sprint.id} "${sprint.name}" time limit reached, completing.`);
        completeSprint(sprint.id);
      }
    } else if (sprint.length_kind === 'runs') {
      const maxRuns = parseInt(sprint.length_value, 10);
      if (Number.isNaN(maxRuns)) continue;
      const row = db.prepare(`
        SELECT COUNT(*) as cnt
        FROM job_instances ji
        JOIN agents a ON a.id = ji.agent_id
        WHERE a.sprint_id = ?
          AND ji.status IN ('done', 'failed')
      `).get(sprint.id) as { cnt: number };
      if (row.cnt >= maxRuns) {
        console.log(`[sprints] Sprint ${sprint.id} "${sprint.name}" run limit reached (${row.cnt}/${maxRuns}), completing.`);
        completeSprint(sprint.id);
      }
    }
  }
}
