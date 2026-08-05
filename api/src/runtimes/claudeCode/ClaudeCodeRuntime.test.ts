import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

const mockSpawn = jest.fn();
const mockValidateAndLogViolation = jest.fn(async (..._args: unknown[]) => undefined);
const mockMaterializeMcp = jest.fn();
const mockReadPreviousRunServers = jest.fn(
  (..._args: unknown[]): Record<string, Record<string, unknown>> => ({}),
);
const mockApplyRuntimeEnd = jest.fn(async (..._args: unknown[]) => ({ changed: true }));
const mockPreflight = jest.fn(async (..._args: unknown[]) => [] as unknown[]);

// Only `spawn` is replaced. Replacing the whole child_process module would also
// blank execFileSync/execSync for everything this file transitively imports.
jest.mock('child_process', () => ({
  ...(jest.requireActual('child_process') as object),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock('../../lib/workspaceBoundary', () => ({
  validateAndLogViolation: (...args: unknown[]) => mockValidateAndLogViolation(...args),
}));

jest.mock('./mcpConfig', () => ({
  materializeClaudeCodeMcpConfig: (...args: unknown[]) => mockMaterializeMcp(...args),
  readPreviousRunServers: (...args: unknown[]) => mockReadPreviousRunServers(...args),
  resolveClaudeCodeAgentStateDir: (instanceId: number) => `/tmp/agent-hq-test/${instanceId}`,
}));

jest.mock('./mcpPreflight', () => ({
  // describeMcpPreflightFailure stays real so the thrown message is the production one.
  ...(jest.requireActual('./mcpPreflight') as object),
  preflightMcpServers: (...args: unknown[]) => mockPreflight(...args),
}));

jest.mock('../../domains/runs/runtimeEnd', () => ({
  applyRuntimeEndToJobInstance: (...args: unknown[]) => mockApplyRuntimeEnd(...args),
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
      sql.includes('agent_id') ? { agent_id: 42 } : undefined,
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

function baseParams(overrides: Partial<DispatchParams> = {}): DispatchParams {
  return {
    message: 'do the work',
    agentSlug: 'forge',
    sessionKey: 'agent:forge:run:1',
    timeoutSeconds: 0,
    name: 'Forge',
    instanceId: 7,
    taskId: 99,
    durableRunId: 'drun_abc',
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

describe('ClaudeCodeRuntime dispatch', () => {
  let child: MockChild;

  beforeEach(() => {
    jest.clearAllMocks();
    child = createMockChild();
    mockSpawn.mockImplementation(() => {
      setImmediate(() => child.emit('spawn'));
      return child;
    });
    mockMaterializeMcp.mockResolvedValue({
      configPath: '/tmp/agent-hq-test/7/mcp-config.json',
      serverNames: ['agent-hq__agent-42'],
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

  it('carries the previous run server map forward into materialization', async () => {
    const runtime = new ClaudeCodeRuntime({});
    mockReadPreviousRunServers.mockReturnValue({ 'agent-hq__agent-42': { command: 'node' } } as never);

    await runtime.dispatch(baseParams({ db: createMockDb() as never, activeRepoRoot: '/repo' }));

    // Without carry-forward, fetchAssignedMcpServers mints a brand-new
    // AGENT_HQ_MCP_API_KEY on every dispatch and never revokes the old one.
    expect(mockMaterializeMcp).toHaveBeenCalledWith(
      expect.objectContaining({
        previousServers: { 'agent-hq__agent-42': { command: 'node' } },
      }),
    );
  });

  it('surfaces a launch failure as a dispatch error', async () => {
    mockSpawn.mockImplementation(() => {
      setImmediate(() => child.emit('error', new Error('spawn claude ENOENT')));
      return child;
    });
    const runtime = new ClaudeCodeRuntime({});

    await expect(
      runtime.dispatch(baseParams({ db: createMockDb() as never, activeRepoRoot: '/repo' })),
    ).rejects.toThrow(/failed to launch/);
  });
});

describe('ClaudeCodeRuntime terminal handling', () => {
  let child: MockChild;

  beforeEach(() => {
    jest.clearAllMocks();
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

  it('rejects dispatch when a required MCP server fails preflight', async () => {
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
        toolNames: [],
        error: 'spawn /nonexistent ENOENT',
        durationMs: 4,
      },
    ]);

    const runtime = new ClaudeCodeRuntime({});
    await expect(
      runtime.dispatch(baseParams({ db: createMockDb() as never, activeRepoRoot: '/repo' })),
    ).rejects.toThrow(/failed preflight/);

    // The entire point of preflighting rather than gating mid-stream: a run that
    // could never have reported its outcome costs zero model spend.
    expect(mockSpawn).not.toHaveBeenCalled();
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
        onRuntimeEnd: async (e) => {
          event = e as never;
        },
      }),
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

  it('classifies a non-zero exit as a failed run', async () => {
    const runtime = new ClaudeCodeRuntime({});
    let event: { success: boolean; reason?: string } | null = null;

    await runtime.dispatch(
      baseParams({
        db: createMockDb() as never,
        activeRepoRoot: '/repo',
        onRuntimeEnd: async (e) => {
          event = e as never;
        },
      }),
    );

    child.stderr.write('boom');
    child.stdout.end();
    child.emit('close', 1, null);
    await flush();

    expect(event!.success).toBe(false);
    expect(event!.reason).toBe('error');
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

    await runtime.abort(runId, 'agent:forge:run:1');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('is a no-op for an unknown runId', async () => {
    const runtime = new ClaudeCodeRuntime({});
    await expect(runtime.abort('claude-code:999', 'k')).resolves.toBeUndefined();
    await expect(runtime.abort('hermes:1', 'k')).resolves.toBeUndefined();
  });
});
