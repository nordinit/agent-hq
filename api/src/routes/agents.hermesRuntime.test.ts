import { setupTestDb, teardownTestDb } from '../db/testDb';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../db/client';
import agentsRouter from './agents';

let tempDir: string;
let dbPath: string;
const ORIGINAL_OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH;
const ORIGINAL_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH = process.env.AGENT_HQ_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH;

async function resetDb(): Promise<void> {
  await setupTestDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-hermes-runtime-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');
  process.env.OPENCLAW_CONFIG_PATH = path.join(tempDir, 'openclaw.json');
  process.env.AGENT_HQ_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH = '1';

  const db = getDb();


  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
  await db.run(`INSERT INTO provider_config (tenant_id, slug, status) VALUES (1, ?, ?), (1, ?, ?)`, 'openai', 'connected', 'openai-codex', 'connected');
}

async function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/agents', agentsRouter);
  const server = await new Promise<Server>((resolve, reject) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
    bound.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('agents Hermes runtime CRUD support', () => {
  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-hermes-runtime-'));
    dbPath = path.join(tempDir, 'agent-hq-test.db');
    await resetDb();
  });

  afterEach(async () => {
    await teardownTestDb();
    if (ORIGINAL_OPENCLAW_CONFIG_PATH === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
    else process.env.OPENCLAW_CONFIG_PATH = ORIGINAL_OPENCLAW_CONFIG_PATH;
    if (ORIGINAL_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH === undefined) delete process.env.AGENT_HQ_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH;
    else process.env.AGENT_HQ_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH = ORIGINAL_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('provision-full creates a fully initialized Hermes agent without OpenClaw native registration', async () => {
    const db = getDb();
    const workspacePath = path.join(tempDir, 'workspace-hermes-full');
    const hermesHome = path.join(tempDir, 'hermes-home');
    await db.run(`INSERT INTO mcp_servers (id, tenant_id, name, slug, command, args) VALUES (?, 1, ?, ?, ?, ?)`, 30, 'Agent HQ', 'agent-hq', 'node', '["server.js"]');

    const runtimeConfig = {
      profile: 'agent-hq-hermes-full',
      hermesHome,
      invocationMode: 'z',
      sessionMode: 'fresh',
    };

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents/provision-full`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Hermes Full',
          role: 'Backend Engineer',
          session_key: 'agent:hermes-full:main',
          workspace_path: workspacePath,
          runtime_type: 'hermes',
          runtime_config: runtimeConfig,
          mcp_server_ids: [30],
        }),
      });
      const body = await response.json() as Record<string, any>;

      if (response.status !== 201) {
        throw new Error(`Expected 201, received ${response.status}: ${JSON.stringify(body)}`);
      }

      expect(response.status).toBe(201);
      expect(body.ok).toBe(true);
      expect(body.agent.runtime_type).toBe('hermes');
      expect(body.agent.runtime_config).toEqual(runtimeConfig);
      expect(body.agent.openclaw_agent_id).toBeNull();
      expect(body.report.openclaw.status).toBe('skipped');
      expect(body.report.runtime.details.runtime_type).toBe('hermes');
      expect(body.report.runtime.details.auth_providers_synced).toBeUndefined();
      expect(body.report.auth.status).toBe('skipped');
      expect(body.report.auth.details.runtime_auth_providers_synced).toEqual([]);

      const row = await db.get(`SELECT runtime_type, runtime_config, openclaw_agent_id, workspace_path FROM agents WHERE session_key = ?`, 'agent:hermes-full:main') as {
          runtime_type: string;
          runtime_config: string | null;
          openclaw_agent_id: string | null;
          workspace_path: string;
        };
      expect(row.runtime_type).toBe('hermes');
      expect(JSON.parse(row.runtime_config ?? 'null')).toEqual(runtimeConfig);
      expect(row.openclaw_agent_id).toBeNull();
      expect(row.workspace_path).toBe(workspacePath);

      for (const doc of ['SOUL.md', 'AGENTS.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md', 'MEMORY.md', 'LESSONS.md']) {
        expect(fs.existsSync(path.join(workspacePath, doc))).toBe(true);
      }
      expect(fs.existsSync(path.join(workspacePath, 'memory'))).toBe(true);

      const workspaceMcp = JSON.parse(fs.readFileSync(path.join(workspacePath, '.mcp.json'), 'utf8'));
      expect(workspaceMcp.mcpServers['agent-hq__agent-1']).toMatchObject({ command: 'node', args: ['server.js'] });
      expect(workspaceMcp.mcpServers['agent-hq__agent-1'].env.AGENT_HQ_MCP_API_KEY).toMatch(/^ahq_mcp_/);
      expect(fs.existsSync(path.join(hermesHome, '.agent-hq', 'assigned-skills.json'))).toBe(true);

      const openClawConfig = fs.existsSync(process.env.OPENCLAW_CONFIG_PATH!)
        ? JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH!, 'utf8'))
        : {};
      const registered = ((openClawConfig.agents?.list ?? []) as Array<Record<string, unknown>>)
        .some(entry => entry.id === 'hermes-full');
      expect(registered).toBe(false);
    } finally {
      await stopTestServer(server);
    }
  });

  it('provision-full syncs openai-codex credentials into the Hermes profile auth store', async () => {
    const db = getDb();
    const workspacePath = path.join(tempDir, 'workspace-hermes-codex-auth');
    const hermesHome = path.join(tempDir, 'hermes-home-codex-auth');
    const expiresAt = Date.now() + 60 * 60 * 1000;
    await db.run(`
      UPDATE provider_config
      SET display_name = ?, status = ?, config = ?
      WHERE tenant_id = 1 AND slug = 'openai-codex'
    `, 'OpenAI Codex (OAuth)', 'connected', JSON.stringify({
            auth_type: 'oauth',
            provider: 'openai-codex',
            expires_at: expiresAt,
            tokens: {
              access_token: 'test-access-token',
              refresh_token: 'test-refresh-token',
              account_id: 'acct-test',
            },
          }));

    const runtimeConfig = {
      profile: 'agent-hq-hermes-codex-auth',
      hermesHome,
      provider: 'openai-codex',
      invocationMode: 'z',
      sessionMode: 'fresh',
    };

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents/provision-full`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Hermes Codex Auth',
          role: 'QA',
          session_key: 'agent:hermes-codex-auth:main',
          workspace_path: workspacePath,
          runtime_type: 'hermes',
          runtime_config: runtimeConfig,
          preferred_provider: 'openai-codex',
        }),
      });
      const body = await response.json() as Record<string, any>;

      expect(response.status).toBe(201);
      expect(body.ok).toBe(true);
      expect(body.report.openclaw.status).toBe('skipped');
      expect(body.report.auth.status).toBe('synced');
      expect(body.report.auth.details.runtime_auth_providers_synced).toEqual(['openai-codex']);
      expect(body.report.auth.details.openclaw_auth_providers_synced).toEqual([]);

      const authPath = path.join(hermesHome, 'profiles', 'agent-hq-hermes-codex-auth', 'auth.json');
      expect(body.report.auth.details.runtime_auth_path).toBe(authPath);
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      expect(auth.active_provider).toBe('openai-codex');
      expect(auth.providers['openai-codex'].tokens).toMatchObject({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        account_id: 'acct-test',
      });
      expect(auth.credential_pool['openai-codex'][0]).toMatchObject({
        auth_type: 'oauth',
        source: 'agent-hq',
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
      });
      expect(body.report.verification.details.runtime_auth_status).toBe('synced');
      expect(body.report.verification.details.runtime_auth_providers_synced).toEqual(['openai-codex']);
    } finally {
      await stopTestServer(server);
    }
  });

  it('provision-full fails explicitly when Hermes openai-codex auth cannot be prepared', async () => {
    const db = getDb();
    const workspacePath = path.join(tempDir, 'workspace-hermes-missing-codex-auth');
    const hermesHome = path.join(tempDir, 'hermes-home-missing-codex-auth');
    await db.run(`
      UPDATE provider_config
      SET display_name = ?, status = ?, config = ?
      WHERE tenant_id = 1 AND slug = 'openai-codex'
    `, 'OpenAI Codex (OAuth)', 'connected', '{}');

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents/provision-full`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Hermes Missing Codex Auth',
          session_key: 'agent:hermes-missing-codex-auth:main',
          workspace_path: workspacePath,
          runtime_type: 'hermes',
          runtime_config: {
            profile: 'agent-hq-hermes-missing-codex-auth',
            hermesHome,
            invocationMode: 'z',
            sessionMode: 'fresh',
            provider: 'openai-codex',
          },
          preferred_provider: 'openai-codex',
        }),
      });
      const body = await response.json() as Record<string, any>;

      if (!body.report?.auth) {
        throw new Error(`Expected auth report, received ${response.status}: ${JSON.stringify(body)}`);
      }

      expect(response.status).toBe(500);
      expect(body.ok).toBe(false);
      expect(body.report.auth.status).toBe('failed');
      expect(body.report.auth.details.runtime_auth_path).toBe(path.join(hermesHome, 'profiles', 'agent-hq-hermes-missing-codex-auth', 'auth.json'));
      expect(body.report.auth.details.runtime_auth_providers_synced).toEqual([]);
      expect(body.report.provision.error).toContain('No OAuth profile "openai-codex:default"');
      expect(body.report.verification).toBeUndefined();
    } finally {
      await stopTestServer(server);
    }
  });

  it('provision-full rejects invalid Hermes runtime_config with a clear 400', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents/provision-full`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Broken Hermes Full',
          workspace_path: path.join(tempDir, 'workspace-broken-hermes-full'),
          runtime_type: 'hermes',
          runtime_config: {},
        }),
      });
      const body = await response.json() as Record<string, any>;

      expect(response.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.report.validation.error).toBe('runtime_config.profile is required for hermes runtime');
    } finally {
      await stopTestServer(server);
    }
  });

  it('provision-full preserves OpenClaw native registration behavior', async () => {
    const workspacePath = path.join(tempDir, 'workspace-openclaw-full');

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents/provision-full`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'OpenClaw Full',
          role: 'Backend Engineer',
          session_key: 'agent:openclaw-full:main',
          workspace_path: workspacePath,
          openclaw_agent_id: 'openclaw-full',
          runtime_type: 'openclaw',
        }),
      });
      const body = await response.json() as Record<string, any>;

      expect(response.status).toBe(201);
      expect(body.ok).toBe(true);
      expect(body.agent.runtime_type).toBe('openclaw');
      expect(body.agent.openclaw_agent_id).toBe('openclaw-full');
      expect(body.report.openclaw.status).toBe('created');
      expect(body.report.openclaw.details.openclaw_auth_providers_synced).toEqual([]);
      expect(body.report.auth.status).toBe('skipped');
      expect(body.report.verification.details.openclaw_registered).toBe(true);

      const openClawConfig = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH!, 'utf8'));
      expect(openClawConfig.agents.list).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'openclaw-full',
          workspace: workspacePath,
        }),
      ]));
    } finally {
      await stopTestServer(server);
    }
  });

  it('creates Hermes agents and round-trips runtime_config through detail fetches', async () => {
    const db = getDb();

    const hermesConfig = {
      profile: 'agent-hq-cinder-backend',
      invocationMode: 'z',
      sessionMode: 'fresh',
      hermesBin: '/usr/local/bin/hermes',
      hermesHome: '/tmp/hermes-cinder',
      provider: 'openai',
      model: 'openai/gpt-5',
      ignoreUserConfig: true,
      ignoreRules: true,
      extraArgs: ['--json'],
      env: {
        HERMES_LOG_LEVEL: 'debug',
      },
      heartbeatIntervalMs: 45000,
      killGraceMs: 5000,
    };

    const { server, baseUrl } = await startTestServer();
    try {
      const createResponse = await fetch(`${baseUrl}/api/v1/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Hermes Worker',
          role: 'Backend Engineer',
          session_key: 'agent:hermes-worker:main',
          runtime_type: 'hermes',
          runtime_config: hermesConfig,
          preferred_provider: 'openai',
        }),
      });
      const createdBody = await createResponse.json() as Record<string, unknown>;

      expect(createResponse.status).toBe(201);
      expect(createdBody.runtime_type).toBe('hermes');
      expect(createdBody.runtime_config).toEqual(hermesConfig);

      const createdRow = await db.get(`SELECT id, runtime_type, runtime_config FROM agents WHERE session_key = ?`, 'agent:hermes-worker:main') as {
        id: number;
        runtime_type: string;
        runtime_config: string | null;
      };
      expect(createdRow.runtime_type).toBe('hermes');
      expect(JSON.parse(createdRow.runtime_config ?? 'null')).toEqual(hermesConfig);

      const fetchResponse = await fetch(`${baseUrl}/api/v1/agents/${createdRow.id}`);
      const fetchedBody = await fetchResponse.json() as Record<string, unknown>;

      expect(fetchResponse.status).toBe(200);
      expect(fetchedBody.runtime_type).toBe('hermes');
      expect(fetchedBody.runtime_config).toEqual(hermesConfig);
    } finally {
      await stopTestServer(server);
    }
  });

  it('creates Hermes agents when preferred_provider is omitted and no providers are connected', async () => {
    const db = getDb();
    await db.run(`DELETE FROM provider_config`);

    const hermesConfig = {
      profile: 'agent-hq-hermes-qa',
      invocationMode: 'z',
      sessionMode: 'fresh',
      command: 'hermes',
    };

    const { server, baseUrl } = await startTestServer();
    try {
      const createResponse = await fetch(`${baseUrl}/api/v1/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Hermes QA Fixture 508',
          session_key: 'agent:hermes-qa-fixture:main',
          runtime_type: 'hermes',
          runtime_config: hermesConfig,
        }),
      });
      const createdBody = await createResponse.json() as Record<string, unknown>;

      expect(createResponse.status).toBe(201);
      expect(createdBody.runtime_type).toBe('hermes');
      expect(createdBody.runtime_config).toEqual(hermesConfig);
      expect(createdBody.preferred_provider).toBe('anthropic');

      const createdRow = await db.get(`SELECT preferred_provider, model FROM agents WHERE session_key = ?`, 'agent:hermes-qa-fixture:main') as {
        preferred_provider: string;
        model: string | null;
      };
      expect(createdRow.preferred_provider).toBe('anthropic');
      expect(createdRow.model).toBeNull();
    } finally {
      await stopTestServer(server);
    }
  });

  it('updates existing agents to Hermes and preserves the new config on subsequent reads', async () => {
    const db = getDb();
    await db.run(`
      INSERT INTO agents (
        id, tenant_id, name, role, session_key, runtime_type, runtime_config, preferred_provider, project_id
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
    `, 94, 'Cinder', 'Backend Engineer', 'agent:cinder:main', 'webhook', JSON.stringify({ dispatchUrl: 'http://localhost:3900/hook' }), 'openai', null);

    const hermesConfig = {
      profile: 'agent-hq-cinder-backend',
      invocationMode: 'chat-q',
      sessionMode: 'fresh',
      extraArgs: ['--json'],
    };

    const { server, baseUrl } = await startTestServer();
    try {
      const updateResponse = await fetch(`${baseUrl}/api/v1/agents/94`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runtime_type: 'hermes',
          runtime_config: hermesConfig,
          preferred_provider: null,
        }),
      });
      const updatedBody = await updateResponse.json() as Record<string, unknown>;

      expect(updateResponse.status).toBe(200);
      expect(updatedBody.runtime_type).toBe('hermes');
      expect(updatedBody.runtime_config).toEqual(hermesConfig);

      const stored = await db.get(`SELECT runtime_type, runtime_config, preferred_provider, model FROM agents WHERE id = 94`) as {
        runtime_type: string;
        runtime_config: string | null;
        preferred_provider: string;
        model: string | null;
      };
      expect(stored.runtime_type).toBe('hermes');
      expect(JSON.parse(stored.runtime_config ?? 'null')).toEqual(hermesConfig);
      expect(stored.preferred_provider).toBe('openai');
      expect(stored.model).toBeNull();

      const fetchResponse = await fetch(`${baseUrl}/api/v1/agents/94`);
      const fetchedBody = await fetchResponse.json() as Record<string, unknown>;

      expect(fetchResponse.status).toBe(200);
      expect(fetchedBody.runtime_type).toBe('hermes');
      expect(fetchedBody.runtime_config).toEqual(hermesConfig);
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects invalid Hermes runtime_config during create and update validation', async () => {
    const db = getDb();
    await db.run(`INSERT INTO agents (id, tenant_id, name, role, session_key, runtime_type, preferred_provider) VALUES (?, 1, ?, ?, ?, ?, ?)`, 94, 'Cinder', 'Backend Engineer', 'agent:cinder:main', 'webhook', 'openai');

    const { server, baseUrl } = await startTestServer();
    try {
      const createResponse = await fetch(`${baseUrl}/api/v1/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Broken Hermes Worker',
          session_key: 'agent:broken-hermes:main',
          runtime_type: 'hermes',
          runtime_config: {},
          preferred_provider: 'openai',
        }),
      });
      const createBody = await createResponse.json() as Record<string, unknown>;

      expect(createResponse.status).toBe(400);
      expect(createBody.error).toBe('runtime_config.profile is required for hermes runtime');

      const updateResponse = await fetch(`${baseUrl}/api/v1/agents/94`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runtime_type: 'hermes',
          runtime_config: {
            profile: 'agent-hq-cinder-backend',
            extraArgs: ['--resume'],
          },
        }),
      });
      const updateBody = await updateResponse.json() as Record<string, unknown>;

      expect(updateResponse.status).toBe(400);
      expect(updateBody.error).toBe('Hermes runtime does not allow extraArgs entry "--resume" in V1');
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects removed webhook lifecycleProxy runtime_config', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const createResponse = await fetch(`${baseUrl}/api/v1/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Webhook Worker',
          session_key: 'agent:webhook-worker:main',
          runtime_type: 'webhook',
          runtime_config: {
            dispatchUrl: 'https://remote.example/dispatch',
            lifecycleProxy: true,
          },
          preferred_provider: 'openai',
        }),
      });
      const createBody = await createResponse.json() as Record<string, unknown>;

      expect(createResponse.status).toBe(400);
      expect(createBody.error).toBe('runtime_config.lifecycleProxy is no longer supported for webhook runtime; use Agent HQ MCP/capability lifecycle tools instead');
    } finally {
      await stopTestServer(server);
    }
  });
});
