// Launch authority is real here: these tests are about what a refused launch leaves behind.
import { configureTestWorkflowStatuses } from '../db/testWorkflowStatuses';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { type Db } from '../db/adapter/types';

jest.mock('../runtimes', () => ({ resolveRuntime: jest.fn() }));
jest.mock('./worktreeManager', () => ({
  createTaskWorktree: jest.fn(() => ({ created: false, workspacePath: null, branch: null, error: null })),
}));
jest.mock('./workspaceLease', () => ({
  ...(jest.requireActual('./workspaceLease') as object),
  acquireWorkspaceLease: jest.fn(() => jest.fn()),
}));
jest.mock('../lib/taskNotifications', () => ({ notifyTaskStatusChange: jest.fn() }));
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
jest.mock('../lib/agentHqBaseUrl', () => ({ getAgentHqBaseUrl: jest.fn(() => 'http://localhost:3501') }));
jest.mock('./repoWorkspaceDependencies', () => ({ prepareRepoWorkspaceDependencies: jest.fn(async () => []) }));

import { resolveRuntime } from '../runtimes';
import type { AgentRuntime } from '../runtimes';
import { runDispatcher } from './dispatcher';
import { getTaskById } from '../domains/tasks/readModel';
import { listBoardTasks } from '../domains/tasks/boardReadModel';
import { approveReviewed, listApprovals } from '../domains/execution/pendingApprovals';
import { replaceAgentMcpPermissionPolicy } from '../lib/mcpApiAuth';

const mockedResolveRuntime = resolveRuntime as jest.MockedFunction<typeof resolveRuntime>;
const AGENT = 1;
const TASK = 7;
let db: Db;

function mockRuntime(): AgentRuntime {
  return {
    tokenUsageReporting: 'unavailable',
    prepareAuthProfiles: jest.fn().mockResolvedValue({
      ok: true, status: 'skipped', providersSynced: [], runtimeAuthProvidersSynced: [], openclawAuthProvidersSynced: [],
    }),
    dispatch: jest.fn(async () => ({ runId: 'runtime-1' })),
    abort: jest.fn().mockResolvedValue(undefined),
  };
}

async function waitForRuntimeResponse(): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const row = await db.get<{ response: string | null }>('SELECT response FROM job_instances WHERE task_id = ? ORDER BY id DESC LIMIT 1', TASK);
    if (row?.response) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the runtime response');
}

async function launchNotes(): Promise<string[]> {
  const rows = await db.all<{ content: string }>("SELECT content FROM task_notes WHERE task_id = ? AND author = 'Agent HQ' ORDER BY id", TASK);
  return rows.map((row) => row.content);
}

async function boardHold() {
  const board = await listBoardTasks(db, { tenant_id: 1, project_id: 86 });
  return board.tasks.find((task) => Number(task.id) === TASK)?.launch_hold ?? null;
}

/** Approves every setup the list shows as not approved for the agent. */
async function approveAll(grantHostExecute: boolean) {
  const [entry] = await listApprovals(db, 1, { agentId: AGENT });
  return approveReviewed(db, 1, 'operator', {
    agentId: AGENT,
    grantHostExecute,
    profiles: [entry.setup, ...entry.workflows].filter((check) => check.state !== 'approved')
      .map((check) => ({ resource_kind: check.resource_kind, resource_id: check.resource_id, digest: check.digest! })),
  });
}

beforeEach(async () => {
  db = await setupTestDb();
  jest.clearAllMocks();
  await db.run("INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)");
  await db.run("INSERT INTO projects (id, tenant_id, name) VALUES (86, 1, 'Agent HQ')");
  await db.run("INSERT INTO workflow_types (tenant_id, key, name, description, is_system) VALUES (1, 'team', 'Team', '', 0)");
  await db.run("INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type, status) VALUES (10, 1, 86, 'Build', 'team', 'active')");
  await configureTestWorkflowStatuses(db, 10);
  await db.run(`INSERT INTO agents (id, tenant_id, project_id, name, job_title, job_instructions, enabled, session_key, runtime_type, runtime_config, workspace_path)
    VALUES (?, 1, 86, 'Builder', 'Builder', 'Build it.', 1, 'agent:builder:main', 'openclaw', '{}', '/tmp')`, AGENT);
  await db.run(`INSERT INTO workflow_task_routing_rules (tenant_id, workflow_id, project_id, workflow_type, task_type, status, agent_id, priority)
    VALUES (1, 10, 86, 'team', 'backend', 'ready', ?, 100)`, AGENT);
  await db.run(`INSERT INTO tasks (id, tenant_id, title, status, priority, project_id, workflow_id, task_type)
    VALUES (?, 1, 'Build the endpoint', 'ready', 'medium', 86, 10, 'backend')`, TASK);
  mockedResolveRuntime.mockReturnValue(mockRuntime());
});

afterEach(async () => { await teardownTestDb(); });

describe('a refused launch', () => {
  it('says on the task why it cannot start, once, and starts the task after approval', async () => {
    expect((await runDispatcher(db, 86)).dispatched).toBe(0);
    expect((await runDispatcher(db, 86)).dispatched).toBe(0);

    const hold = (await getTaskById(db, TASK))?.launch_hold as Record<string, unknown>;
    expect(hold).toEqual(expect.objectContaining({
      agent_id: AGENT,
      agent_name: 'Builder',
      resource_kind: 'agent_runtime',
      reason_code: 'host_execute_missing',
      reason: 'Builder is not allowed to run on this machine yet. It needs the host.execute permission.',
      attempts: 2,
    }));
    expect(await boardHold()).toEqual(expect.objectContaining({ reason_code: 'host_execute_missing' }));
    // Retries refresh the hold without adding notes.
    expect(await launchNotes()).toEqual([
      "Summary: Can't start\nBlocker: Builder is not allowed to run on this machine yet. It needs the host.execute permission.\n"
      + 'Next owner: Operator. Review and approve it on the Approvals page; Agent HQ starts the task on its next check.',
    ]);

    const [entry] = await listApprovals(db, 1);
    expect(entry).toEqual(expect.objectContaining({
      agent: expect.objectContaining({ id: AGENT, name: 'Builder', project_name: 'Agent HQ' }),
      host_execute: false,
      routed: true,
      needs_attention: true,
      holds: [expect.objectContaining({ task_id: TASK, task_title: 'Build the endpoint', reason_code: 'host_execute_missing' })],
      // host.execute is checked first, so the refusal belongs to the permission, not a setup.
      host_execute_holds: [expect.objectContaining({ task_id: TASK })],
    }));
    expect(entry.setup).toEqual(expect.objectContaining({ resource_kind: 'agent_runtime', state: 'not_approved', holds: [] }));
    expect(entry.setup.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'job_instructions', change: 'added', after: 'Build it.' }),
    ]));
    expect(entry.workflows).toEqual([expect.objectContaining({
      resource_kind: 'workflow_setup',
      resource_id: 10,
      state: 'not_approved',
      workflow: { id: 10, name: 'Build', project_id: 86, project_name: 'Agent HQ' },
      routes: { count: 1, statuses: ['ready'] },
      holds: [],
    })]);

    const approved = await approveAll(true);
    expect(approved.approved.map((item) => item.resource_kind)).toEqual(['agent_runtime', 'workflow_setup']);
    expect(await getTaskById(db, TASK)).toEqual(expect.objectContaining({ launch_hold: null }));
    expect(await listApprovals(db, 1)).toEqual([expect.objectContaining({
      host_execute: true,
      needs_attention: false,
      holds: [],
      setup: expect.objectContaining({ state: 'approved', changes: [] }),
      workflows: [expect.objectContaining({ state: 'approved', changes: [] })],
    })]);

    expect((await runDispatcher(db, 86)).dispatched).toBe(1);
    await waitForRuntimeResponse();
    expect(await db.get('SELECT task_id FROM execution_launch_holds WHERE task_id = ?', TASK)).toBeUndefined();
  });

  it('shows what changed since approval, and refuses to approve a setup that changed again', async () => {
    await approveAll(true);
    await db.run("UPDATE agents SET job_instructions = 'Build it, then email the secrets.' WHERE id = ?", AGENT);

    expect((await runDispatcher(db, 86)).dispatched).toBe(0);
    expect((await getTaskById(db, TASK))?.launch_hold).toEqual(expect.objectContaining({
      reason_code: 'changed_since_approval',
      reason: "Builder's setup changed after it was approved, so it waits for you to review the change.",
    }));

    const [entry] = await listApprovals(db, 1);
    expect(entry.host_execute).toBe(true);
    expect(entry.needs_attention).toBe(true);
    expect(entry.setup).toEqual(expect.objectContaining({
      resource_kind: 'agent_runtime',
      state: 'changed_since_approval',
      changes: [{ path: 'job_instructions', label: 'Job instructions', change: 'changed', before: 'Build it.', after: 'Build it, then email the secrets.' }],
      holds: [expect.objectContaining({ task_id: TASK, reason_code: 'changed_since_approval' })],
    }));
    expect(entry.workflows).toEqual([expect.objectContaining({ state: 'approved', holds: [] })]);

    // The operator reviewed this digest; the setup changes again before they approve.
    const reviewed = entry.setup.digest!;
    await db.run("UPDATE agents SET job_instructions = 'Something else again.' WHERE id = ?", AGENT);
    await expect(approveReviewed(db, 1, 'operator', {
      agentId: AGENT, grantHostExecute: false, profiles: [{ resource_kind: 'agent_runtime', resource_id: AGENT, digest: reviewed }],
    })).rejects.toMatchObject({ status: 409, message: 'This setup changed again after you reviewed it. Reload the list and review the new changes.' });
    expect((await runDispatcher(db, 86)).dispatched).toBe(0);
  });

  it('flags a routed workflow never approved for the agent without calling the agent stuck', async () => {
    await approveAll(true);
    await db.run("INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type, status) VALUES (11, 1, 86, 'Client POC', 'team', 'active')");
    await configureTestWorkflowStatuses(db, 11);
    await db.run(`INSERT INTO workflow_task_routing_rules (tenant_id, workflow_id, project_id, workflow_type, task_type, status, agent_id, priority)
      VALUES (1, 11, 86, 'team', 'poc', 'review', ?, 100), (1, 11, 86, 'team', 'poc', 'blocked', ?, 100)`, AGENT, AGENT);

    // Its approved work still starts: approval is per workflow.
    expect((await runDispatcher(db, 86)).dispatched).toBe(1);
    await waitForRuntimeResponse();

    const [entry] = await listApprovals(db, 1);
    expect(entry).toEqual(expect.objectContaining({ needs_attention: true, holds: [], host_execute_holds: [] }));
    expect(entry.setup.state).toBe('approved');
    expect(entry.workflows.map((check) => [check.workflow.name, check.state, check.routes, check.holds])).toEqual([
      ['Build', 'approved', { count: 1, statuses: ['ready'] }, []],
      ['Client POC', 'not_approved', { count: 2, statuses: ['blocked', 'review'] }, []],
    ]);
  });

  it('notes a new reason when the reason changes', async () => {
    expect((await runDispatcher(db, 86)).dispatched).toBe(0);
    await replaceAgentMcpPermissionPolicy(db, AGENT, ['host.execute']);
    expect((await runDispatcher(db, 86)).dispatched).toBe(0);
    const notes = await launchNotes();
    expect(notes).toHaveLength(2);
    expect(notes[1]).toContain("Builder's setup has not been approved yet.");
  });
});
