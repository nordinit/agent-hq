#!/usr/bin/env node
/**
 * Enumerates every foreign-key violation in a SQLite snapshot, one row per constraint.
 *
 * This is the pre-migration gate. PostgreSQL will not create a foreign key whose data
 * already violates it, so every orphan found here is a constraint that silently will not
 * exist after the migration unless the rows are dealt with first. SQLite accumulated
 * them because enforcement had leaked off for the life of every API process.
 *
 * `PRAGMA foreign_key_check` reports violating ROWS but does not aggregate, and on a
 * database this size it returns hundreds of thousands of individual rows. This walks the
 * constraints instead and counts violations per constraint, which is what a purge plan
 * needs.
 *
 * Read-only. It never modifies the snapshot.
 *
 * Usage: node scripts/pg/report-orphans.mjs <sqlite-db> [--json]
 */
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require(path.resolve('api/node_modules/better-sqlite3'));

const [, , SRC, ...flags] = process.argv;
if (!SRC) {
  console.error('usage: report-orphans.mjs <sqlite-db> [--json]');
  process.exit(1);
}
const asJson = flags.includes('--json');

const db = new Database(SRC, { readonly: true });
const tableNames = new Set(
  db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all().map((r) => r.name)
);

const findings = [];
let totalOrphans = 0;

for (const table of [...tableNames].sort()) {
  const fks = db.prepare(`PRAGMA foreign_key_list("${table}")`).all();
  const byId = new Map();
  for (const fk of fks) {
    if (!byId.has(fk.id)) byId.set(fk.id, []);
    byId.get(fk.id).push(fk);
  }

  for (const [id, cols] of byId) {
    const ordered = cols.sort((a, b) => a.seq - b.seq);
    const parent = ordered[0].table;

    if (!tableNames.has(parent)) {
      findings.push({ table, constraint: id, parent, columns: ordered.map((c) => c.from), orphans: null, note: 'PARENT TABLE MISSING' });
      continue;
    }

    // A NULL "to" means the reference targets the parent's primary key implicitly.
    const parentPk = db.prepare(`PRAGMA table_info("${parent}")`).all().filter((c) => c.pk > 0);
    const joinPairs = ordered.map((c, i) => ({
      child: c.from,
      parentCol: c.to ?? parentPk[i]?.name,
    }));
    if (joinPairs.some((p) => !p.parentCol)) {
      findings.push({ table, constraint: id, parent, columns: ordered.map((c) => c.from), orphans: null, note: 'UNRESOLVABLE PARENT KEY' });
      continue;
    }

    const on = joinPairs.map((p) => `p."${p.parentCol}" = c."${p.child}"`).join(' AND ');
    // NULL child keys never violate a foreign key, so they must not be counted.
    const notNull = joinPairs.map((p) => `c."${p.child}" IS NOT NULL`).join(' AND ');
    const anyParentNull = joinPairs.map((p) => `p."${p.parentCol}" IS NULL`).join(' AND ');

    let orphans;
    try {
      orphans = db.prepare(
        `SELECT COUNT(*) AS c FROM "${table}" c
         LEFT JOIN "${parent}" p ON ${on}
         WHERE ${notNull} AND ${anyParentNull}`
      ).get().c;
    } catch (err) {
      findings.push({ table, constraint: id, parent, columns: ordered.map((x) => x.from), orphans: null, note: `QUERY FAILED: ${err.message}` });
      continue;
    }

    if (orphans > 0) {
      totalOrphans += orphans;
      findings.push({
        table, constraint: id, parent,
        columns: ordered.map((c) => c.from),
        onDelete: ordered[0].on_delete,
        orphans,
      });
    }
  }
}

findings.sort((a, b) => (b.orphans ?? Infinity) - (a.orphans ?? Infinity));

if (asJson) {
  console.log(JSON.stringify({ totalOrphans, findings }, null, 2));
} else {
  console.log(`Foreign-key violations in ${path.basename(SRC)}\n`);
  console.log('   ORPHANS  CHILD -> PARENT                                            ON DELETE');
  console.log('   -------  ------------------------------------------------------     ---------');
  for (const f of findings) {
    const label = `${f.table}.${f.columns.join('+')} -> ${f.parent}`;
    const count = f.orphans === null ? f.note : String(f.orphans).padStart(8);
    console.log(`  ${String(count).padStart(8)}  ${label.padEnd(56)} ${f.onDelete ?? ''}`);
  }
  console.log(`\n  constraints violated: ${findings.length}`);
  console.log(`  total orphan rows:    ${totalOrphans}`);
}
