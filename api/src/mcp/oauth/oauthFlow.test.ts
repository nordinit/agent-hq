import crypto from 'crypto';
import express from 'express';
import type { Server } from 'http';
import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { resolveMcpApiIdentityForKey } from '../../lib/mcpApiAuth';
import { createMcpHttpRouter } from '../httpServer';
import { createMcpOAuthRouter, resolveMcpOAuthConfigFromEnv } from './router';
import { resetOperatorPasswordLockout, setOperatorPassword } from './operatorPassword';

const OPERATOR_PASSWORD = 'correct-horse-battery-staple';
const PUBLIC_URL = 'https://hq.test.example';

/** PKCE pair, S256. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

interface Harness {
  baseUrl: string;
  close(): Promise<void>;
}

async function seed(): Promise<void> {
  const db = await setupTestDb();
  await db.run(
    `INSERT INTO tenants (id, name, slug, is_default) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    1, 'Default Tenant', 'default', 1,
  );
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1') ON CONFLICT DO NOTHING`);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (?, ?, ?)`, 86, 1, 'Agent HQ');
  await db.run(`
    INSERT INTO agents (id, tenant_id, project_id, name, slug, session_key, enabled, role)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'Remote MCP client'),
           (?, ?, ?, ?, ?, ?, 1, 'Remote MCP client'),
           (?, ?, ?, ?, ?, ?, 1, 'Orchestrator')
  `,
    700, 1, 86, 'Claude Mobile', 'claude-mobile', 'agent:claude-mobile:main',
    701, 1, 86, 'ChatGPT Mobile', 'chatgpt-mobile', 'agent:chatgpt-mobile:main',
    // Not a remote MCP identity. Atlas resolves to trusted-admin defaults, which is exactly the
    // identity a connector must never be able to select.
    702, 1, 86, 'Atlas', 'atlas', 'agent:atlas:main');
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
  app.use('/mcp', createMcpHttpRouter({
    apiBaseUrl: 'http://127.0.0.1:1',
    profileName: 'mobile',
    resourceMetadataUrl: oauth.resourceMetadataUrl,
  }));

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

async function registerClient(baseUrl: string, redirectUri = 'https://claude.ai/api/mcp/auth_callback') {
  const res = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Test Connector',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (res.status !== 201) throw new Error(`registration failed: ${res.status} ${await res.text()}`);
  return await res.json() as { client_id: string; client_secret?: string };
}

/** Drives /authorize through the consent screen and returns the redirect the client would receive. */
async function approve(baseUrl: string, params: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state?: string;
  password?: string;
  agentId?: number;
}): Promise<{ status: number; location: string | null; body?: string }> {
  const authorizeUrl = new URL(`${baseUrl}/authorize`);
  authorizeUrl.searchParams.set('client_id', params.clientId);
  authorizeUrl.searchParams.set('redirect_uri', params.redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('code_challenge', params.challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  if (params.state) authorizeUrl.searchParams.set('state', params.state);

  const authorizeRes = await fetch(authorizeUrl, { redirect: 'manual' });
  const consentLocation = authorizeRes.headers.get('location');
  if (!consentLocation) throw new Error(`authorize did not redirect: ${authorizeRes.status} ${await authorizeRes.text()}`);

  const consentUrl = new URL(consentLocation, baseUrl);
  const request = consentUrl.searchParams.get('request');
  if (!request) throw new Error('consent redirect carried no request payload');

  const form = new URLSearchParams({
    request,
    decision: 'approve',
    agent_id: String(params.agentId ?? 700),
    operator_password: params.password ?? OPERATOR_PASSWORD,
  });
  const consentRes = await fetch(`${baseUrl}/oauth/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
  });

  return {
    status: consentRes.status,
    location: consentRes.headers.get('location'),
    body: consentRes.status >= 400 ? await consentRes.text() : undefined,
  };
}

async function exchangeCode(baseUrl: string, params: {
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: params.clientId,
      code: params.code,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri,
    }).toString(),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

describe('MCP OAuth authorization server', () => {
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

  it('publishes discovery metadata for the authorization server and the protected resource', async () => {
    const as = await (await fetch(`${harness!.baseUrl}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
    expect(as.issuer).toBe(`${PUBLIC_URL}/`);
    expect(as.authorization_endpoint).toBe(`${PUBLIC_URL}/authorize`);
    expect(as.token_endpoint).toBe(`${PUBLIC_URL}/token`);
    expect(as.registration_endpoint).toBe(`${PUBLIC_URL}/register`);
    expect(as.code_challenge_methods_supported).toContain('S256');

    const rs = await (await fetch(`${harness!.baseUrl}/.well-known/oauth-protected-resource/mcp`)).json() as Record<string, unknown>;
    expect(rs.resource).toBe(`${PUBLIC_URL}/mcp`);
    expect(rs.authorization_servers).toContain(`${PUBLIC_URL}/`);
  });

  it('points an unauthenticated /mcp caller at the resource metadata', async () => {
    // Without this header a connector has no way to discover the authorization server, and the
    // OAuth flow never starts.
    const res = await fetch(`${harness!.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('completes the authorization code flow and issues a working access token', async () => {
    const client = await registerClient(harness!.baseUrl);
    expect(client.client_secret).toBeUndefined();

    const { verifier, challenge } = pkce();
    const approved = await approve(harness!.baseUrl, {
      clientId: client.client_id,
      redirectUri: REDIRECT,
      challenge,
      state: 'xyz',
    });

    expect(approved.status).toBe(302);
    const redirect = new URL(approved.location as string);
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
    expect(redirect.searchParams.get('state')).toBe('xyz');
    const code = redirect.searchParams.get('code') as string;
    expect(code).toBeTruthy();

    const token = await exchangeCode(harness!.baseUrl, {
      clientId: client.client_id, code, verifier, redirectUri: REDIRECT,
    });
    expect(token.status).toBe(200);
    expect(token.body.token_type).toBe('Bearer');
    expect(token.body.expires_in).toBe(3600);
    expect(typeof token.body.refresh_token).toBe('string');

    // The access token is an ordinary MCP key bound to the scoped identity, which is what makes
    // the rest of the permission model apply to a connector unchanged.
    const identity = await resolveMcpApiIdentityForKey(getDb(), String(token.body.access_token), { updateLastUsed: false });
    expect(identity.agentId).toBe(700);
    expect(identity.agentSlug).toBe('claude-mobile');
  });

  it('refuses the consent form without the operator password', async () => {
    const client = await registerClient(harness!.baseUrl);
    const { challenge } = pkce();

    const denied = await approve(harness!.baseUrl, {
      clientId: client.client_id,
      redirectUri: REDIRECT,
      challenge,
      password: 'not-the-password',
    });

    expect(denied.status).toBe(401);
    expect(denied.location).toBeNull();
    expect(denied.body).toContain('Incorrect operator password');
  });

  it('rejects a token request with the wrong PKCE verifier', async () => {
    const client = await registerClient(harness!.baseUrl);
    const { challenge } = pkce();
    const other = pkce();

    const approved = await approve(harness!.baseUrl, { clientId: client.client_id, redirectUri: REDIRECT, challenge });
    const code = new URL(approved.location as string).searchParams.get('code') as string;

    const token = await exchangeCode(harness!.baseUrl, {
      clientId: client.client_id, code, verifier: other.verifier, redirectUri: REDIRECT,
    });
    expect(token.status).toBe(400);
    expect(token.body.error).toBe('invalid_grant');
  });

  it('refuses to replay an authorization code', async () => {
    const client = await registerClient(harness!.baseUrl);
    const { verifier, challenge } = pkce();
    const approved = await approve(harness!.baseUrl, { clientId: client.client_id, redirectUri: REDIRECT, challenge });
    const code = new URL(approved.location as string).searchParams.get('code') as string;

    const first = await exchangeCode(harness!.baseUrl, { clientId: client.client_id, code, verifier, redirectUri: REDIRECT });
    expect(first.status).toBe(200);

    const second = await exchangeCode(harness!.baseUrl, { clientId: client.client_id, code, verifier, redirectUri: REDIRECT });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_grant');
  });

  it('rejects a redirect_uri that was never registered', async () => {
    const client = await registerClient(harness!.baseUrl);
    const { challenge } = pkce();

    const url = new URL(`${harness!.baseUrl}/authorize`);
    url.searchParams.set('client_id', client.client_id);
    url.searchParams.set('redirect_uri', 'https://evil.example/callback');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    const res = await fetch(url, { redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('rotates refresh tokens and kills the family when one is reused', async () => {
    const client = await registerClient(harness!.baseUrl);
    const { verifier, challenge } = pkce();
    const approved = await approve(harness!.baseUrl, { clientId: client.client_id, redirectUri: REDIRECT, challenge });
    const code = new URL(approved.location as string).searchParams.get('code') as string;
    const first = await exchangeCode(harness!.baseUrl, { clientId: client.client_id, code, verifier, redirectUri: REDIRECT });
    const originalRefresh = String(first.body.refresh_token);

    const refresh = async (token: string) => {
      const res = await fetch(`${harness!.baseUrl}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: client.client_id,
          refresh_token: token,
        }).toString(),
      });
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };

    const rotated = await refresh(originalRefresh);
    expect(rotated.status).toBe(200);
    const rotatedRefresh = String(rotated.body.refresh_token);
    expect(rotatedRefresh).not.toBe(originalRefresh);

    // Replaying the superseded token is indistinguishable from theft, so the chain dies.
    const replay = await refresh(originalRefresh);
    expect(replay.status).toBe(400);

    const afterReplay = await refresh(rotatedRefresh);
    expect(afterReplay.status).toBe(400);

    // And every access token minted under the family stops working.
    await expect(
      resolveMcpApiIdentityForKey(getDb(), String(rotated.body.access_token), { updateLastUsed: false }),
    ).rejects.toMatchObject({ code: 'mcp_api_key_disabled' });
  });

  it('expires access tokens', async () => {
    const client = await registerClient(harness!.baseUrl);
    const { verifier, challenge } = pkce();
    const approved = await approve(harness!.baseUrl, { clientId: client.client_id, redirectUri: REDIRECT, challenge });
    const code = new URL(approved.location as string).searchParams.get('code') as string;
    const token = await exchangeCode(harness!.baseUrl, { clientId: client.client_id, code, verifier, redirectUri: REDIRECT });

    await getDb().run(
      `UPDATE mcp_api_keys SET expires_at = ? WHERE oauth_grant_id IS NOT NULL`,
      '2020-01-01 00:00:00',
    );

    await expect(
      resolveMcpApiIdentityForKey(getDb(), String(token.body.access_token), { updateLastUsed: false }),
    ).rejects.toMatchObject({ code: 'mcp_api_key_expired' });
  });
});

describe('resolveMcpOAuthConfigFromEnv', () => {
  it('stays off until a public URL is configured', () => {
    expect(resolveMcpOAuthConfigFromEnv({})).toMatchObject({ enabled: false, publicUrl: null });
    expect(resolveMcpOAuthConfigFromEnv({ AGENT_HQ_PUBLIC_URL: PUBLIC_URL })).toMatchObject({
      enabled: true,
      publicUrl: PUBLIC_URL,
      agentSlug: 'claude-mobile',
      allowDynamicRegistration: true,
    });
  });

  it('honours the explicit disable switches', () => {
    expect(resolveMcpOAuthConfigFromEnv({ AGENT_HQ_PUBLIC_URL: PUBLIC_URL, AGENT_HQ_OAUTH_ENABLED: '0' }).enabled).toBe(false);
    expect(resolveMcpOAuthConfigFromEnv({ AGENT_HQ_PUBLIC_URL: PUBLIC_URL, AGENT_HQ_OAUTH_ALLOW_DCR: '0' }).allowDynamicRegistration).toBe(false);
  });
});
