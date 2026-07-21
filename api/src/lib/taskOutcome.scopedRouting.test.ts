import Database from 'better-sqlite3';
import type { McpApiIdentity } from './mcpApiAuth';
import { postTaskOutcome } from '../domains/tasks/release';
import { cleanupTaskExecutionLinkageForStatus } from './taskLifecycle';
import { applyTaskOutcome } from './taskOutcome';
import { WorkflowAllowedValuesError } from './taskStatusValidation';

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

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER,
      name TEXT NOT NULL
    );
    CREATE TABLE sprints (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sprint_type TEXT NOT NULL DEFAULT 'generic'
    );
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER,
      name TEXT NOT NULL,
      job_title TEXT
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      project_id INTEGER,
      sprint_id INTEGER,
      task_type TEXT,
      agent_id INTEGER,
      active_instance_id INTEGER,
      review_owner_agent_id INTEGER,
      review_branch TEXT,
      review_commit TEXT,
      review_url TEXT,
      qa_verified_commit TEXT,
      qa_tested_url TEXT,
      merged_commit TEXT,
      deployed_commit TEXT,
      deployed_at TEXT,
      live_verified_at TEXT,
      live_verified_by TEXT,
      deploy_target TEXT,
      evidence_json TEXT,
      custom_fields_json TEXT,
      previous_status TEXT,
      failure_detail TEXT,
      origin_task_id INTEGER,
      updated_at TEXT
    );
    CREATE TABLE routing_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      from_status TEXT NOT NULL,
      outcome TEXT NOT NULL,
      to_status TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE sprint_task_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER,
      project_id INTEGER,
      sprint_type TEXT,
      task_type TEXT,
      from_status TEXT NOT NULL,
      outcome TEXT NOT NULL,
      to_status TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      is_protected INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sprint_task_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
      status_key TEXT NOT NULL,
      label TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'slate',
      terminal INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      allowed_transitions_json TEXT NOT NULL DEFAULT '[]',
      stage_order INTEGER NOT NULL DEFAULT 0,
      is_default_entry INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(sprint_id, status_key)
    );
    CREATE TABLE sprint_task_transition_requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
      task_type TEXT,
      outcome TEXT NOT NULL,
      field_name TEXT NOT NULL,
      requirement_type TEXT NOT NULL DEFAULT 'required',
      match_field TEXT,
      severity TEXT NOT NULL DEFAULT 'block',
      message TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sprint_type_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key TEXT NOT NULL,
      task_type TEXT,
      outcome_key TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      behavior TEXT NOT NULL DEFAULT 'base',
      badge_variant TEXT,
      stage_order INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sprint_task_routing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL,
      agent_id INTEGER,
      priority INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      task_id INTEGER NOT NULL,
      changed_by TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      task_id INTEGER NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      instance_id INTEGER,
      agent_id INTEGER,
      job_title TEXT,
      level TEXT,
      message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      task_id INTEGER,
      project_id INTEGER,
      agent_id INTEGER,
      from_status TEXT,
      to_status TEXT,
      moved_by TEXT,
      move_type TEXT,
      instance_id INTEGER,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE integrity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      task_id INTEGER,
      project_id INTEGER,
      agent_id INTEGER,
      instance_id INTEGER,
      anomaly_type TEXT,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE instance_artifacts (
      instance_id INTEGER PRIMARY KEY,
      task_id INTEGER,
      current_stage TEXT,
      last_agent_heartbeat_at TEXT,
      last_meaningful_output_at TEXT,
      latest_commit_hash TEXT,
      branch_name TEXT,
      changed_files_json TEXT,
      changed_files_count INTEGER,
      summary TEXT,
      blocker_reason TEXT,
      outcome TEXT,
      stale INTEGER,
      stale_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE task_outcome_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      task_id INTEGER,
      spawned_defects INTEGER DEFAULT 0
    );
    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER,
      task_id INTEGER,
      agent_id INTEGER NOT NULL,
      status TEXT,
      session_key TEXT,
      task_outcome TEXT,
      lifecycle_outcome_posted_at TEXT,
      response TEXT,
      created_at TEXT,
      dispatched_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      runtime_ended_at TEXT,
      runtime_completed_at TEXT,
      runtime_end_success INTEGER,
      runtime_end_error TEXT,
      runtime_end_source TEXT,
      lifecycle_handoff_status TEXT,
      semantic_outcome_missing INTEGER NOT NULL DEFAULT 0,
      failure_stage TEXT
    );
  `);

  db.prepare(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Agent HQ')`).run();
  db.prepare(`INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type) VALUES (10, 1, 1, 'Bugs', 'generic')`).run();
  db.prepare(`INSERT INTO agents (id, tenant_id, name, job_title) VALUES (7, 1, 'Cinder', 'Backend Engineer')`).run();
  db.prepare(`
    INSERT INTO tasks (id, tenant_id, title, status, project_id, sprint_id, task_type, agent_id)
    VALUES (417, 1, 'Scoped transitions', 'blocked', 1, 10, 'backend', 7)
  `).run();

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
    globalAdminAccess: false,
    auditActor: `agent-${agentId}`,
    authorityActor: `agent-${agentId}`,
  };
}

describe('applyTaskOutcome scoped routing_config resolution', () => {
  let db: Database.Database;

  afterEach(() => {
    jest.clearAllMocks();
    db.close();
  });

  it('ignores null-scoped routing_config fallback rows', async () => {
    db = createDb();
    db.prepare(`
      INSERT INTO routing_config (project_id, from_status, outcome, to_status, enabled)
      VALUES (NULL, 'blocked', 'custom_global_handoff', 'ready', 1)
    `).run();

    await expect(applyTaskOutcome(db, {
      taskId: 417,
      outcome: 'custom_global_handoff',
      changedBy: 'cinder-backend',
      summary: 'Global fallback should not apply',
    })).rejects.toThrow('Cannot apply outcome "custom_global_handoff" from "blocked": no explicit sprint_task_transitions route is configured');

    const row = db.prepare(`SELECT status FROM tasks WHERE id = 417`).get() as { status: string };
    expect(row.status).toBe('blocked');

    const note = db.prepare(`SELECT author, content FROM task_notes WHERE task_id = 417 ORDER BY id DESC LIMIT 1`).get() as { author: string; content: string };
    expect(note.author).toBe('cinder-backend');
    expect(note.content).toContain('Outcome refused: custom_global_handoff');
  });

  it('ignores legacy lifecycle_rules rows when no explicit sprint transition exists', async () => {
    db = createDb();
    db.exec(`
      CREATE TABLE lifecycle_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_type TEXT,
        from_status TEXT NOT NULL,
        outcome TEXT NOT NULL,
        to_status TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.prepare(`
      INSERT INTO lifecycle_rules (task_type, from_status, outcome, to_status, enabled, priority)
      VALUES ('backend', 'blocked', 'custom_global_handoff', 'ready', 1, 100)
    `).run();

    await expect(applyTaskOutcome(db, {
      taskId: 417,
      outcome: 'custom_global_handoff',
      changedBy: 'cinder-backend',
      summary: 'Legacy fallback should be ignored',
    })).rejects.toThrow('Cannot apply outcome "custom_global_handoff" from "blocked": no explicit sprint_task_transitions route is configured');

    const row = db.prepare(`SELECT status FROM tasks WHERE id = 417`).get() as { status: string };
    expect(row.status).toBe('blocked');
  });

  it('still applies explicitly project-scoped routing_config rows', async () => {
    db = createDb();
    db.prepare(`
      INSERT INTO routing_config (project_id, from_status, outcome, to_status, enabled)
      VALUES (1, 'blocked', 'custom_project_handoff', 'ready', 1)
    `).run();

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
    const row = db.prepare(`SELECT status FROM tasks WHERE id = 417`).get() as { status: string };
    expect(row.status).toBe('ready');
  });

  it('routes implementation queue outcomes to the dev deploy queued status', async () => {
    db = createDb();
    db.prepare(`UPDATE tasks SET status = 'in_progress' WHERE id = 417`).run();
    db.prepare(`
      INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (10, 'backend', 'in_progress', 'dev_deploy_queued', 'dev_deploy_queued', 1)
    `).run();

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
    const row = db.prepare(`SELECT status FROM tasks WHERE id = 417`).get() as { status: string };
    expect(row.status).toBe('dev_deploy_queued');
  });

  it('persists workflow-defined custom statuses from configured outcome transitions', async () => {
    db = createDb();
    db.prepare(`UPDATE tasks SET status = 'todo' WHERE id = 417`).run();
    db.prepare(`
      INSERT INTO sprint_task_statuses (sprint_id, status_key, label, color, terminal, is_system, stage_order, is_default_entry)
      VALUES
        (10, 'todo', 'Todo', 'slate', 0, 1, 0, 1),
        (10, 'intake', 'Intake', 'amber', 0, 0, 1, 0),
        (10, 'field_reported', 'Field Reported', 'blue', 0, 0, 2, 0)
    `).run();
    db.prepare(`
      INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (10, 'backend', 'todo', 'ready_for_intake', 'intake', 1)
    `).run();

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
    const row = db.prepare(`SELECT status FROM tasks WHERE id = 417`).get() as { status: string };
    expect(row.status).toBe('intake');
  });

  it('rejects configured outcome routes whose target status is not defined for the workflow', async () => {
    db = createDb();
    db.prepare(`UPDATE tasks SET status = 'todo' WHERE id = 417`).run();
    db.prepare(`
      INSERT INTO sprint_task_statuses (sprint_id, status_key, label, color, terminal, is_system, stage_order, is_default_entry)
      VALUES
        (10, 'todo', 'Todo', 'slate', 0, 1, 0, 1),
        (10, 'ready', 'Ready', 'blue', 0, 1, 1, 0)
    `).run();
    db.prepare(`
      INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (10, 'backend', 'todo', 'bad_custom_route', 'field_reported', 1)
    `).run();

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

    const row = db.prepare(`SELECT status FROM tasks WHERE id = 417`).get() as { status: string };
    expect(row.status).toBe('todo');
  });

  it('returns workflow-specific allowed values for invalid outcome attempts', async () => {
    db = createDb();
    db.prepare(`UPDATE tasks SET status = 'todo' WHERE id = 417`).run();
    db.prepare(`
      INSERT INTO sprint_task_statuses (sprint_id, status_key, label, color, terminal, is_system, stage_order, is_default_entry)
      VALUES
        (10, 'todo', 'Todo', 'slate', 0, 1, 0, 1),
        (10, 'field_reported', 'Field Reported', 'blue', 0, 0, 1, 0)
    `).run();
    db.prepare(`
      INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (10, 'backend', 'todo', 'ready_for_field_report', 'field_reported', 1)
    `).run();

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
    db = createDb();
    db.prepare(`
      INSERT INTO sprint_task_transitions (sprint_id, project_id, sprint_type, task_type, from_status, outcome, to_status, enabled)
      VALUES (NULL, 1, 'generic', 'backend', 'blocked', 'default_unblocked', 'ready', 1)
    `).run();

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
    const row = db.prepare(`SELECT status FROM tasks WHERE id = 417`).get() as { status: string };
    expect(row.status).toBe('ready');
  });

  it('prefers sprint override transitions over matching sprint-type defaults', async () => {
    db = createDb();
    db.prepare(`
      INSERT INTO sprint_task_transitions (sprint_id, project_id, sprint_type, task_type, from_status, outcome, to_status, enabled, priority)
      VALUES
        (NULL, 1, 'generic', 'backend', 'blocked', 'default_unblocked', 'ready', 1, 100),
        (10, 1, 'generic', 'backend', 'blocked', 'default_unblocked', 'needs_attention', 1, 0)
    `).run();

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
    const row = db.prepare(`SELECT status FROM tasks WHERE id = 417`).get() as { status: string };
    expect(row.status).toBe('needs_attention');
  });

  it('auto-closes the authoritative instance when deployed_live is posted', async () => {
    db = createDb();
    db.prepare(`UPDATE tasks SET status = 'ready_to_merge', active_instance_id = 94, agent_id = 7 WHERE id = 417`).run();
    db.prepare(`
      INSERT INTO job_instances (id, task_id, agent_id, status, session_key)
      VALUES (94, 417, 7, 'running', NULL)
    `).run();
    db.prepare(`
      INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (10, 'backend', 'ready_to_merge', 'deployed_live', 'deployed', 1)
    `).run();

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

    const instance = db.prepare(`
      SELECT status, task_outcome, runtime_ended_at, runtime_end_success, runtime_end_source
      FROM job_instances
      WHERE id = 94
    `).get() as {
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

    const notes = db.prepare(`
      SELECT content
      FROM task_notes
      WHERE task_id = 417
      ORDER BY id ASC
    `).all() as Array<{ content: string }>;
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toContain('Outcome: deployed_live — Released to production and verified live');
    expect(notes[0].content).not.toContain('Agent check-in: Run completed');
  });

  it('routes custom failure-like outcomes through generic failure routes', async () => {
    db = createDb();
    db.prepare(`UPDATE tasks SET status = 'in_progress' WHERE id = 417`).run();
    db.prepare(`
      INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (10, 'backend', 'in_progress', 'failed', 'failed', 1)
    `).run();
    db.prepare(`
      INSERT INTO sprint_type_outcomes (sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, badge_variant, stage_order, is_system, metadata_json)
      VALUES ('generic', NULL, 'custom_failure', 'Custom Failure', 'A configured failure outcome', 1, 'base', 'failed', 1, 0, '{"failure_like":true}')
    `).run();

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
    const row = db.prepare(`SELECT status, failure_detail FROM tasks WHERE id = 417`).get() as { status: string; failure_detail: string | null };
    expect(row.status).toBe('failed');
    expect(row.failure_detail).toContain('Custom failure outcome');
  });

  it('routes custom blocked-like outcomes through generic blocked routes', async () => {
    db = createDb();
    db.prepare(`UPDATE tasks SET status = 'in_progress' WHERE id = 417`).run();
    db.prepare(`
      INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (10, 'backend', 'in_progress', 'blocked', 'stalled', 1)
    `).run();
    db.prepare(`
      INSERT INTO sprint_type_outcomes (sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, badge_variant, stage_order, is_system, metadata_json)
      VALUES ('generic', NULL, 'custom_blocker', 'Custom Blocker', 'A configured blocker outcome', 1, 'base', 'stalled', 1, 0, '{"blocked_like":true}')
    `).run();

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
    const row = db.prepare(`SELECT status, failure_detail FROM tasks WHERE id = 417`).get() as { status: string; failure_detail: string | null };
    expect(row.status).toBe('stalled');
    expect(row.failure_detail).toContain('Custom blocker outcome');
  });

  it('does not infer failure behavior from a custom outcome name', async () => {
    db = createDb();
    db.prepare(`UPDATE tasks SET status = 'in_progress' WHERE id = 417`).run();
    db.prepare(`
      INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (10, 'backend', 'in_progress', 'failed', 'failed', 1)
    `).run();
    db.prepare(`
      INSERT INTO sprint_type_outcomes (sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, badge_variant, stage_order, is_system, metadata_json)
      VALUES ('generic', NULL, 'custom_failed', 'Custom Failed', 'Name alone should not imply failure semantics', 1, 'base', 'failed', 1, 0, '{}')
    `).run();

    await expect(applyTaskOutcome(db, {
      taskId: 417,
      outcome: 'custom_failed',
      changedBy: 'cinder-backend',
      summary: 'Custom suffix should not imply failure-like behavior',
    })).rejects.toThrow('Cannot apply outcome "custom_failed" from "in_progress"');

    const row = db.prepare(`SELECT status FROM tasks WHERE id = 417`).get() as { status: string };
    expect(row.status).toBe('in_progress');
  });

  it('ignores late outcomes from a stopped same-agent instance after task linkage is cleared', async () => {
    db = createDb();
    db.prepare(`UPDATE tasks SET status = 'in_progress', active_instance_id = NULL, agent_id = 7 WHERE id = 417`).run();
    db.prepare(`INSERT INTO job_instances (id, task_id, agent_id, status) VALUES (91, NULL, 7, 'failed')`).run();
    db.prepare(`
      INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (10, 'backend', 'in_progress', 'completed_for_review', 'review', 1)
    `).run();

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

    const task = db.prepare(`SELECT status FROM tasks WHERE id = 417`).get() as { status: string };
    expect(task.status).toBe('in_progress');

    const note = db.prepare(`
      SELECT content
      FROM task_notes
      WHERE task_id = 417
      ORDER BY id DESC
      LIMIT 1
    `).get() as { content: string };
    expect(note.content).toContain('task is no longer linked to that run');

    const integrity = db.prepare(`
      SELECT anomaly_type, instance_id
      FROM integrity_events
      WHERE task_id = 417
      ORDER BY id DESC
      LIMIT 1
    `).get() as { anomaly_type: string; instance_id: number | null };
    expect(integrity).toEqual({ anomaly_type: 'stale_outcome_write', instance_id: 91 });
  });

  it('still accepts linked-instance outcomes when the callback instance remains linked to the task', async () => {
    db = createDb();
    db.prepare(`UPDATE tasks SET status = 'in_progress', active_instance_id = NULL, agent_id = 7 WHERE id = 417`).run();
    db.prepare(`INSERT INTO job_instances (id, task_id, agent_id, status) VALUES (92, 417, 7, 'running')`).run();
    db.prepare(`
      INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (10, 'backend', 'in_progress', 'completed_for_review', 'review', 1)
    `).run();

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

    const task = db.prepare(`SELECT status FROM tasks WHERE id = 417`).get() as { status: string };
    expect(task.status).toBe('review');
  });

  it('clears active ownership immediately when a terminal outcome is accepted for the authoritative active run', async () => {
    db = createDb();
    (cleanupTaskExecutionLinkageForStatus as jest.Mock).mockClear();
    db.prepare(`UPDATE tasks SET status = 'in_progress', active_instance_id = 93, agent_id = 7 WHERE id = 417`).run();
    db.prepare(`
      INSERT INTO job_instances (id, task_id, agent_id, status, session_key)
      VALUES (93, 417, 7, 'running', NULL)
    `).run();
    db.prepare(`
      INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (10, 'backend', 'in_progress', 'completed_for_review', 'review', 1)
    `).run();

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

    const task = db.prepare(`SELECT active_instance_id, agent_id FROM tasks WHERE id = 417`).get() as {
      active_instance_id: number | null;
      agent_id: number | null;
    };
    expect(task.active_instance_id).toBeNull();
    expect(task.agent_id).toBeNull();
  });

  it('writes accepted lifecycle outcome bookkeeping with the task tenant and closes the active tenant-owned instance', async () => {
    db = createDb();
    db.prepare(`UPDATE projects SET tenant_id = 4 WHERE id = 1`).run();
    db.prepare(`UPDATE sprints SET tenant_id = 4 WHERE id = 10`).run();
    db.prepare(`UPDATE agents SET tenant_id = 4 WHERE id = 7`).run();
    db.prepare(`UPDATE tasks SET tenant_id = 4, status = 'in_progress', active_instance_id = 96, agent_id = 7 WHERE id = 417`).run();
    db.prepare(`
      INSERT INTO job_instances (id, tenant_id, task_id, agent_id, status, session_key)
      VALUES (96, 4, 417, 7, 'running', NULL)
    `).run();
    db.prepare(`
      INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (10, 'backend', 'in_progress', 'completed_for_review', 'review', 1)
    `).run();

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

    expect(db.prepare(`SELECT tenant_id, status, task_outcome FROM job_instances WHERE id = 96`).get()).toEqual({
      tenant_id: 4,
      status: 'done',
      task_outcome: 'completed_for_review',
    });
    expect(db.prepare(`SELECT DISTINCT tenant_id FROM task_notes WHERE task_id = 417`).all()).toEqual([{ tenant_id: 4 }]);
    expect(db.prepare(`SELECT DISTINCT tenant_id FROM task_history WHERE task_id = 417`).all()).toEqual([{ tenant_id: 4 }]);
    expect(db.prepare(`SELECT DISTINCT tenant_id FROM task_events WHERE task_id = 417`).all()).toEqual([{ tenant_id: 4 }]);

    const logTenants = db.prepare(`
      SELECT DISTINCT tenant_id
      FROM logs
      WHERE instance_id = 96 OR message LIKE '%task #417%'
      ORDER BY tenant_id
    `).all();
    expect(logTenants).toEqual([{ tenant_id: 4 }]);
  });

  it('binds MCP outcome writes to the authenticated agent active instance instead of caller-supplied instance_id', async () => {
    db = createDb();
    db.prepare(`UPDATE tasks SET status = 'in_progress', active_instance_id = 93, agent_id = 7 WHERE id = 417`).run();
    db.prepare(`
      INSERT INTO job_instances (id, task_id, agent_id, status)
      VALUES
        (93, 417, 7, 'running'),
        (999, 417, 7, 'running')
    `).run();
    db.prepare(`
      INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (10, 'backend', 'in_progress', 'completed_for_review', 'review', 1)
    `).run();

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

    const activeInstance = db.prepare(`
      SELECT task_outcome, lifecycle_outcome_posted_at, semantic_outcome_missing
      FROM job_instances
      WHERE id = 93
    `).get() as {
      task_outcome: string | null;
      lifecycle_outcome_posted_at: string | null;
      semantic_outcome_missing: number | null;
    };
    expect(activeInstance.task_outcome).toBe('completed_for_review');
    expect(activeInstance.lifecycle_outcome_posted_at).toBeTruthy();
    expect(activeInstance.semantic_outcome_missing).toBe(0);

    const spoofedInstance = db.prepare(`SELECT task_outcome, lifecycle_outcome_posted_at FROM job_instances WHERE id = 999`).get() as {
      task_outcome: string | null;
      lifecycle_outcome_posted_at: string | null;
    };
    expect(spoofedInstance.task_outcome).toBeNull();
    expect(spoofedInstance.lifecycle_outcome_posted_at).toBeNull();
  });

  it('rejects MCP outcome writes when the key does not own the task active instance', async () => {
    db = createDb();
    db.prepare(`INSERT INTO agents (id, name, job_title) VALUES (8, 'Atlas', 'Operator')`).run();
    db.prepare(`UPDATE tasks SET status = 'in_progress', active_instance_id = 94, agent_id = 8 WHERE id = 417`).run();
    db.prepare(`INSERT INTO job_instances (id, task_id, agent_id, status) VALUES (94, 417, 8, 'running')`).run();
    db.prepare(`
      INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (10, 'backend', 'in_progress', 'completed_for_review', 'review', 1)
    `).run();

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

    const task = db.prepare(`SELECT status FROM tasks WHERE id = 417`).get() as { status: string };
    const instance = db.prepare(`SELECT task_outcome FROM job_instances WHERE id = 94`).get() as { task_outcome: string | null };
    expect(task.status).toBe('in_progress');
    expect(instance.task_outcome).toBeNull();
  });

  it('rejects MCP task-level outcome writes when the task has no active instance', async () => {
    db = createDb();
    db.prepare(`UPDATE tasks SET status = 'in_progress', active_instance_id = NULL, agent_id = 7 WHERE id = 417`).run();
    db.prepare(`
      INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (10, 'backend', 'in_progress', 'completed_for_review', 'review', 1)
    `).run();

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

    const task = db.prepare(`SELECT status FROM tasks WHERE id = 417`).get() as { status: string };
    expect(task.status).toBe('in_progress');
  });

  it('maps MCP payload fields into existing outcome handling', async () => {
    db = createDb();
    db.prepare(`UPDATE tasks SET status = 'in_progress', active_instance_id = 95, agent_id = 7 WHERE id = 417`).run();
    db.prepare(`INSERT INTO job_instances (id, task_id, agent_id, status) VALUES (95, 417, 7, 'running')`).run();
    db.prepare(`
      INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, enabled)
      VALUES (10, 'backend', 'in_progress', 'failed', 'failed', 1)
    `).run();

    await postTaskOutcome(db, 417, {
      outcome: 'failed',
      summary: 'Payload failure detail should be persisted',
      payload: {
        failure_detail: 'The runtime could not produce required evidence',
      },
    }, 'agent-7', { mcpIdentity: mcpIdentity(7) });

    const task = db.prepare(`SELECT status, failure_detail FROM tasks WHERE id = 417`).get() as {
      status: string;
      failure_detail: string | null;
    };
    const instance = db.prepare(`SELECT task_outcome FROM job_instances WHERE id = 95`).get() as { task_outcome: string | null };
    expect(task).toEqual({
      status: 'failed',
      failure_detail: 'The runtime could not produce required evidence',
    });
    expect(instance.task_outcome).toBe('failed');
  });
});
