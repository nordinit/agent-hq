import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

jest.mock('../runtimes', () => ({
  resolveRuntime: jest.fn(),
}));

jest.mock('./worktreeManager', () => ({
  createTaskWorktree: jest.fn(() => ({ created: false, workspacePath: null, branch: null, error: null })),
}));

jest.mock('../lib/taskNotifications', () => ({
  notifyTaskStatusChange: jest.fn(),
}));

jest.mock('../lib/taskHistory', () => ({
  writeTaskStatusChange: jest.fn(),
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

const mockedGitHubIdentity = jest.requireMock('../lib/githubIdentity') as {
  resolveGitHubIdentity: jest.Mock;
  injectGitHubCredentials: jest.Mock;
  cleanupGitHubCredentials: jest.Mock;
  buildGitHubIdentityContext: jest.Mock;
};

jest.mock('../lib/agentHqBaseUrl', () => ({
  getAgentHqBaseUrl: jest.fn(() => 'http://localhost:3501'),
}));

import { resolveRuntime } from '../runtimes';
import type { AgentRuntime } from '../runtimes';
import { dispatchInstance, resolveModelFromStoryPoints, runDispatcher } from './dispatcher';

const mockedResolveRuntime = resolveRuntime as jest.MockedFunction<typeof resolveRuntime>;
const mockedTaskNotifications = jest.requireMock('../lib/taskNotifications') as {
  notifyTaskStatusChange: jest.Mock;
};

function mockRuntime(dispatch: jest.Mock): AgentRuntime {
  return {
    prepareAuthProfiles: jest.fn().mockResolvedValue({
      ok: true,
      status: 'skipped',
      providersSynced: [],
      runtimeAuthProvidersSynced: [],
      openclawAuthProvidersSynced: [],
    }),
    dispatch,
    abort: jest.fn().mockResolvedValue(undefined),
  };
}

describe('runDispatcher thinking-level routing', () => {
  it('resolveModelFromStoryPoints returns configured thinking_level', async () => {
    const db = new Database(':memory:');
    await db.exec(`
      CREATE TABLE story_point_model_routing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        sprint_id INTEGER,
        max_points INTEGER NOT NULL,
        provider TEXT,
        model TEXT NOT NULL,
        fallback_model TEXT,
        max_turns INTEGER,
        max_budget_usd REAL,
        thinking_level TEXT,
        label TEXT
      );
    `);

    await db.run(`
      INSERT INTO story_point_model_routing (project_id, sprint_id, max_points, provider, model, thinking_level, label)
      VALUES (86, NULL, 5, 'anthropic', 'anthropic/claude-sonnet-4-6', 'medium', 'default route')
    `);

    expect(await resolveModelFromStoryPoints(db, 3, 'anthropic', { projectId: 86 })).toEqual({
      model: 'anthropic/claude-sonnet-4-6',
      max_turns: null,
      max_budget_usd: null,
      thinking_level: 'medium',
      fast_mode: null,
      label: 'default route',
    });

    db.close();
  });

  it('resolveModelFromStoryPoints ignores disabled rules', async () => {
    const db = new Database(':memory:');
    await db.exec(`
      CREATE TABLE story_point_model_routing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        sprint_id INTEGER,
        max_points INTEGER NOT NULL,
        provider TEXT,
        model TEXT NOT NULL,
        fallback_model TEXT,
        max_turns INTEGER,
        max_budget_usd REAL,
        thinking_level TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        label TEXT
      );
    `);

    await db.run(`
      INSERT INTO story_point_model_routing (project_id, sprint_id, max_points, provider, model, thinking_level, enabled, label)
      VALUES
        (86, NULL, 5, 'anthropic', 'anthropic/disabled', 'medium', 0, 'disabled route'),
        (86, NULL, 8, 'anthropic', 'anthropic/enabled', 'low', 1, 'enabled route')
    `);

    expect(await resolveModelFromStoryPoints(db, 3, 'anthropic', { projectId: 86 })).toEqual(expect.objectContaining({
      model: 'anthropic/enabled',
      label: 'enabled route',
    }));

    db.close();
  });

  it('resolveModelFromStoryPoints prefers sprint scoped rules before project scoped rules', async () => {
    const db = new Database(':memory:');
    await db.exec(`
      CREATE TABLE story_point_model_routing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        sprint_id INTEGER,
        max_points INTEGER NOT NULL,
        provider TEXT,
        model TEXT NOT NULL,
        fallback_model TEXT,
        max_turns INTEGER,
        max_budget_usd REAL,
        thinking_level TEXT,
        label TEXT
      );
    `);

    await db.run(`
      INSERT INTO story_point_model_routing (project_id, sprint_id, max_points, provider, model, thinking_level, label)
      VALUES
        (86, NULL, 5, 'openai-codex', 'openai/gpt-5.4', 'medium', 'project'),
        (86, 57, 5, 'openai-codex', 'openai/gpt-5.5', 'high', 'sprint')
    `);

    expect(await resolveModelFromStoryPoints(db, 3, 'openai-codex', { projectId: 86, sprintId: 57 })).toEqual({
      model: 'openai/gpt-5.5',
      max_turns: null,
      max_budget_usd: null,
      thinking_level: 'high',
      fast_mode: null,
      label: 'sprint',
    });

    expect(await resolveModelFromStoryPoints(db, 3, 'openai-codex', { projectId: 86, sprintId: 58 })).toEqual({
      model: 'openai/gpt-5.4',
      max_turns: null,
      max_budget_usd: null,
      thinking_level: 'medium',
      fast_mode: null,
      label: 'project',
    });

    db.close();
  });

  it('resolveModelFromStoryPoints applies sprint-type scoped rules between sprint and project scopes', async () => {
    const db = new Database(':memory:');
    await db.exec(`
      CREATE TABLE sprints (
        id INTEGER PRIMARY KEY,
        project_id INTEGER,
        sprint_type TEXT
      );

      CREATE TABLE story_point_model_routing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        sprint_id INTEGER,
        sprint_type TEXT,
        max_points INTEGER NOT NULL,
        provider TEXT,
        model TEXT NOT NULL,
        fallback_model TEXT,
        max_turns INTEGER,
        max_budget_usd REAL,
        thinking_level TEXT,
        label TEXT
      );

      INSERT INTO sprints (id, project_id, sprint_type) VALUES (57, 86, 'dev'), (58, 86, 'dev'), (59, 86, 'generic');
    `);

    await db.run(`
      INSERT INTO story_point_model_routing (project_id, sprint_id, sprint_type, max_points, provider, model, thinking_level, label)
      VALUES
        (86, NULL, NULL, 5, 'openai-codex', 'openai/project', 'medium', 'project'),
        (NULL, NULL, 'dev', 5, 'openai-codex', 'openai/global-dev-default', 'low', 'global-dev-default'),
        (86, NULL, 'dev', 5, 'openai-codex', 'openai/dev-default', 'high', 'dev-default'),
        (86, 57, NULL, 5, 'openai-codex', 'openai/sprint', 'adaptive', 'sprint')
    `);

    expect(await resolveModelFromStoryPoints(db, 3, 'openai-codex', { projectId: 86, sprintId: 57 })).toEqual(expect.objectContaining({
      model: 'openai/sprint',
      thinking_level: 'adaptive',
      label: 'sprint',
    }));
    expect(await resolveModelFromStoryPoints(db, 3, 'openai-codex', { projectId: 86, sprintId: 58 })).toEqual(expect.objectContaining({
      model: 'openai/dev-default',
      thinking_level: 'high',
      label: 'dev-default',
    }));
    expect(await resolveModelFromStoryPoints(db, 3, 'openai-codex', { projectId: 86, sprintId: 59 })).toEqual(expect.objectContaining({
      model: 'openai/project',
      thinking_level: 'medium',
      label: 'project',
    }));

    await db.run(`DELETE FROM story_point_model_routing WHERE label = 'dev-default'`);
    expect(await resolveModelFromStoryPoints(db, 3, 'openai-codex', { projectId: 86, sprintId: 58 })).toEqual(expect.objectContaining({
      model: 'openai/global-dev-default',
      thinking_level: 'low',
      label: 'global-dev-default',
    }));
    expect(await resolveModelFromStoryPoints(db, 3, 'openai-codex', { sprintType: 'dev' })).toEqual(expect.objectContaining({
      model: 'openai/global-dev-default',
      thinking_level: 'low',
      label: 'global-dev-default',
    }));

    db.close();
  });

  it('resolveModelFromStoryPoints ignores legacy global rows with no explicit scope', async () => {
    const db = new Database(':memory:');
    await db.exec(`
      CREATE TABLE story_point_model_routing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        sprint_id INTEGER,
        max_points INTEGER NOT NULL,
        provider TEXT,
        model TEXT NOT NULL,
        fallback_model TEXT,
        max_turns INTEGER,
        max_budget_usd REAL,
        thinking_level TEXT,
        label TEXT
      );
    `);

    await db.run(`
      INSERT INTO story_point_model_routing (project_id, sprint_id, max_points, provider, model, thinking_level, label)
      VALUES (NULL, NULL, 5, 'openai-codex', 'openai/gpt-5.4', 'medium', 'legacy-global')
    `);

    expect(await resolveModelFromStoryPoints(db, 3, 'openai-codex', { projectId: 86, sprintId: 57 })).toBeNull();

    db.close();
  });

  it('resolveModelFromStoryPoints requires tenant-scoped routing rows to match the task tenant', async () => {
    const db = new Database(':memory:');
    await db.exec(`
      CREATE TABLE story_point_model_routing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER,
        project_id INTEGER,
        sprint_id INTEGER,
        sprint_type TEXT,
        max_points INTEGER NOT NULL,
        provider TEXT,
        model TEXT NOT NULL,
        fallback_model TEXT,
        max_turns INTEGER,
        max_budget_usd REAL,
        thinking_level TEXT,
        label TEXT
      );
    `);

    await db.run(`
      INSERT INTO story_point_model_routing (tenant_id, project_id, sprint_id, sprint_type, max_points, provider, model, thinking_level, label)
      VALUES
        (1, 86, NULL, 'dev', 5, 'openai', 'anthropic/claude-sonnet-4-6', 'medium', 'tenant-1-wrong-model'),
        (4, 86, NULL, 'dev', 5, 'openai', 'openai/gpt-5.5', 'high', 'tenant-4-openai')
    `);

    expect(await resolveModelFromStoryPoints(db, 3, 'openai', { tenantId: 4, projectId: 86, sprintType: 'dev' })).toEqual(expect.objectContaining({
      model: 'openai/gpt-5.5',
      label: 'tenant-4-openai',
    }));
    expect(await resolveModelFromStoryPoints(db, 3, 'openai', { tenantId: 2, projectId: 86, sprintType: 'dev' })).toBeNull();

    db.close();
  });

  it('passes routed thinking_level into runtime dispatch and persists resolved output', async () => {
    const db = new Database(':memory:');
    await db.exec(`
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        tenant_id INTEGER,
        job_title TEXT NOT NULL,
        project_id INTEGER,
        job_instructions TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        timeout_seconds INTEGER NOT NULL,
        model TEXT,
        skill_names TEXT,
        session_key TEXT NOT NULL,
        name TEXT,
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
        openclaw_agent_id TEXT,
        sort_rules TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        tenant_id INTEGER,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        agent_id INTEGER,
        project_id INTEGER,
        task_type TEXT,
        sprint_id INTEGER,
        created_at TEXT NOT NULL,
        story_points INTEGER,
        active_instance_id INTEGER,
        paused_at TEXT,
        dispatched_at TEXT,
        claimed_at TEXT,
        routing_reason TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        updated_at TEXT
      );

      CREATE TABLE sprints (
        id INTEGER PRIMARY KEY,
        tenant_id INTEGER,
        name TEXT,
        sprint_type TEXT,
        status TEXT
      );

      CREATE TABLE sprint_task_routing_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sprint_id INTEGER NOT NULL,
        task_type TEXT,
        status TEXT NOT NULL,
        agent_id INTEGER NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER,
        agent_id INTEGER NOT NULL,
        task_id INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        dispatched_at TEXT,
        payload_sent TEXT,
        worktree_path TEXT,
        session_key TEXT,
        response TEXT,
        error TEXT,
        completed_at TEXT,
        effective_model TEXT,
        effective_thinking_level TEXT,
        effective_fast_mode INTEGER
      );

      CREATE TABLE story_point_model_routing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER,
        project_id INTEGER,
        sprint_id INTEGER,
        max_points INTEGER NOT NULL,
        provider TEXT,
        model TEXT NOT NULL,
        fallback_model TEXT,
        max_turns INTEGER,
        max_budget_usd REAL,
        thinking_level TEXT,
        fast_mode INTEGER,
        label TEXT
      );

      CREATE TABLE dispatch_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        agent_id INTEGER,
        routing_reason TEXT,
        candidate_count INTEGER,
        candidates_skipped TEXT
      );

      CREATE TABLE task_dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        blocker_id INTEGER,
        blocked_id INTEGER
      );

      CREATE TABLE task_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        author TEXT,
        content TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE task_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        changed_by TEXT,
        field TEXT,
        old_value TEXT,
        new_value TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id INTEGER,
        agent_id INTEGER,
        job_title TEXT,
        level TEXT,
        message TEXT
      );
    `);

    await db.run(`
      INSERT INTO agents (id, tenant_id, job_title, project_id, job_instructions, enabled, timeout_seconds, model, skill_names, session_key, name, runtime_type, runtime_config, workspace_path, preferred_provider, sort_rules)
      VALUES (1, 4, 'Backend Engineer', 86, 'Do the task', 1, 900, 'openai/gpt-5.5', '[]', 'agent:backend:main', 'Cinder', 'openclaw', '{}', '/tmp', 'openai', '[]')
    `);

    await db.run(`
      INSERT INTO tasks (id, tenant_id, title, description, status, priority, agent_id, project_id, task_type, sprint_id, created_at, story_points, updated_at)
      VALUES (382, 4, 'Add thinking routing', 'Implement support', 'ready', 'medium', 1, 86, 'backend', 10, '2026-04-28T20:00:00.000Z', 4, '2026-04-28T20:00:00.000Z')
    `);

    await db.run(`
      INSERT INTO story_point_model_routing (tenant_id, project_id, sprint_id, max_points, provider, model, thinking_level, fast_mode, label)
      VALUES
        (1, 86, 10, 4, 'openai', 'anthropic/claude-sonnet-4-6', 'medium', 0, 'Tenant 1 Anthropic route'),
        (4, 86, 10, 4, 'openai', 'openai/gpt-5.5', 'high', 1, 'Tenant 4 OpenAI route')
    `);

    await db.run(`
      INSERT INTO sprints (id, tenant_id, name, sprint_type, status)
      VALUES (10, 4, 'Bugs', 'generic', 'active')
    `);

    await db.run(`
      INSERT INTO sprint_task_routing_rules (sprint_id, task_type, status, agent_id, priority)
      VALUES (10, 'backend', 'ready', 1, 5)
    `);

    const callOrder: string[] = [];
    const dispatchMock = jest.fn(async () => {
      callOrder.push('dispatch');
      return { runId: 'run-123' };
    });
    const runtime = mockRuntime(dispatchMock);
    const prepareAuthProfiles = runtime.prepareAuthProfiles as jest.Mock;
    prepareAuthProfiles.mockImplementation(async () => {
      callOrder.push('prepareAuthProfiles');
      return {
        ok: true,
        status: 'skipped',
        providersSynced: [],
        runtimeAuthProvidersSynced: [],
        openclawAuthProvidersSynced: [],
      };
    });
    mockedResolveRuntime.mockReturnValue(runtime);

    const result = await runDispatcher(db, 86);
    expect(result.dispatched).toBe(1);

    await new Promise((resolve) => setImmediate(resolve));

    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'openai/gpt-5.5',
      thinking: 'high',
      fastMode: true,
      workspaceRoot: '/tmp',
      activeRepoRoot: '/tmp',
      runtimeConfig: expect.objectContaining({ workingDirectory: '/tmp', fastMode: true }),
    }));
    expect(prepareAuthProfiles).toHaveBeenCalledWith(expect.objectContaining({
      agentSlug: 'backend',
      preferredProvider: 'openai',
      runtimeConfig: expect.objectContaining({ workingDirectory: '/tmp', fastMode: true }),
    }));
    expect(callOrder).toEqual(['prepareAuthProfiles', 'dispatch']);

    const instance = await db.get(`SELECT tenant_id, effective_model, effective_thinking_level, effective_fast_mode FROM job_instances LIMIT 1`) as { tenant_id: number | null; effective_model: string | null; effective_thinking_level: string | null; effective_fast_mode: number | null };
    expect(instance).toEqual({
      tenant_id: 4,
      effective_model: 'openai/gpt-5.5',
      effective_thinking_level: 'high',
      effective_fast_mode: 1,
    });

    db.close();
  });

  it('makes task worktree authoritative for runtime cwd and repo-root metadata', async () => {
    const db = new Database(':memory:');
    await db.exec(`
      CREATE TABLE tenants (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        job_title TEXT NOT NULL,
        project_id INTEGER,
        job_instructions TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        timeout_seconds INTEGER NOT NULL,
        model TEXT,
        skill_names TEXT,
        session_key TEXT NOT NULL,
        name TEXT,
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
        openclaw_agent_id TEXT,
        sort_rules TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        agent_id INTEGER,
        project_id INTEGER,
        task_type TEXT,
        sprint_id INTEGER,
        created_at TEXT NOT NULL,
        story_points INTEGER,
        active_instance_id INTEGER,
        paused_at TEXT,
        dispatched_at TEXT,
        claimed_at TEXT,
        routing_reason TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        updated_at TEXT
      );

      CREATE TABLE sprints (
        id INTEGER PRIMARY KEY,
        name TEXT,
        sprint_type TEXT,
        status TEXT
      );

      CREATE TABLE sprint_task_routing_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sprint_id INTEGER NOT NULL,
        task_type TEXT,
        status TEXT NOT NULL,
        agent_id INTEGER NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        task_id INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        dispatched_at TEXT,
        payload_sent TEXT,
        worktree_path TEXT,
        session_key TEXT,
        response TEXT,
        error TEXT,
        completed_at TEXT,
        effective_model TEXT,
        effective_thinking_level TEXT
      );

      CREATE TABLE dispatch_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        agent_id INTEGER,
        routing_reason TEXT,
        candidate_count INTEGER,
        candidates_skipped TEXT
      );

      CREATE TABLE task_dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        blocker_id INTEGER,
        blocked_id INTEGER
      );

      CREATE TABLE task_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        author TEXT,
        content TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE task_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        changed_by TEXT,
        field TEXT,
        old_value TEXT,
        new_value TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id INTEGER,
        agent_id INTEGER,
        job_title TEXT,
        level TEXT,
        message TEXT
      );
    `);

    await db.run(`
      INSERT INTO agents (id, job_title, project_id, job_instructions, enabled, timeout_seconds, model, skill_names, session_key, name, runtime_type, runtime_config, workspace_path, preferred_provider, repo_path, sort_rules)
      VALUES (1, 'Backend Engineer', 86, 'Do the task', 1, 900, 'anthropic/claude-sonnet-4-6', '[]', 'agent:backend:main', 'Cinder', 'claude-code', '{"workingDirectory":"  /parent/workspace/../workspace-root  "}', '/parent/workspace', 'anthropic', '/repos/agent-hq', '[]')
    `);

    await db.run(`
      INSERT INTO tasks (id, title, description, status, priority, agent_id, project_id, task_type, sprint_id, created_at, story_points, updated_at)
      VALUES (375, 'Fix worktree root handoff', 'Make worktree repo root authoritative', 'ready', 'high', 1, 86, 'backend', 10, '2026-04-28T20:00:00.000Z', 3, '2026-04-28T20:00:00.000Z')
    `);

    await db.run(`
      INSERT INTO sprints (id, name, sprint_type, status)
      VALUES (10, 'Bugs', 'generic', 'active')
    `);

    await db.run(`
      INSERT INTO sprint_task_routing_rules (sprint_id, task_type, status, agent_id, priority)
      VALUES (10, 'backend', 'ready', 1, 5)
    `);

    const dispatchMock = jest.fn().mockResolvedValue({ runId: 'run-375' });
    mockedResolveRuntime.mockReturnValue(mockRuntime(dispatchMock));
    mockedGitHubIdentity.resolveGitHubIdentity.mockReturnValue({
      id: 7,
      identity: {
        githubUser: 'cinder-agent',
        gitAuthorName: 'Cinder',
        gitAuthorEmail: 'cinder@agenthq',
        token: 'secret-token',
      },
    });

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const { createTaskWorktree } = jest.requireMock('./worktreeManager') as { createTaskWorktree: jest.Mock };
    createTaskWorktree.mockReturnValue({
      created: true,
      workspacePath: '/Users/test/workspaces/task-375',
      branch: 'task-375-fix',
      error: null,
    });

    const result = await runDispatcher(db, 86);
    expect(result.dispatched).toBe(1);

    await new Promise((resolve) => setImmediate(resolve));

    const runtimeParams = dispatchMock.mock.calls[0]?.[0];
    expect(runtimeParams).toMatchObject({
      workspaceRoot: '/parent/workspace',
      activeRepoRoot: '/Users/test/workspaces/task-375',
      pathMetadata: {
        pathMode: 'worktree',
        repoRootSource: 'worktree',
        workspaceRootSource: 'workspace',
        worktreeRoot: '/Users/test/workspaces/task-375',
        runtimeConfigWorkingDirectory: '/parent/workspace-root',
      },
    });
    expect(runtimeParams?.runtimeConfig).toMatchObject({ workingDirectory: '/Users/test/workspaces/task-375' });
    expect(runtimeParams?.message).toContain('## Active Workspace Context');
    expect(mockedGitHubIdentity.injectGitHubCredentials).toHaveBeenCalledWith(
      '/Users/test/workspaces/task-375',
      expect.objectContaining({ githubUser: 'cinder-agent' }),
    );
    expect(mockedGitHubIdentity.buildGitHubIdentityContext).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ githubUser: 'cinder-agent' }),
      }),
      '/Users/test/workspaces/task-375',
    );

    const dispatchedMessage = dispatchMock.mock.calls[0]?.[0]?.message as string;
    expect(dispatchedMessage).toContain('## Active Workspace Context');
    expect(dispatchedMessage).toContain('- **Path mode:** worktree');
    expect(dispatchedMessage).toContain('- **Active repo root:** /Users/test/workspaces/task-375');
    expect(dispatchedMessage).toContain('- **Workspace container root:** /parent/workspace');
    expect(dispatchedMessage).toContain('- **Task worktree:** /Users/test/workspaces/task-375');
    expect(dispatchedMessage).toContain('Start all file inspection, searches, edits, and git commands from the active repo root first.');
    expect(dispatchedMessage).toContain('Do not begin by probing the workspace container root for repo files when the active repo root differs.');
    expect(dispatchedMessage).toContain('Do not treat the workspace container root as the repo root when a task worktree or other active repo root is present.');

    const loggedMessages = logSpy.mock.calls.map(([message]) => String(message));
    expect(loggedMessages).toEqual(expect.arrayContaining([
      '[dispatcher] Instance #1 path resolution: mode=worktree activeRepoRoot=/Users/test/workspaces/task-375 workspaceRoot=/parent/workspace worktreePath=/Users/test/workspaces/task-375 runtimeConfigWorkingDirectory=/parent/workspace-root repoRootSource=worktree workspaceRootSource=workspace',
      '[dispatcher] Instance #1 runtime config handoff: mode=worktree workingDirectory=/Users/test/workspaces/task-375 activeRepoRoot=/Users/test/workspaces/task-375 workspaceRoot=/parent/workspace worktreePath=/Users/test/workspaces/task-375 runtimeConfigWorkingDirectory=/parent/workspace-root repoRootSource=worktree workspaceRootSource=workspace',
    ]));

    logSpy.mockRestore();

    const payloadSent = await db.get(`SELECT payload_sent FROM job_instances LIMIT 1`) as { payload_sent: string | null };
    expect(JSON.parse(payloadSent.payload_sent ?? '{}')).toEqual(expect.objectContaining({
      mode: 'runtime-dispatch',
      transport: 'ws.send',
    }));

    const instance = await db.get(`SELECT worktree_path FROM job_instances LIMIT 1`) as { worktree_path: string | null };
    expect(instance.worktree_path).toBe('/Users/test/workspaces/task-375');

    db.close();
  });

  it('writes run context into the active worktree with consistent repo-root metadata', async () => {
    const db = new Database(':memory:');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-worktree-'));
    const workspaceRoot = path.join(tempRoot, 'workspace-root');
    const worktreeRoot = path.join(workspaceRoot, 'task-375');
    fs.mkdirSync(worktreeRoot, { recursive: true });

    try {
      await db.exec(`
        CREATE TABLE agents (
          id INTEGER PRIMARY KEY,
          job_title TEXT NOT NULL,
          project_id INTEGER,
          job_instructions TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          timeout_seconds INTEGER NOT NULL,
          model TEXT,
          skill_names TEXT,
          session_key TEXT NOT NULL,
          name TEXT,
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
          openclaw_agent_id TEXT,
          sort_rules TEXT NOT NULL DEFAULT '[]'
        );

        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL,
          priority TEXT NOT NULL,
          agent_id INTEGER,
          project_id INTEGER,
          task_type TEXT,
          sprint_id INTEGER,
          created_at TEXT NOT NULL,
          story_points INTEGER,
          active_instance_id INTEGER,
          paused_at TEXT,
          dispatched_at TEXT,
          claimed_at TEXT,
          routing_reason TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 3,
          updated_at TEXT
        );

        CREATE TABLE sprints (
          id INTEGER PRIMARY KEY,
          name TEXT,
          sprint_type TEXT,
          status TEXT
        );

        CREATE TABLE sprint_task_routing_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sprint_id INTEGER NOT NULL,
          task_type TEXT,
          status TEXT NOT NULL,
          agent_id INTEGER NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE job_instances (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id INTEGER NOT NULL,
          task_id INTEGER,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          dispatched_at TEXT,
          payload_sent TEXT,
          worktree_path TEXT,
          session_key TEXT,
          response TEXT,
          error TEXT,
          completed_at TEXT,
          effective_model TEXT,
          effective_thinking_level TEXT
        );

        CREATE TABLE dispatch_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER,
          agent_id INTEGER,
          routing_reason TEXT,
          candidate_count INTEGER,
          candidates_skipped TEXT
        );

        CREATE TABLE task_dependencies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          blocker_id INTEGER,
          blocked_id INTEGER
        );

        CREATE TABLE task_notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER,
          author TEXT,
          content TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE task_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER,
          changed_by TEXT,
          field TEXT,
          old_value TEXT,
          new_value TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id INTEGER,
          agent_id INTEGER,
          job_title TEXT,
          level TEXT,
          message TEXT
        );
      `);

      await db.run(`
        INSERT INTO agents (id, job_title, project_id, job_instructions, enabled, timeout_seconds, model, skill_names, session_key, name, runtime_type, runtime_config, workspace_path, preferred_provider, repo_path, sort_rules)
        VALUES (1, 'Backend Engineer', 86, 'Do the task', 1, 900, 'anthropic/claude-sonnet-4-6', '[]', 'agent:backend:main', 'Cinder', 'claude-code', '{"workingDirectory":"/stale/root"}', ?, 'anthropic', '/repos/agent-hq', '[]')
      `, workspaceRoot);

      await db.run(`
        INSERT INTO tasks (id, title, description, status, priority, agent_id, project_id, task_type, sprint_id, created_at, story_points, updated_at)
        VALUES (375, 'Fix worktree root handoff', 'Make worktree repo root authoritative', 'ready', 'high', 1, 86, 'backend', 10, '2026-04-28T20:00:00.000Z', 3, '2026-04-28T20:00:00.000Z')
      `);

      await db.run(`
        INSERT INTO sprints (id, name, sprint_type, status)
        VALUES (10, 'Bugs', 'generic', 'active')
      `);

      await db.run(`
        INSERT INTO sprint_task_routing_rules (sprint_id, task_type, status, agent_id, priority)
        VALUES (10, 'backend', 'ready', 1, 5)
      `);

      const dispatchMock = jest.fn().mockResolvedValue({ runId: 'run-375' });
      mockedResolveRuntime.mockReturnValue(mockRuntime(dispatchMock));

      const { createTaskWorktree } = jest.requireMock('./worktreeManager') as { createTaskWorktree: jest.Mock };
      createTaskWorktree.mockReturnValue({
        created: true,
        workspacePath: worktreeRoot,
        branch: 'task-375-fix',
        error: null,
      });

      const result = await runDispatcher(db, 86);
      expect(result.dispatched).toBeGreaterThanOrEqual(0);
      expect(result.errors).toEqual([]);

      await new Promise((resolve) => setImmediate(resolve));

      const runContextPath = path.join(worktreeRoot, '.agent-hq-run-context.json');
      const runContext = JSON.parse(fs.readFileSync(runContextPath, 'utf-8')) as {
        workspace_root: string | null;
        active_repo_root: string | null;
        worktree_root: string | null;
      };

      expect(runContext).toEqual(expect.objectContaining({
        workspace_root: workspaceRoot,
        active_repo_root: worktreeRoot,
        worktree_root: worktreeRoot,
      }));

      expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({
        workspaceRoot: workspaceRoot,
        activeRepoRoot: worktreeRoot,
        pathMetadata: {
          pathMode: 'worktree',
          repoRootSource: 'worktree',
          workspaceRootSource: 'workspace',
          worktreeRoot: worktreeRoot,
          runtimeConfigWorkingDirectory: '/stale/root',
        },
        runtimeConfig: expect.objectContaining({ workingDirectory: worktreeRoot }),
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      db.close();
    }
  });

  it('normalizes dispatch path inputs before making the worktree authoritative', async () => {
    const db = new Database(':memory:');
    await db.exec(`
      CREATE TABLE tenants (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        job_title TEXT NOT NULL,
        project_id INTEGER,
        job_instructions TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        timeout_seconds INTEGER NOT NULL,
        model TEXT,
        skill_names TEXT,
        session_key TEXT NOT NULL,
        name TEXT,
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
        openclaw_agent_id TEXT,
        sort_rules TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        agent_id INTEGER,
        project_id INTEGER,
        task_type TEXT,
        sprint_id INTEGER,
        created_at TEXT NOT NULL,
        story_points INTEGER,
        active_instance_id INTEGER,
        paused_at TEXT,
        dispatched_at TEXT,
        claimed_at TEXT,
        routing_reason TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        updated_at TEXT
      );

      CREATE TABLE sprints (
        id INTEGER PRIMARY KEY,
        name TEXT,
        sprint_type TEXT,
        status TEXT
      );

      CREATE TABLE sprint_task_routing_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sprint_id INTEGER NOT NULL,
        task_type TEXT,
        status TEXT NOT NULL,
        agent_id INTEGER NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        task_id INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        dispatched_at TEXT,
        payload_sent TEXT,
        worktree_path TEXT,
        session_key TEXT,
        response TEXT,
        error TEXT,
        completed_at TEXT,
        effective_model TEXT,
        effective_thinking_level TEXT
      );

      CREATE TABLE dispatch_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        agent_id INTEGER,
        routing_reason TEXT,
        candidate_count INTEGER,
        candidates_skipped TEXT
      );

      CREATE TABLE task_dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        blocker_id INTEGER,
        blocked_id INTEGER
      );

      CREATE TABLE task_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        author TEXT,
        content TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE task_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        changed_by TEXT,
        field TEXT,
        old_value TEXT,
        new_value TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id INTEGER,
        agent_id INTEGER,
        job_title TEXT,
        level TEXT,
        message TEXT
      );
    `);

    await db.run(`
      INSERT INTO agents (id, job_title, project_id, job_instructions, enabled, timeout_seconds, model, skill_names, session_key, name, runtime_type, runtime_config, workspace_path, preferred_provider, repo_path, sort_rules)
      VALUES (1, 'Backend Engineer', 86, 'Do the task', 1, 900, 'anthropic/claude-sonnet-4-6', '[]', 'agent:backend:main', 'Cinder', 'openclaw', '{"workingDirectory":"/parent/workspace"}', '/parent/workspace', 'anthropic', '/repos/agent-hq', '[]')
    `);

    await db.run(`
      INSERT INTO tasks (id, title, description, status, priority, agent_id, project_id, task_type, sprint_id, created_at, story_points, updated_at)
      VALUES (375, 'Fix worktree root handoff', 'Make worktree repo root authoritative', 'ready', 'high', 1, 86, 'backend', 10, '2026-04-28T20:00:00.000Z', 3, '2026-04-28T20:00:00.000Z')
    `);

    await db.run(`
      INSERT INTO sprints (id, name, sprint_type, status)
      VALUES (10, 'Bugs', 'generic', 'active')
    `);

    await db.run(`
      INSERT INTO sprint_task_routing_rules (sprint_id, task_type, status, agent_id, priority)
      VALUES (10, 'backend', 'ready', 1, 5)
    `);

    const dispatchMock = jest.fn().mockResolvedValue({ runId: 'run-375' });
    mockedResolveRuntime.mockReturnValue(mockRuntime(dispatchMock));

    const { createTaskWorktree } = jest.requireMock('./worktreeManager') as { createTaskWorktree: jest.Mock };
    createTaskWorktree.mockReturnValue({
      created: true,
      workspacePath: '/parent/workspace/task-375',
      branch: 'task-375-fix',
      error: null,
    });

    await runDispatcher(db, 86);
    await new Promise((resolve) => setImmediate(resolve));

    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: '/parent/workspace',
      activeRepoRoot: '/parent/workspace/task-375',
      pathMetadata: {
        pathMode: 'worktree',
        repoRootSource: 'worktree',
        workspaceRootSource: 'workspace',
        worktreeRoot: '/parent/workspace/task-375',
        runtimeConfigWorkingDirectory: '/parent/workspace',
      },
      runtimeConfig: expect.objectContaining({
        workingDirectory: '/parent/workspace/task-375',
      }),
    }));

    db.close();
  });

  it('surfaces worktree startup failures on the task instead of leaving it silently ready', async () => {
    jest.clearAllMocks();

    const db = new Database(':memory:');
    await db.exec(`
      CREATE TABLE tenants (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        job_title TEXT NOT NULL,
        project_id INTEGER,
        job_instructions TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        timeout_seconds INTEGER NOT NULL,
        model TEXT,
        skill_names TEXT,
        session_key TEXT NOT NULL,
        name TEXT,
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
        openclaw_agent_id TEXT,
        sort_rules TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        agent_id INTEGER,
        project_id INTEGER,
        task_type TEXT,
        sprint_id INTEGER,
        created_at TEXT NOT NULL,
        story_points INTEGER,
        active_instance_id INTEGER,
        paused_at TEXT,
        dispatched_at TEXT,
        claimed_at TEXT,
        routing_reason TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        failure_detail TEXT,
        previous_status TEXT,
        updated_at TEXT
      );
      CREATE TABLE sprints (id INTEGER PRIMARY KEY, name TEXT, sprint_type TEXT, status TEXT);
      CREATE TABLE sprint_task_routing_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, sprint_id INTEGER NOT NULL, task_type TEXT, status TEXT NOT NULL, agent_id INTEGER NOT NULL, priority INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE job_instances (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER, task_id INTEGER, status TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, payload_sent TEXT, worktree_path TEXT, session_key TEXT, dispatched_at TEXT, response TEXT, error TEXT, completed_at TEXT, effective_model TEXT, effective_thinking_level TEXT);
      CREATE TABLE dispatch_log (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, agent_id INTEGER, routing_reason TEXT, candidate_count INTEGER, candidates_skipped TEXT);
      CREATE TABLE task_dependencies (id INTEGER PRIMARY KEY AUTOINCREMENT, blocker_id INTEGER, blocked_id INTEGER);
      CREATE TABLE task_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, author TEXT, content TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, changed_by TEXT, field TEXT, old_value TEXT, new_value TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id INTEGER, agent_id INTEGER, job_title TEXT, level TEXT, message TEXT);
      CREATE TABLE external_event_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        source TEXT,
        event_name TEXT NOT NULL,
        task_type TEXT,
        status_includes_json TEXT NOT NULL DEFAULT '[]',
        status_excludes_json TEXT NOT NULL DEFAULT '[]',
        action_kind TEXT NOT NULL DEFAULT 'ignore',
        action_target TEXT,
        apply_review_evidence INTEGER NOT NULL DEFAULT 0,
        apply_failure_detail INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await db.run(`INSERT INTO tenants (id, name) VALUES (1, 'Default Tenant')`);

    await db.run(`
      INSERT INTO agents (id, job_title, project_id, job_instructions, enabled, timeout_seconds, session_key, name, runtime_type, workspace_path, repo_path, repo_access_mode, openclaw_agent_id, sort_rules)
      VALUES (1, 'Ember', 86, 'Do the task', 1, 900, 'agent:ember:main', 'Ember', 'openclaw', '/parent/workspace', '/repos/agent-hq', 'worktree', 'ember-frontend', '[]')
    `);
    await db.run(`INSERT INTO sprints (id, name, sprint_type, status) VALUES (10, 'Bugs', 'generic', 'active')`);
    await db.run(`
      INSERT INTO tasks (id, title, description, status, priority, project_id, task_type, sprint_id, created_at, updated_at)
      VALUES (442, 'Surface dispatcher failure', 'Task', 'ready', 'high', 86, 'frontend', 10, '2026-05-06T18:00:00.000Z', '2026-05-06T18:00:00.000Z')
    `);
    await db.run(`INSERT INTO sprint_task_routing_rules (sprint_id, task_type, status, agent_id, priority) VALUES (10, 'frontend', 'ready', 1, 10)`);

    const { createTaskWorktree } = jest.requireMock('./worktreeManager') as { createTaskWorktree: jest.Mock };
    createTaskWorktree.mockReturnValue({
      created: false,
      workspacePath: null,
      branch: null,
      error: "fatal: 'origin' does not appear to be a git repository\nfatal: ambiguous argument 'origin/main': unknown revision",
    });

    await db.run(`
      INSERT INTO external_event_mappings (project_id, source, event_name, task_type, action_kind, action_target, apply_failure_detail, enabled, priority)
      VALUES (86, 'agent_hq_dispatcher', 'dispatch_startup_failed', 'frontend', 'status', 'stalled', 1, 1, 100)
    `);

    const result = await runDispatcher(db, 86);
    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);

    const task = await db.get(`SELECT status, agent_id, routing_reason, failure_detail, previous_status, active_instance_id FROM tasks WHERE id = 442`) as Record<string, unknown>;
    expect(task.status).toBe('stalled');
    expect(task.agent_id).toBe(1);
    expect(task.active_instance_id).toBeNull();
    expect(String(task.failure_detail)).toContain('Dispatcher startup failure workflow event');
    expect(String(task.failure_detail)).toContain('Matched agent: Ember (#1)');
    expect(String(task.failure_detail)).toContain('Event: dispatch_startup_failed');
    expect(String(task.failure_detail)).toContain('repo setup / worktree creation');
    expect(String(task.routing_reason)).toContain('Rule: Ember (agent #1)');
    expect(task.previous_status).toBe('ready');

    const note = await db.get(`SELECT content FROM task_notes WHERE task_id = 442 ORDER BY id DESC LIMIT 1`) as { content: string };
    expect(note.content).toContain('Summary: Dispatch startup failed after routing matched Ember');
    expect(note.content).toContain('Failure or issue observed: Worktree creation failed for task #442');
    expect(note.content).toContain('Root cause assessment: repo configuration or checkout state');
    expect(note.content).toContain('Evidence: workflow_event=dispatch_startup_failed');
    expect(note.content).toContain('mapping=#1');
    expect(note.content).toContain('action=status→stalled');
    expect(note.content).toContain('Next owner: dev');

    const eventHistory = await db.all(`SELECT field, new_value FROM task_history WHERE task_id = 442 AND field LIKE 'workflow_event_%'`) as Array<{ field: string; new_value: string | null }>;
    expect(eventHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'workflow_event_source', new_value: 'agent_hq_dispatcher' }),
      expect.objectContaining({ field: 'workflow_event_name', new_value: 'dispatch_startup_failed' }),
      expect.objectContaining({ field: 'workflow_event_failure_category', new_value: 'repo setup / worktree creation' }),
      expect.objectContaining({ field: 'workflow_event_prior_status', new_value: 'ready' }),
      expect.objectContaining({ field: 'workflow_event_action_kind', new_value: 'status' }),
      expect.objectContaining({ field: 'workflow_event_action_target', new_value: 'stalled' }),
    ]));

    const notification = await db.get(`
      SELECT type, title, body, source, outlet, metadata_json
      FROM notification_records
      WHERE type = 'task_dispatch_startup_failed'
    `) as { type: string; title: string; body: string; source: string; outlet: string; metadata_json: string };
    expect(notification.title).toBe('Task #442 dispatch startup failed');
    expect(notification.body).toContain('Task: #442 Surface dispatcher failure');
    expect(notification.body).toContain('Project: unknown');
    expect(notification.body).toContain('Workflow: Bugs');
    expect(notification.body).toContain('Matched agent: Ember (#1)');
    expect(notification.body).toContain('Routing reason: Priority: high | Created: 2026-05-06T18:00:00.000Z | Rule: Ember (agent #1)');
    expect(notification.body).toContain('Failure category: repo setup / worktree creation');
    expect(notification.body).toContain("Failure message: Worktree creation failed for task #442");
    expect(notification.body).toContain('Mapping: #1; action=status -> stalled');
    expect(notification.body).toContain('Status: ready -> stalled');
    expect(notification.body).toContain('Next action: Fix the repo setup for the matched route, then redispatch the task.');
    expect(notification.source).toBe('agent_hq_dispatcher');
    expect(notification.outlet).toBe('agent_hq');
    expect(JSON.parse(notification.metadata_json)).toEqual(expect.objectContaining({
      taskId: 442,
      matchedAgentId: 1,
      matchedAgentLabel: 'Ember',
      failureCategory: 'repo setup / worktree creation',
      mappingActionKind: 'status',
      mappingActionTarget: 'stalled',
      priorStatus: 'ready',
      resolvedStatus: 'stalled',
    }));
    expect(mockedTaskNotifications.notifyTaskStatusChange).toHaveBeenCalledWith(db, expect.objectContaining({
      taskId: 442,
      fromStatus: 'ready',
      toStatus: 'stalled',
      source: 'dispatcher',
    }));

    expect(mockedResolveRuntime).not.toHaveBeenCalled();
    db.close();
  });

  it('records a startup failure notification when workflow mapping ignores the event and status stays ready', async () => {
    jest.clearAllMocks();

    const db = new Database(':memory:');
    await db.exec(`
      CREATE TABLE tenants (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        job_title TEXT NOT NULL,
        project_id INTEGER,
        job_instructions TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        timeout_seconds INTEGER NOT NULL,
        model TEXT,
        skill_names TEXT,
        session_key TEXT NOT NULL,
        name TEXT,
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
        openclaw_agent_id TEXT,
        sort_rules TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        agent_id INTEGER,
        project_id INTEGER,
        task_type TEXT,
        sprint_id INTEGER,
        created_at TEXT NOT NULL,
        story_points INTEGER,
        active_instance_id INTEGER,
        paused_at TEXT,
        dispatched_at TEXT,
        claimed_at TEXT,
        routing_reason TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        failure_detail TEXT,
        previous_status TEXT,
        updated_at TEXT
      );
      CREATE TABLE sprints (id INTEGER PRIMARY KEY, name TEXT, sprint_type TEXT, status TEXT);
      CREATE TABLE sprint_task_routing_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, sprint_id INTEGER NOT NULL, task_type TEXT, status TEXT NOT NULL, agent_id INTEGER NOT NULL, priority INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE job_instances (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER, task_id INTEGER, status TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, payload_sent TEXT, worktree_path TEXT, session_key TEXT, dispatched_at TEXT, response TEXT, error TEXT, completed_at TEXT, effective_model TEXT, effective_thinking_level TEXT);
      CREATE TABLE dispatch_log (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, agent_id INTEGER, routing_reason TEXT, candidate_count INTEGER, candidates_skipped TEXT);
      CREATE TABLE task_dependencies (id INTEGER PRIMARY KEY AUTOINCREMENT, blocker_id INTEGER, blocked_id INTEGER);
      CREATE TABLE task_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, author TEXT, content TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, changed_by TEXT, field TEXT, old_value TEXT, new_value TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id INTEGER, agent_id INTEGER, job_title TEXT, level TEXT, message TEXT);
      CREATE TABLE external_event_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        source TEXT,
        event_name TEXT NOT NULL,
        task_type TEXT,
        status_includes_json TEXT NOT NULL DEFAULT '[]',
        status_excludes_json TEXT NOT NULL DEFAULT '[]',
        action_kind TEXT NOT NULL DEFAULT 'ignore',
        action_target TEXT,
        apply_review_evidence INTEGER NOT NULL DEFAULT 0,
        apply_failure_detail INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await db.run(`INSERT INTO tenants (id, name) VALUES (1, 'Default Tenant')`);

    await db.run(`
      INSERT INTO agents (id, job_title, project_id, job_instructions, enabled, timeout_seconds, session_key, name, runtime_type, workspace_path, repo_path, repo_access_mode, openclaw_agent_id, sort_rules)
      VALUES (1, 'Cinder', 86, 'Do the task', 1, 900, 'agent:cinder:main', 'Cinder', 'openclaw', '/parent/workspace', '/repos/agent-hq', 'worktree', 'cinder-backend', '[]')
    `);
    await db.run(`INSERT INTO sprints (id, name, sprint_type, status) VALUES (10, 'Enhancements', 'dev', 'active')`);
    await db.run(`
      INSERT INTO tasks (id, title, description, status, priority, project_id, task_type, sprint_id, created_at, updated_at)
      VALUES (932, 'Notify operators when dispatch startup fails without a status change', 'Task', 'ready', 'high', 86, 'backend', 10, '2026-07-06T18:00:00.000Z', '2026-07-06T18:00:00.000Z')
    `);
    await db.run(`INSERT INTO sprint_task_routing_rules (sprint_id, task_type, status, agent_id, priority) VALUES (10, 'backend', 'ready', 1, 10)`);
    await db.run(`
      INSERT INTO external_event_mappings (project_id, source, event_name, task_type, action_kind, action_target, apply_failure_detail, enabled, priority)
      VALUES (86, 'agent_hq_dispatcher', 'dispatch_startup_failed', 'backend', 'ignore', NULL, 1, 1, 100)
    `);

    const { createTaskWorktree } = jest.requireMock('./worktreeManager') as { createTaskWorktree: jest.Mock };
    createTaskWorktree.mockReturnValue({
      created: false,
      workspacePath: null,
      branch: null,
      error: "fatal: ambiguous argument 'origin/main': unknown revision",
    });

    const first = await runDispatcher(db, 86);
    await db.run(`UPDATE tasks SET dispatched_at = NULL WHERE id = 932`);
    const second = await runDispatcher(db, 86);
    expect(first.dispatched).toBe(0);
    expect(first.skipped).toBe(1);
    expect(second.dispatched).toBe(0);
    expect(second.skipped).toBe(1);

    const task = await db.get(`SELECT status, failure_detail, previous_status FROM tasks WHERE id = 932`) as Record<string, unknown>;
    expect(task.status).toBe('ready');
    expect(task.previous_status).toBe('ready');
    expect(String(task.failure_detail)).toContain('Action: ignore');
    expect(String(task.failure_detail)).toContain('Message: Workflow-level repository configuration is required for repo-backed workflow dispatch');

    const notifications = await db.all(`
      SELECT title, body, source, outlet, metadata_json
      FROM notification_records
      WHERE type = 'task_dispatch_startup_failed'
      ORDER BY id
    `) as Array<{ title: string; body: string; source: string; outlet: string; metadata_json: string }>;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe('Task #932 dispatch startup failed');
    expect(notifications[0].body).toContain('Task: #932 Notify operators when dispatch startup fails without a status change');
    expect(notifications[0].body).toContain('Workflow: Enhancements');
    expect(notifications[0].body).toContain('Matched agent: Cinder (#1)');
    expect(notifications[0].body).toContain('Failure category: repo setup / worktree creation');
    expect(notifications[0].body).toContain('Failure message: Workflow-level repository configuration is required for repo-backed workflow dispatch');
    expect(notifications[0].body).toContain('Mapping: #1; action=ignore');
    expect(notifications[0].body).toContain('Status: ready (unchanged)');
    expect(notifications[0].body).toContain('Next action: Fix the repo setup for the matched route, then redispatch the task.');
    expect(notifications[0].source).toBe('agent_hq_dispatcher');
    expect(notifications[0].outlet).toBe('agent_hq');
    expect(JSON.parse(notifications[0].metadata_json)).toEqual(expect.objectContaining({
      taskId: 932,
      failureCategory: 'repo setup / worktree creation',
      mappingActionKind: 'ignore',
      mappingActionTarget: null,
      priorStatus: 'ready',
      resolvedStatus: 'ready',
    }));
    expect(mockedTaskNotifications.notifyTaskStatusChange).not.toHaveBeenCalled();
    expect(mockedResolveRuntime).not.toHaveBeenCalled();

    db.close();
  });

  it('preserves runtime dispatch retries but surfaces the failure on the task', async () => {
    jest.clearAllMocks();

    const db = new Database(':memory:');
    await db.exec(`
      CREATE TABLE tenants (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        job_title TEXT NOT NULL,
        project_id INTEGER,
        job_instructions TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        timeout_seconds INTEGER NOT NULL,
        model TEXT,
        skill_names TEXT,
        session_key TEXT NOT NULL,
        name TEXT,
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
        openclaw_agent_id TEXT,
        sort_rules TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        agent_id INTEGER,
        project_id INTEGER,
        task_type TEXT,
        sprint_id INTEGER,
        created_at TEXT NOT NULL,
        story_points INTEGER,
        active_instance_id INTEGER,
        paused_at TEXT,
        dispatched_at TEXT,
        claimed_at TEXT,
        routing_reason TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        failure_detail TEXT,
        previous_status TEXT,
        updated_at TEXT
      );
      CREATE TABLE sprints (id INTEGER PRIMARY KEY, name TEXT, sprint_type TEXT, status TEXT);
      CREATE TABLE sprint_task_routing_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, sprint_id INTEGER NOT NULL, task_type TEXT, status TEXT NOT NULL, agent_id INTEGER NOT NULL, priority INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE job_instances (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER, task_id INTEGER, status TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, payload_sent TEXT, worktree_path TEXT, session_key TEXT, dispatched_at TEXT, response TEXT, error TEXT, completed_at TEXT, effective_model TEXT, effective_thinking_level TEXT);
      CREATE TABLE dispatch_log (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, agent_id INTEGER, routing_reason TEXT, candidate_count INTEGER, candidates_skipped TEXT);
      CREATE TABLE task_dependencies (id INTEGER PRIMARY KEY AUTOINCREMENT, blocker_id INTEGER, blocked_id INTEGER);
      CREATE TABLE task_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, author TEXT, content TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, changed_by TEXT, field TEXT, old_value TEXT, new_value TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id INTEGER, agent_id INTEGER, job_title TEXT, level TEXT, message TEXT);
    `);
    await db.run(`INSERT INTO tenants (id, name) VALUES (1, 'Default Tenant')`);

    await db.run(`
      INSERT INTO agents (id, job_title, project_id, job_instructions, enabled, timeout_seconds, session_key, name, runtime_type, workspace_path, repo_path, repo_access_mode, openclaw_agent_id, sort_rules)
      VALUES (1, 'Cinder', 86, 'Do the task', 1, 900, 'agent:agent-hq:cinder-platform-engineer:backend-engineer:main', 'Cinder', 'openclaw', '/parent/workspace', '/repos/agent-hq', 'worktree', 'cinder-backend', '[]')
    `);
    await db.run(`INSERT INTO sprints (id, name, sprint_type, status) VALUES (10, 'Bugs', 'generic', 'active')`);
    await db.run(`
      INSERT INTO tasks (id, title, description, status, priority, project_id, task_type, sprint_id, created_at, updated_at)
      VALUES (444, 'Surface dispatcher failure', 'Task', 'ready', 'high', 86, 'backend', 10, '2026-05-06T18:00:00.000Z', '2026-05-06T18:00:00.000Z')
    `);
    await db.run(`INSERT INTO sprint_task_routing_rules (sprint_id, task_type, status, agent_id, priority) VALUES (10, 'backend', 'ready', 1, 10)`);

    const { createTaskWorktree } = jest.requireMock('./worktreeManager') as { createTaskWorktree: jest.Mock };
    createTaskWorktree.mockReturnValue({
      created: true,
      workspacePath: '/parent/workspace/task-444',
      branch: 'task-444-fix',
      error: null,
    });

    const dispatchMock = jest.fn().mockRejectedValue(new Error('Gateway connect timeout'));
    mockedResolveRuntime.mockReturnValue(mockRuntime(dispatchMock));

    const result = await runDispatcher(db, 86);
    expect(result.dispatched).toBe(1);
    await new Promise(resolve => setImmediate(resolve));

    const task = await db.get(`SELECT status, agent_id, routing_reason, retry_count, failure_detail, previous_status, active_instance_id FROM tasks WHERE id = 444`) as Record<string, unknown>;
    expect(task.status).toBe('ready');
    expect(task.agent_id).toBe(1);
    expect(task.active_instance_id).toBeNull();
    expect(task.retry_count).toBe(1);
    expect(String(task.failure_detail)).toContain('Dispatcher startup failure workflow event');
    expect(String(task.failure_detail)).toContain('Matched agent: Cinder (#1)');
    expect(String(task.failure_detail)).toContain('runtime infrastructure');
    expect(String(task.routing_reason)).toContain('Rule: Cinder (agent #1)');
    expect(task.previous_status).toBe('ready');
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      agentSlug: 'cinder-backend',
    }));

    const note = await db.get(`SELECT content FROM task_notes WHERE task_id = 444 ORDER BY id DESC LIMIT 1`) as { content: string };
    expect(note.content).toContain('Summary: Dispatch startup failed after routing matched Cinder (attempt 1/3)');
    expect(note.content).toContain('Result: partial');
    expect(note.content).toContain('Evidence: workflow_event=dispatch_startup_failed');
    expect(note.content).toContain('legacy_outcome=infra_failed');
    expect(note.content).toContain('Next owner: PM/operator');

    const instance = await db.get(`SELECT status, error FROM job_instances WHERE task_id = 444 ORDER BY id DESC LIMIT 1`) as { status: string; error: string | null };
    expect(instance.status).toBe('failed');
    expect(instance.error).toBe('Gateway connect timeout');

    db.close();
  });

  it('does not dispatch a stalled task that lacks a matching sprint routing rule, even if agent_id is set', async () => {
    const db = new Database(':memory:');
    await db.exec(`
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        job_title TEXT NOT NULL,
        project_id INTEGER,
        job_instructions TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        timeout_seconds INTEGER NOT NULL,
        model TEXT,
        skill_names TEXT,
        session_key TEXT NOT NULL,
        name TEXT,
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
        openclaw_agent_id TEXT,
        sort_rules TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        agent_id INTEGER,
        project_id INTEGER,
        task_type TEXT,
        sprint_id INTEGER,
        created_at TEXT NOT NULL,
        story_points INTEGER,
        active_instance_id INTEGER,
        paused_at TEXT,
        dispatched_at TEXT,
        claimed_at TEXT,
        routing_reason TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        updated_at TEXT
      );

      CREATE TABLE sprints (
        id INTEGER PRIMARY KEY,
        name TEXT,
        sprint_type TEXT,
        status TEXT
      );

      CREATE TABLE sprint_task_routing_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sprint_id INTEGER NOT NULL,
        task_type TEXT,
        status TEXT NOT NULL,
        agent_id INTEGER NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        task_id INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        dispatched_at TEXT,
        payload_sent TEXT,
        worktree_path TEXT,
        session_key TEXT,
        response TEXT,
        error TEXT,
        completed_at TEXT,
        effective_model TEXT,
        effective_thinking_level TEXT
      );

      CREATE TABLE dispatch_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        agent_id INTEGER,
        routing_reason TEXT,
        candidate_count INTEGER,
        candidates_skipped TEXT,
        dispatched_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE task_dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        blocker_id INTEGER,
        blocked_id INTEGER
      );

      CREATE TABLE task_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        author TEXT,
        content TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE task_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        changed_by TEXT,
        field TEXT,
        old_value TEXT,
        new_value TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.run(`
      INSERT INTO agents (id, job_title, project_id, job_instructions, enabled, timeout_seconds, model, skill_names, session_key, name, runtime_type, runtime_config, workspace_path, preferred_provider, sort_rules)
      VALUES (2, 'Beacon', 86, 'Do the task', 1, 900, 'openai/gpt-5.5', '[]', 'agent:beacon:main', 'Beacon', 'openclaw', '{}', '/tmp', 'openai-codex', '[]')
    `);

    await db.run(`
      INSERT INTO sprints (id, name, sprint_type, status)
      VALUES (10, 'Bugs', 'generic', 'active')
    `);

    await db.run(`
      INSERT INTO tasks (id, title, description, status, priority, agent_id, project_id, task_type, sprint_id, created_at, updated_at)
      VALUES (417, 'Stalled task should not redispatch', 'Regression coverage', 'stalled', 'high', 2, 86, 'backend', 10, '2026-04-28T20:00:00.000Z', '2026-04-28T20:00:00.000Z')
    `);

    await db.run(`
      INSERT INTO sprint_task_routing_rules (sprint_id, task_type, status, agent_id, priority)
      VALUES (10, 'backend', 'ready', 2, 5)
    `);

    const dispatchMock = jest.fn().mockResolvedValue({ runId: 'run-stalled-417' });
    mockedResolveRuntime.mockReturnValue(mockRuntime(dispatchMock));

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await runDispatcher(db, 86);
    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
    expect(dispatchMock).not.toHaveBeenCalled();

    const instances = await db.get(`SELECT COUNT(*) as n FROM job_instances`) as { n: number };
    expect(instances.n).toBe(0);

    const taskRow = await db.get(`SELECT status, active_instance_id, agent_id FROM tasks WHERE id = 417`) as {
      status: string;
      active_instance_id: number | null;
      agent_id: number | null;
    };
    expect(taskRow).toEqual({
      status: 'stalled',
      active_instance_id: null,
      agent_id: 2,
    });

    expect(logSpy).toHaveBeenCalledWith(
      '[dispatcher] Task #417 not dispatched: no matching routing rule for sprint_id=10 status=stalled task_type=backend'
    );

    logSpy.mockRestore();
    db.close();
  });

  it('dispatchInstance passes routed thinking_level into runtime dispatch', async () => {
    const db = new Database(':memory:');
    await db.exec(`
      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        task_id INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        dispatched_at TEXT,
        payload_sent TEXT,
        session_key TEXT,
        response TEXT,
        error TEXT,
        completed_at TEXT,
        run_id TEXT
      );

      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id INTEGER,
        agent_id INTEGER,
        job_title TEXT,
        level TEXT,
        message TEXT
      );

      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        tenant_id INTEGER
      );

      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        tenant_id INTEGER
      );

      CREATE TABLE story_point_model_routing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        sprint_id INTEGER,
        max_points INTEGER NOT NULL,
        provider TEXT,
        model TEXT NOT NULL,
        fallback_model TEXT,
        max_turns INTEGER,
        max_budget_usd REAL,
        thinking_level TEXT,
        label TEXT
      );
    `);

    await db.run(`
      INSERT INTO job_instances (id, agent_id, task_id, status, created_at)
      VALUES (11, 1, 382, 'queued', '2026-04-28T20:00:00.000Z')
    `);
    await db.run(`INSERT INTO agents (id, tenant_id) VALUES (1, NULL)`);
    await db.run(`INSERT INTO tasks (id, tenant_id) VALUES (382, NULL)`);

    await db.run(`
      INSERT INTO story_point_model_routing (project_id, sprint_id, max_points, provider, model, thinking_level, label)
      VALUES (86, 10, 8, NULL, 'openai/gpt-5.5', 'adaptive', 'deeper route')
    `);

    const dispatchMock = jest.fn().mockResolvedValue({ runId: 'run-456' });
    mockedResolveRuntime.mockReturnValue(mockRuntime(dispatchMock));

    const dispatcherModule = jest.requireActual('./dispatcher') as typeof import('./dispatcher');
    const getDbSpy = jest.spyOn(require('../db/client'), 'getDb').mockReturnValue(db);

    try {
      await dispatchInstance({
        instanceId: 11,
        agentId: 1,
        sessionKey: 'hook:atlas:jobrun:11',
        jobTitle: 'Backend Engineer',
        message: 'Run the task',
        storyPoints: 6,
        projectId: 86,
        sprintId: 10,
        model: null,
        timeoutSeconds: 900,
        runtimeType: 'openclaw',
        runtimeConfig: '{}',
      });
    } finally {
      getDbSpy.mockRestore();
    }

    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'openai/gpt-5.5',
      thinking: 'adaptive',
    }));

    db.close();
  });
});
