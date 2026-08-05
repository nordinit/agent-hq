import express from 'express';
import type { Server } from 'http';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import tasksRouter from './tasks';

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/tasks', tasksRouter);
  const server = await new Promise<Server>((resolve, reject) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
    bound.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

/** Establishes the explicit default tenant parent used by the context fixture. */
async function ensureDefaultTenant(): Promise<void> {
  const db = getDb();
  await db.run(`
    INSERT INTO tenants (id, name, slug, is_default)
    VALUES (1, 'Agent HQ', 'default', 1)
    ON CONFLICT (id) DO NOTHING
  `);
  await db.run(`
    INSERT INTO app_settings (key, value)
    VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `);
}

async function seedTaskContextFixture(): Promise<void> {
  const db = getDb();
  await ensureDefaultTenant();

  await db.run(`INSERT INTO projects (id, tenant_id, name, description, context_md) VALUES (86, 1, 'Agent HQ', '', '')`);
  await db.run(`INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status) VALUES (42, 1, 86, 'Enhancements', '', 'generic', 'active')`);
  await db.run(`
    INSERT INTO agents (id, tenant_id, name, role, session_key, workspace_path, status)
    VALUES (7, 1, 'Cinder', 'Backend Engineer', 'agent:cinder:test', '/tmp/cinder', 'running')
  `);

  await db.run(`
    INSERT INTO tasks (
      id, tenant_id, title, description, status, priority, project_id, sprint_id, agent_id, active_instance_id, task_type, story_points,
      custom_fields_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, 460, 1, 'Add task-context endpoint', 'Create a truthful task context surface.', 'review', 'high', 86, 42, 7, null, 'backend', 5, JSON.stringify({
          review_branch: 'cinder-backend/task-460',
          review_commit: 'abcdef1234567890abcdef1234567890abcdef12',
          review_url: 'http://localhost:3510/tasks/460/review',
        }), '2026-05-09 18:31:00');

  await db.run(`
    INSERT INTO tasks (id, tenant_id, title, description, status, priority, project_id, sprint_id, task_type, custom_fields_json)
    VALUES (461, 1, 'Lease manager follow-up', '', 'in_progress', 'medium', 86, 42, 'backend', '{}')
  `);
  await db.run(`
    INSERT INTO tasks (id, tenant_id, title, description, status, priority, project_id, sprint_id, task_type, custom_fields_json)
    VALUES (462, 1, 'QA downstream task', '', 'todo', 'medium', 86, 42, 'qa', '{}')
  `);
  await db.run(`INSERT INTO task_dependencies (blocker_id, blocked_id) VALUES (461, 460), (460, 462)`);

  await db.run(`
    INSERT INTO job_instances (
      id, tenant_id, agent_id, task_id, status, session_key, created_at, dispatched_at, started_at, task_outcome
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, 700, 1, 7, 460, 'running', 'run:700', '2026-05-09 18:20:00', '2026-05-09 18:21:00', '2026-05-09 18:22:00', null);

  await db.run(`
    INSERT INTO instance_artifacts (
      instance_id, task_id, current_stage, summary, latest_commit_hash, branch_name, changed_files_json, changed_files_count,
      blocker_reason, outcome, last_agent_heartbeat_at, last_meaningful_output_at, started_at, session_key, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, 700, 460, 'progress', 'Implemented summary/full task context endpoint and tests.', 'abcdef1234567890abcdef1234567890abcdef12', 'cinder-backend/task-460', JSON.stringify(['api/src/lib/taskContext.ts', 'api/src/routes/tasks.ts']), 2, null, null, '2026-05-09 18:30:00', '2026-05-09 18:29:00', '2026-05-09 18:22:00', 'run:700', '2026-05-09 18:30:00');

  await db.run(`UPDATE tasks SET active_instance_id = ? WHERE id = ?`, 700, 460);

  await db.run(`INSERT INTO task_notes (id, tenant_id, task_id, author, content, created_at) VALUES (?, 1, ?, ?, ?, ?), (?, 1, ?, ?, ?, ?), (?, 1, ?, ?, ?, ?), (?, 1, ?, ?, ?, ?)`, 9001, 460, 'Cinder', 'Agent check-in: Heartbeat\nSummary: still running\nSession: run:700', '2026-05-09 18:23:00', 9002, 460, 'Cinder', 'Agent check-in: Progress update\nSummary: Wired the endpoint and initial filters.\nCommit: abcdef1234567890abcdef1234567890abcdef12\nSession: run:700', '2026-05-09 18:25:00', 9003, 460, 'Masiah', 'Please keep the summary mode concise and truthful.', '2026-05-09 18:26:00', 9004, 460, 'Cinder', 'Agent check-in: Progress update\nSummary: Finalized deterministic meaningful-event grouping.\nCommit: abcdef1234567890abcdef1234567890abcdef12\nSession: run:700', '2026-05-09 18:28:00');

  await db.run(`INSERT INTO task_history (id, tenant_id, task_id, changed_by, field, old_value, new_value, created_at) VALUES
    (8001, 1, 460, 'cinder-backend', 'status', 'in_progress', 'review', '2026-05-09 18:24:00'),
    (8002, 1, 460, 'cinder-backend', 'review_branch', NULL, 'cinder-backend/task-460', '2026-05-09 18:24:30'),
    (8003, 1, 460, 'cinder-backend', 'review_commit', NULL, 'abcdef1234567890abcdef1234567890abcdef12', '2026-05-09 18:24:30'),
    (8004, 1, 460, 'cinder-backend', 'review_url', NULL, 'http://localhost:3510/tasks/460/review', '2026-05-09 18:24:30'),
    (8005, 1, 460, 'cinder-backend', 'runtime_ended_at', NULL, '2026-05-09T18:27:00.000Z', '2026-05-09 18:27:00'),
    (8006, 1, 460, 'cinder-backend', 'lifecycle_outcome', NULL, 'completed_for_review', '2026-05-09 18:27:00')
  `);

  await db.run(`
    INSERT INTO external_task_event_receipts (
      id, fingerprint, source, event, task_id, environment_id, queue_id, lease_id, branch, commit_sha, review_url, message, payload_json, received_by,
      processing_state, mapping_action_kind, mapping_action_target, created_at, processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, 7001, 'fp-7001', 'dev_environment_lease_manager', 'deployed_for_qa', 460, 'agent-hq-dev', 'queue-123', 'lease-123', 'cinder-backend/task-460', 'abcdef1234567890abcdef1234567890abcdef12', 'http://localhost:3510/tasks/460/review', 'Shared dev is serving the reviewed commit.', JSON.stringify({ ok: true }), 'atlas', 'processed', 'outcome', 'completed_for_review', '2026-05-09 18:29:30', '2026-05-09 18:29:30');
}

describe('GET /api/v1/tasks/:id/context', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    await setupTestDb();
    await seedTaskContextFixture();
    ({ server, baseUrl } = await startServer());
  });

  afterEach(async () => {
    await stopServer(server);
    await teardownTestDb();
  });

  it('returns a concise, meaningful summary context', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks/460/context?mode=summary&recentNotesLimit=5&recentHistoryLimit=10&timelineLimit=6`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    expect(body).toMatchObject({
      task_id: 460,
      mode: 'summary',
      server_summary: expect.stringContaining('Task #460 is review'),
    });

    const meaningfulNotes = Array.isArray(body.recent_meaningful_notes) ? body.recent_meaningful_notes as Array<Record<string, unknown>> : [];
    expect(meaningfulNotes.some((note) => note.meaningful_reason === 'human_or_operator_note')).toBe(true);
    expect(meaningfulNotes.some((note) => note.meaningful_reason === 'heartbeat_noise')).toBe(false);
    expect(meaningfulNotes.filter((note) => note.note_kind === 'agent_checkin')).toHaveLength(1);

    const meaningfulEvents = Array.isArray(body.recent_meaningful_events) ? body.recent_meaningful_events as Array<Record<string, unknown>> : [];
    expect(meaningfulEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'external_receipt', event_kind: 'deployed_for_qa' }),
      expect.objectContaining({ source: 'task_history', event_kind: 'review_evidence_update' }),
    ]));

    expect(body.lease_context).toMatchObject({
      latest_event: expect.objectContaining({
        event: 'deployed_for_qa',
        environment_id: 'agent-hq-dev',
        lease_id: 'lease-123',
        processing_state: 'processed',
        mapping_action_target: 'completed_for_review',
      }),
    });
    expect(body.active_instance).toMatchObject({
      instance_id: 700,
      current_stage: 'progress',
      latest_commit_hash: 'abcdef1234567890abcdef1234567890abcdef12',
    });
  });

  it('returns full context with classified notes/history and explicit delta filters', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks/460/context?mode=full&sinceNoteId=9002&sinceHistoryId=8002&recentNotesLimit=10&recentHistoryLimit=10`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    expect(body).toMatchObject({ task_id: 460, mode: 'full' });

    const notes = Array.isArray(body.notes) ? body.notes as Array<Record<string, unknown>> : [];
    expect(notes.map((note) => note.id)).toEqual([9004, 9003]);
    expect(notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 9004, note_kind: 'agent_checkin', phase: 'progress', is_meaningful: true }),
      expect.objectContaining({ id: 9003, note_kind: 'human_note', is_meaningful: true }),
    ]));

    const history = Array.isArray(body.history) ? body.history as Array<Record<string, unknown>> : [];
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_kind: 'lifecycle_update', is_meaningful: true }),
      expect.objectContaining({ event_kind: 'review_evidence_update', is_meaningful: true }),
    ]));

    expect(body.delta_markers).toMatchObject({
      latest_note_id: 9004,
      latest_history_id: 8006,
      latest_external_event_id: 7001,
      latest_run_id: 700,
    });
  });
});
