import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';
import { applyRuntimeEndToJobInstance } from '../../domains/runs/runtimeEnd';
import {
  appendRuntimeCheckpoint,
  heartbeatRuntimeExecution,
  terminalRuntimeExecution,
  upsertRuntimeExecutionStart,
} from '../runtimeExecutionStore';
import { localProcessIdentity } from '../localProcessSupervisor';
import { CodexRuntime } from './CodexRuntime';
import { codexProviderHomeReference } from './auth';
import { DEFAULT_CODEX_STALE_PROFILE_TTL_MS } from './profile';
import type { CodexMcpMaterialization } from './types';

const mockPreflight = jest.fn(async (..._args: unknown[]) => [] as unknown[]);
const mockCleanupOwnedProcessTree = jest.fn(async (..._args: unknown[]) => ({
  confirmed: true,
  escalated: false,
  scope: 'process-group' as const,
  error: undefined as string | undefined,
}));
const mockResolveRuntimeExecutable = jest.fn((..._args: unknown[]) => ({
  path: '/opt/agent-hq/bin/codex',
  fingerprint: 'sha256:test-codex-executable',
}));
const mockProbeRuntimeCliVersion = jest.fn(async (..._args: unknown[]) => ({
  ok: true,
  version: 'codex-cli 0.146.0',
  executablePath: '/opt/agent-hq/bin/codex',
  executableFingerprint: 'sha256:test-codex-executable',
  message: 'codex-cli 0.146.0 (supported)',
  details: {
    minimum_supported: '0.146.0',
    maximum_exclusive: '0.147.0',
    detected: '0.146.0',
    executable_path: '/opt/agent-hq/bin/codex',
    executable_fingerprint: 'sha256:test-codex-executable',
  },
}));
const mockAssertRuntimeBoundaryAssignmentsCurrent = jest.fn(
  async (..._args: unknown[]) => undefined,
);
const mockMaterializeMcp = jest.fn(async (
  {
    codexHome,
    configPath,
    snapshotPath,
  }: { codexHome: string; configPath?: string; snapshotPath?: string },
): Promise<CodexMcpMaterialization> => ({
  codexHome,
  configPath: configPath ?? path.join(codexHome, 'config.toml'),
  snapshotPath: snapshotPath ?? path.join(codexHome, 'agent-hq-mcp-servers.json'),
  serverNames: [],
  requiredServerNames: [],
  servers: {},
  warnings: [],
}));

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(),
}));
jest.mock('../../domains/runs/runtimeEnd', () => ({
  applyRuntimeEndToJobInstance: jest.fn(async () => ({ changed: true })),
}));
jest.mock('../runtimeExecutionStore', () => ({
  upsertRuntimeExecutionStart: jest.fn(async () => ({
    status: 'persisted',
    executionId: 91,
    checkpointId: 1,
    sequence: 0,
    idempotent: false,
  })),
  appendRuntimeCheckpoint: jest.fn(async () => ({
    status: 'persisted', executionId: 91, checkpointId: 1, sequence: 0,
  })),
  heartbeatRuntimeExecution: jest.fn(async () => ({ status: 'persisted', executionId: 91 })),
  terminalRuntimeExecution: jest.fn(async () => ({ status: 'persisted', executionId: 91 })),
}));
jest.mock('../localProcessSupervisor', () => ({
  ...(jest.requireActual('../localProcessSupervisor') as object),
  localProcessIdentity: jest.fn(() => 'sha256:stable-test-process-identity'),
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
jest.mock('../claudeCode/mcpPreflight', () => ({
  ...(jest.requireActual('../claudeCode/mcpPreflight') as object),
  preflightMcpServers: (...args: unknown[]) => mockPreflight(...args),
}));
jest.mock('./mcpConfig', () => ({
  ...jest.requireActual('./mcpConfig'),
  materializeCodexMcpConfig: (...args: unknown[]) => mockMaterializeMcp(...args as [{
    codexHome: string;
    configPath?: string;
    snapshotPath?: string;
  }]),
}));

class MockChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  kill = jest.fn(() => true);
  pid: number | undefined = 43_210;
  prompt = '';

  constructor() {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => { this.prompt += chunk; });
  }
}

const spawnMock = spawn as jest.MockedFunction<typeof spawn>;
const applyEnd = applyRuntimeEndToJobInstance as jest.MockedFunction<typeof applyRuntimeEndToJobInstance>;
const persistStart = upsertRuntimeExecutionStart as jest.MockedFunction<typeof upsertRuntimeExecutionStart>;
const appendCheckpoint = appendRuntimeCheckpoint as jest.MockedFunction<typeof appendRuntimeCheckpoint>;
const persistHeartbeat = heartbeatRuntimeExecution as jest.MockedFunction<typeof heartbeatRuntimeExecution>;
const persistTerminal = terminalRuntimeExecution as jest.MockedFunction<typeof terminalRuntimeExecution>;
const processIdentity = localProcessIdentity as jest.MockedFunction<typeof localProcessIdentity>;
let root: string;
let child: MockChild;
const originalRunStateDir = process.env.AGENT_HQ_RUN_STATE_DIR;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-test-'));
  process.env.AGENT_HQ_RUN_STATE_DIR = path.join(root, 'runtime-state');
  child = new MockChild();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    process.nextTick(() => child.emit('spawn'));
    return child as never;
  });
  mockResolveRuntimeExecutable.mockClear();
  mockResolveRuntimeExecutable.mockReturnValue({
    path: '/opt/agent-hq/bin/codex',
    fingerprint: 'sha256:test-codex-executable',
  });
  mockProbeRuntimeCliVersion.mockReset();
  mockProbeRuntimeCliVersion.mockResolvedValue({
    ok: true,
    version: 'codex-cli 0.146.0',
    executablePath: '/opt/agent-hq/bin/codex',
    executableFingerprint: 'sha256:test-codex-executable',
    message: 'codex-cli 0.146.0 (supported)',
    details: {
      minimum_supported: '0.146.0',
      maximum_exclusive: '0.147.0',
      detected: '0.146.0',
      executable_path: '/opt/agent-hq/bin/codex',
      executable_fingerprint: 'sha256:test-codex-executable',
    },
  });
  mockAssertRuntimeBoundaryAssignmentsCurrent.mockReset();
  mockAssertRuntimeBoundaryAssignmentsCurrent.mockResolvedValue(undefined);
  applyEnd.mockClear();
  persistStart.mockClear();
  appendCheckpoint.mockClear();
  persistHeartbeat.mockClear();
  persistTerminal.mockClear();
  processIdentity.mockReset();
  processIdentity.mockReturnValue('sha256:stable-test-process-identity');
  mockCleanupOwnedProcessTree.mockReset();
  mockCleanupOwnedProcessTree.mockResolvedValue({
    confirmed: true,
    escalated: false,
    scope: 'process-group',
    error: undefined,
  });
  mockPreflight.mockReset();
  mockPreflight.mockResolvedValue([]);
  mockMaterializeMcp.mockReset();
  mockMaterializeMcp.mockImplementation(async (
    {
      codexHome,
      configPath,
      snapshotPath,
    }: { codexHome: string; configPath?: string; snapshotPath?: string },
  ): Promise<CodexMcpMaterialization> => ({
    codexHome,
    configPath: configPath ?? path.join(codexHome, 'config.toml'),
    snapshotPath: snapshotPath ?? path.join(codexHome, 'agent-hq-mcp-servers.json'),
    serverNames: [] as string[],
    requiredServerNames: [] as string[],
    servers: {},
    warnings: [],
  }));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
afterAll(() => {
  if (originalRunStateDir === undefined) delete process.env.AGENT_HQ_RUN_STATE_DIR;
  else process.env.AGENT_HQ_RUN_STATE_DIR = originalRunStateDir;
});

function params(overrides: Record<string, unknown> = {}) {
  const instanceId = typeof overrides.instanceId === 'number' ? overrides.instanceId : 7;
  const agentSlug = typeof overrides.agentSlug === 'string' ? overrides.agentSlug : 'cinder';
  const boundary = runtimeBoundary();
  boundary.identity.instanceId = instanceId;
  boundary.identity.agentSlug = agentSlug;
  return {
    message: 'Implement the task.',
    agentSlug,
    sessionKey: 'agent:cinder:main',
    timeoutSeconds: 60,
    name: 'Codex test',
    instanceId,
    db: createRuntimeDb(),
    runtimeBoundary: boundary,
    activeRepoRoot: root,
    runtimeConfig: { codexHomeRoot: root, killGraceMs: 1_000 },
    ...overrides,
  } as never;
}

function runtimeBoundary() {
  return {
    version: 1,
    identity: {
      tenantId: 2, projectId: 3, workflowId: null, taskId: 5,
      instanceId: 7, durableRunId: 'run-7', agentId: 42, agentSlug: 'cinder',
    },
    runtime: {
      type: 'codex', driverVersion: '1',
      executableFingerprint: 'sha256:test-codex-executable', configRevision: 'config-hash',
      model: 'gpt-5.5', reasoning: 'high', fastMode: false,
      timeoutSeconds: 60, tokenBudget: null, turnLimit: null,
    },
    workspace: {
      workspaceRoot: root, activeRepoRoot: root, repoAccessMode: 'workspace',
      repoSource: null, branch: null, commit: null, fingerprint: 'workspace-hash',
    },
    prompt: { bundleFingerprint: 'prompt-hash' },
    executionTarget: {
      id: 'local-api-process', kind: 'local-process', trustLevel: 'workspace',
      capabilities: ['inspect', 'signals', 'resume', 'workspace-write'],
    },
    tools: { builtIn: [], mcpServers: [], requiredLifecycleTools: [], skills: [], registryTools: [] },
    auth: { provider: 'openai-codex', providerConnectionId: null, credentialRefs: [] },
    evidence: { required: false, requirements: [] },
    callback: { identity: 'agent:cinder:main' },
    priorCheckpoint: null,
    observability: { traceId: 'run-7', correlationId: 'run-7', requestedBy: null },
  };
}

function createRuntimeDb(
  ownership: { agentId?: number; tenantId?: number } = {},
) {
  const agentId = ownership.agentId ?? 42;
  const tenantId = ownership.tenantId ?? 2;
  const runs: Array<{ sql: string; values: unknown[] }> = [];
  return {
    runs,
    inTransaction: false,
    get: jest.fn(async (sql: string) => sql.includes('SELECT agent_id')
      ? { agent_id: agentId, tenant_id: tenantId }
      : undefined),
    all: jest.fn(async () => []),
    value: jest.fn(async () => undefined),
    run: jest.fn(async (sql: string, ...values: unknown[]) => {
      runs.push({ sql, values });
      return { changes: 1, lastInsertId: null };
    }),
    exec: jest.fn(async () => undefined),
    withTransaction: jest.fn(),
    close: jest.fn(),
  };
}

describe('CodexRuntime', () => {
  it('rejects a case-variant runtime PATH before resolving or spawning a workspace shim', async () => {
    await expect(new CodexRuntime().dispatch(params({
      runtimeConfig: {
        codexHomeRoot: root,
        env: { Path: path.join(root, 'attacker-bin') },
      },
    }))).rejects.toThrow(/may not set protected.*Path/);

    expect(mockResolveRuntimeExecutable).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects an incomplete durable context before probing, writing, or spawning', async () => {
    await expect(new CodexRuntime().dispatch(params({ db: undefined })))
      .rejects.toThrow(/requires db, instanceId, and runtimeBoundary/);

    expect(mockProbeRuntimeCliVersion).not.toHaveBeenCalled();
    expect(mockResolveRuntimeExecutable).not.toHaveBeenCalled();
    expect(mockMaterializeMcp).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('fails boundaryless ad-hoc clearly without an explicit provider connection', async () => {
    await expect(new CodexRuntime().dispatch(params({
      dispatchMode: 'ad-hoc',
      db: undefined,
      instanceId: undefined,
      runtimeBoundary: undefined,
    }))).rejects.toThrow(/requires an explicit provider connection/);

    expect(mockAssertRuntimeBoundaryAssignmentsCurrent).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('runs explicit ad-hoc work in a nonce-only home and removes it after tree cleanup', async () => {
    const providerHome = path.join(root, 'explicit-provider-home');
    fs.mkdirSync(providerHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(providerHome, 'auth.json'),
      `${JSON.stringify({ OPENAI_API_KEY: 'test-only-provider-credential' })}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(providerHome, 'config.toml'),
      'model = "ambient-provider-model"\nmodel_reasoning_effort = "xhigh"\n',
      { mode: 0o600 },
    );
    let resolveEnd!: () => void;
    const ended = new Promise<void>((resolve) => { resolveEnd = resolve; });

    await expect(new CodexRuntime().dispatch(params({
      dispatchMode: 'ad-hoc',
      db: undefined,
      instanceId: undefined,
      runtimeBoundary: undefined,
      providerConnectionId: 91,
      runtimeConfig: {
        codexHome: providerHome,
        providerConnectionExternalRef: codexProviderHomeReference(providerHome),
        killGraceMs: 1_000,
      },
      onRuntimeEnd: resolveEnd,
    }))).resolves.toEqual({ runId: expect.stringMatching(/^codex:\d+$/) });

    const [, argv, options] = spawnMock.mock.calls[0];
    const adHocHome = (options!.env as NodeJS.ProcessEnv).CODEX_HOME!;
    expect(adHocHome).not.toBe(providerHome);
    expect(path.basename(adHocHome)).toMatch(/^[a-f0-9]{32}$/);
    expect(path.basename(path.dirname(adHocHome))).toBe('adhoc');
    expect(path.basename(path.dirname(path.dirname(adHocHome)))).toBe('codex');
    expect(path.dirname(path.dirname(path.dirname(adHocHome))))
      .toBe(path.resolve(process.env.AGENT_HQ_RUN_STATE_DIR!));
    expect(fs.statSync(adHocHome).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(path.join(adHocHome, 'auth.json')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(adHocHome, 'config.toml'))).toBe(false);
    expect(argv).not.toContain('--model');
    expect(argv).not.toContain('ambient-provider-model');
    expect(argv.some((value) => value.includes('model_reasoning_effort'))).toBe(false);
    expect(mockAssertRuntimeBoundaryAssignmentsCurrent).not.toHaveBeenCalled();
    child.emit('close', 0, null);
    // Leader exit alone must not remove a home descendants could still use.
    expect(fs.existsSync(adHocHome)).toBe(true);
    await ended;

    expect(mockCleanupOwnedProcessTree).toHaveBeenCalled();
    expect(fs.existsSync(adHocHome)).toBe(false);
  });

  it('retains an ad-hoc home when descendant process cleanup is not confirmed', async () => {
    const providerHome = path.join(root, 'quarantined-provider-home');
    fs.mkdirSync(providerHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(providerHome, 'auth.json'),
      `${JSON.stringify({ OPENAI_API_KEY: 'test-only-provider-credential' })}\n`,
      { mode: 0o600 },
    );
    mockCleanupOwnedProcessTree.mockResolvedValueOnce({
      confirmed: false,
      escalated: true,
      scope: 'process-group',
      error: 'group remained observable',
    });
    const onRuntimeEnd = jest.fn();

    await new CodexRuntime().dispatch(params({
      dispatchMode: 'ad-hoc',
      db: undefined,
      instanceId: undefined,
      runtimeBoundary: undefined,
      providerConnectionId: 91,
      runtimeConfig: {
        codexHome: providerHome,
        providerConnectionExternalRef: codexProviderHomeReference(providerHome),
        killGraceMs: 1_000,
      },
      onRuntimeEnd,
    }));
    const adHocHome = (spawnMock.mock.calls[0][2]!.env as NodeJS.ProcessEnv).CODEX_HOME!;

    child.emit('close', 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(fs.existsSync(adHocHome)).toBe(true);
    expect(onRuntimeEnd).not.toHaveBeenCalled();
  });

  it('rejects an unsupported Codex CLI before profile materialization or model spend', async () => {
    mockProbeRuntimeCliVersion.mockResolvedValueOnce({
      ok: false,
      version: 'codex-cli 0.147.0',
      executablePath: '/opt/agent-hq/bin/codex',
      executableFingerprint: 'sha256:test-codex-executable',
      message: 'codex-cli 0.147.0 is outside the verified range',
      details: {
        minimum_supported: '0.146.0',
        maximum_exclusive: '0.147.0',
        detected: '0.147.0',
        executable_path: '/opt/agent-hq/bin/codex',
        executable_fingerprint: 'sha256:test-codex-executable',
      },
    });

    await expect(new CodexRuntime().dispatch(params()))
      .rejects.toThrow(/CLI version verification failed.*outside the verified range/);
    expect(mockMaterializeMcp).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('requires the supported probe fingerprint to match the immutable boundary', async () => {
    const boundary = runtimeBoundary();
    boundary.runtime.executableFingerprint = 'sha256:dispatcher-selected-other-binary';

    await expect(new CodexRuntime().dispatch(params({ runtimeBoundary: boundary })))
      .rejects.toThrow(/fingerprint does not match the immutable runtime boundary/);
    expect(mockResolveRuntimeExecutable).not.toHaveBeenCalled();
    expect(mockMaterializeMcp).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('spawns only the canonical path returned by the supported version probe', async () => {
    const pathFromProbe = '/opt/version-checked/bin/codex';
    const fingerprintFromProbe = 'sha256:version-checked-codex';
    mockProbeRuntimeCliVersion.mockResolvedValueOnce({
      ok: true,
      version: 'codex-cli 0.146.0',
      executablePath: pathFromProbe,
      executableFingerprint: fingerprintFromProbe,
      message: 'supported',
      details: {
        minimum_supported: '0.146.0',
        maximum_exclusive: '0.147.0',
        detected: '0.146.0',
        executable_path: pathFromProbe,
        executable_fingerprint: fingerprintFromProbe,
      },
    });
    mockResolveRuntimeExecutable.mockReturnValueOnce({
      path: pathFromProbe,
      fingerprint: fingerprintFromProbe,
    });
    const boundary = runtimeBoundary();
    boundary.runtime.executableFingerprint = fingerprintFromProbe;

    await new CodexRuntime().dispatch(params({ runtimeBoundary: boundary }));

    expect(spawnMock).toHaveBeenCalledWith(pathFromProbe, expect.any(Array), expect.any(Object));
    child.emit('close', 0, null);
  });

  it('rejects an executable path or fingerprint that drifts after the version probe', async () => {
    mockResolveRuntimeExecutable.mockReturnValueOnce({
      path: '/opt/replaced/bin/codex',
      fingerprint: 'sha256:replacement-codex',
    });

    await expect(new CodexRuntime().dispatch(params()))
      .rejects.toThrow(/executable changed after version verification/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('revalidates immutable MCP and skill assignments immediately before spawn', async () => {
    mockAssertRuntimeBoundaryAssignmentsCurrent.mockRejectedValueOnce(
      new Error('Runtime MCP assignments changed after the dispatch boundary was created.'),
    );

    await expect(new CodexRuntime().dispatch(params()))
      .rejects.toThrow(/MCP assignments changed/);
    expect(mockAssertRuntimeBoundaryAssignmentsCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        boundary: expect.objectContaining({ version: 1 }),
        materializedMcpServerNames: [],
      }),
    );
    expect(mockResolveRuntimeExecutable).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects an unmanaged resume id before spawning a process', async () => {
    const runtime = new CodexRuntime();
    await expect(runtime.dispatch(params({
      runtimeConfig: { codexHomeRoot: root, resumeSessionId: 'untrusted-thread' },
    }))).rejects.toThrow('runtime_config.resumeSessionId cannot be used directly');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects before model spend when a required MCP lifecycle tool is missing', async () => {
    const server = { command: '/opt/agent-hq-mcp', args: ['--stdio'] };
    mockMaterializeMcp.mockResolvedValueOnce({
      codexHome: root,
      configPath: path.join(root, 'config.toml'),
      snapshotPath: path.join(root, 'agent-hq-mcp-servers.json'),
      serverNames: ['agent-hq__agent-42'],
      requiredServerNames: ['agent-hq__agent-42'],
      servers: { 'agent-hq__agent-42': server },
      warnings: [],
    });
    mockPreflight.mockResolvedValueOnce([{
      serverName: 'agent-hq__agent-42',
      ok: false,
      toolNames: ['agent_hq_start_task_run'],
      requiredToolNames: ['agent_hq_post_task_outcome', 'agent_hq_start_task_run'],
      missingToolNames: ['agent_hq_post_task_outcome'],
      error: 'server did not advertise required tool(s): agent_hq_post_task_outcome',
      durationMs: 2,
    }]);
    const boundary = runtimeBoundary() as any;
    boundary.tools.mcpServers = [{
      name: 'agent-hq__agent-42',
      configFingerprint: 'sha256:agent-hq',
      requiredToolNames: ['agent_hq_post_task_outcome', 'agent_hq_start_task_run'],
    }];
    boundary.tools.requiredLifecycleTools = [
      'agent_hq_post_task_outcome',
      'agent_hq_start_task_run',
    ];
    const db = {
      inTransaction: false,
      get: jest.fn(async () => ({ agent_id: 42, tenant_id: 2 })),
      all: jest.fn(async () => []),
      value: jest.fn(async () => undefined),
      run: jest.fn(async () => ({ changes: 1, lastInsertId: null })),
      exec: jest.fn(async () => undefined),
      withTransaction: jest.fn(),
      close: jest.fn(),
    };

    await expect(new CodexRuntime().dispatch(params({ db, runtimeBoundary: boundary })))
      .rejects.toThrow(/did not advertise required tool/);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(mockPreflight).toHaveBeenCalledWith(
      { 'agent-hq__agent-42': server },
      [{
        serverName: 'agent-hq__agent-42',
        requiredToolNames: ['agent_hq_post_task_outcome', 'agent_hq_start_task_run'],
      }],
    );
  });

  it('rejects ambient repository Codex config before materialization or spawn', async () => {
    const configDir = path.join(root, '.codex');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.toml'), [
      'sandbox_mode = "danger-full-access"',
      '[mcp_servers.attacker]',
      'command = "attacker-mcp"',
      '',
    ].join('\n'));

    await expect(new CodexRuntime().dispatch(params({ db: createRuntimeDb() })))
      .rejects.toThrow(/ambient project config|refuses ambient project config/);
    expect(mockMaterializeMcp).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rechecks project config after MCP preflight and closes the launch race', async () => {
    const server = { command: '/opt/agent-hq-mcp', args: ['--stdio'] };
    mockMaterializeMcp.mockResolvedValueOnce({
      codexHome: root,
      configPath: path.join(root, 'profile.config.toml'),
      snapshotPath: path.join(root, 'snapshot.json'),
      serverNames: ['agent-hq__agent-42'],
      requiredServerNames: ['agent-hq__agent-42'],
      servers: { 'agent-hq__agent-42': server },
      warnings: [],
    });
    mockPreflight.mockImplementationOnce(async () => {
      const configDir = path.join(root, '.codex');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'config.toml'), '[mcp_servers.race]\ncommand = "race"\n');
      return [];
    });
    const boundary = runtimeBoundary() as any;
    boundary.tools.mcpServers = [{
      name: 'agent-hq__agent-42',
      configFingerprint: 'sha256:agent-hq',
      requiredToolNames: ['agent_hq_start_task_run'],
    }];
    boundary.tools.requiredLifecycleTools = ['agent_hq_start_task_run'];

    await expect(new CodexRuntime().dispatch(params({
      db: createRuntimeDb(),
      runtimeBoundary: boundary,
    }))).rejects.toThrow(/ambient project config/);
    expect(mockPreflight).toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects before model spend when lifecycle policy has no materialized Agent HQ server', async () => {
    const db = createRuntimeDb();
    const boundary = runtimeBoundary() as any;
    boundary.tools.mcpServers = [{
      name: 'agent-hq__agent-42',
      configFingerprint: 'sha256:agent-hq',
      requiredToolNames: ['agent_hq_start_task_run'],
    }];
    boundary.tools.requiredLifecycleTools = ['agent_hq_start_task_run'];

    await expect(new CodexRuntime().dispatch(params({ db, runtimeBoundary: boundary })))
      .rejects.toThrow(/Materialized MCP servers do not exactly match the runtime boundary/);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(mockPreflight).not.toHaveBeenCalled();
  });

  it('keeps provider auth in the canonical home but selects an isolated runtime profile', async () => {
    const providerHome = path.join(root, 'provider-home');
    fs.mkdirSync(providerHome, { recursive: true });
    const db = createRuntimeDb();

    await new CodexRuntime().dispatch(params({
      db,
      providerConnectionId: 91,
      runtimeConfig: {
        codexHome: providerHome,
        providerConnectionExternalRef: codexProviderHomeReference(providerHome),
      },
    }));

    const [, argv, options] = spawnMock.mock.calls[0];
    const profileIndex = argv.indexOf('--profile');
    expect(profileIndex).toBeGreaterThan(0);
    const profileName = argv[profileIndex + 1];
    expect(profileName).toMatch(/^agent-hq-runtime-7-/);
    expect((options!.env as NodeJS.ProcessEnv).CODEX_HOME).toBe(providerHome);
    expect(fs.existsSync(path.join(providerHome, 'config.toml'))).toBe(false);
    expect(mockMaterializeMcp).toHaveBeenCalledWith(expect.objectContaining({
      codexHome: providerHome,
      configPath: path.join(providerHome, `${profileName}.config.toml`),
      snapshotPath: expect.stringContaining(path.join('tenant-2', 'agent-42')),
      preserveExistingConfig: false,
    }));
    const materializeInput = mockMaterializeMcp.mock.calls[0][0];
    expect(materializeInput.snapshotPath?.startsWith(`${providerHome}${path.sep}`)).toBe(false);

    child.emit('close', 0, null);
  });

  it('rejects a provider home whose base config could merge unassigned tools', async () => {
    const providerHome = path.join(root, 'provider-home');
    fs.mkdirSync(providerHome, { recursive: true });
    fs.writeFileSync(
      path.join(providerHome, 'config.toml'),
      '[mcp_servers.personal]\ncommand = "personal"\n',
      { mode: 0o600 },
    );
    await expect(new CodexRuntime().dispatch(params({
      db: createRuntimeDb(),
      providerConnectionId: 91,
      runtimeConfig: {
        codexHome: providerHome,
        providerConnectionExternalRef: codexProviderHomeReference(providerHome),
      },
    }))).rejects.toThrow(/strict operator allowlist/);
    expect(mockMaterializeMcp).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    ['model = "ambient-model"\n', /model is not overridden/],
    ['model_reasoning_effort = "xhigh"\n', /reasoning effort is not overridden/],
  ])('does not inherit omitted dispatch policy from operator config', async (contents, error) => {
    const providerHome = path.join(root, 'provider-home');
    fs.mkdirSync(providerHome, { recursive: true });
    fs.writeFileSync(path.join(providerHome, 'config.toml'), contents, { mode: 0o600 });

    await expect(new CodexRuntime().dispatch(params({
      db: createRuntimeDb(),
      providerConnectionId: 91,
      runtimeConfig: {
        codexHome: providerHome,
        providerConnectionExternalRef: codexProviderHomeReference(providerHome),
      },
    }))).rejects.toThrow(error);
    expect(mockMaterializeMcp).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('accepts an operator base config while pinning its execution policy in argv', async () => {
    const providerHome = path.join(root, 'provider-home');
    fs.mkdirSync(providerHome, { recursive: true });
    fs.writeFileSync(path.join(providerHome, 'config.toml'), [
      'model = "operator-model"',
      'model_reasoning_effort = "low"',
      'service_tier = "fast"',
      '[projects."/work/repo"]',
      'trust_level = "trusted"',
      '[plugins."github@openai-curated"]',
      'enabled = true',
      '',
    ].join('\n'));

    await new CodexRuntime().dispatch(params({
      db: createRuntimeDb(),
      model: 'openai/gpt-5.5',
      thinking: 'high',
      fastMode: false,
      providerConnectionId: 91,
      runtimeConfig: {
        codexHome: providerHome,
        providerConnectionExternalRef: codexProviderHomeReference(providerHome),
      },
    }));

    const argv = spawnMock.mock.calls[0][1];
    expect(argv).toEqual(expect.arrayContaining([
      '--model', 'gpt-5.5',
      '-c', 'model_reasoning_effort="high"',
      '-c', 'service_tier="default"',
      '--disable', 'plugins',
    ]));
    child.emit('close', 0, null);
  });

  it('derives managed homes from tenant and agent identity, not a shared slug', async () => {
    const firstChild = child;
    const firstBoundary = runtimeBoundary();
    firstBoundary.identity.tenantId = 1;
    firstBoundary.identity.agentSlug = 'same-slug';
    await new CodexRuntime().dispatch(params({
      db: createRuntimeDb({ tenantId: 1, agentId: 42 }),
      instanceId: 7,
      agentSlug: 'same-slug',
      runtimeBoundary: firstBoundary,
    }));
    const firstHome = (spawnMock.mock.calls[0][2]!.env as NodeJS.ProcessEnv).CODEX_HOME;
    firstChild.emit('close', 0, null);
    await new Promise((resolve) => setImmediate(resolve));

    child = new MockChild();
    const secondBoundary = runtimeBoundary();
    secondBoundary.identity.instanceId = 8;
    secondBoundary.identity.agentSlug = 'same-slug';
    await new CodexRuntime().dispatch(params({
      db: createRuntimeDb({ tenantId: 2, agentId: 42 }),
      instanceId: 8,
      agentSlug: 'same-slug',
      runtimeBoundary: secondBoundary,
    }));
    const secondHome = (spawnMock.mock.calls[1][2]!.env as NodeJS.ProcessEnv).CODEX_HOME;

    expect(firstHome).toContain(path.join('tenant-1', 'agent-42'));
    expect(secondHome).toContain(path.join('tenant-2', 'agent-42'));
    expect(firstHome).not.toBe(secondHome);
    child.emit('close', 0, null);
  });

  it('scavenges an expired crash-left profile before spawning', async () => {
    const managedHome = path.join(root, 'codex', 'tenant-2', 'agent-42');
    fs.mkdirSync(managedHome, { recursive: true });
    const stalePath = path.join(
      managedHome,
      'agent-hq-runtime-99-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.config.toml',
    );
    fs.writeFileSync(stalePath, '# stale MCP credential\n', { mode: 0o600 });
    const old = new Date(Date.now() - DEFAULT_CODEX_STALE_PROFILE_TTL_MS - 1_000);
    fs.utimesSync(stalePath, old, old);

    await new CodexRuntime().dispatch(params({ db: createRuntimeDb() }));
    expect(fs.existsSync(stalePath)).toBe(false);
    child.emit('close', 0, null);
  });

  it('skips profile scavenging when durable active-run lookup fails', async () => {
    const managedHome = path.join(root, 'codex', 'tenant-2', 'agent-42');
    fs.mkdirSync(managedHome, { recursive: true });
    const stalePath = path.join(
      managedHome,
      'agent-hq-runtime-99-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.config.toml',
    );
    fs.writeFileSync(stalePath, '# possibly active MCP credential\n', { mode: 0o600 });
    const old = new Date(Date.now() - DEFAULT_CODEX_STALE_PROFILE_TTL_MS - 1_000);
    fs.utimesSync(stalePath, old, old);
    const db = createRuntimeDb();
    db.all.mockRejectedValueOnce(new Error('transient runtime execution lookup failure'));

    await new CodexRuntime().dispatch(params({ db }));

    expect(db.all).toHaveBeenCalledWith(expect.stringContaining('FROM runtime_executions'));
    expect(fs.existsSync(stalePath)).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    child.emit('close', 0, null);
  });

  it('retries ephemeral profile cleanup after an unlink failure', async () => {
    mockMaterializeMcp.mockImplementationOnce(async ({
      codexHome,
      configPath,
      snapshotPath,
    }: { codexHome: string; configPath?: string; snapshotPath?: string }) => {
      fs.writeFileSync(configPath!, '# MCP credential\n', { mode: 0o600 });
      return {
        codexHome,
        configPath: configPath!,
        snapshotPath: snapshotPath!,
        serverNames: [],
        requiredServerNames: [],
        servers: {},
        warnings: [],
      };
    });
    await new CodexRuntime().dispatch(params({ db: createRuntimeDb() }));
    const profilePath = mockMaterializeMcp.mock.calls[0][0].configPath!;
    const realUnlink = fs.unlinkSync.bind(fs);
    const unlink = jest.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      const error = new Error('transient unlink denial') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    });
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    child.emit('error', new Error('late child error'));
    expect(fs.existsSync(profilePath)).toBe(true);
    unlink.mockImplementation(realUnlink);
    child.emit('close', 1, null);
    expect(fs.existsSync(profilePath)).toBe(false);
    expect(unlink).toHaveBeenCalledTimes(2);

    warning.mockRestore();
    unlink.mockRestore();
  });

  it('dispatches through managed CODEX_HOME, persists thread/usage/end, and emits one runtime end', async () => {
    const db = createRuntimeDb();
    const { runs } = db;
    let resolveEnd!: (value: any) => void;
    const ended = new Promise<any>((resolve) => { resolveEnd = resolve; });
    const runtime = new CodexRuntime();
    await expect(runtime.dispatch(params({
      db,
      model: 'openai/gpt-5.5',
      thinking: 'high',
      durableRunId: 'run-7',
      runtimeBoundary: runtimeBoundary(),
      onRuntimeEnd: resolveEnd,
    }))).resolves.toEqual({ runId: 'codex:7' });

    const [, argv, options] = spawnMock.mock.calls[0];
    expect(argv).toContain('gpt-5.5');
    expect(argv).not.toContain('openai/gpt-5.5');
    expect((options!.env as NodeJS.ProcessEnv).CODEX_HOME).toContain(path.join(root, 'codex'));
    expect(fs.statSync((options!.env as NodeJS.ProcessEnv).CODEX_HOME!).mode & 0o777).toBe(0o700);
    expect(child.prompt).toBe('Implement the task.');
    expect(persistStart).toHaveBeenCalledWith(db, expect.objectContaining({
      driver: 'codex',
      backend: 'local-process',
      boundary: expect.objectContaining({ version: 1 }),
      handle: expect.objectContaining({ kind: 'local-process', pid: 43_210 }),
      launchSpec: expect.objectContaining({
        command: '/opt/agent-hq/bin/codex',
        executableFingerprint: 'sha256:test-codex-executable',
        cwd: root,
      }),
    }));

    child.stdout.write('{"type":"thread.started","thread_id":"thread-123"}\n');
    child.stdout.write('{"type":"item.completed","item":{"id":"a","type":"agent_message","text":"Done."}}\n');
    child.stdout.write('{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":4}}\n');
    child.emit('close', 0, null);
    const event = await ended;

    expect(event).toMatchObject({ success: true, source: 'codex', reason: 'completed' });
    expect(event.metadata).toMatchObject({ codex_thread_id: 'thread-123', cached_input_tokens: 2 });
    expect(runs.some((entry) => entry.values[0] === 'codex:thread-123')).toBe(true);
    expect(runs.some((entry) => entry.sql.includes('SET token_input') && entry.values[0] === 10)).toBe(true);
    expect(runs.some((entry) => entry.sql.includes("'turn_end'"))).toBe(true);
    expect(applyEnd).toHaveBeenCalledTimes(1);
    expect(persistHeartbeat).toHaveBeenCalledWith(db, {
      instanceId: 7,
      tenantId: 2,
      sessionId: 'thread-123',
    });
    expect(appendCheckpoint).toHaveBeenCalledWith(db, expect.objectContaining({
      executionId: 91,
      kind: 'session',
      sessionId: 'thread-123',
    }));
    expect(persistTerminal).toHaveBeenCalledWith(db, expect.objectContaining({
      instanceId: 7,
      state: 'succeeded',
    }));
  });

  it('still delivers runtime end when the job projection transiently fails after durable terminal state', async () => {
    const db = createRuntimeDb();
    applyEnd.mockRejectedValueOnce(new Error('job projection unavailable'));
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let resolveEnd!: (value: any) => void;
    const ended = new Promise<any>((resolve) => { resolveEnd = resolve; });

    await new CodexRuntime().dispatch(params({
      db,
      runtimeBoundary: runtimeBoundary(),
      onRuntimeEnd: resolveEnd,
    }));
    child.stdout.write('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n');
    child.emit('close', 0, null);

    await expect(ended).resolves.toMatchObject({ success: true, reason: 'completed' });
    expect(persistTerminal).toHaveBeenCalledWith(db, expect.objectContaining({
      instanceId: 7,
      state: 'succeeded',
    }));
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('failed to project runtime terminal state'),
      'job projection unavailable',
    );
    warning.mockRestore();
  });

  it('contains terminal callback rejection inside the detached monitor', async () => {
    const callback = jest.fn(async () => { throw new Error('consumer unavailable'); });
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await new CodexRuntime().dispatch(params({
      db: createRuntimeDb(),
      runtimeBoundary: runtimeBoundary(),
      onRuntimeEnd: callback,
    }));
    child.emit('close', 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(callback).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      '[CodexRuntime] runtime-end callback failed:',
      'consumer unavailable',
    );
    expect(error).not.toHaveBeenCalledWith(
      '[CodexRuntime] unhandled monitor error',
      expect.anything(),
    );
    warning.mockRestore();
    error.mockRestore();
  });

  it('terminates before writing the prompt when durable execution start is unavailable', async () => {
    const db = createRuntimeDb();
    persistStart.mockResolvedValueOnce({
      status: 'unavailable',
      executionId: null,
      checkpointId: null,
      sequence: null,
      idempotent: false,
    });
    const runtime = new CodexRuntime();

    await expect(runtime.dispatch(params({
      db,
      runtimeBoundary: runtimeBoundary(),
    }))).rejects.toThrow(/refused to start without durable execution state/);

    expect(child.prompt).toBe('');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(appendCheckpoint).not.toHaveBeenCalled();
    child.emit('close', null, 'SIGTERM');
  });

  it('keeps monitor cleanup ownership when prompt delivery throws after durable launch', async () => {
    child.stdin.end = jest.fn(() => {
      throw new Error('synchronous stdin failure');
    }) as never;

    await expect(new CodexRuntime().dispatch(params({
      db: createRuntimeDb(),
      runtimeBoundary: runtimeBoundary(),
    }))).rejects.toThrow(/prompt delivery failed.*synchronous stdin failure/);

    expect(persistStart).toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null, 'SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockCleanupOwnedProcessTree).toHaveBeenCalledWith(expect.objectContaining({
      child,
    }));
  });

  it('terminates before writing the prompt when process birth identity is unavailable', async () => {
    const db = createRuntimeDb();
    processIdentity.mockReturnValueOnce(null);

    await expect(new CodexRuntime().dispatch(params({
      db,
      runtimeBoundary: runtimeBoundary(),
    }))).rejects.toThrow(/birth identity/);

    expect(child.prompt).toBe('');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(persistStart).not.toHaveBeenCalled();
    child.emit('close', null, 'SIGTERM');
  });

  it('handles thread heartbeat rejection immediately and reports a failed runtime end', async () => {
    const db = createRuntimeDb();
    persistHeartbeat.mockRejectedValueOnce(new Error('heartbeat write failed'));
    let resolveEnd!: (value: any) => void;
    const ended = new Promise<any>((resolve) => { resolveEnd = resolve; });
    const runtime = new CodexRuntime();

    await runtime.dispatch(params({
      db,
      runtimeBoundary: runtimeBoundary(),
      onRuntimeEnd: resolveEnd,
    }));
    child.stdout.write('{"type":"thread.started","thread_id":"thread-failure"}\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null, 'SIGTERM');
    const event = await ended;

    expect(event).toMatchObject({ success: false, source: 'codex', reason: 'error' });
    expect(event.error).toContain('Codex thread durability failed');
    expect(event.error).toContain('heartbeat write failed');
    expect(appendCheckpoint).not.toHaveBeenCalledWith(
      db,
      expect.objectContaining({ kind: 'session' }),
    );
    expect(persistTerminal).toHaveBeenCalledWith(db, expect.objectContaining({
      instanceId: 7,
      state: 'failed',
      error: expect.stringContaining('heartbeat write failed'),
    }));
  });

  it('can abort from a separately resolved runtime and reports missing targets truthfully', async () => {
    const starter = new CodexRuntime();
    await starter.dispatch(params({ db: createRuntimeDb() }));
    const stopper = new CodexRuntime();
    await expect(stopper.abort('codex:7', '')).resolves.toMatchObject({
      status: 'signalled',
      ok: true,
      confirmed: false,
    });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null, 'SIGTERM');

    await expect(stopper.abort('codex:999', '')).resolves.toMatchObject({
      status: 'not_found',
      ok: false,
      confirmed: false,
    });
  });

  it('does not terminalize when descendant process-group cleanup cannot be confirmed', async () => {
    mockCleanupOwnedProcessTree.mockResolvedValueOnce({
      confirmed: false,
      escalated: true,
      scope: 'process-group',
      error: 'group remained observable',
    });
    const db = createRuntimeDb();
    const onRuntimeEnd = jest.fn();
    await new CodexRuntime().dispatch(params({
      db,
      runtimeBoundary: runtimeBoundary(),
      onRuntimeEnd,
    }));

    child.stdout.write('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n');
    child.emit('close', 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(persistTerminal).not.toHaveBeenCalled();
    expect(applyEnd).not.toHaveBeenCalled();
    expect(onRuntimeEnd).not.toHaveBeenCalled();
  });
});
