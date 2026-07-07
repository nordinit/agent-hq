export type RepoAccessMode = 'worktree' | 'clone';
export type RepoConfigSource = 'workflow' | 'agent_legacy' | null;

export interface RepoConfigRecord {
  repo_path?: unknown;
  repo_url?: unknown;
  repo_access_mode?: unknown;
}

export interface ResolvedRepoConfig {
  repo_path: string | null;
  repo_url: string | null;
  repo_access_mode: RepoAccessMode | null;
  repo_config_source: RepoConfigSource;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeMode(value: unknown): RepoAccessMode | null {
  return value === 'worktree' || value === 'clone' ? value : null;
}

export function normalizeRepoConfig(record: RepoConfigRecord | null | undefined): Omit<ResolvedRepoConfig, 'repo_config_source'> {
  const repoPath = normalizeString(record?.repo_path);
  const repoUrl = normalizeString(record?.repo_url);
  const explicitMode = normalizeMode(record?.repo_access_mode);

  const inferredMode: RepoAccessMode | null = explicitMode
    ?? (repoPath ? 'worktree' : null)
    ?? (repoUrl ? 'clone' : null);

  if (inferredMode === 'worktree') {
    return {
      repo_path: repoPath,
      repo_url: null,
      repo_access_mode: repoPath ? 'worktree' : null,
    };
  }

  if (inferredMode === 'clone') {
    return {
      repo_path: null,
      repo_url: repoUrl,
      repo_access_mode: repoUrl ? 'clone' : null,
    };
  }

  return {
    repo_path: null,
    repo_url: null,
    repo_access_mode: null,
  };
}

export function validateRepoConfig(config: RepoConfigRecord | null | undefined): string | null {
  const repoPath = normalizeString(config?.repo_path);
  const repoUrl = normalizeString(config?.repo_url);
  const explicitMode = normalizeMode(config?.repo_access_mode);
  const normalized = normalizeRepoConfig(config);

  if (explicitMode === 'worktree' && !repoPath) {
    return 'repo_access_mode=worktree requires repo_path';
  }
  if (explicitMode === 'clone' && !repoUrl) {
    return 'repo_access_mode=clone requires repo_url';
  }
  if (normalized.repo_access_mode === 'worktree' && !normalized.repo_path) {
    return 'repo_access_mode=worktree requires repo_path';
  }
  if (normalized.repo_access_mode === 'clone' && !normalized.repo_url) {
    return 'repo_access_mode=clone requires repo_url';
  }
  return null;
}

export function hasRepoConfig(config: RepoConfigRecord | null | undefined): boolean {
  const normalized = normalizeRepoConfig(config);
  return Boolean(normalized.repo_access_mode);
}

export function resolveRepoConfig(params: {
  workflow?: RepoConfigRecord | null;
  agent?: RepoConfigRecord | null;
}): ResolvedRepoConfig {
  const workflowConfig = normalizeRepoConfig(params.workflow);
  if (workflowConfig.repo_access_mode) {
    return { ...workflowConfig, repo_config_source: 'workflow' };
  }

  const agentConfig = normalizeRepoConfig(params.agent);
  if (agentConfig.repo_access_mode) {
    return { ...agentConfig, repo_config_source: 'agent_legacy' };
  }

  return {
    repo_path: null,
    repo_url: null,
    repo_access_mode: null,
    repo_config_source: null,
  };
}
