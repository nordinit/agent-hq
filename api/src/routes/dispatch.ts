/**
 * dispatch.ts — HTTP endpoints for the deterministic routing engine
 *
 * POST /api/v1/dispatch/trigger       — run eligibility + dispatch for one project
 * POST /api/v1/dispatch/reconcile     — run eligibility + dispatch for ALL active projects
 * GET  /api/v1/dispatch/log           — paginated dispatch audit log
 * GET  /api/v1/dispatch/status        — current routing system status
 *
 * Mount in index.ts: app.use('/api/v1/dispatch', dispatchRouter)
 */

import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { runEligibilityPass, EligibilityResult } from '../services/eligibility';
import { runDispatcher, DispatchResult } from '../services/dispatcher';
import { notifyTelegram } from '../integrations/telegram';
import { runReconcilerTick } from '../scheduler/reconciler';

const router = Router();

// ── POST /trigger ─────────────────────────────────────────────────────────────
// Run eligibility pass + dispatcher for a specific project.
// Body: { project_id: number }
// Response: { promoted, blocked, stalled, dispatched, skipped }

router.post('/trigger', async (req: Request, res: Response) => {
  try {
    const { project_id } = req.body as { project_id?: number };
    if (project_id == null || typeof project_id !== 'number') {
      return res.status(400).json({ error: 'project_id (number) is required' });
    }

    const db = getDb();

    const eligResult: EligibilityResult = await runEligibilityPass(db, project_id);
    const dispResult: DispatchResult    = await runDispatcher(db, project_id);

    res.json({
      project_id,
      promoted:   eligResult.promoted,
      blocked:    eligResult.blocked,
      stalled:    eligResult.stalled,
      unclaimed:  eligResult.unclaimed,
      dispatched: dispResult.dispatched,
      skipped:    dispResult.skipped,
      errors:     dispResult.errors,
    });
  } catch (err) {
    console.error('[dispatch/trigger] Error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /reconcile ───────────────────────────────────────────────────────────
// Run full sweep across ALL active projects.
// Response: { projects_checked, promoted, stalled, dispatched, errors }

router.post('/reconcile', async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const reconcileAt = new Date().toISOString();
    const summary = await runReconcilerTick(undefined, db);

    if (summary.dispatched > 0 || summary.errors.length > 0) {
      await notifyTelegram(`📋 Reconcile complete: ${summary.dispatched} dispatched, ${summary.stalled} stalled, ${summary.errors.length} errors`);
    }

    res.json({
      projects_checked: summary.projectsChecked,
      project_ids: summary.projectIds,
      reconcile_at: reconcileAt,
      promoted: summary.promoted,
      blocked: summary.blocked,
      stalled: summary.stalled,
      unclaimed: summary.unclaimed,
      dispatched: summary.dispatched,
      skipped: summary.skipped,
      errors: summary.errors,
    });
  } catch (err) {
    console.error('[dispatch/reconcile] Error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /log ──────────────────────────────────────────────────────────────────
// Paginated dispatch audit log.
// Query params: job_id, task_id, from, to, limit (default 50), offset

router.get('/log', async (req: Request, res: Response) => {
  try {
    const db = getDb();

    const jobId  = req.query.job_id  ? Number(req.query.job_id)  : null;
    const taskId = req.query.task_id ? Number(req.query.task_id) : null;
    const from   = req.query.from   as string | undefined;
    const to     = req.query.to     as string | undefined;
    const limit  = Math.min(Number(req.query.limit  ?? 50), 500);
    const offset = Number(req.query.offset ?? 0);

    // Read job_title from agents table directly (dispatch_log.agent_id -> agents.id)
    let sql = `
      SELECT
        dl.id,
        dl.task_id,
        dl.agent_id,
        dl.dispatched_at,
        dl.routing_reason,
        dl.candidate_count,
        dl.candidates_skipped,
        t.title   AS task_title,
        a.job_title AS job_title,
        a.name    AS agent_name
      FROM dispatch_log dl
      LEFT JOIN tasks  t ON t.id  = dl.task_id
      LEFT JOIN agents a ON a.id  = dl.agent_id
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (jobId  != null) { sql += ` AND dl.agent_id = ?`;                   params.push(jobId);  }
    if (taskId != null) { sql += ` AND dl.task_id = ?`;                    params.push(taskId); }
    if (from)           { sql += ` AND dl.dispatched_at >= ?`;              params.push(from);   }
    if (to)             { sql += ` AND dl.dispatched_at <= ?`;              params.push(to);     }

    sql += ` ORDER BY dl.dispatched_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const log = (await db.all(sql, ...params) as any[]).map(row => ({
      ...row,
      candidates_skipped: (() => {
        try { return JSON.parse(row.candidates_skipped || '[]'); } catch { return []; }
      })(),
    }));

    // Count total for pagination
    let countSql = `SELECT COUNT(*) as n FROM dispatch_log dl WHERE 1=1`;
    const countParams: unknown[] = [];
    if (jobId  != null) { countSql += ` AND dl.agent_id = ?`; countParams.push(jobId);  }
    if (taskId != null) { countSql += ` AND dl.task_id = ?`;  countParams.push(taskId); }
    if (from)           { countSql += ` AND dl.dispatched_at >= ?`; countParams.push(from); }
    if (to)             { countSql += ` AND dl.dispatched_at <= ?`; countParams.push(to);   }

    const { n: total } = await db.get(countSql, ...countParams) as { n: number };

    res.json({ log, total, limit, offset });
  } catch (err) {
    console.error('[dispatch/log] Error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /status ───────────────────────────────────────────────────────────────
// Current routing system status:
//   - last reconcile timestamp
//   - total dispatched today
//   - total stalled today
//   - starved_jobs (agents that have explicitly routed ready tasks but no active dispatch)

router.get('/status', async (_req: Request, res: Response) => {
  try {
    const db = getDb();

    // Last dispatch event in the log acts as proxy for last reconcile
    const lastLog = await db.get(`SELECT dispatched_at FROM dispatch_log ORDER BY dispatched_at DESC LIMIT 1`) as { dispatched_at: string } | undefined;

    const lastReconcileAt = lastLog?.dispatched_at ?? null;

    // Dispatched today
    const dispatchedToday = (await db.get(`
      SELECT COUNT(*) as n
      FROM dispatch_log
      WHERE dispatched_at >= datetime('now', 'start of day')
    `) as { n: number }).n;

    // Stalled today (tasks that transitioned to stalled today)
    const stalledToday = (await db.get(`
      SELECT COUNT(*) as n
      FROM tasks
      WHERE status = 'stalled'
        AND updated_at >= datetime('now', 'start of day')
    `) as { n: number }).n;

    // Starved jobs: enabled agents that currently own an explicit sprint routing rule
    // for ready tasks but have no active dispatch. Legacy task.agent_id ownership is
    // intentionally ignored here so the status view reflects the explicit routing model.
    const starvedJobs = await db.all(`
      SELECT a.id, a.job_title as title, a.name as agent_name,
             COUNT(DISTINCT t.id) as ready_task_count
      FROM agents a
      INNER JOIN sprint_task_routing_rules rr
        ON rr.agent_id = a.id
       AND rr.status = 'ready'
      INNER JOIN tasks t
        ON t.sprint_id = rr.sprint_id
       AND t.status = 'ready'
       AND (
         rr.task_type IS NULL
         OR rr.task_type = t.task_type
       )
      WHERE a.enabled = 1
        AND NOT EXISTS (
          SELECT 1 FROM job_instances ji
          WHERE ji.agent_id = a.id
            AND ji.status IN ('queued', 'dispatched', 'running')
        )
      GROUP BY a.id
      ORDER BY ready_task_count DESC
    `) as { id: number; title: string; agent_name: string; ready_task_count: number }[];

    res.json({
      last_reconcile_at: lastReconcileAt,
      dispatched_today:  dispatchedToday,
      stalled_today:     stalledToday,
      starved_jobs:      starvedJobs,
    });
  } catch (err) {
    console.error('[dispatch/status] Error:', err);
    res.status(500).json({ error: String(err) });
  }
});

export default router;
