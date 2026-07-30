import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { OpenClawSkillAdapter } from './skillMaterialization';
import { type Db } from "../db/adapter/types";
import { SqliteAdapter } from "../db/adapter/SqliteAdapter";

async function createDb(): Promise<Db> {
  const dbRaw = new Database(':memory:');
    const db = new SqliteAdapter(dbRaw);
  await db.exec(`
    CREATE TABLE skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'atlas' CHECK(source IN ('atlas','workspace','system')),
      fs_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, name)
    );
  `);
  return db;
}

function makeTempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-hq-${label}-`));
}

describe('OpenClawSkillAdapter tenant-owned skill resolution', () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
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
    await db.close();
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
    await db.close();
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
    await db.close();
  });
});
