import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import {
  ensureCanonicalSessionByExternalKey,
  ensureCanonicalSessionForInstance,
  ingestSessionByExternalKey,
  SessionIngestTenantError,
  syncSessionMessagesFromChatMessages,
} from '../lib/canonicalSessions';
import { resolveSessionAdapterForKey } from '../lib/sessionAdapters';
import {
  buildReflectionContext,
  buildAgentReflectionSummary,
  buildTaskSessionHistory,
} from '../lib/reflectionContext';
import { normalizeChatMessageRole } from '../lib/chatMessageRoles';
import { toCanonicalTimestamp } from '../lib/timestamps';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';
import { chatMessageTenantScope, instanceTenantScope, sessionTenantScope } from '../lib/runtimeTenantScope';

import { requireNumericId } from '../lib/routeParams';

const router = Router();
// Rejects a non-numeric :id before it reaches the database, restoring the 404 SQLite
// returned for a no-match. Must be per-router: app.param() does not fire for a param
// declared on a mounted sub-router.
router.param('id', requireNumericId);

function parsePositiveInt(value: unknown, fallback: number, max?: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  const i = Math.floor(n);
  if (typeof max === 'number') return Math.min(i, max);
  return i;
}

// GET /api/v1/sessions
router.get('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const filters: string[] = [];
    const params: unknown[] = [];
    const tenantScope = await sessionTenantScope(db, 's', tenantId);
    filters.push(tenantScope.sql);
    params.push(...tenantScope.params);

    const pushEq = (column: string, value: unknown) => {
      if (value === undefined || value === null || value === '') return;
      filters.push(`${column} = ?`);
      params.push(value);
    };

    pushEq('s.agent_id', req.query.agent_id);
    pushEq('s.task_id', req.query.task_id);
    pushEq('s.instance_id', req.query.instance_id);
    pushEq('s.project_id', req.query.project_id);
    pushEq('s.runtime', req.query.runtime);
    pushEq('s.status', req.query.status);

    const limit = parsePositiveInt(req.query.limit, 50, 500);
    const offset = parsePositiveInt(req.query.offset, 0);
    params.push(limit, offset);

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const sessions = await db.all(`
      SELECT
        s.*,
        a.name AS agent_name,
        t.title AS task_title,
        p.name AS project_name
      FROM sessions s
      LEFT JOIN agents a ON a.id = s.agent_id
      LEFT JOIN tasks t ON t.id = s.task_id
      LEFT JOIN projects p ON p.id = s.project_id
      ${where}
      ORDER BY COALESCE(s.started_at, s.created_at) DESC, s.id DESC
      LIMIT ? OFFSET ?
    `, ...params) as Array<Record<string, unknown>>;

    if (String(req.query.include_messages ?? '') === 'true') {
      const msgSql = `
        SELECT id, session_id, ordinal, role, event_type, content, event_meta, raw_payload, timestamp, created_at
        FROM session_messages
        WHERE session_id = ?
        ORDER BY ordinal ASC
      `;
      for (const session of sessions) {
        session.messages = await db.all(msgSql, session.id);
      }
    }

    return res.json(sessions);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/sessions/by-key/:externalKey
// Must be before /:id to avoid being captured as a numeric id.
router.get('/by-key/:externalKey', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const session = await ensureCanonicalSessionByExternalKey(req.params.externalKey, tenantId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const scope = await sessionTenantScope(db, 's', tenantId);
    const visible = await db.get(`SELECT id FROM sessions s WHERE s.id = ? AND ${scope.sql}`, session.id, ...scope.params);
    if (!visible) return res.status(404).json({ error: 'Session not found' });
    return res.json(session);
  } catch (err) {
    if (err instanceof SessionIngestTenantError) return res.status(404).json({ error: err.message });
    return res.status(500).json({ error: String(err) });
  }
});

// ── Reflection / learning endpoints ──────────────────────────────────────────
// NOTE: All literal-segment routes (for-agent, for-task) MUST be registered
// before the /:id wildcard to avoid Express capturing them as ids.

// GET /api/v1/sessions/for-agent/:agentId
// Summary of all sessions for an agent, ordered by most recent first.
// Query params: limit (default 50, max 500)
router.get('/for-agent/:agentId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const agentId = Number(req.params.agentId);
    if (!Number.isFinite(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
    const visible = await db.get(`SELECT id FROM agents WHERE id = ? AND tenant_id = ?`, agentId, tenantId);
    if (!visible) return res.status(404).json({ error: 'Agent not found' });

    const limit = parsePositiveInt(req.query.limit, 50, 500);
    const rows = await buildAgentReflectionSummary(agentId, limit);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/sessions/for-task/:taskId
// All sessions/run instances for a task, ordered by most recent first.
// Useful for reflection: inspect how a task evolved across retries and handoffs.
router.get('/for-task/:taskId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const taskId = Number(req.params.taskId);
    if (!Number.isFinite(taskId)) return res.status(400).json({ error: 'Invalid task id' });
    const visible = await db.get(`SELECT id FROM tasks WHERE id = ? AND tenant_id = ?`, taskId, tenantId);
    if (!visible) return res.status(404).json({ error: 'Task not found' });

    const rows = await buildTaskSessionHistory(taskId);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/sessions/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const id = Number(req.params.id);
    const tenantScope = await sessionTenantScope(db, 's', tenantId);
    const session = await db.get(`
      SELECT
        s.*,
        a.name AS agent_name,
        t.title AS task_title,
        p.name AS project_name
      FROM sessions s
      LEFT JOIN agents a ON a.id = s.agent_id
      LEFT JOIN tasks t ON t.id = s.task_id
      LEFT JOIN projects p ON p.id = s.project_id
      WHERE s.id = ? AND ${tenantScope.sql}
    `, id, ...tenantScope.params) as Record<string, unknown> | undefined;

    if (!session) return res.status(404).json({ error: 'Session not found' });
    return res.json(session);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/sessions/:id/messages
// For active (running) sessions, sync latest chat_messages into session_messages before
// returning so live polling picks up new streamed events without a separate ingest call.
router.get('/:id/messages', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const id = Number(req.params.id);
    const tenantScope = await sessionTenantScope(db, 'sessions', tenantId);
    const session = await db.get(`SELECT id, status, instance_id, external_key FROM sessions WHERE id = ? AND ${tenantScope.sql}`, id, ...tenantScope.params) as {
      id: number; status: string; instance_id: number | null; external_key: string;
    } | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Live sync for active sessions: merge new chat_messages rows into session_messages
    // so that polling consumers see fresh streamed events without needing force-ingest.
    // Uses chat_messages.id stored as raw_payload for dedup — any rows already indexed
    // are skipped; only net-new rows are appended.
    if (session.status === 'active') {
      try {
        if (session.instance_id != null) {
          await syncSessionMessagesFromChatMessages(db, session.id, session.instance_id);
        } else {
          const newRows = await db.all(`
              SELECT cm.id, cm.role, cm.content, cm.timestamp, cm.event_type, cm.event_meta
              FROM chat_messages cm
              WHERE cm.instance_id IS NULL
                AND cm.session_key = ?
                AND ${(await chatMessageTenantScope(db, 'cm', tenantId)).sql}
              ORDER BY cm.timestamp ASC, cm.id ASC
            `, session.external_key, ...(await chatMessageTenantScope(db, 'cm', tenantId)).params) as Array<{
            id: string; role: string; content: string; timestamp: string;
            event_type: string | null; event_meta: string | null;
          }>;

          if (newRows.length > 0) {
            const existingRows = await db.all(`
              SELECT raw_payload, ordinal
              FROM session_messages
              WHERE session_id = ? AND raw_payload IS NOT NULL
            `, session.id) as Array<{ raw_payload: string; ordinal: number }>;
            const ordinalByRawPayload = new Map(
              existingRows.map((row) => [String(row.raw_payload), row.ordinal] as const),
            );

            const maxOrdinalRow = await db.get('SELECT COALESCE(MAX(ordinal), -1) AS max_ord FROM session_messages WHERE session_id = ?', session.id) as { max_ord: number };

            const insertSql = `
              INSERT INTO session_messages (session_id, ordinal, role, event_type, content, event_meta, raw_payload, timestamp, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
              ON CONFLICT(session_id, ordinal) DO UPDATE SET
                content = excluded.content,
                event_type = excluded.event_type,
                event_meta = excluded.event_meta,
                timestamp = excluded.timestamp
            `;

            let ordinal = maxOrdinalRow.max_ord + 1;
            await db.withTransaction(async (db) => {
              for (const row of newRows) {
                const rawPayload = String(row.id);
                const nextOrdinal = ordinalByRawPayload.get(rawPayload) ?? ordinal++;
                await db.run(
                  insertSql,
                  session.id,
                  nextOrdinal,
                  normalizeChatMessageRole(row.role, row.event_type ?? 'text'),
                  row.event_type ?? 'text',
                  row.content,
                  row.event_meta ?? '{}',
                  rawPayload,
                  toCanonicalTimestamp(row.timestamp),
                );
              }
            });

            await db.run(`
              UPDATE sessions
              SET message_count = (SELECT COUNT(*) FROM session_messages WHERE session_id = ?),
                  updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
              WHERE id = ?
            `, session.id, session.id);
          }
        }
      } catch (syncErr) {
        // Non-fatal — still return whatever we have
        console.warn('[sessions] Live sync error:', syncErr instanceof Error ? syncErr.message : String(syncErr));
      }
    }

    const filters = ['session_id = ?'];
    const params: unknown[] = [id];

    if (req.query.event_type) {
      filters.push('event_type = ?');
      params.push(String(req.query.event_type));
    }

    const limit = parsePositiveInt(req.query.limit, 100, 500);
    const offset = parsePositiveInt(req.query.offset, 0);
    params.push(limit, offset);

    const rows = await db.all(`
      SELECT id, session_id, ordinal, role, event_type, content, event_meta, raw_payload, timestamp, created_at
      FROM session_messages
      WHERE ${filters.join(' AND ')}
      ORDER BY ordinal ASC
      LIMIT ? OFFSET ?
    `, ...params);

    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/sessions/:id/context
// Returns the composite reflection context: session + messages + task context + run history.
// Designed for reflection/learning subagents — one call returns everything needed to reason
// about a prior run without runtime-specific storage lookups.
//
// Query params:
//   event_types       — comma-separated event types to include (default: all)
//   message_limit     — max messages (default 200, max 500)
//   include_raw       — include raw_payload column (default false)
//   run_history_limit — max run history entries (default 20, max 100)
router.get('/:id/context', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid session id' });
    const scope = await sessionTenantScope(db, 's', tenantId);
    const visible = await db.get(`SELECT id FROM sessions s WHERE s.id = ? AND ${scope.sql}`, id, ...scope.params);
    if (!visible) return res.status(404).json({ error: 'Session not found' });

    const eventTypesParam = String(req.query.event_types ?? '').trim();
    const eventTypes = eventTypesParam ? eventTypesParam.split(',').map(s => s.trim()).filter(Boolean) : undefined;

    const ctx = await buildReflectionContext(id, {
          eventTypes,
          messageLimit: parsePositiveInt(req.query.message_limit, 200, 500),
          includeRaw: String(req.query.include_raw ?? '') === 'true',
          runHistoryLimit: parsePositiveInt(req.query.run_history_limit, 20, 100),
        });

    if (!ctx) return res.status(404).json({ error: 'Session not found' });
    return res.json(ctx);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// POST /api/v1/sessions/import/instance/:instanceId
// Force-ingest a session from a job instance (re-runs adapter even if already imported).
router.post('/import/instance/:instanceId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const instanceId = Number(req.params.instanceId);
    const scope = await instanceTenantScope(db, 'ji', tenantId);
    const visible = await db.get(`SELECT id FROM job_instances ji WHERE ji.id = ? AND ${scope.sql}`, instanceId, ...scope.params);
    if (!visible) return res.status(404).json({ error: 'Instance/session not found' });
    const session = await ensureCanonicalSessionForInstance(Number(req.params.instanceId), {
      forceIngest: Boolean((req.body as { force?: boolean } | undefined)?.force),
    });
    if (!session) return res.status(404).json({ error: 'Instance/session not found' });
    return res.json(session);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// POST /api/v1/sessions/ingest
// Ingest a session by external key, using the appropriate runtime adapter.
// Body: { external_key: string, instance_id?: number, agent_id?: number, task_id?: number, project_id?: number, runtime?: string, force?: boolean }
router.post('/ingest', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const body = req.body as {
      external_key?: string;
      instance_id?: number;
      agent_id?: number;
      task_id?: number;
      project_id?: number;
      runtime?: string;
      force?: boolean;
    };

    if (!body.external_key) {
      return res.status(400).json({ error: 'external_key is required' });
    }

    const session = await ingestSessionByExternalKey(
      body.external_key,
      tenantId,
      {
        instanceId: body.instance_id,
        agentId: body.agent_id,
        taskId: body.task_id,
        projectId: body.project_id,
      },
      body.runtime,
    );

    if (!session) {
      return res.status(404).json({ error: 'Session not found or could not be ingested', external_key: body.external_key });
    }
    const scope = await sessionTenantScope(db, 's', tenantId);
    const visible = await db.get(`SELECT id FROM sessions s WHERE s.id = ? AND ${scope.sql}`, session.id, ...scope.params);
    if (!visible) return res.status(404).json({ error: 'Session not found or could not be ingested', external_key: body.external_key });

    return res.json(session);
  } catch (err) {
    if (err instanceof SessionIngestTenantError) return res.status(404).json({ error: err.message });
    return res.status(500).json({ error: String(err) });
  }
});

// POST /api/v1/sessions/ingest/cron-runs
// Bulk-ingest recent cron runs from ~/.openclaw/cron/runs/.
// Body: { limit?: number }  (default 50 most recent)
router.post('/ingest/cron-runs', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    const HOME = process.env.HOME ?? os.default.homedir();
    const OPENCLAW_DIR = process.env.OPENCLAW_DIR ?? path.default.join(HOME, '.openclaw');
    const CRON_RUNS_DIR = path.default.join(OPENCLAW_DIR, 'cron', 'runs');

    if (!fs.default.existsSync(CRON_RUNS_DIR)) {
      return res.json({ ingested: 0, skipped: 0, errors: [] });
    }

    const files = fs.default.readdirSync(CRON_RUNS_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .reverse();

    const limit = Math.min(Number(req.body?.limit ?? 50), 500);
    const filesToProcess = files.slice(0, limit);

    const results = { ingested: 0, skipped: 0, errors: [] as string[] };

    for (const file of filesToProcess) {
      const jobId = file.replace('.jsonl', '');
      const externalKey = `cron:${jobId}`;
      try {
        const session = await ingestSessionByExternalKey(externalKey, tenantId, {}, 'cron');
        if (session) {
          results.ingested++;
        } else {
          results.skipped++;
        }
      } catch (err) {
        results.errors.push(`${jobId}: ${String(err)}`);
      }
    }

    return res.json(results);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
