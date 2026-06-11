import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { closeDb, getDb } from './client';
import { initSchema } from './schema';
import { createTenantWithDefaults, getDefaultTenantId } from '../lib/tenantContext';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  closeDb();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-dev-tenant-scope-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');
  process.env.AGENT_HQ_DB_PATH = dbPath;
  process.env.WORKSPACE_PARENT = path.join(tempDir, 'workspaces');
});

afterEach(() => {
  closeDb();
  delete process.env.AGENT_HQ_DB_PATH;
  delete process.env.WORKSPACE_PARENT;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

it('seeds dev fixtures into the default tenant without leaking into another tenant', () => {
  initSchema();
  const setupDb = getDb();
  const defaultTenantId = getDefaultTenantId(setupDb);
  const otherTenant = createTenantWithDefaults(setupDb, { name: 'EcoPool', slug: 'ecopool' });
  setupDb.prepare(`
    INSERT INTO projects (tenant_id, name, description, context_md)
    VALUES (?, 'Tenant 2 Existing', 'preexisting tenant 2 row', '')
  `).run(otherTenant.id);
  closeDb();

  const apiRoot = path.resolve(__dirname, '../..');
  const tsxBin = path.join(apiRoot, 'node_modules', '.bin', 'tsx');
  const result = spawnSync(tsxBin, ['src/db/seed-dev.ts'], {
    cwd: apiRoot,
    env: {
      ...process.env,
      AGENT_HQ_DB_PATH: dbPath,
      WORKSPACE_PARENT: path.join(tempDir, 'workspaces'),
    },
    encoding: 'utf-8',
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');

  const db = new Database(dbPath);
  try {
    for (const table of ['projects', 'agents', 'sprints', 'tasks']) {
      const nullCount = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id IS NULL`).get() as { n: number };
      expect(nullCount.n).toBe(0);
    }

    const seededProjects = db.prepare(`
      SELECT tenant_id, name
      FROM projects
      WHERE name IN ('Agency', 'Agent HQ', 'Default Project')
      ORDER BY name, tenant_id
    `).all() as Array<{ tenant_id: number; name: string }>;
    expect(seededProjects).toEqual([
      { tenant_id: defaultTenantId, name: 'Agency' },
      { tenant_id: defaultTenantId, name: 'Agent HQ' },
      { tenant_id: otherTenant.id, name: 'Default Project' },
    ]);

    const tenantTwoDevTaskCount = db.prepare(`
      SELECT COUNT(*) AS n
      FROM tasks
      WHERE tenant_id = ? AND title LIKE 'Sample dev task%'
    `).get(otherTenant.id) as { n: number };
    expect(tenantTwoDevTaskCount.n).toBe(0);

    const defaultTaskCount = db.prepare(`
      SELECT COUNT(*) AS n
      FROM tasks
      WHERE tenant_id = ? AND title LIKE 'Sample dev task%'
    `).get(defaultTenantId) as { n: number };
    expect(defaultTaskCount.n).toBe(3);
  } finally {
    db.close();
  }
});
