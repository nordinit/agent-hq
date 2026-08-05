import Database from 'better-sqlite3';

// Several adapter/reconciler suites mock this module. Jest 30 can retain an
// explicit mock decision while discovering a directory of suites in one worker,
// so pin this fault-injection suite to the real transactional implementation.
jest.unmock('./runtimeExecutionStore');

import { SqliteAdapter } from '../db/adapter/SqliteAdapter';
import type { Db } from '../db/adapter/types';
import type { RuntimeBoundaryV1 } from './runtimeBoundary';
import {
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

async function testDb(): Promise<Db> {
  const db = new SqliteAdapter(new Database(':memory:'));
  await db.exec(`
    CREATE TABLE runtime_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      instance_id INTEGER NOT NULL,
      boundary_version INTEGER NOT NULL,
      boundary_json TEXT NOT NULL,
      boundary_fingerprint TEXT NOT NULL,
      runtime_type TEXT NOT NULL,
      driver TEXT NOT NULL,
      backend TEXT NOT NULL,
      execution_target_id TEXT NOT NULL,
      sanitized_launch_spec TEXT,
      opaque_handle TEXT,
      state TEXT NOT NULL,
      session_id TEXT,
      capability_snapshot TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      terminal_reason TEXT,
      terminal_error TEXT,
      terminal_metadata TEXT NOT NULL DEFAULT '{}',
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_id, instance_id)
    );
    CREATE TABLE runtime_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      execution_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      session_id TEXT,
      boundary_fingerprint TEXT NOT NULL,
      transcript_cursor TEXT,
      checkpoint_data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (execution_id, sequence)
    );
  `);
  return db;
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

describe('runtime execution store atomicity', () => {
  it('claims a launch and its launched checkpoint in one transaction', async () => {
    const db = await testDb();
    try {
      const result = await upsertRuntimeExecutionStart(db, startInput());
      expect(result).toMatchObject({
        status: 'persisted',
        executionId: expect.any(Number),
        checkpointId: expect.any(Number),
        sequence: 0,
        idempotent: false,
      });

      const checkpoint = await db.get<{ kind: string; checkpoint_data: string }>(`
        SELECT kind, checkpoint_data FROM runtime_checkpoints WHERE execution_id = ?
      `, result.executionId);
      expect(checkpoint).toEqual({
        kind: 'launched',
        checkpoint_data: JSON.stringify({ runId: 'claude-code:4711' }),
      });
    } finally {
      await db.close();
    }
  });

  it('rolls back the launch claim when launched-checkpoint persistence fails', async () => {
    const db = await testDb();
    try {
      await db.exec(`
        CREATE TRIGGER fail_launched_checkpoint
        BEFORE INSERT ON runtime_checkpoints
        WHEN NEW.kind = 'launched'
        BEGIN
          SELECT RAISE(FAIL, 'injected launched checkpoint failure');
        END;
      `);

      await expect(upsertRuntimeExecutionStart(db, startInput()))
        .rejects.toThrow('injected launched checkpoint failure');
      await expect(db.value<number>('SELECT COUNT(*) FROM runtime_executions'))
        .resolves.toBe(0);
      await expect(db.value<number>('SELECT COUNT(*) FROM runtime_checkpoints'))
        .resolves.toBe(0);
    } finally {
      await db.close();
    }
  });

  it('accepts only an exact retry and never overwrites a conflicting process handle', async () => {
    const db = await testDb();
    try {
      const original = startInput();
      const claimed = await upsertRuntimeExecutionStart(db, original);
      const retry = await upsertRuntimeExecutionStart(db, {
        ...original,
        // Key insertion order is intentionally different; canonical JSON still
        // proves this is the exact same checkpoint evidence.
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

      const stored = await db.get<{ opaque_handle: string }>(`
        SELECT opaque_handle FROM runtime_executions WHERE id = ?
      `, claimed.executionId);
      expect(JSON.parse(stored!.opaque_handle)).toMatchObject({
        pid: 8123,
        processGroupId: 8123,
        processIdentity: 'sha256:test-process',
      });
      await expect(db.value<number>('SELECT COUNT(*) FROM runtime_checkpoints'))
        .resolves.toBe(1);
    } finally {
      await db.close();
    }
  });

  it('rolls back an interrupt state transition when its checkpoint fails', async () => {
    const db = await testDb();
    try {
      await upsertRuntimeExecutionStart(db, startInput());
      await db.exec(`
        CREATE TRIGGER fail_interrupt_checkpoint
        BEFORE INSERT ON runtime_checkpoints
        WHEN NEW.kind = 'interrupt_requested'
        BEGIN
          SELECT RAISE(FAIL, 'injected interrupt checkpoint failure');
        END;
      `);

      await expect(interruptRuntimeExecution(db, {
        instanceId: 4711,
        tenantId: 1,
        reason: 'operator stop',
        requestedAt: '2026-08-04 12:01:00',
      })).rejects.toThrow('injected interrupt checkpoint failure');
      await expect(db.value<string>(`
        SELECT state FROM runtime_executions WHERE instance_id = 4711
      `)).resolves.toBe('running');
      await expect(db.value<number>(`
        SELECT COUNT(*) FROM runtime_checkpoints WHERE kind = 'interrupt_requested'
      `)).resolves.toBe(0);
    } finally {
      await db.close();
    }
  });

  it('rolls back terminal truth when its checkpoint fails', async () => {
    const db = await testDb();
    try {
      await upsertRuntimeExecutionStart(db, startInput());
      await db.exec(`
        CREATE TRIGGER fail_terminal_checkpoint
        BEFORE INSERT ON runtime_checkpoints
        WHEN NEW.kind = 'terminal'
        BEGIN
          SELECT RAISE(FAIL, 'injected terminal checkpoint failure');
        END;
      `);

      await expect(terminalRuntimeExecution(db, {
        instanceId: 4711,
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
    } finally {
      await db.close();
    }
  });
});
