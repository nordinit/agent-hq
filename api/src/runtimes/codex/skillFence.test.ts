import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildCodexSkillFence } from './skillFence';

function writeSkill(dir: string, name: string): string {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  const file = path.join(dir, name, 'SKILL.md');
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${name}\n---\n`);
  return file;
}

describe('buildCodexSkillFence', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-codex-fence-')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('disables every SKILL.md Codex would list except the assigned ones', () => {
    const repo = path.join(root, 'repo');
    const cwd = path.join(repo, 'packages', 'app');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    const home = path.join(root, 'home');
    const codexHome = path.join(root, 'codex-home');

    const assigned = writeSkill(path.join(cwd, '.agents', 'skills'), 'proposal-rules');
    writeSkill(path.join(cwd, '.agents', 'skills', 'proposal-rules'), 'nested-inside-assigned');
    const repoOwned = writeSkill(path.join(cwd, '.agents', 'skills'), 'repo-owned');
    const legacy = writeSkill(path.join(cwd, '.codex', 'skills'), 'legacy');
    const repoRoot = writeSkill(path.join(repo, '.agents', 'skills'), 'repo-root');
    const hostWide = writeSkill(path.join(home, '.agents', 'skills', 'synced', 'bundle'), 'pdf');
    const credentialHome = writeSkill(path.join(codexHome, 'skills'), 'user-skill');
    const admin = writeSkill(path.join(root, 'etc-skills'), 'admin-skill');
    // Above the git root: Codex does not look here.
    writeSkill(path.join(root, '.agents', 'skills'), 'outside-repo');

    const fence = buildCodexSkillFence({
      cwd,
      codexHome,
      homeDir: home,
      assignedSkillNames: ['proposal-rules'],
      systemSkillsDir: path.join(root, 'etc-skills'),
    });

    expect(fence.complete).toBe(true);
    expect(fence.disabledSkillPaths).toEqual(
      [repoOwned, legacy, repoRoot, hostWide, credentialHome, admin].sort(),
    );
    expect(fence.disabledSkillPaths).not.toContain(assigned);
  });

  it('walks only cwd outside a repository and follows symlinked skill folders', () => {
    const cwd = path.join(root, 'workspace');
    const source = path.join(root, 'elsewhere');
    const linked = writeSkill(source, 'linked');
    fs.mkdirSync(path.join(cwd, '.agents', 'skills'), { recursive: true });
    fs.symlinkSync(path.join(source, 'linked'), path.join(cwd, '.agents', 'skills', 'linked'));
    writeSkill(path.join(root, '.agents', 'skills'), 'parent');

    const fence = buildCodexSkillFence({
      cwd,
      codexHome: path.join(root, 'codex-home'),
      homeDir: path.join(root, 'home'),
      assignedSkillNames: [],
      systemSkillsDir: null,
    });

    expect(fence.disabledSkillPaths).toEqual(
      [path.join(cwd, '.agents', 'skills', 'linked', 'SKILL.md'), linked].sort(),
    );
  });
});
