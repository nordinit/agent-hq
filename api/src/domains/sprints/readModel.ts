import { type Db } from "../../db/adapter/types";

export interface SprintRecord {
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
  repo_path: string | null;
  repo_url: string | null;
  repo_access_mode: 'worktree' | 'clone' | null;
  created_at: string;
}

async function tableHasColumn(db: Db, table: string, column: string): Promise<boolean> {
  try {
    return (await db.all(`PRAGMA table_info(${table})`) as Array<{ name: string }>)
      .some((entry) => entry.name === column);
  } catch {
    return false;
  }
}

async function sprintRoutingAgentCountPredicate(db: Db): Promise<string> {
  return await tableHasColumn(db, 'sprint_task_routing_rules', 'project_id')
    && await tableHasColumn(db, 'sprint_task_routing_rules', 'sprint_type')
    ? `rr2.sprint_id = s.id
           OR (
             rr2.project_id = s.project_id
             AND rr2.sprint_type = s.sprint_type
             AND rr2.sprint_id IS NULL
           )`
    : `rr2.sprint_id = s.id`;
}

async function sprintRoutingJobsPredicate(db: Db): Promise<string> {
  return await tableHasColumn(db, 'sprint_task_routing_rules', 'project_id')
    && await tableHasColumn(db, 'sprint_task_routing_rules', 'sprint_type')
    ? `rr.sprint_id = s.id
       OR (
         rr.project_id = s.project_id
         AND rr.sprint_type = s.sprint_type
         AND rr.sprint_id IS NULL
       )`
    : `rr.sprint_id = s.id`;
}

export async function listSprints(
  db: Db,
  query: { project_id?: unknown; include_closed?: unknown; tenant_id?: unknown },
) {
  const { project_id, tenant_id } = query;
  const routingAgentCountPredicate = await sprintRoutingAgentCountPredicate(db);

  let sql = `
    SELECT s.*,
      p.name as project_name,
      (
        SELECT COUNT(DISTINCT a2.id)
        FROM sprint_task_routing_rules rr2
        JOIN agents a2 ON a2.id = rr2.agent_id
        WHERE ${routingAgentCountPredicate}
      ) as agent_count,
      COUNT(DISTINCT t.id) as task_count,
      COUNT(DISTINCT CASE WHEN t.status = 'done' THEN t.id END) as tasks_done,
      COALESCE(SUM(COALESCE(t.story_points, 0)), 0) as total_story_points,
      COALESCE(SUM(CASE WHEN t.status = 'done' THEN COALESCE(t.story_points, 0) ELSE 0 END), 0) as done_story_points,
      COALESCE(SUM(CASE WHEN t.status != 'done' THEN COALESCE(t.story_points, 0) ELSE 0 END), 0) as remaining_story_points
    FROM sprints s
    LEFT JOIN projects p ON p.id = s.project_id
    LEFT JOIN tasks t ON t.sprint_id = s.id
  `;
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (project_id) {
    conditions.push('s.project_id = ?');
    params.push(Number(project_id));
  }
  if (tenant_id) {
    conditions.push('s.tenant_id = ?');
    params.push(Number(tenant_id));
  }

  if (!query.include_closed || query.include_closed === 'false') {
    conditions.push(`s.status != 'closed'`);
  }

  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(' AND ')}`;
  }

  sql += ` GROUP BY s.id, p.name ORDER BY s.created_at DESC`;
  return db.prepare(sql).all(...params);
}

export async function getSprintDetail(db: Db, sprintId: number) {
  const routingAgentCountPredicate = await sprintRoutingAgentCountPredicate(db);
  return await db.get(`
    SELECT s.*,
      p.name as project_name,
      (
        SELECT COUNT(DISTINCT a2.id)
        FROM sprint_task_routing_rules rr2
        JOIN agents a2 ON a2.id = rr2.agent_id
        WHERE ${routingAgentCountPredicate}
      ) as agent_count,
      COUNT(DISTINCT t.id) as task_count,
      COUNT(DISTINCT CASE WHEN t.status = 'done' THEN t.id END) as tasks_done,
      COALESCE(SUM(COALESCE(t.story_points, 0)), 0) as total_story_points,
      COALESCE(SUM(CASE WHEN t.status = 'done' THEN COALESCE(t.story_points, 0) ELSE 0 END), 0) as done_story_points,
      COALESCE(SUM(CASE WHEN t.status != 'done' THEN COALESCE(t.story_points, 0) ELSE 0 END), 0) as remaining_story_points
    FROM sprints s
    LEFT JOIN projects p ON p.id = s.project_id
    LEFT JOIN tasks t ON t.sprint_id = s.id
    WHERE s.id = ?
    GROUP BY s.id, p.name
  `, sprintId);
}

export async function getSprintMetrics(db: Db, sprintId: number) {
  const sprint = await db.get('SELECT id FROM sprints WHERE id = ?', sprintId);
  if (!sprint) return null;

  const taskRow = await db.get(`
    SELECT
      COUNT(*) as tasks_total,
      COUNT(CASE WHEN status = 'done' THEN 1 END) as tasks_done,
      COALESCE(SUM(COALESCE(story_points, 0)), 0) as total_story_points,
      COALESCE(SUM(CASE WHEN status = 'done' THEN COALESCE(story_points, 0) ELSE 0 END), 0) as done_story_points,
      COALESCE(SUM(CASE WHEN status != 'done' THEN COALESCE(story_points, 0) ELSE 0 END), 0) as remaining_story_points
    FROM tasks
    WHERE sprint_id = ?
  `, sprintId) as { tasks_total: number; tasks_done: number; total_story_points: number; done_story_points: number; remaining_story_points: number };

  const blockerRow = await db.get(`
    SELECT COUNT(DISTINCT td.blocked_id) as blocker_count
    FROM task_dependencies td
    JOIN tasks blocked ON blocked.id = td.blocked_id
    JOIN tasks blocker ON blocker.id = td.blocker_id
    WHERE blocked.sprint_id = ?
      AND blocker.status != 'done'
  `, sprintId) as { blocker_count: number };

  const durationRow = await db.get(`
    SELECT AVG(
      (strftime('%s', updated_at) - strftime('%s', created_at)) * 1000
    ) as avg_ms
    FROM tasks
    WHERE sprint_id = ? AND status = 'done'
  `, sprintId) as { avg_ms: number | null };

  const runRow = await db.get(`
    SELECT
      COUNT(*) as job_runs_total,
      COUNT(CASE WHEN ji.status = 'done' THEN 1 END) as job_runs_success,
      COUNT(CASE WHEN ji.status = 'failed' THEN 1 END) as job_runs_failed
    FROM job_instances ji
    JOIN tasks t ON t.id = ji.task_id
    WHERE t.sprint_id = ?
  `, sprintId) as { job_runs_total: number; job_runs_success: number; job_runs_failed: number };

  const tasks_total = taskRow.tasks_total ?? 0;
  const tasks_done = taskRow.tasks_done ?? 0;
  const completion_rate = tasks_total > 0 ? Math.round((tasks_done / tasks_total) * 100) : 0;
  const job_runs_total = runRow.job_runs_total ?? 0;
  const job_runs_success = runRow.job_runs_success ?? 0;
  const job_runs_failed = runRow.job_runs_failed ?? 0;
  const success_rate = job_runs_total > 0
    ? Math.round((job_runs_success / job_runs_total) * 1000) / 10
    : 0;

  return {
    sprint_id: sprintId,
    tasks_total,
    tasks_done,
    completion_rate,
    total_story_points: taskRow.total_story_points ?? 0,
    done_story_points: taskRow.done_story_points ?? 0,
    remaining_story_points: taskRow.remaining_story_points ?? 0,
    job_runs_total,
    job_runs_success,
    job_runs_failed,
    success_rate,
    blocker_count: blockerRow.blocker_count ?? 0,
    avg_task_duration_ms: Math.round(durationRow.avg_ms ?? 0),
  };
}

export async function listSprintJobs(db: Db, sprintId: number) {
  const sprint = await db.get('SELECT id FROM sprints WHERE id = ?', sprintId);
  if (!sprint) return null;
  const routingJobsPredicate = await sprintRoutingJobsPredicate(db);

  return await db.all(`
    SELECT a.*,
      a.name as agent_name,
      a.session_key as agent_session_key,
      a.job_title as title,
      COUNT(ji.id) as run_count,
      COUNT(CASE WHEN ji.status = 'done' THEN 1 END) as run_success,
      COUNT(CASE WHEN ji.status = 'failed' THEN 1 END) as run_failed,
      CASE WHEN EXISTS (
        SELECT 1
        FROM sprint_task_routing_rules rr
        WHERE rr.agent_id = a.id
          AND rr.sprint_id = ?
      ) THEN 1 ELSE 0 END as is_primary_sprint
    FROM sprint_task_routing_rules rr
    JOIN sprints s ON s.id = ?
    JOIN agents a ON a.id = rr.agent_id
    LEFT JOIN job_instances ji ON ji.agent_id = a.id
    WHERE ${routingJobsPredicate}
    GROUP BY a.id
    ORDER BY a.created_at DESC
  `, sprintId, sprintId);
}
