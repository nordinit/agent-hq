import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import {
  ensureOpenClawMcpWorkspaceBundleEnabled,
  materializeAgentMcpConfig,
  materializeHermesMcpConfig,
  materializeOpenClawGlobalMcpConfig,
  syncAssignedMcpForAgent,
  syncAssignedMcpForServer,
} from './mcpMaterialization';

const ORIGINAL_OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH;
const ORIGINAL_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH = process.env.AGENT_HQ_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH;

function resetDb(): void {
  closeDb();
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createRegistryTables(): void {
  getDb().exec(`
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      session_key TEXT NOT NULL DEFAULT '',
      openclaw_agent_id TEXT,
      runtime_type TEXT,
      workspace_path TEXT
    );
    CREATE TABLE tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      implementation_type TEXT NOT NULL DEFAULT 'bash',
      implementation_body TEXT NOT NULL DEFAULT '',
      input_schema TEXT NOT NULL DEFAULT '{}',
      permissions TEXT NOT NULL DEFAULT 'read_only',
      tags TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE agent_tool_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      tool_id INTEGER NOT NULL,
      overrides TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE mcp_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      command TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '[]',
      env TEXT NOT NULL DEFAULT '{}',
      cwd TEXT,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE agent_mcp_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      mcp_server_id INTEGER NOT NULL,
      overrides TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1
    );
  `);
}

describe('materializeAgentMcpConfig', () => {
  beforeEach(() => {
    resetDb();
    process.env.OPENCLAW_CONFIG_PATH = path.join(makeTempDir('agent-hq-openclaw-config-'), 'openclaw.json');
    process.env.AGENT_HQ_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH = '1';
  });
  afterEach(() => {
    if (ORIGINAL_OPENCLAW_CONFIG_PATH === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
    else process.env.OPENCLAW_CONFIG_PATH = ORIGINAL_OPENCLAW_CONFIG_PATH;
    if (ORIGINAL_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH === undefined) delete process.env.AGENT_HQ_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH;
    else process.env.AGENT_HQ_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH = ORIGINAL_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH;
    resetDb();
  });

  it('does not materialize assigned capability tools as an OpenClaw MCP bridge', () => {
    createRegistryTables();
    getDb().prepare(`INSERT INTO agents (id, name) VALUES (1, 'Agent')`).run();
    getDb().prepare(`INSERT INTO tools (id, name, slug, implementation_type, implementation_body) VALUES (10, 'Tool', 'custom_tool', 'bash', 'echo ok')`).run();
    getDb().prepare(`INSERT INTO agent_tool_assignments (agent_id, tool_id) VALUES (1, 10)`).run();
    const workingDirectory = makeTempDir('agent-hq-mcp-tools-');

    const result = materializeAgentMcpConfig({
      db: getDb(),
      agentId: 1,
      workingDirectory,
      materializeOpenClawGlobalConfig: true,
    });

    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
    expect(fs.existsSync(path.join(workingDirectory, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(workingDirectory, '.openclaw', 'extensions', 'agent-hq-mcp', '.mcp.json'))).toBe(false);
    if (fs.existsSync(process.env.OPENCLAW_CONFIG_PATH!)) {
      const openClawConfig = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH!, 'utf8'));
      expect(openClawConfig.mcp?.servers).toBeUndefined();
    }
  });

  it('materializes explicitly assigned MCP servers into workspace bundle files and Codex-scoped OpenClaw config', () => {
    createRegistryTables();
    getDb().prepare(`INSERT INTO agents (id, name, session_key, openclaw_agent_id) VALUES (1, 'Agent', 'agent:cinder-backend:main', 'cinder-backend')`).run();
    getDb().prepare(`INSERT INTO mcp_servers (id, slug, command, args) VALUES (30, 'agent-hq', 'node', '["server.js"]')`).run();
    getDb().prepare(`INSERT INTO mcp_servers (id, slug, command, args) VALUES (31, 'dev-environment-lease-manager', '.venv/bin/dev-env-lease-mcp', '["--config","config/environments.json"]')`).run();
    getDb().prepare(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (1, 30)`).run();
    getDb().prepare(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (1, 31)`).run();
    const workingDirectory = makeTempDir('agent-hq-mcp-servers-');
    fs.mkdirSync(path.dirname(process.env.OPENCLAW_CONFIG_PATH!), { recursive: true });
    fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify({
      mcp: {
        servers: {
          'agent-hq__agent-1': { command: 'node', args: ['stale.js'], env: { AGENT_HQ_MCP_API_KEY: 'stale' } },
          'custom__agent-1': { command: 'node', args: ['operator.js'] },
        },
      },
    }), 'utf8');

    const result = materializeAgentMcpConfig({
      db: getDb(),
      agentId: 1,
      workingDirectory,
      materializeOpenClawGlobalConfig: true,
    });
    const config = JSON.parse(fs.readFileSync(path.join(workingDirectory, '.mcp.json'), 'utf8'));
    const bundleConfig = JSON.parse(fs.readFileSync(path.join(workingDirectory, '.openclaw', 'extensions', 'agent-hq-mcp', '.mcp.json'), 'utf8'));
    const bundleManifest = JSON.parse(fs.readFileSync(path.join(workingDirectory, '.openclaw', 'extensions', 'agent-hq-mcp', '.claude-plugin', 'plugin.json'), 'utf8'));
    const openClawConfig = fs.existsSync(process.env.OPENCLAW_CONFIG_PATH!)
      ? JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH!, 'utf8'))
      : {};

    expect(result.ok).toBe(true);
    expect(config.mcpServers['agent-hq__agent-1']).toMatchObject({ command: 'node', args: ['server.js'] });
    expect(config.mcpServers['dev-environment-lease-manager__agent-1']).toMatchObject({ command: '.venv/bin/dev-env-lease-mcp', args: ['--config', 'config/environments.json'] });
    expect(bundleConfig.mcpServers['agent-hq__agent-1']).toMatchObject({ command: 'node', args: ['server.js'] });
    expect(config.mcpServers['agent-hq__agent-1'].env.AGENT_HQ_MCP_API_KEY).toMatch(/^ahq_mcp_/);
    expect(config.mcpServers['dev-environment-lease-manager__agent-1'].env.AGENT_HQ_MCP_API_KEY).toBe(config.mcpServers['agent-hq__agent-1'].env.AGENT_HQ_MCP_API_KEY);
    expect(bundleConfig.mcpServers['agent-hq__agent-1'].env.AGENT_HQ_MCP_API_KEY).toBe(config.mcpServers['agent-hq__agent-1'].env.AGENT_HQ_MCP_API_KEY);
    expect(bundleConfig.mcpServers['dev-environment-lease-manager__agent-1'].env.AGENT_HQ_MCP_API_KEY).toBe(config.mcpServers['agent-hq__agent-1'].env.AGENT_HQ_MCP_API_KEY);
    expect(config.mcpServers['agent-hq']).toBeUndefined();
    expect(config.mcpServers['dev-environment-lease-manager']).toBeUndefined();
    expect(config.mcpServers['agent-local-tool-mcp']).toBeUndefined();
    expect(config.mcpServers.custom).toBeUndefined();
    expect(config.mcpServers['custom__agent-1']).toBeUndefined();
    expect(bundleConfig.mcpServers['agent-local-tool-mcp']).toBeUndefined();
    expect(bundleManifest).toMatchObject({ name: 'agent-hq-mcp', mcpServers: ['.mcp.json'] });
    expect(openClawConfig.mcp?.servers['agent-hq__agent-1']).toMatchObject({
      command: 'node',
      args: ['server.js'],
      codex: { agents: ['cinder-backend'] },
    });
    expect(openClawConfig.mcp?.servers['agent-hq__agent-1'].env.AGENT_HQ_MCP_API_KEY).toBe(config.mcpServers['agent-hq__agent-1'].env.AGENT_HQ_MCP_API_KEY);
    expect(openClawConfig.mcp?.servers['dev-environment-lease-manager__agent-1']).toMatchObject({
      command: '.venv/bin/dev-env-lease-mcp',
      args: ['--config', 'config/environments.json'],
      codex: { agents: ['cinder-backend'] },
    });
    expect(openClawConfig.mcp?.servers['custom__agent-1']).toBeDefined();
  });

  it('reuses an existing valid materialized Agent HQ MCP key for the same agent', () => {
    createRegistryTables();
    getDb().prepare(`INSERT INTO agents (id, name) VALUES (1, 'Agent')`).run();
    getDb().prepare(`INSERT INTO mcp_servers (id, slug, command, args) VALUES (30, 'agent-hq', 'node', '["server.js"]')`).run();
    getDb().prepare(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (1, 30)`).run();
    const workingDirectory = makeTempDir('agent-hq-mcp-reuse-');

    const first = materializeAgentMcpConfig({
      db: getDb(),
      agentId: 1,
      workingDirectory,
      materializeOpenClawGlobalConfig: true,
    });
    const firstConfig = JSON.parse(fs.readFileSync(path.join(workingDirectory, '.mcp.json'), 'utf8'));
    const firstKey = firstConfig.mcpServers['agent-hq__agent-1'].env.AGENT_HQ_MCP_API_KEY;
    const second = materializeAgentMcpConfig({
      db: getDb(),
      agentId: 1,
      workingDirectory,
      materializeOpenClawGlobalConfig: true,
    });
    const secondConfig = JSON.parse(fs.readFileSync(path.join(workingDirectory, '.mcp.json'), 'utf8'));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(secondConfig.mcpServers['agent-hq__agent-1'].env.AGENT_HQ_MCP_API_KEY).toBe(firstKey);
    const openClawConfig = fs.existsSync(process.env.OPENCLAW_CONFIG_PATH!)
      ? JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH!, 'utf8'))
      : {};
    expect(openClawConfig.mcp?.servers['agent-hq__agent-1'].env.AGENT_HQ_MCP_API_KEY).toBe(firstKey);
    expect(openClawConfig.mcp?.servers['agent-hq__agent-1'].codex.agents).toEqual(['agent']);
    const keyCount = getDb().prepare(`SELECT COUNT(*) as count FROM mcp_api_keys WHERE agent_id = 1`).get() as { count: number };
    expect(keyCount.count).toBe(1);
  });

  it('syncs OpenClaw MCP config into the agent workspace without touching global config by default', () => {
    createRegistryTables();
    const workspaceDirectory = makeTempDir('agent-hq-openclaw-workspace-');
    const taskWorktreeDirectory = path.join(workspaceDirectory, 'task-449');
    fs.mkdirSync(taskWorktreeDirectory, { recursive: true });
    getDb().prepare(`INSERT INTO agents (id, name, session_key, openclaw_agent_id, runtime_type, workspace_path) VALUES (1, 'Agent', 'agent:cinder-backend:main', 'cinder-backend', 'openclaw', ?)`).run(workspaceDirectory);
    getDb().prepare(`INSERT INTO mcp_servers (id, slug, command, args) VALUES (30, 'dev-environment-lease-manager', '.venv/bin/dev-env-lease-mcp', '["--config","config/environments.json"]')`).run();
    getDb().prepare(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (1, 30)`).run();

    const result = syncAssignedMcpForAgent({
      db: getDb(),
      agentId: 1,
      workingDirectory: taskWorktreeDirectory,
    });

    expect(result.ok).toBe(true);
    expect(result.workingDirectory).toBe(workspaceDirectory);
    expect(fs.existsSync(path.join(workspaceDirectory, '.mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDirectory, '.openclaw', 'extensions', 'agent-hq-mcp', '.mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDirectory, '.openclaw', 'extensions', 'agent-hq-mcp', '.claude-plugin', 'plugin.json'))).toBe(true);
    const config = JSON.parse(fs.readFileSync(path.join(workspaceDirectory, '.mcp.json'), 'utf8'));
    expect(config.mcpServers['dev-environment-lease-manager__agent-1'].env.AGENT_HQ_MCP_API_KEY).toMatch(/^ahq_mcp_/);
    expect(fs.existsSync(path.join(taskWorktreeDirectory, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(taskWorktreeDirectory, '.openclaw', 'extensions', 'agent-hq-mcp', '.mcp.json'))).toBe(false);
    const openClawConfig = fs.existsSync(process.env.OPENCLAW_CONFIG_PATH!)
      ? JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH!, 'utf8'))
      : {};
    expect(openClawConfig.mcp?.servers).toBeUndefined();
  });

  it('refreshes the OpenClaw plugin registry once after successful OpenClaw MCP sync', () => {
    createRegistryTables();
    const workspaceDirectory = makeTempDir('agent-hq-openclaw-refresh-');
    getDb().prepare(`INSERT INTO agents (id, name, runtime_type, workspace_path) VALUES (1, 'Agent', 'openclaw', ?)`).run(workspaceDirectory);
    getDb().prepare(`INSERT INTO mcp_servers (id, slug, command, args) VALUES (30, 'agent-hq', 'node', '["server.js"]')`).run();
    getDb().prepare(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (1, 30)`).run();
    const refreshOpenClawPluginRegistry = jest.fn(() => ({
      ok: true,
      command: 'openclaw',
      args: ['plugins', 'registry', '--refresh'],
      status: 0,
    }));

    const result = syncAssignedMcpForAgent({
      db: getDb(),
      agentId: 1,
      materializeOpenClawGlobalConfig: true,
      refreshOpenClawPluginRegistry,
    });

    expect(result.ok).toBe(true);
    expect(refreshOpenClawPluginRegistry).toHaveBeenCalledTimes(1);
    expect(refreshOpenClawPluginRegistry).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 1,
      workingDirectory: workspaceDirectory,
      materializedCount: 1,
    }));
  });

  it('does not refresh the OpenClaw plugin registry for failed or no-op syncs', () => {
    createRegistryTables();
    const workspaceDirectory = makeTempDir('agent-hq-openclaw-noop-');
    getDb().prepare(`INSERT INTO agents (id, name, runtime_type, workspace_path) VALUES (1, 'Agent', 'openclaw', ?), (2, 'No Workspace', 'openclaw', NULL)`).run(workspaceDirectory);
    const refreshOpenClawPluginRegistry = jest.fn(() => ({
      ok: true,
      command: 'openclaw',
      args: ['plugins', 'registry', '--refresh'],
      status: 0,
    }));

    const noop = syncAssignedMcpForAgent({
      db: getDb(),
      agentId: 1,
      refreshOpenClawPluginRegistry,
    });
    const failed = syncAssignedMcpForAgent({
      db: getDb(),
      agentId: 2,
      refreshOpenClawPluginRegistry,
    });

    expect(noop.ok).toBe(true);
    expect(noop.count).toBe(0);
    expect(failed.ok).toBe(false);
    expect(failed.skipped).toBe('missing_workspace');
    expect(refreshOpenClawPluginRegistry).not.toHaveBeenCalled();
  });

  it('keeps the workspace bundle plugin enabled even when an OpenClaw global sync has zero assigned MCP servers', () => {
    createRegistryTables();
    const workspaceDirectory = makeTempDir('agent-hq-openclaw-zero-count-');
    const configPath = process.env.OPENCLAW_CONFIG_PATH!;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          'agent-hq-mcp': { enabled: true, config: { timeoutSeconds: 180 } },
          operator: { enabled: true },
        },
      },
    }), 'utf8');
    getDb().prepare(`INSERT INTO agents (id, name, runtime_type, workspace_path) VALUES (1, 'Agent', 'openclaw', ?)`).run(workspaceDirectory);
    const refreshOpenClawPluginRegistry = jest.fn(() => ({
      ok: true,
      command: 'openclaw',
      args: ['plugins', 'registry', '--refresh'],
      status: 0,
    }));

    const result = syncAssignedMcpForAgent({
      db: getDb(),
      agentId: 1,
      materializeOpenClawGlobalConfig: true,
      refreshOpenClawPluginRegistry,
    });
    const openClawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
    expect(fs.existsSync(path.join(workspaceDirectory, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(workspaceDirectory, '.openclaw', 'extensions', 'agent-hq-mcp', '.mcp.json'))).toBe(false);
    expect(openClawConfig.plugins.entries['agent-hq-mcp']).toEqual({ enabled: true, config: { timeoutSeconds: 180 } });
    expect(openClawConfig.plugins.entries.operator).toEqual({ enabled: true });
    expect(refreshOpenClawPluginRegistry).not.toHaveBeenCalled();
  });

  it('surfaces OpenClaw plugin registry refresh failures as sync failures with actionable context', () => {
    createRegistryTables();
    const workspaceDirectory = makeTempDir('agent-hq-openclaw-refresh-fail-');
    getDb().prepare(`INSERT INTO agents (id, name, runtime_type, workspace_path) VALUES (1, 'Agent', 'openclaw', ?)`).run(workspaceDirectory);
    getDb().prepare(`INSERT INTO mcp_servers (id, slug, command, args) VALUES (30, 'agent-hq', 'node', '["server.js"]')`).run();
    getDb().prepare(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (1, 30)`).run();
    const refreshOpenClawPluginRegistry = jest.fn(() => ({
      ok: false,
      command: 'openclaw',
      args: ['plugins', 'registry', '--refresh'],
      status: 1,
      stderr: 'registry locked',
      error: 'registry locked',
    }));

    const result = syncAssignedMcpForAgent({
      db: getDb(),
      agentId: 1,
      materializeOpenClawGlobalConfig: true,
      refreshOpenClawPluginRegistry,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('OpenClaw plugin registry refresh failed');
    expect(result.error).toContain('openclaw plugins registry --refresh');
    expect(result.error).toContain('registry locked');
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('registry locked')]));
  });

  it('does not refresh the OpenClaw plugin registry for a workspace-only multi-agent server sync batch', () => {
    createRegistryTables();
    const firstWorkspace = makeTempDir('agent-hq-openclaw-batch-one-');
    const secondWorkspace = makeTempDir('agent-hq-openclaw-batch-two-');
    getDb().prepare(`INSERT INTO agents (id, name, runtime_type, workspace_path) VALUES (1, 'One', 'openclaw', ?), (2, 'Two', 'openclaw', ?)`).run(firstWorkspace, secondWorkspace);
    getDb().prepare(`INSERT INTO mcp_servers (id, slug, command, args) VALUES (30, 'agent-hq', 'node', '["server.js"]')`).run();
    getDb().prepare(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (1, 30), (2, 30)`).run();
    const refreshOpenClawPluginRegistry = jest.fn(() => ({
      ok: true,
      command: 'openclaw',
      args: ['plugins', 'registry', '--refresh'],
      status: 0,
    }));

    const results = syncAssignedMcpForServer({
      db: getDb(),
      mcpServerId: 30,
      refreshOpenClawPluginRegistry,
    });

    expect(results).toHaveLength(2);
    expect(results.every(result => result.ok)).toBe(true);
    expect(refreshOpenClawPluginRegistry).not.toHaveBeenCalled();
  });

  it('keeps assigned MCP entries isolated in each workspace and Codex-scoped in shared OpenClaw config', () => {
    createRegistryTables();
    const firstWorkspace = makeTempDir('agent-hq-mcp-agent-one-');
    const secondWorkspace = makeTempDir('agent-hq-mcp-agent-two-');
    getDb().prepare(`INSERT INTO agents (id, name, session_key, openclaw_agent_id, runtime_type, workspace_path) VALUES (1, 'Cinder', 'agent:cinder-backend:main', 'cinder-backend', 'openclaw', ?)`).run(firstWorkspace);
    getDb().prepare(`INSERT INTO agents (id, name, session_key, openclaw_agent_id, runtime_type, workspace_path) VALUES (2, 'Beacon', 'agent:beacon-pm:main', 'beacon-pm', 'openclaw', ?)`).run(secondWorkspace);
    getDb().prepare(`INSERT INTO mcp_servers (id, slug, command, args) VALUES (30, 'agent-hq', 'node', '["server.js"]')`).run();
    getDb().prepare(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (1, 30), (2, 30)`).run();

    const first = syncAssignedMcpForAgent({
      db: getDb(),
      agentId: 1,
      materializeOpenClawGlobalConfig: true,
    });
    const second = syncAssignedMcpForAgent({
      db: getDb(),
      agentId: 2,
      materializeOpenClawGlobalConfig: true,
    });
    const openClawConfig = fs.existsSync(process.env.OPENCLAW_CONFIG_PATH!)
      ? JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH!, 'utf8'))
      : {};
    const firstConfig = JSON.parse(fs.readFileSync(path.join(firstWorkspace, '.openclaw', 'extensions', 'agent-hq-mcp', '.mcp.json'), 'utf8'));
    const secondConfig = JSON.parse(fs.readFileSync(path.join(secondWorkspace, '.openclaw', 'extensions', 'agent-hq-mcp', '.mcp.json'), 'utf8'));
    const firstServer = firstConfig.mcpServers['agent-hq__agent-1'];
    const secondServer = secondConfig.mcpServers['agent-hq__agent-2'];
    const firstOpenClawServer = openClawConfig.mcp?.servers['agent-hq__agent-1'];
    const secondOpenClawServer = openClawConfig.mcp?.servers['agent-hq__agent-2'];

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(firstServer.env.AGENT_HQ_MCP_API_KEY).toMatch(/^ahq_mcp_/);
    expect(secondServer.env.AGENT_HQ_MCP_API_KEY).toMatch(/^ahq_mcp_/);
    expect(firstServer.env.AGENT_HQ_MCP_API_KEY).not.toBe(secondServer.env.AGENT_HQ_MCP_API_KEY);
    expect(firstConfig.mcpServers['agent-hq__agent-2']).toBeUndefined();
    expect(secondConfig.mcpServers['agent-hq__agent-1']).toBeUndefined();
    expect(firstOpenClawServer.env.AGENT_HQ_MCP_API_KEY).toBe(firstServer.env.AGENT_HQ_MCP_API_KEY);
    expect(firstOpenClawServer.codex.agents).toEqual(['cinder-backend']);
    expect(secondOpenClawServer.env.AGENT_HQ_MCP_API_KEY).toBe(secondServer.env.AGENT_HQ_MCP_API_KEY);
    expect(secondOpenClawServer.codex.agents).toEqual(['beacon-pm']);
  });

  it('projects only the active Agent HQ and lease-manager MCP servers for each OpenClaw agent workspace', () => {
    createRegistryTables();
    const agents = [
      { id: 94, name: 'Cinder', slug: 'cinder-backend' },
      { id: 95, name: 'Prism', slug: 'prism-frontend' },
      { id: 96, name: 'Talon', slug: 'talon-qa' },
      { id: 97, name: 'Anchor', slug: 'anchor-devops' },
    ];
    getDb().prepare(`INSERT INTO mcp_servers (id, slug, command, args) VALUES (30, 'agent-hq', 'node', '["server.js"]')`).run();
    getDb().prepare(`INSERT INTO mcp_servers (id, slug, command, args) VALUES (31, 'dev-environment-lease-manager', 'dev-env-lease-mcp', '["--stdio"]')`).run();

    const workspaces = new Map<number, string>();
    for (const agent of agents) {
      const workspace = makeTempDir(`agent-hq-${agent.slug}-`);
      workspaces.set(agent.id, workspace);
      getDb().prepare(`
        INSERT INTO agents (id, name, session_key, openclaw_agent_id, runtime_type, workspace_path)
        VALUES (?, ?, ?, ?, 'openclaw', ?)
      `).run(agent.id, agent.name, `agent:${agent.slug}:main`, agent.slug, workspace);
      getDb().prepare(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (?, 30), (?, 31)`).run(agent.id, agent.id);
    }

    for (const agent of agents) {
      const result = syncAssignedMcpForAgent({
        db: getDb(),
        agentId: agent.id,
        materializeOpenClawGlobalConfig: true,
      });
      expect(result.ok).toBe(true);
      const workspace = workspaces.get(agent.id)!;
      const bundleConfig = JSON.parse(fs.readFileSync(path.join(workspace, '.openclaw', 'extensions', 'agent-hq-mcp', '.mcp.json'), 'utf8'));
      const visibleServerNames = Object.keys(bundleConfig.mcpServers).sort();
      expect(visibleServerNames).toEqual([
        `agent-hq__agent-${agent.id}`,
        `dev-environment-lease-manager__agent-${agent.id}`,
      ]);
      for (const other of agents.filter(other => other.id !== agent.id)) {
        expect(visibleServerNames).not.toContain(`agent-hq__agent-${other.id}`);
        expect(visibleServerNames).not.toContain(`dev-environment-lease-manager__agent-${other.id}`);
      }
      const agentHqKey = bundleConfig.mcpServers[`agent-hq__agent-${agent.id}`].env.AGENT_HQ_MCP_API_KEY;
      expect(agentHqKey).toMatch(/^ahq_mcp_/);
      expect(bundleConfig.mcpServers[`dev-environment-lease-manager__agent-${agent.id}`].env.AGENT_HQ_MCP_API_KEY).toBe(agentHqKey);
    }

    const openClawConfig = fs.existsSync(process.env.OPENCLAW_CONFIG_PATH!)
      ? JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH!, 'utf8'))
      : {};
    const globalServerNames = Object.keys(openClawConfig.mcp?.servers ?? {}).sort();
    expect(globalServerNames).toEqual(agents.flatMap(agent => [
      `agent-hq__agent-${agent.id}`,
      `dev-environment-lease-manager__agent-${agent.id}`,
    ]).sort());
    for (const agent of agents) {
      const agentHqServer = openClawConfig.mcp.servers[`agent-hq__agent-${agent.id}`];
      const leaseServer = openClawConfig.mcp.servers[`dev-environment-lease-manager__agent-${agent.id}`];
      expect(agentHqServer.codex.agents).toEqual([agent.slug]);
      expect(leaseServer.codex.agents).toEqual([agent.slug]);
      expect(leaseServer.env.AGENT_HQ_MCP_API_KEY).toBe(agentHqServer.env.AGENT_HQ_MCP_API_KEY);
    }
  });

  it('removes the active agent Agent HQ scoped MCP entries from shared OpenClaw global config while preserving others', () => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH!;
    fs.writeFileSync(configPath, JSON.stringify({
      mcp: {
        servers: {
          'agent-hq__agent-1': { command: 'node', args: ['old.js'], codex: { agents: ['cinder-backend'] } },
          'agent-hq__agent-2': { command: 'node', args: ['other.js'], codex: { agents: ['beacon-pm'] } },
          'custom__agent-42': { command: 'node', args: ['operator-scoped.js'] },
          operator: { command: 'node', args: ['operator.js'] },
        },
      },
    }), 'utf8');

    const result = materializeOpenClawGlobalMcpConfig({
      agentId: 1,
      agentSlug: 'cinder-backend',
      desiredServers: {},
      configPath,
    });
    const openClawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(result.ok).toBe(true);
    expect(openClawConfig.mcp.servers['agent-hq__agent-1']).toBeUndefined();
    expect(openClawConfig.mcp.servers['agent-hq__agent-2']).toBeDefined();
    expect(openClawConfig.mcp.servers['custom__agent-42']).toBeDefined();
    expect(openClawConfig.mcp.servers.operator).toBeDefined();
  });

  it('syncs Hermes MCP config into the prepared runtime directory with an Agent HQ key', () => {
    createRegistryTables();
    const workspaceDirectory = makeTempDir('agent-hq-hermes-workspace-');
    const hermesProfileDirectory = makeTempDir('agent-hq-hermes-profile-');
    getDb().prepare(`INSERT INTO agents (id, name, runtime_type, workspace_path) VALUES (1, 'Hermes Agent', 'hermes', ?)`).run(workspaceDirectory);
    getDb().prepare(`INSERT INTO mcp_servers (id, slug, command, args) VALUES (30, 'agent-hq', 'node', '["server.js"]')`).run();
    getDb().prepare(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (1, 30)`).run();

    const result = syncAssignedMcpForAgent({
      db: getDb(),
      agentId: 1,
      workingDirectory: hermesProfileDirectory,
    });

    expect(result.ok).toBe(true);
    expect(result.runtimeType).toBe('hermes');
    expect(result.workingDirectory).toBe(hermesProfileDirectory);
    const config = JSON.parse(fs.readFileSync(path.join(hermesProfileDirectory, '.mcp.json'), 'utf8'));
    expect(config.mcpServers['agent-hq__agent-1']).toMatchObject({ command: 'node', args: ['server.js'] });
    expect(config.mcpServers['agent-hq__agent-1'].env.AGENT_HQ_MCP_API_KEY).toMatch(/^ahq_mcp_/);
    expect(fs.existsSync(path.join(hermesProfileDirectory, '.openclaw', 'extensions', 'agent-hq-mcp', '.mcp.json'))).toBe(true);
    if (fs.existsSync(process.env.OPENCLAW_CONFIG_PATH!)) {
      const openClawConfig = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH!, 'utf8'));
      expect(openClawConfig.mcp?.servers).toBeUndefined();
    }
  });

  it('removes stale scoped global OpenClaw MCP entries when an agent no longer uses OpenClaw runtime', () => {
    createRegistryTables();
    const configPath = process.env.OPENCLAW_CONFIG_PATH!;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      mcp: {
        servers: {
          'agent-hq__agent-1': { command: 'node', args: ['old.js'], env: { AGENT_HQ_MCP_API_KEY: 'old-key' } },
          'dev-environment-lease-manager__agent-1': { command: 'lease-mcp', env: { AGENT_HQ_MCP_API_KEY: 'old-key' } },
          'agent-hq__agent-2': { command: 'node', args: ['other.js'], env: { AGENT_HQ_MCP_API_KEY: 'other-key' } },
        },
      },
    }), 'utf8');
    const hermesHome = makeTempDir('agent-hq-hermes-cleanup-');
    getDb().prepare(`INSERT INTO agents (id, name, session_key, openclaw_agent_id, runtime_type, workspace_path) VALUES (1, 'Harlow', 'agent:agency-tooling-pm:main', 'agency-tooling-pm', 'hermes', ?)`).run(hermesHome);
    getDb().prepare(`INSERT INTO mcp_servers (id, slug, command, args) VALUES (30, 'agent-hq', 'node', '["server.js"]')`).run();
    getDb().prepare(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (1, 30)`).run();

    const result = syncAssignedMcpForAgent({
      db: getDb(),
      agentId: 1,
      materializeOpenClawGlobalConfig: true,
    });
    const openClawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(result.ok).toBe(true);
    expect(result.runtimeType).toBe('hermes');
    expect(openClawConfig.mcp.servers['agent-hq__agent-1']).toBeUndefined();
    expect(openClawConfig.mcp.servers['dev-environment-lease-manager__agent-1']).toBeUndefined();
    expect(openClawConfig.mcp.servers['agent-hq__agent-2']).toMatchObject({ command: 'node', args: ['other.js'] });
  });

  it('materializes assigned MCP servers into Hermes config.yaml while preserving external servers', () => {
    createRegistryTables();
    const hermesHome = makeTempDir('agent-hq-hermes-native-');
    const configPath = path.join(hermesHome, 'config.yaml');
    fs.writeFileSync(configPath, [
      'model:',
      '  default: gpt-5',
      'mcp_servers:',
      '  operator:',
      '    command: operator-mcp',
      '  agent-hq__agent-1:',
      '    command: stale-node',
      'agent_hq_managed_mcp_servers:',
      '  - agent-hq__agent-1',
      '',
    ].join('\n'), 'utf8');
    getDb().prepare("INSERT INTO agents (id, name, runtime_type) VALUES (1, 'Hermes Agent', 'hermes')").run();
    getDb().prepare("INSERT INTO mcp_servers (id, slug, command, args) VALUES (30, 'agent-hq', 'node', '[\"server.js\"]')").run();
    getDb().prepare("INSERT INTO mcp_servers (id, slug, command, args) VALUES (31, 'dev-environment-lease-manager', 'dev-env-lease-mcp', '[\"--stdio\"]')").run();
    getDb().prepare("INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (1, 30), (1, 31)").run();

    const result = materializeHermesMcpConfig({
      db: getDb(),
      agentId: 1,
      hermesHome,
    });
    const yaml = fs.readFileSync(configPath, 'utf8');

    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(result.serverNames).toEqual([
      'agent-hq__agent-1',
      'dev-environment-lease-manager__agent-1',
    ]);
    expect(yaml).toContain('model:\n  default: gpt-5');
    expect(yaml).toContain('  operator:\n    command: operator-mcp');
    expect(yaml).toContain('  "agent-hq__agent-1":');
    expect(yaml).toContain('    "command": "node"');
    expect(yaml).toContain('    "args":\n      - "server.js"');
    expect(yaml).toContain('  "dev-environment-lease-manager__agent-1":');
    expect(yaml).toContain('agent_hq_managed_mcp_servers:\n  - "agent-hq__agent-1"\n  - "dev-environment-lease-manager__agent-1"');
    expect(yaml).toContain('"AGENT_HQ_MCP_API_KEY": "ahq_mcp_');
    expect(yaml).not.toContain('stale-node');
  });

  it('resolves relative path-style Hermes MCP command and args against cwd', () => {
    createRegistryTables();
    const hermesHome = makeTempDir('agent-hq-hermes-relcmd-');
    const leaseDir = makeTempDir('agent-hq-lease-mgr-');
    const absoluteArg = path.join(leaseDir, 'already-absolute.json');
    getDb().prepare("INSERT INTO agents (id, name, runtime_type) VALUES (1, 'Hermes Agent', 'hermes')").run();
    // Relative path-style command (would fail with ENOENT in Hermes) plus a cwd...
    getDb().prepare(
      "INSERT INTO mcp_servers (id, slug, command, args, cwd) VALUES (31, 'dev-environment-lease-manager', '.venv/bin/dev-env-lease-mcp', ?, ?)",
    ).run(JSON.stringify(['--config', 'config/environments.json', '--stdio', 'bare-value', absoluteArg]), leaseDir);
    // ...and a bare PATH-resolved command which must be left untouched.
    getDb().prepare("INSERT INTO mcp_servers (id, slug, command, args) VALUES (30, 'agent-hq', 'node', '[\"server.js\"]')").run();
    getDb().prepare("INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (1, 30), (1, 31)").run();

    materializeHermesMcpConfig({ db: getDb(), agentId: 1, hermesHome });
    const yaml = fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8');

    expect(yaml).toContain(`"command": ${JSON.stringify(path.join(leaseDir, '.venv/bin/dev-env-lease-mcp'))}`);
    expect(yaml).not.toContain('".venv/bin/dev-env-lease-mcp"');
    expect(yaml).toContain(`- ${JSON.stringify(path.join(leaseDir, 'config/environments.json'))}`);
    expect(yaml).not.toContain('- "config/environments.json"');
    expect(yaml).toContain('- "--config"');
    expect(yaml).toContain('- "--stdio"');
    expect(yaml).toContain('- "bare-value"');
    expect(yaml).toContain(`- ${JSON.stringify(absoluteArg)}`);
    // Bare executable name stays as-is for PATH lookup.
    expect(yaml).toContain('"command": "node"');
  });

  it('rewrites the Agent HQ MCP node binary, entrypoint, and cwd to the running process', () => {
    createRegistryTables();
    const hermesHome = makeTempDir('agent-hq-hermes-portable-');
    getDb().prepare("INSERT INTO agents (id, name, runtime_type) VALUES (1, 'Hermes Agent', 'hermes')").run();
    getDb().prepare(
      "INSERT INTO mcp_servers (id, slug, command, args, cwd) VALUES (30, 'agent-hq', '/fake/host/bin/node', '[\"/fake/host/agent-hq/api/dist/mcp/server.js\"]', '/fake/host/agent-hq/api')",
    ).run();
    getDb().prepare("INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (1, 30)").run();

    materializeHermesMcpConfig({ db: getDb(), agentId: 1, hermesHome });
    const yaml = fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8');

    // Host-specific node binary -> the node running this process.
    expect(yaml).toContain(`"command": ${JSON.stringify(process.execPath)}`);
    expect(yaml).not.toContain('/fake/host/bin/node');
    // Host-specific server.js path -> resolved against this build's dist dir; absolute, ends in mcp/server.js.
    expect(yaml).not.toContain('/fake/host/agent-hq/api/dist/mcp/server.js');
    expect(yaml).toMatch(/"args":\n {6}- "\/.*\/mcp\/server\.js"/);
    // Host-specific cwd is rewritten away.
    expect(yaml).not.toContain('"cwd": "/fake/host/agent-hq/api"');
  });

  it('enables the agent-hq-mcp workspace bundle plugin idempotently', () => {
    const configPath = path.join(makeTempDir('agent-hq-openclaw-config-'), 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify({
      plugins: {
        allow: ['existing'],
        entries: {
          existing: { enabled: true },
        },
      },
    }), 'utf8');

    const first = ensureOpenClawMcpWorkspaceBundleEnabled(configPath);
    const second = ensureOpenClawMcpWorkspaceBundleEnabled(configPath);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(first.ok).toBe(true);
    expect(first.changed).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.changed).toBe(false);
    expect(config.plugins.entries.existing.enabled).toBe(true);
    expect(config.plugins.entries['agent-hq-mcp']).toEqual({ enabled: true });
    expect(config.plugins.allow).toEqual(['existing']);
  });

  it('preserves existing agent-hq-mcp plugin entry config when enabling it', () => {
    const configPath = path.join(makeTempDir('agent-hq-openclaw-config-'), 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          'agent-hq-mcp': { enabled: false, config: { timeoutSeconds: 180 } },
        },
      },
    }), 'utf8');

    const result = ensureOpenClawMcpWorkspaceBundleEnabled(configPath);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(config.plugins.entries['agent-hq-mcp']).toEqual({ enabled: true, config: { timeoutSeconds: 180 } });
  });

  it('does not create a global OpenClaw config only to register the workspace bundle plugin', () => {
    const configPath = path.join(makeTempDir('agent-hq-openclaw-config-'), 'openclaw.json');

    const result = ensureOpenClawMcpWorkspaceBundleEnabled(configPath);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('materializes the OpenClaw bundle into the workspace configured for the dispatch slug', () => {
    createRegistryTables();
    const root = makeTempDir('agent-hq-openclaw-dispatch-slug-');
    const openClawWorkspace = path.join(root, 'ws-lumen');
    const staleWorkspace = path.join(root, 'ws-stale');
    fs.mkdirSync(openClawWorkspace, { recursive: true });
    fs.mkdirSync(staleWorkspace, { recursive: true });
    const configPath = process.env.OPENCLAW_CONFIG_PATH!;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: { workspace: path.join(root, 'ws-default') },
        list: [
          { id: 'main', default: true },
          { id: 'lumen-frontend', workspace: openClawWorkspace },
        ],
      },
    }), 'utf8');
    getDb().prepare(
      `INSERT INTO agents (id, name, session_key, openclaw_agent_id, runtime_type, workspace_path)
       VALUES (1, 'Lumen', 'agent:pool-client:lumen-frontend:frontend-engineer:main', 'ecopool-frontend', 'openclaw', ?)`,
    ).run(staleWorkspace);
    getDb().prepare(`INSERT INTO mcp_servers (id, slug, command, args) VALUES (30, 'agent-hq', 'node', '["server.js"]')`).run();
    getDb().prepare(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (1, 30)`).run();

    const result = syncAssignedMcpForAgent({
      db: getDb(),
      agentId: 1,
      dispatchAgentSlug: 'lumen-frontend',
    });

    expect(result.ok).toBe(true);
    expect(result.workingDirectory).toBe(openClawWorkspace);
    expect(fs.existsSync(path.join(openClawWorkspace, '.openclaw', 'extensions', 'agent-hq-mcp', '.mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(staleWorkspace, '.mcp.json'))).toBe(false);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('differs from the OpenClaw workspace'),
    ]));
  });

  it('reconciles scoped global MCP config for assigned OpenClaw agents outside dispatch', () => {
    createRegistryTables();
    const root = makeTempDir('agent-hq-openclaw-routed-bundle-');
    const openClawWorkspace = path.join(root, 'ws-harlow');
    const storedWorkspace = path.join(root, 'stored-harlow');
    fs.mkdirSync(openClawWorkspace, { recursive: true });
    fs.mkdirSync(storedWorkspace, { recursive: true });
    const configPath = process.env.OPENCLAW_CONFIG_PATH!;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: { workspace: path.join(root, 'ws-default') },
        list: [
          { id: 'main', default: true },
          { id: 'agency-tooling-pm', workspace: openClawWorkspace },
        ],
      },
      mcp: {
        servers: {
          'agent-hq__agent-94': {
            command: 'node',
            args: ['server.js'],
            env: { AGENT_HQ_MCP_API_KEY: 'other-agent-key' },
            codex: { agents: ['cinder-backend'] },
          },
        },
      },
    }), 'utf8');
    getDb().prepare(
      `INSERT INTO agents (id, name, session_key, openclaw_agent_id, runtime_type, workspace_path)
       VALUES (99974444, 'Harlow', 'agent:agency-tooling-pm:main', 'agency-tooling-pm', 'openclaw', ?)`,
    ).run(storedWorkspace);
    getDb().prepare(`INSERT INTO mcp_servers (id, slug, command, args) VALUES (30, 'agent-hq', 'node', '["server.js"]')`).run();
    getDb().prepare(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (99974444, 30)`).run();
    const refreshOpenClawPluginRegistry = jest.fn(() => ({
      ok: true,
      command: 'openclaw',
      args: ['plugins', 'registry', '--refresh'],
      status: 0,
    }));

    const result = syncAssignedMcpForAgent({
      db: getDb(),
      agentId: 99974444,
      materializeOpenClawGlobalConfig: true,
      refreshOpenClawPluginRegistry,
    });
    const bundleConfig = JSON.parse(fs.readFileSync(path.join(openClawWorkspace, '.openclaw', 'extensions', 'agent-hq-mcp', '.mcp.json'), 'utf8'));
    const openClawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(result.ok).toBe(true);
    expect(result.workingDirectory).toBe(openClawWorkspace);
    expect(bundleConfig.mcpServers['agent-hq__agent-99974444'].env.AGENT_HQ_MCP_API_KEY).toMatch(/^ahq_mcp_/);
    expect(fs.existsSync(path.join(storedWorkspace, '.openclaw', 'extensions', 'agent-hq-mcp', '.mcp.json'))).toBe(false);
    expect(openClawConfig.plugins.entries['agent-hq-mcp']).toEqual({ enabled: true });
    expect(openClawConfig.mcp.servers['agent-hq__agent-99974444']).toMatchObject({
      command: 'node',
      args: ['server.js'],
      codex: { agents: ['agency-tooling-pm'] },
    });
    expect(openClawConfig.mcp.servers['agent-hq__agent-99974444'].env.AGENT_HQ_MCP_API_KEY).toBe(
      bundleConfig.mcpServers['agent-hq__agent-99974444'].env.AGENT_HQ_MCP_API_KEY,
    );
    expect(openClawConfig.mcp.servers['agent-hq__agent-94'].env.AGENT_HQ_MCP_API_KEY).toBe('other-agent-key');
    expect(refreshOpenClawPluginRegistry).toHaveBeenCalledTimes(1);
    expect(refreshOpenClawPluginRegistry).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 99974444,
      workingDirectory: openClawWorkspace,
      materializedCount: 1,
    }));
  });

  it('falls back to the session-key agent slug when openclaw_agent_id is not a configured OpenClaw agent', () => {
    createRegistryTables();
    const root = makeTempDir('agent-hq-openclaw-slug-fallback-');
    const openClawWorkspace = path.join(root, 'ws-lumen');
    fs.mkdirSync(openClawWorkspace, { recursive: true });
    const configPath = process.env.OPENCLAW_CONFIG_PATH!;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: { workspace: path.join(root, 'ws-default') },
        list: [{ id: 'lumen-frontend', workspace: openClawWorkspace }],
      },
    }), 'utf8');
    getDb().prepare(
      `INSERT INTO agents (id, name, session_key, openclaw_agent_id, runtime_type, workspace_path)
       VALUES (1, 'Lumen', 'agent:pool-client:lumen-frontend:frontend-engineer:main', 'ecopool-frontend', 'openclaw', ?)`,
    ).run(openClawWorkspace);
    getDb().prepare(`INSERT INTO mcp_servers (id, slug, command, args) VALUES (30, 'agent-hq', 'node', '["server.js"]')`).run();
    getDb().prepare(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (1, 30)`).run();

    const result = syncAssignedMcpForAgent({
      db: getDb(),
      agentId: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.workingDirectory).toBe(openClawWorkspace);
    expect(fs.existsSync(path.join(openClawWorkspace, '.openclaw', 'extensions', 'agent-hq-mcp', '.mcp.json'))).toBe(true);
  });

  it('fails closed instead of materializing an OpenClaw bundle into a workspace shared by another agent', () => {
    createRegistryTables();
    const sharedWorkspace = makeTempDir('agent-hq-openclaw-shared-');
    getDb().prepare(
      `INSERT INTO agents (id, name, runtime_type, workspace_path) VALUES (1, 'One', 'openclaw', ?), (2, 'Two', 'openclaw', ?)`,
    ).run(sharedWorkspace, sharedWorkspace);
    getDb().prepare(`INSERT INTO mcp_servers (id, slug, command, args) VALUES (30, 'agent-hq', 'node', '["server.js"]')`).run();
    getDb().prepare(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (1, 30)`).run();

    const result = syncAssignedMcpForAgent({
      db: getDb(),
      agentId: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.skipped).toBe('shared_workspace');
    expect(result.error).toContain('shared with agent(s) #2');
    expect(fs.existsSync(path.join(sharedWorkspace, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(sharedWorkspace, '.openclaw', 'extensions', 'agent-hq-mcp', '.mcp.json'))).toBe(false);
  });
});
