import { tableHasColumn } from './durableRunIdentity';
import { type Db } from "../db/adapter/types";

async function tableExists(db: Db, table: string): Promise<boolean> {
  return Boolean((await db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`, table) as { name?: string } | undefined)?.name);
}

async function hasTenantId(db: Db, table: string): Promise<boolean> {
  return await tableExists(db, table) && await tableHasColumn(db, table, 'tenant_id');
}

function pushTenantSubquery(
  db: Db,
  conditions: string[],
  params: unknown[],
  sql: string,
  refs: string[],
  tenantId: number,
): void {
  if (!refs.every(async (table) => await hasTenantId(db, table))) return;
  conditions.push(sql);
  params.push(tenantId);
}

export async function resolveRuntimeTenantId(
  db: Db,
  input: { taskId?: number | null; agentId?: number | null; projectId?: number | null; instanceId?: number | null },
): Promise<number | null> {
  if (input.taskId != null && await hasTenantId(db, 'tasks')) {
    const row = await db.get(`SELECT tenant_id FROM tasks WHERE id = ? LIMIT 1`, input.taskId) as { tenant_id: number | null } | undefined;
    if (row?.tenant_id != null) return row.tenant_id;
  }

  if (input.instanceId != null && await tableExists(db, 'job_instances')) {
    const taskTenantExpr = await hasTenantId(db, 'tasks') ? 't.tenant_id' : 'NULL';
    const agentTenantExpr = await hasTenantId(db, 'agents') ? 'a.tenant_id' : 'NULL';
    const row = await db.get(`
      SELECT COALESCE(${taskTenantExpr}, ${agentTenantExpr}) AS tenant_id
      FROM job_instances ji
      LEFT JOIN tasks t ON t.id = ji.task_id
      LEFT JOIN agents a ON a.id = ji.agent_id
      WHERE ji.id = ?
      LIMIT 1
    `, input.instanceId) as { tenant_id: number | null } | undefined;
    if (row?.tenant_id != null) return row.tenant_id;
  }

  if (input.agentId != null && await hasTenantId(db, 'agents')) {
    const row = await db.get(`SELECT tenant_id FROM agents WHERE id = ? LIMIT 1`, input.agentId) as { tenant_id: number | null } | undefined;
    if (row?.tenant_id != null) return row.tenant_id;
  }

  if (input.projectId != null && await hasTenantId(db, 'projects')) {
    const row = await db.get(`SELECT tenant_id FROM projects WHERE id = ? LIMIT 1`, input.projectId) as { tenant_id: number | null } | undefined;
    if (row?.tenant_id != null) return row.tenant_id;
  }

  return null;
}

export async function tenantInsertColumns(
  db: Db,
  table: string,
  tenantId: number | null | undefined,
): Promise<{ columnSql: string; valueSql: string; values: unknown[] }> {
  if (tenantId == null || !await hasTenantId(db, table)) return { columnSql: '', valueSql: '', values: [] };
  return { columnSql: 'tenant_id, ', valueSql: '?, ', values: [tenantId] };
}

export async function tenantUpsertUpdateSql(db: Db, table: string): Promise<string> {
  return await hasTenantId(db, table) ? 'tenant_id = COALESCE(excluded.tenant_id, tenant_id),' : '';
}

export async function insertRuntimeLog(
  db: Db,
  input: {
    instanceId?: number | null;
    agentId?: number | null;
    taskId?: number | null;
    projectId?: number | null;
    jobTitle?: string | number | null;
    level?: 'info' | 'warn' | 'error' | 'debug';
    message: string;
  },
): Promise<void> {
  const tenantId = await resolveRuntimeTenantId(db, {
      taskId: input.taskId,
      instanceId: input.instanceId,
      agentId: input.agentId,
      projectId: input.projectId,
    });
  const columns: string[] = [];
  const placeholders: string[] = [];
  const values: unknown[] = [];
  const pushValue = async (column: string, value: unknown): Promise<void> => {
    if (!await tableHasColumn(db, 'logs', column)) return;
    columns.push(column);
    placeholders.push('?');
    values.push(value);
  };
  // Each of these MUST be awaited: pushValue became async when tableHasColumn did, and an
  // unawaited call leaves columns/placeholders empty, producing `INSERT INTO logs () VALUES ()`.
  // They are awaited in sequence rather than via Promise.all so column order stays
  // deterministic and matches the values array.
  await pushValue('tenant_id', tenantId);
  await pushValue('instance_id', input.instanceId ?? null);
  await pushValue('agent_id', input.agentId ?? null);
  await pushValue('job_title', input.jobTitle == null ? '' : String(input.jobTitle));
  await pushValue('level', input.level ?? 'info');
  await pushValue('message', input.message);
  await db.run(`
    INSERT INTO logs (${columns.join(', ')})
    VALUES (${placeholders.join(', ')})
  `, ...values);
}

export async function sessionTenantScope(
  db: Db,
  alias: string,
  tenantId: number,
): Promise<{ sql: string; params: unknown[] }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (await hasTenantId(db, 'sessions')) {
    conditions.push(`${alias}.tenant_id = ?`);
    params.push(tenantId);
  }
  pushTenantSubquery(db, conditions, params, `${alias}.task_id IN (SELECT id FROM tasks WHERE tenant_id = ?)`, ['tasks'], tenantId);
  pushTenantSubquery(db, conditions, params, `${alias}.agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`, ['agents'], tenantId);
  pushTenantSubquery(db, conditions, params, `${alias}.project_id IN (SELECT id FROM projects WHERE tenant_id = ?)`, ['projects'], tenantId);
  if (await tableExists(db, 'job_instances') && await hasTenantId(db, 'tasks') && await hasTenantId(db, 'agents')) {
    conditions.push(`${alias}.instance_id IN (
      SELECT ji.id
      FROM job_instances ji
      LEFT JOIN tasks t ON t.id = ji.task_id
      LEFT JOIN agents a ON a.id = ji.agent_id
      WHERE t.tenant_id = ? OR a.tenant_id = ?
    )`);
    params.push(tenantId, tenantId);
  }
  return conditions.length ? { sql: `(${conditions.join(' OR ')})`, params } : { sql: '1 = 1', params: [] };
}

export async function chatMessageTenantScope(
  db: Db,
  alias: string,
  tenantId: number,
): Promise<{ sql: string; params: unknown[] }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (await hasTenantId(db, 'chat_messages')) {
    conditions.push(`${alias}.tenant_id = ?`);
    params.push(tenantId);
  }
  pushTenantSubquery(db, conditions, params, `${alias}.agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`, ['agents'], tenantId);
  if (await tableExists(db, 'job_instances') && await hasTenantId(db, 'tasks') && await hasTenantId(db, 'agents')) {
    conditions.push(`${alias}.instance_id IN (
      SELECT ji.id
      FROM job_instances ji
      LEFT JOIN tasks t ON t.id = ji.task_id
      LEFT JOIN agents a ON a.id = ji.agent_id
      WHERE t.tenant_id = ? OR a.tenant_id = ?
    )`);
    params.push(tenantId, tenantId);
  }
  return conditions.length ? { sql: `(${conditions.join(' OR ')})`, params } : { sql: '1 = 1', params: [] };
}

export async function instanceTenantScope(
  db: Db,
  alias: string,
  tenantId: number,
): Promise<{ sql: string; params: unknown[] }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (await hasTenantId(db, 'job_instances')) {
    conditions.push(`${alias}.tenant_id = ?`);
    params.push(tenantId);
  }
  pushTenantSubquery(db, conditions, params, `${alias}.task_id IN (SELECT id FROM tasks WHERE tenant_id = ?)`, ['tasks'], tenantId);
  pushTenantSubquery(db, conditions, params, `${alias}.agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`, ['agents'], tenantId);
  return conditions.length ? { sql: `(${conditions.join(' OR ')})`, params } : { sql: '1 = 1', params: [] };
}

export async function logTenantScope(
  db: Db,
  alias: string,
  tenantId: number,
): Promise<{ sql: string; params: unknown[] }> {
  const relationshipConditions: string[] = [];
  const params: unknown[] = [];
  pushTenantSubquery(db, relationshipConditions, params, `${alias}.agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`, ['agents'], tenantId);
  if (await tableExists(db, 'job_instances') && await hasTenantId(db, 'tasks') && await hasTenantId(db, 'agents')) {
    relationshipConditions.push(`${alias}.instance_id IN (
      SELECT ji.id
      FROM job_instances ji
      LEFT JOIN tasks t ON t.id = ji.task_id
      LEFT JOIN agents a ON a.id = ji.agent_id
      WHERE t.tenant_id = ? OR a.tenant_id = ?
    )`);
    params.push(tenantId, tenantId);
  }
  if (!await hasTenantId(db, 'logs')) {
    return relationshipConditions.length ? { sql: `(${relationshipConditions.join(' OR ')})`, params } : { sql: '1 = 1', params: [] };
  }

  const explicitParams: unknown[] = [tenantId];
  if (relationshipConditions.length === 0) {
    return { sql: `(${alias}.tenant_id = ?)`, params: explicitParams };
  }
  return {
    sql: `(${alias}.tenant_id = ? OR (${alias}.tenant_id IS NULL AND (${relationshipConditions.join(' OR ')})))`,
    params: [...explicitParams, ...params],
  };
}
