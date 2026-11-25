import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import setupRouter from './setup';

/**
 * Starter agents run on Claude Code by default, or on Codex or OpenClaw. A fake CLI on PATH stands
 * in for an installed runtime, and a credential file in its config home for a login.
 */
describe('starter runtimes', () => {
  const saved = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  const tempDirs: string[] = [];
  let server: Server;
  let base: string;

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-starter-runtime-'));
    tempDirs.push(dir);
    return dir;
  }

  /** Puts only these fake CLIs on PATH, so a real install on this machine does not leak in. */
  function installClis(clis: Record<string, string>): void {
    const bin = tempDir();
    for (const [name, body] of Object.entries(clis)) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, 'utf8');
      fs.chmodSync(path.join(bin, name), 0o755);
    }
    process.env.PATH = bin;
  }

  function logIn(variable: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME', file: string): void {
    const home = tempDir();
    fs.writeFileSync(path.join(home, file), JSON.stringify({ placeholder: true }));
    process.env[variable] = home;
  }

  beforeEach(async () => {
    const db = await setupTestDb();
    await db.run("INSERT INTO tenants(id,name,slug,is_default) VALUES(1,'One','one',1)");
    await db.run("INSERT INTO app_settings(key,value) VALUES('default_tenant_id','1'),('active_tenant_id','1')");
    process.env.CLAUDE_CONFIG_DIR = tempDir();
    process.env.CODEX_HOME = tempDir();
    const app = express();
    app.use(express.json());
    app.use('/api/v1/setup', setupRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/setup`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await teardownTestDb();
    for (const [key, value] of Object.entries(saved)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function post(route: string, body: unknown) {
    const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }

  const payload = { template_key: 'development', project_name: 'Acme', workflow_name: 'Delivery' };

  it('recommends Claude Code and reports what each runtime needs on this machine', async () => {
    installClis({ claude: 'exit 1' });
    logIn('CLAUDE_CONFIG_DIR', '.credentials.json');

    const response = await fetch(`${base}/starter-runtimes`);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.recommended).toBe('claude-code');
    expect(body.suggested).toBe('claude-code');
    const byType = Object.fromEntries(body.options.map((option: any) => [option.type, option]));
    expect(byType['claude-code']).toEqual(expect.objectContaining({
      recommended: true,
      status: 'ready',
      login: expect.objectContaining({ runtime_type: 'claude-code', provider_slug: 'anthropic', external_ref: expect.stringMatching(/^claude-code:/) }),
    }));
    expect(byType.codex).toEqual(expect.objectContaining({
      recommended: false,
      status: 'not_installed',
      fix: ['npm install -g @openai/codex', 'codex login'],
    }));
    expect(byType.openclaw).toEqual(expect.objectContaining({ status: 'needs_setup' }));
  });

  it('suggests a ready runtime when Claude Code is not', async () => {
    installClis({ codex: 'exit 1' });
    logIn('CODEX_HOME', 'auth.json');
    const body = await (await fetch(`${base}/starter-runtimes`)).json() as any;
    expect(body.recommended).toBe('claude-code');
    expect(body.suggested).toBe('codex');
  });

  it('puts the starter agents on Claude Code by default, with the Claude Code login on this machine', async () => {
    installClis({ claude: 'exit 1' });
    logIn('CLAUDE_CONFIG_DIR', '.credentials.json');

    const preview = await post('/starter-plan/preview', payload);
    expect(preview.status).toBe(200);
    const plan = preview.body.plan;
    // No model provider has to be connected: the Claude Code login is the provider.
    expect(plan.compatibility).toEqual(expect.objectContaining({ ok: true, runtime: 'claude-code', errors: [] }));
    expect(plan.runtime).toEqual(expect.objectContaining({ type: 'claude-code', status: 'ready' }));
    expect(plan.agents.length).toBeGreaterThan(0);
    for (const agent of plan.agents) {
      expect(agent).toEqual(expect.objectContaining({ runtime_type: 'claude-code', preferred_provider: 'anthropic', model: null }));
    }
    expect(plan.model_routing).toEqual([]);
    expect(plan.preview.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource: 'provider_connection', name: plan.runtime.login.display_name }),
    ]));

    const applied = await post('/starter-plan/apply', payload);
    expect(applied.status).toBe(201);
    const connectionId = applied.body.provider_connection_id;
    const connection = await getDb().get<Record<string, unknown>>('SELECT runtime_type, provider_slug, auth_mode, external_ref, status FROM provider_connections WHERE id = ?', connectionId);
    expect(connection).toEqual({
      runtime_type: 'claude-code', provider_slug: 'anthropic', auth_mode: 'subscription', external_ref: plan.runtime.login.external_ref, status: 'connected',
    });
    const agents = await getDb().all<{ runtime_type: string; provider_connection_id: number }>(
      'SELECT runtime_type, provider_connection_id FROM agents WHERE project_id = ?', applied.body.project_id,
    );
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) expect(agent).toEqual({ runtime_type: 'claude-code', provider_connection_id: connectionId });

    // A second setup reuses the same login instead of recording it again.
    const again = await post('/starter-plan/apply', { ...payload, project_name: 'Second' });
    expect(again.status).toBe(201);
    expect(again.body.provider_connection_id).toBe(connectionId);
  });

  it('puts the starter agents on Codex when chosen', async () => {
    installClis({ codex: 'exit 1' });
    logIn('CODEX_HOME', 'auth.json');

    const applied = await post('/starter-plan/apply', { ...payload, runtime_type: 'codex' });
    expect(applied.status).toBe(201);
    const agents = await getDb().all<{ runtime_type: string; preferred_provider: string; provider_connection_id: number }>(
      'SELECT runtime_type, preferred_provider, provider_connection_id FROM agents WHERE project_id = ?', applied.body.project_id,
    );
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(agent).toEqual({ runtime_type: 'codex', preferred_provider: 'openai-codex', provider_connection_id: applied.body.provider_connection_id });
    }
    expect(await getDb().get('SELECT runtime_type, provider_slug FROM provider_connections WHERE id = ?', applied.body.provider_connection_id))
      .toEqual({ runtime_type: 'codex', provider_slug: 'openai-codex' });
  });

  it('says what to run when Claude Code is missing or logged out, and creates nothing', async () => {
    installClis({});
    const missing = await post('/starter-plan/apply', payload);
    expect(missing.status).toBe(422);
    expect(missing.body.compatibility.errors.join('\n')).toBe(
      'Claude Code is not installed on this machine. Run: npm install -g @anthropic-ai/claude-code, then claude auth login.',
    );

    installClis({ claude: `printf '%s\\n' '{"loggedIn":false}'` });
    const loggedOut = await post('/starter-plan/apply', payload);
    expect(loggedOut.status).toBe(422);
    expect(loggedOut.body.compatibility.errors.join('\n')).toBe('Claude Code is installed but not logged in. Run: claude auth login.');

    expect(await getDb().get("SELECT id FROM projects WHERE name = 'Acme'")).toBeUndefined();
    expect(await getDb().get('SELECT id FROM provider_connections')).toBeUndefined();
  });

  it('rejects an unknown runtime', async () => {
    const response = await post('/starter-plan/preview', { ...payload, runtime_type: 'webhook' });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('runtime_type must be one of: claude-code, codex, openclaw');
  });
});
