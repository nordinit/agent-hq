import type Database from 'better-sqlite3';

export function getDashboardTokenUsageLast24h(db: Database.Database, projectId: number | null = null, tenantId: number | null = null): number {
  const scopedJobJoin = projectId || tenantId ? 'LEFT JOIN tasks t ON t.id = ji.task_id LEFT JOIN agents a ON a.id = ji.agent_id' : '';
  const scopedJobWhere = tenantId
    ? projectId
      ? ' AND ((t.tenant_id = ? AND t.project_id = ?) OR (ji.task_id IS NULL AND a.tenant_id = ? AND a.project_id = ?))'
      : ' AND (t.tenant_id = ? OR (ji.task_id IS NULL AND a.tenant_id = ?))'
    : projectId
      ? ' AND (t.project_id = ? OR (ji.task_id IS NULL AND a.project_id = ?))'
      : '';
  const scopedJobParams = tenantId
    ? projectId
      ? [tenantId, projectId, tenantId, projectId]
      : [tenantId, tenantId]
    : projectId
      ? [projectId, projectId]
      : [];
  const usageActivityAt = `COALESCE(
    ji.lifecycle_outcome_posted_at,
    ji.runtime_completed_at,
    ji.completed_at,
    ji.runtime_ended_at,
    ji.started_at,
    ji.dispatched_at,
    ji.created_at
  )`;

  return (db.prepare(`
    SELECT COALESCE(SUM(COALESCE(ji.token_total, COALESCE(ji.token_input, 0) + COALESCE(ji.token_output, 0))), 0) as n
    FROM job_instances ji
    ${scopedJobJoin}
    WHERE datetime(${usageActivityAt}) >= datetime('now', '-24 hours')
    ${scopedJobWhere}
  `).get(...scopedJobParams) as { n: number }).n;
}
