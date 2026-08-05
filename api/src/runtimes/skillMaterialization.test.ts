import fs from 'fs';
import os from 'os';
import path from 'path';
import { OpenClawSkillAdapter } from './skillMaterialization';
import { type Db } from "../db/adapter/types";
import { setupTestDb, teardownTestDb } from '../db/testDb';

async function createDb(): Promise<Db> {
  const db = await setupTestDb();
  await db.run(`
    INSERT INTO tenants (id, name, slug, is_default)
    VALUES (1, 'Tenant A', 'tenant-a', 1), (2, 'Tenant B', 'tenant-b', 0)
  `);
  return db;
}

function makeTempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-hq-${label}-`));
}

describe('OpenClawSkillAdapter tenant-owned skill resolution', () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
    await teardownTestDb();
  });

  it('does not fall back to global/system filesystem skills without an explicit tenant DB row', async () => {
    const db = await createDb();
    const workspace = makeTempDir('skill-workspace');
    const globalSkills = makeTempDir('global-skills');
    tempDirs.push(workspace, globalSkills);

    fs.mkdirSync(path.join(globalSkills, 'shared-skill'), { recursive: true });
    fs.writeFileSync(path.join(globalSkills, 'shared-skill', 'SKILL.md'), '# Global leak\n', 'utf-8');

    const adapter = new OpenClawSkillAdapter();
    const result = adapter.materialize({
      workingDirectory: workspace,
      skillNames: ['shared-skill'],
      skillsBasePath: globalSkills,
      db,
      tenantId: 1,
    });

    expect((await result).count).toBe(0);
    expect((await result).details).toEqual([{ skill: 'shared-skill', action: 'skipped', reason: 'source not found' }]);
    expect(fs.existsSync(path.join(workspace, 'skills', 'shared-skill'))).toBe(false);
  });

  it('materializes the tenant-local DB skill when tenants reuse the same name', async () => {
    const db = await createDb();
    await db.run(`INSERT INTO skills (tenant_id, name, description, content) VALUES (1, 'shared-skill', 'Tenant A', '# Tenant A skill')`);
    await db.run(`INSERT INTO skills (tenant_id, name, description, content) VALUES (2, 'shared-skill', 'Tenant B', '# Tenant B skill')`);

    const workspaceA = makeTempDir('tenant-a-workspace');
    const workspaceB = makeTempDir('tenant-b-workspace');
    tempDirs.push(workspaceA, workspaceB);

    const adapter = new OpenClawSkillAdapter();
    const resultA = adapter.materialize({ workingDirectory: workspaceA, skillNames: ['shared-skill'], db, tenantId: 1 });
    const resultB = adapter.materialize({ workingDirectory: workspaceB, skillNames: ['shared-skill'], db, tenantId: 2 });

    expect((await resultA).count).toBe(1);
    expect((await resultB).count).toBe(1);
    expect(fs.readFileSync(path.join(workspaceA, 'skills', 'shared-skill', 'SKILL.md'), 'utf-8')).toBe('# Tenant A skill\n');
    expect(fs.readFileSync(path.join(workspaceB, 'skills', 'shared-skill', 'SKILL.md'), 'utf-8')).toBe('# Tenant B skill\n');
  });

  it('materializes supplemental database-backed package files without a filesystem path', async () => {
    const db = await createDb();
    const skill = await db.run(`
      INSERT INTO skills (tenant_id, name, description, content)
      VALUES (1, 'packaged-skill', 'Packaged', '---\nname: packaged-skill\n---\n\n# Packaged skill\n')
    `);
    await db.run(`
      INSERT INTO skill_files (tenant_id, skill_id, path, content)
      VALUES (1, ?, 'references/guide.md', '# Guide\n')
    `, skill.lastInsertId);

    const workspace = makeTempDir('packaged-skill-workspace');
    tempDirs.push(workspace);

    const result = await new OpenClawSkillAdapter().materialize({
      workingDirectory: workspace,
      skillNames: ['packaged-skill'],
      db,
      tenantId: 1,
    });

    expect(result.count).toBe(1);
    expect(fs.readFileSync(path.join(workspace, 'skills', 'packaged-skill', 'SKILL.md'), 'utf-8'))
      .toBe('---\nname: packaged-skill\n---\n\n# Packaged skill\n');
    expect(fs.readFileSync(path.join(workspace, 'skills', 'packaged-skill', 'references', 'guide.md'), 'utf-8'))
      .toBe('# Guide\n');
  });

  it('uses system skill directories only when the tenant has an explicit system skill row', async () => {
    const db = await createDb();
    await db.run(`INSERT INTO skills (tenant_id, name, description, source) VALUES (2, 'system-skill', 'Tenant B explicit system skill', 'system')`);

    const workspaceA = makeTempDir('system-a-workspace');
    const workspaceB = makeTempDir('system-b-workspace');
    const globalSkills = makeTempDir('explicit-system-skills');
    tempDirs.push(workspaceA, workspaceB, globalSkills);

    fs.mkdirSync(path.join(globalSkills, 'system-skill'), { recursive: true });
    fs.writeFileSync(path.join(globalSkills, 'system-skill', 'SKILL.md'), '# System skill\n', 'utf-8');

    const adapter = new OpenClawSkillAdapter();
    const resultA = adapter.materialize({ workingDirectory: workspaceA, skillNames: ['system-skill'], skillsBasePath: globalSkills, db, tenantId: 1 });
    const resultB = adapter.materialize({ workingDirectory: workspaceB, skillNames: ['system-skill'], skillsBasePath: globalSkills, db, tenantId: 2 });

    expect((await resultA).count).toBe(0);
    expect(fs.existsSync(path.join(workspaceA, 'skills', 'system-skill'))).toBe(false);
    expect((await resultB).count).toBe(1);
    expect(fs.readFileSync(path.join(workspaceB, 'skills', 'system-skill', 'SKILL.md'), 'utf-8')).toBe('# System skill\n');
  });
});
