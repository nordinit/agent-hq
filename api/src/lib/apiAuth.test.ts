import express from 'express';
import type { AddressInfo } from 'net';
import * as http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  CHAT_ATTACHMENT_LINK_TTL_SECONDS,
  apiPathPattern,
  authenticateApiRequest,
  createChatWebSocketVerifier,
  isOperatorToken,
  readApiCredential,
  resolveApiAuthConfigFromEnv,
  signedChatAttachmentQuery,
  type ApiAuthConfig,
} from './apiAuth';
import { McpApiAuthError, type McpApiIdentity } from './mcpApiAuth';
import { OPERATOR_SESSION_MAX_AGE_SECONDS, operatorSessionCookieName, signOperatorSession } from './operatorSession';

const TOKEN = 'op-token-0123456789abcdef0123456789abcdef';
const SCOPED_KEY = 'ahq_mcp_scoped_key';

function identityFor(key: string): McpApiIdentity {
  if (key !== SCOPED_KEY) throw new McpApiAuthError('Invalid MCP API key', 401, 'mcp_api_key_invalid');
  return {
    keyId: 1,
    agentId: 7,
    tenantId: 1,
    agentName: 'Cinder',
    agentSlug: 'cinder',
    systemRole: null,
    keyRole: 'scoped',
    globalAdminAccess: false,
    auditActor: 'cinder',
    authorityActor: 'cinder',
  };
}

describe('resolveApiAuthConfigFromEnv', () => {
  it('enforces by default and refuses to start without an operator token', () => {
    expect(() => resolveApiAuthConfigFromEnv({})).toThrow(/AGENT_HQ_OPERATOR_TOKEN is not set.*openssl rand -hex 32.*AGENT_HQ_AUTH_MODE=report/);
    expect(resolveApiAuthConfigFromEnv({ AGENT_HQ_OPERATOR_TOKEN: ` ${TOKEN} ` })).toEqual({ mode: 'enforce', operatorToken: TOKEN });
  });

  it('lets report mode start without a token', () => {
    expect(resolveApiAuthConfigFromEnv({ AGENT_HQ_AUTH_MODE: 'Report' })).toEqual({ mode: 'report', operatorToken: null });
  });

  it('rejects unknown modes and tokens too short to be generated secrets', () => {
    expect(() => resolveApiAuthConfigFromEnv({ AGENT_HQ_AUTH_MODE: 'off', AGENT_HQ_OPERATOR_TOKEN: TOKEN })).toThrow(/"enforce" or "report"/);
    expect(() => resolveApiAuthConfigFromEnv({ AGENT_HQ_OPERATOR_TOKEN: 'hunter2' })).toThrow(/too short/);
  });
});

describe('readApiCredential', () => {
  it('recognizes the operator token only as a bearer token', () => {
    expect(readApiCredential({ authorization: `Bearer ${TOKEN}` }, TOKEN)).toEqual({ kind: 'operator' });
    expect(readApiCredential({ authorization: `bearer   ${TOKEN}` }, TOKEN)).toEqual({ kind: 'operator' });
    expect(readApiCredential({ 'x-api-key': TOKEN }, TOKEN)).toEqual({ kind: 'mcp_key', key: TOKEN });
  });

  it('treats x-api-key and any other bearer token as an MCP key, with or without the client marker', () => {
    expect(readApiCredential({ 'x-api-key': SCOPED_KEY }, TOKEN)).toEqual({ kind: 'mcp_key', key: SCOPED_KEY });
    expect(readApiCredential({ authorization: `Bearer ${SCOPED_KEY}` }, TOKEN)).toEqual({ kind: 'mcp_key', key: SCOPED_KEY });
    expect(readApiCredential({ authorization: `Bearer ${SCOPED_KEY}`, 'x-agent-hq-mcp-client': 'agent-hq-mcp' }, TOKEN))
      .toEqual({ kind: 'mcp_key', key: SCOPED_KEY });
    expect(readApiCredential({ authorization: `Bearer ${SCOPED_KEY}`, 'x-api-key': SCOPED_KEY }, TOKEN))
      .toEqual({ kind: 'mcp_key', key: SCOPED_KEY });
  });

  it('refuses ambiguous or malformed credentials instead of ranking them', () => {
    expect(readApiCredential({ authorization: `Bearer ${TOKEN}`, 'x-api-key': SCOPED_KEY }, TOKEN))
      .toMatchObject({ kind: 'invalid', code: 'api_credentials_conflict' });
    expect(readApiCredential({ authorization: 'Basic dXNlcjpwYXNz' }, TOKEN))
      .toMatchObject({ kind: 'invalid', code: 'api_auth_scheme_unsupported' });
    expect(readApiCredential({ 'x-agent-hq-mcp-client': 'agent-hq-mcp' }, TOKEN))
      .toMatchObject({ kind: 'invalid', code: 'mcp_api_key_missing' });
    expect(readApiCredential({}, TOKEN)).toEqual({ kind: 'none' });
  });

  it('never matches the operator token when none is configured', () => {
    expect(isOperatorToken('', null)).toBe(false);
    expect(isOperatorToken(TOKEN, null)).toBe(false);
    expect(isOperatorToken(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(readApiCredential({ authorization: `Bearer ${TOKEN}` }, null)).toEqual({ kind: 'mcp_key', key: TOKEN });
  });
});

describe('apiPathPattern', () => {
  it('collapses ids so one caller logs once rather than once per record', () => {
    expect(apiPathPattern('/api/v1/tasks/448/notes')).toBe('/api/v1/tasks/:id/notes');
    expect(apiPathPattern('/api/v1/sessions/0f8fad5b-d9cb-469f-a165-70867728950e')).toBe('/api/v1/sessions/:uuid');
    expect(apiPathPattern('/api/v1/chat/attachments/abcdefghijklmnopqrstuvwxyz/download')).toBe('/api/v1/chat/attachments/:value/download');
    expect(apiPathPattern('/api/v1/workflows/types/dev')).toBe('/api/v1/workflows/types/dev');
  });
});

describe('authenticateApiRequest', () => {
  let server: http.Server;
  let baseUrl = '';
  let config: ApiAuthConfig;
  let logs: string[] = [];

  async function start(nextConfig: ApiAuthConfig): Promise<void> {
    config = nextConfig;
    logs = [];
    const app = express();
    app.use('/api/v1', authenticateApiRequest(config, {
      resolveIdentity: async (key) => identityFor(key),
      log: (message) => logs.push(message),
    }));
    app.get('/api/v1/openapi.json', (_req, res) => { res.json({ openapi: '3.0.3' }); });
    app.all('/api/v1/*', (req, res) => {
      res.json({ credential: req.apiCredential ?? null, agent: req.mcpIdentity?.agentSlug ?? null });
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const call = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    fetch(`${baseUrl}${path}`, { method, headers });

  describe('in enforce mode', () => {
    beforeEach(() => start({ mode: 'enforce', operatorToken: TOKEN }));

    it('refuses a request without a credential before it reaches the route', async () => {
      const res = await call('/api/v1/tasks/1', { 'user-agent': 'curl/8.7.1' });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer realm="Agent HQ"');
      expect(await res.json()).toMatchObject({ code: 'api_auth_required' });
      expect(logs).toEqual([
        '[api-auth] rejected GET /api/v1/tasks/:id (no credential) user-agent="curl/8.7.1" remote=127.0.0.1',
      ]);
    });

    it('gives the operator token operator access with no MCP identity', async () => {
      const res = await call('/api/v1/tools', { authorization: `Bearer ${TOKEN}` }, 'POST');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ credential: 'operator', agent: null });
    });

    it('runs a scoped key as its agent however it is sent, so dropping the marker cannot escalate', async () => {
      for (const headers of [
        { 'x-api-key': SCOPED_KEY } as Record<string, string>,
        { authorization: `Bearer ${SCOPED_KEY}` },
        { authorization: `Bearer ${SCOPED_KEY}`, 'x-agent-hq-mcp-client': 'agent-hq-mcp' },
      ]) {
        const res = await call('/api/v1/tasks/1', headers);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ credential: 'mcp_key', agent: 'cinder' });
      }
    });

    it('refuses unknown tokens, conflicting headers, other schemes and a marker without a key', async () => {
      const cases: Array<[Record<string, string>, string]> = [
        [{ authorization: 'Bearer not-a-real-key' }, 'mcp_api_key_invalid'],
        [{ 'x-api-key': 'not-a-real-key' }, 'mcp_api_key_invalid'],
        [{ authorization: `Bearer ${TOKEN}`, 'x-api-key': SCOPED_KEY }, 'api_credentials_conflict'],
        [{ authorization: 'Basic dXNlcjpwYXNz' }, 'api_auth_scheme_unsupported'],
        [{ 'x-agent-hq-mcp-client': 'agent-hq-mcp' }, 'mcp_api_key_missing'],
      ];
      for (const [headers, code] of cases) {
        const res = await call('/api/v1/tasks/1', headers);
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ code });
      }
    });

    it('serves only the static API description without a credential', async () => {
      expect((await call('/api/v1/openapi.json')).status).toBe(200);
      expect((await call('/api/v1/openapi.json', {}, 'POST')).status).toBe(401);
    });

    it('serves a chat attachment to a signed link, for that attachment only and until it expires', async () => {
      const query = signedChatAttachmentQuery(12, TOKEN);
      const signed = await call(`/api/v1/chat/attachments/12/download${query}`);
      expect(signed.status).toBe(200);
      expect(await signed.json()).toEqual({ credential: 'signed_link', agent: null });

      expect((await call(`/api/v1/chat/attachments/13/download${query}`)).status).toBe(401);
      expect((await call(`/api/v1/chat/attachments/12${query}`)).status).toBe(401);
      expect((await call(`/api/v1/chat/attachments/12/download${query}`, {}, 'DELETE')).status).toBe(401);
      const tampered = query.replace(/signature=(.)/, (_match, first: string) => `signature=${first === 'A' ? 'B' : 'A'}`);
      expect((await call(`/api/v1/chat/attachments/12/download${tampered}`)).status).toBe(401);
      const expired = signedChatAttachmentQuery(12, TOKEN, Date.now() - (CHAT_ATTACHMENT_LINK_TTL_SECONDS + 1) * 1000);
      expect((await call(`/api/v1/chat/attachments/12/download${expired}`)).status).toBe(401);
      expect(signedChatAttachmentQuery(12, null)).toBe('');
    });
  });

  describe('in report mode', () => {
    beforeEach(() => start({ mode: 'report', operatorToken: TOKEN }));

    it('lets a request without a credential through as before and logs each caller once', async () => {
      const first = await call('/api/v1/tasks/1', { 'user-agent': 'lease-manager/1.0' });
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ credential: 'unauthenticated', agent: null });
      await call('/api/v1/tasks/2', { 'user-agent': 'lease-manager/1.0' });
      await call('/api/v1/tasks/3', { 'user-agent': 'other-tool/2.0' });
      await call('/api/v1/tasks/3', { 'user-agent': 'other-tool/2.0' }, 'DELETE');
      expect(logs).toEqual([
        '[api-auth:report] would reject GET /api/v1/tasks/:id (no credential) user-agent="lease-manager/1.0" remote=127.0.0.1',
        '[api-auth:report] would reject GET /api/v1/tasks/:id (no credential) user-agent="other-tool/2.0" remote=127.0.0.1',
        '[api-auth:report] would reject DELETE /api/v1/tasks/:id (no credential) user-agent="other-tool/2.0" remote=127.0.0.1',
      ]);
    });

    it('logs a bare bearer token that enforce would authenticate as an MCP key, without applying it', async () => {
      const res = await call('/api/v1/tasks/1', { authorization: `Bearer ${SCOPED_KEY}` });
      expect(await res.json()).toEqual({ credential: 'unauthenticated', agent: null });
      expect(logs[0]).toContain('bearer token is not the operator token; enforce treats it as an MCP API key');
    });

    it('keeps presented MCP keys exactly as strict as they were', async () => {
      expect((await call('/api/v1/tasks/1', { 'x-api-key': 'not-a-real-key' })).status).toBe(401);
      expect((await call('/api/v1/tasks/1', { 'x-agent-hq-mcp-client': 'x' })).status).toBe(401);
      const scoped = await call('/api/v1/tasks/1', { 'x-api-key': SCOPED_KEY });
      expect(await scoped.json()).toEqual({ credential: 'mcp_key', agent: 'cinder' });
    });

    it('still honours the operator token without logging it', async () => {
      const res = await call('/api/v1/tasks/1', { authorization: `Bearer ${TOKEN}` });
      expect(await res.json()).toEqual({ credential: 'operator', agent: null });
      expect(logs).toEqual([]);
    });
  });
});

describe('chat WebSocket authentication', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let url = '';
  let logs: string[] = [];

  async function start(config: ApiAuthConfig): Promise<void> {
    logs = [];
    server = http.createServer();
    wss = new WebSocketServer({
      server,
      path: '/api/v1/chat/ws',
      verifyClient: createChatWebSocketVerifier(config, new Set(), { log: (message) => logs.push(message) }),
    });
    wss.on('connection', (socket) => socket.close(1000, 'ok'));
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/chat/ws`;
  }

  afterEach(async () => {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Resolves with the handshake's HTTP status: 101 when the socket opened. */
  function handshake(headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers });
      socket.once('open', () => { socket.close(); resolve(101); });
      socket.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      socket.once('error', (err) => { if (!/Unexpected server response/.test(err.message)) reject(err); });
    });
  }

  const session = (token: string, expiresAt = Math.floor(Date.now() / 1000) + OPERATOR_SESSION_MAX_AGE_SECONDS) =>
    `theme=dark; ${operatorSessionCookieName(TOKEN)}=${signOperatorSession(token, expiresAt)}`;
  // The UI page and the API differ only by port, which the Origin check allows.
  const uiOrigin = (): string => `http://127.0.0.1:3500`;

  it('opens for the UI session cookie and for the operator token, and nothing else', async () => {
    await start({ mode: 'enforce', operatorToken: TOKEN });
    expect(await handshake({ origin: uiOrigin(), cookie: session(TOKEN) })).toBe(101);
    expect(await handshake({ authorization: `Bearer ${TOKEN}` })).toBe(101);

    expect(await handshake({ origin: uiOrigin() })).toBe(401);
    expect(await handshake({ origin: uiOrigin(), cookie: session('f'.repeat(64)) })).toBe(401);
    expect(await handshake({ origin: uiOrigin(), cookie: session(TOKEN, Math.floor(Date.now() / 1000) - 1) })).toBe(401);
    expect(await handshake({ 'x-api-key': SCOPED_KEY })).toBe(401);
    expect(logs[0]).toMatch(/^\[api-auth\] rejected GET \/api\/v1\/chat\/ws \(WebSocket handshake without a UI session or operator token\)/);
  });

  it('checks the Origin before the session', async () => {
    await start({ mode: 'enforce', operatorToken: TOKEN });
    expect(await handshake({ origin: 'https://evil.example', cookie: session(TOKEN) })).toBe(403);
  });

  it('opens without a session in report mode and logs the caller', async () => {
    await start({ mode: 'report', operatorToken: TOKEN });
    expect(await handshake({ origin: uiOrigin() })).toBe(101);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[api-auth:report\] would reject GET \/api\/v1\/chat\/ws/);
  });
});
