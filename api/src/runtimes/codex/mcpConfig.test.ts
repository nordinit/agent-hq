import fs from 'fs';
import os from 'os';
import path from 'path';
import { fetchAssignedMcpServers } from '../mcpMaterialization';
import {
  CODEX_CONFIG_FILENAME,
  CODEX_MCP_SNAPSHOT_FILENAME,
  materializeCodexMcpConfig,
  readCodexMcpSnapshot,
} from './mcpConfig';

jest.mock('../mcpMaterialization', () => ({
  fetchAssignedMcpServers: jest.fn(),
  resolveMcpServerRuntimePaths: (servers: unknown) => servers,
}));

const fetchAssigned = fetchAssignedMcpServers as jest.MockedFunction<typeof fetchAssignedMcpServers>;
let codexHome: string;
beforeEach(() => {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mcp-test-'));
  fetchAssigned.mockReset();
});
afterEach(() => fs.rmSync(codexHome, { recursive: true, force: true }));

function materialize(
  servers: Record<string, Record<string, unknown>>,
  preserveExistingConfig = false,
) {
  fetchAssigned.mockResolvedValue(servers);
  return materializeCodexMcpConfig({
    db: {} as never,
    agentId: 42,
    instanceId: 7,
    codexHome,
    preserveExistingConfig,
  });
}

describe('Codex MCP config materialization', () => {
  it('translates stdio servers and fail-closed tool allowlists to strict TOML', async () => {
    const result = await materialize({
      'agent-hq__agent-42': {
        command: '/opt/agent-hq-mcp',
        args: ['--stdio'],
        env: { AGENT_HQ_MCP_API_KEY: 'ahq_mcp_secret' },
      },
      'linear__agent-42': {
        command: '/opt/linear-mcp',
        cwd: '/repo',
        env: { LINEAR_API_KEY: 'linear_secret_must_not_be_snapshotted' },
        toolFilter: { include: ['issue_create', 'issue_update'] },
        agentHqAssignment: { id: 12 },
      },
    });
    const toml = fs.readFileSync(result.configPath, 'utf8');
    expect(toml).toContain('[mcp_servers."agent-hq__agent-42"]');
    expect(toml).toContain('env = { "AGENT_HQ_MCP_API_KEY" = "ahq_mcp_secret" }');
    expect(toml).toContain('enabled_tools = ["issue_create", "issue_update"]');
    expect(toml).not.toContain('agentHqAssignment');
    expect(result.requiredServerNames).toEqual(['agent-hq__agent-42']);
    expect(fs.statSync(result.configPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(result.snapshotPath).mode & 0o777).toBe(0o600);
    const snapshot = fs.readFileSync(result.snapshotPath, 'utf8');
    expect(JSON.parse(snapshot)).toEqual({
      servers: {
        'agent-hq__agent-42': {
          env: { AGENT_HQ_MCP_API_KEY: 'ahq_mcp_secret' },
        },
      },
    });
    expect(snapshot).not.toContain('linear_secret_must_not_be_snapshotted');
    expect(snapshot).not.toContain('/opt/linear-mcp');
  });

  it('renders the shared fail-closed sentinel as enabled_tools = []', async () => {
    await materialize({
      'linear__agent-42': {
        command: '/opt/linear-mcp',
        toolFilter: { include: ['__agent_hq_no_allowed_mcp_tools__'] },
      },
    });
    expect(fs.readFileSync(path.join(codexHome, CODEX_CONFIG_FILENAME), 'utf8'))
      .toContain('enabled_tools = []');
  });

  it('preserves safe CLI-owned settings and rejects unmanaged MCP grants', async () => {
    const configPath = path.join(codexHome, CODEX_CONFIG_FILENAME);
    fs.writeFileSync(configPath, 'model = "gpt-5.5"\n', { mode: 0o600 });
    await materialize({ linear: { command: '/opt/linear-mcp' } }, true);
    const first = fs.readFileSync(configPath, 'utf8');
    expect(first).toContain('model = "gpt-5.5"');
    expect(first.match(/BEGIN AGENT HQ MANAGED MCP/g)).toHaveLength(1);
    await materialize({}, true);
    expect(fs.readFileSync(configPath, 'utf8').match(/BEGIN AGENT HQ MANAGED MCP/g)).toHaveLength(1);

    fs.writeFileSync(configPath, '[mcp_servers.personal]\ncommand = "personal"\n', { mode: 0o600 });
    await expect(materialize({}, true)).rejects.toThrow(/unmanaged MCP servers/);
  });

  it('carries the prior MCP API key snapshot into the next fetch', async () => {
    await materialize({
      'agent-hq__agent-42': {
        command: '/opt/agent-hq-mcp',
        env: { AGENT_HQ_MCP_API_KEY: 'ahq_mcp_reused' },
      },
    });
    fetchAssigned.mockClear();
    await materialize({});
    expect(fetchAssigned.mock.calls[0][2]).toMatchObject({
      'agent-hq__agent-42': { env: { AGENT_HQ_MCP_API_KEY: 'ahq_mcp_reused' } },
    });
    expect(readCodexMcpSnapshot(path.join(codexHome, CODEX_MCP_SNAPSHOT_FILENAME))).toEqual({});
  });

  it('keeps concurrent agents on one credential home in disjoint profiles and snapshots', async () => {
    const canonicalConfig = path.join(codexHome, CODEX_CONFIG_FILENAME);
    fs.writeFileSync(canonicalConfig, 'model = "cli-owned-default"\n', { mode: 0o600 });
    const firstConfig = path.join(codexHome, 'agent-hq-runtime-101-a.config.toml');
    const secondConfig = path.join(codexHome, 'agent-hq-runtime-202-b.config.toml');
    const firstSnapshot = path.join(codexHome, '..', 'state-a', CODEX_MCP_SNAPSHOT_FILENAME);
    const secondSnapshot = path.join(codexHome, '..', 'state-b', CODEX_MCP_SNAPSHOT_FILENAME);
    fetchAssigned.mockImplementation(async (_db, agentId) => ({
      [`agent-hq__agent-${agentId}`]: {
        command: '/opt/agent-hq-mcp',
        env: { AGENT_HQ_MCP_API_KEY: `ahq_mcp_agent_${agentId}` },
      },
    }));

    await Promise.all([
      materializeCodexMcpConfig({
        db: {} as never,
        agentId: 101,
        instanceId: 11,
        codexHome,
        configPath: firstConfig,
        snapshotPath: firstSnapshot,
      }),
      materializeCodexMcpConfig({
        db: {} as never,
        agentId: 202,
        instanceId: 22,
        codexHome,
        configPath: secondConfig,
        snapshotPath: secondSnapshot,
      }),
    ]);

    const first = fs.readFileSync(firstConfig, 'utf8');
    const second = fs.readFileSync(secondConfig, 'utf8');
    expect(first).toContain('agent-hq__agent-101');
    expect(first).toContain('ahq_mcp_agent_101');
    expect(first).not.toContain('agent-202');
    expect(second).toContain('agent-hq__agent-202');
    expect(second).toContain('ahq_mcp_agent_202');
    expect(second).not.toContain('agent-101');
    expect(fs.readFileSync(firstSnapshot, 'utf8')).not.toContain('agent_202');
    expect(fs.readFileSync(secondSnapshot, 'utf8')).not.toContain('agent_101');
    expect(fs.readFileSync(canonicalConfig, 'utf8')).toBe('model = "cli-owned-default"\n');
  });
});
