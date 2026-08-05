import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import workflowFilesRouter from './workflow-files';

const ORIGINAL_UPLOADS_DIR = process.env.AGENT_HQ_WORKFLOW_UPLOADS_DIR;

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

describe('workflow file versions', () => {
  let tempDir: string;
  let server: Server | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    // tempDir isolates filesystem uploads; setupTestDb() owns the PostgreSQL fixture state.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-files-'));
    process.env.AGENT_HQ_WORKFLOW_UPLOADS_DIR = path.join(tempDir, 'uploads');

    await setupTestDb();
    const db = getDb();

    // The PostgreSQL fixture is schema-only and truncated between tests. Seed the default tenant
    // and selection settings explicitly because resolveTenantIdFromRequest validates both.
    await db.run(`INSERT INTO tenants (name, slug, is_default) VALUES (?, ?, 1) ON CONFLICT DO NOTHING`, 'Default Tenant', 'default');
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (?, ?, ?, 0), (?, ?, ?, 0) ON CONFLICT DO NOTHING`, 101, 'Tenant One', 'tenant-one', 202, 'Tenant Two', 'tenant-two');
    await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (?, ?, ?), (?, ?, ?)`, 700, 101, 'Tenant One Project', 800, 202, 'Tenant Two Project');
    await db.run(`
      INSERT INTO sprints (id, tenant_id, project_id, name, goal, status)
      VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)
    `, 900, 101, 700, 'Tenant One Workflow', '', 'active', 901, 101, 700, 'Other Tenant One Workflow', '', 'active', 902, 202, 800, 'Tenant Two Workflow', '', 'active');

    const defaultTenant = await db.get(`SELECT id FROM tenants WHERE is_default = 1 ORDER BY id ASC LIMIT 1`) as { id: number } | undefined;
    if (!defaultTenant) throw new Error('test fixture failed to establish a default tenant');
    // An UPDATE would match no row against the schema-only fixture, leaving the active tenant at the
    // default and turning every cross-tenant 404 below into an assertion about nothing.
    await db.run(
      `INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', ?), ('active_tenant_id', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      String(defaultTenant.id),
      '101',
    );

    const app = express();
    app.use('/api/v1/projects/:projectId/workflows/:workflowId/files', workflowFilesRouter);

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
    await teardownTestDb();
    restoreEnv('AGENT_HQ_WORKFLOW_UPLOADS_DIR', ORIGINAL_UPLOADS_DIR);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('records workflow scope, replaces the current file in place, and returns version history', async () => {
    const upload = await fetch(`${baseUrl}/api/v1/projects/700/workflows/900/files`, {
      method: 'POST',
      body: fileForm('spec.md', 'original', 'alice'),
    });
    expect(upload.status).toBe(201);
    const uploaded = await upload.json() as {
      id: number;
      tenant_id: number;
      project_id: number;
      workflow_id: number;
      scope: string;
      size_bytes: number;
      uploaded_by: string;
      updated_by: string;
      current_version: number;
      created_at: string;
    };
    expect(uploaded).toMatchObject({
      tenant_id: 101,
      project_id: 700,
      workflow_id: 900,
      scope: 'workflow',
      size_bytes: 8,
      uploaded_by: 'alice',
      updated_by: 'alice',
      current_version: 1,
    });

    const replace = await fetch(`${baseUrl}/api/v1/projects/700/workflows/900/files/${uploaded.id}`, {
      method: 'PUT',
      body: fileForm('spec.md', 'replacement text', 'cinder'),
    });
    expect(replace.status).toBe(200);
    const replaced = await replace.json() as {
      id: number;
      size_bytes: number;
      uploaded_by: string;
      updated_by: string;
      current_version: number;
      created_at: string;
      workflow_id: number;
      scope: string;
    };
    expect(replaced).toMatchObject({
      id: uploaded.id,
      workflow_id: 900,
      scope: 'workflow',
      size_bytes: 16,
      uploaded_by: 'alice',
      updated_by: 'cinder',
      current_version: 2,
    });
    expect(replaced.created_at).toBe(uploaded.created_at);

    const history = await fetch(`${baseUrl}/api/v1/projects/700/workflows/900/files/${uploaded.id}/versions`);
    expect(history.status).toBe(200);
    const versions = await history.json() as Array<{
      workflow_id: number;
      scope: string;
      version_number: number;
      size_bytes: number;
      created_by: string;
      change_source: string;
    }>;
    expect(versions).toEqual([
      expect.objectContaining({ workflow_id: 900, scope: 'workflow', version_number: 2, size_bytes: 16, created_by: 'cinder', change_source: 'api_replace' }),
      expect.objectContaining({ workflow_id: 900, scope: 'workflow', version_number: 1, size_bytes: 8, created_by: 'alice', change_source: 'api_upload' }),
    ]);

    const download = await fetch(`${baseUrl}/api/v1/projects/700/workflows/900/files/${uploaded.id}/download`);
    expect(download.status).toBe(200);
    await expect(download.text()).resolves.toBe('replacement text');
  });

  it('rejects cross-workflow and cross-tenant workflow file access', async () => {
    const upload = await fetch(`${baseUrl}/api/v1/projects/700/workflows/900/files`, {
      method: 'POST',
      body: fileForm('scope.txt', 'tenant one', 'alice'),
    });
    expect(upload.status).toBe(201);
    const uploaded = await upload.json() as { id: number };

    const crossWorkflowHistory = await fetch(`${baseUrl}/api/v1/projects/700/workflows/901/files/${uploaded.id}/versions`);
    expect(crossWorkflowHistory.status).toBe(404);

    const wrongProject = await fetch(`${baseUrl}/api/v1/projects/800/workflows/900/files/${uploaded.id}`);
    expect(wrongProject.status).toBe(404);

    await getDb().run(`UPDATE app_settings SET value = ? WHERE key = 'active_tenant_id'`, '202');

    const crossTenantReplace = await fetch(`${baseUrl}/api/v1/projects/700/workflows/900/files/${uploaded.id}`, {
      method: 'PUT',
      body: fileForm('scope.txt', 'tenant two overwrite', 'mallory'),
    });
    expect(crossTenantReplace.status).toBe(404);
  });
});
