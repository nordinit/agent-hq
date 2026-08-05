import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { closeActiveInstanceAfterSemanticHandoff } from './instanceClose';
import { type Db } from "../../db/adapter/types";

jest.mock('../../runtimes/OpenClawRuntime', () => ({
  abortChatRunBySessionKey: jest.fn(() => ({ ok: true, status: 'aborted' })),
}));

jest.mock('../../services/browserPool', () => ({
  destroyAgentContext: jest.fn(() => Promise.resolve()),
}));

const TENANT_ID = 8801;
const PROJECT_ID = 8802;
const SPRINT_ID = 8803;
const AGENT_ID = 7;

/**
 * The owning tenant/project/workflow chain, which the old hand-written schema did without.
 * tasks.sprint_id is NOT NULL and foreign-keyed to sprints, so a task cannot be seeded without
 * one, and sprints in turn needs a project and a tenant.
 *
 * Ids are deliberately far from 1: on SQLite the fixture builds the schema with initSchema, which
 * seeds its own default tenant and project, and low explicit ids would collide with them.
 */
async function seedTenantScope(db: Db): Promise<void> {
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (?, 'Semantic Handoff', 'semantic-handoff', 0)`, TENANT_ID);
  await db.run(`INSERT INTO projects (id, tenant_id, name, description, context_md) VALUES (?, ?, 'Semantic Handoff', '', '')`, PROJECT_ID, TENANT_ID);
  await db.run(`
    INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value)
    VALUES (?, ?, ?, 'Handoff', '', 'generic', 'active', 'time', '2w')
  `, SPRINT_ID, TENANT_ID, PROJECT_ID);
  await db.run(`
    INSERT INTO agents (id, tenant_id, name, job_title, session_key, workspace_path)
    VALUES (?, ?, 'Vulcan', 'Backend', 'agent:vulcan-backend:local', '')
  `, AGENT_ID, TENANT_ID);
}

async function insertTask(db: Db, taskId: number, status: string): Promise<void> {
  await db.run(`
    INSERT INTO tasks (id, tenant_id, project_id, sprint_id, title, status, agent_id, active_instance_id, updated_at)
    VALUES (?, ?, ?, ?, 'Task', ?, ?, NULL, datetime('now'))
  `, taskId, TENANT_ID, PROJECT_ID, SPRINT_ID, status, AGENT_ID);
}

async function seedTaskAndInstance(db: Db, options?: {
  taskId?: number;
  instanceId?: number;
  instanceTaskId?: number;
  taskStatus?: string;
  instanceStatus?: string;
  activeInstanceId?: number | null;
  runtimeEndedAt?: string | null;
}): Promise<void> {
  const taskId = options?.taskId ?? 731;
  const instanceId = options?.instanceId ?? 4702;
  const instanceTaskId = options?.instanceTaskId ?? taskId;
  const activeInstanceId = options?.activeInstanceId === undefined ? instanceId : options.activeInstanceId;

  await insertTask(db, taskId, options?.taskStatus ?? 'review');
  // The cross-task case points the instance at a task id that is not the one under test.
  // job_instances.task_id is a real foreign key here, so that other task has to exist.
  if (instanceTaskId !== taskId) {
    await insertTask(db, instanceTaskId, 'review');
  }

  await db.run(`
    INSERT INTO job_instances (id, task_id, agent_id, status, session_key, runtime_ended_at, started_at)
    VALUES (?, ?, ?, ?, NULL, ?, datetime('now'))
  `, instanceId, instanceTaskId, AGENT_ID, options?.instanceStatus ?? 'running', options?.runtimeEndedAt ?? null);

  // tasks.active_instance_id and job_instances.task_id reference each other, so the link is made
  // after both rows exist rather than in the tasks INSERT.
  if (activeInstanceId !== null) {
    await db.run(`UPDATE tasks SET active_instance_id = ? WHERE id = ?`, activeInstanceId, taskId);
  }
}

describe('closeActiveInstanceAfterSemanticHandoff', () => {
  let db: Db;

  beforeEach(async () => {
    // setupTestDb() picks the engine from AGENT_HQ_TEST_PG_URL, so this file runs unchanged on
    // SQLite and on PostgreSQL, against the real schema either way.
    db = await setupTestDb();
    await seedTenantScope(db);
  });

  afterEach(async () => {
    await teardownTestDb();
    jest.clearAllMocks();
  });

  it('closes the same-task active instance by reusing closeInstance behavior without changing task status', async () => {
    await seedTaskAndInstance(db, { instanceStatus: 'running' });

    const result = await closeActiveInstanceAfterSemanticHandoff({
      db,
      taskId: 731,
      outcome: 'completed_for_review',
      summary: 'External event already posted the semantic handoff',
      changedBy: 'dev-env-lease-manager',
      source: 'external_task_event',
    });

    expect(result).toEqual({ closed: true, reason: 'closed', instanceId: 4702 });
    const instance = await db.get(`SELECT status, runtime_ended_at, runtime_end_success, runtime_end_source FROM job_instances WHERE id = 4702`) as {
      status: string;
      runtime_ended_at: string | null;
      runtime_end_success: number | null;
      runtime_end_source: string | null;
    };
    expect(instance.status).toBe('done');
    expect(instance.runtime_ended_at).toBeTruthy();
    expect(instance.runtime_end_success).toBe(1);
    expect(instance.runtime_end_source).toBe('task_outcome_auto_close');

    const task = await db.get(`SELECT status, active_instance_id FROM tasks WHERE id = 731`) as { status: string; active_instance_id: number | null };
    expect(task.status).toBe('review');
    expect(task.active_instance_id).toBe(4702);

    const note = await db.get(`SELECT content FROM task_notes WHERE task_id = 731 ORDER BY id DESC LIMIT 1`) as { content: string };
    expect(note.content).toContain('Agent check-in: Run completed');
    expect(note.content).toContain('Outcome: completed_for_review');
  });

  it('refuses to close an instance that belongs to a different task', async () => {
    await seedTaskAndInstance(db, { taskId: 731, instanceId: 4702, instanceTaskId: 999, activeInstanceId: 4702 });

    const result = await closeActiveInstanceAfterSemanticHandoff({
      db,
      taskId: 731,
      instanceId: 4702,
      outcome: 'completed_for_review',
    });

    expect(result).toEqual({ closed: false, reason: 'cross_task_instance', instanceId: 4702 });
    const instance = await db.get(`SELECT status FROM job_instances WHERE id = 4702`) as { status: string };
    expect(instance.status).toBe('running');
  });

  it.each(['done', 'failed', 'cancelled'])('is idempotent when the instance is already %s', async (status) => {
    await seedTaskAndInstance(db, { instanceStatus: status });

    const result = await closeActiveInstanceAfterSemanticHandoff({
      db,
      taskId: 731,
      instanceId: 4702,
      outcome: 'completed_for_review',
    });

    expect(result).toEqual({ closed: false, reason: 'already_terminal', instanceId: 4702 });
    const instance = await db.get(`SELECT status, runtime_ended_at FROM job_instances WHERE id = 4702`) as { status: string; runtime_ended_at: string | null };
    expect(instance.status).toBe(status);
    expect(instance.runtime_ended_at).toBeNull();
  });

  it('is idempotent when the runtime already ended before instance status changed', async () => {
    await seedTaskAndInstance(db, { instanceStatus: 'running', runtimeEndedAt: '2026-06-03T03:42:50.931Z' });

    const result = await closeActiveInstanceAfterSemanticHandoff({
      db,
      taskId: 731,
      outcome: 'completed_for_review',
    });

    expect(result).toEqual({ closed: false, reason: 'runtime_already_ended', instanceId: 4702 });
    const instance = await db.get(`SELECT status FROM job_instances WHERE id = 4702`) as { status: string };
    expect(instance.status).toBe('running');
  });

  it('returns no-op when the task has no active instance and no instance id is provided', async () => {
    await seedTaskAndInstance(db, { activeInstanceId: null });

    const result = await closeActiveInstanceAfterSemanticHandoff({
      db,
      taskId: 731,
      outcome: 'completed_for_review',
    });

    expect(result).toEqual({ closed: false, reason: 'no_active_instance' });
    const instance = await db.get(`SELECT status FROM job_instances WHERE id = 4702`) as { status: string };
    expect(instance.status).toBe('running');
  });
});
