#!/usr/bin/env node
/**
 * Resolves foreign-key violations by applying each constraint's OWN declared ON DELETE
 * action — the outcome that would have occurred had enforcement never leaked off.
 *
 *   ON DELETE CASCADE    -> delete the orphaned child row
 *   ON DELETE SET NULL   -> null the referencing column, keep the row
 *   ON DELETE SET DEFAULT-> reset the referencing column to its default, keep the row
 *   NO ACTION / RESTRICT -> report only; there is no safe automatic resolution
 *
 * This distinction matters and is not a detail. 15 of the violated constraints are
 * SET NULL, covering sessions, job_instances, logs and chat_messages. Deleting those
 * rows would destroy session and run history that the schema explicitly intends to
 * outlive its parent. Uniform deletion would have been data loss dressed up as cleanup.
 *
 * Deleting a cascade orphan can orphan ITS children in turn, so the pass repeats until
 * the database reaches a fixed point.
 *
 * Runs inside a single transaction: either the database ends up fully consistent or it
 * is left exactly as found. --dry-run reports without writing.
 *
 * CONSTRAINTS COME FROM THE TARGET, NOT THE SOURCE
 * ------------------------------------------------
 * Reading only SQLite's PRAGMA foreign_key_list is not enough, and the gap is silent.
 * SQLite declares 7 foreign keys on `tasks`; db/pg-baseline/03-foreign-keys.sql declares
 * 10. A row violating one of the other three is invisible here and surfaces much later,
 * as an ERROR from psql in provision.mjs step 5 — after the data has already been loaded,
 * with no indication that the purge could never have seen it. So the baseline's ALTER
 * TABLE ... ADD CONSTRAINT statements are parsed and unioned in: the constraints that
 * matter are the ones the TARGET will enforce.
 *
 * Usage: node scripts/pg/purge-orphans.mjs <sqlite-db> [--dry-run] [--fk-file=<path>]
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require(path.resolve('api/node_modules/better-sqlite3'));

const [, , SRC, ...flags] = process.argv;
if (!SRC) {
  console.error('usage: purge-orphans.mjs <sqlite-db> [--dry-run]');
  process.exit(1);
}
const dryRun = flags.includes('--dry-run');
const FK_FILE = flags.find((f) => f.startsWith('--fk-file='))?.slice('--fk-file='.length)
  ?? path.resolve('db/pg-baseline/03-foreign-keys.sql');

const db = new Database(SRC, { readonly: dryRun });
// The rebuild must not itself be policed while it repairs; and these statements are
// deliberately hand-written rather than relying on cascade side effects.
db.pragma('foreign_keys = OFF');

const tableNames = new Set(
  db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all().map((r) => r.name)
);

/** Every foreign key in the database, resolved to concrete column pairs. */
/**
 * Foreign keys the PostgreSQL baseline will enforce, parsed from its ALTER TABLE statements.
 *
 * Single-column only. Every constraint in the generated baseline is single-column, and a
 * composite one would need the pair ordering that this regex does not attempt — so it is
 * skipped loudly rather than half-parsed.
 */
function targetConstraints(fkFile) {
  if (!fs.existsSync(fkFile)) return [];
  const sql = fs.readFileSync(fkFile, 'utf8');
  const re = /ALTER TABLE\s+"?(\w+)"?\s+ADD CONSTRAINT\s+"?(\w+)"?\s+FOREIGN KEY\s*\(\s*"?(\w+)"?\s*\)\s*REFERENCES\s+"?(\w+)"?\s*\(\s*"?(\w+)"?\s*\)([^;]*);/gi;
  const out = [];
  for (const m of sql.matchAll(re)) {
    const [, table, id, childCol, parent, parentCol, tail] = m;
    if (!tableNames.has(table) || !tableNames.has(parent)) continue;
    // The action the TARGET declares decides whether an orphan is nulled or deleted, which is
    // the whole point of the distinction documented above.
    const onDelete = /ON DELETE SET NULL/i.test(tail) ? 'SET NULL'
      : /ON DELETE CASCADE/i.test(tail) ? 'CASCADE'
      : 'NO ACTION';
    out.push({ table, id, parent, pairs: [{ child: childCol, parentCol }], onDelete });
  }
  return out;
}

function allConstraints() {
  const out = [];
  for (const table of tableNames) {
    const fks = db.prepare(`PRAGMA foreign_key_list("${table}")`).all();
    const byId = new Map();
    for (const fk of fks) {
      if (!byId.has(fk.id)) byId.set(fk.id, []);
      byId.get(fk.id).push(fk);
    }
    for (const [id, cols] of byId) {
      const ordered = cols.sort((a, b) => a.seq - b.seq);
      const parent = ordered[0].table;
      if (!tableNames.has(parent)) continue;
      const parentPk = db.prepare(`PRAGMA table_info("${parent}")`).all().filter((c) => c.pk > 0);
      const pairs = ordered.map((c, i) => ({ child: c.from, parentCol: c.to ?? parentPk[i]?.name }));
      if (pairs.some((p) => !p.parentCol)) continue;
      out.push({ table, id, parent, pairs, onDelete: (ordered[0].on_delete || 'NO ACTION').toUpperCase() });
    }
  }

  // Union with the target's constraints, keyed on table+column+parent so a constraint declared
  // by both engines is not scanned twice.
  const seen = new Set(out.map((c) => `${c.table}.${c.pairs.map((p) => p.child).join(',')}->${c.parent}`));
  for (const c of targetConstraints(FK_FILE)) {
    const key = `${c.table}.${c.pairs[0].child}->${c.parent}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function orphanPredicate(c) {
  const on = c.pairs.map((p) => `p."${p.parentCol}" = ch."${p.child}"`).join(' AND ');
  const notNull = c.pairs.map((p) => `ch."${p.child}" IS NOT NULL`).join(' AND ');
  return `${notNull} AND NOT EXISTS (SELECT 1 FROM "${c.parent}" p WHERE ${on})`;
}

/**
 * Applies SET NULL to a constraint's orphans, falling back to per-row handling when the
 * bulk UPDATE collides with a unique index.
 *
 * Nulling a referencing column can make two previously-distinct rows identical — several
 * routing rules that differed only by the deleted agent they pointed at collapse onto the
 * same unique key. The bulk statement then fails and aborts the whole purge.
 *
 * Row by row, a row that still nulls cleanly is kept (that is the declared intent), and a
 * row that cannot is a genuine duplicate of one already kept, so it is dropped. The
 * surviving row retains the information; only the redundant copies go.
 */
function setNullWithDedupe(c, sets, where) {
  try {
    const info = db.prepare(`UPDATE "${c.table}" SET ${sets} WHERE ${where.replace(/\bch\./g, '')}`).run();
    return { nulled: info.changes, deleted: 0 };
  } catch (err) {
    if (!String(err.code).startsWith('SQLITE_CONSTRAINT')) throw err;
  }

  const ids = db.prepare(`SELECT rowid AS rid FROM "${c.table}" WHERE ${where.replace(/\bch\./g, '')}`)
    .all().map((r) => r.rid);
  let nulledRows = 0, deletedRows = 0;
  for (const rid of ids) {
    const savepoint = `sp_${c.table}_${rid}`.replace(/[^A-Za-z0-9_]/g, '');
    db.exec(`SAVEPOINT "${savepoint}"`);
    try {
      db.prepare(`UPDATE "${c.table}" SET ${sets} WHERE rowid = ?`).run(rid);
      db.exec(`RELEASE "${savepoint}"`);
      nulledRows++;
    } catch (err) {
      if (!String(err.code).startsWith('SQLITE_CONSTRAINT')) throw err;
      db.exec(`ROLLBACK TO "${savepoint}"`);
      db.exec(`RELEASE "${savepoint}"`);
      db.prepare(`DELETE FROM "${c.table}" WHERE rowid = ?`).run(rid);
      deletedRows++;
    }
  }
  return { nulled: nulledRows, deleted: deletedRows };
}

const constraints = allConstraints();
const actions = [];
let deleted = 0, nulled = 0, blocked = 0;

const run = () => {
  for (let pass = 1; pass <= 20; pass++) {
    let changedThisPass = 0;

    for (const c of constraints) {
      const where = orphanPredicate(c);
      const count = db.prepare(`SELECT COUNT(*) AS n FROM "${c.table}" ch WHERE ${where}`).get().n;
      if (count === 0) continue;

      if (c.onDelete === 'CASCADE') {
        if (!dryRun) db.prepare(`DELETE FROM "${c.table}" AS ch WHERE ${where}`).run();
        deleted += count; changedThisPass += count;
        actions.push({ pass, action: 'DELETE', table: c.table, columns: c.pairs.map((p) => p.child), parent: c.parent, rows: count });
      } else if (c.onDelete === 'SET NULL') {
        const sets = c.pairs.map((p) => `"${p.child}" = NULL`).join(', ');
        if (dryRun) {
          nulled += count; changedThisPass += count;
          actions.push({ pass, action: 'SET NULL', table: c.table, columns: c.pairs.map((p) => p.child), parent: c.parent, rows: count });
        } else {
          const applied = setNullWithDedupe(c, sets, where);
          nulled += applied.nulled;
          deleted += applied.deleted;
          changedThisPass += applied.nulled + applied.deleted;
          if (applied.nulled) actions.push({ pass, action: 'SET NULL', table: c.table, columns: c.pairs.map((p) => p.child), parent: c.parent, rows: applied.nulled });
          if (applied.deleted) actions.push({ pass, action: 'DEDUPE DEL', table: c.table, columns: c.pairs.map((p) => p.child), parent: c.parent, rows: applied.deleted });
        }
      } else if (c.onDelete === 'SET DEFAULT') {
        const info = db.prepare(`PRAGMA table_info("${c.table}")`).all();
        const sets = c.pairs.map((p) => {
          const def = info.find((i) => i.name === p.child)?.dflt_value;
          return `"${p.child}" = ${def ?? 'NULL'}`;
        }).join(', ');
        if (!dryRun) db.prepare(`UPDATE "${c.table}" AS ch SET ${sets} WHERE ${where}`).run();
        nulled += count; changedThisPass += count;
        actions.push({ pass, action: 'SET DEFAULT', table: c.table, columns: c.pairs.map((p) => p.child), parent: c.parent, rows: count });
      } else {
        // RESTRICT / NO ACTION: the schema states these must never be broken. Something
        // deleted a parent it was not allowed to. A human has to decide what the row means.
        blocked += count;
        actions.push({ pass, action: 'BLOCKED', table: c.table, columns: c.pairs.map((p) => p.child), parent: c.parent, rows: count });
      }
    }

    if (changedThisPass === 0) {
      console.log(`[purge] reached a fixed point after ${pass} pass(es)`);
      return;
    }
    // A dry run cannot converge: nothing is written, so the same rows report every pass.
    if (dryRun) { console.log('[purge] dry run: reporting pass 1 only'); return; }
  }
  throw new Error('[purge] did not converge in 20 passes — aborting, nothing committed');
};

if (dryRun) {
  run();
} else {
  db.transaction(run)();
}

const grouped = new Map();
for (const a of actions) {
  const key = `${a.action}\t${a.table}.${a.columns.join('+')} -> ${a.parent}`;
  grouped.set(key, (grouped.get(key) ?? 0) + a.rows);
}
console.log(`\n${dryRun ? 'WOULD APPLY' : 'APPLIED'}:\n`);
for (const [key, rows] of [...grouped].sort((a, b) => b[1] - a[1])) {
  const [action, label] = key.split('\t');
  console.log(`  ${String(rows).padStart(7)}  ${action.padEnd(11)} ${label}`);
}
console.log(`\n  rows deleted:      ${deleted}`);
console.log(`  rows nulled:       ${nulled}`);
console.log(`  rows blocked:      ${blocked}`);
if (blocked > 0) {
  console.error('\n  BLOCKED rows violate a RESTRICT/NO ACTION constraint and need a human decision.');
  process.exitCode = 2;
}
db.close();
