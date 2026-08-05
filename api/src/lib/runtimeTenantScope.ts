import { tableHasColumn } from './durableRunIdentity';
import { type Db } from "../db/adapter/types";
import { tableExists as sharedTableExists, columnExists as sharedColumnExists, tableColumns as sharedTableColumns, indexExists as sharedIndexExists } from "../db/introspection";

async function tableExists(db: Db, table: string): Promise<boolean> {
    return await sharedTableExists(db, table);
}

async function hasTenantId(db: Db, table: string): Promise<boolean> {
    return await sharedColumnExists(db, table, 'tenant_id');
}

async function pushTenantSubquery(
  db: Db,
  conditions: string[],
  params: unknown[],
  sql: string,
  refs: string[],
  tenantId: number,
): Promise<void> {
  // `.every(async ...)` always returned true, so this guard never fired and the caller
  // appended a tenant condition referencing columns that may not exist.
  const tenantIdPresence = await Promise.all(refs.map((table) => hasTenantId(db, table)));
  if (!tenantIdPresence.every(Boolean)) return;
  conditions.push(sql);
  params.push(tenantId);
}

export async function resolveRuntimeTenantId(
  db: Db,
  input: { taskId?: number | null; agentId?: number | null; projectId?: number | null; instanceId?: number | null },
): Promise<number | null> {
  const candidates: Array<{ source: string; tenantId: number }> = [];
  const addCandidate = (source: string, tenantId: number | null | undefined): void => {
    if (tenantId != null) candidates.push({ source, tenantId });
  };

  if (input.taskId != null && await hasTenantId(db, 'tasks')) {
    const row = await db.get(`SELECT tenant_id FROM tasks WHERE id = ? LIMIT 1`, input.taskId) as { tenant_id: number | null } | undefined;
    addCandidate(`task:${input.taskId}`, row?.tenant_id);
  }

  if (input.instanceId != null && await tableExists(db, 'job_instances')) {
    const instanceTenantExpr = await hasTenantId(db, 'job_instances') ? 'ji.tenant_id' : 'NULL';
    const taskTenantExpr = await hasTenantId(db, 'tasks') ? 't.tenant_id' : 'NULL';
    const agentTenantExpr = await hasTenantId(db, 'agents') ? 'a.tenant_id' : 'NULL';
    const row = await db.get(`
      SELECT ${instanceTenantExpr} AS instance_tenant_id,
             ${taskTenantExpr} AS task_tenant_id,
             ${agentTenantExpr} AS agent_tenant_id
      FROM job_instances ji
      LEFT JOIN tasks t ON t.id = ji.task_id
      LEFT JOIN agents a ON a.id = ji.agent_id
      WHERE ji.id = ?
      LIMIT 1
    `, input.instanceId) as {
      instance_tenant_id: number | null;
      task_tenant_id: number | null;
      agent_tenant_id: number | null;
    } | undefined;
    addCandidate(`instance:${input.instanceId}`, row?.instance_tenant_id);
    addCandidate(`instance-task:${input.instanceId}`, row?.task_tenant_id);
    addCandidate(`instance-agent:${input.instanceId}`, row?.agent_tenant_id);
  }

  if (input.agentId != null && await hasTenantId(db, 'agents')) {
    const row = await db.get(`SELECT tenant_id FROM agents WHERE id = ? LIMIT 1`, input.agentId) as { tenant_id: number | null } | undefined;
    addCandidate(`agent:${input.agentId}`, row?.tenant_id);
  }

  if (input.projectId != null && await hasTenantId(db, 'projects')) {
    const row = await db.get(`SELECT tenant_id FROM projects WHERE id = ? LIMIT 1`, input.projectId) as { tenant_id: number | null } | undefined;
    addCandidate(`project:${input.projectId}`, row?.tenant_id);
  }

  const tenantIds = [...new Set(candidates.map((candidate) => candidate.tenantId))];
  if (tenantIds.length > 1) {
    throw new Error(
      `Conflicting runtime tenant ownership: ${candidates
        .map((candidate) => `${candidate.source}=${candidate.tenantId}`)
        .join(', ')}`,
    );
  }
  return tenantIds[0] ?? null;
}

/**
 * Resolve ownership for a runtime write without ever falling back to the active/default tenant.
 * Every supplied parent is considered; conflicting parent ownership is an error rather than a
 * precedence rule that could silently write data into the wrong tenant.
 */
export async function requireRuntimeTenantId(
  db: Db,
  input: { taskId?: number | null; agentId?: number | null; projectId?: number | null; instanceId?: number | null },
): Promise<number> {
  const tenantId = await resolveRuntimeTenantId(db, input);
  if (tenantId == null) {
    const refs = Object.entries(input)
      .filter(([, value]) => value != null)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(', ');
    throw new Error(`Runtime tenant ownership could not be resolved${refs ? ` (${refs})` : ''}`);
  }
  return tenantId;
}

export async function tenantInsertColumns(
  db: Db,
  table: string,
  tenantId: number | null | undefined,
): Promise<{ columnSql: string; valueSql: string; values: unknown[] }> {
  if (tenantId == null || !await hasTenantId(db, table)) return { columnSql: '', valueSql: '', values: [] };
  return { columnSql: 'tenant_id, ', valueSql: '?, ', values: [tenantId] };
}

/**
 * Strict runtime ownership for migrated tables, while retaining narrow compatibility with unit
 * fixtures that genuinely omit tenant_id. A real production table with tenant_id can never take
 * the empty-column path: unresolved or conflicting parents throw before the INSERT is built.
 */
export async function runtimeTenantInsertColumns(
  db: Db,
  table: string,
  input: { taskId?: number | null; agentId?: number | null; projectId?: number | null; instanceId?: number | null },
): Promise<{ columnSql: string; valueSql: string; values: unknown[] }> {
  if (!await hasTenantId(db, table)) return { columnSql: '', valueSql: '', values: [] };
  return {
    columnSql: 'tenant_id, ',
    valueSql: '?, ',
    values: [await requireRuntimeTenantId(db, input)],
  };
}

/**
 * The fallback is qualified with the table name deliberately.
 *
 * Inside ON CONFLICT ... DO UPDATE SET, a bare `tenant_id` on the right-hand side is ambiguous
 * in PostgreSQL — it could mean the existing row or the proposed `excluded` one — and it is
 * rejected outright with `column reference "tenant_id" is ambiguous`. SQLite silently resolves
 * it to the target table, so the unqualified form worked on one engine and failed on the other.
 * Naming the table is accepted by both and says which row is meant.
 */
export async function tenantUpsertUpdateSql(db: Db, table: string): Promise<string> {
  return await hasTenantId(db, table)
    ? `tenant_id = COALESCE(excluded.tenant_id, ${table}.tenant_id),`
    : '';
}

export async function insertRuntimeLog(
  db: Db,
  input: {
    tenantId?: number | null;
    instanceId?: number | null;
    agentId?: number | null;
    taskId?: number | null;
    projectId?: number | null;
    jobTitle?: string | number | null;
    level?: 'info' | 'warn' | 'error' | 'debug';
    message: string;
  },
): Promise<void> {
  const logHasTenantId = await hasTenantId(db, 'logs');
  let tenantId: number | null = null;
  if (logHasTenantId) {
    const ownership = await resolveRuntimeTenantId(db, {
      taskId: input.taskId,
      instanceId: input.instanceId,
      agentId: input.agentId,
      projectId: input.projectId,
    });
    if (input.tenantId != null && ownership != null && input.tenantId !== ownership) {
      throw new Error(
        `Conflicting runtime tenant ownership: explicit=${input.tenantId}, resolved=${ownership}`,
      );
    }
    tenantId = input.tenantId ?? ownership;
    if (tenantId == null) {
      const refs = Object.entries({
        taskId: input.taskId,
        instanceId: input.instanceId,
        agentId: input.agentId,
        projectId: input.projectId,
      })
        .filter(([, value]) => value != null)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(', ');
      throw new Error(`Runtime tenant ownership could not be resolved${refs ? ` (${refs})` : ''}`);
    }
  }
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
  if (logHasTenantId) {
    columns.push('tenant_id');
    placeholders.push('?');
    values.push(tenantId);
  }
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
  // Every pushTenantSubquery call MUST be awaited. It appends to `conditions` AND to
  // `params`, so an unawaited call defers both appends to a later microtask — and whether
  // they land before `conditions.join(' OR ')` freezes the SQL string comes down to whether
  // the builder happens to await something else first.
  //
  // That is what made the missing awaits so treacherous here. Three of the four builders in
  // this file await a tableExists() query after their pushTenantSubquery calls, and a
  // database round trip is more than enough for the pending appends to land, so they stayed
  // correct BY ACCIDENT. instanceTenantScope, which returns immediately, did not: it emitted
  // SQL with its task_id and agent_id branches dropped, and a `params` array that then grew
  // past the placeholder count, because `params` is returned by reference and the appends
  // arrived after the caller already held it.
  //
  // So the failure takes two shapes, neither visible to the compiler: tenant scope silently
  // narrowed by a missing OR-branch, and a bind count that drifts out of step with the SQL
  // (which PostgreSQL rejects outright). The accidental correctness is the worse half — any
  // refactor that removed or reordered a later await would break tenant scoping in a builder
  // that looks untouched.
  await pushTenantSubquery(db, conditions, params, `${alias}.task_id IN (SELECT id FROM tasks WHERE tenant_id = ?)`, ['tasks'], tenantId);
  await pushTenantSubquery(db, conditions, params, `${alias}.agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`, ['agents'], tenantId);
  await pushTenantSubquery(db, conditions, params, `${alias}.project_id IN (SELECT id FROM projects WHERE tenant_id = ?)`, ['projects'], tenantId);
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
  await pushTenantSubquery(db, conditions, params, `${alias}.agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`, ['agents'], tenantId);
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
  await pushTenantSubquery(db, conditions, params, `${alias}.task_id IN (SELECT id FROM tasks WHERE tenant_id = ?)`, ['tasks'], tenantId);
  await pushTenantSubquery(db, conditions, params, `${alias}.agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`, ['agents'], tenantId);
  return conditions.length ? { sql: `(${conditions.join(' OR ')})`, params } : { sql: '1 = 1', params: [] };
}

export async function logTenantScope(
  db: Db,
  alias: string,
  tenantId: number,
): Promise<{ sql: string; params: unknown[] }> {
  const relationshipConditions: string[] = [];
  const params: unknown[] = [];
  // The only one of the four whose failure mode WIDENS rather than narrows, which is why it
  // is worth calling out separately. `relationshipConditions` starts empty here, so this call
  // is the only thing that can populate it before the job_instances check. Unawaited, on a
  // schema whose `logs` table has no tenant_id column, both branches below fall through to
  // `1 = 1` — no tenant predicate at all, exposing every tenant's logs. The tableExists()
  // await below currently masks it, but that is timing, not a guarantee.
  await pushTenantSubquery(db, relationshipConditions, params, `${alias}.agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`, ['agents'], tenantId);
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
