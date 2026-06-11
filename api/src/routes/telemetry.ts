import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { generateRecommendations, FAILURE_TAXONOMY } from '../services/recommendations';
import { emitIntegrityEvent } from '../domains/tasks/history';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';
import { tenantInsertColumns } from '../lib/runtimeTenantScope';
import { tableHasColumn } from '../lib/durableRunIdentity';

const router = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildDateFilter(
  alias: string,
  from: string | undefined,
  to: string | undefined,
  conditions: string[],
  params: unknown[]
): void {
  if (from) { conditions.push(`${alias}.created_at >= ?`); params.push(from); }
  if (to)   { conditions.push(`${alias}.created_at <= ?`); params.push(to);   }
}

function requireTaskTenant(db: ReturnType<typeof getDb>, taskId: number, tenantId: number): { id: number; tenant_id: number; project_id: number | null; sprint_id: number | null; agent_id: number | null } | null {
  return db.prepare(`
    SELECT id, tenant_id, project_id, sprint_id, agent_id
    FROM tasks
    WHERE id = ? AND tenant_id = ?
    LIMIT 1
  `).get(taskId, tenantId) as { id: number; tenant_id: number; project_id: number | null; sprint_id: number | null; agent_id: number | null } | undefined ?? null;
}

function addTelemetryTenantFilter(tableAlias: string, conditions: string[], params: unknown[], tenantId: number): void {
  conditions.push(`${tableAlias}.task_id IN (SELECT id FROM tasks WHERE tenant_id = ?)`);
  params.push(tenantId);
}

// ── GET /api/v1/telemetry/overview ───────────────────────────────────────────
// Overview metrics: counts, pass rates, avg cycle time, top failure reasons.
// Query params: project_id, sprint_id, job_id, from, to
router.get('/overview', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const { project_id, sprint_id, job_id, from, to } = req.query as Record<string, string | undefined>;

    // Build WHERE clauses for creation events & outcome metrics
    const ceConditions: string[] = [];
    const ceParams: unknown[] = [];
    const omConditions: string[] = [];
    const omParams: unknown[] = [];
    addTelemetryTenantFilter('tce', ceConditions, ceParams, tenantId);
    addTelemetryTenantFilter('tom', omConditions, omParams, tenantId);

    if (project_id) {
      ceConditions.push('tce.project_id = ?'); ceParams.push(Number(project_id));
      omConditions.push('tom.project_id = ?'); omParams.push(Number(project_id));
    }
    if (sprint_id) {
      ceConditions.push('tce.sprint_id = ?'); ceParams.push(Number(sprint_id));
      omConditions.push('tom.sprint_id = ?'); omParams.push(Number(sprint_id));
    }
    if (job_id) {
      ceConditions.push('tce.job_id = ?'); ceParams.push(Number(job_id));
      omConditions.push('tom.job_id = ?'); omParams.push(Number(job_id));
    }
    buildDateFilter('tce', from, to, ceConditions, ceParams);
    buildDateFilter('tom', from, to, omConditions, omParams);

    const ceWhere = ceConditions.length ? `WHERE ${ceConditions.join(' AND ')}` : '';
    const omWhere = omConditions.length ? `WHERE ${omConditions.join(' AND ')}` : '';

    // Total tasks with creation events
    const totalCreated = (db.prepare(
      `SELECT COUNT(*) as n FROM task_creation_events tce ${ceWhere}`
    ).get(...ceParams) as { n: number }).n;

    // Source breakdown
    const bySource = db.prepare(
      `SELECT source, COUNT(*) as count FROM task_creation_events tce ${ceWhere} GROUP BY source ORDER BY count DESC`
    ).all(...ceParams) as { source: string; count: number }[];

    // Confidence breakdown
    const byConfidence = db.prepare(
      `SELECT confidence, COUNT(*) as count FROM task_creation_events tce ${ceWhere} GROUP BY confidence ORDER BY count DESC`
    ).all(...ceParams) as { confidence: string; count: number }[];

    // Scope size breakdown
    const byScopeSize = db.prepare(
      `SELECT scope_size, COUNT(*) as count FROM task_creation_events tce ${ceWhere} GROUP BY scope_size ORDER BY count DESC`
    ).all(...ceParams) as { scope_size: string; count: number }[];

    // Outcome metrics summary
    const totalWithOutcome = (db.prepare(
      `SELECT COUNT(*) as n FROM task_outcome_metrics tom ${omWhere}`
    ).get(...omParams) as { n: number }).n;

    const firstPassRate = (db.prepare(
      `SELECT ROUND(AVG(first_pass_qa) * 100.0, 1) as pct FROM task_outcome_metrics tom ${omWhere}`
    ).get(...omParams) as { pct: number | null }).pct ?? 0;

    const avgCycleTime = (db.prepare(
      `SELECT ROUND(AVG(cycle_time_hours), 2) as avg_h FROM task_outcome_metrics tom ${omWhere} AND cycle_time_hours IS NOT NULL`
        .replace('WHERE', omConditions.length ? 'WHERE' : 'WHERE')
        .replace(/ AND cycle_time_hours/, omConditions.length ? ' AND cycle_time_hours' : ' WHERE cycle_time_hours')
    ).get(...omParams) as { avg_h: number | null }).avg_h ?? null;

    // Simpler version for cycle time
    const cycleParams = [...omParams];
    const cycleConditions = [...omConditions, 'tom.cycle_time_hours IS NOT NULL'];
    const cycleWhere = `WHERE ${cycleConditions.join(' AND ')}`;
    const avgCycleTimeH = (db.prepare(
      `SELECT ROUND(AVG(tom.cycle_time_hours), 2) as avg_h FROM task_outcome_metrics tom ${cycleWhere}`
    ).get(...cycleParams) as { avg_h: number | null }).avg_h ?? null;

    // Quality breakdown
    const byQuality = db.prepare(
      `SELECT outcome_quality, COUNT(*) as count FROM task_outcome_metrics tom ${omWhere} GROUP BY outcome_quality ORDER BY count DESC`
    ).all(...omParams) as { outcome_quality: string; count: number }[];

    // Top failure reasons (parse JSON arrays)
    const rawFailureRows = db.prepare(
      `SELECT failure_reasons FROM task_outcome_metrics tom ${omWhere} AND failure_reasons != '[]' AND failure_reasons != ''`
        .replace(/ AND failure_reasons/, omConditions.length ? ' AND failure_reasons' : ' WHERE failure_reasons')
    ).all(...omParams) as { failure_reasons: string }[];

    const failureCounts: Record<string, number> = {};
    for (const row of rawFailureRows) {
      try {
        const reasons: string[] = JSON.parse(row.failure_reasons);
        for (const r of reasons) {
          failureCounts[r] = (failureCounts[r] ?? 0) + 1;
        }
      } catch { /* skip malformed */ }
    }
    const topFailureReasons = Object.entries(failureCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count }));

    // Tasks needing split
    const needsSplit = (db.prepare(
      `SELECT COUNT(*) as n FROM task_creation_events tce ${ceWhere ? ceWhere + ' AND' : 'WHERE'} tce.needs_split = 1`
    ).get(...ceParams) as { n: number }).n;

    // Avg reopened/rerouted counts
    const avgReopened = (db.prepare(
      `SELECT ROUND(AVG(reopened_count), 2) as avg_r FROM task_outcome_metrics tom ${omWhere}`
    ).get(...omParams) as { avg_r: number | null }).avg_r ?? 0;

    res.json({
      total_created: totalCreated,
      total_with_outcome: totalWithOutcome,
      first_pass_rate_pct: firstPassRate,
      avg_cycle_time_hours: avgCycleTimeH,
      avg_reopened_count: avgReopened,
      needs_split_count: needsSplit,
      by_source: bySource,
      by_confidence: byConfidence,
      by_scope_size: byScopeSize,
      by_quality: byQuality,
      top_failure_reasons: topFailureReasons,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/telemetry/review ─────────────────────────────────────────────
// Task review rows with creation + outcome data joined.
// Query params: project_id, sprint_id, job_id, source, confidence, priority,
//               date_from, date_to, outcome_quality, limit, offset
router.get('/review', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const {
      project_id, sprint_id, job_id, source, confidence, priority,
      date_from, date_to, outcome_quality,
      limit: rawLimit = '50', offset: rawOffset = '0',
    } = req.query as Record<string, string | undefined>;

    const limit = Math.min(Number(rawLimit) || 50, 200);
    const offset = Number(rawOffset) || 0;

    const conditions: string[] = [];
    const params: unknown[] = [];
    conditions.push('t.tenant_id = ?');
    params.push(tenantId);

    if (project_id) { conditions.push('t.project_id = ?'); params.push(Number(project_id)); }
    if (sprint_id)  { conditions.push('t.sprint_id = ?');  params.push(Number(sprint_id));  }
    if (job_id)     { conditions.push('t.agent_id = ?');    params.push(Number(job_id));     }
    if (priority)   { conditions.push('t.priority = ?');   params.push(priority);           }

    if (source)         { conditions.push('tce.source = ?');          params.push(source);         }
    if (confidence)     { conditions.push('tce.confidence = ?');      params.push(confidence);     }
    if (outcome_quality){ conditions.push('tom.outcome_quality = ?'); params.push(outcome_quality);}

    if (date_from) { conditions.push('t.created_at >= ?'); params.push(date_from); }
    if (date_to)   { conditions.push('t.created_at <= ?'); params.push(date_to);   }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = db.prepare(`
      SELECT
        t.id, t.title, t.status, t.priority, t.created_at, t.updated_at,
        p.name as project_name,
        s.name as sprint_name,
        a.job_title as job_title,
        a.name as agent_name,
        -- creation event fields
        tce.source, tce.confidence, tce.scope_size, tce.needs_split,
        tce.expected_artifact, tce.success_mode, tce.open_questions, tce.assumptions,
        tce.created_at as creation_event_at,
        -- outcome fields
        tom.first_pass_qa, tom.reopened_count, tom.rerouted_count,
        tom.split_after_creation, tom.blocked_after_creation,
        tom.clarification_count, tom.cycle_time_hours, tom.outcome_quality,
        tom.failure_reasons, tom.outcome_summary, tom.recorded_at as outcome_recorded_at
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      LEFT JOIN sprints s ON s.id = t.sprint_id
      LEFT JOIN agents a ON a.id = t.agent_id
      LEFT JOIN task_creation_events tce ON tce.task_id = t.id
      LEFT JOIN task_outcome_metrics tom ON tom.task_id = t.id
      ${where}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Record<string, unknown>[];

    // Parse JSON fields
    const enriched = rows.map(r => ({
      ...r,
      failure_reasons: (() => {
        try { return JSON.parse(r.failure_reasons as string || '[]'); } catch { return []; }
      })(),
      assumptions: (() => {
        try { return JSON.parse(r.assumptions as string || '""'); } catch { return r.assumptions; }
      })(),
      open_questions: (() => {
        try { return JSON.parse(r.open_questions as string || '""'); } catch { return r.open_questions; }
      })(),
    }));

    const total = (db.prepare(
      `SELECT COUNT(*) as n FROM tasks t
       LEFT JOIN task_creation_events tce ON tce.task_id = t.id
       LEFT JOIN task_outcome_metrics tom ON tom.task_id = t.id
       ${where}`
    ).get(...params) as { n: number }).n;

    res.json({ tasks: enriched, total, limit, offset });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/telemetry/review/:task_id ───────────────────────────────────
// Full telemetry drilldown for a single task.
router.get('/review/:task_id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const taskId = Number(req.params.task_id);
    const tenantId = resolveTenantIdFromRequest(db, req);

    const task = db.prepare(`
      SELECT t.*,
        p.name as project_name,
        s.name as sprint_name,
        a.job_title as job_title,
        a.name as agent_name
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      LEFT JOIN sprints s ON s.id = t.sprint_id
      LEFT JOIN agents a ON a.id = t.agent_id
      WHERE t.id = ? AND t.tenant_id = ?
    `).get(taskId, tenantId) as Record<string, unknown> | undefined;

    if (!task) return res.status(404).json({ error: 'Task not found' });

    const creationEvent = db.prepare(
      `SELECT * FROM task_creation_events WHERE task_id = ?`
    ).get(taskId) as Record<string, unknown> | null;

    const outcomeMetrics = db.prepare(
      `SELECT * FROM task_outcome_metrics WHERE task_id = ?`
    ).get(taskId) as Record<string, unknown> | null;

    const history = db.prepare(
      `SELECT * FROM task_history WHERE task_id = ? ORDER BY created_at ASC`
    ).all(taskId) as Record<string, unknown>[];

    const notes = db.prepare(
      `SELECT * FROM task_notes WHERE task_id = ? ORDER BY created_at ASC`
    ).all(taskId) as Record<string, unknown>[];

    // Blockers + blocking
    const blockers = db.prepare(`
      SELECT t.id, t.title, t.status FROM tasks t
      WHERE t.id IN (SELECT blocker_id FROM task_dependencies WHERE blocked_id = ?)
    `).all(taskId) as Record<string, unknown>[];

    const blocking = db.prepare(`
      SELECT t.id, t.title, t.status FROM tasks t
      WHERE t.id IN (SELECT blocked_id FROM task_dependencies WHERE blocker_id = ?)
    `).all(taskId) as Record<string, unknown>[];

    // Parse JSON in creation event and outcome metrics
    let parsedCreation = creationEvent;
    if (parsedCreation) {
      parsedCreation = {
        ...parsedCreation,
        assumptions: (() => { try { return JSON.parse(parsedCreation!.assumptions as string || '""'); } catch { return parsedCreation!.assumptions; } })(),
        open_questions: (() => { try { return JSON.parse(parsedCreation!.open_questions as string || '""'); } catch { return parsedCreation!.open_questions; } })(),
      };
    }
    let parsedOutcome = outcomeMetrics;
    if (parsedOutcome) {
      parsedOutcome = {
        ...parsedOutcome,
        failure_reasons: (() => { try { return JSON.parse(parsedOutcome!.failure_reasons as string || '[]'); } catch { return []; } })(),
      };
    }

    res.json({
      task: { ...task, blockers, blocking },
      creation_event: parsedCreation,
      outcome_metrics: parsedOutcome,
      history,
      notes,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/telemetry/schema-config ─────────────────────────────────────
// Returns the metadata schema config (which fields to show in task creation UI).
router.get('/schema-config', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const row = db.prepare(
      `SELECT * FROM telemetry_schema_config WHERE id = 1`
    ).get() as Record<string, unknown> | undefined;

    if (!row) {
      // Return defaults
      return res.json(getDefaultSchemaConfig());
    }

    res.json({
      ...row,
      fields: (() => { try { return JSON.parse(row.fields as string); } catch { return getDefaultSchemaConfig().fields; } })(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── PUT /api/v1/telemetry/schema-config ─────────────────────────────────────
// Update the metadata schema config.
// Body: { fields: Array<{ key, label, type, required, enabled, options? }> }
router.put('/schema-config', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { fields, description } = req.body;

    if (!fields || !Array.isArray(fields)) {
      return res.status(400).json({ error: 'fields must be an array' });
    }

    const fieldsJson = JSON.stringify(fields);
    const now = new Date().toISOString();

    const existing = db.prepare(`SELECT id FROM telemetry_schema_config WHERE id = 1`).get();
    if (existing) {
      db.prepare(`
        UPDATE telemetry_schema_config SET fields = ?, description = ?, updated_at = ? WHERE id = 1
      `).run(fieldsJson, description ?? '', now);
    } else {
      db.prepare(`
        INSERT INTO telemetry_schema_config (id, fields, description, updated_at) VALUES (1, ?, ?, ?)
      `).run(fieldsJson, description ?? '', now);
    }

    const updated = db.prepare(`SELECT * FROM telemetry_schema_config WHERE id = 1`).get() as Record<string, unknown>;
    res.json({
      ...updated,
      fields: (() => { try { return JSON.parse(updated.fields as string); } catch { return []; } })(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/telemetry/creation-events ───────────────────────────────────
// Create a new creation event for a task.
// Body: { task_id, project_id?, sprint_id?, job_id?, source, routing?, confidence?,
//         scope_size?, assumptions?, open_questions?, needs_split?, expected_artifact?,
//         success_mode?, raw_input? }
router.post('/creation-events', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const {
      task_id, project_id, sprint_id, job_id,
      source = 'manual', routing = '', confidence = '', scope_size = '',
      assumptions = '', open_questions = '', needs_split = 0,
      expected_artifact = '', success_mode = '', raw_input = '',
    } = req.body;

    if (!task_id) return res.status(400).json({ error: 'task_id required' });
    const task = requireTaskTenant(db, Number(task_id), tenantId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const assumptionsStr = typeof assumptions === 'string' ? assumptions : JSON.stringify(assumptions);
    const openQStr = typeof open_questions === 'string' ? open_questions : JSON.stringify(open_questions);
    const tenant = tenantInsertColumns(db, 'task_creation_events', task.tenant_id);

    const result = db.prepare(`
      INSERT INTO task_creation_events
        (${tenant.columnSql}task_id, project_id, sprint_id, job_id, source, routing, confidence, scope_size,
         assumptions, open_questions, needs_split, expected_artifact, success_mode, raw_input)
      VALUES (${tenant.valueSql}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ...tenant.values,
      task_id, project_id ?? task.project_id ?? null, sprint_id ?? task.sprint_id ?? null, job_id ?? task.agent_id ?? null,
      source, routing, confidence, scope_size,
      assumptionsStr, openQStr, needs_split ? 1 : 0,
      expected_artifact, success_mode, raw_input
    );

    const created = db.prepare(`SELECT * FROM task_creation_events WHERE id = ?`).get(result.lastInsertRowid) as Record<string, unknown>;
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── PUT /api/v1/telemetry/creation-events/:task_id ───────────────────────────
// Upsert/update creation event for a task.
router.put('/creation-events/:task_id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const taskId = Number(req.params.task_id);
    const task = requireTaskTenant(db, taskId, tenantId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const existing = db.prepare(`SELECT id FROM task_creation_events WHERE task_id = ?`).get(taskId) as { id: number } | undefined;

    const {
      project_id, sprint_id, job_id,
      source, routing, confidence, scope_size,
      assumptions, open_questions, needs_split,
      expected_artifact, success_mode, raw_input,
    } = req.body;

    if (!existing) {
      // Create via the POST handler logic inline
      if (!taskId) return res.status(400).json({ error: 'task_id required' });
      const assumptionsStr = typeof assumptions === 'string' ? assumptions : JSON.stringify(assumptions ?? '');
      const openQStr = typeof open_questions === 'string' ? open_questions : JSON.stringify(open_questions ?? '');
      const tenant = tenantInsertColumns(db, 'task_creation_events', task.tenant_id);
      const result = db.prepare(`
        INSERT INTO task_creation_events
          (${tenant.columnSql}task_id, project_id, sprint_id, job_id, source, routing, confidence, scope_size,
           assumptions, open_questions, needs_split, expected_artifact, success_mode, raw_input)
        VALUES (${tenant.valueSql}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ...tenant.values,
        taskId, project_id ?? task.project_id ?? null, sprint_id ?? task.sprint_id ?? null, job_id ?? task.agent_id ?? null,
        source ?? 'manual', routing ?? '', confidence ?? '', scope_size ?? '',
        assumptionsStr, openQStr, needs_split ? 1 : 0,
        expected_artifact ?? '', success_mode ?? '', raw_input ?? ''
      );
      const created = db.prepare(`SELECT * FROM task_creation_events WHERE id = ?`).get(result.lastInsertRowid) as Record<string, unknown>;
      return res.json(created);
    }

    // Patch existing
    const updates: string[] = [];
    const vals: unknown[] = [];

    const fields: Record<string, unknown> = {
      project_id, sprint_id, job_id, source, routing, confidence, scope_size,
      expected_artifact, success_mode, raw_input,
    };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) { updates.push(`${k} = ?`); vals.push(v); }
    }
    if (assumptions !== undefined) {
      updates.push('assumptions = ?');
      vals.push(typeof assumptions === 'string' ? assumptions : JSON.stringify(assumptions));
    }
    if (open_questions !== undefined) {
      updates.push('open_questions = ?');
      vals.push(typeof open_questions === 'string' ? open_questions : JSON.stringify(open_questions));
    }
    if (needs_split !== undefined) {
      updates.push('needs_split = ?');
      vals.push(needs_split ? 1 : 0);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    if (tableHasColumn(db, 'task_creation_events', 'tenant_id')) {
      updates.push('tenant_id = ?');
      vals.push(task.tenant_id);
    }

    db.prepare(`UPDATE task_creation_events SET ${updates.join(', ')} WHERE task_id = ?`).run(...vals, taskId);
    const updated = db.prepare(`SELECT * FROM task_creation_events WHERE task_id = ?`).get(taskId) as Record<string, unknown>;
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/telemetry/outcome-metrics ───────────────────────────────────
// Create outcome metric record for a task.
// Body: { task_id, project_id?, sprint_id?, job_id?, first_pass_qa?, reopened_count?,
//         rerouted_count?, split_after_creation?, blocked_after_creation?,
//         clarification_count?, notes_count?, cycle_time_hours?, outcome_quality?,
//         failure_reasons?, outcome_summary? }
router.post('/outcome-metrics', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const {
      task_id, project_id, sprint_id, job_id,
      first_pass_qa = 0, reopened_count = 0, rerouted_count = 0,
      split_after_creation = 0, blocked_after_creation = 0,
      clarification_count = 0, notes_count = 0,
      cycle_time_hours = null, outcome_quality = '',
      failure_reasons = [], outcome_summary = '',
    } = req.body;

    if (!task_id) return res.status(400).json({ error: 'task_id required' });
    const task = requireTaskTenant(db, Number(task_id), tenantId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const failureReasonsStr = typeof failure_reasons === 'string'
      ? failure_reasons
      : JSON.stringify(failure_reasons);
    const tenant = tenantInsertColumns(db, 'task_outcome_metrics', task.tenant_id);

    const result = db.prepare(`
      INSERT INTO task_outcome_metrics
        (${tenant.columnSql}task_id, project_id, sprint_id, job_id, first_pass_qa, reopened_count,
         rerouted_count, split_after_creation, blocked_after_creation,
         clarification_count, notes_count, cycle_time_hours, outcome_quality,
         failure_reasons, outcome_summary)
      VALUES (${tenant.valueSql}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ...tenant.values,
      task_id, project_id ?? task.project_id ?? null, sprint_id ?? task.sprint_id ?? null, job_id ?? task.agent_id ?? null,
      first_pass_qa ? 1 : 0, reopened_count, rerouted_count,
      split_after_creation ? 1 : 0, blocked_after_creation ? 1 : 0,
      clarification_count, notes_count, cycle_time_hours, outcome_quality,
      failureReasonsStr, outcome_summary
    );

    const created = db.prepare(`SELECT * FROM task_outcome_metrics WHERE id = ?`).get(result.lastInsertRowid) as Record<string, unknown>;
    res.status(201).json({
      ...created,
      failure_reasons: (() => { try { return JSON.parse(created.failure_reasons as string); } catch { return []; } })(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── PUT /api/v1/telemetry/outcome-metrics/:task_id ───────────────────────────
// Upsert/update outcome metric for a task.
router.put('/outcome-metrics/:task_id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const taskId = Number(req.params.task_id);
    const task = requireTaskTenant(db, taskId, tenantId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const existing = db.prepare(`SELECT id FROM task_outcome_metrics WHERE task_id = ?`).get(taskId) as { id: number } | undefined;

    if (!existing) {
      // Create it
      const {
        project_id, sprint_id, job_id,
        first_pass_qa = 0, reopened_count = 0, rerouted_count = 0,
        split_after_creation = 0, blocked_after_creation = 0,
        clarification_count = 0, notes_count = 0,
        cycle_time_hours = null, outcome_quality = '',
        failure_reasons = [], outcome_summary = '',
      } = req.body;

      const failureReasonsStr = typeof failure_reasons === 'string' ? failure_reasons : JSON.stringify(failure_reasons);
      const tenant = tenantInsertColumns(db, 'task_outcome_metrics', task.tenant_id);

      const result = db.prepare(`
        INSERT INTO task_outcome_metrics
          (${tenant.columnSql}task_id, project_id, sprint_id, job_id, first_pass_qa, reopened_count,
           rerouted_count, split_after_creation, blocked_after_creation,
           clarification_count, notes_count, cycle_time_hours, outcome_quality,
           failure_reasons, outcome_summary)
        VALUES (${tenant.valueSql}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ...tenant.values,
        taskId, project_id ?? task.project_id ?? null, sprint_id ?? task.sprint_id ?? null, job_id ?? task.agent_id ?? null,
        first_pass_qa ? 1 : 0, reopened_count, rerouted_count,
        split_after_creation ? 1 : 0, blocked_after_creation ? 1 : 0,
        clarification_count, notes_count, cycle_time_hours, outcome_quality,
        failureReasonsStr, outcome_summary
      );
      const created = db.prepare(`SELECT * FROM task_outcome_metrics WHERE id = ?`).get(result.lastInsertRowid) as Record<string, unknown>;
      return res.json({
        ...created,
        failure_reasons: (() => { try { return JSON.parse(created.failure_reasons as string); } catch { return []; } })(),
      });
    }

    // Patch existing
    const updates: string[] = [];
    const vals: unknown[] = [];
    const now = new Date().toISOString();

    const numFields = ['reopened_count','rerouted_count','clarification_count','notes_count'];
    const boolFields = ['first_pass_qa','split_after_creation','blocked_after_creation'];
    const strFields = ['project_id','sprint_id','job_id','cycle_time_hours','outcome_quality','outcome_summary'];

    for (const f of numFields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); vals.push(Number(req.body[f])); }
    }
    for (const f of boolFields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); vals.push(req.body[f] ? 1 : 0); }
    }
    for (const f of strFields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); vals.push(req.body[f]); }
    }
    if (req.body.failure_reasons !== undefined) {
      updates.push('failure_reasons = ?');
      const fr = req.body.failure_reasons;
      vals.push(typeof fr === 'string' ? fr : JSON.stringify(fr));
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    if (tableHasColumn(db, 'task_outcome_metrics', 'tenant_id')) {
      updates.push('tenant_id = ?');
      vals.push(task.tenant_id);
    }

    updates.push('updated_at = ?');
    vals.push(now);

    db.prepare(`UPDATE task_outcome_metrics SET ${updates.join(', ')} WHERE task_id = ?`).run(...vals, taskId);
    const updated = db.prepare(`SELECT * FROM task_outcome_metrics WHERE task_id = ?`).get(taskId) as Record<string, unknown>;
    res.json({
      ...updated,
      failure_reasons: (() => { try { return JSON.parse(updated.failure_reasons as string); } catch { return []; } })(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Default schema config ────────────────────────────────────────────────────

function getDefaultSchemaConfig() {
  return {
    id: 1,
    description: 'Default telemetry metadata fields for task creation',
    updated_at: null,
    fields: [
      { key: 'source', label: 'Source', type: 'select', required: false, enabled: true,
        options: ['manual', 'skill', 'agent', 'api', 'import'] },
      { key: 'routing', label: 'Routing', type: 'text', required: false, enabled: true },
      { key: 'confidence', label: 'Confidence', type: 'select', required: false, enabled: true,
        options: ['', 'low', 'medium', 'high'] },
      { key: 'scope_size', label: 'Scope Size', type: 'select', required: false, enabled: true,
        options: ['', 'xs', 'small', 'medium', 'large', 'xl'] },
      { key: 'assumptions', label: 'Assumptions', type: 'textarea', required: false, enabled: true },
      { key: 'open_questions', label: 'Open Questions', type: 'textarea', required: false, enabled: true },
      { key: 'needs_split', label: 'Needs Split', type: 'boolean', required: false, enabled: true },
      { key: 'expected_artifact', label: 'Expected Artifact', type: 'text', required: false, enabled: true },
      { key: 'success_mode', label: 'Success Mode', type: 'text', required: false, enabled: true },
      { key: 'raw_input', label: 'Raw Input', type: 'textarea', required: false, enabled: false },
    ],
  };
}

// ── GET /api/v1/telemetry/recommendations ────────────────────────────────────
// Generate recommendations based on telemetry patterns.
// Query params: project_id, sprint_id, job_id, from, to
router.get('/recommendations', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { project_id, sprint_id, job_id, from, to } = req.query as Record<string, string | undefined>;

    const filters: Record<string, unknown> = {};
    if (project_id) filters.project_id = Number(project_id);
    if (sprint_id)  filters.sprint_id  = Number(sprint_id);
    if (job_id)     filters.job_id     = Number(job_id);
    if (from)       filters.from       = from;
    if (to)         filters.to         = to;

    const result = generateRecommendations(db, filters);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/telemetry/failure-taxonomy ────────────────────────────────────
// Returns the standard failure reason taxonomy with descriptions and actions.
router.get('/failure-taxonomy', (_req: Request, res: Response) => {
  res.json({ taxonomy: FAILURE_TAXONOMY });
});

// ── GET /api/v1/telemetry/sessions ─────────────────────────────────────────
// Aggregate session statistics for telemetry: total sessions, avg message count,
// avg token usage, runtime breakdown, status breakdown, and per-agent summaries.
// Query params: project_id, agent_id, runtime, status, from, to, limit (default 100)
router.get('/sessions', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { project_id, agent_id, runtime, status, from, to } = req.query as Record<string, string | undefined>;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (project_id) { conditions.push('s.project_id = ?'); params.push(Number(project_id)); }
    if (agent_id)   { conditions.push('s.agent_id = ?');   params.push(Number(agent_id));   }
    if (runtime)    { conditions.push('s.runtime = ?');     params.push(runtime);             }
    if (status)     { conditions.push('s.status = ?');      params.push(status);              }
    if (from)       { conditions.push('COALESCE(s.started_at, s.created_at) >= ?'); params.push(from); }
    if (to)         { conditions.push('COALESCE(s.started_at, s.created_at) <= ?'); params.push(to);   }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Aggregate totals
    const totals = db.prepare(`
      SELECT
        COUNT(*) AS total_sessions,
        SUM(message_count) AS total_messages,
        ROUND(AVG(message_count), 1) AS avg_messages_per_session,
        SUM(token_input)  AS total_token_input,
        SUM(token_output) AS total_token_output,
        ROUND(AVG(token_input),  0) AS avg_token_input,
        ROUND(AVG(token_output), 0) AS avg_token_output,
        COUNT(DISTINCT s.agent_id) AS unique_agents,
        COUNT(DISTINCT s.task_id)  AS unique_tasks
      FROM sessions s
      ${where}
    `).get(...params) as Record<string, unknown>;

    // Runtime breakdown
    const byRuntime = db.prepare(`
      SELECT s.runtime, COUNT(*) AS count
      FROM sessions s
      ${where}
      GROUP BY s.runtime
      ORDER BY count DESC
    `).all(...params) as Array<{ runtime: string; count: number }>;

    // Status breakdown
    const byStatus = db.prepare(`
      SELECT s.status, COUNT(*) AS count
      FROM sessions s
      ${where}
      GROUP BY s.status
      ORDER BY count DESC
    `).all(...params) as Array<{ status: string; count: number }>;

    // Per-agent summary (top contributors)
    const byAgent = db.prepare(`
      SELECT
        s.agent_id,
        a.name AS agent_name,
        COUNT(*) AS session_count,
        SUM(s.message_count) AS total_messages,
        SUM(s.token_input)   AS total_token_input,
        SUM(s.token_output)  AS total_token_output,
        ROUND(AVG(s.message_count), 1) AS avg_messages
      FROM sessions s
      LEFT JOIN agents a ON a.id = s.agent_id
      ${where}
      GROUP BY s.agent_id
      ORDER BY session_count DESC
      LIMIT 20
    `).all(...params) as Array<Record<string, unknown>>;

    return res.json({
      totals,
      by_runtime: byRuntime,
      by_status: byStatus,
      by_agent: byAgent,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Task #586: Pipeline Intelligence Endpoints ───────────────────────────────

const INTEGRITY_ANOMALY_TYPES = [
  { type: 'missing_review_evidence',  label: 'Missing Review Evidence',  description: 'Task reached review with no branch or commit recorded.' },
  { type: 'missing_qa_evidence',      label: 'Missing QA Evidence',      description: 'Task reached qa_pass with no qa_verified_commit.' },
  { type: 'commit_mismatch',          label: 'Commit Mismatch',          description: 'Review commit differs from QA verified commit.' },
  { type: 'deployed_not_verified',    label: 'Deployed Not Verified',    description: 'Task reached done without live_verified_at being set.' },
  { type: 'stale_outcome_write',      label: 'Stale Outcome Write',      description: 'Outcome submitted by a non-authoritative instance.' },
  { type: 'branch_missing_on_origin', label: 'Branch Missing on Origin', description: 'Review branch recorded but not found on remote.' },
  { type: 'evidence_placeholder',     label: 'Evidence Placeholder',     description: 'Evidence fields contain placeholder/dummy values.' },
  { type: 'missing_lifecycle_handoff', label: 'Missing Lifecycle Handoff', description: 'Runtime ended without the required semantic lifecycle outcome.' },
];

// GET /api/v1/telemetry/pipeline-health
router.get('/pipeline-health', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { project_id, from, to } = req.query as Record<string, string | undefined>;
    const startDate = from ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const endDate = to ?? new Date().toISOString();

    const conds: string[] = ['1=1'];
    const params: unknown[] = [];
    if (project_id) { conds.push('t.project_id = ?'); params.push(Number(project_id)); }
    const w = `WHERE ${conds.join(' AND ')}`;

    const completedInPeriod = (db.prepare(`SELECT COUNT(*) as n FROM tasks t ${w} AND t.status = 'done' AND t.updated_at >= ? AND t.updated_at <= ?`).get(...params, startDate, endDate) as { n: number }).n;
    const boardDist = db.prepare(`SELECT t.status, COUNT(*) as count FROM tasks t ${w} AND t.status NOT IN ('done','cancelled') GROUP BY t.status ORDER BY count DESC`).all(...params) as Array<{ status: string; count: number }>;
    const totalDispatched = (db.prepare(`SELECT COUNT(*) as n FROM tasks t ${w} AND t.dispatched_at >= ? AND t.dispatched_at <= ?`).get(...params, startDate, endDate) as { n: number }).n;
    const failedInPeriod = (db.prepare(`SELECT COUNT(*) as n FROM tasks t ${w} AND t.status = 'failed' AND t.updated_at >= ? AND t.updated_at <= ?`).get(...params, startDate, endDate) as { n: number }).n;
    const failureRate = totalDispatched > 0 ? Math.round((failedInPeriod / totalDispatched) * 1000) / 10 : 0;
    const staleCount = (db.prepare(`SELECT COUNT(*) as n FROM tasks t ${w} AND t.status IN ('in_progress','review','qa_pass','ready_to_merge') AND t.updated_at < datetime('now', '-2 hours')`).get(...params) as { n: number }).n;

    let manualInterventions = 0;
    try {
      const mc = project_id ? `WHERE te.project_id = ? AND te.move_type IN ('manual','rescue') AND te.created_at >= ? AND te.created_at <= ?` : `WHERE te.move_type IN ('manual','rescue') AND te.created_at >= ? AND te.created_at <= ?`;
      const mp = project_id ? [Number(project_id), startDate, endDate] : [startDate, endDate];
      manualInterventions = (db.prepare(`SELECT COUNT(*) as n FROM task_events te ${mc}`).get(...mp) as { n: number }).n;
    } catch { /* table may not exist */ }

    let integrityCount = 0;
    try {
      const ic = project_id ? `WHERE project_id = ? AND resolved = 0` : `WHERE resolved = 0`;
      const ip = project_id ? [Number(project_id)] : [];
      integrityCount = (db.prepare(`SELECT COUNT(*) as n FROM integrity_events ${ic}`).get(...ip) as { n: number }).n;
    } catch { /* table may not exist */ }

    res.json({ period: { from: startDate, to: endDate }, completed_in_period: completedInPeriod, board_distribution: boardDist, total_dispatched_in_period: totalDispatched, failure_rate_pct: failureRate, stale_task_count: staleCount, manual_interventions_in_period: manualInterventions, integrity_anomaly_count_open: integrityCount });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// GET /api/v1/telemetry/bottlenecks
router.get('/bottlenecks', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { project_id, sprint_id, task_type, story_points } = req.query as Record<string, string | undefined>;
    const conds: string[] = ['1=1'];
    const params: unknown[] = [];
    if (project_id)   { conds.push('t.project_id = ?');  params.push(Number(project_id)); }
    if (sprint_id)    { conds.push('t.sprint_id = ?');   params.push(Number(sprint_id)); }
    if (task_type)    { conds.push('t.task_type = ?');   params.push(task_type); }
    if (story_points) { conds.push('t.story_points = ?');params.push(Number(story_points)); }
    const w = `WHERE ${conds.join(' AND ')}`;

    // Time-in-status from task_events
    let timeInStatus: Array<{ status: string; median_minutes: number | null; p95_minutes: number | null; count: number }> = [];
    try {
      const ACTIVE = ['todo','ready','in_progress','review','qa_pass','ready_to_merge','deployed'];
      const durations = db.prepare(`
        SELECT te.from_status AS status, ROUND((julianday(te.created_at) - julianday(prev.created_at)) * 24 * 60, 1) AS dur
        FROM task_events te
        JOIN task_events prev ON prev.task_id = te.task_id AND prev.to_status = te.from_status
          AND prev.id = (SELECT MAX(p2.id) FROM task_events p2 WHERE p2.task_id = te.task_id AND p2.to_status = te.from_status AND p2.id < te.id)
        WHERE te.from_status IN (${ACTIVE.map(() => '?').join(',')}) AND dur > 0 AND dur < 10080
        ORDER BY te.from_status, dur
      `).all(...ACTIVE) as Array<{ status: string; dur: number }>;
      const byStatus: Record<string, number[]> = {};
      for (const r of durations) { if (!byStatus[r.status]) byStatus[r.status] = []; byStatus[r.status].push(r.dur); }
      timeInStatus = ACTIVE.map(s => {
        const vals = (byStatus[s] ?? []).sort((a, b) => a - b);
        if (!vals.length) return { status: s, median_minutes: null, p95_minutes: null, count: 0 };
        return { status: s, median_minutes: vals[Math.floor(vals.length / 2)], p95_minutes: vals[Math.floor(vals.length * 0.95)], count: vals.length };
      });
    } catch { /* task_events may not exist */ }

    const agingBuckets = db.prepare(`
      SELECT t.status,
        CASE WHEN (julianday('now') - julianday(t.updated_at)) * 24 < 1 THEN '<1h'
             WHEN (julianday('now') - julianday(t.updated_at)) * 24 < 4 THEN '1-4h'
             WHEN (julianday('now') - julianday(t.updated_at)) * 24 < 12 THEN '4-12h'
             WHEN (julianday('now') - julianday(t.updated_at)) * 24 < 48 THEN '12-48h'
             ELSE '48h+' END AS bucket, COUNT(*) as count
      FROM tasks t ${w} AND t.status NOT IN ('done','cancelled','failed')
      GROUP BY t.status, bucket ORDER BY t.status, count DESC
    `).all(...params) as Array<{ status: string; bucket: string; count: number }>;

    const topStuck = db.prepare(`
      SELECT t.id, t.title, t.status, t.priority, ROUND((julianday('now') - julianday(t.updated_at)) * 24, 1) AS hours_stuck, a.name AS agent_name
      FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id
      ${w} AND t.status IN ('in_progress','review','qa_pass','ready_to_merge','stalled','blocked')
      ORDER BY hours_stuck DESC LIMIT 10
    `).all(...params) as Array<Record<string, unknown>>;

    let reviewBounces: Array<Record<string, unknown>> = [];
    try {
      reviewBounces = db.prepare(`
        SELECT te.task_id, t.title, COUNT(*) as review_count FROM task_events te JOIN tasks t ON t.id = te.task_id
        WHERE te.to_status = 'review' GROUP BY te.task_id HAVING review_count >= 2 ORDER BY review_count DESC LIMIT 20
      `).all() as Array<Record<string, unknown>>;
    } catch { /* task_events may not exist */ }

    res.json({ time_in_status: timeInStatus, aging_buckets: agingBuckets, top_stuck: topStuck, review_bounces: reviewBounces });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// GET /api/v1/telemetry/failures
router.get('/failures', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { project_id, sprint_id, agent_id, job_id, outcome, from, to } = req.query as Record<string, string | undefined>;
    const startDate = from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const endDate = to ?? new Date().toISOString();
    const c: string[] = ['t.dispatched_at >= ?', 't.dispatched_at <= ?']; const p: unknown[] = [startDate, endDate];
    if (project_id)  { c.push('t.project_id = ?');  p.push(Number(project_id)); }
    if (sprint_id)   { c.push('t.sprint_id = ?');   p.push(Number(sprint_id)); }
    if (agent_id)    { c.push('t.agent_id = ?');    p.push(Number(agent_id)); }
    if (job_id)      { c.push('t.agent_id = ?');     p.push(Number(job_id)); }
    if (outcome) {
      c.push(`EXISTS (
        SELECT 1
        FROM job_instances ji_filter
        WHERE ji_filter.task_id = t.id
          AND ji_filter.task_outcome = ?
      )`);
      p.push(outcome);
    }
    const w = `WHERE ${c.join(' AND ')}`;

    const totalDispatched = (db.prepare(`SELECT COUNT(*) as n FROM tasks t ${w}`).get(...p) as { n: number }).n;
    const totalFailed = (db.prepare(`SELECT COUNT(*) as n FROM tasks t ${w} AND t.status = 'failed'`).get(...p) as { n: number }).n;
    const failureRate = totalDispatched > 0 ? Math.round((totalFailed / totalDispatched) * 1000) / 10 : 0;

    const latestOutcomeSql = `
      SELECT ji2.task_outcome
      FROM job_instances ji2
      WHERE ji2.task_id = t.id
        AND ji2.task_outcome IS NOT NULL
        AND ji2.task_outcome != ''
      ORDER BY COALESCE(ji2.lifecycle_outcome_posted_at, ji2.completed_at, ji2.runtime_completed_at, ji2.runtime_ended_at, ji2.created_at) DESC,
               ji2.id DESC
      LIMIT 1
    `;
    const byOutcome = db.prepare(`
      WITH failed_tasks AS (
        SELECT t.id, (${latestOutcomeSql}) AS outcome
        FROM tasks t ${w} AND t.status = 'failed'
      )
      SELECT COALESCE(outcome, 'unknown') as outcome, COUNT(*) as count
      FROM failed_tasks
      GROUP BY COALESCE(outcome, 'unknown')
      ORDER BY count DESC
    `).all(...p);
    const byAgent = db.prepare(`SELECT t.agent_id, a.name as agent_name, COUNT(*) as total, SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END) as failed, ROUND(SUM(CASE WHEN t.status='failed' THEN 1.0 ELSE 0 END)/COUNT(*)*100,1) as fail_pct FROM tasks t LEFT JOIN agents a ON a.id=t.agent_id ${w} AND t.agent_id IS NOT NULL GROUP BY t.agent_id ORDER BY fail_pct DESC LIMIT 20`).all(...p);
    const byTaskType = db.prepare(`SELECT COALESCE(t.task_type,'unknown') as task_type, COUNT(*) as total, SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END) as failed, ROUND(SUM(CASE WHEN t.status='failed' THEN 1.0 ELSE 0 END)/COUNT(*)*100,1) as fail_pct FROM tasks t ${w} GROUP BY t.task_type ORDER BY fail_pct DESC`).all(...p);
    const topFailing = db.prepare(`
      SELECT
        t.id,
        t.title,
        t.status,
        t.priority,
        COALESCE((${latestOutcomeSql}), 'unknown') as outcome,
        t.failure_detail,
        t.retry_count,
        t.updated_at
      FROM tasks t ${w} AND t.status='failed'
      ORDER BY t.retry_count DESC,t.updated_at DESC
      LIMIT 20
    `).all(...p);

    let byStage: Array<Record<string, unknown>> = [];
    try {
      const sc: string[] = ["ji.status = 'failed'", 'ji.failure_stage IS NOT NULL']; const sp: unknown[] = [];
      if (project_id) { sc.push('t.project_id = ?'); sp.push(Number(project_id)); }
      if (from) { sc.push('ji.created_at >= ?'); sp.push(from); }
      if (to)   { sc.push('ji.created_at <= ?'); sp.push(to); }
      byStage = db.prepare(`SELECT ji.failure_stage, COUNT(*) as count FROM job_instances ji JOIN tasks t ON t.id=ji.task_id WHERE ${sc.join(' AND ')} GROUP BY ji.failure_stage ORDER BY count DESC`).all(...sp) as Array<Record<string, unknown>>;
    } catch { /* failure_stage may not exist */ }

    res.json({ period: { from: startDate, to: endDate }, total_dispatched: totalDispatched, total_failed: totalFailed, failure_rate_pct: failureRate, by_outcome: byOutcome, by_agent: byAgent, by_task_type: byTaskType, by_stage: byStage, top_failing_tasks: topFailing });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// GET /api/v1/telemetry/integrity
router.get('/integrity', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { project_id, agent_id, anomaly_type, from, to, resolved } = req.query as Record<string, string | undefined>;
    try { db.prepare(`SELECT id FROM integrity_events LIMIT 1`).get(); } catch {
      return res.json({ note: 'integrity_events not yet populated', anomaly_counts_by_type: INTEGRITY_ANOMALY_TYPES.map(t => ({ ...t, count: 0 })), anomaly_rate_trend: [], affected_tasks: [], total_anomalies: 0 });
    }
    const c: string[] = ['1=1']; const p: unknown[] = [];
    if (project_id)   { c.push('ie.project_id = ?'); p.push(Number(project_id)); }
    if (agent_id)     { c.push('ie.agent_id = ?');   p.push(Number(agent_id)); }
    if (anomaly_type) { c.push('ie.anomaly_type = ?');p.push(anomaly_type); }
    if (from)         { c.push('ie.created_at >= ?'); p.push(from); }
    if (to)           { c.push('ie.created_at <= ?'); p.push(to); }
    if (resolved !== undefined) { c.push('ie.resolved = ?'); p.push(resolved === 'true' || resolved === '1' ? 1 : 0); }
    const w = `WHERE ${c.join(' AND ')}`;

    const total = (db.prepare(`SELECT COUNT(*) as n FROM integrity_events ie ${w}`).get(...p) as { n: number }).n;
    const countsByType = db.prepare(`SELECT ie.anomaly_type, COUNT(*) as count FROM integrity_events ie ${w} GROUP BY ie.anomaly_type ORDER BY count DESC`).all(...p) as Array<{ anomaly_type: string; count: number }>;
    const anomalyCounts = INTEGRITY_ANOMALY_TYPES.map(entry => ({ ...entry, count: countsByType.find(r => r.anomaly_type === entry.type)?.count ?? 0 }));

    let trend: Array<{ date: string; count: number }> = [];
    try { trend = db.prepare(`SELECT substr(ie.created_at,1,10) as date, COUNT(*) as count FROM integrity_events ie WHERE ${[...c, "ie.created_at >= datetime('now','-30 days')"].join(' AND ')} GROUP BY date ORDER BY date ASC`).all(...p) as Array<{ date: string; count: number }>; } catch { /* non-fatal */ }

    const byAgent2 = db.prepare(`SELECT ie.agent_id, a.name as agent_name, COUNT(*) as count FROM integrity_events ie LEFT JOIN agents a ON a.id=ie.agent_id ${w} AND ie.agent_id IS NOT NULL GROUP BY ie.agent_id ORDER BY count DESC LIMIT 20`).all(...p);
    const affected = db.prepare(`SELECT t.id,t.title,t.status,t.priority,COUNT(ie.id) as anomaly_count,GROUP_CONCAT(DISTINCT ie.anomaly_type) as anomaly_types FROM integrity_events ie JOIN tasks t ON t.id=ie.task_id ${w} GROUP BY ie.task_id ORDER BY anomaly_count DESC LIMIT 20`).all(...p);

    res.json({ total_anomalies: total, anomaly_counts_by_type: anomalyCounts, anomaly_rate_trend: trend, by_agent: byAgent2, affected_tasks: affected });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// POST /api/v1/telemetry/integrity-events
router.post('/integrity-events', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { task_id, anomaly_type, detail, instance_id, project_id, agent_id } = req.body;
    const VALID = INTEGRITY_ANOMALY_TYPES.map(t => t.type);
    if (!task_id) return res.status(400).json({ error: 'task_id required' });
    if (!anomaly_type || !VALID.includes(anomaly_type)) return res.status(400).json({ error: `anomaly_type must be one of: ${VALID.join(', ')}` });
    emitIntegrityEvent(db, { taskId: task_id, anomalyType: anomaly_type, detail: detail ?? null, instanceId: instance_id ?? null, projectId: project_id ?? null, agentId: agent_id ?? null });
    res.status(201).json({ ok: true, task_id, anomaly_type });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// PUT /api/v1/telemetry/integrity-events/:id/resolve
router.put('/integrity-events/:id/resolve', (req: Request, res: Response) => {
  try {
    const db = getDb();
    db.prepare(`UPDATE integrity_events SET resolved = 1, resolved_at = datetime('now') WHERE id = ?`).run(Number(req.params.id));
    const row = db.prepare(`SELECT * FROM integrity_events WHERE id = ?`).get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Integrity event not found' });
    res.json(row);
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// GET /api/v1/telemetry/routing
router.get('/routing', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { project_id, sprint_id, task_type, from, to } = req.query as Record<string, string | undefined>;
    const startDate = from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const endDate = to ?? new Date().toISOString();
    const c: string[] = ['t.dispatched_at >= ?', 't.dispatched_at <= ?']; const p: unknown[] = [startDate, endDate];
    if (project_id) { c.push('t.project_id = ?'); p.push(Number(project_id)); }
    if (sprint_id)  { c.push('t.sprint_id = ?');  p.push(Number(sprint_id)); }
    if (task_type)  { c.push('t.task_type = ?');  p.push(task_type); }
    const w = `WHERE ${c.join(' AND ')} AND t.routing_reason IS NOT NULL`;

    const routingGroups = db.prepare(`SELECT t.routing_reason, COUNT(*) as dispatched, SUM(CASE WHEN t.status='done' THEN 1 ELSE 0 END) as success, SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END) as failed, SUM(CASE WHEN t.status IN ('stalled','blocked') THEN 1 ELSE 0 END) as stalled, ROUND(SUM(CASE WHEN t.status='done' THEN 1.0 ELSE 0 END)/COUNT(*)*100,1) as success_pct, ROUND(SUM(CASE WHEN t.status='failed' THEN 1.0 ELSE 0 END)/COUNT(*)*100,1) as fail_pct FROM tasks t ${w} GROUP BY t.routing_reason ORDER BY dispatched DESC LIMIT 50`).all(...p);
    const byAgent3 = db.prepare(`SELECT t.agent_id, a.name as agent_name, COUNT(*) as dispatched, SUM(CASE WHEN t.status='done' THEN 1 ELSE 0 END) as done, SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END) as failed, ROUND(SUM(CASE WHEN t.status='done' THEN 1.0 ELSE 0 END)/COUNT(*)*100,1) as success_pct FROM tasks t LEFT JOIN agents a ON a.id=t.agent_id WHERE ${c.join(' AND ')} GROUP BY t.agent_id ORDER BY dispatched DESC LIMIT 20`).all(...p);

    const sprintRuleFilters: string[] = [];
    const sprintRuleParams: unknown[] = [];
    if (sprint_id) {
      sprintRuleFilters.push('trr.sprint_id = ?');
      sprintRuleParams.push(Number(sprint_id));
    } else if (project_id) {
      sprintRuleFilters.push('s.project_id = ?');
      sprintRuleParams.push(Number(project_id));
    }

    const sprintRules = db.prepare(`
      SELECT
        trr.id,
        s.project_id,
        p.name AS project_name,
        trr.sprint_id,
        s.name AS sprint_name,
        trr.task_type,
        trr.status AS route_from_status,
        trr.agent_id,
        a.name AS agent_name,
        trr.priority,
        'sprint' AS scope_type
      FROM sprint_task_routing_rules trr
      LEFT JOIN sprints s ON s.id = trr.sprint_id
      LEFT JOIN projects p ON p.id = s.project_id
      LEFT JOIN agents a ON a.id = trr.agent_id
      ${sprintRuleFilters.length > 0 ? `WHERE ${sprintRuleFilters.join(' AND ')}` : ''}
      ORDER BY COALESCE(s.project_id, -1), trr.sprint_id, trr.task_type, trr.priority DESC
    `).all(...sprintRuleParams);

    const rules = sprintRules;

    res.json({ period: { from: startDate, to: endDate }, routing_reason_summary: routingGroups, by_agent: byAgent3, routing_rules: rules });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// GET /api/v1/telemetry/templates
router.get('/templates', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { project_id, agent_id, from, to } = req.query as Record<string, string | undefined>;
    const startDate = from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const endDate = to ?? new Date().toISOString();
    const c: string[] = ['ji.dispatched_at >= ?', 'ji.dispatched_at <= ?']; const p: unknown[] = [startDate, endDate];
    if (project_id) { c.push('t.project_id = ?'); p.push(Number(project_id)); }
    if (agent_id)   { c.push('ji.agent_id = ?');  p.push(Number(agent_id)); }
    const w = `WHERE ${c.join(' AND ')}`;

    const byTemplate = db.prepare(`
      SELECT ji.agent_id, a.name as agent_name, a.job_title, a.job_instructions_updated_at, a.instructions_version,
        COUNT(*) as total_runs, SUM(CASE WHEN ji.status='done' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN ji.status='failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN ji.status='cancelled' THEN 1 ELSE 0 END) as cancelled,
        ROUND(SUM(CASE WHEN ji.status='done' THEN 1.0 ELSE 0 END)/COUNT(*)*100,1) as success_pct,
        ROUND(SUM(CASE WHEN ji.status='failed' THEN 1.0 ELSE 0 END)/COUNT(*)*100,1) as fail_pct,
        ROUND(AVG(CASE WHEN ji.completed_at IS NOT NULL AND ji.started_at IS NOT NULL THEN (julianday(ji.completed_at)-julianday(ji.started_at))*24*60 END),1) as avg_cycle_min,
        SUM(COALESCE(ji.token_input,0)+COALESCE(ji.token_output,0)) as total_tokens,
        ROUND(AVG(COALESCE(ji.token_input,0)+COALESCE(ji.token_output,0)),0) as avg_tokens,
        SUM(CASE WHEN ji.last_meaningful_output_at IS NOT NULL THEN 1 ELSE 0 END) as meaningful_output_count,
        ROUND(SUM(CASE WHEN ji.last_meaningful_output_at IS NOT NULL THEN 1.0 ELSE 0 END)/COUNT(*)*100,1) as meaningful_output_rate_pct
      FROM job_instances ji JOIN tasks t ON t.id=ji.task_id LEFT JOIN agents a ON a.id=ji.agent_id
      ${w} GROUP BY ji.agent_id ORDER BY total_runs DESC LIMIT 30
    `).all(...p);

    res.json({ period: { from: startDate, to: endDate }, by_template: byTemplate });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// GET /api/v1/telemetry/events — raw task_events with filters
router.get('/events', (req: Request, res: Response) => {
  try {
    const db = getDb();
    try { db.prepare(`SELECT id FROM task_events LIMIT 1`).get(); } catch {
      return res.json({ events: [], total: 0, note: 'task_events table not yet populated' });
    }
    const { task_id, project_id, agent_id, move_type, from_status, to_status, from, to, limit: rl = '100', offset: ro = '0' } = req.query as Record<string, string | undefined>;
    const limit = Math.min(Number(rl) || 100, 500); const offset = Number(ro) || 0;
    const c: string[] = ['1=1']; const p: unknown[] = [];
    if (task_id)     { c.push('te.task_id = ?');     p.push(Number(task_id)); }
    if (project_id)  { c.push('te.project_id = ?');  p.push(Number(project_id)); }
    if (agent_id)    { c.push('te.agent_id = ?');    p.push(Number(agent_id)); }
    if (move_type)   { c.push('te.move_type = ?');   p.push(move_type); }
    if (from_status) { c.push('te.from_status = ?'); p.push(from_status); }
    if (to_status)   { c.push('te.to_status = ?');   p.push(to_status); }
    if (from)        { c.push('te.created_at >= ?'); p.push(from); }
    if (to)          { c.push('te.created_at <= ?'); p.push(to); }
    const w = `WHERE ${c.join(' AND ')}`;
    const events = db.prepare(`SELECT te.*, t.title as task_title, a.name as agent_name FROM task_events te LEFT JOIN tasks t ON t.id=te.task_id LEFT JOIN agents a ON a.id=te.agent_id ${w} ORDER BY te.created_at DESC LIMIT ? OFFSET ?`).all(...p, limit, offset);
    const total = (db.prepare(`SELECT COUNT(*) as n FROM task_events te ${w}`).get(...p) as { n: number }).n;
    res.json({ events, total, limit, offset });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// GET /api/v1/telemetry/integrity-taxonomy
router.get('/integrity-taxonomy', (_req: Request, res: Response) => {
  res.json({ taxonomy: INTEGRITY_ANOMALY_TYPES });
});

export default router;
