import { completeRunInstance, startRunInstance } from './callbacks';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { type Db } from "../../db/adapter/types";

jest.mock('../../services/browserPool', () => ({
  createAgentContext: jest.fn(() => Promise.resolve({})),
  destroyAgentContext: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../integrations/telegram', () => ({
  notifyTelegram: jest.fn(() => Promise.resolve()),
}));

const PROJECT_ID = 86;
const SPRINT_ID = 700;
const AGENT_ID = 94;
const TASK_ID = 552;
const INSTANCE_ID = 3461;
const TENANT_ID = 42;
/** A second live instance, used by the stale-callback case as the task's real owner. */
const OTHER_INSTANCE_ID = 9999;

/**
 * Parents that the real schema requires and the old hand-built one did not: tasks.sprint_id is
 * NOT NULL and both it and project_id are foreign keys, so a task cannot exist on its own.
 */
async function seedScope(db: Db): Promise<void> {
  await db.run(`
    INSERT INTO tenants (id, name, slug, is_default)
    VALUES (?, 'Callback Test Tenant', 'callback-test', 1)
  `, TENANT_ID);
  await db.run(`
    INSERT INTO app_settings (key, value)
    VALUES ('default_tenant_id', ?), ('active_tenant_id', ?)
  `, TENANT_ID, TENANT_ID);
  await db.run(
    `INSERT INTO projects (id, tenant_id, name) VALUES (?, ?, 'Agent HQ')`,
    PROJECT_ID, TENANT_ID,
  );
  await db.run(`
    INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type, status)
    VALUES (?, ?, ?, 'Routing', 'dev', 'active')
  `, SPRINT_ID, TENANT_ID, PROJECT_ID);
  await db.run(`
    INSERT INTO agents (id, tenant_id, name, session_key, openclaw_agent_id, runtime_type)
    VALUES (?, ?, 'Cinder (Backend)', 'cinder-backend', 'cinder-backend', 'openclaw')
  `, AGENT_ID, TENANT_ID);
  await db.run(`
    INSERT INTO external_event_mappings (
      tenant_id, project_id, source, event_name, task_type, status_includes_json, status_excludes_json,
      action_kind, action_target, apply_review_evidence, apply_failure_detail, enabled, priority
    )
    VALUES (?, NULL, NULL, 'agent_started', NULL, '[]', '["in_progress","blocked","review","qa_pass","ready_to_merge","deployed","done","cancelled","failed"]', 'status', 'in_progress', 0, 0, 1, 100)
  `, TENANT_ID);
}

/**
 * tasks.active_instance_id and job_instances.task_id reference each other, so neither row can be
 * inserted already pointing at the other. The task goes in unowned and the linkage is set after
 * the instance exists.
 */
async function seedReadyTaskRun(db: Db, activeInstanceId: number | null = null): Promise<void> {
  await db.run(`
    INSERT INTO tasks (id, tenant_id, title, status, task_type, sprint_id, project_id, agent_id, updated_at)
    VALUES (?, ?, 'Allow task routing rules that apply to all task types', 'ready', 'backend', ?, ?, ?, CURRENT_TIMESTAMP)
  `, TASK_ID, TENANT_ID, SPRINT_ID, PROJECT_ID, AGENT_ID);
  await db.run(`
    INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status, dispatched_at)
    VALUES (?, ?, ?, ?, 'running', CURRENT_TIMESTAMP)
  `, INSTANCE_ID, TENANT_ID, AGENT_ID, TASK_ID);
  if (activeInstanceId === OTHER_INSTANCE_ID) {
    // active_instance_id is a foreign key now, so "owned by another instance" has to be a real
    // competing run rather than a dangling id.
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status, dispatched_at)
      VALUES (?, ?, ?, ?, 'running', CURRENT_TIMESTAMP)
    `, OTHER_INSTANCE_ID, TENANT_ID, AGENT_ID, TASK_ID);
  }
  if (activeInstanceId !== null) {
    await db.run(`UPDATE tasks SET active_instance_id = ? WHERE id = ?`, activeInstanceId, TASK_ID);
  }
}

describe('startRunInstance task ownership repair', () => {
  let db: Db;

  beforeEach(async () => {
    db = await setupTestDb();
    await seedScope(db);
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('reattaches a matching live instance before applying the agent_started status mapping', async () => {
    await seedReadyTaskRun(db);

    expect(await startRunInstance(db, INSTANCE_ID, 'run:3461')).toEqual({ ok: true, id: INSTANCE_ID, session_key: 'run:3461' });

    const task = await db.get(`SELECT status, active_instance_id FROM tasks WHERE id = ?`, TASK_ID) as {
      status: string;
      active_instance_id: number | null;
    };
    expect(task).toEqual({ status: 'in_progress', active_instance_id: INSTANCE_ID });

    const history = await db.all(`
      SELECT field, old_value, new_value
      FROM task_history
      WHERE task_id = ?
      ORDER BY id
    `, TASK_ID);
    expect(history).toEqual([
      { field: 'active_instance_id', old_value: null, new_value: '3461' },
      { field: 'workflow_event_source', old_value: null, new_value: 'agent_hq_runtime' },
      { field: 'workflow_event_source_kind', old_value: null, new_value: 'agent_hq_internal' },
      { field: 'workflow_event_name', old_value: null, new_value: 'agent_started' },
      { field: 'workflow_event_instance_id', old_value: null, new_value: '3461' },
      { field: 'status', old_value: 'ready', new_value: 'in_progress' },
    ]);
  });

  it('does not let a stale start callback steal a task owned by another instance', async () => {
    await seedReadyTaskRun(db, OTHER_INSTANCE_ID);

    expect(await startRunInstance(db, INSTANCE_ID, 'run:3461')).toEqual({ ok: true, id: INSTANCE_ID, session_key: 'run:3461' });

    const task = await db.get(`SELECT status, active_instance_id FROM tasks WHERE id = ?`, TASK_ID) as {
      status: string;
      active_instance_id: number | null;
    };
    expect(task).toEqual({ status: 'ready', active_instance_id: OTHER_INSTANCE_ID });
  });
});

describe('completeRunInstance runtime failure workflow event', () => {
  let db: Db;

  beforeEach(async () => {
    db = await setupTestDb();
    await seedScope(db);
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  async function seedInProgressRun(actionKind: 'status' | 'ignore', actionTarget: string | null): Promise<void> {
    await seedReadyTaskRun(db, INSTANCE_ID);
    await db.run(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`, TASK_ID);
    await db.run(`UPDATE job_instances SET session_key = 'run:3461' WHERE id = ?`, INSTANCE_ID);
    await db.run(`
      INSERT INTO external_event_mappings (
        tenant_id, project_id, source, event_name, task_type, status_includes_json, status_excludes_json,
        action_kind, action_target, apply_review_evidence, apply_failure_detail, enabled, priority
      )
      VALUES (?, NULL, 'agent_hq_runtime', 'runtime_failed', NULL, '[]', '[]', ?, ?, 0, 1, 1, 200)
    `, TENANT_ID, actionKind, actionTarget);
  }

  it('applies the configured visible status for a runtime_failed workflow event', async () => {
    await seedInProgressRun('status', 'blocked');

    await expect(completeRunInstance(db, INSTANCE_ID, {
      status: 'failed',
      summary: 'Runtime process exited with code 1',
    })).resolves.toEqual({ ok: true, id: INSTANCE_ID, status: 'failed' });

    const task = await db.get(`SELECT status, failure_detail FROM tasks WHERE id = ?`, TASK_ID) as { status: string; failure_detail: string | null };
    expect(task.status).toBe('blocked');
    expect(task.failure_detail).toContain('Runtime failure workflow event');
    expect(task.failure_detail).toContain('Event: runtime_failed');

    const history = await db.all(`
      SELECT field, new_value
      FROM task_history
      WHERE task_id = ?
      ORDER BY id
    `, TASK_ID) as Array<{ field: string; new_value: string | null }>;
    expect(history).toEqual(expect.arrayContaining([
      { field: 'workflow_event_source', new_value: 'agent_hq_runtime' },
      { field: 'workflow_event_name', new_value: 'runtime_failed' },
      { field: 'workflow_event_action_kind', new_value: 'status' },
      { field: 'workflow_event_action_target', new_value: 'blocked' },
      { field: 'status', new_value: 'blocked' },
    ]));

    const note = await db.get(`SELECT content FROM task_notes WHERE task_id = ? ORDER BY id DESC LIMIT 1`, TASK_ID) as { content: string };
    expect(note.content).toContain('Classification: runtime/control-plane failure event, not an agent-authored product failure outcome');
  });

  it('records runtime_failed workflow event history when configured action is ignore', async () => {
    await seedInProgressRun('ignore', null);

    await completeRunInstance(db, INSTANCE_ID, {
      status: 'failed',
      summary: 'Runtime monitor failed',
    });

    const task = await db.get(`SELECT status FROM tasks WHERE id = ?`, TASK_ID) as { status: string };
    expect(task.status).toBe('in_progress');

    const history = await db.all(`
      SELECT field, new_value
      FROM task_history
      WHERE task_id = ?
      ORDER BY id
    `, TASK_ID) as Array<{ field: string; new_value: string | null }>;
    expect(history).toEqual(expect.arrayContaining([
      { field: 'workflow_event_source', new_value: 'agent_hq_runtime' },
      { field: 'workflow_event_name', new_value: 'runtime_failed' },
      { field: 'workflow_event_action_kind', new_value: 'ignore' },
      { field: 'workflow_event_action_target', new_value: null },
    ]));
    expect(history.some((entry) => entry.field === 'status' && entry.new_value === 'failed')).toBe(false);
  });
});
