import { setupTestDb, teardownTestDb } from '../db/testDb';
import express from 'express';
import type { Server } from 'http';
import type { Db } from '../db/adapter/types';
import type { AdapterSource, IngestResult } from '../lib/sessionAdapters/types';

let db: Db;
let capturedSource: AdapterSource | null = null;
let adapterResult: IngestResult | null = null;
let adapterCalls = 0;

jest.mock('../db/client', () => ({
  getDb: () => db,
}));

jest.mock('../lib/sessionAdapters', () => {
  const adapter = {
    runtime: 'test',
    ingest: async (source: AdapterSource) => {
      adapterCalls += 1;
      capturedSource = source;
      return adapterResult;
    },
    resolveLiveChat: async () => null,
  };
  return {
    resolveSessionAdapter: () => adapter,
    resolveSessionAdapterForKey: () => adapter,
  };
});

import sessionsRouter from './sessions';

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/sessions', sessionsRouter);
  const server = await new Promise<Server>((resolve, reject) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
    bound.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

describe('session adapter ingestion tenant ownership', () => {
  beforeEach(async () => {
    db = await setupTestDb();
    capturedSource = null;
    adapterResult = null;
    adapterCalls = 0;
    await db.run(`
      INSERT INTO tenants (id, name, slug, is_default)
      VALUES (1, 'Tenant One', 'tenant-one', 1), (2, 'Tenant Two', 'tenant-two', 0)
    `);
    await db.run(`
      INSERT INTO app_settings (key, value)
      VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')
    `);
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('assigns adapter-only sessions to the request tenant', async () => {
    adapterResult = {
      session: {
        externalKey: 'cron:tenant-safe:1770000000000',
        runtime: 'cron',
        status: 'completed',
        title: 'Tenant-safe cron run',
      },
      messages: [],
    };

    const { server, baseUrl } = await startServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/sessions/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ external_key: 'cron:tenant-safe', runtime: 'cron' }),
      });

      expect(response.status).toBe(200);
      expect(capturedSource).toEqual(expect.objectContaining({
        externalKey: 'cron:tenant-safe',
        tenantId: 1,
      }));
      const row = await db.get(`
        SELECT tenant_id, external_key
        FROM sessions
        WHERE external_key = 'cron:tenant-safe:1770000000000'
      `) as { tenant_id: number; external_key: string };
      expect(row).toEqual({ tenant_id: 1, external_key: 'cron:tenant-safe:1770000000000' });
    } finally {
      await stopServer(server);
    }
  });

  it('rejects linked records owned by another tenant before invoking the adapter', async () => {
    await db.run(`
      INSERT INTO agents (id, tenant_id, name, session_key)
      VALUES (202, 2, 'Tenant Two Agent', 'agent:tenant-two:main')
    `);

    const { server, baseUrl } = await startServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/sessions/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ external_key: 'run:foreign-agent', runtime: 'test', agent_id: 202 }),
      });

      expect(response.status).toBe(404);
      expect(adapterCalls).toBe(0);
      expect(await db.get(`SELECT id FROM sessions WHERE external_key = 'run:foreign-agent'`)).toBeUndefined();
    } finally {
      await stopServer(server);
    }
  });

  it('rejects foreign linked records inferred by the adapter without writing a session', async () => {
    await db.run(`
      INSERT INTO agents (id, tenant_id, name, session_key)
      VALUES (203, 2, 'Inferred Tenant Two Agent', 'agent:tenant-two:inferred')
    `);
    adapterResult = {
      session: {
        externalKey: 'run:inferred-foreign-agent',
        runtime: 'test',
        agentId: 203,
        status: 'completed',
      },
      messages: [],
    };

    const { server, baseUrl } = await startServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/sessions/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ external_key: 'run:inferred-foreign-agent', runtime: 'test' }),
      });

      expect(response.status).toBe(404);
      expect(adapterCalls).toBe(1);
      expect(await db.get(`SELECT id FROM sessions WHERE external_key = 'run:inferred-foreign-agent'`)).toBeUndefined();
    } finally {
      await stopServer(server);
    }
  });
});
