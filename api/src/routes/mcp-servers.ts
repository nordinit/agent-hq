import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { syncAssignedMcpForAgent, syncAssignedMcpForServer } from '../runtimes/mcpMaterialization';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';

const router = Router();

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
  setImmediate(() => {
    try {
      const result = syncAssignedMcpForAgent({
        db: getDb(),
        agentId,
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
  setImmediate(() => {
    try {
      const results = syncAssignedMcpForServer({
        db: getDb(),
        mcpServerId,
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

router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const rows = db.prepare(`
      SELECT *
      FROM mcp_servers
      WHERE tenant_id = ?
      ORDER BY name ASC
    `).all(tenantId);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ? AND tenant_id = ?').get(req.params.id, tenantId);
    if (!row) return res.status(404).json({ error: 'MCP server not found' });
    return res.json(row);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.post('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
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

    const result = db.prepare(`
      INSERT INTO mcp_servers (tenant_id, name, slug, description, transport, command, args, env, cwd, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tenantId,
      name.trim(),
      slug.trim(),
      typeof description === 'string' ? description.trim() : '',
      transport === 'stdio' ? 'stdio' : 'stdio',
      command.trim(),
      normalizeJsonText(args, '[]'),
      normalizeJsonText(env, '{}'),
      typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null,
      enabled !== undefined ? (enabled ? 1 : 0) : 1,
    );

    const created = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(result.lastInsertRowid);
    return res.status(201).json(created);
  } catch (err: any) {
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || String(err).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'An MCP server with this slug already exists' });
    }
    return res.status(500).json({ error: String(err) });
  }
});

router.put('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const existing = db.prepare('SELECT * FROM mcp_servers WHERE id = ? AND tenant_id = ?').get(req.params.id, tenantId) as Record<string, unknown> | undefined;
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

    db.prepare(`
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
          updated_at = datetime('now')
      WHERE id = ? AND tenant_id = ?
    `).run(
      typeof name === 'string' ? name.trim() : existing.name,
      typeof slug === 'string' ? slug.trim() : existing.slug,
      typeof description === 'string' ? description.trim() : existing.description,
      transport === 'stdio' ? 'stdio' : existing.transport,
      typeof command === 'string' ? command.trim() : existing.command,
      args !== undefined ? normalizeJsonText(args, '[]') : existing.args,
      env !== undefined ? normalizeJsonText(env, '{}') : existing.env,
      cwd !== undefined ? (typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null) : existing.cwd,
      enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
      req.params.id,
      tenantId,
    );

    const updated = db.prepare('SELECT * FROM mcp_servers WHERE id = ? AND tenant_id = ?').get(req.params.id, tenantId);
    scheduleServerMcpSync(Number(req.params.id));
    return res.json(updated);
  } catch (err: any) {
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || String(err).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'An MCP server with this slug already exists' });
    }
    return res.status(500).json({ error: String(err) });
  }
});

router.delete('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const existing = db.prepare('SELECT id FROM mcp_servers WHERE id = ? AND tenant_id = ?').get(req.params.id, tenantId);
    if (!existing) return res.status(404).json({ error: 'MCP server not found' });
    db.prepare(`UPDATE mcp_servers SET enabled = 0, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`).run(req.params.id, tenantId);
    scheduleServerMcpSync(Number(req.params.id));
    return res.json({ ok: true, id: Number(req.params.id) });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export const agentMcpServersRouter = Router({ mergeParams: true });

agentMcpServersRouter.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const agentId = req.params.agentId ?? req.params.id;
    const agent = db.prepare('SELECT id FROM agents WHERE id = ? AND tenant_id = ?').get(agentId, tenantId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const rows = db.prepare(`
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
    `).all(agentId, tenantId);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

agentMcpServersRouter.post('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const agentId = req.params.agentId ?? req.params.id;
    const { mcp_server_id, overrides, enabled } = req.body as Record<string, unknown>;

    if (!mcp_server_id) return res.status(400).json({ error: 'mcp_server_id is required' });

    const agent = db.prepare('SELECT id FROM agents WHERE id = ? AND tenant_id = ?').get(agentId, tenantId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const server = db.prepare('SELECT id FROM mcp_servers WHERE id = ? AND tenant_id = ?').get(mcp_server_id, tenantId);
    if (!server) return res.status(404).json({ error: 'MCP server not found' });

    const result = db.prepare(`
      INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id, overrides, enabled)
      VALUES (?, ?, ?, ?)
    `).run(
      agentId,
      mcp_server_id,
      normalizeJsonText(overrides, '{}'),
      enabled !== undefined ? (enabled ? 1 : 0) : 1,
    );

    const created = db.prepare(`
      SELECT ama.id AS assignment_id,
             ama.agent_id,
             ama.mcp_server_id,
             ama.overrides,
             ama.enabled AS assignment_enabled,
             s.*
      FROM agent_mcp_assignments ama
      JOIN mcp_servers s ON s.id = ama.mcp_server_id
      WHERE ama.id = ?
    `).get(result.lastInsertRowid);
    scheduleAgentMcpSync(Number(agentId));
    return res.status(201).json(created);
  } catch (err: any) {
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || String(err).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'This MCP server is already assigned to the agent' });
    }
    return res.status(500).json({ error: String(err) });
  }
});

agentMcpServersRouter.delete('/:mcpServerId', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const agentId = req.params.agentId ?? req.params.id;
    const mcpServerId = req.params.mcpServerId;
    const existing = db.prepare(`
      SELECT id FROM agent_mcp_assignments WHERE agent_id = ? AND mcp_server_id = ?
        AND EXISTS (SELECT 1 FROM agents a WHERE a.id = agent_id AND a.tenant_id = ?)
        AND EXISTS (SELECT 1 FROM mcp_servers s WHERE s.id = mcp_server_id AND s.tenant_id = ?)
    `).get(agentId, mcpServerId, tenantId, tenantId);
    if (!existing) return res.status(404).json({ error: 'Assignment not found' });
    db.prepare(`DELETE FROM agent_mcp_assignments WHERE agent_id = ? AND mcp_server_id = ?`).run(agentId, mcpServerId);
    scheduleAgentMcpSync(Number(agentId));
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
