/**
 * routes/github-identities.ts — CRUD for per-agent GitHub identity/credential records.
 *
 * Task #613: Implement per-agent GitHub identities so Agent HQ agents
 * (dev, QA, Harbor) can act under distinct GitHub accounts for PR open,
 * approve, and merge operations.
 *
 * Each identity stores:
 *   - GitHub username (for audit trail / branch protection identity)
 *   - Personal Access Token (PAT) — fine-grained or classic
 *   - Git author name + email (for commit attribution)
 *   - Workflow role label (dev / qa / release / shared) for human reference
 *   - Optional notes
 *
 * The PAT is stored as-is in the DB (plaintext). For production hardening,
 * consider encrypting at rest or using a secrets manager. The current approach
 * matches Agent HQ's operational model where the DB is local and access-controlled.
 */

import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { resolveGitHubIdentity } from '../lib/githubIdentity';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';

const router = Router();

// GET /api/v1/github-identities
router.get('/', async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, _req);
    const identities = await db.all(`
      SELECT gi.*,
        (SELECT COUNT(*) FROM agents a WHERE a.github_identity_id = gi.id AND a.tenant_id = gi.tenant_id) AS agent_count
      FROM github_identities gi
      WHERE gi.tenant_id = ?
      ORDER BY gi.created_at ASC
    `, tenantId);

    // Mask tokens in list view — only show last 4 chars
    const masked = (identities as Record<string, unknown>[]).map(row => ({
      ...row,
      token: row.token ? `***${(row.token as string).slice(-4)}` : null,
    }));

    res.json(masked);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/github-identities/:id
router.get('/:id(\\d+)', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const identity = await db.get(`
      SELECT gi.*,
        (SELECT COUNT(*) FROM agents a WHERE a.github_identity_id = gi.id AND a.tenant_id = gi.tenant_id) AS agent_count
      FROM github_identities gi
      WHERE gi.id = ? AND gi.tenant_id = ?
    `, req.params.id, tenantId) as Record<string, unknown> | undefined;

    if (!identity) return res.status(404).json({ error: 'GitHub identity not found' });

    // Mask token
    identity.token = identity.token ? `***${(identity.token as string).slice(-4)}` : null;

    // Include linked agents
    const agents = await db.all(`
      SELECT a.id, a.name, a.session_key, a.role
      FROM agents a
      WHERE a.github_identity_id = ? AND a.tenant_id = ?
      ORDER BY a.name ASC
    `, req.params.id, tenantId);

    return res.json({ ...identity, agents });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// POST /api/v1/github-identities
router.post('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const {
      github_username,
      token,
      git_author_name,
      git_author_email,
      lane,
      notes,
    } = req.body as {
      github_username: string;
      token: string;
      git_author_name?: string;
      git_author_email?: string;
      lane?: string;
      notes?: string;
    };

    if (!github_username || !token) {
      return res.status(400).json({ error: 'github_username and token are required' });
    }

    const validLanes = ['dev', 'qa', 'release', 'shared'];
    const effectiveLane = lane && validLanes.includes(lane) ? lane : 'shared';

    const result = await db.run(`
      INSERT INTO github_identities (tenant_id, github_username, token, git_author_name, git_author_email, lane, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, tenantId, github_username, token, git_author_name ?? github_username, git_author_email ?? `${github_username}@users.noreply.github.com`, effectiveLane, notes ?? '');

    const created = await db.get('SELECT * FROM github_identities WHERE id = ?', result.lastInsertId) as Record<string, unknown>;
    created.token = `***${(created.token as string).slice(-4)}`;

    return res.status(201).json(created);
  } catch (err) {
    const msg = String(err);
    if (msg.includes('UNIQUE')) return res.status(409).json({ error: 'github_username already exists' });
    return res.status(500).json({ error: msg });
  }
});

// PUT /api/v1/github-identities/:id
router.put('/:id(\\d+)', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const existing = await db.get('SELECT * FROM github_identities WHERE id = ? AND tenant_id = ?', req.params.id, tenantId) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'GitHub identity not found' });

    const {
      github_username,
      token,
      git_author_name,
      git_author_email,
      lane,
      notes,
      enabled,
    } = req.body as {
      github_username?: string;
      token?: string;
      git_author_name?: string;
      git_author_email?: string;
      lane?: string;
      notes?: string;
      enabled?: number | boolean;
    };

    const validLanes = ['dev', 'qa', 'release', 'shared'];

    await db.run(`
      UPDATE github_identities SET
        github_username = ?,
        token = ?,
        git_author_name = ?,
        git_author_email = ?,
        lane = ?,
        notes = ?,
        enabled = ?,
        updated_at = datetime('now')
      WHERE id = ?
        AND tenant_id = ?
    `, github_username ?? existing.github_username, token ?? existing.token, git_author_name ?? existing.git_author_name, git_author_email ?? existing.git_author_email, (lane && validLanes.includes(lane)) ? lane : existing.lane, notes ?? existing.notes, enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled, req.params.id, tenantId);

    const updated = await db.get('SELECT * FROM github_identities WHERE id = ? AND tenant_id = ?', req.params.id, tenantId) as Record<string, unknown>;
    updated.token = updated.token ? `***${(updated.token as string).slice(-4)}` : null;

    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/v1/github-identities/:id
router.delete('/:id(\\d+)', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const existing = await db.get('SELECT id FROM github_identities WHERE id = ? AND tenant_id = ?', req.params.id, tenantId);
    if (!existing) return res.status(404).json({ error: 'GitHub identity not found' });

    // Check for linked agents
    const linkedCount = (await db.get('SELECT COUNT(*) as n FROM agents WHERE github_identity_id = ? AND tenant_id = ?', req.params.id, tenantId) as { n: number }).n;

    if (linkedCount > 0) {
      return res.status(409).json({
        error: `Cannot delete identity: ${linkedCount} agent(s) still linked. Unlink them first.`,
      });
    }

    await db.run('DELETE FROM github_identities WHERE id = ? AND tenant_id = ?', req.params.id, tenantId);
    return res.json({ ok: true, deleted: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// POST /api/v1/github-identities/:id/validate
// Validates the stored PAT by calling GitHub's /user API
router.post('/:id(\\d+)/validate', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const identity = await db.get('SELECT * FROM github_identities WHERE id = ? AND tenant_id = ?', req.params.id, tenantId) as Record<string, unknown> | undefined;
    if (!identity) return res.status(404).json({ error: 'GitHub identity not found' });

    const token = identity.token as string;
    if (!token) return res.status(400).json({ error: 'No token stored for this identity' });

    const resp = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      await db.run(`
        UPDATE github_identities
        SET last_validated_at = datetime('now'), validation_status = 'failed', validation_error = ?
        WHERE id = ?
          AND tenant_id = ?
      `, `HTTP ${resp.status}: ${body.slice(0, 500)}`, req.params.id, tenantId);

      return res.json({
        valid: false,
        status: resp.status,
        error: `GitHub API returned ${resp.status}`,
      });
    }

    const user = await resp.json() as { login: string; id: number; name?: string; email?: string };

    await db.run(`
      UPDATE github_identities
      SET last_validated_at = datetime('now'), validation_status = 'valid', validation_error = NULL
      WHERE id = ?
        AND tenant_id = ?
    `, req.params.id, tenantId);

    return res.json({
      valid: true,
      github_login: user.login,
      github_id: user.id,
      github_name: user.name ?? null,
      github_email: user.email ?? null,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/github-identities/resolve/:agent_id
// Resolve the GitHub identity for a specific agent (used by dispatcher internally)
router.get('/resolve/:agent_id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const agent = await db.get(`SELECT id FROM agents WHERE id = ? AND tenant_id = ? LIMIT 1`, req.params.agent_id, tenantId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const resolved = await resolveGitHubIdentity(db, Number(req.params.agent_id), tenantId);

    if (!resolved) {
      return res.json({ resolved: false, identity: null });
    }

    const { identity, dedicated } = resolved;
    return res.json({
      resolved: true,
      dedicated,
      identity: {
        id: identity.id,
        github_username: identity.github_username,
        git_author_name: identity.git_author_name,
        git_author_email: identity.git_author_email,
        lane: identity.lane,
        // Token intentionally excluded from resolve endpoint
      },
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
