import { Router, type Request, type Response } from 'express';
import { getDb } from '../db/client';
import { parseRuntimeConfigObject } from '../domains/agents/runtimeConfig';
import { diagnoseRuntimeDriver } from '../domains/runtimes/driverDiagnostics';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';

const router = Router();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalPositiveInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

// POST /api/v1/runtime-drivers/diagnose
// Performs only local prerequisite, version, and fixed auth-status checks; it
// never launches a model, submits a prompt, or mutates runtime configuration.
router.post('/diagnose', async (req: Request, res: Response) => {
  try {
    if (!isRecord(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object.' });
    }

    const agentId = optionalPositiveInteger(req.body.agent_id);
    if (req.body.agent_id !== undefined && agentId === null) {
      return res.status(400).json({ error: 'agent_id must be a positive integer.' });
    }

    let runtimeType = typeof req.body.runtime_type === 'string'
      ? req.body.runtime_type.trim()
      : '';
    let runtimeConfig = req.body.runtime_config === undefined
      ? null
      : parseRuntimeConfigObject(req.body.runtime_config);
    let workspacePath = typeof req.body.workspace_path === 'string'
      ? req.body.workspace_path.trim()
      : null;
    let agentSlug: string | null = null;
    let providerConnectionId: number | null = null;
    let trustedTenantId: number | null = null;

    if (req.body.runtime_config !== undefined && req.body.runtime_config !== null && !runtimeConfig) {
      return res.status(400).json({ error: 'runtime_config must be an object or null.' });
    }
    if (req.body.workspace_path !== undefined && req.body.workspace_path !== null && typeof req.body.workspace_path !== 'string') {
      return res.status(400).json({ error: 'workspace_path must be a string or null.' });
    }

    if (agentId !== null) {
      const db = getDb();
      const tenantId = await resolveTenantIdFromRequest(db, req);
      trustedTenantId = tenantId;
      const agent = await db.get<{
        id: number;
        runtime_type: string | null;
        runtime_config: unknown;
        workspace_path: string | null;
        slug: string | null;
        provider_connection_id: number | null;
      }>(`
        SELECT id, runtime_type, runtime_config, workspace_path, slug, provider_connection_id
        FROM agents
        WHERE id = ? AND tenant_id = ?
      `, agentId, tenantId);
      if (!agent) return res.status(404).json({ error: 'Agent not found.' });

      const storedRuntimeType = agent.runtime_type?.trim() || 'openclaw';
      if (runtimeType && runtimeType !== storedRuntimeType) {
        return res.status(400).json({
          error: `runtime_type '${runtimeType}' does not match agent runtime '${storedRuntimeType}'.`,
        });
      }
      runtimeType = storedRuntimeType;
      runtimeConfig = req.body.runtime_config === undefined
        ? parseRuntimeConfigObject(agent.runtime_config) ?? {}
        : runtimeConfig;
      workspacePath = req.body.workspace_path === undefined
        ? agent.workspace_path
        : workspacePath;
      agentSlug = agent.slug;
      providerConnectionId = agent.provider_connection_id;
    }

    if (!runtimeType) {
      return res.status(400).json({ error: 'runtime_type is required when agent_id is not provided.' });
    }

    const result = await diagnoseRuntimeDriver({
      runtimeType,
      runtimeConfig: runtimeConfig ?? {},
      workspacePath,
      agentId,
      tenantId: trustedTenantId,
      agentSlug,
      providerConnectionId,
    });
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith('Unsupported runtime_type') ? 400 : 500;
    return res.status(status).json({ error: message });
  }
});

export default router;
