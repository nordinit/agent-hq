import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';

const router = Router();

interface SkillListEntry {
  id: number;
  tenant_id: number;
  name: string;
  source: 'atlas' | 'workspace' | 'system';
  description: string;
  files: string[];
  created_at: string | null;
  updated_at: string | null;
}

function skillRowToListEntry(row: any): SkillListEntry {
  return {
    id: Number(row.id),
    tenant_id: Number(row.tenant_id),
    name: String(row.name),
    source: row.source,
    description: row.description ?? '',
    files: [],
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

function normalizeName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function constraintIsTenantNameConflict(err: unknown): boolean {
  const text = String((err as any)?.message ?? err);
  return (err as any)?.code === 'SQLITE_CONSTRAINT_UNIQUE' || text.includes('UNIQUE constraint failed');
}

// ---------------------------------------------------------------------------
// GET /api/v1/skills — list tenant-local skills
// ---------------------------------------------------------------------------
router.get('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const rows = await db.all(`
      SELECT id, tenant_id, name, source, description, created_at, updated_at
      FROM skills
      WHERE tenant_id = ?
      ORDER BY name ASC
    `, tenantId);
    res.json(rows.map(skillRowToListEntry));
  } catch (err) {
    res.status((err as any)?.status ?? 500).json({ error: String((err as any)?.message ?? err) });
  }
});

// Explicit tenant-local import endpoint. It intentionally no longer scans the
// shared repository filesystem; callers must provide records to import for the
// resolved tenant.
router.post('/migrate-from-fs', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const requested = Array.isArray(req.body?.skills) ? req.body.skills : [];
    const imported: string[] = [];
    const skipped: string[] = [];
    const insert = db.prepare(`
      INSERT INTO skills (tenant_id, name, description, content, source)
      VALUES (?, ?, ?, ?, 'workspace')
      ON CONFLICT(tenant_id, name) DO NOTHING
    `);
    for (const item of requested) {
      const name = normalizeName(item?.name);
      if (!name) {
        skipped.push(String(item?.name ?? '<missing-name>'));
        continue;
      }
      const result = insert.run(tenantId, name, item?.description ?? '', item?.content ?? '');
      if (result.changes > 0) imported.push(name);
      else skipped.push(name);
    }
    res.json({ ok: true, imported, skipped, tenant_id: tenantId, source: 'request-body' });
  } catch (err) {
    res.status((err as any)?.status ?? 500).json({ error: String((err as any)?.message ?? err) });
  }
});

router.get('/:name', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const name = normalizeName(req.params.name);
    const skill = await db.get(`
      SELECT id, tenant_id, name, source, description, content, fs_path, created_at, updated_at
      FROM skills
      WHERE tenant_id = ? AND name = ?
      LIMIT 1
    `, tenantId, name) as any | undefined;
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    return res.json({ ...skill, files: [] });
  } catch (err) {
    return res.status((err as any)?.status ?? 500).json({ error: String((err as any)?.message ?? err) });
  }
});

router.get('/:name/file/*', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const name = normalizeName(req.params.name);
    const relativePath = (req.params as Record<string, string>)[0];
    if (!relativePath) return res.status(400).json({ error: 'File path required' });
    const skill = await db.get(`SELECT name FROM skills WHERE tenant_id = ? AND name = ? LIMIT 1`, tenantId, name);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    return res.status(404).json({ error: 'Tenant-owned skills are stored as database content; linked filesystem files are not exposed through this API' });
  } catch (err) {
    return res.status((err as any)?.status ?? 500).json({ error: String((err as any)?.message ?? err) });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const { description, content, source } = req.body as { name?: string; description?: string; content?: string; source?: string };
    const name = normalizeName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'name is required' });
    const sourceValue = source === 'system' || source === 'workspace' ? source : 'atlas';
    const result = await db.run(`
      INSERT INTO skills (tenant_id, name, description, content, source)
      VALUES (?, ?, ?, ?, ?)
    `, tenantId, name, description ?? '', content ?? `# ${name}\n\n${description ?? 'Describe this skill here.'}\n`, sourceValue);
    const created = await db.get(`SELECT * FROM skills WHERE id = ? AND tenant_id = ?`, result.lastInsertRowid, tenantId);
    return res.status(201).json({ ...(created as object), files: [] });
  } catch (err) {
    if (constraintIsTenantNameConflict(err)) return res.status(409).json({ error: 'A skill with this name already exists' });
    return res.status((err as any)?.status ?? 500).json({ error: String((err as any)?.message ?? err) });
  }
});

router.put('/:name', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const name = normalizeName(req.params.name);
    const existing = await db.get(`SELECT * FROM skills WHERE tenant_id = ? AND name = ? LIMIT 1`, tenantId, name) as any | undefined;
    if (!existing) return res.status(404).json({ error: 'Skill not found' });
    const { description, content, source } = req.body as { content?: string; description?: string; source?: string };
    if (content === undefined && description === undefined && source === undefined) return res.status(400).json({ error: 'No fields to update' });
    const sourceValue = source === 'system' || source === 'workspace' || source === 'atlas' ? source : existing.source;
    await db.run(`
      UPDATE skills
      SET description = ?, content = ?, source = ?, updated_at = datetime('now')
      WHERE tenant_id = ? AND name = ?
    `, description ?? existing.description, content ?? existing.content, sourceValue, tenantId, name);
    const updated = await db.get(`SELECT * FROM skills WHERE tenant_id = ? AND name = ?`, tenantId, name);
    return res.json({ ...(updated as object), files: [] });
  } catch (err) {
    return res.status((err as any)?.status ?? 500).json({ error: String((err as any)?.message ?? err) });
  }
});

router.delete('/:name', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const name = normalizeName(req.params.name);
    const result = await db.run(`DELETE FROM skills WHERE tenant_id = ? AND name = ?`, tenantId, name);
    if (result.changes === 0) return res.status(404).json({ error: 'Skill not found' });
    return res.json({ ok: true, name });
  } catch (err) {
    return res.status((err as any)?.status ?? 500).json({ error: String((err as any)?.message ?? err) });
  }
});

export default router;
