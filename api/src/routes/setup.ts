import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { isProviderGatePassed, countConnectedProviders } from './providers';
import { getAtlasAgentRecord } from '../lib/atlasAgent';

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

export default router;
