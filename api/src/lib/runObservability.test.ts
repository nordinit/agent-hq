import Database from 'better-sqlite3';
import { recordRunCheckIn } from './runObservability';

describe('recordRunCheckIn missing lifecycle handoff note suppression', () => {
  it('does not write the generic completion note for missing lifecycle handoff completions when the runtime end error uses the canonical text', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        agent_id INTEGER,
        status TEXT,
        session_key TEXT,
        started_at TEXT,
        lifecycle_outcome_posted_at TEXT,
        task_outcome TEXT,
        completed_at TEXT,
        runtime_ended_at TEXT,
        runtime_end_success INTEGER,
        runtime_end_error TEXT,
        runtime_end_source TEXT
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
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        status TEXT,
        previous_status TEXT,
        active_instance_id INTEGER
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
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        name TEXT
      );
    `);

    db.prepare(`INSERT INTO tasks (id, status) VALUES (403, 'review')`).run();
    db.prepare(`INSERT INTO agents (id, name) VALUES (96, 'Cinder (Backend)')`).run();
    db.prepare(`INSERT INTO job_instances (id, task_id, agent_id, status, session_key) VALUES (2030, 403, 96, 'running', 'run:2030')`).run();

    const result = recordRunCheckIn(db, {
      instanceId: 2030,
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
    const notes = db.prepare(`SELECT content FROM task_notes WHERE task_id = 403`).all() as Array<{ content: string }>;
    expect(notes).toHaveLength(0);
  });

  it('does not write the generic completion note for missing lifecycle handoff completions when the runtime end error is a longer failure summary', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        agent_id INTEGER,
        status TEXT,
        session_key TEXT,
        started_at TEXT,
        lifecycle_outcome_posted_at TEXT,
        task_outcome TEXT,
        completed_at TEXT,
        runtime_ended_at TEXT,
        runtime_end_success INTEGER,
        runtime_end_error TEXT,
        runtime_end_source TEXT
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
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        status TEXT,
        previous_status TEXT,
        active_instance_id INTEGER
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
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        name TEXT
      );
    `);

    db.prepare(`INSERT INTO tasks (id, status) VALUES (403, 'review')`).run();
    db.prepare(`INSERT INTO agents (id, name) VALUES (96, 'Cinder (Backend)')`).run();
    db.prepare(`INSERT INTO job_instances (id, task_id, agent_id, status, session_key) VALUES (2031, 403, 96, 'running', 'run:2031')`).run();

    const result = recordRunCheckIn(db, {
      instanceId: 2031,
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
    const notes = db.prepare(`SELECT content FROM task_notes WHERE task_id = 403`).all() as Array<{ content: string }>;
    expect(notes).toHaveLength(0);
  });

  it('does not write the generic completion note for missing lifecycle handoff completions when runtime success is still true before quarantine handling normalizes it', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        agent_id INTEGER,
        status TEXT,
        session_key TEXT,
        started_at TEXT,
        lifecycle_outcome_posted_at TEXT,
        task_outcome TEXT,
        completed_at TEXT,
        runtime_ended_at TEXT,
        runtime_end_success INTEGER,
        runtime_end_error TEXT,
        runtime_end_source TEXT
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
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        status TEXT,
        previous_status TEXT,
        active_instance_id INTEGER
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
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        name TEXT
      );
    `);

    db.prepare(`INSERT INTO tasks (id, status) VALUES (403, 'review')`).run();
    db.prepare(`INSERT INTO agents (id, name) VALUES (96, 'Cinder (Backend)')`).run();
    db.prepare(`INSERT INTO job_instances (id, task_id, agent_id, status, session_key) VALUES (2032, 403, 96, 'running', 'run:2032')`).run();

    const result = recordRunCheckIn(db, {
      instanceId: 2032,
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
    const notes = db.prepare(`SELECT content FROM task_notes WHERE task_id = 403`).all() as Array<{ content: string }>;
    expect(notes).toHaveLength(0);
  });

  it('does not write the generic completion note when the summary says the runtime ended without posting a lifecycle outcome', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        agent_id INTEGER,
        status TEXT,
        session_key TEXT,
        started_at TEXT,
        lifecycle_outcome_posted_at TEXT,
        task_outcome TEXT,
        completed_at TEXT,
        runtime_ended_at TEXT,
        runtime_end_success INTEGER,
        runtime_end_error TEXT,
        runtime_end_source TEXT
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
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        status TEXT,
        previous_status TEXT,
        active_instance_id INTEGER
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
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        name TEXT
      );
    `);

    db.prepare(`INSERT INTO tasks (id, status) VALUES (403, 'review')`).run();
    db.prepare(`INSERT INTO agents (id, name) VALUES (96, 'Cinder (Backend)')`).run();
    db.prepare(`INSERT INTO job_instances (id, task_id, agent_id, status, session_key) VALUES (2033, 403, 96, 'running', 'run:2033')`).run();

    const result = recordRunCheckIn(db, {
      instanceId: 2033,
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
    const notes = db.prepare(`SELECT content FROM task_notes WHERE task_id = 403`).all() as Array<{ content: string }>;
    expect(notes).toHaveLength(0);
  });
});

describe('recordRunCheckIn preserves runtime completion state when lifecycle handoff is missing', () => {
  it('does not force the instance status to failed solely because the lifecycle outcome is still missing', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        agent_id INTEGER,
        status TEXT,
        session_key TEXT,
        started_at TEXT,
        lifecycle_outcome_posted_at TEXT,
        task_outcome TEXT,
        completed_at TEXT,
        runtime_ended_at TEXT,
        runtime_end_success INTEGER,
        runtime_end_error TEXT,
        runtime_end_source TEXT
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
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        status TEXT,
        previous_status TEXT,
        active_instance_id INTEGER
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
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        name TEXT
      );
    `);

    db.prepare(`INSERT INTO tasks (id, status) VALUES (403, 'review')`).run();
    db.prepare(`INSERT INTO agents (id, name) VALUES (96, 'Cinder (Backend)')`).run();
    db.prepare(`INSERT INTO job_instances (id, task_id, agent_id, status, session_key) VALUES (2034, 403, 96, 'running', 'run:2034')`).run();

    recordRunCheckIn(db, {
      instanceId: 2034,
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

    const instance = db.prepare(`SELECT status, runtime_end_success, runtime_end_error FROM job_instances WHERE id = 2034`).get() as {
      status: string;
      runtime_end_success: number;
      runtime_end_error: string | null;
    };

    expect(instance.status).toBe('done');
    expect(instance.runtime_end_success).toBe(1);
    expect(instance.runtime_end_error).toBe('Runtime ended without required lifecycle outcome');
  });
});
