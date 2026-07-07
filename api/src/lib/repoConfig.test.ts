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

  it('prefers workflow config over legacy agent config', () => {
    expect(resolveRepoConfig({
      workflow: {
        repo_path: '/repos/workflow',
        repo_access_mode: 'worktree',
      },
      agent: {
        repo_path: '/repos/legacy-agent',
        repo_access_mode: 'worktree',
      },
    })).toEqual({
      repo_path: '/repos/workflow',
      repo_url: null,
      repo_access_mode: 'worktree',
      repo_config_source: 'workflow',
    });
  });

  it('does not use project-level repo config as a fallback', () => {
    expect(resolveRepoConfig({
      workflow: {
        repo_path: null,
        repo_url: null,
        repo_access_mode: null,
      },
      // @ts-expect-error project is intentionally unsupported for normal resolution.
      project: {
        repo_url: 'git@github.com:owner/project.git',
        repo_access_mode: 'clone',
      },
    })).toEqual({
      repo_path: null,
      repo_url: null,
      repo_access_mode: null,
      repo_config_source: null,
    });
  });

  it('falls back to legacy agent config when the workflow has no repo config', () => {
    expect(resolveRepoConfig({
      workflow: {
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
