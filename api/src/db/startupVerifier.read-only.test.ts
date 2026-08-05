import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Db } from './adapter/types';
import { installInitialConfiguration } from './migrate';
import { verifyStartupSchema } from './startupVerifier';
import { setupTestDb, teardownTestDb } from './testDb';

type DatabaseSnapshot = Record<string, string[]>;

async function snapshotDatabaseRows(db: Db): Promise<DatabaseSnapshot> {
  const tables = await db.all<{ tablename: string }>(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);
  const snapshot: DatabaseSnapshot = {};
  for (const { tablename } of tables) {
    if (!/^[a-z0-9_]+$/.test(tablename)) {
      throw new Error(`Unsafe PostgreSQL table name in test fixture: ${tablename}`);
    }
    const rows = await db.all<{ content: string }>(`
      SELECT to_jsonb(snapshot_row)::text AS content
      FROM "${tablename}" AS snapshot_row
      ORDER BY to_jsonb(snapshot_row)::text
    `);
    snapshot[tablename] = rows.map(({ content }) => content);
  }
  return snapshot;
}

describe('PostgreSQL startup gate', () => {
  let db: Db;
  let workspaceParent = '';
  let previousWorkspaceParent: string | undefined;

  beforeEach(async () => {
    previousWorkspaceParent = process.env.WORKSPACE_PARENT;
    workspaceParent = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-startup-gate-'));
    process.env.WORKSPACE_PARENT = workspaceParent;
    db = await setupTestDb();
  });

  afterEach(async () => {
    try {
      await teardownTestDb();
    } finally {
      if (previousWorkspaceParent === undefined) delete process.env.WORKSPACE_PARENT;
      else process.env.WORKSPACE_PARENT = previousWorkspaceParent;
      if (workspaceParent) fs.rmSync(workspaceParent, { recursive: true, force: true });
    }
  });

  it('rejects migrated-but-uninstalled state read-only, then accepts installed state read-only', async () => {
    const migratedOnlySnapshot = await snapshotDatabaseRows(db);

    await expect(verifyStartupSchema()).rejects.toThrow('Tenant install/migration required');
    expect(await snapshotDatabaseRows(db)).toEqual(migratedOnlySnapshot);
    expect(migratedOnlySnapshot.tenants).toEqual([]);
    expect(migratedOnlySnapshot.app_settings).toEqual([]);

    await expect(installInitialConfiguration(db)).resolves.toEqual(expect.objectContaining({ installed: true }));
    const installedSnapshot = await snapshotDatabaseRows(db);
    expect(installedSnapshot.tenants.length).toBeGreaterThan(0);
    expect(installedSnapshot.sprint_task_transitions.length).toBeGreaterThan(0);
    expect(installedSnapshot.sprint_task_transition_requirements.length).toBeGreaterThan(0);

    await expect(verifyStartupSchema()).resolves.toBeUndefined();
    expect(await snapshotDatabaseRows(db)).toEqual(installedSnapshot);
  });
});
