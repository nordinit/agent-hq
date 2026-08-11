import { getDb } from '../../db/client';
import { buildDispatchContextBundle, dispatchInstance, loadDispatchScopeContext } from '../runs';
import { buildCompletionContractInstructions } from '../../services/contracts';
import { createDurableRunId, tableHasColumn } from '../../lib/durableRunIdentity';
import { insertRuntimeLog } from '../../lib/runtimeTenantScope';
import { resolveTeamContextForDispatch } from '../teams/context';
import { type Db } from "../../db/adapter/types";

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

export async function sprintTypeExists(db: Db, sprintType: string): Promise<boolean> {
  const row = await db.get(`SELECT key FROM sprint_types WHERE key = ? LIMIT 1`, sprintType);
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

export async function completeSprint(sprintId: number): Promise<void> {
  const db = getDb();
  const sprint = await db.get('SELECT * FROM sprints WHERE id = ?', sprintId) as SprintRecord | undefined;
  if (!sprint || sprint.status === 'complete') return;

  await db.run(`
    UPDATE sprints SET status = 'complete', ended_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?
  `, sprintId);

  const paused = await db.run(`
    UPDATE agents SET enabled = 0 WHERE sprint_id = ?
  `, sprintId);

  await insertRuntimeLog(db, {
        projectId: sprint.project_id,
        jobTitle: `Sprint: ${sprint.name}`,
        level: 'info',
        message: `Sprint "${sprint.name}" (id=${sprintId}) completed. ${paused.changes} job(s) paused.`,
      });

  console.log(`[sprints] Sprint ${sprintId} "${sprint.name}" completed. ${paused.changes} job(s) paused.`);

  const sprintJobs = await db.all(`
    SELECT a.*, a.model as agent_model
    FROM agents a
    WHERE a.sprint_id = ?
  `, sprintId) as Array<Record<string, unknown>>;

  for (const job of sprintJobs) {
    const sprintSummaryModel = (job.agent_model ?? null) as string | null;
    const jobInstructions = typeof job.job_instructions === 'string' ? job.job_instructions : '';
    const sessionKey = typeof job.session_key === 'string' ? job.session_key : '';
    console.log(
      `[sprints] Sprint summary model resolution — agent="${job.name}"`
      + ` agent.model=${job.agent_model ?? 'null'}`
      + ` effective=${sprintSummaryModel ?? 'gateway-default'}`,
    );

    const supportsDurableRunId = await tableHasColumn(db, 'job_instances', 'durable_run_id');
    const instanceResult = supportsDurableRunId
      ? await db.run(`
          INSERT INTO job_instances (tenant_id, agent_id, status, durable_run_id) VALUES (?, ?, 'queued', ?)
        `, job.tenant_id, job.id, createDurableRunId())
      : await db.run(`
          INSERT INTO job_instances (tenant_id, agent_id, status) VALUES (?, ?, 'queued')
        `, job.tenant_id, job.id);
    const instanceId = instanceResult.lastInsertId as number;

    const teamContext = await resolveTeamContextForDispatch(db, {
      agentId: job.id as number,
      sprintId: sprint.id as number,
    });

    const scope = await loadDispatchScopeContext(db, {
      projectId: sprint.project_id,
      workflowId: sprint.id,
    });
    const contextBundle = buildDispatchContextBundle({
      workflow: { id: sprint.id, name: sprint.name, goal: sprint.goal || null },
      team: teamContext,
      project: scope.project,
      job: {
        agentId: job.id as number,
        title: (job.job_title as string | null) ?? null,
        instructions: jobInstructions,
      },
      // No task, notes, workspace, or GitHub identity: a workflow summary is not task work and
      // does not run against a repo. Those sections render as not-injected with a reason.
      summaryRequest: `The sprint "${sprint.name}" has ended. Please summarize: (1) what tasks you completed this sprint, (2) what tasks remain unfinished, and (3) any current blockers. Keep it concise.`,
      contract: {
        kind: 'callback_contract',
        label: 'Completion Contract',
        text: buildCompletionContractInstructions({ instanceId }),
        source: { type: 'contract_template', label: 'completion' },
      },
    });
    const message = contextBundle.promptText;

    dispatchInstance({
      instanceId,
      agentId: job.id as number,
      jobTitle: `Sprint Review: ${sprint.name}`,
      sessionKey,
      openclawAgentId: (job.openclaw_agent_id as string | null | undefined) ?? null,
      message,
      contextBundle,
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

export async function checkSprintCompletion(): Promise<void> {
  const db = getDb();
  const activeSprints = await db.all(`
    SELECT * FROM sprints WHERE status = 'active'
  `) as SprintRecord[];

  for (const sprint of activeSprints) {
    if (!sprint.started_at) continue;

    if (sprint.length_kind === 'time') {
      const durationMs = parseLengthToMs(sprint.length_value);
      if (durationMs === null) continue;
      const startedMs = new Date(sprint.started_at).getTime();
      if (Date.now() >= startedMs + durationMs) {
        console.log(`[sprints] Sprint ${sprint.id} "${sprint.name}" time limit reached, completing.`);
        await completeSprint(sprint.id);
      }
    } else if (sprint.length_kind === 'runs') {
      const maxRuns = parseInt(sprint.length_value, 10);
      if (Number.isNaN(maxRuns)) continue;
      const row = await db.get(`
        SELECT COUNT(*) as cnt
        FROM job_instances ji
        JOIN agents a ON a.id = ji.agent_id
        WHERE a.sprint_id = ?
          AND ji.status IN ('done', 'failed')
      `, sprint.id) as { cnt: number };
      if (row.cnt >= maxRuns) {
        console.log(`[sprints] Sprint ${sprint.id} "${sprint.name}" run limit reached (${row.cnt}/${maxRuns}), completing.`);
        await completeSprint(sprint.id);
      }
    }
  }
}
