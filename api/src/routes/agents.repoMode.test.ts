import { type Db } from "../db/adapter/types";
import { setupTestDb, teardownTestDb } from '../db/testDb';

describe('agents repo source mode defaults', () => {
  let db: Db;

  beforeEach(async () => {
    jest.resetModules();
    db = await setupTestDb();
  });

  afterEach(async () => {
    await teardownTestDb();
    jest.clearAllMocks();
  });

  it('surfaces no repo mode when an agent has only workspace_path', async () => {
    await db.run(`
      INSERT INTO agents (
        name, role, session_key, workspace_path, repo_path, repo_url, repo_access_mode, status, runtime_type, runtime_config, project_id, preferred_provider, model, system_role
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, 'Clone Candidate', 'Backend Engineer', 'agent:test:main', '/tmp/agent-workspace', null, null, null, 'idle', 'openclaw', null, null, 'anthropic', null, null);

    const { parseAgentRuntimeConfig } = await import('./agents');
    const row = await db.get('SELECT * FROM agents WHERE name = ?', 'Clone Candidate') as Record<string, unknown>;
    const parsed = parseAgentRuntimeConfig(row);

    expect(parsed.workspace_path).toBe('/tmp/agent-workspace');
    expect(parsed.repo_path).toBeNull();
    expect(parsed.repo_url).toBeNull();
    expect(parsed.repo_access_mode).toBeNull();
  });

  it('preserves explicit clone mode metadata', async () => {
    await db.run(`
      INSERT INTO agents (
        name, role, session_key, workspace_path, repo_path, repo_url, repo_access_mode, status, runtime_type, runtime_config, project_id, preferred_provider, model, system_role
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, 'Clone Agent', 'Backend Engineer', 'agent:test:main', '/tmp/agent-workspace', null, 'https://example.com/repo.git', 'clone', 'idle', 'openclaw', null, null, 'anthropic', null, null);

    const { parseAgentRuntimeConfig } = await import('./agents');
    const row = await db.get('SELECT * FROM agents WHERE name = ?', 'Clone Agent') as Record<string, unknown>;
    const parsed = parseAgentRuntimeConfig(row);

    expect(parsed.repo_path).toBeNull();
    expect(parsed.repo_url).toBe('https://example.com/repo.git');
    expect(parsed.repo_access_mode).toBe('clone');
  });

  it('preserves worktree mode when repo_path exists', async () => {
    await db.run(`
      INSERT INTO agents (
        name, role, session_key, workspace_path, repo_path, repo_url, repo_access_mode, status, runtime_type, runtime_config, project_id, preferred_provider, model, system_role
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, 'Worktree Agent', 'Backend Engineer', 'agent:test:main', '/tmp/agent-workspace', '/tmp/canonical-repo', null, null, 'idle', 'openclaw', null, null, 'anthropic', null, null);

    const { parseAgentRuntimeConfig } = await import('./agents');
    const row = await db.get('SELECT * FROM agents WHERE name = ?', 'Worktree Agent') as Record<string, unknown>;
    const parsed = parseAgentRuntimeConfig(row);

    expect(parsed.repo_path).toBe('/tmp/canonical-repo');
    expect(parsed.repo_url).toBeNull();
    expect(parsed.repo_access_mode).toBe('worktree');
  });

  it('does not use project repo config as an effective agent repo source', async () => {
    const { parseAgentRuntimeConfig } = await import('./agents');
    const parsed = parseAgentRuntimeConfig({
      name: 'Project Repo Agent',
      runtime_type: 'openclaw',
      skill_names: '[]',
      sort_rules: '[]',
      repo_path: '/tmp/legacy-repo',
      repo_url: null,
      repo_access_mode: 'worktree',
      project_repo_path: null,
      project_repo_url: 'git@github.com:owner/project.git',
      project_repo_access_mode: 'clone',
    });

    expect(parsed.repo_path).toBe('/tmp/legacy-repo');
    expect(parsed.repo_url).toBeNull();
    expect(parsed.repo_access_mode).toBe('worktree');
    expect(parsed.repo_config_source).toBe('agent_legacy');
    expect(parsed.legacy_repo_path).toBe('/tmp/legacy-repo');
    expect(parsed.legacy_repo_access_mode).toBe('worktree');
  });
});
