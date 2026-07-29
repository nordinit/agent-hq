import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { closeDb, getDb } from './client';
import { initSchema } from './schema';

/**
 * SQLite validates foreign-key TARGETS only at DML time, so a REFERENCES clause naming a
 * table that no longer exists sits dormant until enforcement is switched on — at which
 * point every write to the child table fails while reads keep working.
 *
 * Production hit exactly this: tenant rebuilds renamed tables to `<name>_legacy_global`
 * and two workflow child tables kept the old name.
 */
let tempDir: string;
let dbPath: string;

beforeEach(() => {
  closeDb();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dangling-fk-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');
  process.env.AGENT_HQ_DB_PATH = dbPath;
});

afterEach(() => {
  closeDb();
  delete process.env.AGENT_HQ_DB_PATH;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedDanglingReference(): void {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE parents (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE children (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER NOT NULL REFERENCES "parents_legacy_global"(id) ON DELETE CASCADE,
      label     TEXT NOT NULL
    );
    CREATE INDEX idx_children_parent ON children(parent_id);
    INSERT INTO parents (id, name) VALUES (1, 'kept');
    INSERT INTO children (id, parent_id, label) VALUES (1, 1, 'row-a'), (2, 1, 'row-b');
  `);
  db.close();
}

it('a dangling _legacy_global reference breaks writes once enforcement is on', () => {
  seedDanglingReference();
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  // Reads never touch the constraint, so the defect stays invisible until a write
  // actually evaluates the foreign key. Updating a non-key column is not enough —
  // SQLite only resolves the parent table when the referencing column is written.
  expect(db.prepare(`SELECT COUNT(*) AS c FROM children`).get()).toEqual({ c: 2 });
  expect(() => db.prepare(`UPDATE children SET label = label`).run()).not.toThrow();

  expect(() => db.prepare(`UPDATE children SET parent_id = parent_id`).run())
    .toThrow(/no such table: main\.parents_legacy_global/);
  expect(() => db.prepare(`INSERT INTO children (parent_id, label) VALUES (1, 'new')`).run())
    .toThrow(/no such table: main\.parents_legacy_global/);
  db.close();
});

it('initSchema re-targets the reference and preserves every row', () => {
  seedDanglingReference();

  // initSchema() builds the full Agent HQ schema alongside these fixtures; the repair
  // runs over whatever it finds, so the seeded tables are picked up too.
  initSchema();

  const db = getDb();
  const fks = db.prepare(`PRAGMA foreign_key_list("children")`).all() as { table: string }[];
  expect(fks.map((f) => f.table)).toEqual(['parents']);

  // Rows survive the rebuild, and the index is recreated with the table.
  expect(db.prepare(`SELECT COUNT(*) AS c FROM children`).get()).toEqual({ c: 2 });
  expect(db.prepare(`SELECT label FROM children ORDER BY id`).all())
    .toEqual([{ label: 'row-a' }, { label: 'row-b' }]);
  const indexes = (db.prepare(`PRAGMA index_list("children")`).all() as { name: string }[])
    .map((i) => i.name);
  expect(indexes).toContain('idx_children_parent');

  // The write that previously failed now succeeds under enforcement.
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(() => db.prepare(`UPDATE children SET label = label`).run()).not.toThrow();

  // And the re-targeted constraint is real: CASCADE now removes the children.
  db.prepare(`DELETE FROM parents WHERE id = 1`).run();
  expect(db.prepare(`SELECT COUNT(*) AS c FROM children`).get()).toEqual({ c: 0 });
});

it('refuses to re-target when a child would lose its parent', () => {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE parents (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE children (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER NOT NULL REFERENCES "parents_legacy_global"(id) ON DELETE CASCADE,
      label     TEXT NOT NULL
    );
    INSERT INTO parents (id, name) VALUES (1, 'kept');
    INSERT INTO children (id, parent_id, label) VALUES (1, 999, 'unmatched');
  `);
  db.close();

  initSchema();

  // Silently re-targeting would have made this row violate a real constraint, so the
  // repair leaves the reference dangling rather than destroying or orphaning data.
  const live = getDb();
  const fks = live.prepare(`PRAGMA foreign_key_list("children")`).all() as { table: string }[];
  expect(fks.map((f) => f.table)).toEqual(['parents_legacy_global']);
  expect(live.prepare(`SELECT COUNT(*) AS c FROM children`).get()).toEqual({ c: 1 });
});
