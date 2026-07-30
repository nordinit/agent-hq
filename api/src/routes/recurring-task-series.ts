import { Router, type Request, type Response } from 'express';
import { getDb } from '../db/client';
import {
  createRecurringTaskSeries,
  deleteRecurringTaskSeries,
  getRecurringTaskSeries,
  listRecurringTaskRuns,
  listRecurringTaskSeries,
  previewRecurringTaskSchedule,
  runRecurringTaskSeriesNow,
  setRecurringTaskSeriesEnabled,
  updateRecurringTaskSeries,
  type CreateRecurringTaskSeriesInput,
  type UpdateRecurringTaskSeriesInput,
} from '../domains/recurring-tasks';
import { resolveRequestActor } from '../domains/tasks/requestActor';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';

const router = Router();

function parseSeriesId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('Invalid recurring task series id') as Error & { status?: number; code?: string };
    err.status = 400;
    err.code = 'invalid_series_id';
    throw err;
  }
  return id;
}

function sendError(res: Response, err: unknown): void {
  const error = err as Error & { status?: number; code?: string };
  const message = error instanceof Error ? error.message : String(err);
  res.status(error.status ?? 500).json({
    error: message,
    ...(error.code ? { code: error.code } : {}),
  });
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    res.json(await listRecurringTaskSeries(db, { ...req.query, tenant_id: tenantId }));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/preview', (req: Request, res: Response) => {
  try {
    const schedule = typeof req.body?.schedule === 'string'
      ? req.body.schedule
      : req.body?.schedule_expression;
    res.json(previewRecurringTaskSchedule(schedule, req.body?.timezone, Number(req.body?.count) || 5));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const actor = resolveRequestActor(req, req.body?.created_by ?? req.body?.changed_by ?? 'system').changedBy;
    const series = await createRecurringTaskSeries(db, {
          ...(req.body as CreateRecurringTaskSeriesInput),
          tenant_id: tenantId,
          created_by: actor,
          updated_by: actor,
        });
    res.status(201).json(await getRecurringTaskSeries(db, series.id, tenantId));
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const id = parseSeriesId(req.params.id);
    const series = await getRecurringTaskSeries(db, id, tenantId);
    if (!series) return res.status(404).json({ error: 'Recurring task series not found', code: 'series_not_found' });
    res.json({
      ...series,
      runs: await listRecurringTaskRuns(db, id, req.query.limit, tenantId),
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/:id/history', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const id = parseSeriesId(req.params.id);
    if (!await getRecurringTaskSeries(db, id, tenantId)) {
      return res.status(404).json({ error: 'Recurring task series not found', code: 'series_not_found' });
    }
    res.json({ series_id: id, runs: await listRecurringTaskRuns(db, id, req.query.limit, tenantId) });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:id/preview', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const id = parseSeriesId(req.params.id);
    const series = await getRecurringTaskSeries(db, id, tenantId) as Record<string, unknown> | null;
    if (!series) return res.status(404).json({ error: 'Recurring task series not found', code: 'series_not_found' });
    res.json(previewRecurringTaskSchedule(
      String(series.schedule_expression ?? series.schedule),
      String(series.timezone),
      Number(req.body?.count) || 5,
    ));
  } catch (err) {
    sendError(res, err);
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const id = parseSeriesId(req.params.id);
    const actor = resolveRequestActor(req, req.body?.updated_by ?? req.body?.changed_by ?? 'system').changedBy;
    const series = await updateRecurringTaskSeries(db, id, {
          ...(req.body as UpdateRecurringTaskSeriesInput),
          tenant_id: tenantId,
          updated_by: actor,
        }, tenantId);
    res.json(await getRecurringTaskSeries(db, series.id, tenantId));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:id/enable', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const id = parseSeriesId(req.params.id);
    const actor = resolveRequestActor(req, req.body?.updated_by ?? req.body?.changed_by ?? 'system').changedBy;
    const series = await setRecurringTaskSeriesEnabled(db, id, true, actor, tenantId);
    res.json(await getRecurringTaskSeries(db, series.id, tenantId));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:id/disable', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const id = parseSeriesId(req.params.id);
    const actor = resolveRequestActor(req, req.body?.updated_by ?? req.body?.changed_by ?? 'system').changedBy;
    const series = await setRecurringTaskSeriesEnabled(db, id, false, actor, tenantId);
    res.json(await getRecurringTaskSeries(db, series.id, tenantId));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:id/run-now', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const id = parseSeriesId(req.params.id);
    const actor = resolveRequestActor(req, req.body?.changed_by ?? 'recurring-task-series-api').changedBy;
    res.status(201).json(await runRecurringTaskSeriesNow(db, id, actor, tenantId));
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    res.json(await deleteRecurringTaskSeries(db, parseSeriesId(req.params.id), tenantId));
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
