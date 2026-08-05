import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { syncAssignedMcpForAgent, syncAssignedMcpForServer } from '../runtimes/mcpMaterialization';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';
import { isPostgresUniqueViolation } from '../lib/postgresErrors';

import { requireNumericId } from '../lib/routeParams';

const router = Router();
// Rejects a non-numeric :id before it reaches the database, restoring the 404 SQLite
// returned for a no-match. Must be per-router: app.param() does not fire for a param
// declared on a mounted sub-router.
router.param('id', requireNumericId);

function normalizeJsonText(value: unknown, fallback: string): string {
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

function scheduleAgentMcpSync(agentId: number): void {
  setImmediate(async () => {
    try {
      const result = await syncAssignedMcpForAgent({
              db: getDb(),
              agentId,
              materializeOpenClawGlobalConfig: true,
            });
      for (const warn of result.warnings) {
        console.warn(`[mcp-servers] ${warn}`);
      }
      if (result.skipped === 'unsupported_runtime') return;
      if (result.skipped === 'missing_workspace') {
        console.warn(`[mcp-servers] MCP sync skipped for agent #${agentId}: no workspace_path`);
        return;
      }
      if (!result.ok && result.error) {
        console.warn(`[mcp-servers] MCP sync failed for agent #${agentId}: ${result.error}`);
        return;
      }
      console.log(
        `[mcp-servers] MCP sync for agent #${agentId}: ${result.count} server(s) materialized in ${result.workingDirectory}`,
      );
    } catch (err) {
      console.warn(
        `[mcp-servers] MCP sync failed for agent #${agentId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  });
}

function scheduleServerMcpSync(mcpServerId: number): void {
  setImmediate(async () => {
    try {
      const results = await syncAssignedMcpForServer({
              db: getDb(),
              mcpServerId,
              materializeOpenClawGlobalConfig: true,
            });
      for (const result of results) {
        for (const warn of result.warnings) {
          console.warn(`[mcp-servers] ${warn}`);
        }
        if (result.skipped === 'unsupported_runtime') continue;
        if (result.skipped === 'missing_workspace') {
          console.warn(`[mcp-servers] MCP sync skipped for agent #${result.agentId}: no workspace_path`);
          continue;
        }
        if (!result.ok && result.error) {
          console.warn(`[mcp-servers] MCP sync failed for agent #${result.agentId}: ${result.error}`);
        }
      }
      if (results.length > 0) {
        console.log(`[mcp-servers] MCP sync for server #${mcpServerId}: ${results.length} assigned agent(s) refreshed`);
      }
    } catch (err) {
      console.warn(
        `[mcp-servers] MCP sync failed for server #${mcpServerId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  });
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const rows = await db.all(`
      SELECT *
      FROM mcp_servers
      WHERE tenant_id = ?
      ORDER BY name ASC
    `, tenantId);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const row = await db.get('SELECT * FROM mcp_servers WHERE id = ? AND tenant_id = ?', req.params.id, tenantId);
    if (!row) return res.status(404).json({ error: 'MCP server not found' });
    return res.json(row);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const {
      name,
      slug,
      description,
      transport,
      command,
      args,
      env,
      cwd,
      enabled,
    } = req.body as Record<string, unknown>;

    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
    if (!slug || typeof slug !== 'string') return res.status(400).json({ error: 'slug is required' });
    if (!command || typeof command !== 'string') return res.status(400).json({ error: 'command is required' });

    const result = await db.run(`
      INSERT INTO mcp_servers (tenant_id, name, slug, description, transport, command, args, env, cwd, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, tenantId, name.trim(), slug.trim(), typeof description === 'string' ? description.trim() : '', transport === 'stdio' ? 'stdio' : 'stdio', command.trim(), normalizeJsonText(args, '[]'), normalizeJsonText(env, '{}'), typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null, enabled !== undefined ? (enabled ? 1 : 0) : 1);

    const created = await db.get('SELECT * FROM mcp_servers WHERE id = ?', result.lastInsertId);
    return res.status(201).json(created);
  } catch (err: any) {
    if (isPostgresUniqueViolation(err)) {
      return res.status(409).json({ error: 'An MCP server with this slug already exists' });
    }
    return res.status(500).json({ error: String(err) });
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const existing = await db.get('SELECT * FROM mcp_servers WHERE id = ? AND tenant_id = ?', req.params.id, tenantId) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'MCP server not found' });

    const {
      name,
      slug,
      description,
      transport,
      command,
      args,
      env,
      cwd,
      enabled,
    } = req.body as Record<string, unknown>;

    await db.run(`
      UPDATE mcp_servers
      SET name = ?,
          slug = ?,
          description = ?,
          transport = ?,
          command = ?,
          args = ?,
          env = ?,
          cwd = ?,
          enabled = ?,
          updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = ? AND tenant_id = ?
    `, typeof name === 'string' ? name.trim() : existing.name, typeof slug === 'string' ? slug.trim() : existing.slug, typeof description === 'string' ? description.trim() : existing.description, transport === 'stdio' ? 'stdio' : existing.transport, typeof command === 'string' ? command.trim() : existing.command, args !== undefined ? normalizeJsonText(args, '[]') : existing.args, env !== undefined ? normalizeJsonText(env, '{}') : existing.env, cwd !== undefined ? (typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null) : existing.cwd, enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled, req.params.id, tenantId);

    const updated = await db.get('SELECT * FROM mcp_servers WHERE id = ? AND tenant_id = ?', req.params.id, tenantId);
    scheduleServerMcpSync(Number(req.params.id));
    return res.json(updated);
  } catch (err: any) {
    if (isPostgresUniqueViolation(err)) {
      return res.status(409).json({ error: 'An MCP server with this slug already exists' });
    }
    return res.status(500).json({ error: String(err) });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const existing = await db.get('SELECT id FROM mcp_servers WHERE id = ? AND tenant_id = ?', req.params.id, tenantId);
    if (!existing) return res.status(404).json({ error: 'MCP server not found' });
    await db.run(`UPDATE mcp_servers SET enabled = 0, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ? AND tenant_id = ?`, req.params.id, tenantId);
    scheduleServerMcpSync(Number(req.params.id));
    return res.json({ ok: true, id: Number(req.params.id) });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export const agentMcpServersRouter = Router({ mergeParams: true });

agentMcpServersRouter.get('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const agentId = req.params.agentId ?? req.params.id;
    const agent = await db.get('SELECT id FROM agents WHERE id = ? AND tenant_id = ?', agentId, tenantId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const rows = await db.all(`
      SELECT ama.id AS assignment_id,
             ama.agent_id,
             ama.mcp_server_id,
             ama.overrides,
             ama.enabled AS assignment_enabled,
             s.*
      FROM agent_mcp_assignments ama
      JOIN mcp_servers s ON s.id = ama.mcp_server_id
      WHERE ama.agent_id = ? AND s.tenant_id = ?
      ORDER BY s.name ASC
    `, agentId, tenantId);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

agentMcpServersRouter.post('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const agentId = req.params.agentId ?? req.params.id;
    const { mcp_server_id, overrides, enabled } = req.body as Record<string, unknown>;

    if (!mcp_server_id) return res.status(400).json({ error: 'mcp_server_id is required' });

    const agent = await db.get('SELECT id FROM agents WHERE id = ? AND tenant_id = ?', agentId, tenantId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const server = await db.get('SELECT id FROM mcp_servers WHERE id = ? AND tenant_id = ?', mcp_server_id, tenantId);
    if (!server) return res.status(404).json({ error: 'MCP server not found' });

    const result = await db.run(`
      INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id, overrides, enabled)
      VALUES (?, ?, ?, ?)
    `, agentId, mcp_server_id, normalizeJsonText(overrides, '{}'), enabled !== undefined ? (enabled ? 1 : 0) : 1);

    const created = await db.get(`
      SELECT ama.id AS assignment_id,
             ama.agent_id,
             ama.mcp_server_id,
             ama.overrides,
             ama.enabled AS assignment_enabled,
             s.*
      FROM agent_mcp_assignments ama
      JOIN mcp_servers s ON s.id = ama.mcp_server_id
      WHERE ama.id = ?
    `, result.lastInsertId);
    scheduleAgentMcpSync(Number(agentId));
    return res.status(201).json(created);
  } catch (err: any) {
    if (isPostgresUniqueViolation(err)) {
      return res.status(409).json({ error: 'This MCP server is already assigned to the agent' });
    }
    return res.status(500).json({ error: String(err) });
  }
});

agentMcpServersRouter.delete('/:mcpServerId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const agentId = req.params.agentId ?? req.params.id;
    const mcpServerId = req.params.mcpServerId;
    const existing = await db.get(`
      SELECT id FROM agent_mcp_assignments WHERE agent_id = ? AND mcp_server_id = ?
        AND EXISTS (SELECT 1 FROM agents a WHERE a.id = agent_id AND a.tenant_id = ?)
        AND EXISTS (SELECT 1 FROM mcp_servers s WHERE s.id = mcp_server_id AND s.tenant_id = ?)
    `, agentId, mcpServerId, tenantId, tenantId);
    if (!existing) return res.status(404).json({ error: 'Assignment not found' });
    await db.run(`DELETE FROM agent_mcp_assignments WHERE agent_id = ? AND mcp_server_id = ?`, agentId, mcpServerId);
    scheduleAgentMcpSync(Number(agentId));
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
