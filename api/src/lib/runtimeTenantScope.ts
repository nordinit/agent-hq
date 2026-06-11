import type Database from 'better-sqlite3';
import { tableHasColumn } from './durableRunIdentity';

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`).get(table) as { name?: string } | undefined)?.name);
}

function hasTenantId(db: Database.Database, table: string): boolean {
  return tableExists(db, table) && tableHasColumn(db, table, 'tenant_id');
}

function pushTenantSubquery(
  db: Database.Database,
  conditions: string[],
  params: unknown[],
  sql: string,
  refs: string[],
  tenantId: number,
): void {
  if (!refs.every((table) => hasTenantId(db, table))) return;
  conditions.push(sql);
  params.push(tenantId);
}

export function resolveRuntimeTenantId(
  db: Database.Database,
  input: { taskId?: number | null; agentId?: number | null; projectId?: number | null; instanceId?: number | null },
): number | null {
  if (input.taskId != null && hasTenantId(db, 'tasks')) {
    const row = db.prepare(`SELECT tenant_id FROM tasks WHERE id = ? LIMIT 1`).get(input.taskId) as { tenant_id: number | null } | undefined;
    if (row?.tenant_id != null) return row.tenant_id;
  }

  if (input.instanceId != null && tableExists(db, 'job_instances')) {
    const taskTenantExpr = hasTenantId(db, 'tasks') ? 't.tenant_id' : 'NULL';
    const agentTenantExpr = hasTenantId(db, 'agents') ? 'a.tenant_id' : 'NULL';
    const row = db.prepare(`
      SELECT COALESCE(${taskTenantExpr}, ${agentTenantExpr}) AS tenant_id
      FROM job_instances ji
      LEFT JOIN tasks t ON t.id = ji.task_id
      LEFT JOIN agents a ON a.id = ji.agent_id
      WHERE ji.id = ?
      LIMIT 1
    `).get(input.instanceId) as { tenant_id: number | null } | undefined;
    if (row?.tenant_id != null) return row.tenant_id;
  }

  if (input.agentId != null && hasTenantId(db, 'agents')) {
    const row = db.prepare(`SELECT tenant_id FROM agents WHERE id = ? LIMIT 1`).get(input.agentId) as { tenant_id: number | null } | undefined;
    if (row?.tenant_id != null) return row.tenant_id;
  }

  if (input.projectId != null && hasTenantId(db, 'projects')) {
    const row = db.prepare(`SELECT tenant_id FROM projects WHERE id = ? LIMIT 1`).get(input.projectId) as { tenant_id: number | null } | undefined;
    if (row?.tenant_id != null) return row.tenant_id;
  }

  return null;
}

export function tenantInsertColumns(
  db: Database.Database,
  table: string,
  tenantId: number | null | undefined,
): { columnSql: string; valueSql: string; values: unknown[] } {
  if (tenantId == null || !hasTenantId(db, table)) return { columnSql: '', valueSql: '', values: [] };
  return { columnSql: 'tenant_id, ', valueSql: '?, ', values: [tenantId] };
}

export function tenantUpsertUpdateSql(db: Database.Database, table: string): string {
  return hasTenantId(db, table) ? 'tenant_id = COALESCE(excluded.tenant_id, tenant_id),' : '';
}

export function insertRuntimeLog(
  db: Database.Database,
  input: {
    instanceId?: number | null;
    agentId?: number | null;
    taskId?: number | null;
    projectId?: number | null;
    jobTitle?: string | number | null;
    level?: 'info' | 'warn' | 'error' | 'debug';
    message: string;
  },
): void {
  const tenantId = resolveRuntimeTenantId(db, {
    taskId: input.taskId,
    instanceId: input.instanceId,
    agentId: input.agentId,
    projectId: input.projectId,
  });
  const columns: string[] = [];
  const placeholders: string[] = [];
  const values: unknown[] = [];
  const pushValue = (column: string, value: unknown): void => {
    if (!tableHasColumn(db, 'logs', column)) return;
    columns.push(column);
    placeholders.push('?');
    values.push(value);
  };
  pushValue('tenant_id', tenantId);
  pushValue('instance_id', input.instanceId ?? null);
  pushValue('agent_id', input.agentId ?? null);
  pushValue('job_title', input.jobTitle == null ? '' : String(input.jobTitle));
  pushValue('level', input.level ?? 'info');
  pushValue('message', input.message);
  db.prepare(`
    INSERT INTO logs (${columns.join(', ')})
    VALUES (${placeholders.join(', ')})
  `).run(...values);
}

export function sessionTenantScope(
  db: Database.Database,
  alias: string,
  tenantId: number,
): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (hasTenantId(db, 'sessions')) {
    conditions.push(`${alias}.tenant_id = ?`);
    params.push(tenantId);
  }
  pushTenantSubquery(db, conditions, params, `${alias}.task_id IN (SELECT id FROM tasks WHERE tenant_id = ?)`, ['tasks'], tenantId);
  pushTenantSubquery(db, conditions, params, `${alias}.agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`, ['agents'], tenantId);
  pushTenantSubquery(db, conditions, params, `${alias}.project_id IN (SELECT id FROM projects WHERE tenant_id = ?)`, ['projects'], tenantId);
  if (tableExists(db, 'job_instances') && hasTenantId(db, 'tasks') && hasTenantId(db, 'agents')) {
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

export function chatMessageTenantScope(
  db: Database.Database,
  alias: string,
  tenantId: number,
): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (hasTenantId(db, 'chat_messages')) {
    conditions.push(`${alias}.tenant_id = ?`);
    params.push(tenantId);
  }
  pushTenantSubquery(db, conditions, params, `${alias}.agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`, ['agents'], tenantId);
  if (tableExists(db, 'job_instances') && hasTenantId(db, 'tasks') && hasTenantId(db, 'agents')) {
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

export function instanceTenantScope(
  db: Database.Database,
  alias: string,
  tenantId: number,
): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (hasTenantId(db, 'job_instances')) {
    conditions.push(`${alias}.tenant_id = ?`);
    params.push(tenantId);
  }
  pushTenantSubquery(db, conditions, params, `${alias}.task_id IN (SELECT id FROM tasks WHERE tenant_id = ?)`, ['tasks'], tenantId);
  pushTenantSubquery(db, conditions, params, `${alias}.agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`, ['agents'], tenantId);
  return conditions.length ? { sql: `(${conditions.join(' OR ')})`, params } : { sql: '1 = 1', params: [] };
}

export function logTenantScope(
  db: Database.Database,
  alias: string,
  tenantId: number,
): { sql: string; params: unknown[] } {
  const relationshipConditions: string[] = [];
  const params: unknown[] = [];
  pushTenantSubquery(db, relationshipConditions, params, `${alias}.agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`, ['agents'], tenantId);
  if (tableExists(db, 'job_instances') && hasTenantId(db, 'tasks') && hasTenantId(db, 'agents')) {
    relationshipConditions.push(`${alias}.instance_id IN (
      SELECT ji.id
      FROM job_instances ji
      LEFT JOIN tasks t ON t.id = ji.task_id
      LEFT JOIN agents a ON a.id = ji.agent_id
      WHERE t.tenant_id = ? OR a.tenant_id = ?
    )`);
    params.push(tenantId, tenantId);
  }
  if (!hasTenantId(db, 'logs')) {
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
