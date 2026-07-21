import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../lib/taskNotifications', () => ({
  notifyTaskStatusChange: jest.fn(),
}));

jest.mock('../lib/instanceClose', () => {
  const actual = jest.requireActual('../lib/instanceClose') as typeof import('../lib/instanceClose');
  return {
    ...actual,
    closeInstance: jest.fn(async () => ({ closed: true })),
  };
});

jest.mock('../lib/taskLifecycle', () => {
  const actual = jest.requireActual('../lib/taskLifecycle') as typeof import('../lib/taskLifecycle');
  return {
    ...actual,
    cleanupTaskExecutionLinkageForStatus: jest.fn(),
  };
});

import { closeDb, getDb } from '../db/client';
import externalTaskEventsRouter, { DEV_ENV_LEASE_MANAGER_SOURCE } from './external-task-events';
import { authenticateMcpApiKeyIfPresent, issueMcpApiKeyForAgent } from '../lib/mcpApiAuth';
import { DEV_ENV_DEPLOY_FAILURE_EVENTS, seedDefaultExternalEventMappings } from '../domains/routing/externalEventMappings';
import { cleanupTaskExecutionLinkageForStatus } from '../lib/taskLifecycle';

let tempDir: string;
let dbPath: string;

function resetDb(): void {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-task-events-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');
  process.env.AGENT_HQ_DB_PATH = dbPath;

  const db = getDb();
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE sprints (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sprint_type TEXT NOT NULL DEFAULT 'generic'
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      task_type TEXT,
      sprint_id INTEGER,
      project_id INTEGER,
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
      deploy_target TEXT,
      deployed_at TEXT,
      live_verified_by TEXT,
      live_verified_at TEXT,
      evidence_json TEXT,
      custom_fields_json TEXT,
      previous_status TEXT,
      failure_detail TEXT,
      updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      changed_by TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
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
      task_id INTEGER NOT NULL,
      project_id INTEGER,
      agent_id INTEGER,
      instance_id INTEGER,
      anomaly_type TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER,
      uploaded_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_outcome_metrics (
      task_id INTEGER PRIMARY KEY,
      spawned_defects INTEGER DEFAULT 0,
      last_outcome TEXT,
      last_outcome_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE task_defects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_dependencies (
      blocker_id INTEGER NOT NULL,
      blocked_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (blocker_id, blocked_id)
    );
    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      task_id INTEGER,
      agent_id INTEGER,
      status TEXT,
      session_key TEXT,
      task_outcome TEXT,
      lifecycle_outcome_posted_at TEXT,
      response TEXT,
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
      failure_stage TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT,
      openclaw_agent_id TEXT,
      session_key TEXT,
      system_role TEXT,
      job_title TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT
    );
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER,
      agent_id INTEGER,
      job_title TEXT,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER,
      status_key TEXT,
      label TEXT,
      color TEXT,
      terminal INTEGER DEFAULT 0,
      is_system INTEGER DEFAULT 0,
      allowed_transitions_json TEXT DEFAULT '[]',
      stage_order INTEGER DEFAULT 0,
      is_default_entry INTEGER DEFAULT 0,
      metadata_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sprint_task_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER,
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
    CREATE TABLE sprint_types (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_field_schemas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key TEXT NOT NULL,
      task_type TEXT,
      schema_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE routing_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      from_status TEXT NOT NULL,
      outcome TEXT NOT NULL,
      to_status TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE external_task_event_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      event TEXT NOT NULL,
      task_id INTEGER NOT NULL,
      environment_id TEXT NOT NULL,
      queue_id TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      branch TEXT,
      commit_sha TEXT,
      review_url TEXT,
      message TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      received_by TEXT NOT NULL DEFAULT 'system',
      processing_state TEXT NOT NULL DEFAULT 'received',
      processing_error TEXT,
      mapping_id INTEGER,
      mapping_action_kind TEXT,
      mapping_action_target TEXT,
      request_metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT
    );
    CREATE TABLE external_event_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      source TEXT,
      event_name TEXT NOT NULL,
      task_type TEXT,
      status_includes_json TEXT NOT NULL DEFAULT '[]',
      status_excludes_json TEXT NOT NULL DEFAULT '[]',
      action_kind TEXT NOT NULL DEFAULT 'ignore',
      action_target TEXT,
      apply_review_evidence INTEGER NOT NULL DEFAULT 0,
      apply_failure_detail INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.prepare(`INSERT INTO projects (id, name) VALUES (1, 'Agent HQ')`).run();
  db.prepare(`INSERT INTO sprint_types (key, name, is_system) VALUES ('generic', 'Generic', 1)`).run();
  db.prepare(`INSERT INTO sprints (id, project_id, name, sprint_type) VALUES (10, 1, 'Enhancements', 'generic')`).run();
  db.prepare(`INSERT INTO agents (id, name, slug, openclaw_agent_id, job_title, enabled) VALUES (7, 'Lease Manager', ?, ?, 'Service', 1)`).run(DEV_ENV_LEASE_MANAGER_SOURCE, DEV_ENV_LEASE_MANAGER_SOURCE);
  db.prepare(`INSERT INTO agents (id, name, slug, job_title, enabled) VALUES (42, 'Cinder', 'cinder-backend', 'Backend Engineer', 1)`).run();
  db.prepare(`
    INSERT INTO tasks (
      id, title, status, task_type, sprint_id, project_id, agent_id, active_instance_id, review_owner_agent_id, updated_at
    ) VALUES (449, 'External task event callback', 'in_progress', 'backend', 10, 1, 42, 1784, 42, datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO job_instances (
      id, task_id, agent_id, status, session_key, dispatched_at
    ) VALUES (1784, 449, 42, 'running', 'run:1784', datetime('now'))
  `).run();
  db.prepare(`INSERT INTO task_outcome_metrics (task_id, spawned_defects, updated_at) VALUES (449, 0, datetime('now'))`).run();
  seedDefaultExternalEventMappings(db);
  db.prepare(`
    INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status)
    VALUES
      (10, 'backend', 'in_progress', 'completed_for_review', 'review'),
      (10, 'backend', 'in_progress', 'dev_deploy_queued', 'dev_deploy_queued'),
      (10, 'backend', 'dev_deploy_queued', 'dev_deploy_queued', 'dev_deploy_queued'),
      (10, 'backend', 'dev_deploy_queued', 'completed_for_review', 'review'),
      (10, 'backend', 'dev_deploy_queued', 'blocked', 'stalled'),
      (10, 'backend', 'dev_deploying', 'completed_for_review', 'review'),
      (10, 'backend', 'dev_deploying', 'blocked', 'stalled'),
      (10, 'backend', 'in_progress', 'blocked', 'stalled')
  `).run();
  db.prepare(`
    INSERT INTO sprint_task_transition_requirements (sprint_id, task_type, outcome, field_name, message)
    VALUES
      (10, 'backend', 'completed_for_review', 'review_branch', 'review_branch required'),
      (10, 'backend', 'completed_for_review', 'review_commit', 'review_commit required')
  `).run();
}

async function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', authenticateMcpApiKeyIfPresent);
  app.use('/api/v1/external', externalTaskEventsRouter);
  const server = await new Promise<Server>((resolve) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function issueLeaseManagerApiKey(): string {
  return issueMcpApiKeyForAgent(getDb(), 7, 'lease manager test key').apiKey;
}

describe('external task events route', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-task-events-'));
    dbPath = path.join(tempDir, 'agent-hq-test.db');
    resetDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.AGENT_HQ_DB_PATH;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves deployed_for_qa through a configurable mapping row', async () => {
    const db = getDb();
    db.prepare(`DELETE FROM external_event_mappings`).run();
    db.prepare(`
      INSERT INTO external_event_mappings (
        project_id, source, event_name, task_type, status_includes_json, status_excludes_json,
        action_kind, action_target, apply_review_evidence, apply_failure_detail, enabled, priority
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      null,
      null,
      'deployed_for_qa',
      'backend',
      JSON.stringify(['in_progress']),
      JSON.stringify([]),
      'outcome',
      'completed_for_review',
      1,
      0,
      1,
      900,
    );

    const apiKey = issueLeaseManagerApiKey();
    const { server, baseUrl } = await startTestServer();

    try {
      const response = await fetch(`${baseUrl}/api/v1/external/task-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          source: DEV_ENV_LEASE_MANAGER_SOURCE,
          event: 'deployed_for_qa',
          task_id: 449,
          environment_id: 'agent-hq-dev',
          queue_id: 'queue-qa-configured',
          lease_id: 'lease-qa-configured',
          branch: 'feature/config-driven-review',
          commit_sha: 'abc123def456',
          review_url: 'http://127.0.0.1:3510',
          message: 'Config-driven handoff to review',
        }),
      });

      expect(response.status).toBe(200);
      const payload = await response.json() as Record<string, unknown>;
      expect(payload.mapping_id).toBeTruthy();
      expect(payload.action_kind).toBe('outcome');
      expect(payload.outcome).toBe('completed_for_review');
      expect(payload.next_status).toBe('review');

      const task = db.prepare(`SELECT status, review_branch, review_commit, review_url FROM tasks WHERE id = 449`).get() as {
        status: string;
        review_branch: string;
        review_commit: string;
        review_url: string;
      };
      expect(task.status).toBe('review');
      expect(task.review_branch).toBe('feature/config-driven-review');
      expect(task.review_commit).toBe('abc123def456');
      expect(task.review_url).toBe('http://127.0.0.1:3510');
    } finally {
      await stopTestServer(server);
    }
  });

  it('resolves deploy_failed through a configurable failure mapping row', async () => {
    const db = getDb();
    db.prepare(`DELETE FROM external_event_mappings`).run();
    db.prepare(`
      INSERT INTO external_event_mappings (
        project_id, source, event_name, task_type, status_includes_json, status_excludes_json,
        action_kind, action_target, apply_review_evidence, apply_failure_detail, enabled, priority
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      null,
      DEV_ENV_LEASE_MANAGER_SOURCE,
      'deploy_failed',
      'backend',
      JSON.stringify(['in_progress']),
      JSON.stringify([]),
      'outcome',
      'blocked',
      0,
      1,
      1,
      900,
    );

    const apiKey = issueLeaseManagerApiKey();
    const { server, baseUrl } = await startTestServer();

    try {
      const response = await fetch(`${baseUrl}/api/v1/external/task-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          source: DEV_ENV_LEASE_MANAGER_SOURCE,
          event: 'deploy_failed',
          task_id: 449,
          environment_id: 'agent-hq-dev',
          queue_id: 'queue-fail-configured',
          lease_id: 'lease-fail-configured',
          branch: 'feature/configured-failure',
          commit_sha: 'deadbeef1234',
          review_url: 'http://127.0.0.1:3510',
          message: 'Config-driven failure route',
        }),
      });

      expect(response.status).toBe(200);
      const payload = await response.json() as Record<string, unknown>;
      expect(payload.mapping_id).toBeTruthy();
      expect(payload.outcome).toBe('blocked');
      expect(payload.next_status).toBe('stalled');

      const task = db.prepare(`SELECT status, failure_detail FROM tasks WHERE id = 449`).get() as {
        status: string;
        failure_detail: string;
      };
      expect(task.status).toBe('stalled');
      expect(task.failure_detail).toContain('Config-driven failure route');
      expect(task.failure_detail).toContain('Event: deploy_failed');
    } finally {
      await stopTestServer(server);
    }
  });

  it('accepts deployed_for_qa and records review evidence plus canonical review transition', async () => {
    const apiKey = issueLeaseManagerApiKey();
    const { server, baseUrl } = await startTestServer();

    try {
      const response = await fetch(`${baseUrl}/api/v1/external/task-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          source: DEV_ENV_LEASE_MANAGER_SOURCE,
          event: 'deployed_for_qa',
          task_id: 449,
          environment_id: 'agent-hq-dev',
          queue_id: 'queue-123',
          lease_id: 'lease-123',
          branch: 'cinder-backend/task-449-external-task-events',
          commit_sha: '1234567890abcdef1234567890abcdef12345678',
          review_url: 'http://127.0.0.1:3510',
          message: 'Lease-backed deploy completed and is ready for QA.',
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { ok: boolean; duplicate: boolean; outcome?: string | null; outcome_applied?: boolean; next_status?: string };
      expect(body).toMatchObject({
        ok: true,
        duplicate: false,
        outcome: 'completed_for_review',
        outcome_applied: true,
        next_status: 'review',
      });

      const task = getDb().prepare(`
        SELECT status, review_branch, review_commit, review_url
        FROM tasks WHERE id = 449
      `).get() as {
        status: string;
        review_branch: string | null;
        review_commit: string | null;
        review_url: string | null;
      };
      expect(task).toMatchObject({
        status: 'review',
        review_branch: 'cinder-backend/task-449-external-task-events',
        review_commit: '1234567890abcdef1234567890abcdef12345678',
        review_url: 'http://127.0.0.1:3510',
      });

      const notes = getDb().prepare(`SELECT author, content FROM task_notes WHERE task_id = 449 ORDER BY id ASC`).all() as Array<{
        author: string;
        content: string;
      }>;
      expect(notes).toHaveLength(2);
      expect(notes[0].author).toBe(DEV_ENV_LEASE_MANAGER_SOURCE);
      expect(notes[0].content).toContain('Workflow event received');
      expect(notes[0].content).toContain('Event: deployed_for_qa');
      expect(notes[1].content).toContain('Outcome: completed_for_review');

      const statusHistory = getDb().prepare(`
        SELECT old_value, new_value FROM task_history
        WHERE task_id = 449 AND field = 'status'
        ORDER BY id DESC LIMIT 1
      `).get() as { old_value: string; new_value: string };
      expect(statusHistory).toMatchObject({ old_value: 'in_progress', new_value: 'review' });

      const eventHistory = getDb().prepare(`
        SELECT new_value FROM task_history
        WHERE task_id = 449 AND field = 'external_event_name'
        ORDER BY id DESC LIMIT 1
      `).get() as { new_value: string };
      expect(eventHistory.new_value).toBe('deployed_for_qa');

      const taskEvent = getDb().prepare(`
        SELECT from_status, to_status, moved_by, move_type
        FROM task_events
        WHERE task_id = 449
        ORDER BY id DESC LIMIT 1
      `).get() as { from_status: string; to_status: string; moved_by: string; move_type: string };
      expect(taskEvent).toMatchObject({
        from_status: 'in_progress',
        to_status: 'review',
        moved_by: DEV_ENV_LEASE_MANAGER_SOURCE,
        move_type: 'outcome',
      });

      const receipts = getDb().prepare(`SELECT COUNT(*) as count FROM external_task_event_receipts WHERE task_id = 449`).get() as { count: number };
      expect(receipts.count).toBe(1);
    } finally {
      await stopTestServer(server);
    }
  });

  it('accepts queued and deploying events as workflow status updates without blocking the task', async () => {
    const apiKey = issueLeaseManagerApiKey();
    const { server, baseUrl } = await startTestServer();

    try {
      const queued = await fetch(`${baseUrl}/api/v1/external/task-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          source: DEV_ENV_LEASE_MANAGER_SOURCE,
          event: 'dev_deploy_queued',
          task_id: 449,
          environment_id: 'agent-hq-dev',
          queue_id: 'queue-queued',
          lease_id: 'lease-queued',
          branch: 'cinder-backend/task-449-external-task-events',
          commit_sha: '1234567890abcdef1234567890abcdef12345678',
          message: 'Shared dev environment is busy; deploy queued.',
        }),
      });

      expect(queued.status).toBe(200);
      expect(await queued.json()).toMatchObject({
        ok: true,
        duplicate: false,
        event: 'dev_deploy_queued',
        outcome: null,
        outcome_applied: true,
        next_status: 'dev_deploy_queued',
      });

      const queuedTask = getDb().prepare(`SELECT status FROM tasks WHERE id = 449`).get() as { status: string };
      expect(queuedTask.status).toBe('dev_deploy_queued');

      const deploying = await fetch(`${baseUrl}/api/v1/external/task-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          source: DEV_ENV_LEASE_MANAGER_SOURCE,
          event: 'dev_deploying',
          task_id: 449,
          environment_id: 'agent-hq-dev',
          queue_id: 'queue-queued',
          lease_id: 'lease-queued',
          branch: 'cinder-backend/task-449-external-task-events',
          commit_sha: '1234567890abcdef1234567890abcdef12345678',
          message: 'Queued deploy has started.',
        }),
      });

      expect(deploying.status).toBe(200);
      expect(await deploying.json()).toMatchObject({
        ok: true,
        duplicate: false,
        event: 'dev_deploying',
        outcome: null,
        outcome_applied: true,
        next_status: 'dev_deploying',
      });

      const task = getDb().prepare(`SELECT status FROM tasks WHERE id = 449`).get() as { status: string };
      expect(task.status).toBe('dev_deploying');

      const statusHistory = getDb().prepare(`
        SELECT old_value, new_value FROM task_history
        WHERE task_id = 449 AND field = 'status'
        ORDER BY id ASC
      `).all() as Array<{ old_value: string; new_value: string }>;
      expect(statusHistory).toEqual(expect.arrayContaining([
        { old_value: 'in_progress', new_value: 'dev_deploy_queued' },
        { old_value: 'dev_deploy_queued', new_value: 'dev_deploying' },
      ]));

      const blockedCount = getDb().prepare(`
        SELECT COUNT(*) AS count
        FROM task_history
        WHERE task_id = 449 AND field = 'status' AND new_value IN ('blocked', 'stalled')
      `).get() as { count: number };
      expect(blockedCount.count).toBe(0);
    } finally {
      await stopTestServer(server);
    }
  });

  it('accepts dev environment lease manager events authenticated with the calling agent key', async () => {
    const apiKey = issueMcpApiKeyForAgent(getDb(), 42, 'agent lease manager callback key').apiKey;
    const { server, baseUrl } = await startTestServer();

    try {
      const response = await fetch(`${baseUrl}/api/v1/external/task-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          source: DEV_ENV_LEASE_MANAGER_SOURCE,
          event: 'dev_deploying',
          task_id: 449,
          environment_id: 'agent-hq-dev',
          queue_id: 'queue-agent-key',
          lease_id: 'lease-agent-key',
          branch: 'cinder-backend/task-449-external-task-events',
          commit_sha: '1234567',
          message: 'Lease manager callback sent with the calling agent key.',
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        event: 'dev_deploying',
        next_status: 'dev_deploying',
      });

      const receipt = getDb().prepare(`
        SELECT received_by
        FROM external_task_event_receipts
        WHERE queue_id = 'queue-agent-key'
      `).get() as { received_by: string };
      expect(receipt.received_by).toBe('cinder-backend');
    } finally {
      await stopTestServer(server);
    }
  });

  it('promotes a queued dev deploy to review when deployed_for_qa arrives', async () => {
    getDb().prepare(`UPDATE tasks SET status = 'dev_deploy_queued' WHERE id = 449`).run();

    const apiKey = issueLeaseManagerApiKey();
    const { server, baseUrl } = await startTestServer();

    try {
      const response = await fetch(`${baseUrl}/api/v1/external/task-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          source: DEV_ENV_LEASE_MANAGER_SOURCE,
          event: 'deployed_for_qa',
          task_id: 449,
          environment_id: 'agent-hq-dev',
          queue_id: 'queue-queued',
          lease_id: 'lease-queued',
          branch: 'cinder-backend/task-449-external-task-events',
          commit_sha: '1234567890abcdef1234567890abcdef12345678',
          review_url: 'http://127.0.0.1:3510',
          message: 'Queued deploy completed and is ready for QA.',
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        duplicate: false,
        outcome: 'completed_for_review',
        outcome_applied: true,
        next_status: 'review',
      });

      const task = getDb().prepare(`SELECT status, review_commit FROM tasks WHERE id = 449`).get() as { status: string; review_commit: string | null };
      expect(task).toMatchObject({
        status: 'review',
        review_commit: '1234567890abcdef1234567890abcdef12345678',
      });
    } finally {
      await stopTestServer(server);
    }
  });

  it('reprocesses a rejected deployed_for_qa receipt after missing configuration evidence is recorded', async () => {
    const db = getDb();
    (cleanupTaskExecutionLinkageForStatus as jest.Mock).mockClear();
    db.prepare(`
      INSERT INTO sprint_task_transition_requirements (sprint_id, task_type, outcome, field_name, message)
      VALUES (10, 'backend', 'completed_for_review', 'configuration_resource', 'configuration_resource required')
    `).run();
    db.prepare(`UPDATE tasks SET status = 'dev_deploying' WHERE id = 449`).run();

    const apiKey = issueLeaseManagerApiKey();
    const { server, baseUrl } = await startTestServer();
    const payload = {
      source: DEV_ENV_LEASE_MANAGER_SOURCE,
      event: 'deployed_for_qa',
      task_id: 449,
      environment_id: 'agent-hq-dev',
      queue_id: 'queue-config-retry',
      lease_id: 'lease-config-retry',
      branch: 'cinder-backend/task-980-preserve-lifecycle-recovery-after-deploy',
      commit_sha: '5414a60758c163677f05d7f1faea3897c47be042',
      review_url: 'http://127.0.0.1:3510',
      message: 'Deploy completed before configuration evidence was recorded.',
    };

    try {
      const rejected = await fetch(`${baseUrl}/api/v1/external/task-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify(payload),
      });

      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({
        ok: false,
        code: 'external_task_event_transition_refused',
        receipt_accepted: true,
        processing_state: 'rejected',
        action_target: 'completed_for_review',
      });

      let task = db.prepare(`
        SELECT status, active_instance_id, review_branch, review_commit, custom_fields_json
        FROM tasks
        WHERE id = 449
      `).get() as {
        status: string;
        active_instance_id: number | null;
        review_branch: string | null;
        review_commit: string | null;
        custom_fields_json: string | null;
      };
      expect(task.status).toBe('dev_deploying');
      expect(task.active_instance_id).toBe(1784);
      expect(task.review_branch).toBeNull();
      expect(task.review_commit).toBeNull();
      expect(cleanupTaskExecutionLinkageForStatus).not.toHaveBeenCalled();

      db.prepare(`
        UPDATE tasks
        SET custom_fields_json = ?
        WHERE id = 449
      `).run(JSON.stringify({
        configuration_resource: 'dev-environment-lease-manager:lease-config-retry/configuration',
        configuration_review_hash: 'config-hash-980',
        configuration_review_receipt: 'receipt-config-980',
      }));

      const recovered = await fetch(`${baseUrl}/api/v1/external/task-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify(payload),
      });

      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({
        ok: true,
        duplicate: false,
        reprocessed: true,
        outcome: 'completed_for_review',
        outcome_applied: true,
        next_status: 'review',
      });

      const recoveredTask = db.prepare(`
        SELECT status, review_branch, review_commit, review_url, custom_fields_json
        FROM tasks
        WHERE id = 449
      `).get() as {
        status: string;
        review_branch: string | null;
        review_commit: string | null;
        review_url: string | null;
        custom_fields_json: string | null;
      };
      expect(recoveredTask.status).toBe('review');
      expect(recoveredTask.review_branch).toBe('cinder-backend/task-980-preserve-lifecycle-recovery-after-deploy');
      expect(recoveredTask.review_commit).toBe('5414a60758c163677f05d7f1faea3897c47be042');
      expect(recoveredTask.review_url).toBe('http://127.0.0.1:3510');
      expect(JSON.parse(recoveredTask.custom_fields_json ?? '{}')).toMatchObject({
        configuration_resource: 'dev-environment-lease-manager:lease-config-retry/configuration',
      });
      expect(cleanupTaskExecutionLinkageForStatus).toHaveBeenCalledTimes(1);
      expect(cleanupTaskExecutionLinkageForStatus).toHaveBeenCalledWith(
        db,
        449,
        'review',
        expect.objectContaining({
          authoritativeInstanceId: 1784,
          changedBy: 'task_outcome',
        }),
      );
      expect((cleanupTaskExecutionLinkageForStatus as jest.Mock).mock.calls[0][3]).not.toHaveProperty('deferEndedActiveInstanceCleanup');

      const third = await fetch(`${baseUrl}/api/v1/external/task-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify(payload),
      });
      expect(third.status).toBe(200);
      expect(await third.json()).toMatchObject({
        ok: true,
        duplicate: true,
        processing_state: 'duplicate',
      });
      expect(cleanupTaskExecutionLinkageForStatus).toHaveBeenCalledTimes(1);

      const receipt = db.prepare(`
        SELECT COUNT(*) AS count, processing_state, processing_error, mapping_action_target
        FROM external_task_event_receipts
        WHERE queue_id = 'queue-config-retry'
      `).get() as {
        count: number;
        processing_state: string;
        processing_error: string | null;
        mapping_action_target: string;
      };
      expect(receipt).toMatchObject({
        count: 1,
        processing_state: 'processed',
        processing_error: null,
        mapping_action_target: 'completed_for_review',
      });

      const outcomeNotes = db.prepare(`
        SELECT COUNT(*) AS count
        FROM task_notes
        WHERE task_id = 449 AND content LIKE 'Outcome: completed_for_review%'
      `).get() as { count: number };
      const workflowNotes = db.prepare(`
        SELECT COUNT(*) AS count
        FROM task_notes
        WHERE task_id = 449 AND content LIKE 'Workflow event received%'
      `).get() as { count: number };
      const transitions = db.prepare(`
        SELECT COUNT(*) AS count
        FROM task_events
        WHERE task_id = 449 AND from_status = 'dev_deploying' AND to_status = 'review'
      `).get() as { count: number };
      expect(outcomeNotes.count).toBe(1);
      expect(workflowNotes.count).toBe(1);
      expect(transitions.count).toBe(1);
    } finally {
      await stopTestServer(server);
    }
  });

  it('accepts deploy_failed and records blocked failure metadata', async () => {
    const apiKey = issueLeaseManagerApiKey();
    const { server, baseUrl } = await startTestServer();

    try {
      const response = await fetch(`${baseUrl}/api/v1/external/task-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          source: DEV_ENV_LEASE_MANAGER_SOURCE,
          event: 'deploy_failed',
          task_id: 449,
          environment_id: 'agent-hq-dev',
          queue_id: 'queue-456',
          lease_id: 'lease-456',
          message: 'pnpm build failed during review deploy.',
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { ok: boolean; outcome?: string | null; next_status?: string };
      expect(body).toMatchObject({ ok: true, outcome: 'env_blocked', next_status: 'stalled' });

      const task = getDb().prepare(`SELECT status, failure_detail FROM tasks WHERE id = 449`).get() as {
        status: string;
        failure_detail: string | null;
      };
      expect(task.status).toBe('stalled');
      expect(String(task.failure_detail)).toContain('pnpm build failed during review deploy.');
    } finally {
      await stopTestServer(server);
    }
  });

  it('durably records deploy_failed before rejecting an invalid mapped outcome', async () => {
    const db = getDb();
    db.prepare(`DELETE FROM external_event_mappings`).run();
    db.prepare(`
      INSERT INTO external_event_mappings (
        project_id, source, event_name, task_type, status_includes_json, status_excludes_json,
        action_kind, action_target, apply_review_evidence, apply_failure_detail, enabled, priority
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      null,
      DEV_ENV_LEASE_MANAGER_SOURCE,
      'deploy_failed',
      'backend',
      JSON.stringify(['dev_deploying']),
      JSON.stringify([]),
      'outcome',
      'not_a_configured_outcome',
      0,
      1,
      1,
      900,
    );
    db.prepare(`UPDATE tasks SET status = 'dev_deploying' WHERE id = 449`).run();

    const apiKey = issueLeaseManagerApiKey();
    const { server, baseUrl } = await startTestServer();

    try {
      const response = await fetch(`${baseUrl}/api/v1/external/task-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'user-agent': 'lease-manager-test',
        },
        body: JSON.stringify({
          source: DEV_ENV_LEASE_MANAGER_SOURCE,
          event: 'deploy_failed',
          task_id: 449,
          environment_id: 'agent-hq-dev',
          queue_id: 'c3ff00e4-b37e-4f2c-b902-374f34d396c4',
          lease_id: 'lease-invalid-outcome',
          branch: 'cinder-backend/task-887',
          commit_sha: 'feedface1234',
          failure_class: 'api_health_failed',
          phase: 'health_check',
          message: 'Deploy failed, but the mapped workflow outcome is invalid.',
        }),
      });

      expect(response.status).toBe(500);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        ok: false,
        code: 'external_task_event_processing_failed',
        receipt_accepted: true,
        task_id: 449,
        event: 'deploy_failed',
        processing_state: 'rejected',
        action_kind: 'outcome',
        action_target: 'not_a_configured_outcome',
      });
      expect(body.receipt_id).toBeTruthy();

      const receipt = db.prepare(`
        SELECT processing_state,
               processing_error,
               mapping_id,
               mapping_action_kind,
               mapping_action_target,
               payload_json,
               request_metadata_json,
               processed_at
        FROM external_task_event_receipts
        WHERE queue_id = ?
      `).get('c3ff00e4-b37e-4f2c-b902-374f34d396c4') as {
        processing_state: string;
        processing_error: string;
        mapping_id: number;
        mapping_action_kind: string;
        mapping_action_target: string;
        payload_json: string;
        request_metadata_json: string;
        processed_at: string | null;
      };
      expect(receipt).toBeTruthy();
      expect(receipt.processing_state).toBe('rejected');
      expect(receipt.processing_error).toContain('not_a_configured_outcome');
      expect(receipt.mapping_id).toBeTruthy();
      expect(receipt.mapping_action_kind).toBe('outcome');
      expect(receipt.mapping_action_target).toBe('not_a_configured_outcome');
      expect(receipt.payload_json).toContain('api_health_failed');
      expect(receipt.request_metadata_json).toContain('lease-manager-test');
      expect(receipt.processed_at).toBeTruthy();

      const task = db.prepare(`SELECT status, failure_detail FROM tasks WHERE id = 449`).get() as {
        status: string;
        failure_detail: string | null;
      };
      expect(task.status).toBe('dev_deploying');
      expect(task.failure_detail).toBeNull();

      const notes = db.prepare(`SELECT COUNT(*) as count FROM task_notes WHERE task_id = 449`).get() as { count: number };
      const history = db.prepare(`SELECT COUNT(*) as count FROM task_history WHERE task_id = 449`).get() as { count: number };
      expect(notes.count).toBe(0);
      expect(history.count).toBe(0);
    } finally {
      await stopTestServer(server);
    }
  });

  it('seeds deploy failure classes as workflow events mapped to env_blocked', async () => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT event_name, action_kind, action_target, apply_failure_detail
      FROM external_event_mappings
      WHERE source = ?
        AND event_name IN (${DEV_ENV_DEPLOY_FAILURE_EVENTS.map(() => '?').join(',')})
      ORDER BY event_name
    `).all(DEV_ENV_LEASE_MANAGER_SOURCE, ...DEV_ENV_DEPLOY_FAILURE_EVENTS) as Array<{
      event_name: string;
      action_kind: string;
      action_target: string;
      apply_failure_detail: number;
    }>;

    expect(rows).toHaveLength(DEV_ENV_DEPLOY_FAILURE_EVENTS.length);
    expect(rows).toEqual(expect.arrayContaining(
      DEV_ENV_DEPLOY_FAILURE_EVENTS.map((eventName) => expect.objectContaining({
        event_name: eventName,
        action_kind: 'outcome',
        action_target: 'env_blocked',
        apply_failure_detail: 1,
      })),
    ));
  });

  it('accepts a structured database_migration_failed event and preserves failure details', async () => {
    const apiKey = issueLeaseManagerApiKey();
    const { server, baseUrl } = await startTestServer();

    try {
      const response = await fetch(`${baseUrl}/api/v1/external/task-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          source: DEV_ENV_LEASE_MANAGER_SOURCE,
          event: 'database_migration_failed',
          task_id: 449,
          environment_id: 'agent-hq-dev',
          queue_id: 'queue-db-failed',
          lease_id: 'lease-db-failed',
          failure_class: 'database_migration_failed',
          phase: 'preflight',
          error: {
            migration_id: '20260516_551_routing_rule_scope',
            stderr: 'no such column: project_id',
          },
          message: 'Migration preflight failed before mutating the shared dev database.',
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        outcome: 'env_blocked',
        next_status: 'stalled',
      });

      const task = getDb().prepare(`SELECT status, failure_detail FROM tasks WHERE id = 449`).get() as {
        status: string;
        failure_detail: string | null;
      };
      expect(task.status).toBe('stalled');
      expect(String(task.failure_detail)).toContain('Failure Class: database_migration_failed');
      expect(String(task.failure_detail)).toContain('Phase: preflight');
      expect(String(task.failure_detail)).toContain('no such column: project_id');
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects malformed deployed_for_qa events without mutating the task but keeps the receipt', async () => {
    const apiKey = issueLeaseManagerApiKey();
    const { server, baseUrl } = await startTestServer();

    try {
      const response = await fetch(`${baseUrl}/api/v1/external/task-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          source: DEV_ENV_LEASE_MANAGER_SOURCE,
          event: 'deployed_for_qa',
          task_id: 449,
          environment_id: 'agent-hq-dev',
          queue_id: 'queue-123',
          lease_id: 'lease-123',
          branch: 'cinder-backend/task-449-external-task-events',
          review_url: 'http://127.0.0.1:3510',
          message: 'Missing commit SHA should fail validation.',
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json() as { code?: string };
      expect(body.code).toBe('external_task_event_validation_failed');

      const task = getDb().prepare(`SELECT status, review_branch, review_commit FROM tasks WHERE id = 449`).get() as {
        status: string;
        review_branch: string | null;
        review_commit: string | null;
      };
      expect(task).toMatchObject({ status: 'in_progress', review_branch: null, review_commit: null });

      const notes = getDb().prepare(`SELECT COUNT(*) as count FROM task_notes WHERE task_id = 449`).get() as { count: number };
      const history = getDb().prepare(`SELECT COUNT(*) as count FROM task_history WHERE task_id = 449`).get() as { count: number };
      const receipts = getDb().prepare(`
        SELECT COUNT(*) as count,
               processing_state,
               processing_error,
               mapping_action_target
        FROM external_task_event_receipts
        WHERE task_id = 449
      `).get() as {
        count: number;
        processing_state: string;
        processing_error: string;
        mapping_action_target: string;
      };
      expect(notes.count).toBe(0);
      expect(history.count).toBe(0);
      expect(receipts.count).toBe(1);
      expect(receipts.processing_state).toBe('rejected');
      expect(receipts.processing_error).toContain('review_commit');
      expect(receipts.mapping_action_target).toBe('completed_for_review');
    } finally {
      await stopTestServer(server);
    }
  });

  it('deduplicates identical accepted events without repeating notes or history', async () => {
    const apiKey = issueLeaseManagerApiKey();
    const { server, baseUrl } = await startTestServer();
    const payload = {
      source: DEV_ENV_LEASE_MANAGER_SOURCE,
      event: 'dev_deploy_queued',
      task_id: 449,
      environment_id: 'agent-hq-dev',
      queue_id: 'queue-789',
      lease_id: 'lease-789',
      message: 'Queued for the shared dev environment.',
    };

    try {
      const first = await fetch(`${baseUrl}/api/v1/external/task-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify(payload),
      });
      expect(first.status).toBe(200);
      expect((await first.json() as { duplicate: boolean }).duplicate).toBe(false);

      const second = await fetch(`${baseUrl}/api/v1/external/task-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify(payload),
      });
      expect(second.status).toBe(200);
      expect((await second.json() as { duplicate: boolean }).duplicate).toBe(true);

      const noteCount = getDb().prepare(`SELECT COUNT(*) as count FROM task_notes WHERE task_id = 449`).get() as { count: number };
      const historyCount = getDb().prepare(`SELECT COUNT(*) as count FROM task_history WHERE task_id = 449 AND field = 'external_event_name'`).get() as { count: number };
      const receiptCount = getDb().prepare(`SELECT COUNT(*) as count FROM external_task_event_receipts WHERE task_id = 449`).get() as { count: number };
      expect(noteCount.count).toBe(1);
      expect(historyCount.count).toBe(1);
      expect(receiptCount.count).toBe(1);
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects unauthorized or unknown-source callers', async () => {
    const apiKey = issueLeaseManagerApiKey();
    const { server, baseUrl } = await startTestServer();

    try {
      const unauthorized = await fetch(`${baseUrl}/api/v1/external/task-events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: DEV_ENV_LEASE_MANAGER_SOURCE,
          event: 'dev_deploy_queued',
          task_id: 449,
          environment_id: 'agent-hq-dev',
          queue_id: 'queue-999',
          lease_id: 'lease-999',
          message: 'Queued without auth.',
        }),
      });
      expect(unauthorized.status).toBe(401);

      const unknownSource = await fetch(`${baseUrl}/api/v1/external/task-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          source: 'unknown_service',
          event: 'dev_deploy_queued',
          task_id: 449,
          environment_id: 'agent-hq-dev',
          queue_id: 'queue-999',
          lease_id: 'lease-999',
          message: 'Queued from an unsupported source.',
        }),
      });
      expect(unknownSource.status).toBe(403);

      const noteCount = getDb().prepare(`SELECT COUNT(*) as count FROM task_notes WHERE task_id = 449`).get() as { count: number };
      expect(noteCount.count).toBe(0);
    } finally {
      await stopTestServer(server);
    }
  });
});
