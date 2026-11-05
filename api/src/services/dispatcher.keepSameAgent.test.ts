import { setupTestDb, teardownTestDb } from '../db/testDb';
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

jest.mock('./workspaceLease', () => ({
  ...(jest.requireActual('./workspaceLease') as object),
  acquireWorkspaceLease: jest.fn(() => jest.fn()),
}));

jest.mock('../lib/taskNotifications', () => ({
  notifyTaskStatusChange: jest.fn(),
}));

jest.mock('../runtimes/skillMaterialization', () => ({
  getSkillMaterializationAdapter: jest.fn(() => ({
    adapterName: 'test',
    materialize: jest.fn(() => ({ ok: true, count: 0, details: [], warnings: [] })),
  })),
}));

jest.mock('../runtimes/mcpMaterialization', () => ({
  syncAssignedMcpForAgent: jest.fn(() => ({
    ok: true, count: 0, path: '', bundlePath: '', openClawConfigPath: '', serverNames: [], warnings: [],
  })),
}));

jest.mock('../lib/githubIdentity', () => ({
  resolveGitHubIdentity: jest.fn(() => null),
  injectGitHubCredentials: jest.fn(),
  cleanupGitHubCredentials: jest.fn(),
  buildGitHubCredentialEnv: jest.fn(() => ({})),
}));

jest.mock('../lib/agentHqBaseUrl', () => ({
  getAgentHqBaseUrl: jest.fn(() => 'http://localhost:3501'),
}));

jest.mock('./repoWorkspaceDependencies', () => ({ prepareRepoWorkspaceDependencies: jest.fn(async () => []) }));

import { resolveRuntime } from '../runtimes';
import type { AgentRuntime } from '../runtimes';
import { runDispatcher } from './dispatcher';
import { reconcileAssignedAgents } from '../scheduler/reconciler';
import { recordOutcomeStatusOwner } from './dispatch/routing/keepSameAgent';
import { getTaskStatusOwner, recordTaskStatusOwner } from '../domains/tasks/statusOwners';

const mockedResolveRuntime = resolveRuntime as jest.MockedFunction<typeof resolveRuntime>;

function mockRuntime(dispatch: jest.Mock): AgentRuntime {
  return {
    prepareAuthProfiles: jest.fn().mockResolvedValue({
      ok: true, status: 'skipped', providersSynced: [], runtimeAuthProvidersSynced: [], openclawAuthProvidersSynced: [],
    }),
    dispatch,
    abort: jest.fn().mockResolvedValue(undefined),
  };
}

async function waitForRuntimeResponse(db: Db, instanceId: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const row = await db.get<{ response: string | null }>('SELECT response FROM job_instances WHERE id = ?', instanceId);
    if (row?.response) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for job instance #${instanceId} runtime response`);
}

const DEV_ONE = 1;
const DEV_TWO = 2;
const REVIEWER = 3;
const OTHER_TASK = 99;
const TASK = 7;

let db: Db;

async function addAgent(id: number, name: string): Promise<void> {
  await db.run(`INSERT INTO agents (id, tenant_id, project_id, name, job_title, job_instructions,
    enabled, session_key, runtime_type, runtime_config, workspace_path)
    VALUES (?, 1, 86, ?, ?, 'Do the task', 1, ?, 'openclaw', '{}', '/tmp')`, id, name, name, `agent:${name.toLowerCase().replace(/\s+/g, '-')}:main`);
}

async function addRule(agentId: number, status: string, priority: number): Promise<void> {
  await db.run(`INSERT INTO workflow_task_routing_rules (tenant_id, workflow_id, project_id, workflow_type, task_type, status, agent_id, priority)
    VALUES (1, 10, 86, 'team', 'backend', ?, ?, ?)`, status, agentId, priority);
}

async function setKeepSameAgent(on: boolean): Promise<void> {
  await db.run(`UPDATE workflow_types SET keep_same_agent = ? WHERE key = 'team'`, on ? 1 : 0);
}

/** Gives an agent a live run on another task, which is what makes the dispatcher treat it as busy. */
async function makeBusy(agentId: number): Promise<void> {
  await db.run(`INSERT INTO job_instances (tenant_id, agent_id, status, task_id) VALUES (1, ?, 'running', ?)`, agentId, OTHER_TASK);
}

async function dispatchedAgentIds(): Promise<number[]> {
  const rows = await db.all<{ agent_id: number }>(`SELECT agent_id FROM job_instances WHERE task_id = ? ORDER BY id`, TASK);
  return rows.map(row => Number(row.agent_id));
}

async function waitingNotes(): Promise<string[]> {
  const rows = await db.all<{ new_value: string }>(`SELECT new_value FROM task_history
    WHERE task_id = ? AND field = 'dispatch_eligibility' ORDER BY id`, TASK);
  return rows.map(row => row.new_value);
}

beforeEach(async () => {
  db = await setupTestDb();
  jest.clearAllMocks();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (86, 1, 'Agent HQ')`);
  await db.run(`INSERT INTO workflow_types (tenant_id, key, name, description, is_system) VALUES (1, 'team', 'Team', '', 0)`);
  await db.run(`INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type, status) VALUES (10, 1, 86, 'Build', 'team', 'active')`);
  await addAgent(DEV_ONE, 'Dev One');
  await addAgent(DEV_TWO, 'Dev Two');
  await addAgent(REVIEWER, 'Reviewer');
  // Dev Two has the higher priority, so plain routing prefers it whenever it is free.
  await addRule(DEV_TWO, 'ready', 120);
  await addRule(DEV_ONE, 'ready', 100);
  await addRule(REVIEWER, 'review', 100);
  await db.run(`INSERT INTO tasks (id, tenant_id, title, status, priority, project_id, workflow_id, task_type)
    VALUES (?, 1, 'Build the endpoint', 'ready', 'medium', 86, 10, 'backend')`, TASK);
  await db.run(`INSERT INTO tasks (id, tenant_id, title, status, priority, project_id, workflow_id, task_type)
    VALUES (?, 1, 'Something else', 'done', 'medium', 86, 10, 'backend')`, OTHER_TASK);
  mockedResolveRuntime.mockReturnValue(mockRuntime(jest.fn(async () => ({ runId: 'runtime-1' }))));
});

afterEach(async () => { await teardownTestDb(); });

describe('dispatch with Keep same agent', () => {
  it('records the agent a launched run went to as the owner of that status', async () => {
    const result = await runDispatcher(db, 86);
    expect(result.dispatched).toBe(1);
    const [instanceId] = (await db.all<{ id: number }>('SELECT id FROM job_instances WHERE task_id = ?', TASK)).map(r => r.id);
    await waitForRuntimeResponse(db, instanceId);
    expect(await getTaskStatusOwner(db, TASK, 'ready')).toMatchObject({ agent_id: DEV_TWO, source: 'dispatch', instance_id: instanceId });
  });

  it('off: a busy owner does not hold the task, the next free eligible agent takes it', async () => {
    await recordTaskStatusOwner(db, { taskId: TASK, status: 'ready', agentId: DEV_ONE, source: 'dispatch' });
    await makeBusy(DEV_ONE);

    expect((await runDispatcher(db, 86)).dispatched).toBe(1);
    expect(await dispatchedAgentIds()).toEqual([DEV_TWO]);
    expect(await waitingNotes()).toEqual([]);
    const [instanceId] = (await db.all<{ id: number }>('SELECT id FROM job_instances WHERE task_id = ?', TASK)).map(r => r.id);
    await waitForRuntimeResponse(db, instanceId);
  });

  it('on: the owner wins over rule priority', async () => {
    await setKeepSameAgent(true);
    await recordTaskStatusOwner(db, { taskId: TASK, status: 'ready', agentId: DEV_ONE, source: 'dispatch' });

    expect((await runDispatcher(db, 86)).dispatched).toBe(1);
    expect(await dispatchedAgentIds()).toEqual([DEV_ONE]);
    const [instanceId] = (await db.all<{ id: number }>('SELECT id FROM job_instances WHERE task_id = ?', TASK)).map(r => r.id);
    await waitForRuntimeResponse(db, instanceId);
  });

  it('on: a busy owner makes the task wait, with the reason in its history, until the owner is free', async () => {
    await setKeepSameAgent(true);
    await recordTaskStatusOwner(db, { taskId: TASK, status: 'ready', agentId: DEV_ONE, source: 'dispatch' });
    await makeBusy(DEV_ONE);

    expect((await runDispatcher(db, 86)).dispatched).toBe(0);
    expect((await runDispatcher(db, 86)).dispatched).toBe(0);
    expect(await dispatchedAgentIds()).toEqual([]);
    expect(await waitingNotes()).toEqual([
      'Waiting for Dev One: Keep same agent is on and Dev One already worked this task in "ready"',
    ]);

    await db.run(`UPDATE job_instances SET status = 'done' WHERE agent_id = ?`, DEV_ONE);
    expect((await runDispatcher(db, 86)).dispatched).toBe(1);
    expect(await dispatchedAgentIds()).toEqual([DEV_ONE]);
    const [instanceId] = (await db.all<{ id: number }>('SELECT id FROM job_instances WHERE task_id = ?', TASK)).map(r => r.id);
    await waitForRuntimeResponse(db, instanceId);
  });

  it('on: a first visit to a status uses normal rule priority', async () => {
    await setKeepSameAgent(true);
    expect((await runDispatcher(db, 86)).dispatched).toBe(1);
    expect(await dispatchedAgentIds()).toEqual([DEV_TWO]);
    const [instanceId] = (await db.all<{ id: number }>('SELECT id FROM job_instances WHERE task_id = ?', TASK)).map(r => r.id);
    await waitForRuntimeResponse(db, instanceId);
  });

  it('on: an owner that can no longer work the status does not hold the task', async () => {
    await setKeepSameAgent(true);
    await recordTaskStatusOwner(db, { taskId: TASK, status: 'ready', agentId: DEV_ONE, source: 'dispatch' });
    await db.run(`UPDATE agents SET enabled = 0 WHERE id = ?`, DEV_ONE);

    expect((await runDispatcher(db, 86)).dispatched).toBe(1);
    expect(await dispatchedAgentIds()).toEqual([DEV_TWO]);
    const [instanceId] = (await db.all<{ id: number }>('SELECT id FROM job_instances WHERE task_id = ?', TASK)).map(r => r.id);
    await waitForRuntimeResponse(db, instanceId);
  });

  it('on: owners are per status, so the reviewer owns review while the developer owns ready', async () => {
    await setKeepSameAgent(true);
    await addRule(DEV_ONE, 'review', 50);
    await recordTaskStatusOwner(db, { taskId: TASK, status: 'ready', agentId: DEV_ONE, source: 'dispatch' });
    await recordTaskStatusOwner(db, { taskId: TASK, status: 'review', agentId: REVIEWER, source: 'dispatch' });
    await db.run(`UPDATE tasks SET status = 'review' WHERE id = ?`, TASK);
    await makeBusy(REVIEWER);

    // Dev One can also review, but Reviewer owns review, so the task waits for Reviewer.
    expect((await runDispatcher(db, 86)).dispatched).toBe(0);
    expect(await dispatchedAgentIds()).toEqual([]);
  });
});

describe('outcome ownership', () => {
  const moveTo = (status: string, agentId: number) =>
    recordOutcomeStatusOwner(db, { taskId: TASK, fromStatus: 'ready', status, agentId, instanceId: null });

  it('the posting agent owns the next status when the same team works it', async () => {
    await addRule(DEV_ONE, 'in_progress', 100);
    await addRule(DEV_TWO, 'in_progress', 100);
    await moveTo('in_progress', DEV_ONE);
    expect(await getTaskStatusOwner(db, TASK, 'in_progress')).toMatchObject({ agent_id: DEV_ONE, source: 'outcome' });
  });

  it('the posting agent does not own a status it cannot work', async () => {
    await moveTo('review', DEV_ONE);
    expect(await getTaskStatusOwner(db, TASK, 'review')).toBeNull();
  });

  it('a developer who can also review does not become the review owner by handing work to review', async () => {
    await addRule(DEV_ONE, 'review', 50);
    await moveTo('review', DEV_ONE);
    expect(await getTaskStatusOwner(db, TASK, 'review')).toBeNull();
  });

  it('an outcome never replaces an existing owner', async () => {
    await addRule(DEV_ONE, 'in_progress', 100);
    await addRule(DEV_TWO, 'in_progress', 100);
    await recordTaskStatusOwner(db, { taskId: TASK, status: 'in_progress', agentId: DEV_TWO, source: 'dispatch' });
    await moveTo('in_progress', DEV_ONE);
    expect(await getTaskStatusOwner(db, TASK, 'in_progress')).toMatchObject({ agent_id: DEV_TWO, source: 'dispatch' });
  });

  it('a status with no assignment rules of its own gets no owner', async () => {
    // No status borrows another status's rules, so nobody can work in_progress here.
    await moveTo('in_progress', DEV_ONE);
    expect(await getTaskStatusOwner(db, TASK, 'in_progress')).toBeNull();
  });
});

describe('reconciler with Keep same agent', () => {
  it('shows the required owner as the assigned agent instead of the top-priority agent', async () => {
    await setKeepSameAgent(true);
    await db.run(`UPDATE tasks SET assigned_agent_id = ? WHERE id = ?`, DEV_TWO, TASK);
    await recordTaskStatusOwner(db, { taskId: TASK, status: 'ready', agentId: DEV_ONE, source: 'dispatch' });

    await reconcileAssignedAgents(db);
    expect(await db.value('SELECT assigned_agent_id FROM tasks WHERE id = ?', TASK)).toBe(DEV_ONE);
  });

  it('off: keeps assigning the top-priority agent', async () => {
    await db.run(`UPDATE tasks SET assigned_agent_id = ? WHERE id = ?`, DEV_ONE, TASK);
    await recordTaskStatusOwner(db, { taskId: TASK, status: 'ready', agentId: DEV_ONE, source: 'dispatch' });

    await reconcileAssignedAgents(db);
    expect(await db.value('SELECT assigned_agent_id FROM tasks WHERE id = ?', TASK)).toBe(DEV_TWO);
  });
});
