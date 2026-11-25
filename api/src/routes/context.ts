/**
 * /api/v1/context — the Context page: inspect what shapes an agent's prompt and tools, and
 * publish a batch of edits to those sources. A run's captured prompt itself comes from
 * GET /api/v1/instances/:id/context.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';
import {
  ContextNotFound,
  agentContextSources,
  listContextRuns,
  runMcpTools,
  taskContextSources,
} from '../domains/context/workspace';
import { ContextPublishError, contextPublishRequest, publishContextChanges } from '../domains/context/publish';

const router = Router();
const positiveId = z.coerce.number().int().positive();
const actor = (req: Request) => req.mcpIdentity?.auditActor ?? 'operator';

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    void fn(req, res).catch((error: unknown) => {
      if (error instanceof z.ZodError) return res.status(400).json({ code: 'invalid_request', error: 'Invalid context request.', issues: error.issues });
      if (error instanceof ContextNotFound) return res.status(404).json({ code: 'not_found', error: error.message });
      if (error instanceof ContextPublishError) {
        return res.status(error.status).json({ code: error.code, error: error.message, ...(error.detail ? { detail: error.detail } : {}) });
      }
      const status = (error as { status?: number }).status;
      if (status && status < 500) return res.status(status).json({ code: (error as { code?: string }).code ?? 'request_failed', error: (error as Error).message });
      console.error('[context] request failed:', error);
      return res.status(500).json({ code: 'context_request_failed', error: 'Context request failed.' });
    });
  };
}

router.get('/runs', handle(async (req, res) => {
  const query = z.object({
    project_id: positiveId.optional(),
    agent_id: positiveId.optional(),
    workflow_id: positiveId.optional(),
    task_type: z.string().min(1).max(200).optional(),
    task_id: positiveId.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  }).strict().parse(req.query);
  const db = getDb();
  const tenantId = await resolveTenantIdFromRequest(db, req);
  res.json({
    runs: await listContextRuns(db, tenantId, {
      projectId: query.project_id,
      agentId: query.agent_id,
      workflowId: query.workflow_id,
      taskType: query.task_type,
      taskId: query.task_id,
      limit: query.limit,
    }),
  });
}));

router.get('/runs/:id/mcp-tools', handle(async (req, res) => {
  const db = getDb();
  const tenantId = await resolveTenantIdFromRequest(db, req);
  res.json({ servers: await runMcpTools(db, tenantId, positiveId.parse(req.params.id)) });
}));

router.get('/agents/:id', handle(async (req, res) => {
  const db = getDb();
  const tenantId = await resolveTenantIdFromRequest(db, req);
  res.json(await agentContextSources(db, tenantId, positiveId.parse(req.params.id)));
}));

router.get('/tasks/:id', handle(async (req, res) => {
  const db = getDb();
  const tenantId = await resolveTenantIdFromRequest(db, req);
  res.json(await taskContextSources(db, tenantId, positiveId.parse(req.params.id)));
}));

router.post('/publish', handle(async (req, res) => {
  const body = contextPublishRequest.parse(req.body);
  const db = getDb();
  const tenantId = await resolveTenantIdFromRequest(db, req);
  res.json(await publishContextChanges(db, tenantId, body.changes, actor(req)));
}));

export default router;
