import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { isProviderGatePassed, countConnectedProviders } from './providers';
import {
  getAtlasAgentRecord,
  ATLAS_AGENT_NAME,
  ATLAS_SESSION_KEY,
  ATLAS_SYSTEM_ROLE,
} from '../lib/atlasAgent';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';
import {
  checkRuntimeConnection,
  detectRuntimeConnectionConfig,
  readRuntimeConnectionConfig,
  saveRuntimeConnectionConfig,
  type RuntimeKind,
  type RuntimeConnectionConfig,
} from '../lib/runtimeOnboarding';

const router = Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSetting(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

function normalizeRuntimeKind(value: unknown): RuntimeKind | null {
  if (value === 'openclaw' || value === 'hermes' || value === 'custom') return value;
  return null;
}

function runtimeConfigResponse(config: RuntimeConnectionConfig): Record<string, unknown> {
  return {
    kind: config.kind,
    endpoint: config.endpoint,
    label: config.label ?? null,
    auth_token_configured: Boolean(config.authToken),
  };
}

// ─── GET /api/v1/setup/status ────────────────────────────────────────────────
// Returns high-level setup state for the first-run onboarding wizard.
router.get('/status', (_req: Request, res: Response) => {
  try {
    const db = getDb();

    const projectCount = (db.prepare('SELECT COUNT(*) as n FROM projects').get() as { n: number }).n;
    const agentCount = (db.prepare('SELECT COUNT(*) as n FROM agents').get() as { n: number }).n;

    const onboardingCompleted = getSetting('onboarding_completed') === 'true';

    res.json({
      hasProjects: projectCount > 0,
      hasAgents: agentCount > 0,
      has_atlas_agent: !!getAtlasAgentRecord(),
      onboarding_completed: onboardingCompleted,
      onboarding_provider_gate_passed: isProviderGatePassed(),
      connected_provider_count: countConnectedProviders(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── POST /api/v1/setup/onboarding/complete ──────────────────────────────────
// Mark onboarding as complete — enforces the at-least-one-provider gate.
router.post('/onboarding/complete', (_req: Request, res: Response) => {
  try {
    if (!isProviderGatePassed()) {
      res.status(422).json({
        error: 'At least one provider must be configured and connected before onboarding can be completed.',
        onboarding_provider_gate_passed: false,
        connected_provider_count: 0,
      });
      return;
    }

    if (!getAtlasAgentRecord()) {
      res.status(422).json({
        error: 'Atlas must be provisioned before onboarding can be completed.',
        onboarding_provider_gate_passed: true,
        connected_provider_count: countConnectedProviders(),
      });
      return;
    }

    setSetting('onboarding_completed', 'true');

    res.json({
      ok: true,
      onboarding_completed: true,
      onboarding_provider_gate_passed: true,
      connected_provider_count: countConnectedProviders(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── POST /api/v1/setup/onboarding/skip ──────────────────────────────────────
// Manual-setup path: bypass the guided wizard entirely. Creates the Atlas agent
// record if missing (DB only — no workspace or OpenClaw provisioning) and marks
// onboarding complete without requiring a connected provider.
router.post('/onboarding/skip', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);

    let atlasCreated = false;
    if (!getAtlasAgentRecord()) {
      db.prepare(`
        INSERT INTO agents (tenant_id, name, role, session_key, system_role)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        tenantId,
        ATLAS_AGENT_NAME,
        'Built-in assistant for chat, task routing, and coordination.',
        ATLAS_SESSION_KEY,
        ATLAS_SYSTEM_ROLE,
      );
      atlasCreated = true;
    }

    setSetting('onboarding_completed', 'true');

    res.json({
      ok: true,
      onboarding_completed: true,
      atlas_created: atlasCreated,
      onboarding_provider_gate_passed: isProviderGatePassed(),
      connected_provider_count: countConnectedProviders(),
    });
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({ error: String(err) });
  }
});

// ─── Runtime setup ───────────────────────────────────────────────────────────
router.get('/runtime/detect', (_req: Request, res: Response) => {
  try {
    res.json({ ok: true, runtime: runtimeConfigResponse(detectRuntimeConnectionConfig()) });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

router.get('/runtime/status', async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const config = readRuntimeConnectionConfig(db) ?? detectRuntimeConnectionConfig();
    const status = await checkRuntimeConnection(config);
    res.json({ ok: true, configured: Boolean(readRuntimeConnectionConfig(db)), ...status });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

router.post('/runtime/test', async (req: Request, res: Response) => {
  try {
    const kind = normalizeRuntimeKind(req.body?.kind);
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint.trim() : '';
    if (!kind) {
      res.status(400).json({ ok: false, error: 'runtime kind must be openclaw, hermes, or custom' });
      return;
    }
    if (!endpoint) {
      res.status(400).json({ ok: false, error: 'runtime endpoint is required' });
      return;
    }
    const status = await checkRuntimeConnection({
      kind,
      endpoint,
      authToken: typeof req.body?.auth_token === 'string' ? req.body.auth_token : null,
      label: typeof req.body?.label === 'string' ? req.body.label : null,
    });
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

router.post('/runtime/config', async (req: Request, res: Response) => {
  try {
    const kind = normalizeRuntimeKind(req.body?.kind);
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint.trim() : '';
    if (!kind) {
      res.status(400).json({ ok: false, error: 'runtime kind must be openclaw, hermes, or custom' });
      return;
    }
    if (!endpoint) {
      res.status(400).json({ ok: false, error: 'runtime endpoint is required' });
      return;
    }
    const db = getDb();
    const config = saveRuntimeConnectionConfig(db, {
      kind,
      endpoint,
      authToken: typeof req.body?.auth_token === 'string' ? req.body.auth_token : null,
      label: typeof req.body?.label === 'string' ? req.body.label : null,
    });
    const status = await checkRuntimeConnection(config);
    res.status(201).json({ ok: true, configured: true, runtime: runtimeConfigResponse(config), status });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
