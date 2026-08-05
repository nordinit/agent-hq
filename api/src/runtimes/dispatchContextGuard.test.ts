import type { Db } from '../db/adapter/types';
import type { RuntimeBoundaryV1 } from './runtimeBoundary';
import { guardLocalRuntimeDispatchContext } from './dispatchContextGuard';

function boundary(): RuntimeBoundaryV1 {
  return {
    version: 1,
    identity: {
      tenantId: 2,
      projectId: 3,
      workflowId: null,
      taskId: 5,
      instanceId: 7,
      durableRunId: 'durable-7',
      agentId: 42,
      agentSlug: 'cinder',
    },
    runtime: {
      type: 'codex',
      driverVersion: 'codex-driver/1',
      executableFingerprint: 'sha256:test-codex-executable',
      configRevision: 'sha256:config',
      model: 'gpt-5.5',
      reasoning: 'high',
      fastMode: false,
      timeoutSeconds: 60,
      tokenBudget: null,
      turnLimit: null,
    },
    workspace: {
      workspaceRoot: '/work/cinder',
      activeRepoRoot: '/work/cinder/task-7',
      repoAccessMode: 'worktree',
      repoSource: 'worktree:/repo',
      branch: 'agent/task-7',
      commit: null,
      fingerprint: 'sha256:workspace',
    },
    prompt: { bundleFingerprint: 'sha256:prompt' },
    executionTarget: {
      id: 'local:codex',
      kind: 'local-process',
      trustLevel: 'workspace',
      capabilities: ['signals', 'workspace-write'],
    },
    tools: { builtIn: ['shell'], mcpServers: [], requiredLifecycleTools: [], skills: [] },
    auth: { provider: 'openai-codex', providerConnectionId: 9, credentialRefs: [] },
    evidence: { required: false, requirements: [] },
    callback: { identity: 'run:7' },
    priorCheckpoint: null,
    observability: {
      traceId: 'trace-7',
      correlationId: 'dispatch-7',
      requestedBy: 'test',
    },
  };
}

function mockDb(row: { agent_id?: number; tenant_id?: number | null } | null | undefined = {
  agent_id: 42,
  tenant_id: 2,
}): Db & { get: jest.Mock } {
  return {
    dialect: 'sqlite',
    inTransaction: false,
    get: jest.fn(async () => row),
    all: jest.fn(async () => []),
    value: jest.fn(async () => undefined),
    run: jest.fn(async () => ({ changes: 0, lastInsertId: null })),
    exec: jest.fn(async () => undefined),
    withTransaction: jest.fn(),
    close: jest.fn(async () => undefined),
  } as unknown as Db & { get: jest.Mock };
}

describe('guardLocalRuntimeDispatchContext', () => {
  it('accepts a validated production context with authoritative ownership', async () => {
    const db = mockDb();
    await expect(guardLocalRuntimeDispatchContext({
      runtimeType: 'codex',
      agentSlug: 'cinder',
      db,
      instanceId: 7,
      runtimeBoundary: boundary(),
      platform: 'darwin',
    })).resolves.toMatchObject({
      mode: 'production',
      instanceId: 7,
      tenantId: 2,
      agentId: 42,
    });
    expect(db.get).toHaveBeenCalledWith(
      'SELECT agent_id, tenant_id FROM job_instances WHERE id = ?',
      7,
    );
  });

  it('accepts only an explicit, entirely boundaryless ad-hoc context', async () => {
    await expect(guardLocalRuntimeDispatchContext({
      runtimeType: 'codex',
      agentSlug: 'diagnostic',
      dispatchMode: 'ad-hoc',
      platform: 'linux',
    })).resolves.toEqual({
      mode: 'ad-hoc',
      db: null,
      instanceId: null,
      boundary: null,
      tenantId: null,
      agentId: null,
    });

    await expect(guardLocalRuntimeDispatchContext({
      runtimeType: 'codex',
      agentSlug: 'diagnostic',
      dispatchMode: 'ad-hoc',
      instanceId: 7,
      platform: 'linux',
    })).rejects.toThrow(/db, instanceId, and runtimeBoundary to all be absent/);
  });

  it.each([
    ['nothing', {}],
    ['db only', { db: mockDb() }],
    ['instance only', { instanceId: 7 }],
    ['boundary only', { runtimeBoundary: boundary() }],
    ['db and instance', { db: mockDb(), instanceId: 7 }],
  ])('rejects incomplete production context: %s', async (_name, incomplete) => {
    await expect(guardLocalRuntimeDispatchContext({
      runtimeType: 'codex',
      agentSlug: 'cinder',
      platform: 'linux',
      ...incomplete,
    })).rejects.toThrow(/requires db, instanceId, and runtimeBoundary/);
  });

  it('validates the boundary before querying ownership', async () => {
    const db = mockDb();
    const invalid = boundary() as unknown as Record<string, unknown>;
    invalid.version = 99;
    await expect(guardLocalRuntimeDispatchContext({
      runtimeType: 'codex',
      agentSlug: 'cinder',
      db,
      instanceId: 7,
      runtimeBoundary: invalid as unknown as RuntimeBoundaryV1,
      platform: 'linux',
    })).rejects.toThrow(/Invalid RuntimeBoundaryV1/);
    expect(db.get).not.toHaveBeenCalled();
  });

  it.each([
    ['instance', (value: RuntimeBoundaryV1) => { value.identity.instanceId = 8; }, /instance 8/],
    ['runtime', (value: RuntimeBoundaryV1) => { value.runtime.type = 'claude-code'; }, /type claude-code/],
    ['agent slug', (value: RuntimeBoundaryV1) => { value.identity.agentSlug = 'other'; }, /agent slug/],
    ['target', (value: RuntimeBoundaryV1) => { value.executionTarget.kind = 'managed'; }, /local-process boundary target/],
  ])('rejects boundary %s mismatch before ownership lookup', async (_name, mutate, error) => {
    const db = mockDb();
    const value = boundary();
    mutate(value);
    await expect(guardLocalRuntimeDispatchContext({
      runtimeType: 'codex',
      agentSlug: 'cinder',
      db,
      instanceId: 7,
      runtimeBoundary: value,
      platform: 'linux',
    })).rejects.toThrow(error);
    expect(db.get).not.toHaveBeenCalled();
  });

  it.each([
    ['missing row', null],
    ['missing tenant', { agent_id: 42, tenant_id: null }],
    ['wrong tenant', { agent_id: 42, tenant_id: 9 }],
    ['wrong agent', { agent_id: 99, tenant_id: 2 }],
  ])('rejects non-authoritative ownership: %s', async (_name, row) => {
    await expect(guardLocalRuntimeDispatchContext({
      runtimeType: 'codex',
      agentSlug: 'cinder',
      db: mockDb(row),
      instanceId: 7,
      runtimeBoundary: boundary(),
      platform: 'linux',
    })).rejects.toThrow(/authoritative|does not match/);
  });

  it('fails local Claude and Codex dispatch on win32 before any DB lookup', async () => {
    for (const runtimeType of ['claude-code', 'codex'] as const) {
      const db = mockDb();
      await expect(guardLocalRuntimeDispatchContext({
        runtimeType,
        agentSlug: 'cinder',
        db,
        instanceId: 7,
        runtimeBoundary: boundary(),
        platform: 'win32',
      })).rejects.toThrow(/unsupported on win32/);
      expect(db.get).not.toHaveBeenCalled();
    }
  });
});
