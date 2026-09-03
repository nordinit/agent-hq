import { setupTestDb, teardownTestDb } from '../db/testDb';
import type { McpApiIdentity } from './mcpApiAuth';
import { postTaskOutcome } from '../domains/tasks/release';
import { cleanupTaskExecutionLinkageForStatus } from './taskLifecycle';
import { applyTaskOutcome } from './taskOutcome';
import { WorkflowAllowedValuesError } from './taskStatusValidation';
import { type Db } from "../db/adapter/types";

jest.mock('../domains/tasks/readModel', () => {
  const actual = jest.requireActual('../domains/tasks/readModel');
  return {
    ...actual,
    enrichTask: jest.fn((task) => task),
  };
});

jest.mock('../domains/tasks/mutations', () => {
  const actual = jest.requireActual('../domains/tasks/mutations');
  return {
    ...actual,
    maybeTriggerDispatch: jest.fn(),
  };
});

jest.mock('./taskLifecycle', () => {
  const actual = jest.requireActual('./taskLifecycle');
  return {
    ...actual,
    cleanupTaskExecutionLinkageForStatus: jest.fn(actual.cleanupTaskExecutionLinkageForStatus),
  };
});

async function createDb(): Promise<Db> {
  const db = await setupTestDb();

  await db.run(`
    INSERT INTO tenants (id, name, slug, is_default)
    VALUES (1, 'Test Tenant', 'test-tenant', 1), (4, 'Tenant Four', 'tenant-four', 0)
  `);
  await db.run(`
    INSERT INTO app_settings (key, value)
    VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')
  `);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Agent HQ')`);
  await db.run(`INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type) VALUES (10, 1, 1, 'Bugs', 'generic')`);
  await db.run(`
    INSERT INTO agents (id, tenant_id, name, job_title, session_key)
    VALUES (7, 1, 'Cinder', 'Backend Engineer', 'agent:cinder:main')
  `);
  await db.run(`
    INSERT INTO tasks (id, tenant_id, title, status, project_id, sprint_id, task_type, agent_id)
    VALUES (417, 1, 'Scoped transitions', 'blocked', 1, 10, 'backend', 7)
  `);

  return db;
}

function mcpIdentity(agentId: number): McpApiIdentity {
  return {
    keyId: 1,
    agentId,
    tenantId: 1,
    agentName: `Agent ${agentId}`,
    agentSlug: `agent-${agentId}`,
    systemRole: null,
  keyRole: 'scoped' as const,
    globalAdminAccess: false,
    auditActor: `agent-${agentId}`,
    authorityActor: `agent-${agentId}`,
  };
}

describe('applyTaskOutcome scoped routing_config resolution', () => {
  let db: Db;

  afterEach(async () => {
    jest.clearAllMocks();
    await teardownTestDb();
  });

  it('ignores null-scoped routing_config fallback rows', async () => {
    db = await createDb();
    await db.run(`
      INSERT INTO routing_config (project_id, from_status, outcome, to_status, enabled)
      VALUES (NULL, 'blocked', 'custom_global_handoff', 'ready', 1)
    `);

    await expect(applyTaskOutcome(db, {
              taskId: 417,
              outcome: 'custom_global_handoff',
              changedBy: 'cinder-backend',
              summary: 'Global fallback should not apply',
            })).rejects.toThrow('Cannot apply outcome "custom_global_handoff" from "blocked": no explicit sprint_task_transitions route is configured');

    const row = await db.get(`SELECT status FROM tasks WHERE id = 417`) as { status: string };
    expect(row.status).toBe('blocked');

    const note = await db.get(`SELECT author, content FROM task_notes WHERE task_id = 417 ORDER BY id DESC LIMIT 1`) as { author: string; content: string };
    expect(note.author).toBe('cinder-backend');
    expect(note.content).toContain('Outcome refused: custom_global_handoff');
  });

  it('ignores legacy lifecycle_rules rows when no explicit sprint transition exists', async () => {
    db = await createDb();
    await db.run(`
      INSERT INTO lifecycle_rules (task_type, from_status, outcome, to_status, enabled, priority)
      VALUES ('backend', 'blocked', 'custom_global_handoff', 'ready', 1, 100)
    `);

    await expect(applyTaskOutcome(db, {
              taskId: 417,
              outcome: 'custom_global_handoff',
              changedBy: 'cinder-backend',
              summary: 'Legacy fallback should be ignored',
            })).rejects.toThrow('Cannot apply outcome "custom_global_handoff" from "blocked": no explicit sprint_task_transitions route is configured');

    const row = await db.get(`SELECT status FROM tasks WHERE id = 417`) as { status: string };
    expect(row.status).toBe('blocked');
  });

  it('still applies explicitly project-scoped routing_config rows', async () => {
    db = await createDb();
    await db.run(`
      INSERT INTO routing_config (project_id, from_status, outcome, to_status, enabled)
      VALUES (1, 'blocked', 'custom_project_handoff', 'ready', 1)
    `);

    const result = await applyTaskOutcome(db, {
      taskId: 417,
      outcome: 'custom_project_handoff',
      changedBy: 'cinder-backend',
      summary: 'Project-scoped route should apply',
    });

    expect(result).toMatchObject({
      applied: true,
      priorStatus: 'blocked',
      nextStatus: 'ready',
      outcome: 'custom_project_handoff',
    });
    const row = await db.get(`SELECT status FROM tasks WHERE id = 417`) as { status: string };
    expect(row.status).toBe('ready');
  });

  it('routes implementation queue outcomes to the dev deploy queued status', async () => {
    db = await createDb();
    await db.run(`UPDATE tasks SET status = 'in_progress' WHERE id = 417`);
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (1, 10, 'backend', 'in_progress', 'dev_deploy_queued', 'dev_deploy_queued', 1)
    `);

    const result = await applyTaskOutcome(db, {
      taskId: 417,
      outcome: 'dev_deploy_queued',
      changedBy: 'cinder-backend',
      summary: 'Queued behind another deploy in the shared Dev environment',
    });

    expect(result).toMatchObject({
      applied: true,
      priorStatus: 'in_progress',
      nextStatus: 'dev_deploy_queued',
      outcome: 'dev_deploy_queued',
    });
    const row = await db.get(`SELECT status FROM tasks WHERE id = 417`) as { status: string };
    expect(row.status).toBe('dev_deploy_queued');
  });

  it('persists workflow-defined custom statuses from configured outcome transitions', async () => {
    db = await createDb();
    await db.run(`UPDATE tasks SET status = 'todo' WHERE id = 417`);
    await db.run(`
      INSERT INTO sprint_task_statuses (sprint_id, status_key, label, color, terminal, is_system, stage_order, is_default_entry)
      VALUES
        (10, 'todo', 'Todo', 'slate', 0, 1, 0, 1),
        (10, 'intake', 'Intake', 'amber', 0, 0, 1, 0),
        (10, 'field_reported', 'Field Reported', 'blue', 0, 0, 2, 0)
    `);
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (1, 10, 'backend', 'todo', 'ready_for_intake', 'intake', 1)
    `);

    const result = await applyTaskOutcome(db, {
      taskId: 417,
      outcome: 'ready_for_intake',
      changedBy: 'cinder-backend',
      summary: 'Elevation Build-style intake handoff',
    });

    expect(result).toMatchObject({
      applied: true,
      priorStatus: 'todo',
      nextStatus: 'intake',
      outcome: 'ready_for_intake',
    });
    const row = await db.get(`SELECT status FROM tasks WHERE id = 417`) as { status: string };
    expect(row.status).toBe('intake');
  });

  it('rejects configured outcome routes whose target status is not defined for the workflow', async () => {
    db = await createDb();
    await db.run(`UPDATE tasks SET status = 'todo' WHERE id = 417`);
    await db.run(`
      INSERT INTO sprint_task_statuses (sprint_id, status_key, label, color, terminal, is_system, stage_order, is_default_entry)
      VALUES
        (10, 'todo', 'Todo', 'slate', 0, 1, 0, 1),
        (10, 'ready', 'Ready', 'blue', 0, 1, 1, 0)
    `);
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (1, 10, 'backend', 'todo', 'bad_custom_route', 'field_reported', 1)
    `);

    await expect(applyTaskOutcome(db, {
              taskId: 417,
              outcome: 'bad_custom_route',
              changedBy: 'cinder-backend',
              summary: 'Route target is not a workflow status',
            })).rejects.toThrow('"field_reported" is not a valid task status for this workflow');

    await applyTaskOutcome(db, {
      taskId: 417,
      outcome: 'bad_custom_route',
      changedBy: 'cinder-backend',
      summary: 'Route target is not a workflow status',
    }).catch((error) => {
      expect(error).toBeInstanceOf(WorkflowAllowedValuesError);
      expect(error).toMatchObject({
        code: 'task_status_not_allowed_for_workflow',
        field: 'status',
        attemptedValue: 'field_reported',
        allowedValues: expect.arrayContaining(['todo', 'ready', 'done', 'cancelled', 'failed', 'needs_attention']),
        metadataTool: 'agent_hq_get_workflow_metadata',
        workflow: expect.objectContaining({
          sprint_id: 10,
          sprint_type: 'generic',
        }),
      });
    });

    const row = await db.get(`SELECT status FROM tasks WHERE id = 417`) as { status: string };
    expect(row.status).toBe('todo');
  });

  it('returns workflow-specific allowed values for invalid outcome attempts', async () => {
    db = await createDb();
    await db.run(`UPDATE tasks SET status = 'todo' WHERE id = 417`);
    await db.run(`
      INSERT INTO sprint_task_statuses (sprint_id, status_key, label, color, terminal, is_system, stage_order, is_default_entry)
      VALUES
        (10, 'todo', 'Todo', 'slate', 0, 1, 0, 1),
        (10, 'field_reported', 'Field Reported', 'blue', 0, 0, 1, 0)
    `);
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (1, 10, 'backend', 'todo', 'ready_for_field_report', 'field_reported', 1)
    `);

    await applyTaskOutcome(db, {
      taskId: 417,
      outcome: 'not_configured',
      changedBy: 'cinder-backend',
      summary: 'Invalid outcome',
    }).catch((error) => {
      expect(error).toBeInstanceOf(WorkflowAllowedValuesError);
      expect(error).toMatchObject({
        code: 'task_outcome_not_allowed_for_workflow',
        field: 'outcome',
        attemptedValue: 'not_configured',
        allowedValues: ['ready_for_field_report'],
        metadataTool: 'agent_hq_get_workflow_metadata',
        workflow: expect.objectContaining({
          sprint_id: 10,
          sprint_type: 'generic',
          task_type: 'backend',
          from_status: 'todo',
        }),
      });
    });
  });

  it('uses sprint-type default transitions for matching sprint workflow outcomes', async () => {
    db = await createDb();
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, project_id, sprint_type, task_type, from_status, outcome, to_status, enabled)
      VALUES (1, NULL, 1, 'generic', 'backend', 'blocked', 'default_unblocked', 'ready', 1)
    `);

    const result = await applyTaskOutcome(db, {
      taskId: 417,
      outcome: 'default_unblocked',
      changedBy: 'cinder-backend',
      summary: 'Sprint-type default route should apply',
    });

    expect(result).toMatchObject({
      applied: true,
      priorStatus: 'blocked',
      nextStatus: 'ready',
      outcome: 'default_unblocked',
    });
    const row = await db.get(`SELECT status FROM tasks WHERE id = 417`) as { status: string };
    expect(row.status).toBe('ready');
  });

  it('prefers sprint override transitions over matching sprint-type defaults', async () => {
    db = await createDb();
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, project_id, sprint_type, task_type, from_status, outcome, to_status, enabled, priority)
      VALUES
        (1, NULL, 1, 'generic', 'backend', 'blocked', 'default_unblocked', 'ready', 1, 100),
        (1, 10, 1, 'generic', 'backend', 'blocked', 'default_unblocked', 'needs_attention', 1, 0)
    `);

    const result = await applyTaskOutcome(db, {
      taskId: 417,
      outcome: 'default_unblocked',
      changedBy: 'cinder-backend',
      summary: 'Sprint override route should win',
    });

    expect(result).toMatchObject({
      applied: true,
      priorStatus: 'blocked',
      nextStatus: 'needs_attention',
      outcome: 'default_unblocked',
    });
    const row = await db.get(`SELECT status FROM tasks WHERE id = 417`) as { status: string };
    expect(row.status).toBe('needs_attention');
  });

  it('auto-closes the authoritative instance when deployed_live is posted', async () => {
    db = await createDb();
    await db.run(`
      INSERT INTO job_instances (id, task_id, agent_id, status, session_key)
      VALUES (94, 417, 7, 'running', NULL)
    `);
    await db.run(`UPDATE tasks SET status = 'ready_to_merge', active_instance_id = 94, agent_id = 7 WHERE id = 417`);
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (1, 10, 'backend', 'ready_to_merge', 'deployed_live', 'deployed', 1)
    `);

    const result = await applyTaskOutcome(db, {
      taskId: 417,
      outcome: 'deployed_live',
      changedBy: 'anchor-devops',
      summary: 'Released to production and verified live',
      instanceId: 94,
    });

    expect(result).toMatchObject({
      applied: true,
      priorStatus: 'ready_to_merge',
      nextStatus: 'deployed',
      outcome: 'deployed_live',
      instanceClosed: true,
    });

    const instance = await db.get(`
      SELECT status, task_outcome, runtime_ended_at, runtime_end_success, runtime_end_source
      FROM job_instances
      WHERE id = 94
    `) as {
      status: string;
      task_outcome: string | null;
      runtime_ended_at: string | null;
      runtime_end_success: number | null;
      runtime_end_source: string | null;
    };
    expect(instance.status).toBe('done');
    expect(instance.task_outcome).toBe('deployed_live');
    expect(instance.runtime_ended_at).toBeTruthy();
    expect(instance.runtime_end_success).toBe(1);
    expect(instance.runtime_end_source).toBe('task_outcome_auto_close');

    const notes = await db.all(`
      SELECT content
      FROM task_notes
      WHERE task_id = 417
      ORDER BY id ASC
    `) as Array<{ content: string }>;
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toContain('Outcome: deployed_live — Released to production and verified live');
    expect(notes[0].content).not.toContain('Agent check-in: Run completed');
  });

  it('routes custom failure-like outcomes through generic failure routes', async () => {
    db = await createDb();
    await db.run(`UPDATE tasks SET status = 'in_progress' WHERE id = 417`);
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (1, 10, 'backend', 'in_progress', 'failed', 'failed', 1)
    `);
    await db.run(`
      INSERT INTO sprint_type_outcomes (tenant_id, sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, badge_variant, stage_order, is_system, metadata_json)
      VALUES (1, 'generic', NULL, 'custom_failure', 'Custom Failure', 'A configured failure outcome', 1, 'base', 'failed', 1, 0, '{"failure_like":true}')
    `);

    const result = await applyTaskOutcome(db, {
      taskId: 417,
      outcome: 'custom_failure',
      changedBy: 'cinder-backend',
      summary: 'Custom failure outcome should use the generic failed route',
    });

    expect(result).toMatchObject({
      applied: true,
      priorStatus: 'in_progress',
      nextStatus: 'failed',
      outcome: 'custom_failure',
    });
    const row = await db.get(`SELECT status, failure_detail FROM tasks WHERE id = 417`) as { status: string; failure_detail: string | null };
    expect(row.status).toBe('failed');
    expect(row.failure_detail).toContain('Custom failure outcome');
  });

  it('routes custom blocked-like outcomes through generic blocked routes', async () => {
    db = await createDb();
    await db.run(`UPDATE tasks SET status = 'in_progress' WHERE id = 417`);
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (1, 10, 'backend', 'in_progress', 'blocked', 'stalled', 1)
    `);
    await db.run(`
      INSERT INTO sprint_type_outcomes (tenant_id, sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, badge_variant, stage_order, is_system, metadata_json)
      VALUES (1, 'generic', NULL, 'custom_blocker', 'Custom Blocker', 'A configured blocker outcome', 1, 'base', 'stalled', 1, 0, '{"blocked_like":true}')
    `);

    const result = await applyTaskOutcome(db, {
      taskId: 417,
      outcome: 'custom_blocker',
      changedBy: 'cinder-backend',
      summary: 'Custom blocker outcome should use the generic blocked route',
    });

    expect(result).toMatchObject({
      applied: true,
      priorStatus: 'in_progress',
      nextStatus: 'stalled',
      outcome: 'custom_blocker',
    });
    const row = await db.get(`SELECT status, failure_detail FROM tasks WHERE id = 417`) as { status: string; failure_detail: string | null };
    expect(row.status).toBe('stalled');
    expect(row.failure_detail).toContain('Custom blocker outcome');
  });

  it('does not infer failure behavior from a custom outcome name', async () => {
    db = await createDb();
    await db.run(`UPDATE tasks SET status = 'in_progress' WHERE id = 417`);
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (1, 10, 'backend', 'in_progress', 'failed', 'failed', 1)
    `);
    await db.run(`
      INSERT INTO sprint_type_outcomes (tenant_id, sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, badge_variant, stage_order, is_system, metadata_json)
      VALUES (1, 'generic', NULL, 'custom_failed', 'Custom Failed', 'Name alone should not imply failure semantics', 1, 'base', 'failed', 1, 0, '{}')
    `);

    await expect(applyTaskOutcome(db, {
              taskId: 417,
              outcome: 'custom_failed',
              changedBy: 'cinder-backend',
              summary: 'Custom suffix should not imply failure-like behavior',
            })).rejects.toThrow('Cannot apply outcome "custom_failed" from "in_progress"');

    const row = await db.get(`SELECT status FROM tasks WHERE id = 417`) as { status: string };
    expect(row.status).toBe('in_progress');
  });

  it('ignores late outcomes from a stopped same-agent instance after task linkage is cleared', async () => {
    db = await createDb();
    await db.run(`UPDATE tasks SET status = 'in_progress', active_instance_id = NULL, agent_id = 7 WHERE id = 417`);
    await db.run(`INSERT INTO job_instances (id, task_id, agent_id, status) VALUES (91, NULL, 7, 'failed')`);
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (1, 10, 'backend', 'in_progress', 'completed_for_review', 'review', 1)
    `);

    const result = await applyTaskOutcome(db, {
      taskId: 417,
      outcome: 'completed_for_review',
      changedBy: 'cinder-backend',
      summary: 'Late stopped run callback',
      instanceId: 91,
    });

    expect(result).toMatchObject({
      applied: false,
      ignored: true,
      reason: 'instance_not_authoritative',
      priorStatus: 'in_progress',
      nextStatus: 'in_progress',
    });

    const task = await db.get(`SELECT status FROM tasks WHERE id = 417`) as { status: string };
    expect(task.status).toBe('in_progress');

    const note = await db.get(`
      SELECT content
      FROM task_notes
      WHERE task_id = 417
      ORDER BY id DESC
      LIMIT 1
    `) as { content: string };
    expect(note.content).toContain('task is no longer linked to that run');

    const integrity = await db.get(`
      SELECT anomaly_type, instance_id
      FROM integrity_events
      WHERE task_id = 417
      ORDER BY id DESC
      LIMIT 1
    `) as { anomaly_type: string; instance_id: number | null };
    expect(integrity).toEqual({ anomaly_type: 'stale_outcome_write', instance_id: 91 });
  });

  it('still accepts linked-instance outcomes when the callback instance remains linked to the task', async () => {
    db = await createDb();
    await db.run(`UPDATE tasks SET status = 'in_progress', active_instance_id = NULL, agent_id = 7 WHERE id = 417`);
    await db.run(`INSERT INTO job_instances (id, task_id, agent_id, status) VALUES (92, 417, 7, 'running')`);
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (1, 10, 'backend', 'in_progress', 'completed_for_review', 'review', 1)
    `);

    const result = await applyTaskOutcome(db, {
      taskId: 417,
      outcome: 'completed_for_review',
      changedBy: 'cinder-backend',
      summary: 'Detached but still linked linked-instance callback',
      instanceId: 92,
    });

    expect(result).toMatchObject({
      applied: true,
      ignored: false,
      priorStatus: 'in_progress',
      nextStatus: 'review',
    });

    const task = await db.get(`SELECT status FROM tasks WHERE id = 417`) as { status: string };
    expect(task.status).toBe('review');
  });

  it('clears active ownership immediately when a terminal outcome is accepted for the authoritative active run', async () => {
    db = await createDb();
    (cleanupTaskExecutionLinkageForStatus as jest.Mock).mockClear();
    await db.run(`
      INSERT INTO job_instances (id, task_id, agent_id, status, session_key)
      VALUES (93, 417, 7, 'running', NULL)
    `);
    await db.run(`UPDATE tasks SET status = 'in_progress', active_instance_id = 93, agent_id = 7 WHERE id = 417`);
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (1, 10, 'backend', 'in_progress', 'completed_for_review', 'review', 1)
    `);

    const result = await applyTaskOutcome(db, {
      taskId: 417,
      outcome: 'completed_for_review',
      changedBy: 'cinder-backend',
      summary: 'Implementation complete and ready for review',
      instanceId: 93,
    });

    expect(result).toMatchObject({
      applied: true,
      priorStatus: 'in_progress',
      nextStatus: 'review',
    });

    expect(cleanupTaskExecutionLinkageForStatus).toHaveBeenCalledWith(
      db,
      417,
      'review',
      expect.objectContaining({
        authoritativeInstanceId: 93,
        changedBy: 'task_outcome',
      }),
    );
    expect((cleanupTaskExecutionLinkageForStatus as jest.Mock).mock.calls[0][3]).not.toHaveProperty('deferEndedActiveInstanceCleanup');

    const task = await db.get(`SELECT active_instance_id, agent_id FROM tasks WHERE id = 417`) as {
      active_instance_id: number | null;
      agent_id: number | null;
    };
    expect(task.active_instance_id).toBeNull();
    expect(task.agent_id).toBeNull();
  });

  it('writes accepted lifecycle outcome bookkeeping with the task tenant and closes the active tenant-owned instance', async () => {
    db = await createDb();
    await db.run(`UPDATE projects SET tenant_id = 4 WHERE id = 1`);
    await db.run(`UPDATE sprints SET tenant_id = 4 WHERE id = 10`);
    await db.run(`UPDATE agents SET tenant_id = 4 WHERE id = 7`);
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, task_id, agent_id, status, session_key)
      VALUES (96, 4, 417, 7, 'running', NULL)
    `);
    await db.run(`UPDATE tasks SET tenant_id = 4, status = 'in_progress', active_instance_id = 96, agent_id = 7 WHERE id = 417`);
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (4, 10, 'backend', 'in_progress', 'completed_for_review', 'review', 1)
    `);

    const result = await applyTaskOutcome(db, {
      taskId: 417,
      outcome: 'completed_for_review',
      changedBy: 'cinder-backend',
      summary: 'Tenant 4 implementation is ready for review',
      instanceId: 96,
    });

    expect(result).toMatchObject({
      applied: true,
      priorStatus: 'in_progress',
      nextStatus: 'review',
      outcome: 'completed_for_review',
      instanceClosed: true,
    });

    expect(await db.get(`SELECT tenant_id, status, task_outcome FROM job_instances WHERE id = 96`)).toEqual({
      tenant_id: 4,
      status: 'done',
      task_outcome: 'completed_for_review',
    });
    expect(await db.all(`SELECT DISTINCT tenant_id FROM task_notes WHERE task_id = 417`)).toEqual([{ tenant_id: 4 }]);
    expect(await db.all(`SELECT DISTINCT tenant_id FROM task_history WHERE task_id = 417`)).toEqual([{ tenant_id: 4 }]);
    expect(await db.all(`SELECT DISTINCT tenant_id FROM task_events WHERE task_id = 417`)).toEqual([{ tenant_id: 4 }]);

    const logTenants = await db.all(`
      SELECT DISTINCT tenant_id
      FROM logs
      WHERE instance_id = 96 OR message LIKE '%task #417%'
      ORDER BY tenant_id
    `);
    expect(logTenants).toEqual([{ tenant_id: 4 }]);
  });

  it('binds MCP outcome writes to the authenticated agent active instance instead of caller-supplied instance_id', async () => {
    db = await createDb();
    await db.run(`
      INSERT INTO job_instances (id, task_id, agent_id, status)
      VALUES
        (93, 417, 7, 'running'),
        (999, 417, 7, 'running')
    `);
    await db.run(`UPDATE tasks SET status = 'in_progress', active_instance_id = 93, agent_id = 7 WHERE id = 417`);
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (1, 10, 'backend', 'in_progress', 'completed_for_review', 'review', 1)
    `);

    const result = await postTaskOutcome(db, 417, {
      outcome: 'completed_for_review',
      summary: 'Ready for review through MCP identity',
      instance_id: 999,
    }, 'agent-7', { mcpIdentity: mcpIdentity(7) });

    expect(result).toMatchObject({
      applied: true,
      ignored: false,
      prior_status: 'in_progress',
      next_status: 'review',
      outcome: 'completed_for_review',
    });

    const activeInstance = await db.get(`
      SELECT task_outcome, lifecycle_outcome_posted_at, semantic_outcome_missing
      FROM job_instances
      WHERE id = 93
    `) as {
      task_outcome: string | null;
      lifecycle_outcome_posted_at: string | null;
      semantic_outcome_missing: number | null;
    };
    expect(activeInstance.task_outcome).toBe('completed_for_review');
    expect(activeInstance.lifecycle_outcome_posted_at).toBeTruthy();
    expect(activeInstance.semantic_outcome_missing).toBe(0);

    const spoofedInstance = await db.get(`SELECT task_outcome, lifecycle_outcome_posted_at FROM job_instances WHERE id = 999`) as {
      task_outcome: string | null;
      lifecycle_outcome_posted_at: string | null;
    };
    expect(spoofedInstance.task_outcome).toBeNull();
    expect(spoofedInstance.lifecycle_outcome_posted_at).toBeNull();
  });

  it('rejects MCP outcome writes when the key does not own the task active instance', async () => {
    db = await createDb();
    await db.run(`
      INSERT INTO agents (id, tenant_id, name, job_title, session_key)
      VALUES (8, 1, 'Atlas', 'Operator', 'agent:atlas:main')
    `);
    await db.run(`INSERT INTO job_instances (id, task_id, agent_id, status) VALUES (94, 417, 8, 'running')`);
    await db.run(`UPDATE tasks SET status = 'in_progress', active_instance_id = 94, agent_id = 8 WHERE id = 417`);
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (1, 10, 'backend', 'in_progress', 'completed_for_review', 'review', 1)
    `);

    await expect(postTaskOutcome(db, 417, {
              outcome: 'completed_for_review',
              summary: 'Wrong agent should not advance this task',
            }, 'agent-7', { mcpIdentity: mcpIdentity(7) })).rejects.toMatchObject({
      status: 403,
      body: expect.objectContaining({
        reason: 'active_instance_agent_mismatch',
        active_instance_id: 94,
        active_instance_agent_id: 8,
        authenticated_agent_id: 7,
      }),
    });

    const task = await db.get(`SELECT status FROM tasks WHERE id = 417`) as { status: string };
    const instance = await db.get(`SELECT task_outcome FROM job_instances WHERE id = 94`) as { task_outcome: string | null };
    expect(task.status).toBe('in_progress');
    expect(instance.task_outcome).toBeNull();
  });

  it('rejects MCP task-level outcome writes when the task has no active instance', async () => {
    db = await createDb();
    await db.run(`UPDATE tasks SET status = 'in_progress', active_instance_id = NULL, agent_id = 7 WHERE id = 417`);
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (1, 10, 'backend', 'in_progress', 'completed_for_review', 'review', 1)
    `);

    await expect(postTaskOutcome(db, 417, {
              outcome: 'completed_for_review',
              summary: 'Task-level outcome without active run must not advance',
            }, 'agent-7', { mcpIdentity: mcpIdentity(7) })).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({
        reason: 'no_active_instance',
        authenticated_agent_id: 7,
      }),
    });

    const task = await db.get(`SELECT status FROM tasks WHERE id = 417`) as { status: string };
    expect(task.status).toBe('in_progress');
  });

  it('maps MCP payload fields into existing outcome handling', async () => {
    db = await createDb();
    await db.run(`INSERT INTO job_instances (id, task_id, agent_id, status) VALUES (95, 417, 7, 'running')`);
    await db.run(`UPDATE tasks SET status = 'in_progress', active_instance_id = 95, agent_id = 7 WHERE id = 417`);
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (1, 10, 'backend', 'in_progress', 'failed', 'failed', 1)
    `);

    await postTaskOutcome(db, 417, {
      outcome: 'failed',
      summary: 'Payload failure detail should be persisted',
      payload: {
        failure_detail: 'The runtime could not produce required evidence',
      },
    }, 'agent-7', { mcpIdentity: mcpIdentity(7) });

    const task = await db.get(`SELECT status, failure_detail FROM tasks WHERE id = 417`) as {
      status: string;
      failure_detail: string | null;
    };
    const instance = await db.get(`SELECT task_outcome FROM job_instances WHERE id = 95`) as { task_outcome: string | null };
    expect(task).toEqual({
      status: 'failed',
      failure_detail: 'The runtime could not produce required evidence',
    });
    expect(instance.task_outcome).toBe('failed');
  });
});
