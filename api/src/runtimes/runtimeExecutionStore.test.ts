// Several adapter/reconciler suites mock this module. Pin this fault-injection
// suite to the real transactional implementation when Jest reuses a worker.
jest.unmock('./runtimeExecutionStore');

import type { Db, RunResult, SqlParam } from '../db/adapter/types';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import type { RuntimeBoundaryV1, RuntimeCheckpointKind } from './runtimeBoundary';
import {
  clearRuntimeExecutionStoreAvailabilityCache,
  interruptRuntimeExecution,
  terminalRuntimeExecution,
  upsertRuntimeExecutionStart,
} from './runtimeExecutionStore';

function boundary(instanceId = 4711): RuntimeBoundaryV1 {
  return {
    version: 1,
    identity: {
      tenantId: 1,
      projectId: null,
      workflowId: null,
      taskId: null,
      instanceId,
      durableRunId: `durable-${instanceId}`,
      agentId: 14,
      agentSlug: 'runtime-test',
    },
    runtime: {
      type: 'claude-code',
      driverVersion: 'claude-code-driver/1',
      executableFingerprint: 'sha256:test-claude-executable',
      configRevision: null,
      model: null,
      reasoning: null,
      fastMode: null,
      timeoutSeconds: 900,
      tokenBudget: null,
      turnLimit: null,
    },
    workspace: {
      workspaceRoot: '/tmp/runtime-test',
      activeRepoRoot: '/tmp/runtime-test/repo',
      repoAccessMode: 'worktree',
      repoSource: 'worktree:/tmp/source',
      branch: 'runtime-test',
      commit: 'abc123',
      fingerprint: 'sha256:workspace',
    },
    prompt: { bundleFingerprint: 'sha256:prompt' },
    executionTarget: {
      id: 'local:test',
      kind: 'local-process',
      trustLevel: 'workspace',
      capabilities: ['signals', 'inspect'],
    },
    tools: {
      builtIn: [],
      mcpServers: [],
      requiredLifecycleTools: [],
      skills: [],
      registryTools: [],
    },
    auth: { provider: null, providerConnectionId: null, credentialRefs: [] },
    evidence: { required: false, requirements: [] },
    callback: { identity: `instance:${instanceId}` },
    priorCheckpoint: null,
    observability: {
      traceId: `trace-${instanceId}`,
      correlationId: `run-${instanceId}`,
      requestedBy: null,
    },
  };
}

function startInput(instanceId = 4711) {
  const startedAt = '2026-08-04 12:00:00';
  return {
    boundary: boundary(instanceId),
    driver: 'claude-code',
    backend: 'local-process',
    state: 'running' as const,
    launchSpec: {
      version: 1 as const,
      command: '/usr/local/bin/claude',
      executableFingerprint: 'sha256:test-claude-executable',
      args: ['--print', '-'],
      cwd: '/tmp/runtime-test/repo',
      envKeys: ['PATH'],
    },
    handle: {
      version: 1 as const,
      kind: 'local-process' as const,
      pid: 8123,
      processGroupId: 8123,
      processIdentity: 'sha256:test-process',
      hostname: 'test-host',
      startedAt,
    },
    sessionId: 'claude-session',
    startedAt,
    checkpointData: { runId: `claude-code:${instanceId}` },
  };
}

/**
 * Inject a checkpoint write failure through the Db contract itself. The wrapped
 * transaction still uses PostgresAdapter's connection-bound handle, so the test
 * proves the surrounding state change rolls back without creating test-only
 * triggers or mutating the shared schema.
 */
class FailingCheckpointDb implements Db {
  constructor(
    private readonly inner: Db,
    private readonly kind: RuntimeCheckpointKind,
  ) {}

  get inTransaction(): boolean {
    return this.inner.inTransaction;
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    ...params: SqlParam[]
  ): Promise<T | undefined> {
    if (/\bINSERT\s+INTO\s+runtime_checkpoints\b/i.test(sql) && params[4] === this.kind) {
      throw new Error(`injected ${this.kind} checkpoint failure`);
    }
    return await this.inner.get<T>(sql, ...params);
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T[]> {
    return await this.inner.all<T>(sql, ...params);
  }

  async run(sql: string, ...params: SqlParam[]): Promise<RunResult> {
    return await this.inner.run(sql, ...params);
  }

  async value<T = unknown>(sql: string, ...params: SqlParam[]): Promise<T | undefined> {
    return await this.inner.value<T>(sql, ...params);
  }

  async exec(sql: string): Promise<void> {
    await this.inner.exec(sql);
  }

  async withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return await this.inner.withTransaction(async (tx) =>
      await fn(new FailingCheckpointDb(tx, this.kind)));
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

describe('runtime execution store atomicity', () => {
  let db: Db;

  beforeEach(async () => {
    db = await setupTestDb();
    clearRuntimeExecutionStoreAvailabilityCache(db);
    await db.run(`INSERT INTO tenants (id, name, slug) VALUES (1, 'Runtime Tests', 'runtime-tests')`);
    await db.run(`
      INSERT INTO agents (id, tenant_id, name, role, session_key, runtime_type)
      VALUES (14, 1, 'Runtime Test', 'test', 'agent:runtime-test:main', 'claude-code')
    `);
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, agent_id, status, durable_run_id)
      VALUES (4711, 1, 14, 'running', 'durable-4711')
    `);
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('claims a launch and its launched checkpoint in one transaction', async () => {
    const result = await upsertRuntimeExecutionStart(db, startInput());
    expect(result).toMatchObject({
      status: 'persisted',
      executionId: expect.any(Number),
      checkpointId: expect.any(Number),
      sequence: 0,
      idempotent: false,
    });

    const checkpoint = await db.get<{ kind: string; checkpoint_data: Record<string, unknown> }>(`
      SELECT kind, checkpoint_data FROM runtime_checkpoints WHERE execution_id = ?
    `, result.executionId);
    expect(checkpoint).toEqual({
      kind: 'launched',
      checkpoint_data: { runId: 'claude-code:4711' },
    });
  });

  it('rolls back the launch claim when launched-checkpoint persistence fails', async () => {
    const failingDb = new FailingCheckpointDb(db, 'launched');

    await expect(upsertRuntimeExecutionStart(failingDb, startInput()))
      .rejects.toThrow('injected launched checkpoint failure');
    await expect(db.value<number>('SELECT COUNT(*) FROM runtime_executions'))
      .resolves.toBe(0);
    await expect(db.value<number>('SELECT COUNT(*) FROM runtime_checkpoints'))
      .resolves.toBe(0);
  });

  it('accepts only an exact retry and never overwrites a conflicting process handle', async () => {
    const original = startInput();
    const claimed = await upsertRuntimeExecutionStart(db, original);
    const retry = await upsertRuntimeExecutionStart(db, {
      ...original,
      // Key insertion order may differ; canonical JSON still proves this is the
      // exact same checkpoint evidence.
      checkpointData: { runId: 'claude-code:4711' },
    });
    expect(retry).toEqual({
      status: 'persisted',
      executionId: claimed.executionId,
      checkpointId: claimed.checkpointId,
      sequence: 0,
      idempotent: true,
    });

    const conflicting = await upsertRuntimeExecutionStart(db, {
      ...original,
      handle: {
        ...original.handle,
        pid: 9001,
        processGroupId: 9001,
        processIdentity: 'sha256:different-process',
      },
    });
    expect(conflicting).toMatchObject({
      status: 'conflict',
      executionId: claimed.executionId,
      checkpointId: null,
      idempotent: false,
    });

    const stored = await db.get<{ opaque_handle: { pid: number; processGroupId: number; processIdentity: string } }>(`
      SELECT opaque_handle FROM runtime_executions WHERE id = ?
    `, claimed.executionId);
    expect(stored?.opaque_handle).toMatchObject({
      pid: 8123,
      processGroupId: 8123,
      processIdentity: 'sha256:test-process',
    });
    await expect(db.value<number>('SELECT COUNT(*) FROM runtime_checkpoints'))
      .resolves.toBe(1);
  });

  it('rolls back an interrupt state transition when its checkpoint fails', async () => {
    await upsertRuntimeExecutionStart(db, startInput());
    const failingDb = new FailingCheckpointDb(db, 'interrupt_requested');

    await expect(interruptRuntimeExecution(failingDb, {
      instanceId: 4711,
      tenantId: 1,
      reason: 'operator stop',
      requestedAt: '2026-08-04 12:01:00',
    })).rejects.toThrow('injected interrupt_requested checkpoint failure');
    await expect(db.value<string>(`
      SELECT state FROM runtime_executions WHERE instance_id = 4711
    `)).resolves.toBe('running');
    await expect(db.value<number>(`
      SELECT COUNT(*) FROM runtime_checkpoints WHERE kind = 'interrupt_requested'
    `)).resolves.toBe(0);
  });

  it('rolls back terminal truth when its checkpoint fails', async () => {
    await upsertRuntimeExecutionStart(db, startInput());
    const failingDb = new FailingCheckpointDb(db, 'terminal');

    await expect(terminalRuntimeExecution(failingDb, {
      instanceId: 4711,
      tenantId: 1,
      state: 'failed',
      reason: 'error',
      error: 'runtime exited',
      endedAt: '2026-08-04 12:02:00',
    })).rejects.toThrow('injected terminal checkpoint failure');
    const stored = await db.get<{ state: string; ended_at: string | null }>(`
      SELECT state, ended_at FROM runtime_executions WHERE instance_id = 4711
    `);
    expect(stored).toEqual({ state: 'running', ended_at: null });
    await expect(db.value<number>(`
      SELECT COUNT(*) FROM runtime_checkpoints WHERE kind = 'terminal'
    `)).resolves.toBe(0);
  });
});
