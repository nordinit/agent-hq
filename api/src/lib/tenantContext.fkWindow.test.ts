import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ensureTenantSchema } from './tenantContext';
import { SqliteAdapter } from '../db/adapter/SqliteAdapter';
import { type Db } from '../db/adapter/types';

/**
 * Concurrency guard for the foreign-key disable window.
 *
 * `PRAGMA foreign_keys` is per-connection and db/client.ts hands out ONE connection for
 * the whole process, so a rebuild that disables enforcement disables it for every request
 * in flight. While better-sqlite3 was called synchronously that was safe: nothing could
 * run between the disable and the restore.
 *
 * Under the async Db adapter it is not safe by default. Every adapter method is async, so
 * an `await` inside the window hands the event loop to another request handler's
 * continuation — and that handler's DELETE then runs with foreign keys off, ON DELETE
 * CASCADE silently does not fire, and orphan rows accumulate with nothing logged. That
 * exact defect shipped to production once already.
 *
 * These tests reproduce it: a second "request handler" resumes on the microtask queue
 * while ensureTenantSchema() is rebuilding, and asserts that its cascading delete still
 * cascaded — i.e. that enforcement was never disabled underneath it.
 */

let raw: Database.Database;
let db: Db;
let errorSpy: ReturnType<typeof jest.spyOn>;

const fkState = (): number => Number(raw.pragma('foreign_keys', { simple: true }));

const loggedErrors = (): string => errorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');

beforeEach(() => {
  raw = new Database(':memory:');
  // Mirror db/client.ts: the real connection is opened with enforcement ON.
  raw.pragma('foreign_keys = ON');
  db = new SqliteAdapter(raw);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  raw.close();
});

/** tasks + a CASCADE child, the shape that lost rows in production. */
function seedCascadingTables(): void {
  raw.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, tenant_id INTEGER);
    CREATE TABLE task_history (
      id        INTEGER PRIMARY KEY,
      task_id   INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      tenant_id INTEGER
    );
    INSERT INTO tasks (id, tenant_id) VALUES (1, 1);
    INSERT INTO task_history (id, task_id) VALUES (100, 1);
  `);
}

/** Steady-state production shape: sprint_types tenant scoped with a surrogate PK. */
function seedTenantScopedSprintTypes(): void {
  raw.exec(`
    CREATE TABLE sprint_types (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id        INTEGER,
      key              TEXT NOT NULL,
      name             TEXT NOT NULL,
      description      TEXT NOT NULL DEFAULT '',
      is_system        INTEGER NOT NULL DEFAULT 1,
      status_seeded_at TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO sprint_types (tenant_id, key, name) VALUES (NULL, 'delivery', 'Delivery');
  `);
}

/** Legacy shape: sprint_types keyed globally, forcing the full table rebuild path. */
function seedLegacySprintTypes(): void {
  raw.exec(`
    CREATE TABLE sprint_types (
      key  TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    INSERT INTO sprint_types (key, name) VALUES ('delivery', 'Delivery');
  `);
}

/** Legacy global workflow config table, forcing migrateWorkflowConfigTable's rebuild. */
function seedLegacyWorkflowConfigTable(): void {
  raw.exec(`
    CREATE TABLE task_field_schemas (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key TEXT NOT NULL,
      task_type       TEXT,
      schema_json     TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO task_field_schemas (sprint_type_key, task_type) VALUES ('delivery', 'feature');
  `);
}

/** Legacy globally-unique MCP server slugs, forcing the mcp_servers rebuild. */
function seedLegacyMcpServers(): void {
  raw.exec(`
    CREATE TABLE mcp_servers (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      name    TEXT NOT NULL,
      slug    TEXT NOT NULL UNIQUE,
      command TEXT NOT NULL
    );
    INSERT INTO mcp_servers (name, slug, command) VALUES ('Agent HQ', 'agent-hq', 'node');
  `);
}

type ConcurrentDeleteResult = {
  /** True when the other handler ever observed enforcement switched off underneath it. */
  sawDisabledWindow: boolean;
  /** Rows left in task_history after the cascading parent delete. */
  orphans: number;
};

/**
 * Runs a tenant migration and a second request handler concurrently.
 *
 * The second handler resumes via `await Promise.resolve()` — the same microtask queue an
 * awaited adapter call resumes on, so it interleaves with the migration wherever the
 * migration awaits. As soon as it sees enforcement off it deletes the parent row, which
 * is precisely what a real handler would have done at that instant.
 *
 * SqliteAdapter.run() issues the statement synchronously before returning its promise, so
 * the DELETE lands at the exact moment the pragma was sampled — no timing slack.
 */
async function migrateWhileAnotherHandlerDeletes(): Promise<ConcurrentDeleteResult> {
  let migrationDone = false;
  const migration = ensureTenantSchema(db).then(() => { migrationDone = true; });

  const otherHandler = (async (): Promise<boolean> => {
    let sawDisabledWindow = false;
    // Bounded so a bug here can never hang the suite; the loop exits on migrationDone.
    for (let spins = 0; !migrationDone && spins < 1_000_000; spins += 1) {
      if (fkState() === 0) {
        sawDisabledWindow = true;
        break;
      }
      await Promise.resolve();
    }
    await db.run(`DELETE FROM tasks WHERE id = 1`);
    return sawDisabledWindow;
  })();

  const [, sawDisabledWindow] = await Promise.all([migration, otherHandler]);

  const row = await db.get(`SELECT COUNT(*) AS n FROM task_history WHERE task_id = 1`) as { n: number };
  return { sawDisabledWindow, orphans: row.n };
}

describe('the foreign-key disable window is never observable by another handler', () => {
  it('keeps ON DELETE CASCADE working for a concurrent delete during the steady-state rebuild', async () => {
    seedCascadingTables();
    seedTenantScopedSprintTypes();
    // The request path calls ensureTenantSchema() on every request; the second call is the
    // steady-state shape, which is the one that reaches the rebuild sites on a warm process.
    await ensureTenantSchema(db);
    expect(fkState()).toBe(1);

    const { sawDisabledWindow, orphans } = await migrateWhileAnotherHandlerDeletes();

    expect(orphans).toBe(0);
    expect(sawDisabledWindow).toBe(false);
    expect(fkState()).toBe(1);
  });

  it('keeps ON DELETE CASCADE working for a concurrent delete during the legacy sprint_types rebuild', async () => {
    seedCascadingTables();
    seedLegacySprintTypes();

    const { sawDisabledWindow, orphans } = await migrateWhileAnotherHandlerDeletes();

    expect(orphans).toBe(0);
    expect(sawDisabledWindow).toBe(false);
    expect(fkState()).toBe(1);
  });

  it('keeps ON DELETE CASCADE working for a concurrent delete during the workflow config rebuild', async () => {
    seedCascadingTables();
    seedTenantScopedSprintTypes();
    seedLegacyWorkflowConfigTable();

    const { sawDisabledWindow, orphans } = await migrateWhileAnotherHandlerDeletes();

    expect(orphans).toBe(0);
    expect(sawDisabledWindow).toBe(false);
    expect(fkState()).toBe(1);
  });

  it('keeps ON DELETE CASCADE working for a concurrent delete during the mcp_servers rebuild', async () => {
    seedCascadingTables();
    seedTenantScopedSprintTypes();
    seedLegacyMcpServers();

    const { sawDisabledWindow, orphans } = await migrateWhileAnotherHandlerDeletes();

    expect(orphans).toBe(0);
    expect(sawDisabledWindow).toBe(false);
    expect(fkState()).toBe(1);
  });
});

describe('the post-migration foreign-key tripwire runs against the raw connection', () => {
  it('does not blow up on the Db adapter, which has no pragma()', async () => {
    seedCascadingTables();
    seedTenantScopedSprintTypes();

    // Before the fix this threw "db.pragma is not a function", 500-ing every request that
    // resolved a tenant.
    await expect(ensureTenantSchema(db)).resolves.toEqual(expect.any(Number));
    expect(fkState()).toBe(1);
  });

  it('force-restores and reports loudly when enforcement leaked off before migrating', async () => {
    seedCascadingTables();
    seedTenantScopedSprintTypes();
    await ensureTenantSchema(db);
    raw.pragma('foreign_keys = OFF');

    await ensureTenantSchema(db);

    expect(fkState()).toBe(1);
    expect(loggedErrors()).toContain('FATAL DATA INTEGRITY DEFECT');
  });
});
