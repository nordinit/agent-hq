import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

const mockSpawn = jest.fn();
const mockValidateAndLogViolation = jest.fn(async (..._args: unknown[]) => undefined);
const mockMaterializeMcp = jest.fn();
const mockCleanupMcpRunConfig = jest.fn();
const mockReadPreviousRunServers = jest.fn(
  (..._args: unknown[]): Record<string, Record<string, unknown>> => ({}),
);
const mockApplyRuntimeEnd = jest.fn(async (..._args: unknown[]) => ({ changed: true }));
const mockPreflight = jest.fn(async (..._args: unknown[]) => [] as unknown[]);
const mockPersistExecutionStart = jest.fn(async (..._args: unknown[]) => ({
  status: 'persisted' as const,
  executionId: 71,
  checkpointId: 72,
  sequence: 0,
}));
const mockAppendRuntimeCheckpoint = jest.fn(async (..._args: unknown[]) => ({
  status: 'persisted' as const,
  executionId: 71,
  checkpointId: 72,
  sequence: 0,
}));
const mockPersistExecutionTerminal = jest.fn(async (..._args: unknown[]) => ({
  status: 'persisted' as const,
  executionId: 71,
}));
const mockLocalProcessIdentity = jest.fn<string | null, [number]>(
  (_pid: number) => 'sha256:test-process-birth',
);
const mockCleanupOwnedProcessTree = jest.fn(async (..._args: unknown[]) => ({
  confirmed: true,
  escalated: false,
  scope: 'process-group' as const,
  error: undefined as string | undefined,
}));
const mockResolveRuntimeExecutable = jest.fn((..._args: unknown[]) => ({
  path: '/opt/agent-hq/bin/claude',
  fingerprint: 'sha256:test-claude-executable',
}));
const mockProbeRuntimeCliVersion = jest.fn(async (..._args: unknown[]) => ({
  ok: true,
  version: 'Claude Code 2.1.220',
  executablePath: '/opt/agent-hq/bin/claude',
  executableFingerprint: 'sha256:test-claude-executable',
  message: 'Claude Code 2.1.220 (supported)',
  details: {
    minimum_supported: '2.1.220',
    maximum_exclusive: '2.2.0',
    detected: '2.1.220',
    executable_path: '/opt/agent-hq/bin/claude',
    executable_fingerprint: 'sha256:test-claude-executable',
  },
}));
const mockAssertRuntimeBoundaryAssignmentsCurrent = jest.fn(
  async (..._args: unknown[]) => undefined,
);

// Only `spawn` is replaced. Replacing the whole child_process module would also
// blank execFileSync/execSync for everything this file transitively imports.
jest.mock('child_process', () => ({
  ...(jest.requireActual('child_process') as object),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock('../localProcessSupervisor', () => ({
  ...(jest.requireActual('../localProcessSupervisor') as object),
  localProcessIdentity: (pid: number) => mockLocalProcessIdentity(pid),
}));

jest.mock('../ownedProcessTreeCleanup', () => ({
  ...(jest.requireActual('../ownedProcessTreeCleanup') as object),
  cleanupOwnedProcessTree: (...args: unknown[]) => mockCleanupOwnedProcessTree(...args),
}));

jest.mock('../executablePolicy', () => ({
  ...(jest.requireActual('../executablePolicy') as object),
  resolveAllowedRuntimeExecutable: (...args: unknown[]) => mockResolveRuntimeExecutable(...args),
}));

jest.mock('../runtimeCliVersion', () => ({
  ...(jest.requireActual('../runtimeCliVersion') as object),
  probeAllowedRuntimeCliVersion: (...args: unknown[]) => mockProbeRuntimeCliVersion(...args),
}));

jest.mock('../../services/runtimeBoundaryAssignments', () => ({
  ...(jest.requireActual('../../services/runtimeBoundaryAssignments') as object),
  assertRuntimeBoundaryAssignmentsCurrent: (...args: unknown[]) => (
    mockAssertRuntimeBoundaryAssignmentsCurrent(...args)
  ),
}));

jest.mock('../../lib/workspaceBoundary', () => ({
  validateAndLogViolation: (...args: unknown[]) => mockValidateAndLogViolation(...args),
}));

jest.mock('./mcpConfig', () => ({
  materializeClaudeCodeMcpConfig: (...args: unknown[]) => mockMaterializeMcp(...args),
  cleanupClaudeCodeMcpRunConfig: (...args: unknown[]) => mockCleanupMcpRunConfig(...args),
  readPreviousRunServers: (...args: unknown[]) => mockReadPreviousRunServers(...args),
}));

jest.mock('./mcpPreflight', () => ({
  // describeMcpPreflightFailure stays real so the thrown message is the production one.
  ...(jest.requireActual('./mcpPreflight') as object),
  preflightMcpServers: (...args: unknown[]) => mockPreflight(...args),
}));

jest.mock('../../domains/runs/runtimeEnd', () => ({
  applyRuntimeEndToJobInstance: (...args: unknown[]) => mockApplyRuntimeEnd(...args),
}));

jest.mock('../runtimeExecutionStore', () => ({
  upsertRuntimeExecutionStart: (...args: unknown[]) => mockPersistExecutionStart(...args),
  appendRuntimeCheckpoint: (...args: unknown[]) => mockAppendRuntimeCheckpoint(...args),
  terminalRuntimeExecution: (...args: unknown[]) => mockPersistExecutionTerminal(...args),
}));

import { ClaudeCodeRuntime } from './ClaudeCodeRuntime';
import type { DispatchParams } from '../types';

interface MockChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: jest.Mock;
  pid: number;
}

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn(() => true);
  child.pid = 4242;
  return child;
}

function createMockDb() {
  const runs: Array<{ sql: string; params: unknown[] }> = [];
  return {
    runs,
    dialect: 'postgres' as const,
    inTransaction: false,
    get: jest.fn(async (sql: string) =>
      sql.includes('agent_id') ? { agent_id: 42, tenant_id: 2 } : undefined,
    ),
    all: jest.fn(async () => []),
    value: jest.fn(async () => undefined),
    run: jest.fn(async (sql: string, ...params: unknown[]) => {
      runs.push({ sql, params });
      return { changes: 1, lastInsertId: null };
    }),
    exec: jest.fn(async () => undefined),
    withTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(null)),
    close: jest.fn(async () => undefined),
  };
}

function runsMatching(db: ReturnType<typeof createMockDb>, fragment: string) {
  return db.runs.filter((entry) => entry.sql.includes(fragment));
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function runtimeBoundary(
  instanceId = 7,
  agentSlug = 'forge',
  tools: {
    mcpServers?: Array<{
      name: string;
      configFingerprint: string;
      requiredToolNames: string[];
    }>;
    requiredLifecycleTools?: string[];
  } = {},
) {
  return {
    version: 1,
    identity: {
      tenantId: 2,
      projectId: 3,
      workflowId: null,
      taskId: 99,
      instanceId,
      durableRunId: `drun-${instanceId}`,
      agentId: 42,
      agentSlug,
    },
    runtime: {
      type: 'claude-code',
      driverVersion: '1',
      executableFingerprint: 'sha256:test-claude-executable',
      configRevision: 'config-hash',
      model: null,
      reasoning: null,
      fastMode: null,
      timeoutSeconds: 60,
      tokenBudget: null,
      turnLimit: null,
    },
    workspace: {
      workspaceRoot: '/repo',
      activeRepoRoot: '/repo',
      repoAccessMode: 'workspace',
      repoSource: null,
      branch: null,
      commit: null,
      fingerprint: 'workspace-hash',
    },
    prompt: { bundleFingerprint: 'prompt-hash' },
    executionTarget: {
      id: 'local-api-process',
      kind: 'local-process',
      trustLevel: 'workspace',
      capabilities: ['inspect', 'signals', 'resume', 'workspace-write'],
    },
    tools: {
      builtIn: [],
      mcpServers: tools.mcpServers ?? [],
      requiredLifecycleTools: tools.requiredLifecycleTools ?? [],
      skills: [],
    },
    auth: { provider: 'anthropic', providerConnectionId: null, credentialRefs: [] },
    evidence: { required: false, requirements: [] },
    callback: { identity: `agent:${agentSlug}:run:${instanceId}` },
    priorCheckpoint: null,
    observability: {
      traceId: `drun-${instanceId}`,
      correlationId: `drun-${instanceId}`,
      requestedBy: null,
    },
  };
}

function baseParams(overrides: Partial<DispatchParams> = {}): DispatchParams {
  const instanceId = typeof overrides.instanceId === 'number' ? overrides.instanceId : 7;
  const agentSlug = typeof overrides.agentSlug === 'string' ? overrides.agentSlug : 'forge';
  const db = Object.prototype.hasOwnProperty.call(overrides, 'db')
    ? overrides.db
    : createMockDb() as never;
  const boundary = Object.prototype.hasOwnProperty.call(overrides, 'runtimeBoundary')
    ? overrides.runtimeBoundary
    : runtimeBoundary(instanceId, agentSlug) as never;
  return {
    message: 'do the work',
    agentSlug,
    sessionKey: 'agent:forge:run:1',
    timeoutSeconds: 0,
    name: 'Forge',
    instanceId,
    taskId: 99,
    durableRunId: 'drun_abc',
    db,
    runtimeBoundary: boundary,
    ...overrides,
  } as DispatchParams;
}

const SUCCESS_RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  terminal_reason: 'completed',
  is_error: false,
  num_turns: 1,
  session_id: 's',
  total_cost_usd: 0.5,
  result: 'all done',
  modelUsage: {
    'claude-opus-5': {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 10,
    },
  },
});

beforeEach(() => {
  mockProbeRuntimeCliVersion.mockReset();
  mockProbeRuntimeCliVersion.mockResolvedValue({
    ok: true,
    version: 'Claude Code 2.1.220',
    executablePath: '/opt/agent-hq/bin/claude',
    executableFingerprint: 'sha256:test-claude-executable',
    message: 'Claude Code 2.1.220 (supported)',
    details: {
      minimum_supported: '2.1.220',
      maximum_exclusive: '2.2.0',
      detected: '2.1.220',
      executable_path: '/opt/agent-hq/bin/claude',
      executable_fingerprint: 'sha256:test-claude-executable',
    },
  });
  mockAssertRuntimeBoundaryAssignmentsCurrent.mockReset();
  mockAssertRuntimeBoundaryAssignmentsCurrent.mockResolvedValue(undefined);
  mockCleanupMcpRunConfig.mockReset();
});

describe('ClaudeCodeRuntime dispatch', () => {
  let child: MockChild;

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveRuntimeExecutable.mockReturnValue({
      path: '/opt/agent-hq/bin/claude',
      fingerprint: 'sha256:test-claude-executable',
    });
    mockLocalProcessIdentity.mockReturnValue('sha256:test-process-birth');
    mockCleanupOwnedProcessTree.mockReset();
    mockCleanupOwnedProcessTree.mockResolvedValue({
      confirmed: true,
      escalated: false,
      scope: 'process-group',
      error: undefined,
    });
    mockReadPreviousRunServers.mockReturnValue({});
    child = createMockChild();
    mockSpawn.mockImplementation(() => {
      setImmediate(() => child.emit('spawn'));
      return child;
    });
    mockMaterializeMcp.mockResolvedValue({
      configPath: null,
      serverNames: [],
      requiredServerNames: [],
      allowedToolNames: [],
      warnings: [],
    });
  });

  it('returns the claude-code runId synchronously', async () => {
    const runtime = new ClaudeCodeRuntime({});
    const db = createMockDb();
    const { runId } = await runtime.dispatch(
      baseParams({ db: db as never, activeRepoRoot: '/repo/worktree' }),
    );
    expect(runId).toBe('claude-code:7');
    expect(mockSpawn).toHaveBeenCalledWith(
      '/opt/agent-hq/bin/claude',
      expect.any(Array),
      expect.any(Object),
    );
  });

  it('rejects an incomplete production context before any write, probe, or materialization', async () => {
    const db = createMockDb();
    await expect(new ClaudeCodeRuntime().dispatch(baseParams({
      db: db as never,
      runtimeBoundary: undefined,
      activeRepoRoot: '/repo',
    }))).rejects.toThrow(/requires db, instanceId, and runtimeBoundary/);

    expect(db.runs).toEqual([]);
    expect(mockProbeRuntimeCliVersion).not.toHaveBeenCalled();
    expect(mockMaterializeMcp).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('fails a supported-version probe before DB writes or MCP materialization', async () => {
    mockProbeRuntimeCliVersion.mockResolvedValueOnce({
      ok: false,
      version: 'Claude Code 2.2.0',
      executablePath: '/opt/agent-hq/bin/claude',
      executableFingerprint: 'sha256:test-claude-executable',
      message: 'outside verified range',
      details: {
        minimum_supported: '2.1.220',
        maximum_exclusive: '2.2.0',
        detected: '2.2.0',
        executable_path: '/opt/agent-hq/bin/claude',
        executable_fingerprint: 'sha256:test-claude-executable',
      },
    });
    const db = createMockDb();

    await expect(new ClaudeCodeRuntime().dispatch(baseParams({
      db: db as never,
      activeRepoRoot: '/repo',
    }))).rejects.toThrow(/version verification failed: outside verified range/);

    expect(db.runs).toEqual([]);
    expect(mockMaterializeMcp).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('rejects a probed executable that differs from the immutable boundary', async () => {
    const boundary = runtimeBoundary();
    boundary.runtime.executableFingerprint = 'sha256:boundary-other-executable';
    const db = createMockDb();

    await expect(new ClaudeCodeRuntime().dispatch(baseParams({
      db: db as never,
      runtimeBoundary: boundary as never,
      activeRepoRoot: '/repo',
    }))).rejects.toThrow(/fingerprint does not match the immutable runtime boundary/);

    expect(db.runs).toEqual([]);
    expect(mockMaterializeMcp).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('re-resolves executable identity immediately before spawn and cleans the run config on change', async () => {
    mockMaterializeMcp.mockResolvedValueOnce({
      configPath: '/tmp/agent-hq-test/mcp-config-instance-7-deadbeefdeadbeefdeadbeef.json',
      serverNames: [],
      requiredServerNames: [],
      allowedToolNames: [],
      warnings: [],
    });
    mockResolveRuntimeExecutable.mockReturnValueOnce({
      path: '/opt/agent-hq/bin/claude-replaced',
      fingerprint: 'sha256:replaced-after-probe',
    });

    await expect(new ClaudeCodeRuntime().dispatch(baseParams({
      activeRepoRoot: '/repo',
    }))).rejects.toThrow(/executable changed after version verification/);

    expect(mockCleanupMcpRunConfig).toHaveBeenCalledWith(
      '/tmp/agent-hq-test/mcp-config-instance-7-deadbeefdeadbeefdeadbeef.json',
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('rechecks boundary assignments immediately before spawn and cleans on mismatch', async () => {
    const configPath = '/tmp/agent-hq-test/mcp-config-instance-7-feedfacefeedfacefeedface.json';
    mockMaterializeMcp.mockResolvedValueOnce({
      configPath,
      serverNames: [],
      requiredServerNames: [],
      allowedToolNames: [],
      warnings: [],
    });
    mockAssertRuntimeBoundaryAssignmentsCurrent.mockRejectedValueOnce(
      new Error('Runtime MCP assignments changed'),
    );

    await expect(new ClaudeCodeRuntime().dispatch(baseParams({
      activeRepoRoot: '/repo',
    }))).rejects.toThrow('Runtime MCP assignments changed');

    expect(mockAssertRuntimeBoundaryAssignmentsCurrent).toHaveBeenCalledWith({
      db: expect.any(Object),
      boundary: expect.objectContaining({ version: 1 }),
      materializedMcpServerNames: [],
    });
    expect(mockCleanupMcpRunConfig).toHaveBeenCalledWith(configPath);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('treats MCP materialization errors as fatal capability loss', async () => {
    mockMaterializeMcp.mockRejectedValueOnce(new Error('MCP assignment lookup failed'));

    await expect(new ClaudeCodeRuntime().dispatch(baseParams({
      activeRepoRoot: '/repo',
    }))).rejects.toThrow('MCP assignment lookup failed');

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('rejects a case-variant runtime PATH before resolving or spawning a workspace shim', async () => {
    await expect(new ClaudeCodeRuntime().dispatch(baseParams({
      activeRepoRoot: '/repo/worktree',
      runtimeConfig: { env: { Path: '/repo/worktree/attacker-bin' } },
    }))).rejects.toThrow(/may not set protected.*Path/);

    expect(mockResolveRuntimeExecutable).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('persists the canonical executable path and fingerprint used for launch', async () => {
    const db = createMockDb();
    await new ClaudeCodeRuntime().dispatch(baseParams({
      db: db as never,
      activeRepoRoot: '/repo/worktree',
    }));

    expect(mockPersistExecutionStart).toHaveBeenCalledWith(db, expect.objectContaining({
      launchSpec: expect.objectContaining({
        command: '/opt/agent-hq/bin/claude',
        executableFingerprint: 'sha256:test-claude-executable',
      }),
    }));
    child.emit('close', 0, null);
  });

  it('prefers activeRepoRoot over runtime_config.workingDirectory for cwd', async () => {
    const runtime = new ClaudeCodeRuntime({ workingDirectory: '/stale/workspace' });
    const db = createMockDb();

    await runtime.dispatch(
      baseParams({
        db: db as never,
        activeRepoRoot: '/repo/worktree',
        workspaceRoot: '/repo',
      }),
    );

    const [, , options] = mockSpawn.mock.calls[0];
    expect((options as { cwd: string }).cwd).toBe('/repo/worktree');
    expect((options as { env: Record<string, string> }).env.AGENT_HQ_ACTIVE_REPO_ROOT).toBe(
      '/repo/worktree',
    );
  });

  it('keeps workspaceRoot as the boundary while using activeRepoRoot as cwd', async () => {
    const runtime = new ClaudeCodeRuntime({});
    const db = createMockDb();

    await runtime.dispatch(
      baseParams({
        db: db as never,
        activeRepoRoot: '/repo/worktree',
        workspaceRoot: '/repo',
      }),
    );

    const [, , options] = mockSpawn.mock.calls[0];
    expect((options as { env: Record<string, string> }).env.AGENT_HQ_WORKSPACE_ROOT).toBe('/repo');
    expect(mockValidateAndLogViolation).toHaveBeenCalledWith(
      db,
      '/repo',
      '/repo/worktree',
      expect.objectContaining({ instanceId: 7 }),
    );
  });

  it('throws when no working directory can be resolved', async () => {
    const runtime = new ClaudeCodeRuntime({});
    await expect(runtime.dispatch(baseParams({ db: createMockDb() as never }))).rejects.toThrow(
      /requires activeRepoRoot/,
    );
  });

  it('writes session_key BEFORE spawning so the transcript is locatable from t=0', async () => {
    const runtime = new ClaudeCodeRuntime({});
    const db = createMockDb();

    await runtime.dispatch(baseParams({ db: db as never, activeRepoRoot: '/repo' }));

    const sessionWrites = runsMatching(db, 'SET session_key');
    expect(sessionWrites).toHaveLength(1);
    const sessionKey = sessionWrites[0].params[0] as string;
    expect(sessionKey).toMatch(
      /^claude-code:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // The same uuid must be handed to the CLI, or Agent HQ's session_key would
    // point at a transcript that does not exist.
    const argv = mockSpawn.mock.calls[0][1] as string[];
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(
      sessionKey.replace('claude-code:', ''),
    );
  });

  it('delivers the prompt on stdin and closes it', async () => {
    const runtime = new ClaudeCodeRuntime({});
    const chunks: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    const ended = new Promise<void>((resolve) => child.stdin.on('end', () => resolve()));
    child.stdin.resume();

    await runtime.dispatch(
      baseParams({ db: createMockDb() as never, activeRepoRoot: '/repo', message: 'PROMPT-1' }),
    );
    await ended;

    // `--print -` blocks until stdin hits EOF; a prompt in argv would also risk E2BIG.
    expect(chunks.join('')).toBe('PROMPT-1');
    const argv = mockSpawn.mock.calls[0][1] as string[];
    expect(argv).not.toContain('PROMPT-1');
  });

  it('spawns with a writable stdin pipe', async () => {
    const runtime = new ClaudeCodeRuntime({});
    await runtime.dispatch(baseParams({ db: createMockDb() as never, activeRepoRoot: '/repo' }));
    const [, , options] = mockSpawn.mock.calls[0];
    expect((options as { stdio: string[] }).stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('materializes MCP state under trusted tenant/agent/instance identity', async () => {
    const runtime = new ClaudeCodeRuntime({});

    await runtime.dispatch(baseParams({ db: createMockDb() as never, activeRepoRoot: '/repo' }));

    expect(mockMaterializeMcp).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 2,
        agentId: 42,
        instanceId: 7,
        runKey: expect.any(String),
        protectedInstanceIds: expect.any(Set),
      }),
    );
  });

  it('surfaces a launch failure as a dispatch error', async () => {
    const configPath = '/tmp/agent-hq-test/mcp-config-instance-7-cafebabecafebabecafebabe.json';
    mockMaterializeMcp.mockResolvedValueOnce({
      configPath,
      serverNames: [],
      requiredServerNames: [],
      allowedToolNames: [],
      warnings: [],
    });
    mockSpawn.mockImplementation(() => {
      setImmediate(() => child.emit('error', new Error('spawn claude ENOENT')));
      return child;
    });
    const runtime = new ClaudeCodeRuntime({});

    await expect(
      runtime.dispatch(baseParams({ db: createMockDb() as never, activeRepoRoot: '/repo' })),
    ).rejects.toThrow(/failed to launch/);
    expect(mockCleanupMcpRunConfig).toHaveBeenCalledWith(configPath);
  });

  it('terminates before writing the prompt when durable execution start throws', async () => {
    const runtime = new ClaudeCodeRuntime({ killGraceMs: 1_000 });
    const chunks: string[] = [];
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', (chunk: string) => chunks.push(chunk));
    mockPersistExecutionStart.mockRejectedValueOnce(new Error('runtime store unavailable'));

    await expect(runtime.dispatch(baseParams({
      db: createMockDb() as never,
      activeRepoRoot: '/repo',
      message: 'MUST NOT START',
    }))).rejects.toThrow(/refused to start without durable execution state/);

    expect(chunks).toEqual([]);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mockAppendRuntimeCheckpoint).not.toHaveBeenCalled();
    child.emit('close', null, 'SIGTERM');
  });

  it('cleans a duplicate spawned child without signalling the authoritative registered run', async () => {
    const firstChild = child;
    const runtime = new ClaudeCodeRuntime({ killGraceMs: 1_000 });
    await runtime.dispatch(baseParams({ db: createMockDb() as never, activeRepoRoot: '/repo' }));

    const duplicateChild = createMockChild();
    duplicateChild.pid = 4343;
    (duplicateChild as unknown as { spawnargs: string[] }).spawnargs = ['claude'];
    mockSpawn.mockImplementationOnce(() => {
      setImmediate(() => duplicateChild.emit('spawn'));
      return duplicateChild;
    });

    await expect(runtime.dispatch(baseParams({
      db: createMockDb() as never,
      activeRepoRoot: '/repo',
    }))).rejects.toThrow(/already registered/);

    expect(firstChild.kill).not.toHaveBeenCalled();
    expect(mockCleanupOwnedProcessTree).toHaveBeenCalledWith(expect.objectContaining({
      child: duplicateChild,
      processGroupId: 4343,
    }));

    duplicateChild.emit('close', null, 'SIGTERM');
    firstChild.stdout.write(`${SUCCESS_RESULT}\n`);
    firstChild.stdout.end();
    firstChild.emit('close', 0, null);
    await flush();
  });

  it('keeps monitor cleanup ownership when prompt delivery throws after durable launch', async () => {
    child.stdin.end = jest.fn(() => {
      throw new Error('synchronous stdin failure');
    }) as never;

    await expect(new ClaudeCodeRuntime({ killGraceMs: 1_000 }).dispatch(baseParams({
      db: createMockDb() as never,
      activeRepoRoot: '/repo',
      message: 'PROMPT',
    }))).rejects.toThrow(/prompt delivery failed.*synchronous stdin failure/);

    expect(mockPersistExecutionStart).toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null, 'SIGTERM');
    await flush();
    expect(mockCleanupOwnedProcessTree).toHaveBeenCalledWith(expect.objectContaining({ child }));
  });

  it('terminates before writing the prompt when no durable process fingerprint is available', async () => {
    const runtime = new ClaudeCodeRuntime({ killGraceMs: 1_000 });
    const chunks: string[] = [];
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', (chunk: string) => chunks.push(chunk));
    mockLocalProcessIdentity.mockReturnValueOnce(null);

    await expect(runtime.dispatch(baseParams({
      db: createMockDb() as never,
      activeRepoRoot: '/repo',
      message: 'MUST NOT START',
    }))).rejects.toThrow(/no durable birth fingerprint/);

    expect(chunks).toEqual([]);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mockPersistExecutionStart).not.toHaveBeenCalled();
    child.emit('close', null, 'SIGTERM');
  });
});

describe('ClaudeCodeRuntime terminal handling', () => {
  let child: MockChild;

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveRuntimeExecutable.mockReturnValue({
      path: '/opt/agent-hq/bin/claude',
      fingerprint: 'sha256:test-claude-executable',
    });
    mockLocalProcessIdentity.mockReturnValue('sha256:test-process-birth');
    mockReadPreviousRunServers.mockReturnValue({});
    child = createMockChild();
    mockSpawn.mockImplementation(() => {
      setImmediate(() => child.emit('spawn'));
      return child;
    });
    mockMaterializeMcp.mockResolvedValue({
      configPath: null,
      serverNames: [],
      requiredServerNames: [],
      allowedToolNames: [],
      warnings: [],
    });
  });

  it('keeps the run config until process-group cleanup is confirmed, then removes it', async () => {
    const configPath = '/tmp/agent-hq-test/mcp-config-instance-7-0123456789abcdef01234567.json';
    mockMaterializeMcp.mockResolvedValueOnce({
      configPath,
      serverNames: [],
      requiredServerNames: [],
      allowedToolNames: [],
      warnings: [],
    });

    await new ClaudeCodeRuntime().dispatch(baseParams({ activeRepoRoot: '/repo' }));
    expect(mockCleanupMcpRunConfig).not.toHaveBeenCalled();

    child.stdout.write(`${SUCCESS_RESULT}\n`);
    child.stdout.end();
    child.emit('close', 0, null);
    await flush();

    expect(mockCleanupOwnedProcessTree).toHaveBeenCalled();
    expect(mockCleanupMcpRunConfig).toHaveBeenCalledWith(configPath);
  });

  it('persists runtime end and fires onRuntimeEnd, in that order', async () => {
    const runtime = new ClaudeCodeRuntime({});
    const db = createMockDb();
    const order: string[] = [];
    mockApplyRuntimeEnd.mockImplementation(async () => {
      order.push('persist');
      return { changed: true };
    });

    await runtime.dispatch(
      baseParams({
        db: db as never,
        activeRepoRoot: '/repo',
        onRuntimeEnd: async () => {
          order.push('callback');
        },
      }),
    );

    child.stdout.write(`${SUCCESS_RESULT}\n`);
    child.stdout.end();
    child.emit('close', 0, null);
    await flush();

    // Persistence must precede the observability callback — the callback is not
    // a substitute for it (see the AgentRuntime contract).
    expect(order).toEqual(['persist', 'callback']);
  });

  it('still delivers runtime end when the job projection fails after durable terminal state', async () => {
    const db = createMockDb();
    mockApplyRuntimeEnd.mockRejectedValueOnce(new Error('job projection unavailable'));
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onRuntimeEnd = jest.fn(async () => undefined);

    await new ClaudeCodeRuntime({}).dispatch(baseParams({
      db: db as never,
      activeRepoRoot: '/repo',
      onRuntimeEnd,
    }));
    child.stdout.write(`${SUCCESS_RESULT}\n`);
    child.stdout.end();
    child.emit('close', 0, null);
    await flush();

    expect(mockPersistExecutionTerminal).toHaveBeenCalledWith(db, expect.objectContaining({
      instanceId: 7,
      state: 'succeeded',
    }));
    expect(onRuntimeEnd).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('failed to project runtime terminal state'),
      'job projection unavailable',
    );
    warning.mockRestore();
  });

  it('contains runtime-end callback rejection inside the detached monitor', async () => {
    const callback = jest.fn(async () => { throw new Error('consumer unavailable'); });
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await new ClaudeCodeRuntime({}).dispatch(baseParams({
      db: createMockDb() as never,
      activeRepoRoot: '/repo',
      onRuntimeEnd: callback,
    }));
    child.stdout.write(`${SUCCESS_RESULT}\n`);
    child.stdout.end();
    child.emit('close', 0, null);
    await flush();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      '[ClaudeCodeRuntime] runtime-end callback failed:',
      'consumer unavailable',
    );
    expect(error).not.toHaveBeenCalledWith(
      '[ClaudeCodeRuntime] unhandled error in monitorRun',
      expect.anything(),
    );
    warning.mockRestore();
    error.mockRestore();
  });

  it('records a successful run with cumulative usage and cost', async () => {
    const runtime = new ClaudeCodeRuntime({});
    const db = createMockDb();
    let event: { success: boolean; metadata?: Record<string, unknown> } | null = null;

    await runtime.dispatch(
      baseParams({
        db: db as never,
        activeRepoRoot: '/repo',
        onRuntimeEnd: async (e) => {
          event = e as never;
        },
      }),
    );

    child.stdout.write(`${SUCCESS_RESULT}\n`);
    child.stdout.end();
    child.emit('close', 0, null);
    await flush();

    expect(event!.success).toBe(true);
    // input = inputTokens + cacheCreationInputTokens (cache creation is billed input)
    expect(event!.metadata!.total_cost_usd).toBe(0.5);

    const tokenWrites = runsMatching(db, 'SET token_input');
    expect(tokenWrites[0].params.slice(0, 3)).toEqual([110, 20, 130]);
  });

  it('writes the turn_end row the watchdog recovery path reads back', async () => {
    const runtime = new ClaudeCodeRuntime({});
    const db = createMockDb();

    await runtime.dispatch(baseParams({ db: db as never, activeRepoRoot: '/repo' }));
    child.stdout.write(`${SUCCESS_RESULT}\n`);
    child.stdout.end();
    child.emit('close', 0, null);
    await flush();

    const turnEnd = runsMatching(db, "'turn_end'");
    expect(turnEnd).toHaveLength(1);
    expect(turnEnd[0].params[0]).toBe('claude-code-runtime-end-7');

    // `source` is written explicitly so watchdog recovery does not have to fall
    // back to matching the message-id prefix.
    const meta = JSON.parse(turnEnd[0].params[3] as string);
    expect(meta.source).toBe('claude-code');

    expect(runsMatching(db, "'{runtimeEnd}'")).toHaveLength(1);
  });

  it('rejects dispatch before model spend when a required MCP lifecycle tool is missing', async () => {
    mockMaterializeMcp.mockResolvedValue({
      configPath: '/tmp/x/mcp-config.json',
      serverNames: ['agent-hq__agent-42'],
      requiredServerNames: ['agent-hq__agent-42'],
      allowedToolNames: [],
      warnings: [],
    });
    mockPreflight.mockResolvedValue([
      {
        serverName: 'agent-hq__agent-42',
        ok: false,
        toolNames: ['agent_hq_start_task_run'],
        requiredToolNames: ['agent_hq_post_task_outcome', 'agent_hq_start_task_run'],
        missingToolNames: ['agent_hq_post_task_outcome'],
        error: 'server did not advertise required tool(s): agent_hq_post_task_outcome',
        durationMs: 4,
      },
    ]);

    const runtime = new ClaudeCodeRuntime({});
    await expect(
      runtime.dispatch(baseParams({
        db: createMockDb() as never,
        activeRepoRoot: '/repo',
        runtimeBoundary: runtimeBoundary(7, 'forge', {
          mcpServers: [{
            name: 'agent-hq__agent-42',
            configFingerprint: 'sha256:agent-hq',
            requiredToolNames: ['agent_hq_post_task_outcome', 'agent_hq_start_task_run'],
          }],
          requiredLifecycleTools: ['agent_hq_post_task_outcome', 'agent_hq_start_task_run'],
        }) as never,
      })),
    ).rejects.toThrow(/failed preflight/);

    // The entire point of preflighting rather than gating mid-stream: a run that
    // could never have reported its outcome costs zero model spend.
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockPreflight).toHaveBeenCalledWith({}, [{
      serverName: 'agent-hq__agent-42',
      requiredToolNames: ['agent_hq_post_task_outcome', 'agent_hq_start_task_run'],
    }]);
  });

  it('rejects before model spend when lifecycle tools have no materialized Agent HQ server', async () => {
    mockMaterializeMcp.mockResolvedValue({
      configPath: null,
      serverNames: [],
      requiredServerNames: [],
      allowedToolNames: [],
      warnings: [],
    });
    const runtime = new ClaudeCodeRuntime({});

    await expect(runtime.dispatch(baseParams({
      db: createMockDb() as never,
      activeRepoRoot: '/repo',
      runtimeBoundary: runtimeBoundary(7, 'forge', {
        requiredLifecycleTools: ['agent_hq_start_task_run'],
      }) as never,
    }))).rejects.toThrow(/exactly one assigned and materialized agent-hq MCP server/);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockPreflight).not.toHaveBeenCalled();
  });

  it('rejects before model spend when required MCP configuration is unreadable', async () => {
    mockMaterializeMcp.mockResolvedValue({
      configPath: '/tmp/x/mcp-config.json',
      serverNames: ['agent-hq__agent-42'],
      requiredServerNames: ['agent-hq__agent-42'],
      allowedToolNames: [],
      warnings: [],
    });
    mockReadPreviousRunServers.mockImplementationOnce(() => {
      throw new Error('permission denied');
    });
    const runtime = new ClaudeCodeRuntime({});

    await expect(runtime.dispatch(baseParams({
      db: createMockDb() as never,
      activeRepoRoot: '/repo',
      runtimeBoundary: runtimeBoundary(7, 'forge', {
        mcpServers: [{
          name: 'agent-hq__agent-42',
          configFingerprint: 'sha256:test',
          requiredToolNames: ['agent_hq_start_task_run'],
        }],
        requiredLifecycleTools: ['agent_hq_start_task_run'],
      }) as never,
    }))).rejects.toThrow(/could not be read: permission denied/);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockPreflight).not.toHaveBeenCalled();
  });

  it('spawns once preflight passes and records which MCP servers the agent used', async () => {
    mockMaterializeMcp.mockResolvedValue({
      configPath: '/tmp/x/mcp-config.json',
      serverNames: ['agent-hq__agent-42'],
      requiredServerNames: ['agent-hq__agent-42'],
      allowedToolNames: [],
      warnings: [],
    });
    mockPreflight.mockResolvedValue([
      {
        serverName: 'agent-hq__agent-42',
        ok: true,
        toolNames: ['agent_hq_post_task_outcome'],
        durationMs: 22,
      },
    ]);

    const runtime = new ClaudeCodeRuntime({});
    let event: { success: boolean; metadata?: Record<string, unknown> } | null = null;

    await runtime.dispatch(
      baseParams({
        db: createMockDb() as never,
        activeRepoRoot: '/repo',
        runtimeBoundary: runtimeBoundary(7, 'forge', {
          mcpServers: [{
            name: 'agent-hq__agent-42',
            configFingerprint: 'sha256:test',
            requiredToolNames: [
              'agent_hq_start_task_run',
              'agent_hq_post_task_outcome',
            ],
          }],
          requiredLifecycleTools: [
            'agent_hq_start_task_run',
            'agent_hq_post_task_outcome',
          ],
        }) as never,
        onRuntimeEnd: async (e) => {
          event = e as never;
        },
      }),
    );

    const argv = mockSpawn.mock.calls[0][1] as string[];
    const allowedTools = argv[argv.indexOf('--allowedTools') + 1];
    expect(allowedTools).toContain(
      'mcp__agent-hq__agent-42__agent_hq_start_task_run',
    );
    expect(allowedTools).toContain(
      'mcp__agent-hq__agent-42__agent_hq_post_task_outcome',
    );

    // A real healthy run leaves mcp_servers at 'pending' in every init it emits,
    // so the ONLY in-band evidence the server worked is an actual namespaced
    // tool call. It is metadata, never a gate.
    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        session_id: 's',
        message: {
          content: [
            { type: 'tool_use', name: 'mcp__agent-hq__agent-42__agent_hq_post_task_outcome', input: {} },
          ],
        },
      })}\n`,
    );
    child.stdout.write(`${SUCCESS_RESULT}\n`);
    child.stdout.end();
    child.emit('close', 0, null);
    await flush();

    expect(event!.success).toBe(true);
    expect(event!.metadata!.mcp_servers_confirmed_in_run).toEqual(['agent-hq__agent-42']);
    expect(event!.metadata!.mcp_tool_calls).toEqual([
      'mcp__agent-hq__agent-42__agent_hq_post_task_outcome',
    ]);
  });

  it('does not fail a healthy run whose MCP status never leaves "pending"', async () => {
    mockMaterializeMcp.mockResolvedValue({
      configPath: '/tmp/x/mcp-config.json',
      serverNames: ['agent-hq__agent-42'],
      requiredServerNames: ['agent-hq__agent-42'],
      allowedToolNames: [],
      warnings: [],
    });
    mockPreflight.mockResolvedValue([
      { serverName: 'agent-hq__agent-42', ok: true, toolNames: ['t'], durationMs: 10 },
    ]);

    const runtime = new ClaudeCodeRuntime({});
    let event: { success: boolean } | null = null;

    await runtime.dispatch(
      baseParams({
        db: createMockDb() as never,
        activeRepoRoot: '/repo',
        runtimeBoundary: runtimeBoundary(7, 'forge', {
          mcpServers: [{
            name: 'agent-hq__agent-42',
            configFingerprint: 'sha256:test',
            requiredToolNames: [],
          }],
        }) as never,
        onRuntimeEnd: async (e) => {
          event = e as never;
        },
      }),
    );

    // Regression guard. This exact shape — one init, status stuck at 'pending',
    // clean success — is what a genuinely healthy run looks like against the real
    // CLI. An earlier design read that status as a readiness signal and failed
    // runs that had in fact completed their work.
    child.stdout.write(
      `${JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 's',
        mcp_servers: [{ name: 'agent-hq__agent-42', status: 'pending' }],
      })}\n`,
    );
    child.stdout.write(`${SUCCESS_RESULT}\n`);
    child.stdout.end();
    child.emit('close', 0, null);
    await flush();

    expect(event!.success).toBe(true);
  });

  it('classifies a non-zero exit as failed without persisting stderr credentials', async () => {
    const runtime = new ClaudeCodeRuntime({});
    let event: { success: boolean; reason?: string; error?: string; metadata?: Record<string, unknown> } | null = null;

    await runtime.dispatch(
      baseParams({
        db: createMockDb() as never,
        activeRepoRoot: '/repo',
        onRuntimeEnd: async (e) => {
          event = e as never;
        },
      }),
    );

    child.stderr.write('ANTHROPIC_API_KEY=operator-secret sk-ant-oat01-secretvalue');
    child.stdout.end();
    child.emit('close', 1, null);
    await flush();

    expect(event!.success).toBe(false);
    expect(event!.reason).toBe('error');
    expect(JSON.stringify(event)).not.toContain('operator-secret');
    expect(JSON.stringify(event)).not.toContain('sk-ant-oat01-secretvalue');
    expect(JSON.stringify(event)).toContain('[REDACTED]');
  });

  it('bounds retained stderr for a noisy failed process', async () => {
    const runtime = new ClaudeCodeRuntime({});
    let event: { metadata?: Record<string, unknown> } | null = null;

    await runtime.dispatch(
      baseParams({
        db: createMockDb() as never,
        activeRepoRoot: '/repo',
        onRuntimeEnd: async (runtimeEvent) => {
          event = runtimeEvent as never;
        },
      }),
    );

    child.stderr.emit('data', 'x'.repeat(256 * 1024));
    child.stdout.end();
    child.emit('close', 1, null);
    await flush();

    expect((event!.metadata?.stderr as string).length).toBeLessThanOrEqual(128 * 1024);
  });

  it('does not terminalize when descendant process-group cleanup cannot be confirmed', async () => {
    const configPath = '/tmp/agent-hq-test/mcp-config-instance-7-89abcdef0123456789abcdef.json';
    mockMaterializeMcp.mockResolvedValueOnce({
      configPath,
      serverNames: [],
      requiredServerNames: [],
      allowedToolNames: [],
      warnings: [],
    });
    mockCleanupOwnedProcessTree.mockResolvedValueOnce({
      confirmed: false,
      escalated: true,
      scope: 'process-group',
      error: 'group remained observable',
    });
    const db = createMockDb();
    const onRuntimeEnd = jest.fn();
    await new ClaudeCodeRuntime({}).dispatch(baseParams({
      db: db as never,
      activeRepoRoot: '/repo',
      onRuntimeEnd,
    }));

    child.stdout.write(`${SUCCESS_RESULT}\n`);
    child.stdout.end();
    child.emit('close', 0, null);
    await flush();

    expect(mockPersistExecutionTerminal).not.toHaveBeenCalled();
    expect(mockApplyRuntimeEnd).not.toHaveBeenCalled();
    expect(onRuntimeEnd).not.toHaveBeenCalled();
    expect(mockCleanupMcpRunConfig).not.toHaveBeenCalledWith(configPath);
  });
});

describe('ClaudeCodeRuntime abort', () => {
  beforeEach(() => jest.clearAllMocks());

  it('signals the tracked child', async () => {
    const child = createMockChild();
    mockSpawn.mockImplementation(() => {
      setImmediate(() => child.emit('spawn'));
      return child;
    });
    mockMaterializeMcp.mockResolvedValue({
      configPath: null,
      serverNames: [],
      requiredServerNames: [],
      allowedToolNames: [],
      warnings: [],
    });

    const runtime = new ClaudeCodeRuntime({});
    const { runId } = await runtime.dispatch(
      baseParams({ db: createMockDb() as never, activeRepoRoot: '/repo' }),
    );

    await expect(runtime.abort(runId, 'agent:forge:run:1')).resolves.toMatchObject({
      status: 'signalled',
      ok: true,
      confirmed: false,
    });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('reports an unknown runId as unconfirmed rather than claiming it stopped', async () => {
    const runtime = new ClaudeCodeRuntime({});
    await expect(runtime.abort('claude-code:999', 'k')).resolves.toMatchObject({
      ok: false,
      confirmed: false,
      status: 'not_found',
    });
    await expect(runtime.abort('hermes:1', 'k')).resolves.toMatchObject({
      ok: false,
      confirmed: false,
      status: 'not_found',
    });
  });
});
