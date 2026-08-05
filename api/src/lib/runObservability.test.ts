import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { recordRunCheckIn } from './runObservability';

/**
 * A completion check-in that only reports "the runtime ended without a lifecycle outcome" must not
 * leave a generic "Run completed/failed" note on the task, and must not rewrite the runtime
 * completion state it was handed.
 */

interface SeededRun {
  taskId: number;
  instanceId: number;
}

/**
 * The real schema has the foreign keys the old hand-written one did not, so an instance needs a
 * task, a task needs a sprint, and a sprint needs a project — all of which recordRunCheckIn is
 * indifferent to beyond the row existing.
 */
async function seedRun(): Promise<SeededRun> {
  const db = getDb();
  const project = await db.run(
    `INSERT INTO projects (name, description, context_md) VALUES ('Observability Project', '', '')`,
  );
  const sprint = await db.run(
    `INSERT INTO sprints (project_id, name, goal, sprint_type, status, length_kind, length_value)
     VALUES (?, 'Observability Workflow', '', 'dev', 'active', 'time', '2w')`,
    Number(project.lastInsertId),
  );
  const task = await db.run(
    `INSERT INTO tasks (title, status, project_id, sprint_id) VALUES ('Observability Task', 'review', ?, ?)`,
    Number(project.lastInsertId),
    Number(sprint.lastInsertId),
  );
  const agent = await db.run(
    `INSERT INTO agents (name, session_key, project_id) VALUES ('Cinder (Backend)', 'cinder-backend', ?)`,
    Number(project.lastInsertId),
  );
  const taskId = Number(task.lastInsertId);
  const instance = await db.run(
    `INSERT INTO job_instances (task_id, agent_id, status, session_key) VALUES (?, ?, 'running', 'run:observability')`,
    taskId,
    Number(agent.lastInsertId),
  );
  return { taskId, instanceId: Number(instance.lastInsertId) };
}

const notesFor = async (taskId: number): Promise<Array<{ content: string }>> =>
  await getDb().all(`SELECT content FROM task_notes WHERE task_id = ?`, taskId) as Array<{ content: string }>;

beforeEach(async () => { await setupTestDb(); });
afterEach(async () => { await teardownTestDb(); });

describe('recordRunCheckIn missing lifecycle handoff note suppression', () => {
  it('does not write the generic completion note for missing lifecycle handoff completions when the runtime end error uses the canonical text', async () => {
    const { taskId, instanceId } = await seedRun();

    const result = await recordRunCheckIn(getDb(), {
      instanceId,
      stage: 'completion',
      summary: 'OpenClaw runtime ended without required lifecycle outcome',
      outcome: 'failed',
      meaningfulOutput: true,
      statusLabel: 'failed',
      forceNote: true,
      runtimeEndSuccess: false,
      runtimeEndError: 'Runtime ended without required lifecycle outcome',
      runtimeEndSource: 'instance_complete',
    });

    expect(result.noteCreated).toBe(false);
    expect(await notesFor(taskId)).toHaveLength(0);
  });

  it('does not write the generic completion note for missing lifecycle handoff completions when the runtime end error is a longer failure summary', async () => {
    const { taskId, instanceId } = await seedRun();

    const result = await recordRunCheckIn(getDb(), {
      instanceId,
      stage: 'completion',
      summary: 'OpenClaw runtime ended without required lifecycle outcome',
      outcome: 'failed',
      meaningfulOutput: true,
      statusLabel: 'failed',
      forceNote: true,
      runtimeEndSuccess: false,
      runtimeEndError: 'OpenClaw runtime ended without required lifecycle outcome after stale reconciler fallback fix',
      runtimeEndSource: 'instance_complete',
    });

    expect(result.noteCreated).toBe(false);
    expect(await notesFor(taskId)).toHaveLength(0);
  });

  it('does not write the generic completion note for missing lifecycle handoff completions when runtime success is still true before quarantine handling normalizes it', async () => {
    const { taskId, instanceId } = await seedRun();

    const result = await recordRunCheckIn(getDb(), {
      instanceId,
      stage: 'completion',
      summary: 'OpenClaw runtime ended without required lifecycle outcome',
      outcome: 'failed',
      meaningfulOutput: true,
      statusLabel: 'done',
      forceNote: true,
      runtimeEndSuccess: true,
      runtimeEndError: 'OpenClaw runtime ended without required lifecycle outcome after stale short-note suppression fix',
      runtimeEndSource: 'instance_complete',
    });

    expect(result.noteCreated).toBe(false);
    expect(await notesFor(taskId)).toHaveLength(0);
  });

  it('does not write the generic completion note when the summary says the runtime ended without posting a lifecycle outcome', async () => {
    const { taskId, instanceId } = await seedRun();

    const result = await recordRunCheckIn(getDb(), {
      instanceId,
      stage: 'completion',
      summary: 'QA simulation: runtime ended without posting lifecycle outcome after the latest control-plane patch.',
      outcome: 'done',
      meaningfulOutput: true,
      statusLabel: 'done',
      forceNote: true,
      runtimeEndSuccess: true,
      runtimeEndError: 'Runtime ended without required lifecycle outcome',
      runtimeEndSource: 'instance_complete',
    });

    expect(result.noteCreated).toBe(false);
    expect(await notesFor(taskId)).toHaveLength(0);
  });
});

describe('recordRunCheckIn preserves runtime completion state when lifecycle handoff is missing', () => {
  it('does not force the instance status to failed solely because the lifecycle outcome is still missing', async () => {
    const { instanceId } = await seedRun();

    await recordRunCheckIn(getDb(), {
      instanceId,
      stage: 'completion',
      summary: 'Runtime ended without required lifecycle outcome',
      outcome: 'done',
      meaningfulOutput: true,
      statusLabel: 'done',
      forceNote: true,
      runtimeEndSuccess: true,
      runtimeEndError: 'Runtime ended without required lifecycle outcome',
      runtimeEndSource: 'instance_complete',
    });

    const instance = await getDb().get(
      `SELECT status, runtime_end_success, runtime_end_error FROM job_instances WHERE id = ?`,
      instanceId,
    ) as {
      status: string;
      runtime_end_success: number;
      runtime_end_error: string | null;
    };

    expect(instance.status).toBe('done');
    expect(instance.runtime_end_success).toBe(1);
    expect(instance.runtime_end_error).toBe('Runtime ended without required lifecycle outcome');
  });
});
