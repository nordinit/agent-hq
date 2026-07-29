import Database from 'better-sqlite3';
import { markTaskNeedsAttentionForMissingSemanticHandoff } from './lifecycleHandoff';
import { SqliteAdapter } from "../db/adapter/SqliteAdapter";

describe('markTaskNeedsAttentionForMissingSemanticHandoff', () => {
  it('records a structured operator recovery note without auto-moving visible workflow status', async () => {
    const dbRaw = new Database(':memory:');
      const db = new SqliteAdapter(dbRaw);
    await db.exec(`
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        title TEXT,
        status TEXT,
        previous_status TEXT,
        updated_at TEXT,
        task_type TEXT,
        sprint_id INTEGER
      );
      CREATE TABLE sprints (
        id INTEGER PRIMARY KEY,
        sprint_type TEXT
      );
      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        task_outcome TEXT,
        lifecycle_outcome_posted_at TEXT,
        lifecycle_handoff_status TEXT,
        semantic_outcome_missing INTEGER NOT NULL DEFAULT 0,
        runtime_completed_at TEXT,
        runtime_ended_at TEXT
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
      CREATE TABLE integrity_events (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        project_id INTEGER,
        agent_id INTEGER,
        instance_id INTEGER,
        anomaly_type TEXT,
        detail TEXT
      );
      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        project_id INTEGER,
        agent_id INTEGER,
        from_status TEXT,
        to_status TEXT,
        moved_by TEXT,
        move_type TEXT,
        instance_id INTEGER,
        reason TEXT
      );
    `);

    await db.run(`INSERT INTO tasks (id, title, status) VALUES (403, 'Task 403', 'review')`);
    await db.run(`INSERT INTO job_instances (id, task_id, runtime_ended_at) VALUES (2028, 403, '2026-05-01T19:44:23.584Z')`);

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
    const dbRaw = new Database(':memory:');
      const db = new SqliteAdapter(dbRaw);
    await db.exec(`
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        title TEXT,
        status TEXT,
        previous_status TEXT,
        updated_at TEXT,
        task_type TEXT,
        sprint_id INTEGER
      );
      CREATE TABLE sprints (
        id INTEGER PRIMARY KEY,
        sprint_type TEXT
      );
      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        task_outcome TEXT,
        lifecycle_outcome_posted_at TEXT,
        lifecycle_handoff_status TEXT,
        semantic_outcome_missing INTEGER NOT NULL DEFAULT 0,
        runtime_completed_at TEXT,
        runtime_ended_at TEXT
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
      CREATE TABLE integrity_events (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        project_id INTEGER,
        agent_id INTEGER,
        instance_id INTEGER,
        anomaly_type TEXT,
        detail TEXT
      );
      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        project_id INTEGER,
        agent_id INTEGER,
        from_status TEXT,
        to_status TEXT,
        moved_by TEXT,
        move_type TEXT,
        instance_id INTEGER,
        reason TEXT
      );
    `);

    await db.run(`INSERT INTO tasks (id, title, status) VALUES (404, 'Task 404', 'review')`);
    await db.run(`INSERT INTO job_instances (id, task_id, runtime_ended_at) VALUES (2029, 404, '2026-05-01T21:25:17.102Z')`);

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
    const dbRaw = new Database(':memory:');
      const db = new SqliteAdapter(dbRaw);
    await db.exec(`
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        title TEXT,
        status TEXT,
        previous_status TEXT,
        updated_at TEXT,
        task_type TEXT,
        sprint_id INTEGER,
        project_id INTEGER,
        agent_id INTEGER
      );
      CREATE TABLE sprints (id INTEGER PRIMARY KEY, sprint_type TEXT);
      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        task_outcome TEXT,
        lifecycle_outcome_posted_at TEXT,
        lifecycle_handoff_status TEXT,
        semantic_outcome_missing INTEGER NOT NULL DEFAULT 0,
        runtime_completed_at TEXT,
        runtime_ended_at TEXT
      );
      CREATE TABLE external_event_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        source TEXT,
        event_name TEXT NOT NULL,
        task_type TEXT,
        status_includes_json TEXT NOT NULL DEFAULT '[]',
        status_excludes_json TEXT NOT NULL DEFAULT '[]',
        action_kind TEXT NOT NULL,
        action_target TEXT,
        apply_review_evidence INTEGER NOT NULL DEFAULT 0,
        apply_failure_detail INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE task_notes (id INTEGER PRIMARY KEY, task_id INTEGER, author TEXT, content TEXT);
      CREATE TABLE task_history (id INTEGER PRIMARY KEY, task_id INTEGER, changed_by TEXT, field TEXT, old_value TEXT, new_value TEXT);
      CREATE TABLE integrity_events (id INTEGER PRIMARY KEY, task_id INTEGER, project_id INTEGER, agent_id INTEGER, instance_id INTEGER, anomaly_type TEXT, detail TEXT);
      CREATE TABLE task_events (id INTEGER PRIMARY KEY, task_id INTEGER, project_id INTEGER, agent_id INTEGER, from_status TEXT, to_status TEXT, moved_by TEXT, move_type TEXT, instance_id INTEGER, reason TEXT);
    `);

    await db.run(`INSERT INTO tasks (id, title, status, task_type, project_id, agent_id) VALUES (405, 'Task 405', 'review', 'backend', 86, 94)`);
    await db.run(`INSERT INTO job_instances (id, task_id, runtime_ended_at) VALUES (2030, 405, '2026-05-01T22:00:00.000Z')`);
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
