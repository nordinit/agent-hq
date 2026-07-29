import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { materializeAssignedToolForOpenClaw } from '../capability-tools/materialize';
import { executeToolImplementation, fetchAgentTools } from '../runtimes/toolInjection';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/v1/tools — list tools (default: enabled only, opt into ?enabled=0|1)
// ---------------------------------------------------------------------------
router.get('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    let sql = `SELECT * FROM tools WHERE tenant_id = ?`;
    const params: unknown[] = [tenantId];

    // Default view hides soft-deleted / disabled tools unless explicitly requested.
    if (req.query.enabled !== undefined) {
      sql += ` AND enabled = ?`;
      params.push(Number(req.query.enabled));
    } else {
      sql += ` AND enabled = 1`;
    }

    // Filter by tag (JSON array contains)
    if (req.query.tag) {
      // tags is stored as a JSON text array, e.g. '["git","filesystem"]'
      // We use LIKE as a simple containment check. For exact matching
      // we'd use json_each, but LIKE on the serialised array is fine
      // for tag filtering in practice.
      sql += ` AND tags LIKE ?`;
      params.push(`%"${String(req.query.tag)}"%`);
    }

    sql += ` ORDER BY name ASC`;

    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/tools/materialized/agents/:openclawAgentId
// Canonical OpenClaw plugin lookup. The plugin resolves the active OpenClaw
// agent id from runtime context; Agent HQ maps that to the canonical agent row.
// ---------------------------------------------------------------------------
router.get('/materialized/agents/:openclawAgentId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const openclawAgentId = String(req.params.openclawAgentId ?? '').trim();
    if (!openclawAgentId) return res.status(400).json({ error: 'openclawAgentId is required' });

    const agent = await db.get(`SELECT id, openclaw_agent_id FROM agents WHERE openclaw_agent_id = ? AND tenant_id = ?`, openclawAgentId, tenantId) as { id: number; openclaw_agent_id: string | null } | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const tools = (await fetchAgentTools(db, agent.id))
      .flatMap((tool) => {
        if (!['bash', 'shell', 'script', 'http'].includes(tool.implementation_type)) return [];
        try {
          return [materializeAssignedToolForOpenClaw(tool)];
        } catch (err) {
          console.warn(
            `[tools] skipped malformed assigned tool "${tool.slug}" for agent #${agent.id}:`,
            err instanceof Error ? err.message : String(err),
          );
          return [];
        }
      });

    return res.json({
      agent: {
        id: agent.id,
        openclaw_agent_id: agent.openclaw_agent_id,
      },
      tools,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/tools/:id — get tool detail
// ---------------------------------------------------------------------------
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const tool = await db.get(`SELECT * FROM tools WHERE id = ?`, req.params.id);
    if (tool && Number((tool as { tenant_id?: number | null }).tenant_id) !== tenantId) return res.status(404).json({ error: 'Tool not found' });
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    return res.json(tool);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/tools — create tool
// ---------------------------------------------------------------------------
router.post('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const {
      name, slug, description,
      implementation_type, implementation_body,
      input_schema, permissions, tags, enabled,
    } = req.body;

    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!slug) return res.status(400).json({ error: 'slug is required' });
    if (!implementation_type) return res.status(400).json({ error: 'implementation_type is required' });

    const result = await db.run(`
      INSERT INTO tools (tenant_id, name, slug, description, implementation_type, implementation_body, input_schema, permissions, tags, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, tenantId, name, slug, description ?? '', implementation_type, implementation_body ?? '', input_schema ? JSON.stringify(input_schema) : '{}', permissions ?? 'read_only', tags ? JSON.stringify(tags) : '[]', enabled !== undefined ? (enabled ? 1 : 0) : 1);

    const created = await db.get(`SELECT * FROM tools WHERE id = ?`, result.lastInsertRowid);
    return res.status(201).json(created);
  } catch (err: any) {
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || String(err).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'A tool with this slug already exists' });
    }
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/v1/tools/:id — update tool
// ---------------------------------------------------------------------------
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const existing = await db.get(`SELECT * FROM tools WHERE id = ? AND tenant_id = ?`, req.params.id, tenantId) as any;
    if (!existing) return res.status(404).json({ error: 'Tool not found' });

    const {
      name, slug, description,
      implementation_type, implementation_body,
      input_schema, permissions, tags, enabled,
    } = req.body;

    await db.run(`
      UPDATE tools SET
        name = ?,
        slug = ?,
        description = ?,
        implementation_type = ?,
        implementation_body = ?,
        input_schema = ?,
        permissions = ?,
        tags = ?,
        enabled = ?,
        updated_at = datetime('now')
      WHERE id = ? AND tenant_id = ?
    `, name ?? existing.name, slug ?? existing.slug, description ?? existing.description, implementation_type ?? existing.implementation_type, implementation_body ?? existing.implementation_body, input_schema !== undefined ? JSON.stringify(input_schema) : existing.input_schema, permissions ?? existing.permissions, tags !== undefined ? JSON.stringify(tags) : existing.tags, enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled, req.params.id, tenantId);

    const updated = await db.get(`SELECT * FROM tools WHERE id = ? AND tenant_id = ?`, req.params.id, tenantId);
    return res.json(updated);
  } catch (err: any) {
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || String(err).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'A tool with this slug already exists' });
    }
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/tools/:id — soft delete (disable and hide from default lists)
// ---------------------------------------------------------------------------
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const existing = await db.get(`SELECT id FROM tools WHERE id = ? AND tenant_id = ?`, req.params.id, tenantId);
    if (!existing) return res.status(404).json({ error: 'Tool not found' });

    await db.run(`UPDATE tools SET enabled = 0, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`, req.params.id, tenantId);
    return res.json({ ok: true, id: Number(req.params.id) });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/tools/:id/test — run a tool with sample input in a sandbox
// ---------------------------------------------------------------------------
router.post('/:id/test', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const tool = await db.get(`SELECT * FROM tools WHERE id = ? AND tenant_id = ?`, req.params.id, tenantId) as any;
    if (!tool) return res.status(404).json({ error: 'Tool not found' });

    const { input } = req.body;
    if (input === undefined) {
      return res.status(400).json({ error: 'input is required' });
    }

    // Validate input against schema if present
    if (tool.input_schema) {
      try {
        const schema = JSON.parse(tool.input_schema);
        // Basic type validation: if schema says "object" and input is not an object
        if (schema.type === 'object' && (typeof input !== 'object' || Array.isArray(input) || input === null)) {
          return res.status(400).json({ error: 'input must be an object matching the tool input_schema' });
        }
        // Required field validation
        if (schema.required && Array.isArray(schema.required)) {
          const missing = schema.required.filter((k: string) => !(k in input));
          if (missing.length > 0) {
            return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
          }
        }
      } catch (parseErr) {
        // Schema is malformed — skip validation
      }
    }

    const start = Date.now();

    // Execute in /tmp (sandboxed — no access to agent workspaces)
    const result = executeToolImplementation(
      {
        id: tool.id,
        tenant_id: tool.tenant_id,
        agent_tenant_id: tool.tenant_id,
        assignment_id: 0,
        name: tool.name,
        slug: tool.slug,
        description: tool.description ?? '',
        implementation_type: tool.implementation_type,
        implementation_body: tool.implementation_body ?? '',
        input_schema: tool.input_schema ?? '{}',
        permissions: tool.permissions ?? 'read_only',
        tags: tool.tags ?? '[]',
        enabled: tool.enabled ?? 1,
        overrides: '{}',
        assignment_enabled: 1,
      },
      typeof input === 'object' && input !== null ? input : {},
      '/tmp',
    );

    const duration_ms = Date.now() - start;

    const output = result.content.map((c: any) => c.text).join('');
    if (result.isError) {
      return res.json({ output: null, duration_ms, error: output });
    }
    return res.json({ output, duration_ms });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/agents/:id/tools — get all tools assigned to an agent
// (mounted on the agents router or re-exported; see agentToolsRouter below)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Agent tool assignment sub-router (mounted at /api/v1/agents/:agentId/tools)
// ---------------------------------------------------------------------------
export const agentToolsRouter = Router({ mergeParams: true });

agentToolsRouter.get('/materialized', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const openclawAgentId = String(req.query.openclaw_agent_id ?? '').trim();

    let agentId = req.params.agentId ?? req.params.id;
    if (!agentId && openclawAgentId) {
      const agent = await db.get(`SELECT id FROM agents WHERE openclaw_agent_id = ? AND tenant_id = ?`, openclawAgentId, tenantId) as { id: number } | undefined;
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      agentId = String(agent.id);
    }

    if (!agentId) {
      return res.status(400).json({ error: 'agent id or openclaw_agent_id is required' });
    }

    const agent = await db.get(`SELECT id, openclaw_agent_id FROM agents WHERE id = ? AND tenant_id = ?`, agentId, tenantId) as { id: number; openclaw_agent_id: string | null } | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const tools = (await fetchAgentTools(db, agent.id))
      .flatMap((tool) => {
        if (!['bash', 'shell', 'script', 'http'].includes(tool.implementation_type)) return [];
        try {
          return [materializeAssignedToolForOpenClaw(tool)];
        } catch (err) {
          console.warn(
            `[tools] skipped malformed assigned tool "${tool.slug}" for agent #${agent.id}:`,
            err instanceof Error ? err.message : String(err),
          );
          return [];
        }
      });

    return res.json({
      agent: {
        id: agent.id,
        openclaw_agent_id: agent.openclaw_agent_id,
      },
      tools,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

agentToolsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const agentId = req.params.agentId ?? req.params.id;

    // Verify agent exists
    const agent = await db.get(`SELECT id FROM agents WHERE id = ? AND tenant_id = ?`, agentId, tenantId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const rows = await db.all(`
      SELECT ata.id as assignment_id,
             ata.agent_id,
             ata.tool_id,
             ata.overrides,
             ata.enabled as assignment_enabled,
             t.*
      FROM agent_tool_assignments ata
      JOIN tools t ON t.id = ata.tool_id
      WHERE ata.agent_id = ? AND t.tenant_id = ?
      ORDER BY t.name ASC
    `, agentId, tenantId);

    // Contract: each assignment row returns both assignment identity and tool identity.
    // `assignment_id` identifies the join row only.
    // `tool_id` is the canonical identifier for assigned-tool checks and DELETE calls.
    // `id` mirrors the same tool id via t.* for backward compatibility.

    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

agentToolsRouter.post('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const agentId = req.params.agentId ?? req.params.id;
    const { tool_id, overrides, enabled } = req.body;

    if (!tool_id) return res.status(400).json({ error: 'tool_id is required' });

    // Verify agent and tool exist
    const agent = await db.get(`SELECT id FROM agents WHERE id = ? AND tenant_id = ?`, agentId, tenantId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const tool = await db.get(`SELECT id FROM tools WHERE id = ? AND tenant_id = ?`, tool_id, tenantId);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });

    const result = await db.run(`
      INSERT INTO agent_tool_assignments (agent_id, tool_id, overrides, enabled)
      VALUES (?, ?, ?, ?)
    `, agentId, tool_id, overrides ? JSON.stringify(overrides) : '{}', enabled !== undefined ? (enabled ? 1 : 0) : 1);

    const created = await db.get(`
      SELECT ata.id as assignment_id,
             ata.agent_id,
             ata.tool_id,
             ata.overrides,
             ata.enabled as assignment_enabled,
             t.*
      FROM agent_tool_assignments ata
      JOIN tools t ON t.id = ata.tool_id
      WHERE ata.id = ?
    `, result.lastInsertRowid);

    return res.status(201).json(created);
  } catch (err: any) {
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || String(err).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'This tool is already assigned to the agent' });
    }
    return res.status(500).json({ error: String(err) });
  }
});

agentToolsRouter.delete('/:toolId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const agentId = req.params.agentId ?? req.params.id;
    const toolId = req.params.toolId;

    const existing = await db.get(`
      SELECT id FROM agent_tool_assignments WHERE agent_id = ? AND tool_id = ?
        AND EXISTS (SELECT 1 FROM agents a WHERE a.id = agent_id AND a.tenant_id = ?)
        AND EXISTS (SELECT 1 FROM tools t WHERE t.id = tool_id AND t.tenant_id = ?)
    `, agentId, toolId, tenantId, tenantId);
    if (!existing) return res.status(404).json({ error: 'Assignment not found' });

    await db.run(`DELETE FROM agent_tool_assignments WHERE agent_id = ? AND tool_id = ?`, agentId, toolId);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
