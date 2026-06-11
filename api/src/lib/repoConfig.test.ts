import { normalizeRepoConfig, resolveRepoConfig, validateRepoConfig } from './repoConfig';

describe('repoConfig', () => {
  it('normalizes worktree config and clears clone fields', () => {
    expect(normalizeRepoConfig({
      repo_path: '  /repos/agent-hq  ',
      repo_url: 'git@github.com:owner/ignored.git',
      repo_access_mode: 'worktree',
    })).toEqual({
      repo_path: '/repos/agent-hq',
      repo_url: null,
      repo_access_mode: 'worktree',
    });
  });

  it('prefers project config over legacy agent config', () => {
    expect(resolveRepoConfig({
      project: {
        repo_url: 'git@github.com:owner/project.git',
        repo_access_mode: 'clone',
      },
      agent: {
        repo_path: '/repos/legacy-agent',
        repo_access_mode: 'worktree',
      },
    })).toEqual({
      repo_path: null,
      repo_url: 'git@github.com:owner/project.git',
      repo_access_mode: 'clone',
      repo_config_source: 'project',
    });
  });

  it('falls back to legacy agent config when the project has no repo config', () => {
    expect(resolveRepoConfig({
      project: {
        repo_path: null,
        repo_url: null,
        repo_access_mode: null,
      },
      agent: {
        repo_path: '/repos/legacy-agent',
        repo_access_mode: 'worktree',
      },
    })).toEqual({
      repo_path: '/repos/legacy-agent',
      repo_url: null,
      repo_access_mode: 'worktree',
      repo_config_source: 'agent_legacy',
    });
  });

  it('validates required source fields for each mode', () => {
    expect(validateRepoConfig({ repo_access_mode: 'worktree', repo_path: null })).toBe('repo_access_mode=worktree requires repo_path');
    expect(validateRepoConfig({ repo_access_mode: 'clone', repo_url: null })).toBe('repo_access_mode=clone requires repo_url');
    expect(validateRepoConfig({ repo_access_mode: 'clone', repo_url: 'git@github.com:owner/project.git' })).toBeNull();
  });
});
