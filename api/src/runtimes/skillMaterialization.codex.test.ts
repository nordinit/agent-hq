import fs from 'fs';
import os from 'os';
import path from 'path';

import { type Db } from '../db/adapter/types';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { getSkillMaterializationAdapter } from './skillMaterialization';

describe('Codex skill materialization', () => {
  let workspaces: string[] = [];
  let db: Db;

  beforeEach(async () => {
    db = await setupTestDb();
    await db.run(`
      INSERT INTO tenants (id, name, slug)
      VALUES (1, 'Codex Skill Tests', 'codex-skill-tests')
    `);
  });

  afterEach(async () => {
    for (const workspace of workspaces) {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
    workspaces = [];
    await teardownTestDb();
  });

  it('projects complete DB skill packages into the repository discovery path', async () => {
    const inserted = await db.run(`
      INSERT INTO skills (tenant_id, name, description, content, source)
      VALUES (1, 'runtime-check', 'Check a runtime', '---\nname: runtime-check\ndescription: Check a runtime\n---\n\n# Runtime check\n', 'atlas')
    `);
    await db.run(
      `INSERT INTO skill_files (tenant_id, skill_id, path, content) VALUES (1, ?, 'references/checklist.md', '# Checklist\n')`,
      inserted.lastInsertId,
    );

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-codex-skills-'));
    workspaces.push(workspace);
    const adapter = getSkillMaterializationAdapter('codex');
    const result = await adapter.materialize({
      workingDirectory: workspace,
      skillNames: ['runtime-check'],
      db,
      tenantId: 1,
    });

    const skillRoot = path.join(workspace, '.agents', 'skills', 'runtime-check');
    expect(adapter.adapterName).toBe('codex');
    expect(result.ok).toBe(true);
    expect(fs.lstatSync(skillRoot).isDirectory()).toBe(true);
    expect(fs.lstatSync(skillRoot).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8')).toContain('# Runtime check');
    expect(fs.readFileSync(path.join(skillRoot, 'references', 'checklist.md'), 'utf8')).toBe('# Checklist\n');
  });

  it('removes only previously managed Codex skills during reconciliation', async () => {
    await db.run(`INSERT INTO skills (tenant_id, name, content, source) VALUES (1, 'old-skill', '# Old', 'atlas')`);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-codex-skills-reconcile-'));
    workspaces.push(workspace);
    const skillsRoot = path.join(workspace, '.agents', 'skills');
    const adapter = getSkillMaterializationAdapter('codex');

    await adapter.materialize({ workingDirectory: workspace, skillNames: ['old-skill'], db, tenantId: 1 });
    fs.mkdirSync(path.join(skillsRoot, 'repo-owned-skill'), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, 'repo-owned-skill', 'SKILL.md'), '# Repo owned\n', 'utf8');

    const result = await adapter.materialize({ workingDirectory: workspace, skillNames: [], db, tenantId: 1 });

    expect(result.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ skill: 'old-skill', action: 'removed' }),
    ]));
    expect(fs.existsSync(path.join(skillsRoot, 'old-skill'))).toBe(false);
    expect(fs.existsSync(path.join(skillsRoot, 'repo-owned-skill', 'SKILL.md'))).toBe(true);
  });
});
