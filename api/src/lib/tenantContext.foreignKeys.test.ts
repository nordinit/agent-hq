import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ensureTenantSchema, foreignKeysEnabled, withForeignKeysDisabled } from './tenantContext';

/**
 * Regression guard for the foreign-key enforcement leak.
 *
 * The application DB handle is a process-wide singleton. Any tenant migration that
 * runs `PRAGMA foreign_keys = OFF` and fails to restore it disables ON DELETE CASCADE
 * for the rest of the process, silently orphaning task_history / task_notes rows.
 */

let db: Database.Database;
let errorSpy: ReturnType<typeof jest.spyOn>;

const fkState = (): number => Number(db.pragma('foreign_keys', { simple: true }));

const loggedErrors = (): string => errorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');

/**
 * Every rebuild site must toggle the pragma outside db.transaction(); inside one
 * SQLite ignores it, so the rebuild would silently run WITH enforcement on.
 */
const expectDisableTookEffect = (): void => {
  expect(loggedErrors()).not.toContain('did not take effect');
};

beforeEach(() => {
  db = new Database(':memory:');
  // Mirror db/client.ts: the real connection is opened with enforcement ON.
  db.pragma('foreign_keys = ON');
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  db.close();
});

/** tasks + a CASCADE child, the shape that is losing rows in production. */
function seedOperationalTables(): void {
  db.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, tenant_id INTEGER);
    CREATE TABLE task_history (
      id        INTEGER PRIMARY KEY,
      task_id   INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      tenant_id INTEGER
    );
    CREATE TABLE job_instances (id INTEGER PRIMARY KEY, task_id INTEGER, agent_id INTEGER);
    INSERT INTO tasks (id, tenant_id) VALUES (1, 1);
    INSERT INTO task_history (id, task_id) VALUES (100, 1);
  `);
}

/** Steady-state production shape: sprint_types already tenant scoped with a surrogate PK. */
function seedTenantScopedSprintTypes(): void {
  db.exec(`
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

/** Legacy shape: sprint_types keyed globally by key, forcing the table rebuild path. */
function seedLegacySprintTypes(): void {
  db.exec(`
    CREATE TABLE sprint_types (
      key  TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    INSERT INTO sprint_types (key, name) VALUES ('delivery', 'Delivery');
  `);
}

/** Legacy global workflow config table, forcing migrateWorkflowConfigTable's rebuild. */
function seedLegacyWorkflowConfigTable(): void {
  db.exec(`
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
  db.exec(`
    CREATE TABLE mcp_servers (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      name    TEXT NOT NULL,
      slug    TEXT NOT NULL UNIQUE,
      command TEXT NOT NULL
    );
    INSERT INTO mcp_servers (name, slug, command) VALUES ('Agent HQ', 'agent-hq', 'node');
  `);
}

describe('withForeignKeysDisabled', () => {
  it('restores enforcement when the callback throws mid-rebuild', () => {
    expect(foreignKeysEnabled(db)).toBe(true);

    expect(() => withForeignKeysDisabled(db, () => {
      expect(fkState()).toBe(0);
      throw new Error('rebuild exploded');
    })).toThrow('rebuild exploded');

    expect(fkState()).toBe(1);
  });

  it('restores the prior value instead of hardcoding ON', () => {
    db.pragma('foreign_keys = OFF');

    withForeignKeysDisabled(db, () => {
      expect(fkState()).toBe(0);
    });

    expect(fkState()).toBe(0);
  });

  it('reports loudly when the disable cannot take effect inside a transaction', () => {
    db.transaction(() => {
      withForeignKeysDisabled(db, () => {
        // PRAGMA foreign_keys is a documented no-op inside a transaction.
        expect(fkState()).toBe(1);
      });
    })();

    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('did not take effect');
    expect(fkState()).toBe(1);
  });
});

describe('tenant migrations preserve foreign key enforcement', () => {
  it('leaves PRAGMA foreign_keys ON for the steady-state tenant-scoped sprint_types path', () => {
    seedOperationalTables();
    seedTenantScopedSprintTypes();

    ensureTenantSchema(db);

    expect(fkState()).toBe(1);
    expectDisableTookEffect();
  });

  it('leaves PRAGMA foreign_keys ON when sprint_types is rebuilt from legacy global keys', () => {
    seedOperationalTables();
    seedLegacySprintTypes();

    ensureTenantSchema(db);

    expect(fkState()).toBe(1);
    expectDisableTookEffect();
  });

  it('leaves PRAGMA foreign_keys ON when legacy workflow config tables are rebuilt', () => {
    seedOperationalTables();
    seedTenantScopedSprintTypes();
    seedLegacyWorkflowConfigTable();

    ensureTenantSchema(db);

    expect(fkState()).toBe(1);
    expectDisableTookEffect();
  });

  it('leaves PRAGMA foreign_keys ON when mcp_servers is migrated to tenant-local slugs', () => {
    seedOperationalTables();
    seedLegacyMcpServers();

    ensureTenantSchema(db);

    expect(fkState()).toBe(1);
    expectDisableTookEffect();
  });

  it('stays ON across repeated calls, which is what the request path does', () => {
    seedOperationalTables();
    seedTenantScopedSprintTypes();
    seedLegacyWorkflowConfigTable();

    for (let i = 0; i < 3; i += 1) {
      ensureTenantSchema(db);
      expect(fkState()).toBe(1);
    }
  });

  it('keeps ON DELETE CASCADE working after the migrations run', () => {
    seedOperationalTables();
    seedTenantScopedSprintTypes();

    ensureTenantSchema(db);
    db.prepare(`DELETE FROM tasks WHERE id = 1`).run();

    const orphans = db.prepare(`SELECT COUNT(*) AS n FROM task_history WHERE task_id = 1`).get() as { n: number };
    expect(orphans.n).toBe(0);
  });

  it('force-restores and reports loudly when enforcement was already off before migrating', () => {
    seedOperationalTables();
    seedTenantScopedSprintTypes();
    db.pragma('foreign_keys = OFF');

    ensureTenantSchema(db);

    expect(fkState()).toBe(1);
    expect(loggedErrors()).toContain('FATAL DATA INTEGRITY DEFECT');
  });
});
