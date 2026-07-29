import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getSkillMaterializationAdapter } from './skillMaterialization';
import { type Db } from "../db/adapter/types";
import { SqliteAdapter } from "../db/adapter/SqliteAdapter";

const TENANT_ID = 1;

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function makeSkillsDb(skillNames: string[]): Promise<Db> {
  const dbRaw = new Database(':memory:');
    const db = new SqliteAdapter(dbRaw);
  await db.exec(`
    CREATE TABLE skills (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   INTEGER NOT NULL,
      name        TEXT NOT NULL,
      fs_path     TEXT,
      content     TEXT,
      description TEXT,
      source      TEXT
    );
  `);
  const insert = dbRaw.prepare(`
    INSERT INTO skills (tenant_id, name, fs_path, content, description, source)
    VALUES (?, ?, NULL, NULL, '', 'system')
  `);
  for (const name of skillNames) insert.run(TENANT_ID, name);
  return db;
}

describe('Hermes skill materialization', () => {
  it('uses concrete Hermes profile artifacts instead of prompt injection', async () => {
    const workspaceDir = makeTempDir('hermes-workspace-');
    const hermesHome = makeTempDir('hermes-home-');
    const skillsBasePath = makeTempDir('hermes-skills-base-');
    const sourceSkillDir = path.join(skillsBasePath, 'create-tool');
    fs.mkdirSync(sourceSkillDir, { recursive: true });
    fs.writeFileSync(path.join(sourceSkillDir, 'SKILL.md'), '# create-tool\n', 'utf-8');
    fs.writeFileSync(path.join(hermesHome, '.skills_prompt_snapshot.json'), '{"stale":true}\n', 'utf-8');

    const adapter = getSkillMaterializationAdapter('hermes');
    const result = adapter.materialize({
      workingDirectory: workspaceDir,
      skillNames: ['create-tool'],
      skillsBasePath,
      db: await makeSkillsDb(['create-tool']),
      tenantId: TENANT_ID,
      runtimeConfig: { profile: 'agent-hq-hermes-test', hermesHome },
    });

    expect(result.ok).toBe(true);
    expect(adapter.adapterName).toBe('hermes');
    expect(fs.lstatSync(path.join(hermesHome, 'skills', 'create-tool')).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(hermesHome, 'skills', 'create-tool', 'SKILL.md'), 'utf-8')).toBe('# create-tool\n');
    expect(fs.readFileSync(path.join(hermesHome, '.agent-hq', 'SKILLS.md'), 'utf-8')).toContain('create-tool');
    expect(JSON.parse(fs.readFileSync(path.join(hermesHome, '.agent-hq', 'assigned-skills.json'), 'utf-8')).skills).toEqual(['create-tool']);
    expect(fs.existsSync(path.join(hermesHome, '.skills_prompt_snapshot.json'))).toBe(false);
  });

  it('reconciles removed Hermes skills on rematerialization', async () => {
    const workspaceDir = makeTempDir('hermes-remat-workspace-');
    const hermesHome = makeTempDir('hermes-remat-home-');
    const skillsBasePath = makeTempDir('hermes-remat-skills-base-');

    for (const skillName of ['create-tool', 'debug-tool']) {
      const sourceSkillDir = path.join(skillsBasePath, skillName);
      fs.mkdirSync(sourceSkillDir, { recursive: true });
      fs.writeFileSync(path.join(sourceSkillDir, 'SKILL.md'), `# ${skillName}\n`, 'utf-8');
    }
    const db = await makeSkillsDb(['create-tool', 'debug-tool']);

    const adapter = getSkillMaterializationAdapter('hermes');
    adapter.materialize({
      workingDirectory: workspaceDir,
      skillNames: ['create-tool', 'debug-tool'],
      skillsBasePath,
      db,
      tenantId: TENANT_ID,
      runtimeConfig: { profile: 'agent-hq-hermes-test', hermesHome },
    });

    const result = adapter.materialize({
      workingDirectory: workspaceDir,
      skillNames: ['debug-tool'],
      skillsBasePath,
      db,
      tenantId: TENANT_ID,
      runtimeConfig: { profile: 'agent-hq-hermes-test', hermesHome },
    });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(hermesHome, 'skills', 'create-tool'))).toBe(false);
    expect(fs.lstatSync(path.join(hermesHome, 'skills', 'debug-tool')).isDirectory()).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(hermesHome, '.agent-hq', 'assigned-skills.json'), 'utf-8')).skills).toEqual(['debug-tool']);
  });
});
