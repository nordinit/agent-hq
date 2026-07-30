import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { closeTestDb, getTestDb, resetTestDb } from './testFixture';
import type { Db } from '../adapter/types';

const PG = process.env.AGENT_HQ_TEST_PG_URL;
const d = PG ? describe : describe.skip;

d('pg testFixture probe', () => {
  let db: Db;
  beforeEach(async () => { db = await getTestDb(); await resetTestDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('gives a worker database with the real baseline schema, legacy vocabulary', async () => {
    const tables = await db.all<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`);
    const names = tables.map((t) => t.table_name);
    expect(names).toContain('tasks');
    expect(names).toContain('sprints');       // legacy name the app's SQL still uses
    expect(names).toContain('job_instances');
    expect(names.length).toBeGreaterThan(60);
  });

  it('enforces foreign keys and resets identities between tests', async () => {
    await db.run(`INSERT INTO tenants (name, slug, is_default) VALUES (?, ?, ?)`, 'T', 't', 1);
    const t = await db.get<{ id: number }>(`SELECT id FROM tenants WHERE slug = ?`, 't');
    expect(t?.id).toBe(1);   // RESTART IDENTITY makes this deterministic
    await expect(db.run(
      `INSERT INTO tasks (tenant_id, title, project_id) VALUES (?, ?, ?)`, 1, 'x', 999999,
    )).rejects.toThrow();     // real FK, unlike most hand-written SQLite fixtures
  });

  it('is isolated from the previous test', async () => {
    expect(Number(await db.value(`SELECT COUNT(*) FROM tenants`))).toBe(0);
  });
});
