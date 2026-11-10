import type { Db } from '../../db/adapter/types';
export async function projectContext(db: Db, tenantId: number, projectId: number, limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
        throw Object.assign(new Error('limit must be 1–50'), { status: 400 });
    const project = await db.get('SELECT id,name,description,created_at FROM projects WHERE id=? AND tenant_id=?', projectId, tenantId);
    if (!project)
        throw Object.assign(new Error('Project not found'), { status: 404 });
    const statusCounts = await db.all('SELECT status,count(*)::int AS count FROM tasks WHERE project_id=? AND tenant_id=? GROUP BY status ORDER BY status', projectId, tenantId);
    const workflows = await db.all('SELECT id,name,status,goal FROM workflows WHERE project_id=? AND tenant_id=? ORDER BY id', projectId, tenantId);
    const recentTasks = await db.all(`SELECT t.id,t.title,t.status,t.updated_at,t.agent_id,t.active_instance_id,
    ji.status AS active_instance_status,ji.started_at AS run_started_at,ji.completed_at AS run_completed_at,
    latest.id AS latest_instance_id,latest.status AS latest_instance_status,latest.completed_at AS latest_run_completed_at
    FROM tasks t LEFT JOIN job_instances ji ON ji.id=t.active_instance_id AND ji.tenant_id=t.tenant_id
    LEFT JOIN LATERAL(SELECT id,status,completed_at FROM job_instances WHERE task_id=t.id AND tenant_id=t.tenant_id ORDER BY id DESC LIMIT 1) latest ON true
    WHERE t.project_id=? AND t.tenant_id=? ORDER BY t.updated_at DESC,t.id DESC LIMIT ?`, projectId, tenantId, limit);
    const attention = await db.all("SELECT id,title,status,failure_detail,updated_at FROM tasks WHERE project_id=? AND tenant_id=? AND status IN ('blocked','stalled','needs_attention') ORDER BY updated_at DESC,id DESC LIMIT ?", projectId, tenantId, limit);
    return { project, workflows, status_counts: statusCounts, recent_tasks: recentTasks, attention, generated_at: new Date().toISOString(), coverage: { recent_tasks_limit: limit, attention_limit: limit, status_counts: 'all_project_tasks', attention: 'explicit blocked/stalled/needs_attention statuses; custom workflow labels may require task context' }, authority: 'persisted_agent_hq_state' };
}
export function summaryTaskResponse(value: any): any {
    const summarize = (t: any) => Object.fromEntries(['id', 'title', 'status', 'priority', 'task_type', 'project_id', 'workflow_id', 'agent_id', 'agent_name', 'active_instance_id', 'updated_at', 'created_at', 'is_blocked', 'recurring_series_id', 'scheduled_for'].filter(k => t[k] !== undefined).map(k => [k, t[k]]));
    return Array.isArray(value) ? value.map(summarize) : value && Array.isArray(value.tasks) ? { ...value, tasks: value.tasks.map(summarize) } : value;
}
