import { setupTestDb, teardownTestDb } from '../db/testDb';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import {
  ACTIVE_INSTANCE_END_GRACE_MS,
  cleanupImpossibleTaskLifecycleStates,
  cleanupTaskExecutionLinkageForStatus,
  clearPendingEndedActiveInstanceLinkageCleanupTimers,
  clearEndedActiveInstanceLinkageIfEligible,
  flushPendingEndedActiveInstanceLinkageCleanups,
  scheduleEndedActiveInstanceLinkageCleanup,
} from './taskLifecycle';
import { removeTaskWorktree } from '../services/worktreeManager';
import { removeTaskClone } from '../services/repoWorkspaceManager';
import { type Db } from "../db/adapter/types";

jest.mock('../services/worktreeManager', () => ({
  removeTaskWorktree: jest.fn(({ worktreePath }: { worktreePath: string }) => ({ removed: true, worktreePath })),
}));

jest.mock('../services/repoWorkspaceManager', () => ({
  removeTaskClone: jest.fn(({ workspacePath }: { workspacePath: string }) => ({ removed: true, workspacePath })),
}));

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    spawn: jest.fn(),
  };
});

const mockedRemoveTaskWorktree = removeTaskWorktree as jest.MockedFunction<typeof removeTaskWorktree>;
const mockedRemoveTaskClone = removeTaskClone as jest.MockedFunction<typeof removeTaskClone>;
const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;

// The deferred cleanup is launched from a timer callback, so the only
// deterministic way to observe its result is to await the work itself rather
// than a fixed number of microtask ticks.
async function flushPromises(): Promise<void> {
  await flushPendingEndedActiveInstanceLinkageCleanups();
}

function mockAbortSpawn(): void {
  mockedSpawn.mockImplementation(() => {
    const child = new EventEmitter() as ReturnType<typeof spawn> & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: jest.Mock;
    };
    child.stdout = new EventEmitter() as typeof child.stdout;
    child.stderr = new EventEmitter() as typeof child.stderr;
    child.kill = jest.fn();
    return child;
  });
}

async function createDb(): Promise<Db> {
  const db = await setupTestDb();

  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Test', 'test', 1)`);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1')`);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Test Project')`);
  await db.run(`INSERT INTO sprints (id, tenant_id, project_id, name) VALUES (1, 1, 1, 'Test Sprint')`);

  return db;
}

async function seedLinkedTask(db: Db, params: {
  taskStatus?: string;
  nextAgentTitle?: string;
  instanceStatus?: string;
  activeInstanceId?: number | null;
  worktreePath?: string | null;
} = {}): Promise<void> {
  const {
    taskStatus = 'in_progress',
    nextAgentTitle = 'Builder',
    instanceStatus = 'running',
    activeInstanceId = 10,
    worktreePath = '/tmp/workspaces/task-1',
  } = params;

  await db.run(
    `INSERT INTO agents (id, tenant_id, name, session_key, job_title, repo_path, repo_access_mode)
     VALUES (1, 1, 'Agent', 'agent:test-1:main', ?, '/repo', 'worktree')`,
    nextAgentTitle,
  );
  await db.run(
    `INSERT INTO tasks (id, tenant_id, project_id, sprint_id, title, status, agent_id, active_instance_id)
     VALUES (1, 1, 1, 1, 'Lifecycle task', ?, 1, NULL)`,
    taskStatus,
  );
  await db.run(`
    INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status, session_key, worktree_path)
    VALUES (10, 1, 1, 1, ?, NULL, ?)
  `, instanceStatus, worktreePath);
  if (activeInstanceId !== null) {
    await db.run(`UPDATE tasks SET active_instance_id = ? WHERE id = 1`, activeInstanceId);
  }
}

describe('task lifecycle worktree cleanup', () => {
  let db: Db;

  beforeEach(async () => {
    mockedRemoveTaskWorktree.mockClear();
    mockedRemoveTaskWorktree.mockImplementation(({ worktreePath }) => ({ removed: true, worktreePath }));
    mockedRemoveTaskClone.mockClear();
    mockedRemoveTaskClone.mockImplementation(({ workspacePath }) => ({ removed: true, workspacePath }));
    mockedSpawn.mockReset();
    mockAbortSpawn();

    // node-postgres resolves socket work through microtasks. Jest's modern fake timers include
    // nextTick/queueMicrotask by default, which freezes completed query promises and can leave
    // the template advisory lock held indefinitely. Only lifecycle clocks/timers are under test;
    // keep the driver's microtask queue real for every PostgreSQL query in this suite.
    db = await createDb();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    jest.setSystemTime(new Date('2026-05-01T12:00:00.000Z'));
  });

  afterEach(async () => {
    await flushPromises();
    clearPendingEndedActiveInstanceLinkageCleanupTimers();
    jest.clearAllTimers();
    jest.useRealTimers();
    await teardownTestDb();
  });

  it.each(['failed', 'cancelled', 'ready', 'qa_pass'])('keeps the worktree when a task moves to %s', async (status) => {
    await seedLinkedTask(db, { instanceStatus: 'done' });

    await cleanupTaskExecutionLinkageForStatus(db, 1, status);

    expect(mockedRemoveTaskWorktree).not.toHaveBeenCalled();
  });

  it.each([
    ['review', 'QA Engineer'],
    ['ready_to_merge', 'Release Engineer'],
    ['deployed', 'Release Engineer'],
  ])('keeps the worktree during %s handoff with a live instance', async (status, agentTitle) => {
    await seedLinkedTask(db, { nextAgentTitle: agentTitle, instanceStatus: 'running' });

    await cleanupTaskExecutionLinkageForStatus(db, 1, status);

    expect(mockedRemoveTaskWorktree).not.toHaveBeenCalled();
  });

  it.each(['dev_deploy_queued', 'dev_deploying'])('preserves active instance linkage while task is %s', async (status) => {
    await seedLinkedTask(db, { taskStatus: status, instanceStatus: 'running' });

    const cleared = await cleanupTaskExecutionLinkageForStatus(db, 1, status);

    const task = await db.get(`SELECT active_instance_id FROM tasks WHERE id = 1`) as { active_instance_id: number | null };
    expect(cleared).toBe(false);
    expect(task.active_instance_id).toBe(10);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('keeps the worktree during qa_pass handoff even when execution linkage is cleared', async () => {
    await seedLinkedTask(db, { instanceStatus: 'done' });

    await cleanupTaskExecutionLinkageForStatus(db, 1, 'qa_pass');

    expect(mockedRemoveTaskWorktree).not.toHaveBeenCalled();
    const task = await db.get(`SELECT active_instance_id FROM tasks WHERE id = 1`) as { active_instance_id: number | null };
    expect(task.active_instance_id).toBeNull();
  });

  it('removes all known repo task workspaces when the task becomes done', async () => {
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, job_title, repo_path, repo_access_mode) VALUES (1, 1, 'Agent', 'agent:test-1:main', 'Builder', '/repo', 'worktree')`);
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, job_title, repo_path, repo_access_mode) VALUES (2, 1, 'Agent 2', 'agent:test-2:main', 'Builder', NULL, 'clone')`);
    await db.run(`INSERT INTO tasks (id, tenant_id, project_id, sprint_id, title, status, agent_id, active_instance_id) VALUES (1, 1, 1, 1, 'Lifecycle task', 'deployed', 1, NULL)`);
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status, worktree_path)
      VALUES
        (10, 1, 1, 1, 'done', '/tmp/workspaces/task-1'),
        (11, 1, 1, 1, 'failed', '/tmp/workspaces/task-1'),
        (12, 1, 1, 1, 'done', '/tmp/workspaces/task-1-retry'),
        (13, 1, 2, 1, 'done', '/tmp/workspaces/no-repo'),
        (14, 1, 1, NULL, 'failed', '/tmp/workspaces/agent-hq-task-1')
    `);

    await cleanupTaskExecutionLinkageForStatus(db, 1, 'done');

    expect(mockedRemoveTaskWorktree).toHaveBeenCalledTimes(3);
    expect(mockedRemoveTaskWorktree).toHaveBeenCalledWith({ repoPath: '/repo', worktreePath: '/tmp/workspaces/task-1' });
    expect(mockedRemoveTaskWorktree).toHaveBeenCalledWith({ repoPath: '/repo', worktreePath: '/tmp/workspaces/task-1-retry' });
    expect(mockedRemoveTaskWorktree).toHaveBeenCalledWith({ repoPath: '/repo', worktreePath: '/tmp/workspaces/agent-hq-task-1' });
    expect(mockedRemoveTaskClone).toHaveBeenCalledWith({ workspacePath: '/tmp/workspaces/no-repo' });
  });

  it('removes clone-backed task workspaces with removeTaskClone', async () => {
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, job_title, repo_path, repo_access_mode) VALUES (3, 1, 'Clone Agent', 'agent:test-3:main', 'Builder', NULL, 'clone')`);
    await db.run(`INSERT INTO tasks (id, tenant_id, project_id, sprint_id, title, status, agent_id, active_instance_id) VALUES (77, 1, 1, 1, 'Clone cleanup', 'done', 3, NULL)`);
    await db.run(`INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status, worktree_path) VALUES (77, 1, 3, 77, 'done', '/tmp/task-77')`);

    await cleanupTaskExecutionLinkageForStatus(db, 77, 'done');

    expect(mockedRemoveTaskClone).toHaveBeenCalledWith({ workspacePath: '/tmp/task-77' });
  });

  it('cleans worktree-backed runs from payload repo metadata when agent repo fields are empty', async () => {
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, job_title, repo_path, repo_access_mode) VALUES (4, 1, 'Project Repo Agent', 'agent:test-4:main', 'Builder', NULL, NULL)`);
    await db.run(`INSERT INTO tasks (id, tenant_id, project_id, sprint_id, title, status, agent_id, active_instance_id) VALUES (88, 1, 1, 1, 'Payload cleanup', 'done', 4, NULL)`);
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status, worktree_path, payload_sent)
      VALUES (88, 1, 4, 88, 'done', '/tmp/task-88', ?)
    `, JSON.stringify({
            repoAccessMode: 'worktree',
            repoSource: 'worktree:/projects/agent-hq',
          }));

    await cleanupTaskExecutionLinkageForStatus(db, 88, 'done');

    expect(mockedRemoveTaskWorktree).toHaveBeenCalledWith({
      repoPath: '/projects/agent-hq',
      worktreePath: '/tmp/task-88',
    });
  });

  it('keeps repeated done cleanup calls harmless', async () => {
    await seedLinkedTask(db, { taskStatus: 'done', activeInstanceId: null, instanceStatus: 'done' });

    await expect(cleanupTaskExecutionLinkageForStatus(db, 1, 'done')).resolves.toBeDefined();
    await expect(cleanupTaskExecutionLinkageForStatus(db, 1, 'done')).resolves.toBeDefined();

    expect(mockedRemoveTaskWorktree).toHaveBeenCalledTimes(2);
  });

  it('keeps an ended active instance linked until the grace window elapses', async () => {
    await seedLinkedTask(db, { taskStatus: 'review', instanceStatus: 'done' });
    const nowIso = new Date().toISOString();
    await db.run(`
      UPDATE job_instances
      SET runtime_ended_at = ?
      WHERE id = 10
    `, nowIso);

    expect(await clearEndedActiveInstanceLinkageIfEligible(db, 1, 10)).toBe(false);

    await scheduleEndedActiveInstanceLinkageCleanup(db, 1, 10, { changedBy: 'task_lifecycle' });
    jest.advanceTimersByTime(ACTIVE_INSTANCE_END_GRACE_MS - 1);

    let task = await db.get(`SELECT active_instance_id FROM tasks WHERE id = 1`) as { active_instance_id: number | null };
    expect(task.active_instance_id).toBe(10);

    jest.advanceTimersByTime(1);
    await flushPromises();
    task = await db.get(`SELECT active_instance_id FROM tasks WHERE id = 1`) as { active_instance_id: number | null };
    expect(task.active_instance_id).toBeNull();
  });

  it('does not clear linkage for a newer replacement run after scheduling cleanup for the older run', async () => {
    await seedLinkedTask(db, { taskStatus: 'review', instanceStatus: 'done' });
    const nowIso = new Date().toISOString();
    await db.run(`
      UPDATE job_instances
      SET runtime_ended_at = ?
      WHERE id = 10
    `, nowIso);
    await db.run(`INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status) VALUES (11, 1, 1, 1, 'running')`);

    await scheduleEndedActiveInstanceLinkageCleanup(db, 1, 10, { changedBy: 'task_lifecycle' });
    await db.run(`UPDATE tasks SET active_instance_id = 11 WHERE id = 1`);

    jest.advanceTimersByTime(ACTIVE_INSTANCE_END_GRACE_MS + 1);
    await flushPromises();

    const task = await db.get(`SELECT active_instance_id FROM tasks WHERE id = 1`) as { active_instance_id: number | null };
    expect(task.active_instance_id).toBe(11);
  });

  it('reconciler fallback preserves ended linkage during grace and clears it afterward', async () => {
    await seedLinkedTask(db, { taskStatus: 'review', instanceStatus: 'done' });
    const nowIso = new Date().toISOString();
    await db.run(`
      UPDATE job_instances
      SET runtime_ended_at = ?
      WHERE id = 10
    `, nowIso);

    expect(await cleanupImpossibleTaskLifecycleStates(db)).toBe(0);
    let task = await db.get(`SELECT active_instance_id FROM tasks WHERE id = 1`) as { active_instance_id: number | null };
    expect(task.active_instance_id).toBe(10);

    jest.advanceTimersByTime(ACTIVE_INSTANCE_END_GRACE_MS + 1);
    await flushPromises();

    expect(await cleanupImpossibleTaskLifecycleStates(db)).toBe(1);
    task = await db.get(`SELECT active_instance_id FROM tasks WHERE id = 1`) as { active_instance_id: number | null };
    expect(task.active_instance_id).toBeNull();
  });

  it('reconciler fallback preserves live linkage while a dispatched task is still ready', async () => {
    await seedLinkedTask(db, { taskStatus: 'ready', instanceStatus: 'dispatched' });

    expect(await cleanupImpossibleTaskLifecycleStates(db)).toBe(0);

    const task = await db.get(`SELECT active_instance_id FROM tasks WHERE id = 1`) as { active_instance_id: number | null };
    expect(task.active_instance_id).toBe(10);
  });

  it('finalizes a detached running instance as successful after semantic task handoff grace', async () => {
    await seedLinkedTask(db, { taskStatus: 'in_progress', instanceStatus: 'running' });
    await db.run(`
      UPDATE job_instances
      SET session_key = 'run:10:abc',
          lifecycle_outcome_posted_at = ?,
          task_outcome = 'completed_for_review'
      WHERE id = 10
    `, new Date().toISOString());

    await cleanupTaskExecutionLinkageForStatus(db, 1, 'review', {
            deferEndedActiveInstanceCleanup: true,
            authoritativeInstanceId: 10,
            changedBy: 'task_lifecycle',
          });

    let task = await db.get(`SELECT active_instance_id FROM tasks WHERE id = 1`) as { active_instance_id: number | null };
    expect(task.active_instance_id).toBe(10);

    jest.advanceTimersByTime(ACTIVE_INSTANCE_END_GRACE_MS + 1);
    await flushPromises();

    const instance = await db.get(`
      SELECT status, runtime_ended_at, runtime_end_success, runtime_end_source, semantic_outcome_missing
      FROM job_instances
      WHERE id = 10
    `) as {
      status: string;
      runtime_ended_at: string | null;
      runtime_end_success: number | null;
      runtime_end_source: string | null;
      semantic_outcome_missing: number;
    };
    task = await db.get(`SELECT active_instance_id FROM tasks WHERE id = 1`) as { active_instance_id: number | null };

    expect(instance.status).toBe('done');
    expect(instance.runtime_ended_at).toBeTruthy();
    expect(instance.runtime_end_success).toBe(1);
    expect(instance.runtime_end_source).toBe('task_transition');
    expect(instance.semantic_outcome_missing).toBe(0);
    expect(task.active_instance_id).toBeNull();
  });

  it('does not re-finalize an instance that already recorded runtime end before detached cleanup', async () => {
    await seedLinkedTask(db, { taskStatus: 'in_progress', instanceStatus: 'done' });
    await db.run(`
      UPDATE job_instances
      SET session_key = 'run:10:abc',
          runtime_ended_at = ?,
          runtime_end_success = 1,
          runtime_end_source = 'openclaw_runtime',
          lifecycle_outcome_posted_at = ?,
          task_outcome = 'completed_for_review'
      WHERE id = 10
    `, new Date().toISOString(), new Date().toISOString());

    await cleanupTaskExecutionLinkageForStatus(db, 1, 'review', {
            deferEndedActiveInstanceCleanup: true,
            authoritativeInstanceId: 10,
            changedBy: 'task_lifecycle',
          });

    jest.advanceTimersByTime(ACTIVE_INSTANCE_END_GRACE_MS + 1);
    await flushPromises();

    const instance = await db.get(`
      SELECT status, runtime_end_source
      FROM job_instances
      WHERE id = 10
    `) as { status: string; runtime_end_source: string | null };
    const task = await db.get(`SELECT active_instance_id FROM tasks WHERE id = 1`) as { active_instance_id: number | null };

    expect(instance.status).toBe('done');
    expect(instance.runtime_end_source).toBe('openclaw_runtime');
    expect(task.active_instance_id).toBeNull();
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('aborts a still-live gateway session after task-transition runtime finalization', async () => {
    await seedLinkedTask(db, { taskStatus: 'in_progress', instanceStatus: 'running' });
    await db.run(`
      UPDATE job_instances
      SET session_key = 'run:10:abc',
          lifecycle_outcome_posted_at = ?,
          task_outcome = 'completed_for_review'
      WHERE id = 10
    `, new Date().toISOString());

    await cleanupTaskExecutionLinkageForStatus(db, 1, 'review', {
            deferEndedActiveInstanceCleanup: true,
            authoritativeInstanceId: 10,
            changedBy: 'task_lifecycle',
          });

    jest.advanceTimersByTime(ACTIVE_INSTANCE_END_GRACE_MS + 1);
    await flushPromises();

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const args = mockedSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('chat.abort');
    expect(args).toContain(JSON.stringify({ sessionKey: 'run:10:abc' }));
  });
});
