import express from 'express';
import type { Server } from 'http';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { buildRuntimeConfigDefaults } from '../lib/runtimeOnboarding';
import { probeGateway } from '../lib/gatewayHealth';
import setupRouter from './setup';

jest.mock('../lib/gatewayHealth', () => ({
  probeGateway: jest.fn(),
}));

const mockedProbeGateway = probeGateway as jest.MockedFunction<typeof probeGateway>;
const originalApiUrl = process.env.AGENT_HQ_API_URL;

async function resetDb(): Promise<void> {
  await setupTestDb();
  // The callback-readiness assertions turn on this value, so it is pinned to a non-localhost URL
  // for every test and overridden in place by the one test that cares about localhost.
  process.env.AGENT_HQ_API_URL = 'http://agent-hq.test';
  mockedProbeGateway.mockReset();
}

async function cleanup(): Promise<void> {
  await teardownTestDb();
  if (originalApiUrl == null) delete process.env.AGENT_HQ_API_URL;
  else process.env.AGENT_HQ_API_URL = originalApiUrl;
}

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/setup', setupRouter);
  const server = await new Promise<Server>((resolve) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

describe('setup runtime onboarding', () => {
  beforeEach(resetDb);
  afterEach(cleanup);

  it('saves and reports a healthy OpenClaw Gateway runtime', async () => {
    mockedProbeGateway.mockResolvedValue({
      ok: true,
      state: 'ready',
      reachable: true,
      pairing_required: false,
      checked_at: '2026-06-28T18:00:00.000Z',
      error: null,
    });
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/v1/setup/runtime/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'openclaw', endpoint: 'ws://127.0.0.1:17601', auth_token: 'gw-token' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as Record<string, any>;
      expect(body.status.state).toBe('healthy');
      expect(body.status.auth_present).toBe(true);
      expect(body.status.capabilities).toEqual(expect.arrayContaining(['chat.send', 'agent_hq.lifecycle_callbacks']));
      expect(body.status.callback_ready).toBe(true);
      expect(mockedProbeGateway).toHaveBeenCalledWith('ws://127.0.0.1:17601');

      const defaults = await buildRuntimeConfigDefaults(getDb());
      expect(defaults).toMatchObject({
        gateway_ws_url: 'ws://127.0.0.1:17601',
        onboarding_runtime: {
          kind: 'openclaw',
          endpoint: 'ws://127.0.0.1:17601',
          auth_present: true,
        },
      });
    } finally {
      await stopServer(server);
    }
  });

  it('reports unreachable OpenClaw Gateway runtime with repair guidance', async () => {
    mockedProbeGateway.mockResolvedValue({
      ok: false,
      state: 'offline',
      reachable: false,
      pairing_required: false,
      checked_at: '2026-06-28T18:00:00.000Z',
      error: 'ECONNREFUSED',
    });
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/v1/setup/runtime/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'openclaw', endpoint: 'ws://127.0.0.1:17601' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, any>;
      expect(body.state).toBe('unreachable');
      expect(body.reachable).toBe(false);
      expect(body.repair_guidance.join('\n')).toMatch(/Start the OpenClaw gateway/);
    } finally {
      await stopServer(server);
    }
  });

  it('reports unauthorized OpenClaw Gateway runtime when pairing or token repair is needed', async () => {
    mockedProbeGateway.mockResolvedValue({
      ok: false,
      state: 'auth_error',
      reachable: false,
      pairing_required: false,
      checked_at: '2026-06-28T18:00:00.000Z',
      error: 'Gateway token mismatch',
    });
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/v1/setup/runtime/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'openclaw', endpoint: 'ws://127.0.0.1:17601', auth_token: 'bad' }),
      });
      const body = await res.json() as Record<string, any>;
      expect(body.state).toBe('unauthorized');
      expect(body.authorized).toBe(false);
      expect(body.repair_guidance.join('\n')).toMatch(/gateway auth token/);
    } finally {
      await stopServer(server);
    }
  });

  it('reports partial readiness when callbacks use localhost for a remote runtime', async () => {
    process.env.AGENT_HQ_API_URL = 'http://localhost:3501';
    mockedProbeGateway.mockResolvedValue({
      ok: true,
      state: 'ready',
      reachable: true,
      pairing_required: false,
      checked_at: '2026-06-28T18:00:00.000Z',
      error: null,
    });
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/v1/setup/runtime/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'openclaw', endpoint: 'ws://runtime.example:17601' }),
      });
      const body = await res.json() as Record<string, any>;
      expect(body.state).toBe('partial');
      expect(body.callback_ready).toBe(false);
      expect(body.repair_guidance.join('\n')).toMatch(/network-reachable Agent HQ API URL/);
    } finally {
      await stopServer(server);
    }
  });
});

