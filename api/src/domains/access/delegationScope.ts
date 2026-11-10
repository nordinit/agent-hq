import type { Db } from '../../db/adapter/types';
/** Resolve persisted ownership before a delegated host operation reaches a handler. */
export async function delegationTarget(db: Db, path: string, body: Record<string, unknown>, tenantId: number): Promise<{
    exists: boolean;
    projectId: number | null;
} | null> {
    if (path === '/dispatch/reconcile')
        return { exists: false, projectId: null };
    let sql: string | undefined, id: unknown;
    if (path === '/dispatch/trigger') {
        sql = 'SELECT id AS project_id FROM projects WHERE id=? AND tenant_id=?';
        id = body.project_id;
    }
    const recurring = path.match(/^\/recurring-task-series\/([^/]+)\/run-now$/);
    if (recurring) {
        sql = 'SELECT project_id FROM recurring_task_series WHERE id=? AND tenant_id=?';
        id = recurring[1];
    }
    const agent = path.match(/^\/chat\/agents\/([^/]+)\/(?:send|chat-session\/rotate)$/);
    if (agent) {
        sql = 'SELECT project_id FROM agents WHERE id=? AND tenant_id=?';
        id = agent[1];
    }
    const instance = path.match(/^\/chat\/instances\/([^/]+)\/send$/);
    if (instance) {
        sql = 'SELECT a.project_id FROM job_instances ji JOIN agents a ON a.id=ji.agent_id AND a.tenant_id=ji.tenant_id WHERE ji.id=? AND ji.tenant_id=?';
        id = instance[1];
    }
    if (!sql)
        return null;
    const value = Number(id);
    if (!Number.isSafeInteger(value) || value < 1)
        return { exists: false, projectId: null };
    const row = await db.get<{
        project_id: number | null;
    }>(sql, value, tenantId);
    return { exists: !!row, projectId: row?.project_id ?? null };
}
