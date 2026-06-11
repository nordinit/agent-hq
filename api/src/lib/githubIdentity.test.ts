import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { injectGitHubCredentials, type GitHubIdentity } from './githubIdentity';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as string;
}

const identity: GitHubIdentity = {
  id: 11,
  tenant_id: 1,
  github_username: 'cinder-agent',
  token: 'gho_testtoken',
  git_author_name: 'Cinder',
  git_author_email: 'cinder@agenthq',
  lane: 'dev',
  enabled: 1,
};

describe('GitHub identity injection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-gh-identity-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes credential files and configures worktree-local git author identity', () => {
    git(['init'], tempDir);

    expect(injectGitHubCredentials(tempDir, identity)).toBe(true);

    expect(fs.readFileSync(path.join(tempDir, '.atlas-gh-token'), 'utf-8')).toBe(identity.token);
    expect(fs.readFileSync(path.join(tempDir, '.atlas-gh-identity.env'), 'utf-8')).toContain('GIT_AUTHOR_NAME="Cinder"');
    expect(git(['config', '--worktree', 'user.name'], tempDir).trim()).toBe('Cinder');
    expect(git(['config', '--worktree', 'user.email'], tempDir).trim()).toBe('cinder@agenthq');
  });

  it('keeps git author config isolated across linked task worktrees', () => {
    const repoDir = path.join(tempDir, 'repo');
    const cinderWorktree = path.join(tempDir, 'task-cinder');
    const prismWorktree = path.join(tempDir, 'task-prism');
    fs.mkdirSync(repoDir);
    git(['init'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'test\n');
    git(['add', 'README.md'], repoDir);
    git(['-c', 'user.name=Bootstrap', '-c', 'user.email=bootstrap@example.com', 'commit', '-m', 'init'], repoDir);
    git(['worktree', 'add', '-b', 'task-cinder', cinderWorktree], repoDir);
    git(['worktree', 'add', '-b', 'task-prism', prismWorktree], repoDir);

    const prismIdentity: GitHubIdentity = {
      ...identity,
      id: 12,
      github_username: 'prism-agent',
      git_author_name: 'Prism',
      git_author_email: 'prism@agenthq',
    };

    expect(injectGitHubCredentials(cinderWorktree, identity)).toBe(true);
    expect(injectGitHubCredentials(prismWorktree, prismIdentity)).toBe(true);

    expect(git(['config', '--worktree', 'user.name'], cinderWorktree).trim()).toBe('Cinder');
    expect(git(['config', '--worktree', 'user.email'], cinderWorktree).trim()).toBe('cinder@agenthq');
    expect(git(['config', '--worktree', 'user.name'], prismWorktree).trim()).toBe('Prism');
    expect(git(['config', '--worktree', 'user.email'], prismWorktree).trim()).toBe('prism@agenthq');
  });

  it('still writes credential files when the target is not a git worktree', () => {
    expect(injectGitHubCredentials(tempDir, identity)).toBe(true);

    expect(fs.existsSync(path.join(tempDir, '.atlas-gh-token'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, '.atlas-gh-identity.env'))).toBe(true);
  });
});
