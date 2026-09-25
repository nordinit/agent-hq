import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { signedChatAttachmentQuery } from '../lib/apiAuth';
import { authorizeMcpApiRequestIfPresent, issueMcpApiKeyForAgent } from '../lib/mcpApiAuth';
import { authenticateTestApiRequest, operatorFetch, testOperatorToken } from '../lib/testApiAuth';
import chatRouter from './chat';

describe('chat attachment tenant scope', () => {
  const originalUploadsDir = process.env.AGENT_HQ_CHAT_UPLOADS_DIR;
  let tempDir = '';
  let server: Server;
  let baseUrl = '';
  let tenantOneAdminKey = '';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-attachment-tenant-'));
    process.env.AGENT_HQ_CHAT_UPLOADS_DIR = tempDir;
    const db = await setupTestDb();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'One', 'one', 1), (2, 'Two', 'two', 0)`);
    await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
    await db.run(`
      INSERT INTO agents (id, tenant_id, name, session_key)
      VALUES (11, 1, 'One Agent', 'agent:one:main'), (21, 2, 'Two Agent', 'agent:two:main')
    `);
    await db.run(`INSERT INTO job_instances (id, tenant_id, agent_id, status) VALUES (210, 2, 21, 'running')`);
    const file = (name: string) => {
      const filePath = path.join(tempDir, name);
      fs.writeFileSync(filePath, `contents of ${name}`);
      return filePath;
    };
    await db.run(`
      INSERT INTO chat_attachments (id, instance_id, agent_id, filename, filepath, mime_type)
      VALUES (1, NULL, 11, 'one.txt', ?, 'text/plain'),
             (2, 210, NULL, 'two-run.txt', ?, 'text/plain'),
             (3, NULL, 21, 'two-agent.txt', ?, 'text/plain'),
             (4, NULL, NULL, 'unowned.txt', ?, 'text/plain')
    `, file('one.txt'), file('two-run.txt'), file('two-agent.txt'), file('unowned.txt'));
    await db.run(`SELECT setval(pg_get_serial_sequence('chat_attachments', 'id'), 100)`);
    tenantOneAdminKey = (await issueMcpApiKeyForAgent(db, 11, 'Tenant one admin', 'admin')).apiKey;

    const app = express();
    app.use('/api/v1', authenticateTestApiRequest());
    app.use(express.json());
    app.use('/api/v1', authorizeMcpApiRequestIfPresent);
    app.use('/api/v1/chat', chatRouter);
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
    if (originalUploadsDir === undefined) delete process.env.AGENT_HQ_CHAT_UPLOADS_DIR;
    else process.env.AGENT_HQ_CHAT_UPLOADS_DIR = originalUploadsDir;
  });

  const download = (id: number | string, init: RequestInit = {}, suffix = '') =>
    operatorFetch(`${baseUrl}/api/v1/chat/attachments/${id}/download${suffix}`, init);

  it("keeps the operator inside the requested tenant's attachments", async () => {
    await expect(download(1).then((res) => res.text())).resolves.toBe('contents of one.txt');
    // Owned by tenant 2 through its run, and through its agent.
    expect((await download(2)).status).toBe(404);
    expect((await download(3)).status).toBe(404);
    // An attachment uploaded before any run existed has no owner; the operator can read it.
    expect((await download(4)).status).toBe(200);
    // Switching the active tenant to 2 reaches them.
    await getDb().run(`UPDATE app_settings SET value = '2' WHERE key = 'active_tenant_id'`);
    expect((await download(2)).status).toBe(200);
    expect((await download(3)).status).toBe(200);
    expect((await download(1)).status).toBe(404);
    expect((await download('abc')).status).toBe(404);
  });

  it("refuses another tenant's attachments, and unowned ones, to a tenant-bound MCP key", async () => {
    const asKey = { headers: { 'x-api-key': tenantOneAdminKey } };
    expect((await download(1, asKey)).status).toBe(200);
    expect((await download(2, asKey)).status).toBe(404);
    expect((await download(3, asKey)).status).toBe(404);
    expect((await download(4, asKey)).status).toBe(404);
  });

  it('still serves a signed link to an agent that presents no credential', async () => {
    const query = signedChatAttachmentQuery(2, testOperatorToken());
    // Plain fetch: the agent's HTTP tool has no Agent HQ credential.
    const res = await fetch(`${baseUrl}/api/v1/chat/attachments/2/download${query}`);
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('contents of two-run.txt');
    expect((await fetch(`${baseUrl}/api/v1/chat/attachments/3/download${query}`)).status).toBe(401);
  });

  it('only records an upload against a run or agent in the requested tenant', async () => {
    const upload = (fields: Record<string, string>) => {
      const form = new FormData();
      form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'note.txt');
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      return operatorFetch(`${baseUrl}/api/v1/chat/attachments`, { method: 'POST', body: form });
    };
    expect((await upload({ instance_id: '210' })).status).toBe(404);
    expect((await upload({ agent_id: '21' })).status).toBe(404);
    expect((await upload({ agent_id: '11' })).status).toBe(200);
    const stored = await getDb().all('SELECT agent_id FROM chat_attachments WHERE id > 100');
    expect(stored).toEqual([{ agent_id: 11 }]);
  });
});
