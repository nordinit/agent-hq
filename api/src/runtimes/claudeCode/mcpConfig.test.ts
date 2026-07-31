/**
 * Tests for the run-scoped Claude Code MCP config materializer.
 *
 * `fetchAssignedMcpServers` is stubbed because it is the DB boundary of this unit:
 * exercising it for real would mean simulating the whole mcp_api_keys + tenants
 * schema, and the guarantee under test is precisely WHAT this module hands it (the
 * previous run's server map) rather than what it does with a live database.
 * `resolveMcpServerRuntimePaths` is deliberately left real.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { type Db } from '../../db/adapter/types';
import { fetchAssignedMcpServers } from '../mcpMaterialization';
import {
  CLAUDE_CODE_MCP_CONFIG_FILENAME,
  materializeClaudeCodeMcpConfig,
  readPreviousRunServers,
  resolveClaudeCodeAgentStateDir,
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
const originalRunStateDir = process.env.AGENT_HQ_RUN_STATE_DIR;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mcp-config-test-'));
  dbMock = createMockDb();
  fetchAssignedMcpServersMock.mockReset();
  delete process.env.AGENT_HQ_RUN_STATE_DIR;
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  if (originalRunStateDir === undefined) delete process.env.AGENT_HQ_RUN_STATE_DIR;
  else process.env.AGENT_HQ_RUN_STATE_DIR = originalRunStateDir;
});

function materialize(servers: ServerMap, previousServers?: ServerMap) {
  fetchAssignedMcpServersMock.mockResolvedValue(servers);
  return materializeClaudeCodeMcpConfig({
    db: dbMock,
    agentId: 42,
    instanceId: 8801,
    stateDir,
    previousServers,
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

  it('leaves a server without a toolFilter unrestricted, but records it', async () => {
    const result = await materialize({ 'agent-hq__agent-42': agentHqServer() });

    expect(result.allowedToolNames).toEqual([]);
    expect(result.warnings).toEqual([
      'MCP server "agent-hq__agent-42" has no toolFilter.include and is unrestricted: every tool it exposes can be called.',
    ]);
  });

  it('mixes an unrestricted lifecycle server with an allowlisted one', async () => {
    const result = await materialize({
      'agent-hq__agent-42': agentHqServer(),
      'linear__agent-42': filteredServer(['issue_create']),
    });

    expect(result.serverNames).toEqual(['agent-hq__agent-42', 'linear__agent-42']);
    expect(result.allowedToolNames).toEqual(['mcp__linear__agent-42__issue_create']);
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

    expect(result.configPath).toBe(path.join(stateDir, CLAUDE_CODE_MCP_CONFIG_FILENAME));
    expect(fs.statSync(result.configPath!).mode & 0o777).toBe(0o600);
  });

  it('creates the run state dir when it does not exist yet', async () => {
    const nested = path.join(stateDir, 'claude-code', '8801');
    fetchAssignedMcpServersMock.mockResolvedValue({ 'agent-hq__agent-42': agentHqServer() });

    const result = await materializeClaudeCodeMcpConfig({
      db: dbMock,
      agentId: 42,
      instanceId: 8801,
      stateDir: nested,
    });

    expect(result.configPath).toBe(path.join(nested, CLAUDE_CODE_MCP_CONFIG_FILENAME));
    expect(fs.existsSync(result.configPath!)).toBe(true);
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
    expect(fs.readdirSync(stateDir)).toEqual([]);
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
  it('reads the previous run config off disk and passes its servers through', async () => {
    const first = await materialize({ 'agent-hq__agent-42': agentHqServer('ahq_mcp_first') });
    expect(first.configPath).not.toBeNull();

    fetchAssignedMcpServersMock.mockClear();
    await materialize({ 'agent-hq__agent-42': agentHqServer('ahq_mcp_first') });

    expect(fetchAssignedMcpServersMock).toHaveBeenCalledTimes(1);
    const [db, agentId, existingServers] = fetchAssignedMcpServersMock.mock.calls[0];
    expect(db).toBe(dbMock);
    expect(agentId).toBe(42);
    // The whole point: without this env reaching ensureMaterializedMcpApiKeyForAgent
    // a fresh mcp_api_keys row is minted on every single dispatch.
    expect((existingServers as ServerMap)['agent-hq__agent-42'].env).toEqual({
      AGENT_HQ_MCP_API_KEY: 'ahq_mcp_first',
      AGENT_HQ_API_URL: 'http://127.0.0.1:3501',
    });
  });

  it('prefers an explicitly supplied previousServers map over the on-disk one', async () => {
    await materialize({ 'agent-hq__agent-42': agentHqServer('ahq_mcp_on_disk') });

    fetchAssignedMcpServersMock.mockClear();
    await materialize(
      { 'agent-hq__agent-42': agentHqServer('ahq_mcp_from_caller') },
      { 'agent-hq__agent-42': agentHqServer('ahq_mcp_from_caller') },
    );

    const [, , existingServers] = fetchAssignedMcpServersMock.mock.calls[0];
    expect((existingServers as ServerMap)['agent-hq__agent-42'].env).toMatchObject({
      AGENT_HQ_MCP_API_KEY: 'ahq_mcp_from_caller',
    });
  });

  it('passes an empty map when there is no previous run', async () => {
    await materialize({ 'agent-hq__agent-42': agentHqServer() });

    const [, , existingServers] = fetchAssignedMcpServersMock.mock.calls[0];
    expect(existingServers).toEqual({});
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
  it('defaults to a per-AGENT directory under the OS temp dir', () => {
    expect(resolveClaudeCodeAgentStateDir(8801)).toBe(
      path.join(os.tmpdir(), 'agent-hq', 'claude-code', 'agent-8801'),
    );
  });

  it('honours AGENT_HQ_RUN_STATE_DIR, keeping the runtime/agent tail', () => {
    process.env.AGENT_HQ_RUN_STATE_DIR = '/var/lib/agent-hq/runs';

    expect(resolveClaudeCodeAgentStateDir(8801)).toBe(
      '/var/lib/agent-hq/runs/claude-code/agent-8801',
    );
  });

  it('is scoped per agent, not per instance, so the API key carries forward', () => {
    // Two dispatches of the same agent must resolve to the SAME directory.
    // Per-instance scoping would hand fetchAssignedMcpServers an empty
    // previousServers on every run, minting a fresh never-revoked mcp_api_keys
    // row each time.
    expect(resolveClaudeCodeAgentStateDir(42)).toBe(resolveClaudeCodeAgentStateDir(42));
    expect(resolveClaudeCodeAgentStateDir(42)).not.toBe(resolveClaudeCodeAgentStateDir(43));
  });
});

describe('registry-tool shim materialization', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-code-shim-'));
    fetchAssignedMcpServersMock.mockResolvedValue({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function dbWithToolCount(count: number): Db {
    const db = createMockDb() as unknown as Record<string, jest.Mock>;
    db.get = jest.fn(async (sql: string) =>
      sql.includes('agent_tool_assignments') ? { count } : undefined,
    );
    return db as unknown as Db;
  }

  it('is omitted when the compiled shim is not on disk', async () => {
    // Running from source (tsx/jest) there is no emitted .js, so the guard must
    // degrade to "no registry tools" rather than materializing a dead command.
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);

    const result = await materializeClaudeCodeMcpConfig({
      db: dbWithToolCount(3),
      agentId: 42,
      instanceId: 7,
      stateDir,
    });

    expect(result.serverNames).not.toContain('agent-tools__agent-42');
  });

  it('is omitted when the agent has no enabled registry tools', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await materializeClaudeCodeMcpConfig({
      db: dbWithToolCount(0),
      agentId: 42,
      instanceId: 7,
      stateDir,
    });

    expect(result.serverNames).not.toContain('agent-tools__agent-42');
  });

  it('is materialized as a stdio server when the agent has registry tools', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await materializeClaudeCodeMcpConfig({
      db: dbWithToolCount(2),
      agentId: 42,
      instanceId: 7,
      stateDir,
    });

    expect(result.serverNames).toContain('agent-tools__agent-42');

    const written = JSON.parse(
      fs.readFileSync(path.join(stateDir, CLAUDE_CODE_MCP_CONFIG_FILENAME), 'utf8'),
    );
    const shim = written.mcpServers['agent-tools__agent-42'];
    expect(shim.command).toBe(process.execPath);
    expect(String(shim.args[0])).toContain('agent-tool-mcp.js');
    expect(shim.env.AGENT_HQ_TOOL_AGENT_ID).toBe('42');
  });

  it('leaves the shim unrestricted — assignments are already the allowlist', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await materializeClaudeCodeMcpConfig({
      db: dbWithToolCount(2),
      agentId: 42,
      instanceId: 7,
      stateDir,
    });

    // The shim only ever serves tools already assigned to this agent, so a second
    // allowlist at the MCP layer would be redundant. It contributes no qualified
    // tool names, and says so via a warning rather than silently.
    expect(result.allowedToolNames).toEqual([]);
    expect(result.warnings.join(' ')).toContain('agent-tools__agent-42');
  });

  it('never counts the shim as a required server', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await materializeClaudeCodeMcpConfig({
      db: dbWithToolCount(2),
      agentId: 42,
      instanceId: 7,
      stateDir,
    });

    // Only the lifecycle server gates the run. A missing tool shim degrades
    // capability; a missing lifecycle server makes the run unable to report.
    expect(result.requiredServerNames).not.toContain('agent-tools__agent-42');
  });
});
