import type { Db } from '../db/adapter/types';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import type { RuntimeBoundaryV1 } from './runtimeBoundary';
import {
  appendRuntimeCheckpoint,
  clearRuntimeExecutionStoreAvailabilityCache,
  heartbeatRuntimeExecution,
  interruptRuntimeExecution,
  terminalRuntimeExecution,
  upsertRuntimeExecutionStart,
} from './runtimeExecutionStore';

function boundary(): RuntimeBoundaryV1 {
  return {
    version: 1,
    identity: {
      tenantId: 1,
      projectId: null,
      workflowId: null,
      taskId: null,
      instanceId: 4711,
      durableRunId: 'durable-4711',
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
    },
    auth: { provider: null, providerConnectionId: null, credentialRefs: [] },
    evidence: { required: false, requirements: [] },
    callback: { identity: 'instance:4711' },
    priorCheckpoint: null,
    observability: { traceId: 'trace-4711', correlationId: 'run-4711', requestedBy: null },
  };
}

describe('runtime execution persistence', () => {
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

  it('persists start, ordered checkpoints, heartbeat, interrupt and one terminal claim', async () => {
    const started = await upsertRuntimeExecutionStart(db, {
      boundary: boundary(),
      driver: 'claude-code',
      backend: 'local-process',
      state: 'running',
      launchSpec: {
        version: 1,
        command: 'claude',
        executableFingerprint: 'sha256:test-claude-executable',
        args: ['--print', '-'],
        cwd: '/tmp/runtime-test/repo',
        envKeys: ['PATH'],
      },
      handle: {
        version: 1,
        kind: 'local-process',
        pid: 8123,
        processGroupId: 8123,
        processIdentity: 'sha256:test-process',
        hostname: 'test-host',
        startedAt: '2026-08-04 12:00:00',
      },
      sessionId: 'claude-session',
      startedAt: '2026-08-04 12:00:00',
      checkpointData: { runId: 'claude-code:4711' },
    });
    expect(started).toMatchObject({
      status: 'persisted',
      executionId: expect.any(Number),
      checkpointId: expect.any(Number),
      sequence: 0,
      idempotent: false,
    });

    await expect(heartbeatRuntimeExecution(db, {
      instanceId: 4711,
      tenantId: 2,
      heartbeatAt: '2026-08-04 12:00:05',
    })).resolves.toMatchObject({ status: 'not_found' });
    await expect(terminalRuntimeExecution(db, {
      instanceId: 4711,
      tenantId: 2,
      state: 'failed',
      reason: 'cross-tenant update',
    })).resolves.toMatchObject({ status: 'not_found' });

    const progress = await appendRuntimeCheckpoint(db, {
      executionId: started.executionId as number,
      kind: 'progress',
      state: 'running',
      transcriptCursor: { line: 12 },
      data: { stage: 'implementing' },
      createdAt: '2026-08-04 12:00:10',
    });
    expect(progress).toMatchObject({ status: 'persisted', sequence: 1 });

    await heartbeatRuntimeExecution(db, {
      instanceId: 4711,
      tenantId: 1,
      heartbeatAt: '2026-08-04 12:00:20',
      leaseOwner: 'api:test-host',
      leaseExpiresAt: '2026-08-04 12:01:20',
    });
    await interruptRuntimeExecution(db, {
      instanceId: 4711,
      tenantId: 1,
      reason: 'operator stop',
      requestedAt: '2026-08-04 12:00:30',
    });
    const terminal = await terminalRuntimeExecution(db, {
      instanceId: 4711,
      tenantId: 1,
      state: 'cancelled',
      reason: 'aborted',
      endedAt: '2026-08-04 12:00:31',
    });
    expect(terminal.status).toBe('persisted');
    await expect(terminalRuntimeExecution(db, {
      instanceId: 4711,
      tenantId: 1,
      state: 'failed',
      reason: 'late duplicate',
    })).resolves.toMatchObject({ status: 'not_found' });

    const execution = await db.get<{
      state: string;
      backend: string;
      heartbeat_at: string;
      lease_owner: string | null;
      boundary_json: RuntimeBoundaryV1;
    }>(`
      SELECT state, backend, heartbeat_at, lease_owner, boundary_json
      FROM runtime_executions WHERE instance_id = 4711
    `);
    expect(execution).toMatchObject({
      state: 'cancelled',
      backend: 'local-process',
      heartbeat_at: '2026-08-04 12:00:31',
      lease_owner: null,
      boundary_json: expect.objectContaining({ version: 1 }),
    });

    const checkpoints = await db.all<{ sequence: number; kind: string; state: string }>(`
      SELECT sequence, kind, state
      FROM runtime_checkpoints
      WHERE execution_id = ?
      ORDER BY sequence
    `, started.executionId);
    expect(checkpoints).toEqual([
      { sequence: 0, kind: 'launched', state: 'running' },
      { sequence: 1, kind: 'progress', state: 'running' },
      { sequence: 2, kind: 'interrupt_requested', state: 'interrupting' },
      { sequence: 3, kind: 'terminal', state: 'cancelled' },
    ]);
  });

  it('serializes concurrent launch claims and preserves only the winning process handle', async () => {
    const common = {
      boundary: boundary(),
      driver: 'claude-code',
      backend: 'local-process',
      state: 'running' as const,
      launchSpec: {
        version: 1 as const,
        command: 'claude',
        executableFingerprint: 'sha256:test-claude-executable',
        args: ['--print', '-'],
        cwd: '/tmp/runtime-test/repo',
        envKeys: ['PATH'],
      },
      sessionId: 'claude-session',
      startedAt: '2026-08-04 13:00:00',
      checkpointData: { runId: 'claude-code:4711' },
    };
    const handles = [8123, 9123].map((pid) => ({
      version: 1 as const,
      kind: 'local-process' as const,
      pid,
      processGroupId: pid,
      processIdentity: `sha256:test-process-${pid}`,
      hostname: 'test-host',
      startedAt: common.startedAt,
    }));

    const results = await Promise.all(handles.map((handle) =>
      upsertRuntimeExecutionStart(db, { ...common, handle })));
    expect(results.map((result) => result.status).sort()).toEqual(['conflict', 'persisted']);

    const winningIndex = results.findIndex((result) => result.status === 'persisted');
    const execution = await db.get<{ opaque_handle: { pid: number; processIdentity: string } }>(`
      SELECT opaque_handle FROM runtime_executions WHERE instance_id = 4711
    `);
    expect(execution?.opaque_handle).toMatchObject({
      pid: handles[winningIndex].pid,
      processIdentity: handles[winningIndex].processIdentity,
    });
    await expect(db.value<number>(`
      SELECT COUNT(*) FROM runtime_checkpoints WHERE kind = 'launched'
    `)).resolves.toBe(1);
  });
});
