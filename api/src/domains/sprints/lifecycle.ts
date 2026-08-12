import { getDb } from '../../db/client';
import { insertRuntimeLog } from '../../lib/runtimeTenantScope';
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
