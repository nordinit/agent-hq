import { setupTestDb, teardownTestDb } from '../db/testDb';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../db/client';
import {
  authenticateMcpApiKeyIfPresent,
  authorizeMcpApiRequestIfPresent,
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

async function resetDb(): Promise<void> {
  await setupTestDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-tenant-scope-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');

  const db = getDb();


  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (?, ?, ?, ?), (?, ?, ?, ?)`, 1, 'Default Company', 'default', 1, 2, 'Tenant Two', 'tenant-two', 0);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
  await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, enabled, system_role) VALUES (?, ?, ?, ?, 1, 'admin'), (?, ?, ?, ?, 1, 'admin')`, 101, 1, 'Tenant One Admin', 'agent:tenant-one-admin:main', 202, 2, 'Tenant Two Admin', 'agent:tenant-two-admin:main');
  await db.run(`INSERT INTO provider_config (tenant_id, slug, display_name, status, config) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`, 1, 'openai', 'Tenant One OpenAI', 'connected', '{"api_key":"tenant-one-secret"}', 2, 'openai', 'Tenant Two OpenAI', 'connected', '{"api_key":"tenant-two-secret"}');
  await db.run(`
    INSERT INTO github_identities (tenant_id, github_username, token, git_author_name, git_author_email, lane)
    VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)
  `, 1, 'shared-bot', 'ghp_tenant_one_secret', 'Tenant One Bot', 'one@example.test', 'shared', 2, 'shared-bot', 'ghp_tenant_two_secret', 'Tenant Two Bot', 'two@example.test', 'shared');

  tenantOneAdminKey = (await issueMcpApiKeyForAgent(db, 101)).apiKey;
  tenantTwoAdminKey = (await issueMcpApiKeyForAgent(db, 202)).apiKey;
  await replaceAgentMcpPermissionPolicy(db, 101, ['admin.full_access']);
  await replaceAgentMcpPermissionPolicy(db, 202, ['admin.full_access']);
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
    await resetDb();
    await startTestServer();
  });

  afterEach(async () => {
    await stopTestServer();
    await teardownTestDb();
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
