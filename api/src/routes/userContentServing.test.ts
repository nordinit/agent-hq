import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { apiSecurityHeaders, contentDispositionValue, normalizeDeclaredMimeType } from '../lib/userContentHeaders';
import artifactsRouter from './artifacts';
import chatRouter from './chat';
import tasksRouter from './tasks';

const ENV_KEYS = ['AGENT_HQ_TASK_UPLOADS_DIR', 'AGENT_HQ_CHAT_UPLOADS_DIR', 'AGENT_HQ_ALLOWED_WORKSPACE_ROOTS'] as const;

describe('serving user-supplied files', () => {
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let tempDir = '';
  let workspace = '';
  let server: Server;
  let baseUrl = '';

  beforeEach(async () => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'user-content-')));
    workspace = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspace);
    process.env.AGENT_HQ_TASK_UPLOADS_DIR = path.join(tempDir, 'tasks');
    process.env.AGENT_HQ_CHAT_UPLOADS_DIR = path.join(tempDir, 'chat');
    process.env.AGENT_HQ_ALLOWED_WORKSPACE_ROOTS = tempDir;

    const db = await setupTestDb();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
    await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
    await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (5, 1, 'Project')`);
    await db.run(`INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type) VALUES (6, 1, 5, 'Workflow', 'generic')`);
    await db.run(`INSERT INTO tasks (id, tenant_id, project_id, workflow_id, title, status) VALUES (50, 1, 5, 6, 'Task', 'todo')`);
    await db.run(`
      INSERT INTO agents (id, tenant_id, name, session_key, workspace_path)
      VALUES (9, 1, 'Worker', 'agent:worker:main', ?)
    `, workspace);

    const app = express();
    app.use(apiSecurityHeaders);
    app.use(express.json());
    app.use('/api/v1/tasks', tasksRouter);
    app.use('/api/v1/chat', chatRouter);
    app.use('/api/v1/artifacts', artifactsRouter);
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
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  async function uploadTaskAttachment(filename: string, type: string, content: string): Promise<number> {
    const form = new FormData();
    form.append('file', new Blob([content], { type }), filename);
    const res = await fetch(`${baseUrl}/api/v1/tasks/50/attachments`, { method: 'POST', body: form });
    expect(res.status).toBe(201);
    return (await res.json() as { id: number }).id;
  }

  it('serves scriptable task attachments as sandboxed downloads', async () => {
    const id = await uploadTaskAttachment('report.html', 'text/html', '<script>alert(document.domain)</script>');
    const res = await fetch(`${baseUrl}/api/v1/tasks/50/attachments/${id}/download`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="report.html"; filename*=UTF-8''report.html`,
    );
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toMatch(/^sandbox; default-src 'none'/);
  });

  it('keeps inert task attachments inline', async () => {
    const png = await uploadTaskAttachment('chart.png', 'image/png', 'not really a png');
    const pngRes = await fetch(`${baseUrl}/api/v1/tasks/50/attachments/${png}/download`);
    expect(pngRes.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(pngRes.headers.get('content-type')).toBe('image/png');

    const text = await uploadTaskAttachment('notes.txt', 'text/plain', 'hello');
    const textRes = await fetch(`${baseUrl}/api/v1/tasks/50/attachments/${text}/download`);
    expect(textRes.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(textRes.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });

  it('serves an uploaded SVG chat attachment as a download', async () => {
    const form = new FormData();
    form.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'], { type: 'image/svg+xml' }), 'logo.svg');
    const upload = await fetch(`${baseUrl}/api/v1/chat/attachments`, { method: 'POST', body: form });
    expect(upload.status).toBe(200);
    const { attachment } = await upload.json() as { attachment: { id: number } };

    const res = await fetch(`${baseUrl}/api/v1/chat/attachments/${attachment.id}/download`);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toMatch(/sandbox/);
  });

  it('serves workspace SVG artifacts as sandboxed downloads and images inline', async () => {
    fs.writeFileSync(path.join(workspace, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    fs.writeFileSync(path.join(workspace, 'shot.png'), 'png bytes');

    const svg = await fetch(`${baseUrl}/api/v1/artifacts/raw?agentId=9&path=diagram.svg`);
    expect(svg.status).toBe(200);
    // Still an image type, so an <img> preview keeps working; never a document.
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('content-disposition')).toMatch(/^attachment; filename="diagram.svg"/);
    expect(svg.headers.get('content-security-policy')).toMatch(/sandbox/);

    const png = await fetch(`${baseUrl}/api/v1/artifacts/raw?agentId=9&path=shot.png`);
    expect(png.headers.get('content-disposition')).toMatch(/^inline;/);
  });

  it('sets baseline headers on ordinary API responses', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks/50/attachments`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  });
});

describe('user content header helpers', () => {
  it('accepts only well-formed MIME types', () => {
    expect(normalizeDeclaredMimeType('Image/PNG; charset=binary')).toBe('image/png');
    expect(normalizeDeclaredMimeType('text/html\r\nSet-Cookie: x=1')).toBeNull();
    expect(normalizeDeclaredMimeType('')).toBeNull();
    expect(normalizeDeclaredMimeType(undefined)).toBeNull();
  });

  it('builds a header-safe Content-Disposition for any filename', () => {
    expect(contentDispositionValue('attachment', 'evil "report".html')).toBe(
      `attachment; filename="evil _report_.html"; filename*=UTF-8''evil%20%22report%22.html`,
    );
    expect(contentDispositionValue('attachment', 'résumé\r\n.pdf')).toBe(
      `attachment; filename="r_sum___.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%0D%0A.pdf`,
    );
    expect(contentDispositionValue('inline', '')).toBe(`inline; filename="download"; filename*=UTF-8''download`);
  });
});
