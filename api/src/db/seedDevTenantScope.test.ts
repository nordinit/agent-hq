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
  // setupTestDb() picks the engine from AGENT_HQ_TEST_PG_URL, so this file runs unchanged on
  // SQLite and on PostgreSQL. tempDir survives because WORKSPACE_PARENT is filesystem state that
  // seed-dev.ts writes agent workspace paths from — nothing to do with the database.
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-dev-tenant-scope-'));
  process.env.WORKSPACE_PARENT = path.join(tempDir, 'workspaces');
  await setupTestDb();
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

  // Snapshot the pre-seed projects instead of hardcoding them. Creating the default tenant against
  // the complete PostgreSQL schema provisions its starter workspace (a 'Default Project' row),
  // whereas on SQLite the default tenant is created part-way through initSchema, before
  // canProvisionTenantDefaultWorkspace()'s tables exist, so it gets none. That difference belongs
  // to tenant bootstrap, not to seed-dev, and asserting the DELTA pins seed-dev's behaviour on both
  // engines — more tightly than the old fixed list did, because it now covers every projects row
  // rather than three names.
  const projectsBeforeSeed = await listProjects();

  const apiRoot = path.resolve(__dirname, '../..');
  const tsxBin = path.join(apiRoot, 'node_modules', '.bin', 'tsx');
  const result = spawnSync(tsxBin, ['src/db/seed-dev.ts'], {
    cwd: apiRoot,
    // The child resolves its own connection from the environment, so it must inherit whichever
    // selector setupTestDb() set: AGENT_HQ_DB_PATH (a temp file) on SQLite, DATABASE_URL (the
    // per-worker clone) on PostgreSQL. Both are already on process.env, so inheriting is enough.
    //
    // The AGENT_HQ_DB_PATH fallback is a guard, not a normal path: seed-dev.ts calls initSchema()
    // unconditionally and initSchema() builds its DDL on the raw better-sqlite3 connection with no
    // dialect check, so under DATABASE_URL the child still opens a SQLite database alongside the
    // PostgreSQL one it seeds. jest-setup-env.ts pins AGENT_HQ_DB_PATH to ':memory:', which keeps
    // that throwaway off disk here; the fallback makes sure it can never land on a real file if
    // that ever stops being true.
    env: {
      ...process.env,
      AGENT_HQ_DB_PATH: process.env.AGENT_HQ_DB_PATH ?? path.join(tempDir, 'throwaway-sqlite.db'),
      WORKSPACE_PARENT: path.join(tempDir, 'workspaces'),
    },
    encoding: 'utf-8',
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');

  const db = getDb();
  for (const table of ['projects', 'agents', 'sprints', 'tasks']) {
    const nullCount = await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id IS NULL`) as { n: number | string };
    // COUNT(*) is a bigint on PostgreSQL and arrives as a string; SQLite returns a number.
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
