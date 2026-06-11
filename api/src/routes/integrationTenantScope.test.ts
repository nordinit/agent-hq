import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import {
  authenticateMcpApiKeyIfPresent,
  authorizeMcpApiRequestIfPresent,
  ensureMcpApiKeyTable,
  issueMcpApiKeyForAgent,
  replaceAgentMcpPermissionPolicy,
} from '../lib/mcpApiAuth';
import { handleJsonRequestErrors } from '../lib/jsonRequestErrors';
import providersRouter from './providers';
import githubIdentitiesRouter from './github-identities';

let tempDir: string;
let dbPath: string;
let server: Server | null = null;
let baseUrl = '';
let tenantOneAdminKey = '';
let tenantTwoAdminKey = '';

function resetDb(): void {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-tenant-scope-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');
  process.env.AGENT_HQ_DB_PATH = dbPath;

  const db = getDb();
  db.exec(`
    CREATE TABLE tenants (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      system_role TEXT,
      github_identity_id INTEGER,
      deleted_at TEXT
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER,
      project_id INTEGER,
      sprint_id INTEGER,
      active_instance_id INTEGER
    );
    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      task_id INTEGER,
      agent_id INTEGER,
      status TEXT
    );
    CREATE TABLE provider_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      slug TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      config TEXT NOT NULL DEFAULT '{}',
      last_validated_at TEXT,
      validation_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, slug)
    );
    CREATE TABLE github_identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      github_username TEXT NOT NULL,
      token TEXT NOT NULL DEFAULT '',
      git_author_name TEXT NOT NULL DEFAULT '',
      git_author_email TEXT NOT NULL DEFAULT '',
      lane TEXT NOT NULL DEFAULT 'shared',
      notes TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_validated_at TEXT,
      validation_status TEXT,
      validation_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, github_username)
    );
  `);

  db.prepare(`INSERT INTO tenants (id, name, slug, is_default) VALUES (?, ?, ?, ?), (?, ?, ?, ?)`)
    .run(1, 'Default Company', 'default', 1, 2, 'Tenant Two', 'tenant-two', 0);
  db.prepare(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`).run();
  db.prepare(`INSERT INTO agents (id, tenant_id, name, enabled, system_role) VALUES (?, ?, ?, 1, 'admin'), (?, ?, ?, 1, 'admin')`)
    .run(101, 1, 'Tenant One Admin', 202, 2, 'Tenant Two Admin');
  db.prepare(`INSERT INTO provider_config (tenant_id, slug, display_name, status, config) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`)
    .run(1, 'openai', 'Tenant One OpenAI', 'connected', '{"api_key":"tenant-one-secret"}', 2, 'openai', 'Tenant Two OpenAI', 'connected', '{"api_key":"tenant-two-secret"}');
  db.prepare(`
    INSERT INTO github_identities (tenant_id, github_username, token, git_author_name, git_author_email, lane)
    VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)
  `).run(
    1, 'shared-bot', 'ghp_tenant_one_secret', 'Tenant One Bot', 'one@example.test', 'shared',
    2, 'shared-bot', 'ghp_tenant_two_secret', 'Tenant Two Bot', 'two@example.test', 'shared',
  );

  ensureMcpApiKeyTable(db);
  tenantOneAdminKey = issueMcpApiKeyForAgent(db, 101).apiKey;
  tenantTwoAdminKey = issueMcpApiKeyForAgent(db, 202).apiKey;
  replaceAgentMcpPermissionPolicy(db, 101, ['admin.full_access']);
  replaceAgentMcpPermissionPolicy(db, 202, ['admin.full_access']);
}

async function startTestServer(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(handleJsonRequestErrors);
  app.use('/api/v1', authenticateMcpApiKeyIfPresent);
  app.use('/api/v1', authorizeMcpApiRequestIfPresent);
  app.use('/api/v1/providers', providersRouter);
  app.use('/api/v1/github-identities', githubIdentitiesRouter);

  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

async function stopTestServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (!server) return resolve();
    server.close((err) => (err ? reject(err) : resolve()));
  });
  server = null;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-agent-hq-mcp-client': 'agent-hq-mcp',
    authorization: `Bearer ${apiKey}`,
  };
}

describe('tenant scoping for integration credentials/config routes', () => {
  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-tenant-scope-'));
    resetDb();
    await startTestServer();
  });

  afterEach(async () => {
    await stopTestServer();
    closeDb();
    delete process.env.AGENT_HQ_DB_PATH;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('lists only the MCP key tenant provider and GitHub config even when slugs/usernames overlap', async () => {
    const tenantOneProviders = await fetch(`${baseUrl}/api/v1/providers`, { headers: authHeaders(tenantOneAdminKey) });
    const tenantOneProvidersBody = await tenantOneProviders.json();
    expect(tenantOneProviders.status).toBe(200);
    expect(tenantOneProvidersBody).toMatchObject({
      providers: [
        expect.objectContaining({ slug: 'openai', display_name: 'Tenant One OpenAI' }),
      ],
      connected_count: 1,
    });

    const tenantTwoProviders = await fetch(`${baseUrl}/api/v1/providers`, { headers: authHeaders(tenantTwoAdminKey) });
    const tenantTwoProvidersBody = await tenantTwoProviders.json();
    expect(tenantTwoProviders.status).toBe(200);
    expect(tenantTwoProvidersBody).toMatchObject({
      providers: [
        expect.objectContaining({ slug: 'openai', display_name: 'Tenant Two OpenAI' }),
      ],
      connected_count: 1,
    });

    const tenantTwoGithub = await fetch(`${baseUrl}/api/v1/github-identities`, { headers: authHeaders(tenantTwoAdminKey) });
    expect(tenantTwoGithub.status).toBe(200);
    await expect(tenantTwoGithub.json()).resolves.toEqual([
      expect.objectContaining({ tenant_id: 2, github_username: 'shared-bot', token: '***cret' }),
    ]);
  });

  it('denies tenant header and query manipulation on integration config routes without super-admin access', async () => {
    const providerQuery = await fetch(`${baseUrl}/api/v1/providers?tenant_id=1`, { headers: authHeaders(tenantTwoAdminKey) });
    expect(providerQuery.status).toBe(403);
    await expect(providerQuery.json()).resolves.toMatchObject({
      code: 'mcp_tenant_scope_denied',
      details: { key_tenant_id: 2, requested_tenant_id: 1, required_capability: 'admin.cross_tenant' },
    });

    const githubHeader = await fetch(`${baseUrl}/api/v1/github-identities`, {
      headers: { ...authHeaders(tenantTwoAdminKey), 'x-agent-hq-tenant-id': '1' },
    });
    expect(githubHeader.status).toBe(403);
    await expect(githubHeader.json()).resolves.toMatchObject({
      code: 'mcp_tenant_scope_denied',
      details: { key_tenant_id: 2, requested_tenant_id: 1, required_capability: 'admin.cross_tenant' },
    });
  });
});
