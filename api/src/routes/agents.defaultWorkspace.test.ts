import { setupTestDb, teardownTestDb } from '../db/testDb';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../db/client';
import agentsRouter from './agents';

let tempDir: string;
const ORIGINAL_WORKSPACE_PARENT = process.env.AGENT_HQ_WORKSPACE_PARENT;
const ORIGINAL_OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH;
const ORIGINAL_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH =
  process.env.AGENT_HQ_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH;

async function resetDb(): Promise<void> {
  await setupTestDb();
  process.env.OPENCLAW_CONFIG_PATH = path.join(tempDir, 'openclaw.json');
  process.env.AGENT_HQ_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH = '1';
  // Relocate the workspace parent so the suite never writes into the real ~/.agent-hq.
  process.env.AGENT_HQ_WORKSPACE_PARENT = path.join(tempDir, 'workspaces');

  const db = getDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
  await db.run(
    `INSERT INTO provider_config (tenant_id, slug, status) VALUES (1, ?, ?)`,
    'anthropic',
    'connected',
  );
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

async function createAgent(baseUrl: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/v1/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe('local-process runtimes get an Agent HQ-owned default workspace', () => {
  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-claude-workspace-'));
    await resetDb();
  });

  afterEach(async () => {
    await teardownTestDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
    for (const [key, original] of [
      ['AGENT_HQ_WORKSPACE_PARENT', ORIGINAL_WORKSPACE_PARENT],
      ['OPENCLAW_CONFIG_PATH', ORIGINAL_OPENCLAW_CONFIG_PATH],
      ['AGENT_HQ_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH', ORIGINAL_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH],
    ] as const) {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it('defaults workspace_path under the Agent HQ parent, not ~/.openclaw', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const created = await createAgent(baseUrl, {
        name: 'Claude Builder',
        runtime_type: 'claude-code',
        preferred_provider: 'anthropic',
      });

      expect(created.status).toBe(201);
      const workspacePath = created.body.workspace_path as string;
      expect(workspacePath).toBe(path.join(tempDir, 'workspaces', 'claude-builder'));
      expect(workspacePath).not.toContain('.openclaw');
      // Pre-created so the first dispatch has a real cwd rather than an ENOENT spawn.
      expect(fs.existsSync(workspacePath)).toBe(true);
    } finally {
      await stopTestServer(server);
    }
  });

  it('never overrides an explicitly supplied workspace_path', async () => {
    const { server, baseUrl } = await startTestServer();
    const explicit = path.join(tempDir, 'explicit-workspace');
    try {
      const created = await createAgent(baseUrl, {
        name: 'Explicit Claude',
        runtime_type: 'claude-code',
        preferred_provider: 'anthropic',
        workspace_path: explicit,
      });

      expect(created.status).toBe(201);
      expect(created.body.workspace_path).toBe(explicit);
    } finally {
      await stopTestServer(server);
    }
  });

  it.each(['openclaw', 'codex', 'hermes'])(
    'applies the same Agent HQ-owned default to the %s runtime',
    async (runtimeType) => {
      const { server, baseUrl } = await startTestServer();
      try {
        const created = await createAgent(baseUrl, {
          name: `Runtime ${runtimeType}`,
          runtime_type: runtimeType,
          preferred_provider: 'anthropic',
          // Hermes independently requires a profile; unrelated to the workspace default.
          ...(runtimeType === 'hermes' ? { runtime_config: { profile: 'default' } } : {}),
        });

        expect({ status: created.status, error: created.body.error }).toEqual({ status: 201, error: undefined });
        const workspacePath = created.body.workspace_path as string;
        expect(workspacePath).toBe(path.join(tempDir, 'workspaces', `runtime-${runtimeType}`));
        expect(workspacePath).not.toContain('.openclaw');
        expect(fs.existsSync(workspacePath)).toBe(true);
      } finally {
        await stopTestServer(server);
      }
    },
  );

  it('leaves remote runtimes without a cwd untouched', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const created = await createAgent(baseUrl, {
        name: 'Remote Webhook',
        runtime_type: 'webhook',
        preferred_provider: 'anthropic',
      });

      expect(created.status).toBe(201);
      expect(created.body.workspace_path ?? '').toBe('');
      expect(fs.existsSync(path.join(tempDir, 'workspaces', 'remote-webhook'))).toBe(false);
    } finally {
      await stopTestServer(server);
    }
  });
});
