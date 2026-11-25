import fs from 'fs';
import os from 'os';
import path from 'path';

import { type Db } from '../db/adapter/types';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { resolveClaudeCodeSkillPluginDir } from './claudeCode/skillPlugin';
import {
  claudeCodeSkillPluginDir,
  claudeCodeSkillPluginManifestPath,
  getSkillMaterializationAdapter,
} from './skillMaterialization';

const SKILL = '---\nname: proposal-rules\ndescription: Rules for proposals\n---\n\n# Proposal rules\n';

describe('Claude Code skill materialization', () => {
  let workspaces: string[] = [];
  let db: Db;

  function workspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-claude-skills-'));
    workspaces.push(dir);
    return dir;
  }

  beforeEach(async () => {
    db = await setupTestDb();
    await db.run(`INSERT INTO tenants (id, name, slug) VALUES (1, 'Claude Skill Tests', 'claude-skill-tests')`);
    await db.run(
      `INSERT INTO skills (tenant_id, name, description, content, source) VALUES (1, 'proposal-rules', 'Rules for proposals', ?, 'atlas')`,
      SKILL,
    );
  });

  afterEach(async () => {
    for (const dir of workspaces) fs.rmSync(dir, { recursive: true, force: true });
    workspaces = [];
    await teardownTestDb();
  });

  it('projects assigned skills into the session-only agent-hq plugin', async () => {
    const ws = workspace();
    const result = await getSkillMaterializationAdapter('claude-code').materialize({
      workingDirectory: ws,
      skillNames: ['proposal-rules'],
      db,
      tenantId: 1,
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(claudeCodeSkillPluginManifestPath(ws), 'utf8'))).toEqual(
      expect.objectContaining({ name: 'agent-hq' }),
    );
    const skillFile = path.join(claudeCodeSkillPluginDir(ws), 'skills', 'proposal-rules', 'SKILL.md');
    expect(fs.readFileSync(skillFile, 'utf8')).toBe(SKILL);
    expect(resolveClaudeCodeSkillPluginDir(ws, ['proposal-rules'])).toBe(claudeCodeSkillPluginDir(ws));
    // Claude Code runs never read these, so nothing is written there any more.
    expect(fs.existsSync(path.join(ws, '.claude', 'skills'))).toBe(false);
    expect(fs.existsSync(path.join(ws, 'CLAUDE.md'))).toBe(false);
  });

  it('removes the old .claude/skills links and CLAUDE.md section, keeping other content', async () => {
    const ws = workspace();
    const legacy = path.join(ws, '.claude', 'skills');
    fs.mkdirSync(legacy, { recursive: true });
    fs.symlinkSync(os.tmpdir(), path.join(legacy, 'proposal-rules'));
    fs.mkdirSync(path.join(legacy, 'hand-written'));
    fs.writeFileSync(
      path.join(ws, 'CLAUDE.md'),
      '# Notes\n\nKeep me.\n\n<!-- atlas-skills-start -->\n## Available Skills\n- x\n<!-- atlas-skills-end -->\n\n## After\nKeep me too.\n',
    );

    const result = await getSkillMaterializationAdapter('claude-code').materialize({
      workingDirectory: ws,
      skillNames: ['proposal-rules'],
      db,
      tenantId: 1,
    });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(legacy, 'proposal-rules'))).toBe(false);
    expect(fs.statSync(path.join(legacy, 'hand-written')).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8')).toBe('# Notes\n\nKeep me.\n\n## After\nKeep me too.\n');
  });

  it('deletes a CLAUDE.md that held only the generated skill section', async () => {
    const ws = workspace();
    fs.writeFileSync(
      path.join(ws, 'CLAUDE.md'),
      '<!-- atlas-skills-start -->\n## Available Skills\n<!-- atlas-skills-end -->\n',
    );
    await getSkillMaterializationAdapter('claude-code').materialize({
      workingDirectory: ws,
      skillNames: [],
      db,
      tenantId: 1,
    });
    expect(fs.existsSync(path.join(ws, 'CLAUDE.md'))).toBe(false);
  });

  it('drops a skill from the plugin once it is unassigned', async () => {
    const ws = workspace();
    const adapter = getSkillMaterializationAdapter('claude-code');
    await adapter.materialize({ workingDirectory: ws, skillNames: ['proposal-rules'], db, tenantId: 1 });
    await adapter.materialize({ workingDirectory: ws, skillNames: [], db, tenantId: 1 });
    expect(fs.existsSync(path.join(claudeCodeSkillPluginDir(ws), 'skills', 'proposal-rules'))).toBe(false);
    expect(resolveClaudeCodeSkillPluginDir(ws, [])).toBeNull();
  });

  it('refuses to launch with an assigned skill the plugin does not hold', async () => {
    const ws = workspace();
    await getSkillMaterializationAdapter('claude-code').materialize({
      workingDirectory: ws,
      skillNames: ['proposal-rules'],
      db,
      tenantId: 1,
    });
    expect(() => resolveClaudeCodeSkillPluginDir(ws, ['proposal-rules', 'missing-skill'])).toThrow(/missing-skill/);
    expect(() => resolveClaudeCodeSkillPluginDir(workspace(), ['proposal-rules'])).toThrow(/manifest/);
  });
});
