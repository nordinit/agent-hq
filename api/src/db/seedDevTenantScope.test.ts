import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { closeDb, getDb } from './client';
import { initSchema } from './schema';
import { createTenantWithDefaults, getDefaultTenantId } from '../lib/tenantContext';
import { SqliteAdapter } from "./adapter/SqliteAdapter";

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

it('seeds dev fixtures into the default tenant without leaking into another tenant', async () => {
  await initSchema();
  const setupDb = getDb();
  const defaultTenantId = await getDefaultTenantId(setupDb);
  const otherTenant = await createTenantWithDefaults(setupDb, { name: 'EcoPool', slug: 'ecopool' });
  await setupDb.run(`
    INSERT INTO projects (tenant_id, name, description, context_md)
    VALUES (?, 'Tenant 2 Existing', 'preexisting tenant 2 row', '')
  `, otherTenant.id);
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

  const dbRaw = new Database(dbPath);
    const db = new SqliteAdapter(dbRaw);
  try {
    for (const table of ['projects', 'agents', 'sprints', 'tasks']) {
      const nullCount = await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id IS NULL`) as { n: number };
      expect(nullCount.n).toBe(0);
    }

    const seededProjects = await db.all(`
      SELECT tenant_id, name
      FROM projects
      WHERE name IN ('Agency', 'Agent HQ', 'Default Project')
      ORDER BY name, tenant_id
    `) as Array<{ tenant_id: number; name: string }>;
    expect(seededProjects).toEqual([
      { tenant_id: defaultTenantId, name: 'Agency' },
      { tenant_id: defaultTenantId, name: 'Agent HQ' },
      { tenant_id: otherTenant.id, name: 'Default Project' },
    ]);

    const tenantTwoDevTaskCount = await db.get(`
      SELECT COUNT(*) AS n
      FROM tasks
      WHERE tenant_id = ? AND title LIKE 'Sample dev task%'
    `, otherTenant.id) as { n: number };
    expect(tenantTwoDevTaskCount.n).toBe(0);

    const defaultTaskCount = await db.get(`
      SELECT COUNT(*) AS n
      FROM tasks
      WHERE tenant_id = ? AND title LIKE 'Sample dev task%'
    `, defaultTenantId) as { n: number };
    expect(defaultTaskCount.n).toBe(3);
  } finally {
    dbRaw.close();
  }
});
