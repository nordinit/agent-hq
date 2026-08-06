/**
 * Team CRUD, membership, capability defaults, routing templates, and workflow ownership.
 *
 * Mirrors the shape of routes/mcp-servers.ts: tenant resolved per request, soft delete rather
 * than DELETE, and 409 on a slug collision. The interesting endpoints are the last three —
 * context-preview, which renders exactly what a member's prompt will contain, and the two
 * workflow ownership routes, where assigning a team and stamping its routing template are
 * deliberately separate actions.
 */

import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';
import { isPostgresUniqueViolation } from '../lib/postgresErrors';
import { requireNumericId } from '../lib/routeParams';
import { renderTeamContextForAgent, resolveDispatchTeamId } from '../domains/teams/context';
import { fetchEffectiveAgentMcpRows, fetchEffectiveAgentToolRows, resolveEffectiveSkillNames } from '../domains/teams/effectiveCapabilities';
import { applyTeamRouting, planTeamRoutingApplication } from '../domains/teams/routingTemplates';
import { requestAuditActor } from '../domains/routing/audit';
import { syncAssignedMcpForAgent } from '../runtimes/mcpMaterialization';

const router = Router();
router.param('id', requireNumericId);

function errorStatus(err: unknown): number {
  const status = (err as { status?: unknown })?.status;
  return typeof status === 'number' ? status : 500;
}

function fail(res: Response, err: unknown): Response {
  const status = errorStatus(err);
  const message = err instanceof Error ? err.message : String(err);
  return res.status(status).json({ error: status === 500 ? String(err) : message });
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeJsonArray(value: unknown, fallback: string): string {
  if (Array.isArray(value)) return JSON.stringify(value.filter((item) => typeof item === 'string'));
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? JSON.stringify(parsed.filter((item) => typeof item === 'string')) : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function normalizeJsonObject(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return value.trim() ? value : fallback;
    }
  }
  if (value == null) return fallback;
  return JSON.stringify(value);
}

/**
 * Any edit that changes what a member's prompt says bumps context_version, so a transcript can
 * be tied back to the exact definition it ran under. Cheap to call and idempotent per request.
 */
async function bumpContextVersion(teamId: number): Promise<void> {
  await getDb().run(`
    UPDATE teams
    SET context_version = context_version + 1,
        updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = ?
  `, teamId);
}

async function requireTeam(teamId: unknown, tenantId: number): Promise<Record<string, unknown>> {
  const team = await getDb().get(
    `SELECT * FROM teams WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
    teamId, tenantId,
  ) as Record<string, unknown> | undefined;
  if (!team) {
    const err = new Error('Team not found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  return team;
}

// ── Teams ────────────────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const rows = await db.all(`
      SELECT t.*,
             (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id AND tm.enabled = 1) AS member_count,
             (SELECT COUNT(*) FROM sprints s WHERE s.team_id = t.id) AS workflow_count
      FROM teams t
      WHERE t.tenant_id = ? AND t.deleted_at IS NULL
      ORDER BY t.name ASC
    `, tenantId);
    return res.json(rows);
  } catch (err) {
    return fail(res, err);
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = await resolveTenantIdFromRequest(getDb(), req);
    return res.json(await requireTeam(req.params.id, tenantId));
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const { name, slug, description, goal, charter, project_id, skill_names, enabled } = req.body as Record<string, unknown>;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const resolvedSlug = typeof slug === 'string' && slug.trim() ? slugify(slug) : slugify(name);
    if (!resolvedSlug) return res.status(400).json({ error: 'slug could not be derived from name' });

    const result = await db.run(`
      INSERT INTO teams (tenant_id, name, slug, description, goal, charter, project_id, skill_names, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      tenantId, name.trim(), resolvedSlug,
      typeof description === 'string' ? description.trim() : '',
      typeof goal === 'string' ? goal.trim() : '',
      typeof charter === 'string' ? charter.trim() : '',
      project_id == null ? null : Number(project_id),
      normalizeJsonArray(skill_names, '[]'),
      enabled === undefined ? 1 : (enabled ? 1 : 0),
    );

    return res.status(201).json(await db.get('SELECT * FROM teams WHERE id = ?', result.lastInsertId));
  } catch (err) {
    if (isPostgresUniqueViolation(err)) {
      return res.status(409).json({ error: 'A team with this slug already exists' });
    }
    return fail(res, err);
  }
});

router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const existing = await requireTeam(req.params.id, tenantId);
    const body = req.body as Record<string, unknown>;

    const next = {
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : existing.name,
      slug: typeof body.slug === 'string' && body.slug.trim() ? slugify(body.slug) : existing.slug,
      description: typeof body.description === 'string' ? body.description.trim() : existing.description,
      goal: typeof body.goal === 'string' ? body.goal.trim() : existing.goal,
      charter: typeof body.charter === 'string' ? body.charter.trim() : existing.charter,
      project_id: body.project_id === undefined
        ? existing.project_id
        : (body.project_id == null ? null : Number(body.project_id)),
      skill_names: body.skill_names === undefined
        ? existing.skill_names
        : normalizeJsonArray(body.skill_names, '[]'),
      enabled: body.enabled === undefined ? existing.enabled : (body.enabled ? 1 : 0),
    };

    await db.run(`
      UPDATE teams
      SET name = ?, slug = ?, description = ?, goal = ?, charter = ?, project_id = ?,
          skill_names = ?, enabled = ?,
          updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = ? AND tenant_id = ?
    `,
      next.name, next.slug, next.description, next.goal, next.charter, next.project_id,
      next.skill_names, next.enabled, req.params.id, tenantId,
    );
    await bumpContextVersion(Number(req.params.id));

    return res.json(await db.get('SELECT * FROM teams WHERE id = ?', req.params.id));
  } catch (err) {
    if (isPostgresUniqueViolation(err)) {
      return res.status(409).json({ error: 'A team with this slug already exists' });
    }
    return fail(res, err);
  }
});

/**
 * Soft delete. Workflows keep their team_id and materialized routing rules keep their
 * provenance — both are ON DELETE SET NULL, so a hard delete would silently detach live
 * configuration. The rows stay explicable instead.
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    await requireTeam(req.params.id, tenantId);
    await db.run(`
      UPDATE teams
      SET deleted_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
          updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = ? AND tenant_id = ?
    `, req.params.id, tenantId);
    return res.json({ ok: true, id: Number(req.params.id) });
  } catch (err) {
    return fail(res, err);
  }
});

// ── Members ──────────────────────────────────────────────────────────────────

router.get('/:id/members', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    await requireTeam(req.params.id, tenantId);
    const rows = await db.all(`
      SELECT tm.*,
             COALESCE(NULLIF(ag.name, ''), NULLIF(ag.job_title, ''), 'Agent #' || ag.id) AS agent_name,
             ag.enabled AS agent_enabled
      FROM team_members tm
      JOIN agents ag ON ag.id = tm.agent_id
      WHERE tm.team_id = ? AND ag.deleted_at IS NULL
      ORDER BY tm.sort_order ASC, tm.id ASC
    `, req.params.id);
    return res.json(rows);
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/:id/members', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    await requireTeam(req.params.id, tenantId);
    const { agent_id, member_role, responsibilities, is_lead, is_primary, sort_order, enabled } = req.body as Record<string, unknown>;

    if (agent_id == null) return res.status(400).json({ error: 'agent_id is required' });
    const agent = await db.get(
      `SELECT id FROM agents WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
      agent_id, tenantId,
    );
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const result = await db.run(`
      INSERT INTO team_members
        (team_id, agent_id, member_role, responsibilities, is_lead, is_primary, sort_order, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      req.params.id, agent_id,
      typeof member_role === 'string' ? member_role.trim() : '',
      typeof responsibilities === 'string' ? responsibilities.trim() : '',
      is_lead ? 1 : 0, is_primary ? 1 : 0,
      Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0,
      enabled === undefined ? 1 : (enabled ? 1 : 0),
    );
    await bumpContextVersion(Number(req.params.id));

    return res.status(201).json(await db.get('SELECT * FROM team_members WHERE id = ?', result.lastInsertId));
  } catch (err) {
    if (isPostgresUniqueViolation(err)) {
      // Either the agent is already on this team, or it already has a primary membership
      // elsewhere — the partial unique index on (agent_id) WHERE is_primary = 1.
      return res.status(409).json({
        error: 'Agent is already a member of this team, or already has a primary team',
      });
    }
    return fail(res, err);
  }
});

router.patch('/:id/members/:agentId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    await requireTeam(req.params.id, tenantId);
    const existing = await db.get(
      `SELECT * FROM team_members WHERE team_id = ? AND agent_id = ?`,
      req.params.id, req.params.agentId,
    ) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Team member not found' });

    const body = req.body as Record<string, unknown>;
    await db.run(`
      UPDATE team_members
      SET member_role = ?, responsibilities = ?, is_lead = ?, is_primary = ?, sort_order = ?, enabled = ?,
          updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
      WHERE team_id = ? AND agent_id = ?
    `,
      typeof body.member_role === 'string' ? body.member_role.trim() : existing.member_role,
      typeof body.responsibilities === 'string' ? body.responsibilities.trim() : existing.responsibilities,
      body.is_lead === undefined ? existing.is_lead : (body.is_lead ? 1 : 0),
      body.is_primary === undefined ? existing.is_primary : (body.is_primary ? 1 : 0),
      body.sort_order === undefined ? existing.sort_order : Number(body.sort_order),
      body.enabled === undefined ? existing.enabled : (body.enabled ? 1 : 0),
      req.params.id, req.params.agentId,
    );
    await bumpContextVersion(Number(req.params.id));

    return res.json(await db.get(
      `SELECT * FROM team_members WHERE team_id = ? AND agent_id = ?`,
      req.params.id, req.params.agentId,
    ));
  } catch (err) {
    if (isPostgresUniqueViolation(err)) {
      return res.status(409).json({ error: 'That agent already has a primary team' });
    }
    return fail(res, err);
  }
});

router.delete('/:id/members/:agentId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    await requireTeam(req.params.id, tenantId);
    const result = await db.run(
      `DELETE FROM team_members WHERE team_id = ? AND agent_id = ?`,
      req.params.id, req.params.agentId,
    );
    if (!result.changes) return res.status(404).json({ error: 'Team member not found' });
    await bumpContextVersion(Number(req.params.id));
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

// ── Capability defaults ──────────────────────────────────────────────────────

/**
 * A team capability change reaches every member's materialized runtime config, so the affected
 * agents are resynced in the background rather than waiting for each one's next dispatch.
 */
function scheduleTeamMcpSync(teamId: number): void {
  setImmediate(async () => {
    try {
      const db = getDb();
      const members = await db.all(
        `SELECT agent_id FROM team_members WHERE team_id = ? AND enabled = 1 ORDER BY agent_id ASC`,
        teamId,
      ) as Array<{ agent_id: number }>;
      for (const { agent_id } of members) {
        const result = await syncAssignedMcpForAgent({ db, agentId: agent_id, materializeOpenClawGlobalConfig: true });
        if (!result.ok && result.error) {
          console.warn(`[teams] MCP sync failed for agent #${agent_id}: ${result.error}`);
        }
      }
    } catch (err) {
      console.warn(`[teams] MCP sync failed for team #${teamId}:`, err instanceof Error ? err.message : String(err));
    }
  });
}

router.get('/:id/tools', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    await requireTeam(req.params.id, tenantId);
    return res.json(await db.all(`
      SELECT tta.id AS assignment_id, tta.team_id, tta.tool_id, tta.overrides,
             tta.enabled AS assignment_enabled, t.*
      FROM team_tool_assignments tta
      JOIN tools t ON t.id = tta.tool_id AND t.tenant_id = ?
      WHERE tta.team_id = ?
      ORDER BY t.name ASC
    `, tenantId, req.params.id));
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/:id/tools', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    await requireTeam(req.params.id, tenantId);
    const { tool_id, overrides, enabled } = req.body as Record<string, unknown>;
    if (tool_id == null) return res.status(400).json({ error: 'tool_id is required' });

    const tool = await db.get(`SELECT id FROM tools WHERE id = ? AND tenant_id = ?`, tool_id, tenantId);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });

    const result = await db.run(`
      INSERT INTO team_tool_assignments (team_id, tool_id, overrides, enabled)
      VALUES (?, ?, ?, ?)
    `, req.params.id, tool_id, normalizeJsonObject(overrides, '{}'), enabled === undefined ? 1 : (enabled ? 1 : 0));

    return res.status(201).json(await db.get('SELECT * FROM team_tool_assignments WHERE id = ?', result.lastInsertId));
  } catch (err) {
    if (isPostgresUniqueViolation(err)) {
      return res.status(409).json({ error: 'That tool is already assigned to this team' });
    }
    return fail(res, err);
  }
});

router.delete('/:id/tools/:toolId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    await requireTeam(req.params.id, tenantId);
    const result = await db.run(
      `DELETE FROM team_tool_assignments WHERE team_id = ? AND tool_id = ?`,
      req.params.id, req.params.toolId,
    );
    if (!result.changes) return res.status(404).json({ error: 'Team tool assignment not found' });
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

router.get('/:id/mcp-servers', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    await requireTeam(req.params.id, tenantId);
    return res.json(await db.all(`
      SELECT tma.id AS assignment_id, tma.team_id, tma.mcp_server_id, tma.overrides,
             tma.enabled AS assignment_enabled, s.*
      FROM team_mcp_assignments tma
      JOIN mcp_servers s ON s.id = tma.mcp_server_id AND s.tenant_id = ?
      WHERE tma.team_id = ?
      ORDER BY s.name ASC
    `, tenantId, req.params.id));
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/:id/mcp-servers', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    await requireTeam(req.params.id, tenantId);
    const { mcp_server_id, overrides, enabled } = req.body as Record<string, unknown>;
    if (mcp_server_id == null) return res.status(400).json({ error: 'mcp_server_id is required' });

    const server = await db.get(`SELECT id FROM mcp_servers WHERE id = ? AND tenant_id = ?`, mcp_server_id, tenantId);
    if (!server) return res.status(404).json({ error: 'MCP server not found' });

    const result = await db.run(`
      INSERT INTO team_mcp_assignments (team_id, mcp_server_id, overrides, enabled)
      VALUES (?, ?, ?, ?)
    `, req.params.id, mcp_server_id, normalizeJsonObject(overrides, '{}'), enabled === undefined ? 1 : (enabled ? 1 : 0));
    scheduleTeamMcpSync(Number(req.params.id));

    return res.status(201).json(await db.get('SELECT * FROM team_mcp_assignments WHERE id = ?', result.lastInsertId));
  } catch (err) {
    if (isPostgresUniqueViolation(err)) {
      return res.status(409).json({ error: 'That MCP server is already assigned to this team' });
    }
    return fail(res, err);
  }
});

router.delete('/:id/mcp-servers/:serverId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    await requireTeam(req.params.id, tenantId);
    const result = await db.run(
      `DELETE FROM team_mcp_assignments WHERE team_id = ? AND mcp_server_id = ?`,
      req.params.id, req.params.serverId,
    );
    if (!result.changes) return res.status(404).json({ error: 'Team MCP assignment not found' });
    scheduleTeamMcpSync(Number(req.params.id));
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

// ── Routing templates ────────────────────────────────────────────────────────

router.get('/:id/routing-rules', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    await requireTeam(req.params.id, tenantId);
    return res.json(await db.all(`
      SELECT trr.*,
             COALESCE(NULLIF(ag.name, ''), NULLIF(ag.job_title, '')) AS agent_name
      FROM team_routing_rules trr
      LEFT JOIN agents ag ON ag.id = trr.agent_id
      WHERE trr.team_id = ? AND trr.tenant_id = ?
      ORDER BY trr.status ASC, trr.priority DESC, trr.id ASC
    `, req.params.id, tenantId));
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/:id/routing-rules', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    await requireTeam(req.params.id, tenantId);
    const { workflow_type, task_type, status, agent_id, member_role, priority, enabled } = req.body as Record<string, unknown>;

    if (!status || typeof status !== 'string') return res.status(400).json({ error: 'status is required' });
    const role = typeof member_role === 'string' ? member_role.trim() : '';
    if (agent_id == null && !role) {
      return res.status(400).json({ error: 'either agent_id or member_role is required' });
    }
    if (agent_id != null) {
      const member = await db.get(
        `SELECT agent_id FROM team_members WHERE team_id = ? AND agent_id = ?`,
        req.params.id, agent_id,
      );
      if (!member) return res.status(400).json({ error: 'agent_id must be a member of this team' });
    }

    const result = await db.run(`
      INSERT INTO team_routing_rules
        (tenant_id, team_id, workflow_type, task_type, status, agent_id, member_role, priority, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      tenantId, req.params.id,
      typeof workflow_type === 'string' && workflow_type.trim() ? workflow_type.trim() : null,
      typeof task_type === 'string' && task_type.trim() ? task_type.trim() : null,
      status.trim(), agent_id == null ? null : Number(agent_id), role,
      Number.isFinite(Number(priority)) ? Number(priority) : 0,
      enabled === undefined ? 1 : (enabled ? 1 : 0),
    );

    return res.status(201).json(await db.get('SELECT * FROM team_routing_rules WHERE id = ?', result.lastInsertId));
  } catch (err) {
    return fail(res, err);
  }
});

router.delete('/:id/routing-rules/:ruleId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    await requireTeam(req.params.id, tenantId);
    const result = await db.run(
      `DELETE FROM team_routing_rules WHERE id = ? AND team_id = ? AND tenant_id = ?`,
      req.params.ruleId, req.params.id, tenantId,
    );
    if (!result.changes) return res.status(404).json({ error: 'Team routing rule not found' });
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

// ── Context preview ──────────────────────────────────────────────────────────

/**
 * The exact block a member's prompt will carry. Worth having on day one: it turns "why did the
 * agent do that" into one request rather than an archaeology session through transcripts.
 */
router.get('/:id/context-preview', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    await requireTeam(req.params.id, tenantId);
    const agentId = Number(req.query.agent_id);
    if (!Number.isSafeInteger(agentId) || agentId <= 0) {
      return res.status(400).json({ error: 'agent_id query parameter is required' });
    }

    const rendered = await renderTeamContextForAgent(db, { teamId: Number(req.params.id), agentId });
    if (!rendered) return res.status(404).json({ error: 'Team not found or disabled' });
    return res.json({
      ...rendered,
      /** '' means the block would be omitted from the prompt entirely. */
      injected: Boolean(rendered.section),
    });
  } catch (err) {
    return fail(res, err);
  }
});

// ── Agent-facing view ────────────────────────────────────────────────────────

export const agentTeamsRouter = Router({ mergeParams: true });

agentTeamsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const agentId = req.params.agentId ?? req.params.id;
    const agent = await db.get(`SELECT id FROM agents WHERE id = ? AND tenant_id = ?`, agentId, tenantId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    return res.json(await db.all(`
      SELECT te.id AS team_id, te.name, te.slug, te.goal,
             tm.member_role, tm.responsibilities, tm.is_lead, tm.is_primary, tm.enabled
      FROM team_members tm
      JOIN teams te ON te.id = tm.team_id
      WHERE tm.agent_id = ? AND te.tenant_id = ? AND te.deleted_at IS NULL
      ORDER BY te.name ASC
    `, agentId, tenantId));
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * What this agent actually gets at dispatch time, with each grant labelled own or inherited.
 * The UI uses it to explain a capability the operator never assigned to the agent directly.
 */
export const agentEffectiveCapabilitiesRouter = Router({ mergeParams: true });

agentEffectiveCapabilitiesRouter.get('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const agentId = Number(req.params.agentId ?? req.params.id);
    const agent = await db.get(
      `SELECT id, skill_names FROM agents WHERE id = ? AND tenant_id = ?`,
      agentId, tenantId,
    ) as { id: number; skill_names: unknown } | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const [tools, mcpServers, skillNames, dispatchTeamId] = await Promise.all([
      fetchEffectiveAgentToolRows(db, agentId),
      fetchEffectiveAgentMcpRows(db, agentId),
      resolveEffectiveSkillNames(db, agentId, agent.skill_names),
      resolveDispatchTeamId(db, { agentId }),
    ]);

    return res.json({
      agent_id: agentId,
      /** Which team would speak for a dispatch with no workflow context; null if ambiguous. */
      dispatch_team_id: dispatchTeamId,
      tools: tools.map((row) => ({
        id: row.id, name: row.name, slug: row.slug,
        source: row.source, source_team_id: row.source_team_id, source_team_name: row.source_team_name,
      })),
      mcp_servers: mcpServers.map((row) => ({
        id: row.mcp_server_id, slug: row.slug,
        source: row.source, source_team_id: row.source_team_id, source_team_name: row.source_team_name,
      })),
      skill_names: skillNames,
    });
  } catch (err) {
    return fail(res, err);
  }
});

// ── Workflow ownership ───────────────────────────────────────────────────────

export const workflowTeamRouter = Router({ mergeParams: true });

workflowTeamRouter.put('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const workflowId = Number(req.params.workflowId ?? req.params.id);
    const { team_id } = req.body as Record<string, unknown>;

    const workflow = await db.get(
      `SELECT id, tenant_id FROM sprints WHERE id = ?`, workflowId,
    ) as { id: number; tenant_id: number | null } | undefined;
    if (!workflow || (workflow.tenant_id != null && Number(workflow.tenant_id) !== tenantId)) {
      return res.status(404).json({ error: 'Workflow not found' });
    }
    if (team_id != null) await requireTeam(team_id, tenantId);

    await db.run(`UPDATE sprints SET team_id = ? WHERE id = ?`, team_id == null ? null : Number(team_id), workflowId);
    // Assigning a team changes context injection immediately. Routing is deliberately NOT
    // touched here: rewriting routing configuration as a side effect of setting a dropdown is
    // not something an operator can undo.
    return res.json({ ok: true, workflow_id: workflowId, team_id: team_id == null ? null : Number(team_id) });
  } catch (err) {
    return fail(res, err);
  }
});

workflowTeamRouter.post('/apply-routing', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const workflowId = Number(req.params.workflowId ?? req.params.id);
    const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true';

    if (dryRun) {
      return res.json(await planTeamRoutingApplication(db, { workflowId, tenantId }));
    }

    const actor = requestAuditActor(req);
    // Batch id is derived from the request, not the clock, so a retry of the same apply is
    // traceable as one operator action.
    const batchId = `team-routing-${workflowId}-${tenantId}-${actor.actor}`;
    return res.json(await applyTeamRouting(db, {
      workflowId, tenantId, batchId, actor: actor.actor, actorKind: actor.actorKind,
    }));
  } catch (err) {
    return fail(res, err);
  }
});

export default router;
