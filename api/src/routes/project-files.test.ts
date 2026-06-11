import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { closeDb, getDb } from '../db/client';
import { initSchema } from '../db/schema';
import projectFilesRouter from './project-files';

const ORIGINAL_DB_PATH = process.env.AGENT_HQ_DB_PATH;
const ORIGINAL_UPLOADS_DIR = process.env.AGENT_HQ_PROJECT_UPLOADS_DIR;

function restoreEnv(name: string, value: string | undefined): void {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

function fileForm(filename: string, content: string, uploadedBy: string): FormData {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), filename);
  form.append('uploaded_by', uploadedBy);
  return form;
}

describe('project file versions', () => {
  let tempDir: string;
  let server: Server | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-files-'));
    process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq.db');
    process.env.AGENT_HQ_PROJECT_UPLOADS_DIR = path.join(tempDir, 'uploads');
    closeDb();

    initSchema();
    const db = getDb();
    db.prepare(`INSERT INTO tenants (id, name, slug, is_default) VALUES (?, ?, ?, ?), (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .run(101, 'Tenant One', 'tenant-one', 0, 202, 'Tenant Two', 'tenant-two', 0);
    db.prepare(`INSERT INTO projects (id, tenant_id, name) VALUES (?, ?, ?), (?, ?, ?)`)
      .run(700, 101, 'Tenant One Project', 800, 202, 'Tenant Two Project');
    db.prepare(`UPDATE app_settings SET value = ? WHERE key = 'active_tenant_id'`).run('101');

    const app = express();
    app.use('/api/v1/projects/:id/files', projectFilesRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close((err) => err ? reject(err) : resolve());
    });
    server = null;
    closeDb();
    restoreEnv('AGENT_HQ_DB_PATH', ORIGINAL_DB_PATH);
    restoreEnv('AGENT_HQ_PROJECT_UPLOADS_DIR', ORIGINAL_UPLOADS_DIR);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('records upload metadata, replaces the current file in place, and returns version history', async () => {
    const upload = await fetch(`${baseUrl}/api/v1/projects/700/files`, {
      method: 'POST',
      body: fileForm('notes.txt', 'original', 'alice'),
    });
    expect(upload.status).toBe(201);
    const uploaded = await upload.json() as {
      id: number;
      size_bytes: number;
      uploaded_by: string;
      updated_by: string;
      current_version: number;
      created_at: string;
      updated_at: string;
    };
    expect(uploaded).toMatchObject({
      size_bytes: 8,
      uploaded_by: 'alice',
      updated_by: 'alice',
      current_version: 1,
    });

    const replace = await fetch(`${baseUrl}/api/v1/projects/700/files/${uploaded.id}`, {
      method: 'PUT',
      body: fileForm('notes.txt', 'replacement text', 'forge'),
    });
    expect(replace.status).toBe(200);
    const replaced = await replace.json() as {
      id: number;
      size_bytes: number;
      uploaded_by: string;
      updated_by: string;
      current_version: number;
      created_at: string;
      updated_at: string;
    };
    expect(replaced).toMatchObject({
      id: uploaded.id,
      size_bytes: 16,
      uploaded_by: 'alice',
      updated_by: 'forge',
      current_version: 2,
    });
    expect(replaced.created_at).toBe(uploaded.created_at);
    expect(replaced.updated_at).not.toEqual('');

    const history = await fetch(`${baseUrl}/api/v1/projects/700/files/${uploaded.id}/versions`);
    expect(history.status).toBe(200);
    const versions = await history.json() as Array<{
      version_number: number;
      size_bytes: number;
      created_by: string;
      change_source: string;
      filename: string;
    }>;
    expect(versions).toEqual([
      expect.objectContaining({ version_number: 2, size_bytes: 16, created_by: 'forge', change_source: 'api_replace' }),
      expect.objectContaining({ version_number: 1, size_bytes: 8, created_by: 'alice', change_source: 'api_upload' }),
    ]);
    expect(versions[0].filename).not.toEqual('');

    const list = await fetch(`${baseUrl}/api/v1/projects/700/files`);
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual([
      expect.objectContaining({
        id: uploaded.id,
        size_bytes: 16,
        uploaded_by: 'alice',
        updated_by: 'forge',
        current_version: 2,
      }),
    ]);

    const download = await fetch(`${baseUrl}/api/v1/projects/700/files/${uploaded.id}/download`);
    expect(download.status).toBe(200);
    await expect(download.text()).resolves.toBe('replacement text');
  });

  it('keeps project file version reads tenant-scoped', async () => {
    const upload = await fetch(`${baseUrl}/api/v1/projects/700/files`, {
      method: 'POST',
      body: fileForm('scope.txt', 'tenant one', 'alice'),
    });
    expect(upload.status).toBe(201);
    const uploaded = await upload.json() as { id: number };

    getDb().prepare(`UPDATE app_settings SET value = ? WHERE key = 'active_tenant_id'`).run('202');

    const crossTenantHistory = await fetch(`${baseUrl}/api/v1/projects/700/files/${uploaded.id}/versions`);
    expect(crossTenantHistory.status).toBe(404);

    const crossTenantReplace = await fetch(`${baseUrl}/api/v1/projects/700/files/${uploaded.id}`, {
      method: 'PUT',
      body: fileForm('scope.txt', 'tenant two overwrite', 'mallory'),
    });
    expect(crossTenantReplace.status).toBe(404);
  });
});
