import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import agentsRouter from './agents';
import artifactsRouter from './artifacts';

const ENV_KEYS = [
  'AGENT_HQ_WORKSPACE_PARENT',
  'WORKSPACE_PARENT',
  'AGENT_HQ_ALLOWED_WORKSPACE_ROOTS',
  'OPENCLAW_CONFIG_PATH',
  'AGENT_HQ_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH',
] as const;

describe('agent workspace confinement', () => {
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let tempDir = '';
  let parent = '';
  let outside = '';
  let server: Server;
  let baseUrl = '';

  beforeEach(async () => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-confinement-')));
    parent = path.join(tempDir, 'workspaces');
    outside = path.join(tempDir, 'outside');
    fs.mkdirSync(parent);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'host secret');
    process.env.AGENT_HQ_WORKSPACE_PARENT = parent;
    process.env.WORKSPACE_PARENT = path.join(tempDir, 'openclaw');
    delete process.env.AGENT_HQ_ALLOWED_WORKSPACE_ROOTS;
    process.env.OPENCLAW_CONFIG_PATH = path.join(tempDir, 'openclaw.json');
    process.env.AGENT_HQ_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH = '1';

    const db = await setupTestDb();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
    await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
    await db.run(`INSERT INTO provider_config (tenant_id, slug, status) VALUES (1, 'anthropic', 'connected')`);

    const app = express();
    app.use(express.json());
    app.use('/api/v1/agents', agentsRouter);
    app.use('/api/v1/artifacts', artifactsRouter);
    server = await new Promise<Server>((resolve) => {
      const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await teardownTestDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  const send = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };

  const createClaudeAgent = (name: string, workspacePath?: string) => send('POST', '/api/v1/agents', {
    name,
    runtime_type: 'claude-code',
    preferred_provider: 'anthropic',
    ...(workspacePath === undefined ? {} : { workspace_path: workspacePath }),
  });

  it('refuses to create or move an agent workspace outside the workspace roots', async () => {
    for (const workspace of ['/', '/etc', outside, parent, `${parent}/../outside`]) {
      const created = await createClaudeAgent(`Refused ${workspace}`, workspace);
      expect({ workspace, status: created.status }).toEqual({ workspace, status: 400 });
    }

    const created = await createClaudeAgent('Inside', `${parent}/inside/../cinder`);
    expect(created.status).toBe(201);
    expect(created.body.workspace_path).toBe(path.join(parent, 'cinder'));

    const moved = await send('PUT', `/api/v1/agents/${created.body.id}`, { workspace_path: '/' });
    expect(moved.status).toBe(400);
    expect(moved.body.error).toContain('AGENT_HQ_ALLOWED_WORKSPACE_ROOTS');
  });

  it('lets the operator allow another root, and keeps an existing out-of-policy value editable', async () => {
    process.env.AGENT_HQ_ALLOWED_WORKSPACE_ROOTS = outside;
    const created = await createClaudeAgent('Operator Root', path.join(outside, 'repo'));
    expect(created.status).toBe(201);

    delete process.env.AGENT_HQ_ALLOWED_WORKSPACE_ROOTS;
    // The editor sends the stored value back unchanged; that is not a move.
    const edited = await send('PUT', `/api/v1/agents/${created.body.id}`, {
      workspace_path: created.body.workspace_path,
      job_instructions: 'Still editable.',
    });
    expect(edited.status).toBe(200);
  });

  it('refuses artifact access to a workspace outside policy and to symlinks leaving the workspace', async () => {
    const db = getDb();
    // A value stored before confinement existed.
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, workspace_path) VALUES (70, 1, 'Legacy', 'agent:legacy:main', ?)`, outside);
    const legacy = await send('GET', '/api/v1/artifacts/file?agentId=70&path=secret.txt');
    expect(legacy.status).toBe(403);

    const workspace = path.join(parent, 'linked');
    fs.mkdirSync(workspace);
    fs.symlinkSync(outside, path.join(workspace, 'escape'));
    fs.writeFileSync(path.join(workspace, 'notes.md'), 'inside');
    fs.mkdirSync(path.join(parent, 'linked-sibling'));
    fs.writeFileSync(path.join(parent, 'linked-sibling', 'other.md'), 'sibling');
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, workspace_path) VALUES (71, 1, 'Linked', 'agent:linked:main', ?)`, workspace);

    await expect(send('GET', '/api/v1/artifacts/file?agentId=71&path=notes.md').then((r) => r.body.content)).resolves.toBe('inside');
    for (const escape of ['escape/secret.txt', '../outside/secret.txt', '../linked-sibling/other.md', outside]) {
      const res = await send('GET', `/api/v1/artifacts/file?agentId=71&path=${encodeURIComponent(escape)}`);
      expect({ escape, status: res.status }).toEqual({ escape, status: 403 });
    }
    const write = await send('PUT', `/api/v1/artifacts/file?agentId=71&path=${encodeURIComponent('escape/planted.txt')}`, { content: 'x' });
    expect(write.status).toBe(403);
    expect(fs.existsSync(path.join(outside, 'planted.txt'))).toBe(false);
  });

  it('confines working_directory overrides for skill and MCP sync', async () => {
    const created = await createClaudeAgent('Sync Target');
    for (const route of ['skills/sync', 'mcp/sync']) {
      const res = await send('POST', `/api/v1/agents/${created.body.id}/${route}`, { working_directory: outside });
      expect({ route, status: res.status }).toEqual({ route, status: 400 });
    }
  });
});
