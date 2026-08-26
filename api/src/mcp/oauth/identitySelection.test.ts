import crypto from 'crypto';
import express from 'express';
import type { Server } from 'http';
import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { resolveMcpApiIdentityForKey } from '../../lib/mcpApiAuth';
import { createMcpOAuthRouter } from './router';
import { resetOperatorPasswordLockout, setOperatorPassword } from './operatorPassword';
import {
  findLastIdentityForClient,
  listRemoteMcpIdentities,
  selectDefaultIdentity,
  type ConsentIdentity,
} from './identities';

const OPERATOR_PASSWORD = 'correct-horse-battery-staple';
const PUBLIC_URL = 'https://hq.test.example';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

const CLAUDE_MOBILE = 700;
const CHATGPT_MOBILE = 701;
const ATLAS = 702;

interface Harness { baseUrl: string; close(): Promise<void> }

async function seed(): Promise<void> {
  const db = await setupTestDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1) ON CONFLICT DO NOTHING`);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1') ON CONFLICT DO NOTHING`);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (?, ?, ?), (?, ?, ?)`, 86, 1, 'Agent HQ', 87, 1, 'Agency');
  await db.run(`
    INSERT INTO agents (id, tenant_id, project_id, name, slug, session_key, enabled, role)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'Remote MCP client'),
           (?, ?, ?, ?, ?, ?, 1, 'Remote MCP client'),
           (?, ?, ?, ?, ?, ?, 1, 'Orchestrator'),
           (?, ?, ?, ?, ?, ?, 0, 'Remote MCP client')
  `,
    CLAUDE_MOBILE, 1, 86, 'Claude Mobile', 'claude-mobile', 'agent:claude-mobile:main',
    CHATGPT_MOBILE, 1, 87, 'ChatGPT Mobile', 'chatgpt-mobile', 'agent:chatgpt-mobile:main',
    ATLAS, 1, 86, 'Atlas', 'atlas', 'agent:atlas:main',
    703, 1, 86, 'Retired Mobile', 'retired-mobile', 'agent:retired-mobile:main');
  await setOperatorPassword(db, OPERATOR_PASSWORD);
  resetOperatorPasswordLockout();
}

async function startHarness(): Promise<Harness> {
  const app = express();
  app.use(express.json());
  const oauth = createMcpOAuthRouter({
    db: getDb(),
    config: {
      enabled: true,
      publicUrl: PUBLIC_URL,
      agentSlug: 'claude-mobile',
      allowDynamicRegistration: true,
      accessTokenTtlSeconds: 3600,
    },
  });
  app.use(oauth.router);

  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function registerClient(baseUrl: string, name = 'Test Connector'): Promise<string> {
  const res = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  return (await res.json() as { client_id: string }).client_id;
}

async function consentRequest(baseUrl: string, clientId: string): Promise<string> {
  const url = new URL(`${baseUrl}/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', REDIRECT);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', CHALLENGE);
  url.searchParams.set('code_challenge_method', 'S256');
  const res = await fetch(url, { redirect: 'manual' });
  const location = res.headers.get('location') as string;
  return new URL(location, baseUrl).searchParams.get('request') as string;
}

async function submit(baseUrl: string, request: string, fields: Record<string, string>) {
  const res = await fetch(`${baseUrl}/oauth/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request, decision: 'approve', operator_password: OPERATOR_PASSWORD, ...fields }).toString(),
    redirect: 'manual',
  });
  return { status: res.status, location: res.headers.get('location'), body: res.status >= 400 ? await res.text() : '' };
}

async function agentForCode(code: string): Promise<number> {
  const row = await getDb().get(
    `SELECT agent_id FROM mcp_oauth_authorization_codes WHERE code_hash = ?`,
    crypto.createHash('sha256').update(code, 'utf8').digest('hex'),
  ) as { agent_id: number };
  return Number(row.agent_id);
}

describe('consent identity selection', () => {
  let harness: Harness | null = null;

  beforeEach(async () => {
    await seed();
    harness = await startHarness();
  });

  afterEach(async () => {
    await harness?.close();
    harness = null;
    await teardownTestDb();
  });

  it('offers every remote MCP identity and nothing else', async () => {
    const identities = await listRemoteMcpIdentities(getDb());
    const ids = identities.map((identity) => identity.agentId);

    expect(ids).toContain(CLAUDE_MOBILE);
    expect(ids).toContain(CHATGPT_MOBILE);
    // Atlas carries a different role; the disabled one is not connectable at all.
    expect(ids).not.toContain(ATLAS);
    expect(ids).not.toContain(703);
  });

  it('renders each identity with its own project', async () => {
    const clientId = await registerClient(harness!.baseUrl);
    const request = await consentRequest(harness!.baseUrl, clientId);
    const html = await (await fetch(`${harness!.baseUrl}/oauth/consent?request=${encodeURIComponent(request)}`)).text();

    expect(html).toContain('Claude Mobile');
    expect(html).toContain('ChatGPT Mobile');
    expect(html).toContain('Agent HQ');
    expect(html).toContain('Agency');
    expect(html).not.toContain('agent:atlas:main');
    expect(html).toMatch(/name="agent_id" value="700"/);
    expect(html).toMatch(/name="agent_id" value="701"/);
  });

  it('authorizes as the identity the operator picked', async () => {
    const clientId = await registerClient(harness!.baseUrl, 'ChatGPT');
    const request = await consentRequest(harness!.baseUrl, clientId);

    const result = await submit(harness!.baseUrl, request, { agent_id: String(CHATGPT_MOBILE) });
    expect(result.status).toBe(302);

    const code = new URL(result.location as string).searchParams.get('code') as string;
    expect(await agentForCode(code)).toBe(CHATGPT_MOBILE);
  });

  it('refuses an identity that is not a remote MCP client', async () => {
    // The escalation this validation exists for: Atlas resolves to trusted-admin defaults, so a
    // token bound to it would bypass the capability policy entirely.
    const clientId = await registerClient(harness!.baseUrl);
    const request = await consentRequest(harness!.baseUrl, clientId);

    const result = await submit(harness!.baseUrl, request, { agent_id: String(ATLAS) });

    expect(result.status).toBe(400);
    expect(result.location).toBeNull();
    expect(result.body).toContain('Select which identity');

    const codes = await getDb().all(`SELECT agent_id FROM mcp_oauth_authorization_codes`) as Array<{ agent_id: number }>;
    expect(codes).toEqual([]);
  });

  it('refuses a disabled identity and an unknown id', async () => {
    const clientId = await registerClient(harness!.baseUrl);

    for (const agentId of ['703', '999999', 'not-a-number', '']) {
      const request = await consentRequest(harness!.baseUrl, clientId);
      const result = await submit(harness!.baseUrl, request, { agent_id: agentId });
      expect({ agentId, status: result.status }).toEqual({ agentId, status: 400 });
    }
  });

  it('pre-selects what a returning client connected as last', async () => {
    const clientId = await registerClient(harness!.baseUrl, 'ChatGPT');
    const first = await consentRequest(harness!.baseUrl, clientId);
    const approved = await submit(harness!.baseUrl, first, { agent_id: String(CHATGPT_MOBILE) });
    const code = new URL(approved.location as string).searchParams.get('code') as string;

    await fetch(`${harness!.baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: VERIFIER,
        redirect_uri: REDIRECT,
      }).toString(),
    });

    expect(await findLastIdentityForClient(getDb(), clientId)).toBe(CHATGPT_MOBILE);

    const second = await consentRequest(harness!.baseUrl, clientId);
    const html = await (await fetch(`${harness!.baseUrl}/oauth/consent?request=${encodeURIComponent(second)}`)).text();
    expect(html).toMatch(/value="701" checked/);
  });

  it('issues a token that resolves to the chosen identity', async () => {
    const clientId = await registerClient(harness!.baseUrl, 'ChatGPT');
    const request = await consentRequest(harness!.baseUrl, clientId);
    const approved = await submit(harness!.baseUrl, request, { agent_id: String(CHATGPT_MOBILE) });
    const code = new URL(approved.location as string).searchParams.get('code') as string;

    const token = await (await fetch(`${harness!.baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: VERIFIER,
        redirect_uri: REDIRECT,
      }).toString(),
    })).json() as { access_token: string };

    const identity = await resolveMcpApiIdentityForKey(getDb(), token.access_token, { updateLastUsed: false });
    expect(identity.agentId).toBe(CHATGPT_MOBILE);
    expect(identity.agentSlug).toBe('chatgpt-mobile');
  });
});

describe('selectDefaultIdentity', () => {
  const identity = (agentId: number, agentSlug: string): ConsentIdentity => ({
    agentId, agentSlug, tenantId: 1, agentName: agentSlug, projectName: null, capabilities: [],
  });
  const identities = [identity(700, 'claude-mobile'), identity(701, 'chatgpt-mobile')];

  it('prefers the client history, then the configured default, then the first', () => {
    expect(selectDefaultIdentity(identities, { lastAgentId: 701, defaultSlug: 'claude-mobile' })?.agentId).toBe(701);
    expect(selectDefaultIdentity(identities, { lastAgentId: null, defaultSlug: 'chatgpt-mobile' })?.agentId).toBe(701);
    expect(selectDefaultIdentity(identities, { lastAgentId: null, defaultSlug: null })?.agentId).toBe(700);
    // A history or default pointing at something no longer eligible falls through rather than
    // selecting nothing.
    expect(selectDefaultIdentity(identities, { lastAgentId: 999, defaultSlug: 'gone' })?.agentId).toBe(700);
    expect(selectDefaultIdentity([], { lastAgentId: 700, defaultSlug: 'claude-mobile' })).toBeNull();
  });
});
