import { randomUUID } from 'crypto';
import { getDb } from '../../db/client';
import {
  buildGatewayDirectSessionKey,
  parseAgentSessionKey,
} from '../../lib/sessionKeys';
import { chatMessageTenantScope, sessionTenantScope } from '../../lib/runtimeTenantScope';
import { type Db } from "../../db/adapter/types";
import { tableColumns as sharedTableColumns } from "../../db/introspection";

function sessionSlug(sessionKey: string | null | undefined): string | null {
  const parsed = parseAgentSessionKey(sessionKey);
  return parsed?.runtimeSlug ?? null;
}

function readPositiveInteger(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function readOptionalPositiveInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function resolveAgentRowForSessionKey(sessionKey: string | null | undefined): Promise<Record<string, unknown> | null> {
  const db = getDb();
  const directAgent = await db.get(`
    SELECT *
    FROM agents
    WHERE session_key = ?
    LIMIT 1
  `, sessionKey ?? null) as Record<string, unknown> | undefined;
  if (directAgent) return directAgent;

  const slug = sessionSlug(sessionKey);
  if (!slug) return null;

  const agent = await db.get(`
    SELECT *
    FROM agents
    WHERE openclaw_agent_id = ?
       OR session_key LIKE ?
       OR session_key LIKE ?
    ORDER BY CASE WHEN openclaw_agent_id = ? THEN 0 ELSE 1 END, id DESC
    LIMIT 1
  `, slug, `agent:${slug}:%`, `agent:%:${slug}:%`, slug) as Record<string, unknown> | undefined;

  return agent ?? null;
}

export async function resolveAgentRowById(agentId: number | null | undefined): Promise<Record<string, unknown> | null> {
  if (typeof agentId !== 'number') return null;
  const db = getDb();
  return (await db.get('SELECT * FROM agents WHERE id = ?', agentId) as Record<string, unknown> | undefined) ?? null;
}

export async function getCanonicalChatSessionKey(agentId: number, channel = 'web'): Promise<string | null> {
  const db = getDb();
  const row = await db.get(`
    SELECT session_key
    FROM canonical_chat_sessions
    WHERE agent_id = ? AND channel = ?
    LIMIT 1
  `, agentId, channel) as { session_key?: string | null } | undefined;
  return typeof row?.session_key === 'string' && row.session_key.trim() ? row.session_key.trim() : null;
}

export async function setCanonicalChatSessionKey(agentId: number, sessionKey: string, channel = 'web'): Promise<string> {
  const db = getDb();
  await db.run(`
    INSERT INTO canonical_chat_sessions (agent_id, channel, session_key, created_at, updated_at)
    VALUES (?, ?, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
    ON CONFLICT(agent_id, channel)
    DO UPDATE SET session_key = excluded.session_key, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
  `, agentId, channel, sessionKey);
  return sessionKey;
}

export async function buildDerivedDirectSessionKey(
  sessionKey: string,
  channel = 'web',
  agentId?: number | null,
  rotate = false,
): Promise<string | null> {
  const agent = typeof agentId === 'number'
    ? (await resolveAgentRowById(agentId)) ?? undefined
    : (await resolveAgentRowForSessionKey(sessionKey)) ?? undefined;
  if (!agent) return null;
  const resolvedAgentId = Number(agent.id);
  if (!Number.isFinite(resolvedAgentId)) return null;

  if (!rotate) {
    const existing = await getCanonicalChatSessionKey(resolvedAgentId, channel);
    if (existing) return existing;
  }

  const next = buildGatewayDirectSessionKey(agent, channel, randomUUID());
  if (!next) return null;
  return await setCanonicalChatSessionKey(resolvedAgentId, next, channel);
}

export async function listChatSessions(
  db: Db,
  query: { agent_id?: unknown; instance_id?: unknown; project_id?: unknown; limit?: unknown; offset?: unknown; tenantId?: number },
): Promise<Array<Record<string, unknown>>> {
  const agentId = readOptionalPositiveInteger(query.agent_id);
  const instanceId = readOptionalPositiveInteger(query.instance_id);
  const projectId = readOptionalPositiveInteger(query.project_id);
  const limit = readPositiveInteger(query.limit, 50, 500);
  const offset = readPositiveInteger(query.offset, 0, Number.MAX_SAFE_INTEGER);
  const queryLimit = limit + offset;
  const tenantId = query.tenantId;
  const jobInstanceColumns = await sharedTableColumns(db, 'job_instances');
  const hasJobInstanceDurableRunId = jobInstanceColumns.includes('durable_run_id');
  const canonicalFilters = [
    '(?::text IS NULL OR s.agent_id = ?)',
    '(?::text IS NULL OR s.instance_id = ?)',
    '(?::text IS NULL OR s.project_id = ?)',
  ];
  const canonicalTenant = tenantId ? await sessionTenantScope(db, 's', tenantId) : { sql: '1 = 1', params: [] };

  const canonicalRows = await db.all(`
    WITH canonical_sessions AS (
      SELECT
        s.instance_id,
        ${hasJobInstanceDurableRunId ? 'ji.durable_run_id' : 'NULL'} AS durable_run_id,
        s.external_key AS session_key,
        s.agent_id,
        a.name AS agent_name,
        s.message_count AS message_count,
        COALESCE(s.started_at, s.created_at) AS started_at,
        COALESCE(s.updated_at, s.ended_at, s.started_at, s.created_at) AS last_activity,
        s.project_id,
        p.name AS project_name,
        CASE
          WHEN p.name IS NOT NULL AND TRIM(p.name) != '' THEN lower(replace(trim(p.name), ' ', '-'))
          ELSE NULL
        END AS project_slug,
        CASE
          WHEN s.project_id IS NOT NULL THEN 'task'
          ELSE 'none'
        END AS project_source
      FROM sessions s
      LEFT JOIN agents a ON a.id = s.agent_id
      LEFT JOIN job_instances ji ON ji.id = s.instance_id
      LEFT JOIN projects p ON p.id = s.project_id
      WHERE ${canonicalFilters.join(' AND ')}
        AND ${canonicalTenant.sql}
      ORDER BY last_activity DESC
      LIMIT ?
    )
    SELECT
      cs.*,
      lm.content AS last_message,
      lm.role AS last_role
    FROM canonical_sessions cs
    LEFT JOIN chat_messages lm ON lm.id = (
      SELECT cm_last.id
      FROM chat_messages cm_last
      WHERE (
        (cs.instance_id IS NOT NULL AND cm_last.instance_id = cs.instance_id)
        OR (cs.instance_id IS NULL AND cm_last.session_key = cs.session_key)
      )
      ORDER BY cm_last.timestamp DESC
      LIMIT 1
    )
    ORDER BY cs.last_activity DESC
  `, agentId, agentId, instanceId, instanceId, projectId, projectId, ...canonicalTenant.params, queryLimit) as Array<Record<string, unknown>>;

  const rawLimit = queryLimit;

  const cols = await sharedTableColumns(db, 'chat_messages');
  const hasSessionKey = cols.includes('session_key');
  const hasDurableRunId = cols.includes('durable_run_id');

  const params: unknown[] = [];
  const filters: string[] = [];
  if (agentId) {
    filters.push('cm.agent_id = ?');
    params.push(agentId);
  }
  if (instanceId) {
    filters.push('cm.instance_id = ?');
    params.push(instanceId);
  }
  if (projectId) {
    filters.push('t.project_id = ?');
    params.push(projectId);
  }
  if (tenantId) {
    const rawTenant = await chatMessageTenantScope(db, 'cm', tenantId);
    filters.push(rawTenant.sql);
    params.push(...rawTenant.params);
  }
  filters.push(`NOT EXISTS (
    SELECT 1
    FROM sessions sx
    WHERE (cm.instance_id IS NOT NULL AND sx.instance_id = cm.instance_id)
       OR (${hasSessionKey ? 'cm.session_key IS NOT NULL AND cm.session_key != \'\' AND sx.external_key = cm.session_key' : '0'})
  )`);
  params.push(rawLimit);

  const rawWhere = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const sessionKeyGroupBy = hasSessionKey && hasDurableRunId
    ? "COALESCE(cm.durable_run_id, CAST(cm.instance_id AS TEXT), cm.session_key)"
    : hasSessionKey
    ? "COALESCE(CAST(cm.instance_id AS TEXT), cm.session_key)"
    : "COALESCE(CAST(cm.instance_id AS TEXT), CAST(cm.agent_id AS TEXT))";
  const rawSourceDurableRunSelect = hasDurableRunId ? 'cm.durable_run_id AS cm_durable_run_id' : 'NULL AS cm_durable_run_id';
  const rawSourceSessionKeySelect = hasSessionKey ? 'cm.session_key AS cm_session_key' : "'' AS cm_session_key";
  const rawGroupDurableRunSelect = hasDurableRunId && hasJobInstanceDurableRunId
    ? 'COALESCE(MAX(ji_durable_run_id), MAX(cm_durable_run_id)) AS durable_run_id'
    : hasDurableRunId
    ? 'MAX(cm_durable_run_id) AS durable_run_id'
    : `${hasJobInstanceDurableRunId ? 'MAX(ji_durable_run_id)' : 'NULL'} AS durable_run_id`;

  const rawRows = await db.all(`
    WITH raw_source AS (
      SELECT
        cm.id,
        cm.instance_id,
        ${rawSourceDurableRunSelect},
        ${rawSourceSessionKeySelect},
        cm.agent_id,
        cm.role,
        cm.content,
        cm.timestamp,
        a.name AS agent_name,
        ${hasJobInstanceDurableRunId ? 'ji.durable_run_id' : 'NULL'} AS ji_durable_run_id,
        t.project_id AS project_id,
        p.name AS project_name,
        CASE
          WHEN p.name IS NOT NULL AND TRIM(p.name) != '' THEN lower(replace(trim(p.name), ' ', '-'))
          ELSE NULL
        END AS project_slug,
        CASE
          WHEN t.project_id IS NOT NULL THEN 'task'
          ELSE 'none'
        END AS project_source,
        ${sessionKeyGroupBy} AS session_group_key
      FROM chat_messages cm
      LEFT JOIN agents a ON a.id = cm.agent_id
      LEFT JOIN job_instances ji ON ji.id = cm.instance_id
      LEFT JOIN tasks t ON t.id = ji.task_id
      LEFT JOIN projects p ON p.id = t.project_id
      ${rawWhere}
    ),
    raw_groups AS (
      SELECT
        MAX(instance_id) AS instance_id,
        ${rawGroupDurableRunSelect},
        MAX(cm_session_key) AS session_key,
        agent_id,
        MAX(agent_name) AS agent_name,
        COUNT(*) AS message_count,
        MIN(timestamp) AS started_at,
        MAX(timestamp) AS last_activity,
        MAX(project_id) AS project_id,
        MAX(project_name) AS project_name,
        MAX(project_slug) AS project_slug,
        MAX(project_source) AS project_source,
        session_group_key
      FROM raw_source
      GROUP BY agent_id, session_group_key
      ORDER BY last_activity DESC
      LIMIT ?
    ),
    raw_last AS (
      SELECT *
      FROM (
        SELECT
          raw_source.*,
          ROW_NUMBER() OVER (
            PARTITION BY agent_id, session_group_key
            ORDER BY timestamp DESC
          ) AS row_number
        FROM raw_source
      ) ranked
      WHERE row_number = 1
    )
    SELECT
      rg.instance_id,
      rg.durable_run_id,
      rg.session_key,
      rg.agent_id,
      rg.agent_name,
      rg.message_count,
      rg.started_at,
      rg.last_activity,
      rg.project_id,
      rg.project_name,
      rg.project_slug,
      rg.project_source,
      rl.content AS last_message,
      rl.role AS last_role
    FROM raw_groups rg
    LEFT JOIN raw_last rl
      ON rl.agent_id = rg.agent_id
      AND rl.session_group_key = rg.session_group_key
    ORDER BY rg.last_activity DESC
  `, ...params) as Array<Record<string, unknown>>;

  const rawMapped: Array<Record<string, unknown>> = rawRows.map((row) => ({
    ...row,
    project_id: row.project_id ?? null,
    project_name: row.project_name ?? null,
    project_slug: row.project_slug ?? null,
    project_source: row.project_source === 'task' ? 'task' : 'none',
  }));

  return [...canonicalRows, ...rawMapped]
    .sort((a, b) => String(b.last_activity ?? '').localeCompare(String(a.last_activity ?? '')))
    .slice(offset, offset + limit);
}

export async function listChatSessionMessages(
  db: Db,
  rawInstanceId: string,
  query: { session_key?: unknown; durable_run_id?: unknown; limit?: unknown; offset?: unknown; tenantId?: number },
): Promise<unknown[]> {
  const instanceId = rawInstanceId === '0' ? null : Number(rawInstanceId);
  const sessionKey = typeof query.session_key === 'string' ? query.session_key : '';
  const limit = Math.min(Number(query.limit ?? 200), 500);
  const offset = Math.max(Number(query.offset ?? 0), 0);

  const cols = await sharedTableColumns(db, 'chat_messages');
  const hasSessionKey = cols.includes('session_key');
  const hasDurableRunId = cols.includes('durable_run_id');
  const tenantId = query.tenantId;
  const tenantScope = tenantId ? await chatMessageTenantScope(db, 'chat_messages', tenantId) : { sql: '1 = 1', params: [] };

  const selectCols = hasSessionKey
    ? `id, agent_id, instance_id, ${hasDurableRunId ? 'durable_run_id' : 'NULL AS durable_run_id'}, session_key, role, content, timestamp, event_type, event_meta`
    : `id, agent_id, instance_id, ${hasDurableRunId ? 'durable_run_id' : 'NULL AS durable_run_id'}, '' AS session_key, role, content, timestamp, event_type, event_meta`;

  if (instanceId === null) {
    if (hasSessionKey) {
      // Match the whole chat session by key, regardless of instance_id. Direct/agent
      // chats are now saved as per-turn job_instances (like every other agent run), so
      // their rows carry an instance_id; the bubble still loads the conversation by its
      // stable session_key across those turns (and any legacy instance-less rows).
      return await db.all(`
        SELECT ${selectCols}
        FROM chat_messages
        WHERE session_key = ?
          AND ${tenantScope.sql}
        ORDER BY timestamp ASC
        LIMIT ? OFFSET ?
      `, sessionKey, ...tenantScope.params, limit, offset);
    }
    return await db.all(`
      SELECT ${selectCols}
      FROM chat_messages
      WHERE instance_id IS NULL
        AND ${tenantScope.sql}
      ORDER BY timestamp ASC
      LIMIT ? OFFSET ?
    `, ...tenantScope.params, limit, offset);
  }

  const durableRunId = hasDurableRunId && typeof query.durable_run_id === 'string' && query.durable_run_id.trim()
    ? query.durable_run_id.trim()
    : null;
  if (durableRunId) {
    return await db.all(`
      SELECT ${selectCols}
      FROM chat_messages
      WHERE durable_run_id = ?
        AND ${tenantScope.sql}
      ORDER BY timestamp ASC
      LIMIT ? OFFSET ?
    `, durableRunId, ...tenantScope.params, limit, offset);
  }

  const currentDurableRunId = hasDurableRunId && Number.isFinite(instanceId)
    ? (await db.get(`SELECT durable_run_id FROM job_instances WHERE id = ?`, instanceId) as { durable_run_id?: string | null } | undefined)?.durable_run_id ?? null
    : null;
  const durableGuard = currentDurableRunId ? `AND (durable_run_id IS NULL OR durable_run_id = ?)` : '';
  const params = currentDurableRunId
    ? [instanceId, currentDurableRunId, ...tenantScope.params, limit, offset]
    : [instanceId, ...tenantScope.params, limit, offset];

  return await db.all(`
    SELECT ${selectCols}
    FROM chat_messages
    WHERE instance_id = ?
    ${durableGuard}
    AND ${tenantScope.sql}
    ORDER BY timestamp ASC
    LIMIT ? OFFSET ?
  `, ...params);
}
