/**
 * Tests for the run-scoped Claude Code MCP config materializer.
 *
 * `fetchAssignedMcpServers` is stubbed because it is the DB boundary of this unit:
 * exercising it for real would mean simulating the whole mcp_api_keys + tenants
 * schema, and the guarantee under test is precisely WHAT this module hands it (a
 * reconstructed API-key-only reuse input) rather than what it does with a live database.
 * `resolveMcpServerRuntimePaths` is deliberately left real.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { type Db } from '../../db/adapter/types';
import { fetchAssignedMcpServers } from '../mcpMaterialization';
import {
  CLAUDE_CODE_MCP_CREDENTIAL_SNAPSHOT_FILENAME,
  CLAUDE_CODE_MCP_RUN_CONFIG_PREFIX,
  DEFAULT_CLAUDE_CODE_MCP_STALE_CONFIG_TTL_MS,
  cleanupClaudeCodeMcpRunConfig,
  materializeClaudeCodeMcpConfig,
  readPreviousRunServers,
  resolveClaudeCodeAgentStateDir,
  resolveClaudeCodeMcpRunConfigPath,
  scavengeStaleClaudeCodeMcpRunConfigs,
} from './mcpConfig';
import { NO_ALLOWED_MCP_TOOLS_SENTINEL } from './types';

jest.mock('../mcpMaterialization', () => ({
  ...jest.requireActual('../mcpMaterialization'),
  fetchAssignedMcpServers: jest.fn(),
}));

const fetchAssignedMcpServersMock = fetchAssignedMcpServers as jest.MockedFunction<
  typeof fetchAssignedMcpServers
>;

type ServerMap = Record<string, Record<string, unknown>>;

function createMockDb(): Db {
  const db: Record<string, unknown> = {
    dialect: 'sqlite',
    inTransaction: false,
    get: jest.fn(async () => undefined),
    all: jest.fn(async () => []),
    value: jest.fn(async () => undefined),
    run: jest.fn(async () => ({ changes: 0, lastInsertId: null })),
    exec: jest.fn(async () => undefined),
    withTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    close: jest.fn(async () => undefined),
  };
  return db as unknown as Db;
}

/**
 * The Agent HQ lifecycle server as the materializer emits it: no toolFilter, and an
 * API key in env. Deliberately NOT the `node <dist>/mcp/server.js` shape, because
 * resolveAgentHqServerRuntimePaths rewrites that against __dirname — which points at
 * src/ under jest and would make the assertions depend on a nonexistent path.
 */
function agentHqServer(apiKey = 'ahq_mcp_first'): Record<string, unknown> {
  return {
    command: '/opt/agent-hq/bin/agent-hq-mcp',
    args: ['--stdio'],
    env: { AGENT_HQ_MCP_API_KEY: apiKey, AGENT_HQ_API_URL: 'http://127.0.0.1:3501' },
    cwd: '/opt/agent-hq',
  };
}

function filteredServer(include: string[]): Record<string, unknown> {
  return {
    command: '/usr/local/bin/linear-mcp',
    env: { LINEAR_API_KEY: 'lin_test' },
    toolFilter: { include },
    agentHqAssignment: {
      id: 91,
      mcpServerSlug: 'linear',
      toolAllowlist: { source: 'assignment_override', malformed: false, count: include.length, tools: include },
    },
  };
}

let stateDir: string;
let dbMock: Db;
let runCounter: number;
const originalRunStateDir = process.env.AGENT_HQ_RUN_STATE_DIR;
const TENANT_ID = 7;
const AGENT_ID = 42;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mcp-config-test-'));
  dbMock = createMockDb();
  runCounter = 0;
  fetchAssignedMcpServersMock.mockReset();
  process.env.AGENT_HQ_RUN_STATE_DIR = stateDir;
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  if (originalRunStateDir === undefined) delete process.env.AGENT_HQ_RUN_STATE_DIR;
  else process.env.AGENT_HQ_RUN_STATE_DIR = originalRunStateDir;
});

function agentStateDir(): string {
  return resolveClaudeCodeAgentStateDir(TENANT_ID, AGENT_ID);
}

function materialize(servers: ServerMap, runKey = `run-${++runCounter}`, instanceId = 8801) {
  fetchAssignedMcpServersMock.mockResolvedValue(servers);
  return materializeClaudeCodeMcpConfig({
    db: dbMock,
    tenantId: TENANT_ID,
    agentId: AGENT_ID,
    instanceId,
    runKey,
    protectedInstanceIds: new Set(),
  });
}

function readWrittenConfig(configPath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

describe('materializeClaudeCodeMcpConfig — toolFilter translation', () => {
  it('translates toolFilter.include into fully-qualified mcp__ tool names', async () => {
    const result = await materialize({
      'linear__agent-42': filteredServer(['issue_create', 'issue_update']),
    });

    expect(result.allowedToolNames).toEqual([
      'mcp__linear__agent-42__issue_create',
      'mcp__linear__agent-42__issue_update',
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('drops the fail-closed sentinel and warns, naming the server', async () => {
    const result = await materialize({
      'linear__agent-42': filteredServer([NO_ALLOWED_MCP_TOOLS_SENTINEL]),
    });

    expect(result.allowedToolNames).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('linear__agent-42');
    expect(result.warnings.join('\n')).not.toContain(NO_ALLOWED_MCP_TOOLS_SENTINEL);
  });

  it('treats a malformed include as zero tools rather than as unrestricted', async () => {
    const result = await materialize({
      'linear__agent-42': { command: '/usr/local/bin/linear-mcp', toolFilter: { include: 'issue_create' } },
    });

    expect(result.allowedToolNames).toEqual([]);
    expect(result.warnings[0]).toContain('linear__agent-42');
  });

  it('grants a server without toolFilter.include through Claude\'s documented MCP wildcard', async () => {
    const result = await materialize({ 'agent-hq__agent-42': agentHqServer() });

    expect(result.allowedToolNames).toEqual(['mcp__agent-hq__agent-42__*']);
    expect(result.warnings).toEqual([
      'MCP server "agent-hq__agent-42" has no toolFilter.include; its assigned tool surface is granted with mcp__agent-hq__agent-42__*.',
    ]);
  });

  it('mixes an unrestricted lifecycle server with an allowlisted one', async () => {
    const result = await materialize({
      'agent-hq__agent-42': agentHqServer(),
      'linear__agent-42': filteredServer(['issue_create']),
    });

    expect(result.serverNames).toEqual(['agent-hq__agent-42', 'linear__agent-42']);
    expect(result.allowedToolNames).toEqual([
      'mcp__agent-hq__agent-42__*',
      'mcp__linear__agent-42__issue_create',
    ]);
    expect(result.warnings).toHaveLength(1);
  });
});

describe('materializeClaudeCodeMcpConfig — written file', () => {
  it('strips Agent HQ bookkeeping keys and keeps command/args/env/cwd', async () => {
    const result = await materialize({
      'agent-hq__agent-42': agentHqServer(),
      'linear__agent-42': filteredServer(['issue_create']),
    });

    const written = readWrittenConfig(result.configPath!);
    expect(Object.keys(written.mcpServers).sort()).toEqual(['agent-hq__agent-42', 'linear__agent-42']);
    expect(written.mcpServers['linear__agent-42']).toEqual({
      command: '/usr/local/bin/linear-mcp',
      env: { LINEAR_API_KEY: 'lin_test' },
    });
    expect(written.mcpServers['agent-hq__agent-42']).toEqual({
      command: '/opt/agent-hq/bin/agent-hq-mcp',
      args: ['--stdio'],
      env: { AGENT_HQ_MCP_API_KEY: 'ahq_mcp_first', AGENT_HQ_API_URL: 'http://127.0.0.1:3501' },
      cwd: '/opt/agent-hq',
    });
    expect(JSON.stringify(written)).not.toContain('toolFilter');
    expect(JSON.stringify(written)).not.toContain('agentHqAssignment');
  });

  it('records the managed server names at the top level', async () => {
    const result = await materialize({ 'agent-hq__agent-42': agentHqServer() });

    expect(readWrittenConfig(result.configPath!).agentHqManagedMcpServers).toEqual(['agent-hq__agent-42']);
  });

  it('writes the config 0600 because it embeds AGENT_HQ_MCP_API_KEY', async () => {
    const result = await materialize({ 'agent-hq__agent-42': agentHqServer() });

    expect(path.dirname(result.configPath!)).toBe(agentStateDir());
    expect(path.basename(result.configPath!)).toMatch(
      new RegExp(`^${CLAUDE_CODE_MCP_RUN_CONFIG_PREFIX}8801-[a-f0-9]{24}\\.json$`),
    );
    expect(fs.statSync(result.configPath!).mode & 0o777).toBe(0o600);
  });

  it('creates the tenant/agent state dir when it does not exist yet', async () => {
    fetchAssignedMcpServersMock.mockResolvedValue({ 'agent-hq__agent-42': agentHqServer() });

    const result = await materializeClaudeCodeMcpConfig({
      db: dbMock,
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      instanceId: 8801,
      runKey: 'nested-state',
      protectedInstanceIds: new Set(),
    });

    expect(path.dirname(result.configPath!)).toBe(agentStateDir());
    expect(fs.existsSync(result.configPath!)).toBe(true);
    expect(fs.statSync(agentStateDir()).mode & 0o777).toBe(0o700);
  });

  it('writes nothing and returns a null configPath when no servers are assigned', async () => {
    const result = await materialize({});

    expect(result).toEqual({
      configPath: null,
      serverNames: [],
      requiredServerNames: [],
      allowedToolNames: [],
      warnings: [],
    });
    expect(fs.readdirSync(agentStateDir())).toEqual([]);
  });

  it('applies the shared runtime path passes to cwd-relative commands', async () => {
    const result = await materialize({
      'dev-environment-lease-manager__agent-42': {
        command: '.venv/bin/dev-env-lease-mcp',
        args: ['config/environments.json', 'stdio'],
        cwd: '/srv/lease-manager',
      },
    });

    const server = readWrittenConfig(result.configPath!).mcpServers['dev-environment-lease-manager__agent-42'];
    expect(server.command).toBe('/srv/lease-manager/.venv/bin/dev-env-lease-mcp');
    expect(server.args).toEqual(['/srv/lease-manager/config/environments.json', 'stdio']);
  });
});

describe('materializeClaudeCodeMcpConfig — requiredServerNames', () => {
  it('selects the agent-hq server by slug despite the __agent-<id> suffix', async () => {
    const result = await materialize({
      'agent-hq__agent-42': agentHqServer(),
      'agent-hq-notifier__agent-42': filteredServer(['notify']),
      'linear__agent-42': filteredServer(['issue_create']),
    });

    expect(result.requiredServerNames).toEqual(['agent-hq__agent-42']);
  });

  it('matches an unsuffixed agent-hq server name too', async () => {
    const result = await materialize({ 'agent-hq': agentHqServer() });

    expect(result.requiredServerNames).toEqual(['agent-hq']);
  });
});

describe('materializeClaudeCodeMcpConfig — API key carry-forward', () => {
  it('reads only the reusable API key snapshot and passes no third-party server state through', async () => {
    const first = await materialize({ 'agent-hq__agent-42': agentHqServer('ahq_mcp_first') });
    expect(first.configPath).not.toBeNull();

    const snapshotPath = path.join(
      agentStateDir(),
      CLAUDE_CODE_MCP_CREDENTIAL_SNAPSHOT_FILENAME,
    );
    expect(JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))).toEqual({
      version: 1,
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      AGENT_HQ_MCP_API_KEY: 'ahq_mcp_first',
    });
    expect(fs.statSync(snapshotPath).mode & 0o777).toBe(0o600);

    fetchAssignedMcpServersMock.mockClear();
    await materialize({ 'agent-hq__agent-42': agentHqServer('ahq_mcp_first') });

    expect(fetchAssignedMcpServersMock).toHaveBeenCalledTimes(1);
    const [db, agentId, existingServers] = fetchAssignedMcpServersMock.mock.calls[0];
    expect(db).toBe(dbMock);
    expect(agentId).toBe(42);
    expect((existingServers as ServerMap)['agent-hq__agent-42'].env).toEqual({
      AGENT_HQ_MCP_API_KEY: 'ahq_mcp_first',
    });
    expect(JSON.stringify(existingServers)).not.toContain('AGENT_HQ_API_URL');
  });

  it('rewrites a snapshot to the minimal schema and never retains unrelated secrets', async () => {
    fs.mkdirSync(agentStateDir(), { recursive: true });
    const snapshotPath = path.join(agentStateDir(), CLAUDE_CODE_MCP_CREDENTIAL_SNAPSHOT_FILENAME);
    fs.writeFileSync(snapshotPath, JSON.stringify({
      version: 1,
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      AGENT_HQ_MCP_API_KEY: 'ahq_mcp_reused',
      LINEAR_API_KEY: 'must-not-survive',
      mcpServers: { thirdParty: { env: { TOKEN: 'must-not-survive' } } },
    }));

    await materialize({ 'agent-hq__agent-42': agentHqServer('ahq_mcp_reused') });
    expect(JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))).toEqual({
      version: 1,
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      AGENT_HQ_MCP_API_KEY: 'ahq_mcp_reused',
    });
  });

  it('passes an empty map when there is no previous run', async () => {
    await materialize({ 'agent-hq__agent-42': agentHqServer() });

    const [, , existingServers] = fetchAssignedMcpServersMock.mock.calls[0];
    expect(existingServers).toEqual({});
  });

  it('rejects a snapshot whose embedded tenant or agent identity does not match its path', async () => {
    fs.mkdirSync(agentStateDir(), { recursive: true });
    fs.writeFileSync(
      path.join(agentStateDir(), CLAUDE_CODE_MCP_CREDENTIAL_SNAPSHOT_FILENAME),
      JSON.stringify({
        version: 1,
        tenantId: TENANT_ID + 1,
        agentId: AGENT_ID,
        AGENT_HQ_MCP_API_KEY: 'cross-tenant-key',
      }),
      { mode: 0o600 },
    );

    await materialize({ 'agent-hq__agent-42': agentHqServer('replacement-key') });

    expect(fetchAssignedMcpServersMock.mock.calls[0][2]).toEqual({});
    expect(JSON.stringify(fetchAssignedMcpServersMock.mock.calls[0][2]))
      .not.toContain('cross-tenant-key');
  });
});

describe('materializeClaudeCodeMcpConfig — concurrent run isolation', () => {
  it('writes distinct immutable files and shares only the reusable Agent HQ key', async () => {
    fetchAssignedMcpServersMock
      .mockResolvedValueOnce({
        'agent-hq__agent-42': agentHqServer('ahq_mcp_shared'),
        'linear__agent-42': {
          ...filteredServer(['issue_create']),
          env: { LINEAR_API_KEY: 'linear-run-one' },
        },
      })
      .mockResolvedValueOnce({
        'agent-hq__agent-42': agentHqServer('ahq_mcp_shared'),
        'linear__agent-42': {
          ...filteredServer(['issue_create']),
          env: { LINEAR_API_KEY: 'linear-run-two' },
        },
      });

    const [first, second] = await Promise.all([
      materializeClaudeCodeMcpConfig({
        db: dbMock,
        tenantId: TENANT_ID,
        agentId: AGENT_ID,
        instanceId: 8801,
        runKey: 'concurrent-one',
        protectedInstanceIds: new Set([8801, 8802]),
      }),
      materializeClaudeCodeMcpConfig({
        db: dbMock,
        tenantId: TENANT_ID,
        agentId: AGENT_ID,
        instanceId: 8802,
        runKey: 'concurrent-two',
        protectedInstanceIds: new Set([8801, 8802]),
      }),
    ]);

    expect(first.configPath).not.toBe(second.configPath);
    expect(readWrittenConfig(first.configPath!).mcpServers['linear__agent-42'].env)
      .toEqual({ LINEAR_API_KEY: 'linear-run-one' });
    expect(readWrittenConfig(second.configPath!).mcpServers['linear__agent-42'].env)
      .toEqual({ LINEAR_API_KEY: 'linear-run-two' });

    const secondExistingServers = fetchAssignedMcpServersMock.mock.calls[1][2] as ServerMap;
    expect(secondExistingServers['agent-hq__agent-42'].env).toEqual({
      AGENT_HQ_MCP_API_KEY: 'ahq_mcp_shared',
    });
    expect(JSON.stringify(secondExistingServers)).not.toContain('LINEAR_API_KEY');
  });

  it('never carries a credential snapshot across tenant identity', async () => {
    fetchAssignedMcpServersMock
      .mockResolvedValueOnce({ 'agent-hq__agent-42': agentHqServer('tenant-seven-key') })
      .mockResolvedValueOnce({ 'agent-hq__agent-42': agentHqServer('tenant-eight-key') });

    await materializeClaudeCodeMcpConfig({
      db: dbMock,
      tenantId: 7,
      agentId: AGENT_ID,
      instanceId: 7001,
      runKey: 'tenant-seven',
      protectedInstanceIds: new Set(),
    });
    await materializeClaudeCodeMcpConfig({
      db: dbMock,
      tenantId: 8,
      agentId: AGENT_ID,
      instanceId: 8001,
      runKey: 'tenant-eight',
      protectedInstanceIds: new Set(),
    });

    expect(fetchAssignedMcpServersMock.mock.calls[1][2]).toEqual({});
    expect(resolveClaudeCodeAgentStateDir(7, AGENT_ID))
      .not.toBe(resolveClaudeCodeAgentStateDir(8, AGENT_ID));
  });

  it('propagates MCP assignment/materialization errors without writing an empty config', async () => {
    fetchAssignedMcpServersMock.mockRejectedValue(new Error('MCP assignment lookup failed'));

    await expect(materializeClaudeCodeMcpConfig({
      db: dbMock,
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      instanceId: 8801,
      runKey: 'fatal-fetch',
      protectedInstanceIds: new Set(),
    })).rejects.toThrow('MCP assignment lookup failed');
    expect(fs.readdirSync(agentStateDir())).toEqual([]);
  });
});

describe('Claude MCP run-config cleanup', () => {
  it('removes exactly the completed run config while preserving the reusable snapshot', async () => {
    const result = await materialize({ 'agent-hq__agent-42': agentHqServer() });
    const snapshotPath = path.join(agentStateDir(), CLAUDE_CODE_MCP_CREDENTIAL_SNAPSHOT_FILENAME);

    cleanupClaudeCodeMcpRunConfig(result.configPath);

    expect(fs.existsSync(result.configPath!)).toBe(false);
    expect(fs.existsSync(snapshotPath)).toBe(true);
  });

  it('refuses to unlink a path outside the adapter-owned filename shape', () => {
    const unrelated = path.join(stateDir, 'operator-config.json');
    fs.writeFileSync(unrelated, '{}');
    expect(() => cleanupClaudeCodeMcpRunConfig(unrelated)).toThrow(/Refusing to remove/);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it('scavenges only old orphaned configs, protecting active and durable instance ids', async () => {
    const active = await materialize(
      { 'agent-hq__agent-42': agentHqServer() },
      'active-long-run',
      8801,
    );
    const durable = resolveClaudeCodeMcpRunConfigPath({
      stateDir: agentStateDir(), instanceId: 8802, runKey: 'durable-active',
    });
    const orphan = resolveClaudeCodeMcpRunConfigPath({
      stateDir: agentStateDir(), instanceId: 8803, runKey: 'orphaned',
    });
    fs.writeFileSync(durable, '{}', { mode: 0o600 });
    fs.writeFileSync(orphan, '{}', { mode: 0o600 });

    const now = Date.now();
    const staleAt = new Date(now - DEFAULT_CLAUDE_CODE_MCP_STALE_CONFIG_TTL_MS - 1_000);
    fs.utimesSync(active.configPath!, staleAt, staleAt);
    fs.utimesSync(durable, staleAt, staleAt);
    fs.utimesSync(orphan, staleAt, staleAt);

    const result = scavengeStaleClaudeCodeMcpRunConfigs(agentStateDir(), {
      protectedInstanceIds: new Set([8802]),
      now,
    });

    expect(result).toEqual({ removed: [orphan], failures: [] });
    expect(fs.existsSync(active.configPath!)).toBe(true);
    expect(fs.existsSync(durable)).toBe(true);
    expect(fs.existsSync(orphan)).toBe(false);
    cleanupClaudeCodeMcpRunConfig(active.configPath);
  });
});

describe('readPreviousRunServers', () => {
  it('returns an empty map for a missing file', () => {
    expect(readPreviousRunServers(path.join(stateDir, 'nope.json'))).toEqual({});
  });

  it('returns an empty map for malformed JSON instead of throwing', () => {
    const file = path.join(stateDir, 'broken.json');
    fs.writeFileSync(file, '{ "mcpServers": ', 'utf8');

    expect(readPreviousRunServers(file)).toEqual({});
  });

  it('ignores non-object server entries', () => {
    const file = path.join(stateDir, 'mixed.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ mcpServers: { good: { command: 'x' }, bad: 'nope' } }),
      'utf8',
    );

    expect(readPreviousRunServers(file)).toEqual({ good: { command: 'x' } });
  });
});

describe('resolveClaudeCodeAgentStateDir', () => {
  it('defaults to an immutable tenant/agent directory under the OS temp dir', () => {
    delete process.env.AGENT_HQ_RUN_STATE_DIR;
    expect(resolveClaudeCodeAgentStateDir(7, 8801)).toBe(
      path.join(os.tmpdir(), 'agent-hq', 'claude-code', 'tenant-7', 'agent-8801'),
    );
  });

  it('honours AGENT_HQ_RUN_STATE_DIR, keeping the runtime/tenant/agent tail', () => {
    process.env.AGENT_HQ_RUN_STATE_DIR = '/var/lib/agent-hq/runs';

    expect(resolveClaudeCodeAgentStateDir(7, 8801)).toBe(
      '/var/lib/agent-hq/runs/claude-code/tenant-7/agent-8801',
    );
  });

  it('isolates tenants and agents while reusing one agent credential snapshot', () => {
    expect(resolveClaudeCodeAgentStateDir(7, 42)).toBe(resolveClaudeCodeAgentStateDir(7, 42));
    expect(resolveClaudeCodeAgentStateDir(7, 42)).not.toBe(resolveClaudeCodeAgentStateDir(7, 43));
    expect(resolveClaudeCodeAgentStateDir(7, 42)).not.toBe(resolveClaudeCodeAgentStateDir(8, 42));
  });

  it('rejects mutable or untrusted identifiers', () => {
    expect(() => resolveClaudeCodeAgentStateDir(0, 42)).toThrow(/tenant id/);
    expect(() => resolveClaudeCodeAgentStateDir(7, -1)).toThrow(/agent id/);
  });
});

describe('registry-tool boundary enforcement', () => {
  function dbWithToolCount(count: number): Db {
    const db = createMockDb() as unknown as Record<string, jest.Mock>;
    const toolRows = Array.from({ length: count }, (_unused, index) => ({
      id: index + 1,
      name: `tool-${index + 1}`,
      enabled: 1,
      assignment_enabled: 1,
    }));
    db.all = jest.fn(async (sql: string) =>
      sql.includes('team_tool_assignments') ? [] : (sql.includes('agent_tool_assignments') ? toolRows : []),
    );
    return db as unknown as Db;
  }

  it('allows normal MCP materialization when no registry tools are assigned', async () => {
    fetchAssignedMcpServersMock.mockResolvedValue({});
    const result = await materializeClaudeCodeMcpConfig({
      db: dbWithToolCount(0),
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      instanceId: 7,
      runKey: 'no-registry-tools',
      protectedInstanceIds: new Set(),
    });
    expect(result.serverNames).toEqual([]);
  });

  it('fails closed before MCP fetch when registry tools exist outside the boundary', async () => {
    const db = dbWithToolCount(2);
    await expect(materializeClaudeCodeMcpConfig({
      db,
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      instanceId: 7,
      runKey: 'registry-postgres',
      protectedInstanceIds: new Set(),
    })).rejects.toThrow(/absent from RuntimeBoundaryV1/);
    expect(fetchAssignedMcpServersMock).not.toHaveBeenCalled();
    expect(fs.readdirSync(agentStateDir())).toEqual([]);
  });

  it('fails closed on a tool granted only through a team', async () => {
    // A team grant is an assigned registry capability too. If the boundary check only counted
    // direct assignments, a team-only grant would launch unrecorded — the exact fail-open this
    // module exists to prevent.
    const db = createMockDb() as unknown as Record<string, jest.Mock>;
    db.all = jest.fn(async (sql: string) =>
      sql.includes('team_tool_assignments')
        ? [{ id: 1, name: 'team-tool', enabled: 1, assignment_enabled: 1 }]
        : [],
    );
    await expect(materializeClaudeCodeMcpConfig({
      db: db as unknown as Db,
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      instanceId: 7,
      runKey: 'registry-team-grant',
      protectedInstanceIds: new Set(),
    })).rejects.toThrow(/absent from RuntimeBoundaryV1/);
    expect(fetchAssignedMcpServersMock).not.toHaveBeenCalled();
  });

  it('treats registry-assignment inspection errors as fatal', async () => {
    const db = createMockDb() as unknown as Record<string, jest.Mock>;
    db.all = jest.fn(async () => { throw new Error('registry query failed'); });
    await expect(materializeClaudeCodeMcpConfig({
      db: db as unknown as Db,
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      instanceId: 7,
      runKey: 'registry-query-error',
      protectedInstanceIds: new Set(),
    })).rejects.toThrow('registry query failed');
    expect(fetchAssignedMcpServersMock).not.toHaveBeenCalled();
  });
});
