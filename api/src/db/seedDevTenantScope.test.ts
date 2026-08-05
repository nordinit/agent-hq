import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from './client';
import { setupTestDb, teardownTestDb } from './testDb';
import { createTenantWithDefaults, getDefaultTenantId } from '../lib/tenantContext';

let tempDir: string;

type ProjectRow = { tenant_id: number; name: string };

function sortProjects(rows: ProjectRow[]): ProjectRow[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name) || a.tenant_id - b.tenant_id);
}

async function listProjects(): Promise<ProjectRow[]> {
  return sortProjects(await getDb().all(`SELECT tenant_id, name FROM projects`) as ProjectRow[]);
}

beforeEach(async () => {
  // tempDir is filesystem state that seed-dev.ts writes agent workspace paths from.
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-dev-tenant-scope-'));
  process.env.WORKSPACE_PARENT = path.join(tempDir, 'workspaces');
  const db = await setupTestDb();
  const tenantId = Number((await db.run(
    `INSERT INTO tenants (name, slug, is_default) VALUES ('Default', 'default', 1)`,
  )).lastInsertId);
  await db.run(`
    INSERT INTO app_settings (key, value)
    VALUES ('default_tenant_id', ?), ('active_tenant_id', ?)
  `, String(tenantId), String(tenantId));
});

afterEach(async () => {
  await teardownTestDb();
  delete process.env.WORKSPACE_PARENT;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

it('seeds dev fixtures into the default tenant without leaking into another tenant', async () => {
  const setupDb = getDb();
  const defaultTenantId = await getDefaultTenantId(setupDb);
  const otherTenant = await createTenantWithDefaults(setupDb, { name: 'EcoPool', slug: 'ecopool' });
  await setupDb.run(`
    INSERT INTO projects (tenant_id, name, description, context_md)
    VALUES (?, 'Tenant 2 Existing', 'preexisting tenant 2 row', '')
  `, otherTenant.id);

  // Snapshot the pre-seed projects so the assertion covers only seed-dev's delta and preserves
  // every project explicitly installed by either tenant fixture.
  const projectsBeforeSeed = await listProjects();

  const apiRoot = path.resolve(__dirname, '../..');
  const tsxBin = path.join(apiRoot, 'node_modules', '.bin', 'tsx');
  const result = spawnSync(tsxBin, ['src/db/seed-dev.ts'], {
    cwd: apiRoot,
    // The child resolves its own PostgreSQL connection from the worker URL set by setupTestDb().
    env: {
      ...process.env,
      WORKSPACE_PARENT: path.join(tempDir, 'workspaces'),
    },
    encoding: 'utf-8',
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');

  const db = getDb();
  for (const table of ['projects', 'agents', 'sprints', 'tasks']) {
    const nullCount = await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id IS NULL`) as { n: number | string };
    // Coerce defensively at the assertion boundary in case a driver parser is overridden.
    expect(Number(nullCount.n)).toBe(0);
  }

  // seed-dev must add exactly 'Agency' and 'Agent HQ' to the DEFAULT tenant, and leave every other
  // project — including tenant 2's 'Default Project' and 'Tenant 2 Existing' — untouched.
  expect(await listProjects()).toEqual(sortProjects([
    ...projectsBeforeSeed,
    { tenant_id: defaultTenantId, name: 'Agency' },
    { tenant_id: defaultTenantId, name: 'Agent HQ' },
  ]));
  expect(projectsBeforeSeed).toContainEqual({ tenant_id: otherTenant.id, name: 'Default Project' });
  expect(projectsBeforeSeed).not.toContainEqual({ tenant_id: defaultTenantId, name: 'Agency' });

  const tenantTwoDevTaskCount = await db.get(`
    SELECT COUNT(*) AS n
    FROM tasks
    WHERE tenant_id = ? AND title LIKE 'Sample dev task%'
  `, otherTenant.id) as { n: number | string };
  expect(Number(tenantTwoDevTaskCount.n)).toBe(0);

  const defaultTaskCount = await db.get(`
    SELECT COUNT(*) AS n
    FROM tasks
    WHERE tenant_id = ? AND title LIKE 'Sample dev task%'
  `, defaultTenantId) as { n: number | string };
  expect(Number(defaultTaskCount.n)).toBe(3);
});
