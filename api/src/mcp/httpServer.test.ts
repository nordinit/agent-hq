import express from 'express';
import type { Server } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpApiAuthError, type McpApiIdentity } from '../lib/mcpApiAuth';
import { createMcpHttpRouter, resolveMcpHttpConfigFromEnv } from './httpServer';
import { resolveMcpToolProfile } from './toolProfiles';

const VALID_KEY = 'ahq_mcp_valid_test_key';

function identityFor(agentSlug: string): McpApiIdentity {
  return {
    keyId: 1,
    agentId: 42,
    tenantId: 1,
    agentName: 'Claude Mobile',
    agentSlug,
    systemRole: null,
    globalAdminAccess: false,
    auditActor: agentSlug,
    authorityActor: agentSlug,
  };
}

async function resolveIdentity(apiKey: string): Promise<McpApiIdentity> {
  if (apiKey !== VALID_KEY) throw new McpApiAuthError('Invalid MCP API key', 401, 'mcp_api_key_invalid');
  return identityFor('claude-mobile');
}

interface Harness {
  baseUrl: string;
  close(): Promise<void>;
}

async function startHarness(options: { profileName?: string; rateLimitRpm?: number } = {}): Promise<Harness> {
  const app = express();
  app.use(express.json());
  app.use('/mcp', createMcpHttpRouter({
    // No tool call in these tests reaches the API; an unroutable base URL keeps it that way.
    apiBaseUrl: 'http://127.0.0.1:1',
    profileName: options.profileName ?? 'mobile',
    rateLimitRpm: options.rateLimitRpm,
    resolveIdentity,
  }));

  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

async function connectClient(baseUrl: string, apiKey: string): Promise<Client> {
  const client = new Client({ name: 'agent-hq-test-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
  }));
  return client;
}

describe('MCP Streamable HTTP transport', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    await harness?.close();
    harness = null;
  });

  it('serves the profile tool list to an authenticated MCP client', async () => {
    harness = await startHarness();
    const client = await connectClient(harness.baseUrl, VALID_KEY);

    try {
      const listed = await client.listTools();
      const names = new Set(listed.tools.map((tool) => tool.name));

      expect(names).toEqual(resolveMcpToolProfile('mobile').toolNames);
    } finally {
      await client.close();
    }
  });

  it('serves the full surface when configured with the full profile', async () => {
    harness = await startHarness({ profileName: 'full' });
    const client = await connectClient(harness.baseUrl, VALID_KEY);

    try {
      const listed = await client.listTools();
      const mobileCount = resolveMcpToolProfile('mobile').toolNames?.size ?? 0;

      expect(listed.tools.length).toBeGreaterThan(mobileCount * 3);
    } finally {
      await client.close();
    }
  });

  it('refuses a request with no MCP key', async () => {
    harness = await startHarness();

    const res = await fetch(`${harness.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/);
    await expect(res.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      error: { message: expect.stringMatching(/Authorization required/i) },
    });
  });

  it('refuses a request whose MCP key does not resolve', async () => {
    harness = await startHarness();

    const res = await fetch(`${harness.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ahq_mcp_nope' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      error: { message: 'Invalid MCP API key' },
    });
  });

  it('rate limits per key', async () => {
    harness = await startHarness({ rateLimitRpm: 1 });

    const send = () => fetch(`${harness!.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${VALID_KEY}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    const first = await send();
    const second = await send();

    expect(first.status).not.toBe(429);
    expect(second.status).toBe(429);
  });
});

describe('resolveMcpHttpConfigFromEnv', () => {
  it('defaults to the mobile profile on the local API', () => {
    expect(resolveMcpHttpConfigFromEnv({}, 3501)).toEqual({
      enabled: true,
      apiBaseUrl: 'http://127.0.0.1:3501',
      profileName: 'mobile',
      rateLimitRpm: 120,
      allowedHosts: [],
    });
  });

  it('reads overrides and treats only "0" as disabled', () => {
    expect(resolveMcpHttpConfigFromEnv({
      AGENT_HQ_MCP_HTTP_ENABLED: '0',
      AGENT_HQ_INTERNAL_BASE_URL: 'http://127.0.0.1:3511',
      AGENT_HQ_MCP_HTTP_TOOL_PROFILE: 'full',
      AGENT_HQ_MCP_HTTP_RATE_LIMIT_RPM: '30',
      AGENT_HQ_MCP_HTTP_ALLOWED_HOSTS: 'hq.example.com, localhost',
    }, 3501)).toEqual({
      enabled: false,
      apiBaseUrl: 'http://127.0.0.1:3511',
      profileName: 'full',
      rateLimitRpm: 30,
      allowedHosts: ['hq.example.com', 'localhost'],
    });

    expect(resolveMcpHttpConfigFromEnv({ AGENT_HQ_MCP_HTTP_ENABLED: 'false' }, 3501).enabled).toBe(true);
  });
});
