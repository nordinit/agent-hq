import Database from 'better-sqlite3';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import {
  ACTIVE_INSTANCE_END_GRACE_MS,
  cleanupImpossibleTaskLifecycleStates,
  cleanupTaskExecutionLinkageForStatus,
  clearPendingEndedActiveInstanceLinkageCleanupTimers,
  clearEndedActiveInstanceLinkageIfEligible,
  scheduleEndedActiveInstanceLinkageCleanup,
} from './taskLifecycle';
import { removeTaskWorktree } from '../services/worktreeManager';
import { removeTaskClone } from '../services/repoWorkspaceManager';
import { type Db } from "../db/adapter/types";
import { SqliteAdapter } from "../db/adapter/SqliteAdapter";

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

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
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
  const dbRaw = new Database(':memory:');
    const db = new SqliteAdapter(dbRaw);
  await db.exec(`
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT,
      job_title TEXT,
      repo_path TEXT,
      repo_access_mode TEXT
    );

    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      title TEXT,
      status TEXT NOT NULL,
      task_type TEXT,
      sprint_id INTEGER,
      project_id INTEGER,
      agent_id INTEGER,
      active_instance_id INTEGER,
      updated_at TEXT
    );

    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      agent_id INTEGER,
      task_id INTEGER,
      status TEXT NOT NULL,
      session_key TEXT,
      worktree_path TEXT,
      payload_sent TEXT,
      abort_attempted_at TEXT,
      abort_status TEXT,
      abort_error TEXT,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      runtime_ended_at TEXT,
      runtime_end_success INTEGER,
      runtime_end_error TEXT,
      runtime_end_source TEXT,
      runtime_completed_at TEXT,
      lifecycle_handoff_status TEXT,
      semantic_outcome_missing INTEGER NOT NULL DEFAULT 0,
      lifecycle_outcome_posted_at TEXT,
      task_outcome TEXT,
      token_input INTEGER,
      token_output INTEGER,
      token_total INTEGER
    );

    CREATE TABLE sprints (
      id INTEGER PRIMARY KEY,
      sprint_type TEXT
    );

    CREATE TABLE instance_artifacts (
      instance_id INTEGER PRIMARY KEY,
      task_id INTEGER,
      current_stage TEXT,
      summary TEXT,
      latest_commit_hash TEXT,
      branch_name TEXT,
      changed_files_json TEXT,
      changed_files_count INTEGER,
      blocker_reason TEXT,
      outcome TEXT,
      last_agent_heartbeat_at TEXT,
      last_meaningful_output_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      stale INTEGER,
      stale_at TEXT,
      session_key TEXT,
      updated_at TEXT,
      last_note_at TEXT
    );

    CREATE TABLE task_notes (
      id INTEGER PRIMARY KEY,
      task_id INTEGER,
      author TEXT,
      content TEXT
    );

    CREATE TABLE task_history (
      id INTEGER PRIMARY KEY,
      task_id INTEGER,
      changed_by TEXT,
      field TEXT,
      old_value TEXT,
      new_value TEXT
    );
  `);
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

  await db.run(`INSERT INTO agents (id, name, job_title, repo_path, repo_access_mode) VALUES (1, 'Agent', ?, '/repo', 'worktree')`, nextAgentTitle);
  await db.run(`INSERT INTO tasks (id, status, agent_id, active_instance_id) VALUES (1, ?, 1, ?)`, taskStatus, activeInstanceId);
  await db.run(`
    INSERT INTO job_instances (id, agent_id, task_id, status, session_key, worktree_path)
    VALUES (10, 1, 1, ?, NULL, ?)
  `, instanceStatus, worktreePath);
}

describe('task lifecycle worktree cleanup', () => {
  let db: Db;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-01T12:00:00.000Z'));
    mockedRemoveTaskWorktree.mockClear();
    mockedRemoveTaskWorktree.mockImplementation(({ worktreePath }) => ({ removed: true, worktreePath }));
    mockedRemoveTaskClone.mockClear();
    mockedRemoveTaskClone.mockImplementation(({ workspacePath }) => ({ removed: true, workspacePath }));
    mockedSpawn.mockReset();
    mockAbortSpawn();
    db = await createDb();
  });

  afterEach(async () => {
    await flushPromises();
    clearPendingEndedActiveInstanceLinkageCleanupTimers();
    jest.clearAllTimers();
    jest.useRealTimers();
    await db.close();
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
    await db.run(`INSERT INTO agents (id, name, job_title, repo_path, repo_access_mode) VALUES (1, 'Agent', 'Builder', '/repo', 'worktree')`);
    await db.run(`INSERT INTO agents (id, name, job_title, repo_path, repo_access_mode) VALUES (2, 'Agent 2', 'Builder', NULL, 'clone')`);
    await db.run(`INSERT INTO tasks (id, status, agent_id, active_instance_id) VALUES (1, 'deployed', 1, NULL)`);
    await db.run(`
      INSERT INTO job_instances (id, agent_id, task_id, status, worktree_path)
      VALUES
        (10, 1, 1, 'done', '/tmp/workspaces/task-1'),
        (11, 1, 1, 'failed', '/tmp/workspaces/task-1'),
        (12, 1, 1, 'done', '/tmp/workspaces/task-1-retry'),
        (13, 2, 1, 'done', '/tmp/workspaces/no-repo'),
        (14, 1, NULL, 'failed', '/tmp/workspaces/agent-hq-task-1')
    `);

    await cleanupTaskExecutionLinkageForStatus(db, 1, 'done');

    expect(mockedRemoveTaskWorktree).toHaveBeenCalledTimes(3);
    expect(mockedRemoveTaskWorktree).toHaveBeenCalledWith({ repoPath: '/repo', worktreePath: '/tmp/workspaces/task-1' });
    expect(mockedRemoveTaskWorktree).toHaveBeenCalledWith({ repoPath: '/repo', worktreePath: '/tmp/workspaces/task-1-retry' });
    expect(mockedRemoveTaskWorktree).toHaveBeenCalledWith({ repoPath: '/repo', worktreePath: '/tmp/workspaces/agent-hq-task-1' });
    expect(mockedRemoveTaskClone).toHaveBeenCalledWith({ workspacePath: '/tmp/workspaces/no-repo' });
  });

  it('removes clone-backed task workspaces with removeTaskClone', async () => {
    await db.run(`INSERT INTO agents (id, name, job_title, repo_path, repo_access_mode) VALUES (3, 'Clone Agent', 'Builder', NULL, 'clone')`);
    await db.run(`INSERT INTO tasks (id, status, agent_id, active_instance_id) VALUES (77, 'done', 3, NULL)`);
    await db.run(`INSERT INTO job_instances (id, agent_id, task_id, status, worktree_path) VALUES (77, 3, 77, 'done', '/tmp/task-77')`);

    await cleanupTaskExecutionLinkageForStatus(db, 77, 'done');

    expect(mockedRemoveTaskClone).toHaveBeenCalledWith({ workspacePath: '/tmp/task-77' });
  });

  it('cleans worktree-backed runs from payload repo metadata when agent repo fields are empty', async () => {
    await db.run(`INSERT INTO agents (id, name, job_title, repo_path, repo_access_mode) VALUES (4, 'Project Repo Agent', 'Builder', NULL, NULL)`);
    await db.run(`INSERT INTO tasks (id, status, agent_id, active_instance_id) VALUES (88, 'done', 4, NULL)`);
    await db.run(`
      INSERT INTO job_instances (id, agent_id, task_id, status, worktree_path, payload_sent)
      VALUES (88, 4, 88, 'done', '/tmp/task-88', ?)
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

    expect(async () => await cleanupTaskExecutionLinkageForStatus(db, 1, 'done')).not.toThrow();
    expect(async () => await cleanupTaskExecutionLinkageForStatus(db, 1, 'done')).not.toThrow();

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
    await db.run(`INSERT INTO job_instances (id, agent_id, task_id, status) VALUES (11, 1, 1, 'running')`);

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
