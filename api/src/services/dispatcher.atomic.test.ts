import { setupTestDb, teardownTestDb } from '../db/testDb';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { type Db } from '../db/adapter/types';

jest.mock('../runtimes', () => ({
  resolveRuntime: jest.fn(),
}));

jest.mock('../runtimes/executablePolicy', () => ({
  ...(jest.requireActual('../runtimes/executablePolicy') as object),
  resolveAllowedRuntimeExecutable: jest.fn(() => ({
    path: '/opt/agent-hq/test-bin/claude',
    fingerprint: `sha256:${'a'.repeat(64)}`,
  })),
}));

jest.mock('./worktreeManager', () => ({
  createTaskWorktree: jest.fn(() => ({ created: false, workspacePath: null, branch: null, error: null })),
}));

// These routing/path fixtures intentionally use synthetic filesystem paths.
// Workspace lease behavior is exercised with real directories in its own suite.
jest.mock('./workspaceLease', () => ({
  ...(jest.requireActual('./workspaceLease') as object),
  acquireWorkspaceLease: jest.fn(() => jest.fn()),
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
    materialize: jest.fn(() => ({ ok: true, count: 0, details: [], warnings: [] })),
  })),
}));

jest.mock('../runtimes/mcpMaterialization', () => ({
  syncAssignedMcpForAgent: jest.fn(() => ({
    ok: true,
    count: 0,
    path: '',
    bundlePath: '',
    openClawConfigPath: '',
    serverNames: [],
    warnings: [],
  })),
}));

jest.mock('../lib/githubIdentity', () => ({
  resolveGitHubIdentity: jest.fn(() => null),
  injectGitHubCredentials: jest.fn(),
  cleanupGitHubCredentials: jest.fn(),
  buildGitHubCredentialEnv: jest.fn(() => ({ GH_TOKEN: 'ghp-test-token' })),
}));

const mockedGitHubIdentity = jest.requireMock('../lib/githubIdentity') as {
  resolveGitHubIdentity: jest.Mock;
  injectGitHubCredentials: jest.Mock;
  cleanupGitHubCredentials: jest.Mock;
  buildGitHubCredentialEnv: jest.Mock;
};

jest.mock('../lib/agentHqBaseUrl', () => ({
  getAgentHqBaseUrl: jest.fn(() => 'http://localhost:3501'),
}));

import { resolveRuntime } from '../runtimes';
import type { AgentRuntime } from '../runtimes';
import { dispatchTaskToJob, runDispatcher } from './dispatcher';
import { parseTimestamp, timestampFromEpochMs } from '../lib/timestamps';

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

async function seedProjectParents(
  db: Db,
  options: {
    projectTenantId?: number;
    workflows?: Array<{ id: number; workflowType: string; tenantId?: number; name?: string }>;
  } = {},
): Promise<void> {
  const projectTenantId = options.projectTenantId ?? 1;
  await db.run(`
    INSERT INTO tenants (id, name, slug, is_default)
    VALUES
      (1, 'Default Tenant', 'default', 1),
      (2, 'Tenant Two', 'tenant-two', 0),
      (4, 'Tenant Four', 'tenant-four', 0)
  `);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (86, ?, 'Agent HQ')`, projectTenantId);
  for (const workflow of options.workflows ?? []) {
    await db.run(`
      INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type, status)
      VALUES (?, ?, 86, ?, ?, 'active')
    `, workflow.id, workflow.tenantId ?? projectTenantId, workflow.name ?? `Workflow ${workflow.id}`, workflow.workflowType);
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForInstanceDispatchPersistence(db: Db, instanceId: number): Promise<void> {
  await waitFor(async () => {
    const row = await db.get(`SELECT response FROM job_instances WHERE id = ?`, instanceId) as { response: string | null } | undefined;
    return Boolean(row?.response);
  }, `job instance #${instanceId} runtime response persistence`);
}

import { prepareRepoWorkspaceDependencies } from './repoWorkspaceDependencies';
import { reconcileReviewQaRouting } from '../scheduler/reconciler';
jest.mock('./repoWorkspaceDependencies', () => ({ prepareRepoWorkspaceDependencies: jest.fn(async () => []) }));
const prepare = prepareRepoWorkspaceDependencies as jest.MockedFunction<typeof prepareRepoWorkspaceDependencies>;

let db: Db;
let dispatch: jest.Mock;
beforeEach(async () => {
  db = await setupTestDb();
  jest.clearAllMocks();
  prepare.mockResolvedValue([]);
  await seedProjectParents(db, { workflows: [{ id: 10, workflowType: 'generic' }] });
  await db.run(`INSERT INTO agents (id, tenant_id, project_id, name, job_title, job_instructions,
    enabled, session_key, runtime_type, runtime_config, workspace_path)
    VALUES (1, 1, 86, 'A', 'Producer', 'Do the task', 1, 'agent:producer:main', 'openclaw', '{}', '/tmp')`);
  await db.run(`INSERT INTO tasks (id, tenant_id, title, status, priority, project_id, workflow_id, task_type)
    VALUES (7, 1, 'Search', 'ready', 'medium', 86, 10, 'backend')`);
  await db.run(`INSERT INTO workflow_task_routing_rules (tenant_id, workflow_id, project_id, workflow_type, task_type, status, agent_id)
    VALUES (1, 10, 86, 'generic', 'backend', 'ready', 1)`);
  dispatch = jest.fn(async () => ({ runId: 'runtime-1' }));
  mockedResolveRuntime.mockReturnValue(mockRuntime(dispatch));
});
afterEach(async () => { await teardownTestDb(); });

it('two concurrent dispatch passes create one claim, preparation and runtime launch', async () => {
  const results = await Promise.all([runDispatcher(db, 86), runDispatcher(db, 86)]);
  expect(results.reduce((n, r) => n + r.dispatched, 0)).toBe(1);
  expect(results.flatMap(r => r.errors)).toEqual([]);
  await waitForInstanceDispatchPersistence(db, 1);
  expect(await db.value('SELECT count(*) FROM job_instances')).toBe(1);
  expect(await db.value('SELECT total_dispatch_count FROM tasks WHERE id = 7')).toBe(1);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it('reserves agent capacity across different tasks', async () => {
  await db.run(`INSERT INTO tasks (id, tenant_id, title, status, project_id, workflow_id, task_type)
    VALUES (8, 1, 'Other search', 'ready', 86, 10, 'backend')`);
  const results = await Promise.all([runDispatcher(db, 86), runDispatcher(db, 86)]);
  expect(results.reduce((n, r) => n + r.dispatched, 0)).toBe(1);
  expect(results.flatMap(r => r.errors)).toEqual([]);
  await waitForInstanceDispatchPersistence(db, 1);
  expect(await db.value("SELECT count(*) FROM job_instances WHERE status IN ('queued','dispatched','running')")).toBe(1);
  expect(prepare).toHaveBeenCalledTimes(1);
});

it('serializes different agents competing for the same task', async () => {
  await db.run(`INSERT INTO agents (id, tenant_id, project_id, name, job_title, job_instructions,
    enabled, session_key, runtime_type, runtime_config, workspace_path)
    VALUES (2, 1, 86, 'B', 'Producer B', 'Do the task', 1, 'agent:producer-b:main', 'openclaw', '{}', '/tmp')`);
  const jobs = await db.all(`SELECT *, id AS agent_id, job_title AS title, name AS agent_name,
    session_key AS agent_session_key FROM agents ORDER BY id`);
  const task = await db.get('SELECT *, 0 AS blocking_count FROM tasks WHERE id = 7');
  const results = await Promise.all(jobs.map(job => dispatchTaskToJob(db, job as never, task as never, 1)));
  expect(results.filter(Boolean)).toHaveLength(1);
  await waitForInstanceDispatchPersistence(db, 1);
  expect(await db.value('SELECT count(*) FROM job_instances')).toBe(1);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it('rolls back the instance when the task claim cannot be persisted', async () => {
  await db.exec(`CREATE FUNCTION reject_test_claim() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Test claim write failure'; END $$;
    CREATE TRIGGER reject_test_claim BEFORE UPDATE ON tasks FOR EACH ROW
    WHEN (NEW.active_instance_id IS NOT NULL) EXECUTE FUNCTION reject_test_claim();`);
  try {
    const result = await runDispatcher(db, 86);
    expect(result.dispatched).toBe(0);
    expect(result.errors.join(' ')).toContain('Test claim write failure');
    expect(await db.value('SELECT count(*) FROM job_instances')).toBe(0);
    expect(await db.value('SELECT active_instance_id FROM tasks WHERE id = 7')).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    await db.exec('DROP TRIGGER reject_test_claim ON tasks; DROP FUNCTION reject_test_claim();');
  }
});

it('claims before asynchronous preparation and releases a cancelled preparation without launching', async () => {
  let finish!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>(resolve => { entered = resolve; });
  prepare.mockImplementationOnce(async () => {
    entered();
    await new Promise<void>(resolve => { finish = resolve; });
    return [];
  });
  const pending = runDispatcher(db, 86);
  await barrier;
  try {
    expect(await db.value('SELECT active_instance_id FROM tasks WHERE id = 7')).toBe(1);
    expect(await db.value('SELECT status FROM job_instances WHERE id = 1')).toBe('queued');
    expect((await runDispatcher(db, 86)).dispatched).toBe(0);
    await db.run("UPDATE tasks SET paused_at = '2026-10-16 12:00:00' WHERE id = 7");
  } finally { finish(); }
  expect((await pending).dispatched).toBe(0);
  expect(await db.value('SELECT active_instance_id FROM tasks WHERE id = 7')).toBeNull();
  expect(await db.value('SELECT status FROM job_instances WHERE id = 1')).toBe('failed');
  expect(dispatch).not.toHaveBeenCalled();
});

it('records failed preparation and releases capacity for a later retry', async () => {
  prepare.mockRejectedValueOnce(new Error('Test setup failure'));
  expect((await runDispatcher(db, 86)).dispatched).toBe(0);
  expect(await db.value('SELECT active_instance_id FROM tasks WHERE id = 7')).toBeNull();
  expect(await db.value('SELECT status FROM job_instances WHERE id = 1')).toBe('failed');
  expect(await db.value('SELECT retry_count FROM tasks WHERE id = 7')).toBe(1);
  expect((await runDispatcher(db, 86)).dispatched).toBe(0);
  await db.run("UPDATE tasks SET dispatched_at = '2020-01-01 00:00:00' WHERE id = 7");
  expect((await runDispatcher(db, 86)).dispatched).toBe(1);
  await waitForInstanceDispatchPersistence(db, 2);
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it('shares the claim protocol with the review reconciler', async () => {
  await db.run("UPDATE tasks SET status = 'review', assigned_agent_id = 1 WHERE id = 7");
  await db.run("UPDATE workflow_task_routing_rules SET status = 'review' WHERE agent_id = 1");
  const reviewDispatch = jest.fn(async () => undefined);
  const [regular] = await Promise.all([
    runDispatcher(db, 86), reconcileReviewQaRouting({ dispatchInstance: reviewDispatch }, db),
  ]);
  expect(regular.errors).toEqual([]);
  if (regular.dispatched) await waitForInstanceDispatchPersistence(db, 1);
  expect(await db.value('SELECT count(*) FROM job_instances')).toBe(1);
  expect(regular.dispatched + reviewDispatch.mock.calls.length).toBe(1);
});
