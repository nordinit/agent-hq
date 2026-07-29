import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { runWatchdogPass, runWorktreePrunePass } from './watchdog';
import { pruneOrphanedWorktrees } from '../services/worktreeManager';
import { setActiveTenantId } from '../lib/tenantContext';
import { type Db } from "../db/adapter/types";

jest.mock('../integrations/telegram', () => ({
  notifyTelegram: jest.fn(),
}));

jest.mock('../services/worktreeManager', () => {
  const actual = jest.requireActual('../services/worktreeManager');
  return {
    ...actual,
    pruneOrphanedWorktrees: jest.fn(actual.pruneOrphanedWorktrees),
  };
});

async function createDb(): Promise<Db> {
  const db = new Database(':memory:');
  await db.exec(`
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      project_id INTEGER,
      name TEXT,
      job_title TEXT,
      runtime_type TEXT,
      session_key TEXT,
      openclaw_agent_id TEXT,
      timeout_seconds INTEGER,
      startup_grace_seconds INTEGER,
      heartbeat_stale_seconds INTEGER,
      workspace_path TEXT,
      repo_path TEXT,
      repo_url TEXT,
      repo_access_mode TEXT,
      os_user TEXT
    );

    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT,
      repo_path TEXT,
      repo_url TEXT,
      repo_access_mode TEXT
    );

    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      title TEXT,
      status TEXT,
      task_type TEXT,
      sprint_id INTEGER,
      active_instance_id INTEGER,
      updated_at TEXT
    );

    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      agent_id INTEGER,
      task_id INTEGER,
      status TEXT NOT NULL,
      created_at TEXT,
      dispatched_at TEXT,
      started_at TEXT,
      session_key TEXT,
      task_outcome TEXT,
      lifecycle_outcome_posted_at TEXT,
      completed_at TEXT,
      error TEXT,
      runtime_ended_at TEXT,
      runtime_end_success INTEGER,
      runtime_end_error TEXT,
      runtime_end_source TEXT,
      token_input INTEGER,
      token_output INTEGER,
      token_total INTEGER,
      response TEXT,
      worktree_path TEXT
    );

    CREATE TABLE instance_artifacts (
      instance_id INTEGER PRIMARY KEY,
      task_id INTEGER,
      started_at TEXT,
      last_agent_heartbeat_at TEXT,
      last_meaningful_output_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      agent_id INTEGER,
      instance_id INTEGER,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL,
      session_key TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL DEFAULT 'text',
      event_meta TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE logs (
      id INTEGER PRIMARY KEY,
      instance_id INTEGER,
      agent_id INTEGER,
      level TEXT,
      message TEXT
    );

    CREATE TABLE task_history (
      id INTEGER PRIMARY KEY,
      task_id INTEGER,
      changed_by TEXT,
      field TEXT,
      old_value TEXT,
      new_value TEXT
    );

    CREATE TABLE tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO tenants (id, name, slug, is_default)
    VALUES (1, 'Default Tenant', 'default', 1);
    INSERT INTO app_settings (key, value)
    VALUES ('active_tenant_id', '1'), ('default_tenant_id', '1');
  `);
  return db;
}

async function seedRunningInstance(db: Db, params: {
  instanceId?: number;
  taskId?: number;
  durableRunId?: string;
  createdAt?: string;
  dispatchedAt?: string;
  startedAt?: string | null;
} = {}): Promise<void> {
  const {
    instanceId = 42,
    taskId = 478,
    durableRunId = `durable-${instanceId}`,
    createdAt = '2026-05-13T10:48:08.000Z',
    dispatchedAt = '2026-05-13T10:48:08.000Z',
    startedAt = '2026-05-13T10:48:38.000Z',
  } = params;

  await db.run(`
    INSERT INTO agents (
      id, name, job_title, runtime_type, session_key, openclaw_agent_id,
      timeout_seconds, heartbeat_stale_seconds
    )
    VALUES (
      94, 'Cinder', 'Backend', 'openclaw', 'agent:cinder-backend:main', 'cinder-backend',
      1800, 600
    )
  `);
  await db.run(`INSERT INTO tasks (id, tenant_id, title, active_instance_id) VALUES (?, 1, 'Task', ?)`, taskId, instanceId);
  await db.run(`
    INSERT INTO job_instances (id, agent_id, task_id, status, created_at, dispatched_at, started_at, session_key)
    VALUES (?, 94, ?, 'running', ?, ?, ?, ?)
  `, instanceId, taskId, createdAt, dispatchedAt, startedAt, `run:${instanceId}:${durableRunId}`);
  await db.run(`
    INSERT INTO instance_artifacts (instance_id, task_id, started_at)
    VALUES (?, ?, ?)
  `, instanceId, taskId, startedAt);
}

function writeOpenClawSession(openclawHome: string, params: {
  instanceId?: number;
  agentSlug?: string;
  durableRunId?: string;
  lines: Array<Record<string, unknown>>;
}): string {
  const instanceId = params.instanceId ?? 42;
  const agentSlug = params.agentSlug ?? 'cinder-backend';
  const durableRunId = params.durableRunId ?? `durable-${instanceId}`;
  const sessionsDir = path.join(openclawHome, 'agents', agentSlug, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, `session-${instanceId}.jsonl`);
  fs.writeFileSync(
    path.join(sessionsDir, 'sessions.json'),
    JSON.stringify({
      [`agent:${agentSlug}:run:${instanceId}:${durableRunId}`]: {
        sessionId: `session-${instanceId}`,
        sessionFile,
        updatedAt: Date.parse('2026-05-13T10:59:30.000Z'),
      },
    }),
  );
  fs.writeFileSync(sessionFile, `${params.lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  return sessionFile;
}

function writeOpenClawTrajectory(sessionFile: string, lines: Array<Record<string, unknown>>): string {
  const trajectoryFile = sessionFile.replace(/\.jsonl$/, '.trajectory.jsonl');
  fs.writeFileSync(trajectoryFile, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  return trajectoryFile;
}

describe('watchdog transcript activity', () => {
  let db: Db;
  let openclawHome: string;
  let previousOpenClawHome: string | undefined;

  beforeEach(async () => {
    db = await createDb();
    openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-watchdog-openclaw-'));
    previousOpenClawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = openclawHome;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(openclawHome, { recursive: true, force: true });
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
  });

  it('reconciles a stale Hermes response.runtimeEnd success before watchdog stale failure', async () => {
    await seedRunningInstance(db, {
            instanceId: 4590,
            taskId: 715,
            startedAt: '2026-06-03T00:00:00.000Z',
            dispatchedAt: '2026-06-03T00:00:00.000Z',
            createdAt: '2026-06-03T00:00:00.000Z',
          });
    await db.run(`UPDATE agents SET runtime_type = 'hermes', name = 'Hermes' WHERE id = 94`);
    await db.run(`
      UPDATE job_instances
      SET response = ?
      WHERE id = 4590
    `, JSON.stringify({
            runtimeEnd: {
              type: 'runEnded',
              source: 'hermes',
              sessionKey: 'run:4590',
              success: true,
              endedAt: '2026-06-03T00:32:30.031Z',
              reason: 'completed',
            },
          }));

    await runWatchdogPass(db, new Date('2026-06-03T01:00:00.000Z'));
    await new Promise(resolve => setImmediate(resolve));

    const row = await db.get(`
      SELECT status, completed_at, runtime_ended_at, runtime_end_success, runtime_end_source, runtime_end_error, error
      FROM job_instances WHERE id = 4590
    `) as {
      status: string;
      completed_at: string | null;
      runtime_ended_at: string | null;
      runtime_end_success: number | null;
      runtime_end_source: string | null;
      runtime_end_error: string | null;
      error: string | null;
    };
    expect(row.status).toBe('done');
    expect(row.completed_at).toBe('2026-06-03 00:32:30.031');
    expect(row.runtime_ended_at).toBe('2026-06-03 00:32:30.031');
    expect(row.runtime_end_success).toBe(1);
    expect(row.runtime_end_source).toBe('hermes');
    expect(row.runtime_end_error).toBeNull();
    expect(row.error).toBeNull();

    const log = await db.get(`SELECT message FROM logs WHERE instance_id = 4590`) as { message: string };
    expect(log.message).toContain('response.runtimeEnd');
  });

  it('reconciles a persisted runtimeEnd failure generically', async () => {
    await seedRunningInstance(db, { instanceId: 88, taskId: 808, startedAt: '2026-05-13T10:00:00.000Z' });
    await db.run(`UPDATE agents SET runtime_type = 'veri', name = 'Veri' WHERE id = 94`);
    await db.run(`
      UPDATE job_instances
      SET response = ?
      WHERE id = 88
    `, JSON.stringify({
            runtimeEnd: {
              type: 'runEnded',
              source: 'veri',
              sessionKey: 'run:88',
              success: false,
              endedAt: '2026-05-13T10:05:00.000Z',
              reason: 'error',
              error: 'veri execution failed',
            },
          }));

    await runWatchdogPass(db, new Date('2026-05-13T11:00:00.000Z'));
    await new Promise(resolve => setImmediate(resolve));

    const row = await db.get(`
      SELECT status, completed_at, runtime_ended_at, runtime_end_success, runtime_end_source, runtime_end_error, error
      FROM job_instances WHERE id = 88
    `) as {
      status: string;
      completed_at: string | null;
      runtime_ended_at: string | null;
      runtime_end_success: number | null;
      runtime_end_source: string | null;
      runtime_end_error: string | null;
      error: string | null;
    };
    expect(row.status).toBe('failed');
    expect(row.completed_at).toBe('2026-05-13 10:05:00.000');
    expect(row.runtime_ended_at).toBe('2026-05-13 10:05:00.000');
    expect(row.runtime_end_success).toBe(0);
    expect(row.runtime_end_source).toBe('veri');
    expect(row.runtime_end_error).toBe('veri execution failed');
    expect(row.error).toBeNull();
  });

  it('falls back to a terminal turn_end chat message when response.runtimeEnd is absent', async () => {
    await seedRunningInstance(db, { instanceId: 77, taskId: 707, startedAt: '2026-05-13T10:00:00.000Z' });
    await db.run(`UPDATE agents SET runtime_type = 'hermes', name = 'Hermes' WHERE id = 94`);
    await db.run(`
      INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp, event_type, event_meta, session_key)
      VALUES (?, 94, 77, 'system', 'Runtime runEnded (completed)', ?, 'turn_end', ?, 'run:77')
    `, 'hermes-runtime-end-77', '2026-05-13T10:06:00.000Z', JSON.stringify({
              runtime_end_type: 'runEnded',
              terminal_reason: 'completed',
              success: true,
              error: null,
            }));

    await runWatchdogPass(db, new Date('2026-05-13T11:00:00.000Z'));
    await new Promise(resolve => setImmediate(resolve));

    const row = await db.get(`
      SELECT status, completed_at, runtime_ended_at, runtime_end_success, runtime_end_source, runtime_end_error, error
      FROM job_instances WHERE id = 77
    `) as {
      status: string;
      completed_at: string | null;
      runtime_ended_at: string | null;
      runtime_end_success: number | null;
      runtime_end_source: string | null;
      runtime_end_error: string | null;
      error: string | null;
    };
    expect(row.status).toBe('done');
    expect(row.completed_at).toBe('2026-05-13 10:06:00.000');
    expect(row.runtime_ended_at).toBe('2026-05-13 10:06:00.000');
    expect(row.runtime_end_success).toBe(1);
    expect(row.runtime_end_source).toBe('hermes');
    expect(row.runtime_end_error).toBeNull();
    expect(row.error).toBeNull();
  });

  it('does not fail a run when raw OpenClaw transcript activity is recent', async () => {
    await seedRunningInstance(db);
    writeOpenClawSession(openclawHome, {
      lines: [
        {
          type: 'message',
          id: 'assistant-tool-call',
          timestamp: '2026-05-13T10:59:00.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'call-1', name: 'explore_codebase', arguments: { focus: 'routing' } }],
          },
        },
        {
          type: 'message',
          id: 'tool-result',
          timestamp: '2026-05-13T10:59:30.000Z',
          message: {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'explore_codebase',
            content: [{ type: 'text', text: 'Still working through tool calls' }],
            isError: false,
          },
        },
      ],
    });

    await runWatchdogPass(db, new Date('2026-05-13T11:00:00.000Z'));

    const row = await db.get(`SELECT status, error FROM job_instances WHERE id = 42`) as {
      status: string;
      error: string | null;
    };
    expect(row.status).toBe('running');
    expect(row.error).toBeNull();

    const chatRows = await db.all(`
      SELECT role, event_type, content
        FROM chat_messages
        WHERE instance_id = 42
        ORDER BY timestamp ASC
    `) as Array<{ role: string; event_type: string; content: string }>;
    expect(chatRows.map(row => [row.role, row.event_type, row.content])).toEqual([
      ['assistant', 'tool_call', 'explore_codebase'],
      ['tool', 'tool_result', 'Still working through tool calls'],
    ]);
  });

  it('reconciles a stale row when the raw OpenClaw transcript reached a final answer', async () => {
    await seedRunningInstance(db);
    await db.run(`
      UPDATE job_instances
      SET task_outcome = 'deployed_live',
          lifecycle_outcome_posted_at = '2026-05-13T10:59:35.000Z'
      WHERE id = 42
    `);
    writeOpenClawSession(openclawHome, {
      lines: [
        {
          type: 'message',
          id: 'assistant-final',
          timestamp: '2026-05-13T10:59:30.000Z',
          message: {
            role: 'assistant',
            stopReason: 'stop',
            provider: 'openai-codex',
            api: 'openai-codex-responses',
            content: [
              {
                type: 'text',
                text: 'Done.',
                textSignature: JSON.stringify({ phase: 'final_answer' }),
              },
            ],
          },
        },
      ],
    });

    await runWatchdogPass(db, new Date('2026-05-13T11:20:00.000Z'));
    await new Promise(resolve => setImmediate(resolve));

    const row = await db.get(`
      SELECT status, completed_at, runtime_ended_at, runtime_end_success, runtime_end_source, error
      FROM job_instances
      WHERE id = 42
    `) as {
      status: string;
      completed_at: string | null;
      runtime_ended_at: string | null;
      runtime_end_success: number | null;
      runtime_end_source: string | null;
      error: string | null;
    };
    expect(row.status).toBe('done');
    expect(row.completed_at).toBe('2026-05-13 10:59:30.000');
    expect(row.runtime_ended_at).toBe('2026-05-13 10:59:30.000');
    expect(row.runtime_end_success).toBe(1);
    expect(row.runtime_end_source).toBe('watchdog_raw_session');
    expect(row.error).toBeNull();
  });

  it('ignores the initial user prompt when deciding whether a run is alive', async () => {
    await seedRunningInstance(db);
    await db.run(`
      INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp)
      VALUES ('user-1', 94, 42, 'user', 'Dispatch prompt', '2026-05-13T10:59:30.000Z')
    `);

    await runWatchdogPass(db, new Date('2026-05-13T11:00:00.000Z'));

    const row = await db.get(`SELECT status, error, runtime_end_source FROM job_instances WHERE id = 42`) as {
      status: string;
      error: string | null;
      runtime_end_source: string | null;
    };
    expect(row.status).toBe('failed');
    expect(row.error).toBe('Watchdog: stale run: no start signal for 11m');
    expect(row.runtime_end_source).toBe('watchdog');

    const notification = await db.get(`
      SELECT tenant_id, type, title, body, source, outlet
      FROM notification_records
      WHERE type = 'watchdog_stale_run'
    `) as {
      tenant_id: number;
      type: string;
      title: string;
      body: string;
      source: string;
      outlet: string;
    };
    expect(notification.tenant_id).toBe(1);
    expect(notification.title).toBe('⏰ Watchdog auto-failed Task #478');
    expect(notification.body).toContain('Instance #42 · Task #478 · Agent: Cinder / Backend');
    expect(notification.body).toContain('Reason: stale run: no start signal for 11m');
    expect(notification.source).toBe('watchdog');
    expect(notification.outlet).toBe('agent_hq');
  });

  it('reconciles a run 4581-style prompt-only OpenClaw session when trajectory ended with an error', async () => {
    await seedRunningInstance(db, {
            instanceId: 4581,
            taskId: 679,
            durableRunId: '244f30ff-cf5d-4c86-96f9-273787cf8062',
            createdAt: '2026-06-02T23:12:57.000Z',
            dispatchedAt: '2026-06-02T23:12:57.000Z',
            startedAt: '2026-06-02T23:13:00.000Z',
          });
    const sessionFile = writeOpenClawSession(openclawHome, {
      instanceId: 4581,
      durableRunId: '244f30ff-cf5d-4c86-96f9-273787cf8062',
      lines: [
        {
          type: 'message',
          id: 'initial-prompt',
          timestamp: '2026-06-02T23:23:57.214Z',
          message: {
            role: 'user',
            content: 'Dispatch prompt only',
          },
        },
      ],
    });
    const trajectoryFile = writeOpenClawTrajectory(sessionFile, [
      {
        traceSchema: 'openclaw-trajectory',
        type: 'session.ended',
        ts: '2026-06-02T23:23:57.211Z',
        sessionKey: 'agent:cinder-backend:run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062',
        data: {
          status: 'error',
          promptError: JSON.stringify({
            type: 'error',
            error: { message: "The model 'gpt-image-2' does not exist." },
            status: 400,
          }),
        },
      },
    ]);

    await runWatchdogPass(db, new Date('2026-06-02T23:24:30.000Z'));
    await new Promise(resolve => setImmediate(resolve));

    const row = await db.get(`
      SELECT status, completed_at, runtime_ended_at, runtime_end_success, runtime_end_error, runtime_end_source
      FROM job_instances
      WHERE id = 4581
    `) as {
      status: string;
      completed_at: string | null;
      runtime_ended_at: string | null;
      runtime_end_success: number | null;
      runtime_end_error: string | null;
      runtime_end_source: string | null;
    };
    expect(row.status).toBe('failed');
    expect(row.completed_at).toBe('2026-06-02 23:23:57.211');
    expect(row.runtime_ended_at).toBe('2026-06-02 23:23:57.211');
    expect(row.runtime_end_success).toBe(0);
    expect(row.runtime_end_error).toBe("The model 'gpt-image-2' does not exist.");
    expect(row.runtime_end_source).toBe('watchdog_raw_session');

    const log = await db.get(`SELECT message FROM logs WHERE instance_id = 4581`) as { message: string };
    expect(log.message).toContain('trajectory_prompt_error');
    expect(log.message).toContain(trajectoryFile);
  });

  it('does not defer a prompt-only OpenClaw session forever when no terminal trajectory exists', async () => {
    await seedRunningInstance(db, {
            startedAt: null,
            createdAt: '2026-05-13T10:48:08.000Z',
            dispatchedAt: '2026-05-13T10:48:08.000Z',
          });
    writeOpenClawSession(openclawHome, {
      lines: [
        {
          type: 'message',
          id: 'initial-prompt',
          timestamp: '2026-05-13T10:59:30.000Z',
          message: {
            role: 'user',
            content: 'Dispatch prompt only',
          },
        },
      ],
    });

    await runWatchdogPass(db, new Date('2026-05-13T11:00:00.000Z'));

    const row = await db.get(`SELECT status, error, runtime_end_source FROM job_instances WHERE id = 42`) as {
      status: string;
      error: string | null;
      runtime_end_source: string | null;
    };
    expect(row.status).toBe('failed');
    expect(row.error).toBe('Watchdog: startup timeout: no real start/check-in within 5m');
    expect(row.runtime_end_source).toBe('watchdog');
  });
});

describe('watchdog worktree pruning notifications', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb();
    jest.mocked(pruneOrphanedWorktrees).mockReset();
  });

  afterEach(() => {
    db.close();
  });

  it('records prune notifications in the pruned agent tenant instead of the active tenant', async () => {
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (2, 'Tenant 2', 'tenant-2', 0)`);
    await setActiveTenantId(db, 1);
    await db.run(`
      INSERT INTO projects (id, tenant_id, name, repo_path, repo_access_mode)
      VALUES (200, 2, 'Tenant 2 Project', '/repo/from-project', 'worktree')
    `);
    await db.run(`
      INSERT INTO agents (
        id, tenant_id, project_id, name, workspace_path, repo_path, repo_access_mode
      )
      VALUES (94, 2, 200, 'Cinder', '/workspace/cinder', '/repo/from-agent', 'worktree')
    `);
    jest.mocked(pruneOrphanedWorktrees).mockReturnValue({
      pruned: ['/workspace/cinder/task-776'],
      errors: [],
    });

    await runWorktreePrunePass(db);

    const notification = await db.get(`
      SELECT tenant_id, type, title, body, source, outlet, metadata_json
      FROM notification_records
      WHERE type = 'worktree_pruned'
    `) as {
      tenant_id: number;
      type: string;
      title: string;
      body: string;
      source: string;
      outlet: string;
      metadata_json: string;
    };
    expect(notification.tenant_id).toBe(2);
    expect(notification.title).toBe('🧹 Watchdog pruned 1 worktree');
    expect(notification.body).toBe('Pruned 1 orphaned worktree for Cinder.');
    expect(notification.source).toBe('watchdog');
    expect(notification.outlet).toBe('agent_hq');
    expect(JSON.parse(notification.metadata_json)).toEqual({
      agentId: 94,
      agentName: 'Cinder',
      prunedCount: 1,
    });
  });
});
