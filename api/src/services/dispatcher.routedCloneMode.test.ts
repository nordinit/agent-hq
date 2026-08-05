import { setupTestDb, teardownTestDb } from '../db/testDb';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { type Db } from '../db/adapter/types';

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
    materialize: jest.fn(() => ({ ok: true, count: 0, details: [], warnings: [] })),
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

    db = await setupTestDb();

    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default', 'default', 1)`);
    await db.run(`INSERT INTO projects (id, tenant_id, name, context_md) VALUES (1, 1, 'Agent HQ', 'Context')`);
    await db.run(`
      INSERT INTO sprint_types (tenant_id, key, name, repo_required)
      VALUES (1, 'generic', 'Generic', 0), (1, 'dev', 'Development', 1)
    `);
    await db.run(`
      INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type)
      VALUES (9, 1, 1, 'Repository modes', 'generic')
    `);
    await db.run(`
      INSERT INTO agents (
        id, tenant_id, name, job_title, project_id, job_instructions, enabled, timeout_seconds, model,
        skill_names, session_key, runtime_type, runtime_config, hooks_url, hooks_auth_header,
        workspace_path, preferred_provider, repo_path, repo_url, repo_access_mode, os_user, openclaw_agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, 1, 1, 'Cinder', 'Backend Engineer', 1, 'Do the work', 1, 900, null, '[]', 'agent:cinder-backend:main', 'openclaw', null, null, null, workspaceRoot, 'anthropic', null, remotePath, 'clone', null, 'cinder-backend');
    await db.run(`
      INSERT INTO tasks (id, tenant_id, title, description, status, priority, project_id, task_type, sprint_id, created_at, updated_at)
      VALUES (373, 1, 'Agent repo source modes', 'Test task', 'ready', 'high', 1, 'implementation', 9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    await db.run(`
      INSERT INTO sprint_task_routing_rules (id, tenant_id, project_id, sprint_id, agent_id, status, task_type, priority)
      VALUES (1, 1, 1, 9, 1, 'ready', 'implementation', 100)
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

  afterEach(async () => {
    await teardownTestDb();
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

    const ok = await dispatchTaskToJob(db, job as never, task as never, 1, 'Rule: Backend Engineer (agent #1)');
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
    expect(runtimeParams.runtimeBoundary).toMatchObject({
      version: 1,
      identity: {
        tenantId: 1,
        projectId: 1,
        workflowId: 9,
        taskId: 373,
        agentId: 1,
        agentSlug: 'cinder-backend',
      },
      runtime: { type: 'openclaw', driverVersion: 'openclaw-driver/1' },
      workspace: {
        workspaceRoot,
        activeRepoRoot: path.join(workspaceRoot, 'task-373'),
        repoAccessMode: 'clone',
        repoSource: `clone:${remotePath}`,
      },
      executionTarget: { id: 'managed:openclaw-gateway', kind: 'managed' },
      callback: { identity: expect.stringMatching(/^run:/) },
    });
    expect(runtimeParams.runtimeBoundary.prompt.bundleFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
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

    const ok = await dispatchTaskToJob(db, job as never, task as never, 1, 'Rule: Backend Engineer (agent #1)');

    expect(ok).toBe(false);
    expect(runtimeDispatch).not.toHaveBeenCalled();
    const note = await db.get(`SELECT content FROM task_notes WHERE task_id = 373 ORDER BY id DESC LIMIT 1`) as { content: string } | undefined;
    expect(note?.content).toContain('Workflow-level repository configuration is required for repo-backed workflow dispatch');
    const instanceCount = await db.get(`SELECT COUNT(*) AS count FROM job_instances WHERE task_id = 373`) as { count: number };
    expect(instanceCount.count).toBe(0);
  });

  it('dispatchInstance uses persisted repo workspace as runtime working directory', async () => {
    const repoWorkspacePath = path.join(workspaceRoot, 'task-373');
    const claudeBin = path.join(tempRoot, 'claude');
    fs.writeFileSync(claudeBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(claudeBin, 0o755);
    const previousClaudeAllowlist = process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES;
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status, payload_sent, created_at)
      VALUES (?, 1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, 900, 1, 373, 'queued', JSON.stringify({
              repoAccessMode: 'clone',
              repoSource: `clone:${remotePath}`,
              repoWorkspacePath,
              repoBranch: 'cinder-backend/task-373-agent-repo-source-modes',
            }));

    const getDbSpy = jest.spyOn(require('../db/client'), 'getDb').mockReturnValue(db);
    await db.run(`UPDATE agents SET session_key = ? WHERE id = 1`, 'agent:agent-hq:cinder-platform-engineer:backend-engineer:main');
    process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES = claudeBin;
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
        runtimeConfig: { maxTurns: 3, claudeBin },
      });
    } finally {
      getDbSpy.mockRestore();
      if (previousClaudeAllowlist == null) delete process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES;
      else process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES = previousClaudeAllowlist;
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
      claudeBin,
      workingDirectory: repoWorkspacePath,
    }));
    expect(runtimeParams.runtimeBoundary).toMatchObject({
      version: 1,
      identity: { tenantId: 1, instanceId: 900, agentId: 1, agentSlug: 'cinder-backend' },
      runtime: {
        type: 'claude-code',
        driverVersion: 'claude-code-driver/1',
        executableFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        turnLimit: 3,
      },
      workspace: {
        workspaceRoot: repoWorkspacePath,
        activeRepoRoot: repoWorkspacePath,
        repoAccessMode: 'clone',
        repoSource: `clone:${remotePath}`,
      },
      executionTarget: { id: 'local:claude-code', kind: 'local-process' },
      callback: { identity: expect.stringMatching(/^run:/) },
    });
  });
});
