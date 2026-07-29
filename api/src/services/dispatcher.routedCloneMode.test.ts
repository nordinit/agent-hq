import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { type Db } from "../db/adapter/types";
import { SqliteAdapter } from "../db/adapter/SqliteAdapter";

jest.mock('../runtimes', () => ({
  resolveRuntime: jest.fn(() => ({
    prepareAuthProfiles: jest.fn().mockResolvedValue({
      ok: true,
      status: 'skipped',
      providersSynced: [],
      runtimeAuthProvidersSynced: [],
      openclawAuthProvidersSynced: [],
    }),
    dispatch: jest.fn(async () => ({ runId: 'run-test' })),
    abort: jest.fn(async () => undefined),
  })),
}));

jest.mock('../runtimes/skillMaterialization', () => ({
  getSkillMaterializationAdapter: jest.fn(() => ({
    adapterName: 'test',
    materialize: jest.fn(() => ({ ok: true, count: 0, warnings: [] })),
  })),
}));

jest.mock('../runtimes/mcpMaterialization', () => ({
  syncAssignedMcpForAgent: jest.fn(() => ({ ok: true, count: 0, warnings: [] })),
}));

jest.mock('../lib/githubIdentity', () => ({
  resolveGitHubIdentity: jest.fn(() => null),
  injectGitHubCredentials: jest.fn(),
  cleanupGitHubCredentials: jest.fn(),
  buildGitHubIdentityContext: jest.fn(() => ''),
}));

const { resolveRuntime } = jest.requireMock('../runtimes') as { resolveRuntime: jest.Mock };
const { syncAssignedMcpForAgent } = jest.requireMock('../runtimes/mcpMaterialization') as { syncAssignedMcpForAgent: jest.Mock };

describe('dispatchTaskToJob preserves clone repo mode', () => {
  let db: Db;
  let tempRoot: string;
  let remotePath: string;
  let seedPath: string;
  let workspaceRoot: string;
  let runtimeDispatch: jest.Mock;

  beforeEach(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-dispatcher-clone-'));
    remotePath = path.join(tempRoot, 'remote.git');
    seedPath = path.join(tempRoot, 'seed');
    workspaceRoot = path.join(tempRoot, 'workspace');

    fs.mkdirSync(seedPath, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: seedPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: seedPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: seedPath, stdio: 'ignore' });
    fs.writeFileSync(path.join(seedPath, 'README.md'), '# seed\n');
    execFileSync('git', ['add', 'README.md'], { cwd: seedPath, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'seed'], { cwd: seedPath, stdio: 'ignore' });
    execFileSync('git', ['init', '--bare', remotePath], { stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', remotePath], { cwd: seedPath, stdio: 'ignore' });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: seedPath, stdio: 'ignore' });

    db = new SqliteAdapter(new Database(':memory:'));
    await db.exec(`
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        name TEXT,
        job_title TEXT,
        project_id INTEGER,
        job_instructions TEXT,
        enabled INTEGER,
        timeout_seconds INTEGER,
        model TEXT,
        skill_names TEXT,
        session_key TEXT,
        runtime_type TEXT,
        runtime_config TEXT,
        hooks_url TEXT,
        hooks_auth_header TEXT,
        workspace_path TEXT,
        preferred_provider TEXT,
        repo_path TEXT,
        repo_url TEXT,
        repo_access_mode TEXT,
        os_user TEXT,
        openclaw_agent_id TEXT
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        title TEXT,
        description TEXT,
        status TEXT,
        priority TEXT,
        agent_id INTEGER,
        active_instance_id INTEGER,
        project_id INTEGER,
        task_type TEXT,
        sprint_id INTEGER,
        created_at TEXT,
        updated_at TEXT,
        dispatched_at TEXT,
        claimed_at TEXT,
        paused_at TEXT,
        routing_reason TEXT,
        first_dispatched_at TEXT,
        total_dispatch_count INTEGER DEFAULT 0
      );
      CREATE TABLE task_dependencies (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        blocked_id INTEGER
      );
      CREATE TABLE sprint_task_routing_rules (
        id INTEGER PRIMARY KEY,
        sprint_id INTEGER,
        agent_id INTEGER,
        status TEXT,
        task_type TEXT,
        priority INTEGER
      );
      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY,
        agent_id INTEGER,
        task_id INTEGER,
        status TEXT,
        payload_sent TEXT,
        worktree_path TEXT,
        session_key TEXT,
        dispatched_at TEXT,
        created_at TEXT,
        run_id TEXT,
        response TEXT,
        error TEXT,
        completed_at TEXT,
        effective_model TEXT
      );
      CREATE TABLE task_notes (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        author TEXT,
        content TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE task_history (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        changed_by TEXT,
        field TEXT,
        old_value TEXT,
        new_value TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY,
        instance_id INTEGER,
        agent_id INTEGER,
        job_title TEXT,
        level TEXT,
        message TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE dispatch_log (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        agent_id INTEGER,
        routing_reason TEXT,
        candidate_count INTEGER,
        candidates_skipped TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT,
        context TEXT
      );
      CREATE TABLE sprint_types (
        key TEXT PRIMARY KEY,
        repo_required INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE sprints (
        id INTEGER PRIMARY KEY,
        sprint_type TEXT
      );
      CREATE TABLE story_point_model_routing (
        id INTEGER PRIMARY KEY,
        max_points INTEGER,
        model TEXT,
        max_turns INTEGER,
        max_budget_usd REAL,
        label TEXT,
        enabled INTEGER DEFAULT 1,
        preferred_provider TEXT
      );
    `);

    await db.run(`INSERT INTO projects (id, name, context) VALUES (1, 'Agent HQ', 'Context')`);
    await db.run(`INSERT INTO sprint_types (key, repo_required) VALUES ('generic', 0), ('dev', 1)`);
    await db.run(`INSERT INTO sprints (id, sprint_type) VALUES (9, 'generic')`);
    await db.run(`
      INSERT INTO agents (
        id, name, job_title, project_id, job_instructions, enabled, timeout_seconds, model,
        skill_names, session_key, runtime_type, runtime_config, hooks_url, hooks_auth_header,
        workspace_path, preferred_provider, repo_path, repo_url, repo_access_mode, os_user, openclaw_agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, 1, 'Cinder', 'Backend Engineer', 1, 'Do the work', 1, 900, null, null, 'agent:cinder-backend:main', 'openclaw', null, null, null, workspaceRoot, null, null, remotePath, 'clone', null, 'cinder-backend');
    await db.run(`
      INSERT INTO tasks (id, title, description, status, priority, project_id, task_type, sprint_id, created_at, updated_at)
      VALUES (373, 'Agent repo source modes', 'Test task', 'ready', 'high', 1, 'implementation', 9, datetime('now'), datetime('now'))
    `);
    await db.run(`
      INSERT INTO sprint_task_routing_rules (id, sprint_id, agent_id, status, task_type, priority)
      VALUES (1, 9, 1, 'ready', 'implementation', 100)
    `);

    runtimeDispatch = jest.fn(async () => ({ runId: 'run-test' }));
    resolveRuntime.mockReturnValue({
      prepareAuthProfiles: jest.fn().mockResolvedValue({
        ok: true,
        status: 'skipped',
        providersSynced: [],
        runtimeAuthProvidersSynced: [],
        openclawAuthProvidersSynced: [],
      }),
      dispatch: runtimeDispatch,
      abort: jest.fn(async () => undefined),
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('dispatches clone-mode jobs with repo context intact', async () => {
    const { dispatchTaskToJob } = await import('./dispatcher');

    const job = await db.get(`SELECT
      id,
      job_title as title,
      id as agent_id,
      project_id,
      job_instructions,
      enabled,
      timeout_seconds,
      session_key as agent_session_key,
      name as agent_name,
      model,
      model as agent_model,
      runtime_type,
      runtime_config,
      hooks_url as agent_hooks_url,
      hooks_auth_header as agent_hooks_auth_header,
      workspace_path,
      skill_names,
      preferred_provider,
      repo_path,
      repo_url,
      repo_access_mode,
      os_user,
      openclaw_agent_id
    FROM agents WHERE id = 1`) as Record<string, unknown>;
    const task = await db.get(`SELECT
      id,
      title,
      description,
      status,
      priority,
      agent_id,
      project_id,
      task_type,
      sprint_id,
      NULL as sprint_name,
      NULL as sprint_type,
      created_at,
      0 as blocking_count,
      NULL as story_points
    FROM tasks WHERE id = 373`) as Record<string, unknown>;

    const ok = dispatchTaskToJob(db, job as never, task as never, 1, 'Rule: Backend Engineer (agent #1)');
    expect(ok).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(runtimeDispatch).toHaveBeenCalledTimes(1);
    const runtimeParams = runtimeDispatch.mock.calls[0][0];
    expect(runtimeParams.repoAccessMode).toBe('clone');
    expect(runtimeParams.repoConfigSource).toBeUndefined();
    expect(runtimeParams.repoSource).toBe(`clone:${remotePath}`);
    expect(runtimeParams.repoWorkspacePath).toBe(path.join(workspaceRoot, 'task-373'));
    expect(runtimeParams.repoBranch).toBe('cinder-backend/task-373-agent-repo-source-modes');
    expect(runtimeParams.workspaceRoot).toBe(workspaceRoot);
    expect(runtimeParams.activeRepoRoot).toBe(path.join(workspaceRoot, 'task-373'));
    expect(runtimeParams.runtimeConfig).toEqual(expect.objectContaining({
      workingDirectory: path.join(workspaceRoot, 'task-373'),
    }));
    expect(syncAssignedMcpForAgent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 1,
      workingDirectory: workspaceRoot,
      activateOpenClawWorkspaceBundle: true,
      refreshPluginRegistry: true,
    }));

    const instance = await db.get(`SELECT payload_sent, worktree_path FROM job_instances WHERE task_id = 373`) as { payload_sent: string; worktree_path: string };
    const payload = JSON.parse(instance.payload_sent) as {
      repoAccessMode?: string;
      repoSource?: string;
      repoWorkspacePath?: string;
      repoBranch?: string;
      repoConfigSource?: string | null;
      repoDependencySetup?: Array<{ strategy: string; status: string; reason?: string }>;
    };
    expect(payload.repoAccessMode).toBe('clone');
    expect(payload.repoConfigSource).toBeNull();
    expect(payload.repoSource).toBe(`clone:${remotePath}`);
    expect(payload.repoWorkspacePath).toBe(path.join(workspaceRoot, 'task-373'));
    expect(payload.repoBranch).toBe('cinder-backend/task-373-agent-repo-source-modes');
    expect(payload.repoDependencySetup).toEqual([expect.objectContaining({
      strategy: 'skip',
      status: 'skipped',
      reason: 'no_supported_package_roots',
    })]);
    expect(instance.worktree_path).toBe(path.join(workspaceRoot, 'task-373'));
  });

  it('blocks repo-required workflows when only legacy agent repo config is available', async () => {
    const { dispatchTaskToJob } = await import('./dispatcher');
    await db.run(`UPDATE sprints SET sprint_type = 'dev' WHERE id = 9`);

    const job = await db.get(`SELECT
      id,
      job_title as title,
      id as agent_id,
      project_id,
      job_instructions,
      enabled,
      timeout_seconds,
      session_key as agent_session_key,
      name as agent_name,
      model,
      model as agent_model,
      runtime_type,
      runtime_config,
      hooks_url as agent_hooks_url,
      hooks_auth_header as agent_hooks_auth_header,
      workspace_path,
      skill_names,
      preferred_provider,
      repo_path,
      repo_url,
      repo_access_mode,
      'agent_legacy' as repo_config_source,
      os_user,
      openclaw_agent_id
    FROM agents WHERE id = 1`) as Record<string, unknown>;
    const task = await db.get(`SELECT
      id,
      title,
      description,
      status,
      priority,
      agent_id,
      project_id,
      task_type,
      sprint_id,
      NULL as sprint_name,
      'dev' as sprint_type,
      created_at,
      0 as blocking_count,
      NULL as story_points
    FROM tasks WHERE id = 373`) as Record<string, unknown>;

    const ok = dispatchTaskToJob(db, job as never, task as never, 1, 'Rule: Backend Engineer (agent #1)');

    expect(ok).toBe(false);
    expect(runtimeDispatch).not.toHaveBeenCalled();
    const note = await db.get(`SELECT content FROM task_notes WHERE task_id = 373 ORDER BY id DESC LIMIT 1`) as { content: string } | undefined;
    expect(note?.content).toContain('Workflow-level repository configuration is required for repo-backed workflow dispatch');
    const instanceCount = await db.get(`SELECT COUNT(*) AS count FROM job_instances WHERE task_id = 373`) as { count: number };
    expect(instanceCount.count).toBe(0);
  });

  it('dispatchInstance uses persisted repo workspace as runtime working directory', async () => {
    const repoWorkspacePath = path.join(workspaceRoot, 'task-373');
    await db.run(`
      INSERT INTO job_instances (id, agent_id, task_id, status, payload_sent, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `, 900, 1, 373, 'queued', JSON.stringify({
              repoAccessMode: 'clone',
              repoSource: `clone:${remotePath}`,
              repoWorkspacePath,
              repoBranch: 'cinder-backend/task-373-agent-repo-source-modes',
            }));

    const getDbSpy = jest.spyOn(require('../db/client'), 'getDb').mockReturnValue(db);
    await db.run(`UPDATE agents SET session_key = ? WHERE id = 1`, 'agent:agent-hq:cinder-platform-engineer:backend-engineer:main');
    try {
      const { dispatchInstance } = await import('./dispatcher');
      await dispatchInstance({
        instanceId: 900,
        agentId: 1,
        jobTitle: 'Backend Engineer',
        sessionKey: 'agent:agent-hq:cinder-platform-engineer:backend-engineer:main',
        message: 'Run the task',
        storyPoints: null,
        runtimeType: 'claude-code',
        runtimeConfig: { maxTurns: 3 },
      });
    } finally {
      getDbSpy.mockRestore();
    }

    expect(runtimeDispatch).toHaveBeenCalledTimes(1);
    const runtimeParams = runtimeDispatch.mock.calls[0][0];
    expect(runtimeParams.agentSlug).toBe('cinder-backend');
    expect(runtimeParams.repoAccessMode).toBe('clone');
    expect(runtimeParams.repoSource).toBe(`clone:${remotePath}`);
    expect(runtimeParams.repoWorkspacePath).toBe(repoWorkspacePath);
    expect(runtimeParams.repoBranch).toBe('cinder-backend/task-373-agent-repo-source-modes');
    expect(runtimeParams.workspaceRoot).toBe(repoWorkspacePath);
    expect(runtimeParams.runtimeConfig).toEqual(expect.objectContaining({
      maxTurns: 3,
      workingDirectory: repoWorkspacePath,
    }));
  });
});
