import { setupTestDb, teardownTestDb } from '../db/testDb';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
  const db = await setupTestDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Test', 'test', 1)`);
  await db.run(`
    INSERT INTO app_settings (key, value)
    VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')
  `);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Test')`);
  await db.run(`INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type) VALUES (1, 1, 1, 'Test workflow', 'generic')`);
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
  await db.run(`
    INSERT INTO tasks (id, tenant_id, project_id, workflow_id, title)
    VALUES (?, 1, 1, 1, 'Task')
  `, taskId);
  await db.run(`
    INSERT INTO job_instances (
      id, agent_id, task_id, status, created_at, dispatched_at, started_at, session_key,
      lifecycle_outcome_posted_at
    )
    VALUES (?, 94, ?, 'running', ?, ?, ?, ?, ?)
  `, instanceId, taskId, createdAt, dispatchedAt, startedAt, `run:${instanceId}:${durableRunId}`, createdAt);
  await db.run(`UPDATE tasks SET active_instance_id = ? WHERE id = ?`, instanceId, taskId);
  await db.run(`
    INSERT INTO instance_artifacts (instance_id, task_id, started_at)
    VALUES (?, ?, ?)
  `, instanceId, taskId, startedAt);
}

jest.mock('../domains/runs/stopInstanceExecution', () => ({
  abortInstanceExecutionTransport: jest.fn(async () => ({ result: { attempted: true, ok: true } })),
}));
jest.mock('../domains/runs/openclawSessionState', () => ({ evaluateOpenClawInstanceSessionState: jest.fn() }));
jest.mock('../domains/runs/runtimeSessionState', () => ({ evaluateRuntimeInstanceLiveness: jest.fn() }));

import { abortInstanceExecutionTransport } from '../domains/runs/stopInstanceExecution';
import { evaluateOpenClawInstanceSessionState } from '../domains/runs/openclawSessionState';
import { evaluateRuntimeInstanceLiveness } from '../domains/runs/runtimeSessionState';

const NOW = new Date('2026-05-13T11:00:00.000Z');
describe('watchdog uses inbound Agent HQ activity only', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createDb();
    jest.clearAllMocks();
    await seedRunningInstance(db);
    await db.run(`UPDATE job_instances SET tenant_id = 1, first_agent_call_at = started_at WHERE id = 42`);
  });
  afterEach(async () => { await teardownTestDb(); });

  it('keeps a run alive after a recent authenticated Agent HQ call', async () => {
    await db.run(`UPDATE job_instances SET last_agent_call_at = '2026-05-13 10:59:30' WHERE id = 42`);
    await runWatchdogPass(db, NOW);
    expect(await db.value('SELECT status FROM job_instances WHERE id = 42')).toBe('running');
    expect(abortInstanceExecutionTransport).not.toHaveBeenCalled();
  });

  it('ignores runtime heartbeat/output and never probes runtime state', async () => {
    await db.run(`UPDATE instance_artifacts SET last_agent_heartbeat_at = '2026-05-13 10:59:59',
      last_meaningful_output_at = '2026-05-13 10:59:59' WHERE instance_id = 42`);
    await runWatchdogPass(db, NOW);
    expect(await db.value('SELECT status FROM job_instances WHERE id = 42')).toBe('failed');
    expect(await db.value('SELECT active_instance_id FROM tasks WHERE id = 478')).toBeNull();
    expect(evaluateOpenClawInstanceSessionState).not.toHaveBeenCalled();
    expect(evaluateRuntimeInstanceLiveness).not.toHaveBeenCalled();
    expect(abortInstanceExecutionTransport).toHaveBeenCalledTimes(1);
  });

  it('rechecks an Agent HQ call that arrives after the initial scan before aborting', async () => {
    const all = db.all.bind(db);
    const spy = jest.spyOn(db, 'all').mockImplementation(async (sql, ...params) => {
      const result = await all(sql, ...params);
      if (sql.includes('ji.first_agent_call_at')) {
        await db.run(`UPDATE job_instances SET last_agent_call_at = '2026-05-13 10:59:59' WHERE id = 42`);
      }
      return result as never;
    });
    try { await runWatchdogPass(db, NOW); } finally { spy.mockRestore(); }
    expect(await db.value('SELECT status FROM job_instances WHERE id = 42')).toBe('running');
    expect(abortInstanceExecutionTransport).not.toHaveBeenCalled();
  });

  it('allows only one overlapping watchdog pass to expire and abort the run', async () => {
    await Promise.all([runWatchdogPass(db, NOW), runWatchdogPass(db, NOW)]);
    expect(await db.value('SELECT status FROM job_instances WHERE id = 42')).toBe('failed');
    expect(abortInstanceExecutionTransport).toHaveBeenCalledTimes(1);
  });

  it('accepts a first tool call during startup without needing transcript/start telemetry', async () => {
    await db.run(`UPDATE job_instances SET status = 'dispatched', started_at = NULL,
      first_agent_call_at = '2026-05-13 10:59:00', last_agent_call_at = '2026-05-13 10:59:00' WHERE id = 42`);
    await runWatchdogPass(db, NOW);
    expect(await db.value('SELECT status FROM job_instances WHERE id = 42')).toBe('dispatched');
  });

  it('expires silent startup and keeps the configured total execution cap', async () => {
    await db.run(`UPDATE job_instances SET started_at = NULL, first_agent_call_at = NULL WHERE id = 42`);
    await runWatchdogPass(db, NOW);
    expect(await db.value('SELECT error FROM job_instances WHERE id = 42')).toContain('startup timeout');
    await db.run(`UPDATE job_instances SET status = 'running', first_agent_call_at = '2026-05-13 10:00:00',
      last_agent_call_at = '2026-05-13 10:59:59' WHERE id = 42`);
    await runWatchdogPass(db, NOW);
    expect(await db.value('SELECT error FROM job_instances WHERE id = 42')).toContain('execution timeout');
  });
});

describe('watchdog worktree pruning notifications', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb();
    jest.mocked(pruneOrphanedWorktrees).mockReset();
  });

  afterEach(async () => {
    await teardownTestDb();
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
        id, tenant_id, project_id, name, session_key, workspace_path, repo_path, repo_access_mode
      )
      VALUES (94, 2, 200, 'Cinder', 'agent:cinder:main', '/workspace/cinder', '/repo/from-agent', 'worktree')
    `);
    jest.mocked(pruneOrphanedWorktrees).mockResolvedValue({
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
