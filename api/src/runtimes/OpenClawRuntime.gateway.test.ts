type SentRequest = {
  method: string;
  params: Record<string, unknown>;
};

const mockSentRequests: SentRequest[] = [];
let mockPatchShouldFail = false;
let mockChatSendShouldFail = false;
const mockSocketInstances: Array<{ close: () => void; emitClose: () => void }> = [];
const mockDropBeforeResponseCounts = new Map<string, number>();
const mockNeverRespondMethods = new Set<string>();
const mockResponseDelays = new Map<string, number>();
const mockToolsEffectivePayloads: Array<Record<string, unknown>> = [];

const mockSyncOAuthProviderForOpenClawAgent = jest.fn();
const ORIGINAL_MCP_READINESS_TIMEOUT_MS = process.env.AGENT_HQ_OPENCLAW_MCP_READINESS_TIMEOUT_MS;
const ORIGINAL_MCP_READINESS_POLL_MS = process.env.AGENT_HQ_OPENCLAW_MCP_READINESS_POLL_MS;

jest.mock('ws', () => {
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    readyState = MockWebSocket.OPEN;
    private handlers = new Map<string, Array<(value?: unknown) => void>>();

    constructor() {
      mockSocketInstances.push(this);
      setImmediate(() => {
        this.emit('message', Buffer.from(JSON.stringify({
          type: 'event',
          event: 'connect.challenge',
          payload: { nonce: 'nonce' },
        })));
      });
    }

    on(event: string, handler: (value?: unknown) => void): this {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
      return this;
    }

    send(raw: string): void {
      const frame = JSON.parse(raw) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      mockSentRequests.push({ method: frame.method, params: frame.params });

      const response: Record<string, unknown> = {
        type: 'res',
        id: frame.id,
        payload: {},
      };

      if (frame.method === 'sessions.patch' && mockPatchShouldFail) {
        delete response.payload;
        response.error = { code: 'INVALID_REQUEST', message: 'bad runtime config' };
      } else if (frame.method === 'chat.send') {
        if (mockChatSendShouldFail) {
          delete response.payload;
          response.error = { code: 'INVALID_REQUEST', message: 'bad chat send' };
        } else {
          response.payload = { runId: 'run-123' };
        }
      } else if (frame.method === 'chat.history') {
        response.payload = {
          messages: [
            { role: 'assistant', content: 'hello', timestamp: '2026-06-04T12:00:00.000Z' },
          ],
        };
      } else if (frame.method === 'tools.effective') {
        response.payload = mockToolsEffectivePayloads.length > 0
          ? mockToolsEffectivePayloads.shift()
          : {
              groups: [
                { id: 'core', tools: [{ id: 'exec_command' }] },
              ],
            };
      } else if (frame.method === 'secrets.reload') {
        response.payload = { warningCount: 2 };
      }

      const dropCount = mockDropBeforeResponseCounts.get(frame.method) ?? 0;
      if (dropCount > 0) {
        mockDropBeforeResponseCounts.set(frame.method, dropCount - 1);
        setImmediate(() => this.close());
        return;
      }

      if (mockNeverRespondMethods.has(frame.method)) return;

      const emitResponse = () => {
        this.emit('message', Buffer.from(JSON.stringify(response)));
      };
      const delayMs = mockResponseDelays.get(frame.method) ?? 0;
      if (delayMs > 0) {
        setTimeout(emitResponse, delayMs);
      } else {
        setImmediate(emitResponse);
      }
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close');
    }

    emitClose(): void {
      this.close();
    }

    emit(event: string, value?: unknown): void {
      const handlers = this.handlers.get(event) ?? [];
      for (const handler of handlers) {
        handler(value);
      }
    }
  }

  return { WebSocket: MockWebSocket };
});

jest.mock('../lib/openclawOAuthProfiles', () => ({
  syncOAuthProviderForOpenClawAgent: (...args: unknown[]) => mockSyncOAuthProviderForOpenClawAgent(...args),
}));

import {
  __resetGatewayConnectionPoolForTests,
  OpenClawRuntime,
  gatewayWsGetEffectiveTools,
  gatewayGetHistory,
  gatewayWsPatchSession,
  gatewayWsSend,
  reloadOpenClawSecretsRuntimeForAuthSync,
} from './OpenClawRuntime';

function dispatchParams(overrides: Partial<Parameters<OpenClawRuntime['dispatch']>[0]> = {}): Parameters<OpenClawRuntime['dispatch']>[0] {
  return {
    message: 'Implement task',
    agentSlug: 'cinder-backend',
    sessionKey: 'hook:atlas:jobrun:383',
    timeoutSeconds: 900,
    name: 'Cinder',
    ...overrides,
  };
}

async function waitForSentRequestCount(count: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (mockSentRequests.length >= count) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('OpenClawRuntime gateway dispatch', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    __resetGatewayConnectionPoolForTests();
    mockSentRequests.length = 0;
    mockSocketInstances.length = 0;
    mockPatchShouldFail = false;
    mockChatSendShouldFail = false;
    mockDropBeforeResponseCounts.clear();
    mockNeverRespondMethods.clear();
    mockResponseDelays.clear();
    mockToolsEffectivePayloads.length = 0;
    process.env.AGENT_HQ_OPENCLAW_MCP_READINESS_TIMEOUT_MS = '20';
    process.env.AGENT_HQ_OPENCLAW_MCP_READINESS_POLL_MS = '1';
    mockSyncOAuthProviderForOpenClawAgent.mockResolvedValue({
      ok: true,
      provider: 'openai-codex',
      refreshed: false,
      updatedPaths: [],
    });
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    __resetGatewayConnectionPoolForTests();
    logSpy.mockRestore();
    jest.restoreAllMocks();
    jest.useRealTimers();
    if (ORIGINAL_MCP_READINESS_TIMEOUT_MS === undefined) delete process.env.AGENT_HQ_OPENCLAW_MCP_READINESS_TIMEOUT_MS;
    else process.env.AGENT_HQ_OPENCLAW_MCP_READINESS_TIMEOUT_MS = ORIGINAL_MCP_READINESS_TIMEOUT_MS;
    if (ORIGINAL_MCP_READINESS_POLL_MS === undefined) delete process.env.AGENT_HQ_OPENCLAW_MCP_READINESS_POLL_MS;
    else process.env.AGENT_HQ_OPENCLAW_MCP_READINESS_POLL_MS = ORIGINAL_MCP_READINESS_POLL_MS;
  });

  it('applies model, thinking, and fast mode through sessions.patch before chat.send', async () => {
    const runtime = new OpenClawRuntime();

    const result = await runtime.dispatch(dispatchParams({
      model: 'anthropic/claude-opus-4-6',
      thinking: 'high',
      fastMode: true,
    }));

    expect(result.runId).toBe('run-123');
    expect(mockSentRequests.map((request) => request.method)).toEqual([
      'connect',
      'sessions.patch',
      'chat.send',
    ]);
    expect(mockSocketInstances).toHaveLength(1);

    const patch = mockSentRequests.find((request) => request.method === 'sessions.patch');
    expect(patch?.params).toEqual({
      key: 'agent:cinder-backend:hook:atlas:jobrun:383',
      model: 'anthropic/claude-opus-4-6',
      thinkingLevel: 'high',
      fastMode: true,
    });

    const send = mockSentRequests.find((request) => request.method === 'chat.send');
    expect(send?.params).toEqual(expect.objectContaining({
      sessionKey: 'agent:cinder-backend:hook:atlas:jobrun:383',
      message: 'Implement task',
      timeoutMs: 900_000,
    }));
    expect(send?.params).not.toHaveProperty('systemInputProvenance');
    expect(send?.params).not.toHaveProperty('model');
    expect(send?.params).not.toHaveProperty('thinking');
    expect(send?.params).not.toHaveProperty('thinkingLevel');
    expect(send?.params).not.toHaveProperty('cwd');
    expect(send?.params).not.toHaveProperty('metadata');
  });

  it('waits for required assigned MCP tools to appear before the first chat.send', async () => {
    mockToolsEffectivePayloads.push(
      {
        groups: [
          { id: 'core', tools: [{ id: 'exec_command' }] },
        ],
        notices: [
          { id: 'mcp-stale-catalog', severity: 'info', message: 'stale' },
        ],
      },
      {
        groups: [
          { id: 'core', tools: [{ id: 'exec_command' }] },
          { id: 'mcp', tools: [{ id: 'dev_env_deploy_worktree', source: 'mcp' }] },
        ],
      },
    );
    const runtime = new OpenClawRuntime();

    const result = await runtime.dispatch(dispatchParams({
      openClawMcpReadiness: {
        serverNames: ['dev-environment-lease-manager__agent-94'],
        requiredToolNames: ['dev_env_deploy_worktree'],
        materializedCount: 1,
        bundlePath: '/workspace/.openclaw/extensions/agent-hq-mcp/.mcp.json',
      },
    }));

    expect(result.runId).toBe('run-123');
    expect(mockSentRequests.map((request) => request.method)).toEqual([
      'connect',
      'sessions.patch',
      'tools.effective',
      'tools.effective',
      'chat.send',
    ]);
    const effectiveCalls = mockSentRequests.filter((request) => request.method === 'tools.effective');
    expect(effectiveCalls).toHaveLength(2);
    expect(effectiveCalls[0].params).toEqual({
      sessionKey: 'agent:cinder-backend:hook:atlas:jobrun:383',
      agentId: 'cinder-backend',
    });
    const patch = mockSentRequests.find((request) => request.method === 'sessions.patch');
    expect(patch?.params).toEqual({
      key: 'agent:cinder-backend:hook:atlas:jobrun:383',
    });
  });

  it('fails before chat.send when required assigned MCP tools stay absent', async () => {
    const runtime = new OpenClawRuntime();

    await expect(runtime.dispatch(dispatchParams({
      openClawMcpReadiness: {
        serverNames: ['dev-environment-lease-manager__agent-94'],
        requiredToolNames: ['dev_env_deploy_worktree'],
        materializedCount: 1,
        bundlePath: '/workspace/.openclaw/extensions/agent-hq-mcp/.mcp.json',
      },
    }))).rejects.toThrow('OpenClaw MCP readiness timed out before dispatch');

    expect(mockSentRequests.map((request) => request.method)).toContain('tools.effective');
    expect(mockSentRequests.some((request) => request.method === 'chat.send')).toBe(false);
  });

  it('syncs Agent HQ-managed Codex OAuth in prepareAuthProfiles before gateway dispatch', async () => {
    const runtime = new OpenClawRuntime();

    const result = await runtime.prepareAuthProfiles({
      preferredProvider: 'openai-codex',
      agentSlug: 'cinder-backend',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'synced',
      providersSynced: ['openai-codex'],
    }));
    expect(mockSyncOAuthProviderForOpenClawAgent).toHaveBeenCalledWith({
      provider: 'openai-codex',
      agentSlug: 'cinder-backend',
    });
    expect(mockSentRequests).toEqual([]);
  });

  it('fails OpenClaw credential preparation clearly when Codex sync fails', async () => {
    mockSyncOAuthProviderForOpenClawAgent.mockResolvedValue({
      ok: false,
      provider: 'openai-codex',
      refreshed: false,
      updatedPaths: [],
      error: 'No OAuth profile "openai-codex:default" with a refresh token was found.',
    });
    const runtime = new OpenClawRuntime();

    const result = await runtime.prepareAuthProfiles({
      preferredProvider: 'openai-codex',
      agentSlug: 'cinder-backend',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'failed',
      error: 'No OAuth profile "openai-codex:default" with a refresh token was found.',
    }));
    expect(mockSentRequests).toEqual([]);
  });

  it('treats adaptive thinking as the OpenClaw default and omits thinkingLevel', async () => {
    const runtime = new OpenClawRuntime();

    await runtime.dispatch(dispatchParams({
      model: 'openai/gpt-5.5',
      preferredProvider: 'openai-codex',
      thinking: 'adaptive',
    }));

    const patch = mockSentRequests.find((request) => request.method === 'sessions.patch');
    expect(patch?.params).toEqual({
      key: 'agent:cinder-backend:hook:atlas:jobrun:383',
      model: 'openai/gpt-5.5',
    });
  });

  it('fails dispatch when sessions.patch rejects a requested model override', async () => {
    mockPatchShouldFail = true;
    const runtime = new OpenClawRuntime();

    await expect(runtime.dispatch(dispatchParams({
      model: 'anthropic/claude-opus-4-6',
      thinking: 'high',
    }))).rejects.toThrow('Failed to apply runtime routing overrides');

    expect(mockSentRequests.some((request) => request.method === 'chat.send')).toBe(false);
  });

  it('returns sessions.patch failures through the extracted gateway client', async () => {
    mockPatchShouldFail = true;

    const result = await gatewayWsPatchSession({
      sessionKey: 'agent:cinder-backend:hook:atlas:jobrun:383',
      model: 'anthropic/claude-opus-4-6',
    });

    expect(result).toEqual({
      ok: false,
      error: 'sessions.patch failed: {"code":"INVALID_REQUEST","message":"bad runtime config"}',
    });
  });

  it('normalizes tools.effective payloads through the extracted gateway client', async () => {
    mockToolsEffectivePayloads.push({
      groups: [
        { id: 'mcp', tools: [{ id: 'dev_env_deploy_worktree' }] },
      ],
      notices: [{ id: 'mcp-stale-catalog' }],
    });

    const result = await gatewayWsGetEffectiveTools({
      sessionKey: 'agent:cinder-backend:hook:atlas:jobrun:383',
      agentId: 'cinder-backend',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      toolNames: ['dev_env_deploy_worktree'],
      noticeIds: ['mcp-stale-catalog'],
    }));
  });

  it('normalizes chat.history payloads through the extracted gateway client', async () => {
    const result = await gatewayGetHistory({
      sessionKey: 'agent:cinder-backend:hook:atlas:jobrun:383',
      limit: 12,
    });

    expect(result).toEqual({
      ok: true,
      messages: [
        { role: 'assistant', content: 'hello', timestamp: '2026-06-04T12:00:00.000Z' },
      ],
    });
    const history = mockSentRequests.find((request) => request.method === 'chat.history');
    expect(history?.params).toEqual({
      sessionKey: 'agent:cinder-backend:hook:atlas:jobrun:383',
      limit: 12,
    });
  });

  it('multiplexes concurrent short-lived gateway RPC responses over one socket by response id', async () => {
    mockResponseDelays.set('chat.history', 15);

    const [historyResult, reloadResult] = await Promise.all([
      gatewayGetHistory({
        sessionKey: 'agent:cinder-backend:hook:atlas:jobrun:383',
        limit: 12,
      }),
      reloadOpenClawSecretsRuntimeForAuthSync(),
    ]);

    expect(historyResult).toEqual({
      ok: true,
      messages: [
        { role: 'assistant', content: 'hello', timestamp: '2026-06-04T12:00:00.000Z' },
      ],
    });
    expect(reloadResult).toEqual({
      ok: true,
      message: 'OpenClaw secrets runtime reloaded (2 warning(s)).',
    });
    expect(mockSocketInstances).toHaveLength(1);
    expect(mockSentRequests.map((request) => request.method)).toEqual([
      'connect',
      'chat.history',
      'secrets.reload',
    ]);
  });

  it('fails in-flight calls predictably after the disconnect retry is exhausted and reconnects lazily later', async () => {
    mockNeverRespondMethods.add('chat.history');
    const inFlight = gatewayGetHistory({
      sessionKey: 'agent:cinder-backend:hook:atlas:jobrun:383',
      limit: 12,
    });

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    mockSocketInstances[0].emitClose();
    await waitForSentRequestCount(4);
    mockSocketInstances[1].emitClose();

    await expect(inFlight).resolves.toEqual({
      ok: false,
      messages: [],
      error: 'Gateway WebSocket disconnected before response',
    });

    mockNeverRespondMethods.clear();
    const nextResult = await gatewayGetHistory({
      sessionKey: 'agent:cinder-backend:hook:atlas:jobrun:383',
      limit: 12,
    });

    expect(nextResult.ok).toBe(true);
    expect(mockSocketInstances).toHaveLength(3);
    expect(mockSentRequests.map((request) => request.method)).toEqual([
      'connect',
      'chat.history',
      'connect',
      'chat.history',
      'connect',
      'chat.history',
    ]);
  });

  it('retries once with stable RPC params when the connection drops', async () => {
    mockDropBeforeResponseCounts.set('chat.send', 1);

    const result = await gatewayWsSend({
      sessionKey: 'agent:cinder-backend:hook:atlas:jobrun:383',
      message: 'Implement task',
    });

    expect(result).toEqual({ ok: true, runId: 'run-123' });
    const sendRequests = mockSentRequests.filter((request) => request.method === 'chat.send');
    expect(sendRequests).toHaveLength(2);
    expect(sendRequests[0].params).toEqual(sendRequests[1].params);
    expect(mockSentRequests.map((request) => request.method)).toEqual([
      'connect',
      'chat.send',
      'connect',
      'chat.send',
    ]);
  });

  it('does not retry application-level gateway RPC errors', async () => {
    mockChatSendShouldFail = true;

    const result = await gatewayWsSend({
      sessionKey: 'agent:cinder-backend:hook:atlas:jobrun:383',
      message: 'Implement task',
    });

    expect(result).toEqual({
      ok: false,
      error: 'chat.send failed: {"code":"INVALID_REQUEST","message":"bad chat send"}',
    });
    expect(mockSentRequests.map((request) => request.method)).toEqual([
      'connect',
      'chat.send',
    ]);
    expect(mockSocketInstances).toHaveLength(1);
  });

  it('preserves per-call timeout behavior through the shared socket', async () => {
    jest.useFakeTimers();
    mockNeverRespondMethods.add('chat.history');

    const resultPromise = gatewayGetHistory({
      sessionKey: 'agent:cinder-backend:hook:atlas:jobrun:383',
      limit: 12,
      timeoutMs: 25,
    });

    await jest.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      messages: [],
      error: 'Gateway WebSocket timeout',
    });
  });

  it('resets the singleton gateway pool for test isolation', async () => {
    await reloadOpenClawSecretsRuntimeForAuthSync();
    expect(mockSocketInstances).toHaveLength(1);

    __resetGatewayConnectionPoolForTests();
    await reloadOpenClawSecretsRuntimeForAuthSync();

    expect(mockSocketInstances).toHaveLength(2);
    expect(mockSentRequests.map((request) => request.method)).toEqual([
      'connect',
      'secrets.reload',
      'connect',
      'secrets.reload',
    ]);
  });

  it('reloads secrets through the extracted gateway client', async () => {
    const result = await reloadOpenClawSecretsRuntimeForAuthSync();

    expect(result).toEqual({
      ok: true,
      message: 'OpenClaw secrets runtime reloaded (2 warning(s)).',
    });
    expect(mockSentRequests.map((request) => request.method)).toEqual([
      'connect',
      'secrets.reload',
    ]);
  });

  it('keeps moved gateway helpers available through the flat dynamic import path', async () => {
    const runtimeModule = await import('./OpenClawRuntime');

    expect(runtimeModule.OpenClawRuntime).toBe(OpenClawRuntime);
    expect(runtimeModule.gatewayWsSend).toEqual(expect.any(Function));
    expect(runtimeModule.gatewayGetHistory).toBe(gatewayGetHistory);
    expect(runtimeModule.gatewayWsPatchSession).toBe(gatewayWsPatchSession);
    expect(runtimeModule.__resetGatewayConnectionPoolForTests).toBe(__resetGatewayConnectionPoolForTests);
    expect(runtimeModule.reloadOpenClawSecretsRuntimeForAuthSync).toBe(reloadOpenClawSecretsRuntimeForAuthSync);
  });

  it('continues to chat.send when sessions.patch rejects optional non-model overrides', async () => {
    mockPatchShouldFail = true;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runtime = new OpenClawRuntime();

    const result = await runtime.dispatch(dispatchParams({
      thinking: 'high',
    }));

    expect(result.runId).toBe('run-123');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to apply runtime routing overrides'));

    const send = mockSentRequests.find((request) => request.method === 'chat.send');
    expect(send?.params).toEqual(expect.objectContaining({
      sessionKey: 'agent:cinder-backend:hook:atlas:jobrun:383',
      message: 'Implement task',
    }));
    expect(send?.params).not.toHaveProperty('model');
    expect(send?.params).not.toHaveProperty('cwd');
    expect(send?.params).not.toHaveProperty('metadata');
  });

  it('adds active repo context to the initial message without chat.send cwd metadata', async () => {
    const runtime = new OpenClawRuntime();

    const result = await runtime.dispatch(dispatchParams({
      workspaceRoot: '/Users/nordini/.openclaw/workspace-agent-hq-backend',
      activeRepoRoot: '/Users/nordini/.openclaw/workspace-agent-hq-backend/task-375',
      repoAccessMode: 'worktree',
      repoSource: 'worktree:/Users/nordini/agent-hq',
      repoWorkspacePath: '/Users/nordini/.openclaw/workspace-agent-hq-backend/task-375',
      repoBranch: 'prism-frontend/task-386-bug-atlas-chat-panel-opens-with-floating',
      pathMetadata: {
        pathMode: 'worktree',
        repoRootSource: 'worktree',
        workspaceRootSource: 'workspace',
        worktreeRoot: '/Users/nordini/.openclaw/workspace-agent-hq-backend/task-375',
        runtimeConfigWorkingDirectory: '/Users/nordini/.openclaw/workspace-agent-hq-backend',
      },
    }));

    expect(result).toEqual({ runId: 'run-123' });

    const send = mockSentRequests.find((request) => request.method === 'chat.send');
    expect(send).toBeDefined();
    expect(send?.params).toEqual(expect.objectContaining({
      sessionKey: 'agent:cinder-backend:hook:atlas:jobrun:383',
      timeoutMs: 900_000,
    }));
    expect(send?.params).not.toHaveProperty('cwd');
    expect(send?.params).not.toHaveProperty('metadata');

    const message = String(send?.params.message);
    expect(message).toContain('Implement task');
    expect(message).toContain('## Active Repo Context');
    expect(message).toContain('Use this path as the current working directory for repo, file, and git operations:');
    expect(message).toContain('/Users/nordini/.openclaw/workspace-agent-hq-backend/task-375');
    expect(message).toContain('Repo access mode: worktree');
    expect(message).toContain('Path mode: worktree');
    expect(message).toContain('Repo source: worktree:/Users/nordini/agent-hq');
    expect(message).toContain('Prepared repo workspace: /Users/nordini/.openclaw/workspace-agent-hq-backend/task-375');
    expect(message).toContain('Branch: prism-frontend/task-386-bug-atlas-chat-panel-opens-with-floating');
    expect(message).toContain('Parent workspace root: /Users/nordini/.openclaw/workspace-agent-hq-backend');
    expect(message).toContain('Repo root source: worktree');
    expect(message).toContain('Workspace root source: workspace');

    expect(logSpy).toHaveBeenCalledWith(
      '[OpenClawRuntime] dispatch path resolution: sessionKey=agent:cinder-backend:hook:atlas:jobrun:383 mode=worktree cwd=/Users/nordini/.openclaw/workspace-agent-hq-backend/task-375 activeRepoRoot=/Users/nordini/.openclaw/workspace-agent-hq-backend/task-375 workspaceRoot=/Users/nordini/.openclaw/workspace-agent-hq-backend worktreeRoot=/Users/nordini/.openclaw/workspace-agent-hq-backend/task-375 runtimeConfigWorkingDirectory=/Users/nordini/.openclaw/workspace-agent-hq-backend repoRootSource=worktree workspaceRootSource=workspace',
    );
  });

  it('uses activeRepoRoot in prompt context when workspaceRoot points at the parent workspace', async () => {
    const runtime = new OpenClawRuntime();

    await runtime.dispatch(dispatchParams({
      workspaceRoot: '/parent/workspace',
      activeRepoRoot: '/parent/workspace/task-375',
      pathMetadata: {
        pathMode: 'worktree',
        repoRootSource: 'worktree',
        workspaceRootSource: 'workspace',
        worktreeRoot: '/parent/workspace/task-375',
        runtimeConfigWorkingDirectory: '/parent/workspace',
      },
    }));

    const send = mockSentRequests.find((request) => request.method === 'chat.send');
    expect(send).toBeDefined();
    expect(send?.params).not.toHaveProperty('cwd');
    expect(send?.params).not.toHaveProperty('metadata');

    const message = String(send?.params.message);
    expect(message).toContain('Use this path as the current working directory for repo, file, and git operations:\n/parent/workspace/task-375');
    expect(message).toContain('Active repo root: /parent/workspace/task-375');
    expect(message).toContain('Parent workspace root: /parent/workspace');
  });

  it('falls back to workspaceRoot in prompt context when no activeRepoRoot is provided', async () => {
    const runtime = new OpenClawRuntime();

    await runtime.dispatch(dispatchParams({
      workspaceRoot: '/parent/workspace',
      activeRepoRoot: null,
    }));

    const send = mockSentRequests.find((request) => request.method === 'chat.send');
    expect(send).toBeDefined();
    expect(send?.params).not.toHaveProperty('cwd');
    expect(send?.params).not.toHaveProperty('metadata');

    const message = String(send?.params.message);
    expect(message).toContain('Use this path as the current working directory for repo, file, and git operations:\n/parent/workspace');
    expect(message).toContain('Path mode: workspace-root');
    expect(message).toContain('Parent workspace root: /parent/workspace');
  });

  it('does not add repo context when no repo roots are provided', async () => {
    const runtime = new OpenClawRuntime();

    await runtime.dispatch(dispatchParams());

    const send = mockSentRequests.find((request) => request.method === 'chat.send');
    expect(send).toBeDefined();
    expect(send?.params).toEqual(expect.objectContaining({
      message: 'Implement task',
    }));
    expect(send?.params).not.toHaveProperty('cwd');
    expect(send?.params).not.toHaveProperty('metadata');
    expect(String(send?.params.message)).not.toContain('## Active Repo Context');
  });
});
