import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { markTaskNeedsAttentionForMissingSemanticHandoff } from './lifecycleHandoff';

interface SeedInput {
  taskId: number;
  instanceId: number;
  status: string;
  runtimeEndedAt: string;
  taskType?: string | null;
  /** Only the mapping case scopes its task to a project and agent; the others leave both null. */
  scoped?: boolean;
}

/**
 * The real schema declares tasks.sprint_id and job_instances.agent_id NOT NULL with genuine
 * foreign keys, so a task and an instance cannot stand on their own the way they did against a
 * hand-written minimal schema — each needs a project, workflow and agent behind it.
 *
 * Task and instance ids stay explicit because the assertions read them back out of the operator
 * note and the workflow-event history ("instance_id=2029"), so they have to be known up front.
 */
async function seed(input: SeedInput): Promise<{ projectId: number; agentId: number; sprintId: number }> {
  const db = getDb();
  const project = await db.run(`INSERT INTO projects (name) VALUES ('Lifecycle Handoff Project')`);
  const projectId = Number(project.lastInsertId);
  const sprint = await db.run(
    `INSERT INTO sprints (project_id, name) VALUES (?, 'Lifecycle Handoff Workflow')`,
    projectId,
  );
  const sprintId = Number(sprint.lastInsertId);
  const agent = await db.run(
    `INSERT INTO agents (name, session_key) VALUES ('Lifecycle Handoff Agent', 'lifecycle-handoff-agent')`,
  );
  const agentId = Number(agent.lastInsertId);

  await db.run(
    `INSERT INTO tasks (id, title, status, task_type, sprint_id, project_id, agent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.taskId,
    `Task ${input.taskId}`,
    input.status,
    input.taskType ?? null,
    sprintId,
    input.scoped ? projectId : null,
    input.scoped ? agentId : null,
  );
  await db.run(
    `INSERT INTO job_instances (id, task_id, agent_id, runtime_ended_at) VALUES (?, ?, ?, ?)`,
    input.instanceId,
    input.taskId,
    agentId,
    input.runtimeEndedAt,
  );

  return { projectId, agentId, sprintId };
}

describe('markTaskNeedsAttentionForMissingSemanticHandoff', () => {
  beforeEach(async () => { await setupTestDb(); });
  afterEach(async () => { await teardownTestDb(); });

  it('records a structured operator recovery note without auto-moving visible workflow status', async () => {
    const db = getDb();
    await seed({ taskId: 403, instanceId: 2028, status: 'review', runtimeEndedAt: '2026-05-01T19:44:23.584Z' });

    const changed = await markTaskNeedsAttentionForMissingSemanticHandoff(db, {
          taskId: 403,
          instanceId: 2028,
          changedBy: 'agent:96',
          workflowPhase: 'review',
          priorTaskStatus: 'review',
          sessionKey: 'run:2028',
          reviewQaDeployEvidenceRecorded: 'no',
          runtimeEnd: {
            source: 'instance_complete',
            success: true,
            endedAt: '2026-05-01T19:44:23.584Z',
          },
        });

    expect(changed).toBe('recorded_only');

    const note = await db.get(`SELECT content FROM task_notes WHERE task_id = 403`) as { content: string } | undefined;
    expect(note?.content).toContain('Summary: run ended without required lifecycle outcome');
    expect(note?.content).toContain('Result: partial');
    expect(note?.content).toContain('Root cause assessment: control-plane/lifecycle contract failure or missing outcome write; visible workflow movement is controlled by the configured workflow-event mapping');
    expect(note?.content).toContain('Next action: inspect the missing lifecycle outcome, then decide an explicit routed status or semantic outcome if the configured workflow-event action was ignore');
    expect(note?.content).toContain('Visible status preserved: review');
    expect(note?.content).toContain('Current visible task status: review');

    const task = await db.get(`SELECT status, previous_status FROM tasks WHERE id = 403`) as { status: string; previous_status: string | null } | undefined;
    expect(task).toEqual({ status: 'review', previous_status: null });

    const statusHistory = await db.all(`SELECT * FROM task_history WHERE task_id = 403 AND field = 'status'`);
    expect(statusHistory).toHaveLength(0);

    const workflowEventHistory = await db.all(`
      SELECT field, new_value
      FROM task_history
      WHERE task_id = 403 AND field LIKE 'workflow_event_%'
      ORDER BY field
    `) as Array<{ field: string; new_value: string | null }>;
    expect(workflowEventHistory).toEqual(expect.arrayContaining([
      { field: 'workflow_event_instance_id', new_value: '2028' },
      { field: 'workflow_event_name', new_value: 'no_semantic_handoff_posted' },
      { field: 'workflow_event_runtime_end_source', new_value: 'instance_complete' },
      { field: 'workflow_event_source', new_value: 'agent_hq_runtime' },
      { field: 'workflow_event_source_kind', new_value: 'agent_hq_internal' },
    ]));
  });

  it('preserves runtime-success context in the operator note for outcome-less completions', async () => {
    const db = getDb();
    await seed({ taskId: 404, instanceId: 2029, status: 'review', runtimeEndedAt: '2026-05-01T21:25:17.102Z' });

    const changed = await markTaskNeedsAttentionForMissingSemanticHandoff(db, {
          taskId: 404,
          instanceId: 2029,
          changedBy: 'agent:96',
          workflowPhase: 'review',
          priorTaskStatus: 'review',
          sessionKey: 'run:2029',
          reviewQaDeployEvidenceRecorded: 'yes',
          runtimeEnd: {
            source: 'instance_complete',
            success: true,
            endedAt: '2026-05-01T21:25:17.102Z',
            error: 'Runtime ended without required lifecycle outcome',
          },
        });

    expect(changed).toBe('recorded_only');

    const note = await db.get(`SELECT content FROM task_notes WHERE task_id = 404`) as { content: string } | undefined;
    expect(note?.content).toContain('Failure or issue observed: runtime ended successfully at the session level without the required lifecycle handoff');
    expect(note?.content).toContain('Evidence: instance_id=2029; session_key=run:2029; workflow_phase=review; prior_status=review; runtime_success=yes; review_qa_deploy_evidence_recorded=yes; runtime_end_source=instance_complete; runtime_ended_at=2026-05-01T21:25:17.102Z');
    expect(note?.content).toContain('Runtime ended successfully: yes');
    expect(note?.content).toContain('Review/QA/deploy evidence recorded: yes');
    expect(note?.content).toContain('Runtime end error: Runtime ended without required lifecycle outcome');
  });

  it('applies configured missing-outcome workflow event status actions while recording the event', async () => {
    const db = getDb();
    await seed({
      taskId: 405,
      instanceId: 2030,
      status: 'review',
      taskType: 'backend',
      runtimeEndedAt: '2026-05-01T22:00:00.000Z',
      scoped: true,
    });
    await db.run(`
      INSERT INTO external_event_mappings (source, event_name, task_type, status_includes_json, status_excludes_json, action_kind, action_target, enabled, priority)
      VALUES ('agent_hq_runtime', 'no_semantic_handoff_posted', 'backend', '[]', '[]', 'status', 'blocked', 1, 200)
    `);

    const changed = await markTaskNeedsAttentionForMissingSemanticHandoff(db, {
          taskId: 405,
          instanceId: 2030,
          changedBy: 'reconciler',
          workflowPhase: 'review',
          priorTaskStatus: 'review',
          runtimeEnd: { source: 'watchdog_raw_session', success: true, endedAt: '2026-05-01T22:00:00.000Z' },
        });

    expect(changed).toBe('recorded_only');
    expect(await db.get(`SELECT status FROM tasks WHERE id = 405`)).toEqual({ status: 'blocked' });
    expect(await db.get(`SELECT old_value, new_value FROM task_history WHERE task_id = 405 AND field = 'status'`)).toEqual({ old_value: 'review', new_value: 'blocked' });
    expect(await db.get(`SELECT new_value FROM task_history WHERE task_id = 405 AND field = 'workflow_event_action_kind'`)).toEqual({ new_value: 'status' });
    expect(await db.get(`SELECT new_value FROM task_history WHERE task_id = 405 AND field = 'workflow_event_action_target'`)).toEqual({ new_value: 'blocked' });
    const note = await db.get(`SELECT content FROM task_notes WHERE task_id = 405`) as { content: string };
    expect(note.content).toContain('Workflow event: no_semantic_handoff_posted');
    expect(note.content).toContain('Action: status → blocked');
  });

});
