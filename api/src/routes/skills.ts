import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import type { Db } from '../db/adapter/types';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';
import { normalizeSkillPackagePath, parseSkillPackageFiles, type SkillPackageFile } from '../lib/skillPackage';
import { isPostgresUniqueViolation } from '../lib/postgresErrors';

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

function skillRowToListEntry(row: any, files: string[] = []): SkillListEntry {
  return {
    id: Number(row.id),
    tenant_id: Number(row.tenant_id),
    name: String(row.name),
    source: row.source,
    description: row.description ?? '',
    files: ['SKILL.md', ...files],
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

async function skillFilesBySkillId(db: Db, tenantId: number): Promise<Map<number, string[]>> {
  const rows = await db.all<{ skill_id: number; path: string }>(`
    SELECT skill_id, path
    FROM skill_files
    WHERE tenant_id = ?
    ORDER BY path ASC
  `, tenantId);
  const bySkill = new Map<number, string[]>();
  for (const row of rows) {
    const skillId = Number(row.skill_id);
    const paths = bySkill.get(skillId) ?? [];
    paths.push(String(row.path));
    bySkill.set(skillId, paths);
  }
  return bySkill;
}

async function upsertSkillFiles(
  db: Db,
  tenantId: number,
  skillId: number,
  files: SkillPackageFile[],
): Promise<void> {
  for (const file of files) {
    await db.run(`
      INSERT INTO skill_files (tenant_id, skill_id, path, content)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (tenant_id, skill_id, path) DO UPDATE SET
        content = excluded.content,
        updated_at = excluded.updated_at
    `, tenantId, skillId, file.path, file.content);
  }
}

function normalizeName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function constraintIsTenantNameConflict(err: unknown): boolean {
  return isPostgresUniqueViolation(err);
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
    const filesBySkill = await skillFilesBySkillId(db, tenantId);
    res.json(rows.map((row: any) => skillRowToListEntry(row, filesBySkill.get(Number(row.id)) ?? [])));
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
    const insertSql = `
      INSERT INTO skills (tenant_id, name, description, content, source)
      VALUES (?, ?, ?, ?, 'workspace')
      ON CONFLICT(tenant_id, name) DO NOTHING
    `;
    for (const item of requested) {
      const name = normalizeName(item?.name);
      if (!name) {
        skipped.push(String(item?.name ?? '<missing-name>'));
        continue;
      }
      let files: SkillPackageFile[];
      try {
        files = parseSkillPackageFiles(item?.files);
      } catch (error) {
        return res.status(400).json({ error: String((error as Error).message ?? error), skill: name });
      }
      const result = await db.run(insertSql, tenantId, name, item?.description ?? '', item?.content ?? '');
      if (result.changes > 0) {
        imported.push(name);
        if (result.lastInsertId === null) throw new Error(`Could not resolve the new skill id for ${name}`);
        await upsertSkillFiles(db, tenantId, result.lastInsertId, files);
      } else {
        skipped.push(name);
      }
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
    const filesBySkill = await skillFilesBySkillId(db, tenantId);
    return res.json({ ...skill, files: ['SKILL.md', ...(filesBySkill.get(Number(skill.id)) ?? [])] });
  } catch (err) {
    return res.status((err as any)?.status ?? 500).json({ error: String((err as any)?.message ?? err) });
  }
});

router.get('/:name/file/*', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const name = normalizeName(req.params.name);
    const relativePath = normalizeSkillPackagePath((req.params as Record<string, string>)[0]);
    if (!relativePath) return res.status(400).json({ error: 'A safe relative file path is required' });
    const skill = await db.get<{ id: number; name: string; content: string }>(`
      SELECT id, name, content FROM skills WHERE tenant_id = ? AND name = ? LIMIT 1
    `, tenantId, name);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    if (relativePath === 'SKILL.md') {
      return res.json({ name, file: relativePath, content: skill.content, path: `db://skills/${name}/SKILL.md` });
    }
    const file = await db.get<{ content: string }>(`
      SELECT content
      FROM skill_files
      WHERE tenant_id = ? AND skill_id = ? AND path = ?
      LIMIT 1
    `, tenantId, skill.id, relativePath);
    if (!file) return res.status(404).json({ error: 'Skill package file not found' });
    return res.json({ name, file: relativePath, content: file.content, path: `db://skills/${name}/${relativePath}` });
  } catch (err) {
    return res.status((err as any)?.status ?? 500).json({ error: String((err as any)?.message ?? err) });
  }
});

router.put('/:name/file/*', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const name = normalizeName(req.params.name);
    const relativePath = normalizeSkillPackagePath((req.params as Record<string, string>)[0]);
    if (!relativePath) return res.status(400).json({ error: 'A safe relative file path is required' });
    if (relativePath === 'SKILL.md') return res.status(400).json({ error: 'Update SKILL.md through the skill content endpoint' });
    if (typeof req.body?.content !== 'string') return res.status(400).json({ error: 'content must be a string' });

    const skill = await db.get<{ id: number }>(`
      SELECT id FROM skills WHERE tenant_id = ? AND name = ? LIMIT 1
    `, tenantId, name);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    await upsertSkillFiles(db, tenantId, Number(skill.id), [{ path: relativePath, content: req.body.content }]);
    return res.json({ ok: true, name, file: relativePath });
  } catch (err) {
    return res.status((err as any)?.status ?? 500).json({ error: String((err as any)?.message ?? err) });
  }
});

router.delete('/:name/file/*', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const name = normalizeName(req.params.name);
    const relativePath = normalizeSkillPackagePath((req.params as Record<string, string>)[0]);
    if (!relativePath || relativePath === 'SKILL.md') return res.status(400).json({ error: 'A supplemental skill file path is required' });
    const result = await db.run(`
      DELETE FROM skill_files
      WHERE tenant_id = ?
        AND path = ?
        AND skill_id = (SELECT id FROM skills WHERE tenant_id = ? AND name = ? LIMIT 1)
    `, tenantId, relativePath, tenantId, name);
    if (result.changes === 0) return res.status(404).json({ error: 'Skill package file not found' });
    return res.json({ ok: true, name, file: relativePath });
  } catch (err) {
    return res.status((err as any)?.status ?? 500).json({ error: String((err as any)?.message ?? err) });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const { description, content, source } = req.body as { name?: string; description?: string; content?: string; source?: string; files?: unknown };
    const name = normalizeName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'name is required' });
    const sourceValue = source === 'system' || source === 'workspace' ? source : 'atlas';
    let files: SkillPackageFile[];
    try {
      files = parseSkillPackageFiles(req.body?.files);
    } catch (error) {
      return res.status(400).json({ error: String((error as Error).message ?? error) });
    }
    const created = await db.withTransaction(async (tx) => {
      const result = await tx.run(`
        INSERT INTO skills (tenant_id, name, description, content, source)
        VALUES (?, ?, ?, ?, ?)
      `, tenantId, name, description ?? '', content ?? `# ${name}\n\n${description ?? 'Describe this skill here.'}\n`, sourceValue);
      if (result.lastInsertId === null) throw new Error(`Could not resolve the new skill id for ${name}`);
      await upsertSkillFiles(tx, tenantId, result.lastInsertId, files);
      return await tx.get(`SELECT * FROM skills WHERE id = ? AND tenant_id = ?`, result.lastInsertId, tenantId);
    });
    return res.status(201).json({ ...(created as object), files: ['SKILL.md', ...files.map((file) => file.path).sort()] });
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
      SET description = ?, content = ?, source = ?, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
      WHERE tenant_id = ? AND name = ?
    `, description ?? existing.description, content ?? existing.content, sourceValue, tenantId, name);
    const updated = await db.get(`SELECT * FROM skills WHERE tenant_id = ? AND name = ?`, tenantId, name);
    const filesBySkill = await skillFilesBySkillId(db, tenantId);
    return res.json({ ...(updated as object), files: ['SKILL.md', ...(filesBySkill.get(Number(existing.id)) ?? [])] });
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
