import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';
import { instanceTenantScope, logTenantScope } from '../lib/runtimeTenantScope';

const router = Router();

// GET /api/v1/logs
router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const { agent_id, level, from, to, limit, instance_id } = req.query as {
      agent_id?: string;
      level?: string;
      from?: string;
      to?: string;
      limit?: string;
      instance_id?: string;
    };

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    const tenantScope = logTenantScope(db, 'l', tenantId);
    conditions.push(tenantScope.sql);
    params.push(...tenantScope.params as (string | number)[]);

    if (agent_id) {
      conditions.push('l.agent_id = ?');
      params.push(Number(agent_id));
    }
    if (level) {
      conditions.push('l.level = ?');
      params.push(level);
    }
    if (from) {
      conditions.push('l.created_at >= ?');
      params.push(from);
    }
    if (to) {
      conditions.push('l.created_at <= ?');
      params.push(to);
    }
    if (instance_id) {
      conditions.push('l.instance_id = ?');
      params.push(Number(instance_id));
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = `LIMIT ${Math.min(parseInt(limit ?? '100'), 500)}`;

    const logs = db.prepare(`
      SELECT l.*, a.name as agent_name
      FROM logs l
      LEFT JOIN agents a ON a.id = l.agent_id
      ${where}
      ORDER BY l.created_at DESC
      ${limitClause}
    `).all(...params);

    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/instances — all instances for Kanban
// Reads job_title from agents table directly.
router.get('/instances', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const tenantScope = instanceTenantScope(db, 'ji', tenantId);
    const instances = db.prepare(`
      SELECT ji.*, a.job_title as job_title, a.name as agent_name, a.session_key as agent_session_key
      FROM job_instances ji
      LEFT JOIN agents a ON a.id = ji.agent_id
      WHERE ${tenantScope.sql}
      ORDER BY ji.created_at DESC
      LIMIT 200
    `).all(...tenantScope.params);
    res.json(instances);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
