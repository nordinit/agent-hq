/**
 * routes/browser.ts — REST API for the browser context pool.
 *
 * Endpoints:
 *   GET    /api/v1/browser/pool       — pool stats (browsers, contexts, agents)
 *   POST   /api/v1/browser/contexts   — create a context for an agent+instance
 *   DELETE /api/v1/browser/contexts    — destroy a context for an agent+instance
 *   GET    /api/v1/browser/contexts    — list all active contexts
 *   DELETE /api/v1/browser/pool        — shutdown entire pool (admin)
 */

import { Router } from 'express';
import {
  createAgentContext,
  destroyAgentContext,
  getAgentContext,
  getPoolStats,
  shutdownPool,
} from '../services/browserPool';

const router = Router();

// ── GET /pool — pool stats ───────────────────────────────────────────────────

router.get('/pool', (_req, res) => {
  const stats = getPoolStats();
  res.json(stats);
});

// ── POST /contexts — create a context ────────────────────────────────────────

router.post('/contexts', async (req, res) => {
  const { agentSlug, instanceId, blockResources, userAgent, viewport } = req.body;

  if (!agentSlug || typeof agentSlug !== 'string') {
    return res.status(400).json({ error: 'agentSlug is required (string)' });
  }
  if (!instanceId || typeof instanceId !== 'number') {
    return res.status(400).json({ error: 'instanceId is required (number)' });
  }

  try {
    const ctx = await createAgentContext(agentSlug, instanceId, {
      blockResources,
      userAgent,
      viewport,
    });

    res.status(201).json({
      ok: true,
      agentSlug: ctx.agentSlug,
      instanceId: ctx.instanceId,
      browserId: ctx.browserId,
      createdAt: ctx.createdAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('already exists') ? 409 : 500;
    res.status(status).json({ error: message });
  }
});

// ── DELETE /contexts — destroy a context ─────────────────────────────────────

router.delete('/contexts', async (req, res) => {
  const { agentSlug, instanceId } = req.body;

  if (!agentSlug || typeof agentSlug !== 'string') {
    return res.status(400).json({ error: 'agentSlug is required (string)' });
  }
  if (!instanceId || typeof instanceId !== 'number') {
    return res.status(400).json({ error: 'instanceId is required (number)' });
  }

  const destroyed = await destroyAgentContext(agentSlug, instanceId);
  res.json({ ok: true, destroyed });
});

// ── GET /contexts — list all active contexts ─────────────────────────────────

router.get('/contexts', (_req, res) => {
  const stats = getPoolStats();
  // Return a list of all active contexts with metadata
  // We pull this from the pool stats' activeAgents + internal map
  // For a more detailed view, we iterate the internal map via getPoolStats
  res.json({
    totalContexts: stats.totalContexts,
    activeAgents: stats.activeAgents,
    browsers: stats.browsers,
  });
});

// ── DELETE /pool — shutdown entire pool ──────────────────────────────────────

router.delete('/pool', async (_req, res) => {
  await shutdownPool();
  res.json({ ok: true, message: 'Pool shutdown complete' });
});

export default router;
