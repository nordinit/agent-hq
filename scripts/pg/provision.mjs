#!/usr/bin/env node
/**
 * Provisions a complete Agent HQ PostgreSQL database from a SQLite snapshot, end to end.
 *
 * This is the single reproducible path from "production SQLite" to "a Postgres database
 * the application can run against". Every step is idempotent from the caller's point of
 * view: the target database is dropped and rebuilt, so a partial earlier run cannot leave
 * a half-migrated database that looks finished.
 *
 * ORDER, AND WHY IT IS THIS ORDER
 *   1. purge orphans      on a COPY of the snapshot, never the original
 *   2. create tables      no foreign keys yet, so table order is irrelevant
 *   3. load data          COPY ... FORMAT csv, streamed
 *   4. create indexes     far cheaper after the load than during it
 *   5. add foreign keys   validated once, against finished data
 *   6. rename             sprint -> workflow, job -> agent
 *
 * The rename runs LAST, after the data is in and the constraints are proven. The ETL reads
 * a SQLite database that still uses the old vocabulary, so the load must speak old names;
 * renaming afterwards is metadata-only in PostgreSQL and carries every constraint and
 * index with it automatically. Generating the baseline with new names instead would force
 * the ETL to translate every identifier mid-stream, turning a mechanical copy into a
 * transformation that can silently mismap a column.
 *
 * Usage:
 *   node scripts/pg/provision.mjs <sqlite-snapshot> <database-name> [--keep-legacy-names]
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const [, , SNAPSHOT, DB_NAME, ...flags] = process.argv;
if (!SNAPSHOT || !DB_NAME) {
  console.error('usage: provision.mjs <sqlite-snapshot> <database-name> [--keep-legacy-names]');
  process.exit(1);
}
const keepLegacyNames = flags.includes('--keep-legacy-names');

const PG_BIN = ['/opt/homebrew/opt/postgresql@17/bin', '/usr/local/opt/postgresql@17/bin']
  .find((p) => fs.existsSync(path.join(p, 'psql')));
if (!PG_BIN) {
  console.error('Could not find psql. Install postgresql@17 or add it to PATH.');
  process.exit(1);
}
const psql = path.join(PG_BIN, 'psql');
const BASELINE = path.resolve('db/pg-baseline');
const WORK = path.resolve('.pg-provision-work');
const url = `postgresql://localhost/${DB_NAME}`;

function step(n, label) { console.log(`\n[${n}/6] ${label}`); }

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: opts.quiet ? 'pipe' : 'inherit', encoding: 'utf8', ...opts });
}

function sql(database, statement) {
  return run(psql, ['-d', database, '-tAc', statement], { quiet: true }).trim();
}

function sqlFile(database, file) {
  // ON_ERROR_STOP is essential: without it psql reports failures and exits 0, so a
  // broken migration looks like a successful one.
  run(psql, ['-d', database, '-v', 'ON_ERROR_STOP=1', '-q', '-f', file]);
}

fs.mkdirSync(WORK, { recursive: true });
const working = path.join(WORK, `${DB_NAME}-source.db`);

// ---- 1. purge orphans on a copy ------------------------------------------------------
step(1, 'Purging foreign-key orphans (on a copy; the snapshot is never modified)');
fs.copyFileSync(SNAPSHOT, working);
run('node', ['scripts/pg/purge-orphans.mjs', working]);

const remaining = run('node', ['scripts/pg/report-orphans.mjs', working], { quiet: true });
const violated = /constraints violated:\s*(\d+)/.exec(remaining)?.[1];
if (violated !== '0') {
  console.error(`\nFAILED: ${violated} constraint(s) still violated after the purge.`);
  console.error('Loading now would silently drop those foreign keys in PostgreSQL.\n');
  // Naming them matters: the two failure modes need opposite fixes. Orphan ROWS mean the
  // purge did not converge. A MISSING PARENT TABLE means the snapshot predates the
  // dangling-_legacy_global repair, and the fix is a newer snapshot, not more purging.
  for (const line of remaining.split('\n')) {
    if (/PARENT TABLE MISSING|UNRESOLVABLE|^\s+\d+\s+\S/.test(line)) console.error(`  ${line.trim()}`);
  }
  if (/PARENT TABLE MISSING/.test(remaining)) {
    console.error('\nA parent table is missing entirely. This snapshot predates the repair that');
    console.error('re-targets foreign keys left pointing at dropped <table>_legacy_global tables.');
    console.error('Take a newer snapshot from a database where that migration has been applied.');
  }
  process.exit(1);
}
console.log('  orphans: 0 remaining');

// ---- 2. tables -----------------------------------------------------------------------
step(2, `Creating database ${DB_NAME} and tables`);
sql('postgres', `DROP DATABASE IF EXISTS ${DB_NAME}`);
sql('postgres', `CREATE DATABASE ${DB_NAME}`);
sqlFile(DB_NAME, path.join(BASELINE, '01-tables.sql'));
console.log(`  tables: ${sql(DB_NAME, `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'`)}`);

// ---- 3. data -------------------------------------------------------------------------
step(3, 'Loading data');
run('node', ['scripts/pg/migrate-data.mjs', working, url]);

// ---- 4. indexes ----------------------------------------------------------------------
step(4, 'Creating indexes');
sqlFile(DB_NAME, path.join(BASELINE, '02-indexes.sql'));
console.log(`  indexes: ${sql(DB_NAME, `SELECT COUNT(*) FROM pg_indexes WHERE schemaname='public'`)}`);

// ---- 5. foreign keys -----------------------------------------------------------------
step(5, 'Adding foreign keys');
sqlFile(DB_NAME, path.join(BASELINE, '03-foreign-keys.sql'));
const fkCount = Number(sql(DB_NAME, `SELECT COUNT(*) FROM pg_constraint WHERE contype='f'`));
console.log(`  foreign keys: ${fkCount}`);
if (fkCount === 0) {
  console.error('FAILED: no foreign keys were created.');
  process.exit(1);
}

// ---- verification, BEFORE the rename -------------------------------------------------
// This must run before step 6: verify-migration compares SQLite table and column names
// against PostgreSQL's, and after the rename those deliberately no longer match. Running
// it here checks the thing that can actually go wrong — the data copy — while the two
// schemas are still directly comparable.
//
// It compares against the PURGED copy, which is what was loaded. Comparing against the
// original snapshot would report every purged orphan as data loss.
console.log('\nVerifying the load against the source snapshot');
try {
  run('node', ['scripts/pg/verify-migration.mjs', working, url]);
} catch {
  console.error('\nVERIFICATION FAILED — the database is NOT safe to use.');
  process.exit(1);
}

// ---- 6. rename -----------------------------------------------------------------------
if (keepLegacyNames) {
  step(6, 'Skipping the terminology rename (--keep-legacy-names)');
} else {
  step(6, 'Renaming legacy terminology (sprint -> workflow, job -> agent)');
  // Regenerated against THIS database rather than reused from a previous run: the mapping
  // is only correct for the catalog it was derived from, and a stale mapping would rename
  // objects that no longer exist while missing ones that do.
  run('node', ['scripts/pg/generate-rename-mapping.mjs', url, BASELINE]);
  sqlFile(DB_NAME, path.join(BASELINE, '10-rename-legacy-terminology.sql'));

  const leftover = sql(DB_NAME, `
    SELECT COUNT(*) FROM (
      SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name LIKE '%sprint%'
      UNION ALL
      SELECT indexname FROM pg_indexes
        WHERE schemaname='public' AND indexname LIKE '%sprint%'
    ) legacy`);
  if (leftover !== '0') {
    console.error(`FAILED: ${leftover} legacy-named object(s) survived the rename.`);
    process.exit(1);
  }
  console.log('  legacy-named tables/indexes remaining: 0');
}

const rows = sql(DB_NAME, `
  SELECT SUM(n_live_tup)::bigint FROM pg_stat_user_tables`);
console.log(`\nProvisioned ${DB_NAME}: ~${rows} rows, ${fkCount} foreign keys${keepLegacyNames ? '' : ', renamed'}`);
console.log(`Connection string: ${url}`);
