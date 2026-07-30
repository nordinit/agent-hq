#!/usr/bin/env node
/**
 * normalize-timestamps.mjs — collapse the two timestamp encodings in an Agent HQ
 * SQLite database down to one, ahead of the Postgres migration.
 *
 * THE PROBLEM
 * -----------
 * Timestamp columns are TEXT and have been written by two different producers:
 *
 *   SQL  `datetime('now')`        -> '2026-06-03 20:05:53'        (UTC, offset-less)
 *   JS   `new Date().toISOString()` -> '2026-06-03T20:05:53.000Z' (UTC, offset-bearing)
 *
 * 15 columns hold BOTH encodings. A bare `::timestamptz` cast in Postgres reads
 * the offset-less form in the server's local zone and the 'Z' form as UTC, so a
 * single column ends up with some rows shifted by the server's UTC offset and
 * others correct — silently, with no error.
 *
 * THE FIX
 * -------
 * Rewrite every timestamp value into the canonical offset-less UTC form:
 *
 *     'YYYY-MM-DD HH:MM:SS'   (optionally '.mmm', preserved by default)
 *
 * matching what every SQL DEFAULT in the schema already emits, so the migration
 * needs exactly ONE cast rule: `col::timestamp AT TIME ZONE 'UTC'`.
 *
 * See api/src/lib/timestamps.ts for the rationale and for the same normalizer
 * used by application code at write time.
 *
 * USAGE
 * -----
 *   node scripts/normalize-timestamps.mjs <db-path> [options]
 *
 *   --dry-run              Report only. No writes, no transaction commit.
 *   --only-mixed           Restrict to columns that currently hold BOTH
 *                          encodings (the columns that are actually broken).
 *                          Default is every timestamp-shaped column, which is
 *                          what makes the one-cast-rule guarantee hold.
 *   --truncate-fractional  Drop sub-second precision so every value is exactly
 *                          19 chars. Default preserves it (lossless).
 *   --table <name>         Restrict to one table. Repeatable.
 *   --json                 Emit a machine-readable report to stdout.
 *   --yes                  Skip the "this is not a dry run" confirmation delay.
 *
 * SAFETY
 * ------
 *   - The database path is REQUIRED. There is no default, and the production
 *     path is refused outright unless AGENT_HQ_ALLOW_PROD_NORMALIZE=1 is set.
 *   - All writes happen inside a single transaction; any error rolls back.
 *   - Before/after min/max/count are printed per column.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadDriver() {
  const candidates = [
    'better-sqlite3',
    path.resolve(import.meta.dirname, '../api/node_modules/better-sqlite3'),
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* try next */
    }
  }
  console.error('Could not load better-sqlite3. Run `npm install` in api/ first.');
  process.exit(2);
}

const Database = loadDriver();

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

const PRODUCTION_DB_PATHS = [
  path.join(os.homedir(), '.agent-hq', 'agent-hq.db'),
];

function assertNotProduction(dbPath) {
  const resolved = path.resolve(dbPath);
  const isProd = PRODUCTION_DB_PATHS.some((p) => path.resolve(p) === resolved);
  if (!isProd) return;
  if (process.env.AGENT_HQ_ALLOW_PROD_NORMALIZE === '1') {
    console.error('!! Operating on the PRODUCTION database by explicit opt-in.');
    return;
  }
  console.error(
    `Refusing to operate on the production database:\n  ${resolved}\n\n` +
      'Take a snapshot, run against the copy, and only then re-run here with\n' +
      'AGENT_HQ_ALLOW_PROD_NORMALIZE=1 after the dry-run numbers have been reviewed.',
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The normalizer — must stay behaviourally identical to
// api/src/lib/timestamps.ts#toCanonicalTimestamp
// ---------------------------------------------------------------------------

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(\.\d{1,9})?(Z|z|[+-]\d{2}:?\d{2})?$/;

const pad = (n, w) => String(n).padStart(w, '0');

function formatUtc(date, fractional) {
  const base =
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}` +
    ` ${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}`;
  return fractional ? `${base}${fractional}` : base;
}

export function toCanonicalTimestamp(value, { preserveFractional = true } = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;

  const raw = value.trim();
  if (!raw) return null;

  const dateOnly = DATE_ONLY.exec(raw);
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]} 00:00:00`;

  const m = DATE_TIME.exec(raw);
  if (!m) return null;

  const [, y, mo, d, h, mi, s = '00', frac, zone] = m;
  const fractional = preserveFractional && frac ? frac : undefined;

  const utcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const probe = new Date(utcMs);
  if (
    Number.isNaN(utcMs) ||
    probe.getUTCFullYear() !== Number(y) ||
    probe.getUTCMonth() !== Number(mo) - 1 ||
    probe.getUTCDate() !== Number(d) ||
    probe.getUTCHours() !== Number(h) ||
    probe.getUTCMinutes() !== Number(mi) ||
    probe.getUTCSeconds() !== Number(s)
  ) {
    return null;
  }

  if (!zone || zone === 'Z' || zone === 'z') {
    const canonical = `${y}-${mo}-${d} ${h}:${mi}:${s}`;
    return fractional ? `${canonical}${fractional}` : canonical;
  }

  const offsetMatch = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  if (!offsetMatch) return null;
  const sign = offsetMatch[1] === '-' ? -1 : 1;
  const offsetMinutes = sign * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3]));
  return formatUtc(new Date(utcMs - offsetMinutes * 60_000), fractional);
}

// ---------------------------------------------------------------------------
// Column discovery
// ---------------------------------------------------------------------------

const TS_SHAPE =
  /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?(\.\d{1,9})?(Z|z|[+-]\d{2}:?\d{2})?)?$/;

const SAMPLE_SIZE = 200;
const SAMPLE_MATCH_THRESHOLD = 0.9;

/**
 * A column qualifies when it is TEXT-ish and at least 90% of a 200-row sample
 * parses as a timestamp. The threshold (rather than 100%) catches columns like
 * sprints.started_at that hold a stray date-only value, while the sample keeps
 * discovery cheap on a multi-GB database. Free-text columns that merely happen
 * to contain a date (task_history.old_value/new_value) fall well below it.
 */
function discoverTimestampColumns(db, tableFilter) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name)
    .filter((t) => tableFilter.length === 0 || tableFilter.includes(t));

  const columns = [];
  for (const table of tables) {
    for (const col of db.prepare(`PRAGMA table_info("${table}")`).all()) {
      const declared = String(col.type || '').toUpperCase();
      if (/INT|REAL|BLOB|BOOL|NUMERIC|DOUBLE|FLOAT/.test(declared)) continue;

      let sample;
      try {
        sample = db
          .prepare(`SELECT "${col.name}" AS v FROM "${table}" WHERE "${col.name}" IS NOT NULL LIMIT ${SAMPLE_SIZE}`)
          .all();
      } catch {
        continue;
      }
      if (sample.length === 0) continue;

      const hits = sample.filter((r) => typeof r.v === 'string' && TS_SHAPE.test(r.v)).length;
      if (hits / sample.length < SAMPLE_MATCH_THRESHOLD) continue;

      columns.push({ table, column: col.name, default: col.dflt_value ?? null });
    }
  }
  return columns;
}

function profileColumn(db, table, column) {
  const row = db
    .prepare(
      `SELECT
         COUNT(*)                                                                    AS total,
         SUM(CASE WHEN "${column}" IS NULL THEN 1 ELSE 0 END)                        AS nulls,
         SUM(CASE WHEN "${column}" LIKE '%T%Z' THEN 1 ELSE 0 END)                    AS iso_z,
         SUM(CASE WHEN "${column}" NOT LIKE '%T%'
                   AND "${column}" LIKE '____-__-__ %' THEN 1 ELSE 0 END)            AS naive,
         SUM(CASE WHEN "${column}" LIKE '____-__-__' THEN 1 ELSE 0 END)              AS date_only,
         SUM(CASE WHEN "${column}" LIKE '%T%'
                   AND "${column}" NOT LIKE '%Z' THEN 1 ELSE 0 END)                  AS offset_form,
         MIN("${column}")                                                            AS min,
         MAX("${column}")                                                            AS max
       FROM "${table}"`,
    )
    .get();
  row.other =
    row.total - row.nulls - row.iso_z - row.naive - row.date_only - row.offset_form;
  row.mixed = row.iso_z + row.offset_form > 0 && row.naive + row.date_only > 0;
  return row;
}

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

function table(rows, headers) {
  if (rows.length === 0) return '  (none)';
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)),
  );
  const line = (cells) =>
    '  ' + cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dbPath: null,
    dryRun: false,
    onlyMixed: false,
    truncateFractional: false,
    tables: [],
    json: false,
    yes: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--only-mixed') opts.onlyMixed = true;
    else if (a === '--truncate-fractional') opts.truncateFractional = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--table') opts.tables.push(argv[++i]);
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) {
      console.error(`Unknown option: ${a}`);
      process.exit(2);
    } else if (opts.dbPath === null) opts.dbPath = a;
    else {
      console.error(`Unexpected argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

const USAGE = `
normalize-timestamps.mjs — collapse mixed timestamp encodings to canonical UTC

  node scripts/normalize-timestamps.mjs <db-path> [--dry-run] [--only-mixed]
                                        [--truncate-fractional] [--table NAME]
                                        [--json] [--yes]

<db-path> is REQUIRED and is never defaulted to the production database.
`.trim();

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (!opts.dbPath) {
    console.error(USAGE);
    console.error('\nERROR: a database path argument is required.');
    process.exit(2);
  }
  if (!fs.existsSync(opts.dbPath)) {
    console.error(`ERROR: no such database: ${opts.dbPath}`);
    process.exit(2);
  }
  assertNotProduction(opts.dbPath);

  const started = Date.now();
  const db = new Database(opts.dbPath, { readonly: opts.dryRun, fileMustExist: true });
  db.pragma('foreign_keys = OFF'); // we only touch scalar timestamp columns

  const log = opts.json ? () => {} : (...a) => console.log(...a);

  log(`database        : ${path.resolve(opts.dbPath)}`);
  log(`mode            : ${opts.dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`);
  log(`scope           : ${opts.onlyMixed ? 'mixed-format columns only' : 'all timestamp columns'}`);
  log(`fractional secs : ${opts.truncateFractional ? 'TRUNCATE' : 'preserve'}`);
  log('');

  let discovered = discoverTimestampColumns(db, opts.tables);
  log(`discovered ${discovered.length} timestamp-shaped columns`);

  const profiled = discovered.map((c) => ({ ...c, before: profileColumn(db, c.table, c.column) }));
  const mixedColumns = profiled.filter((c) => c.before.mixed);

  log(`of which ${mixedColumns.length} currently hold BOTH encodings (the defect):`);
  log(
    table(
      mixedColumns.map((c) => [
        `${c.table}.${c.column}`,
        c.before.total,
        c.before.iso_z,
        c.before.offset_form,
        c.before.naive,
        c.before.date_only,
      ]),
      ['column', 'rows', 'ISO-Z', 'offset', 'naive', 'date-only'],
    ),
  );
  log('');

  const targets = opts.onlyMixed ? mixedColumns : profiled;

  // -------------------------------------------------------------------------
  // Plan: which values actually change?
  // -------------------------------------------------------------------------
  const fractionalOpts = { preserveFractional: !opts.truncateFractional };
  const plan = [];

  /**
   * Walk one column row-by-row via rowid. Streaming (rather than building an
   * `IN (...)` list of distinct values) keeps memory bounded and avoids
   * SQLITE_MAX_VARIABLE_NUMBER on columns with hundreds of thousands of
   * distinct timestamps.
   */
  function scanColumn(t, column, onChange) {
    const distinctChanged = new Set();
    const examples = [];
    let rowsAffected = 0;
    let unparseable = 0;
    let unparseableExamples = [];

    const rows = db
      .prepare(`SELECT rowid AS rid, "${column}" AS v FROM "${t}" WHERE "${column}" IS NOT NULL`)
      .iterate();

    for (const { rid, v } of rows) {
      if (typeof v !== 'string') {
        unparseable += 1;
        if (unparseableExamples.length < 3) unparseableExamples.push(String(v));
        continue;
      }
      const canonical = toCanonicalTimestamp(v, fractionalOpts);
      if (canonical === null) {
        unparseable += 1;
        if (unparseableExamples.length < 3) unparseableExamples.push(v);
        continue;
      }
      if (canonical === v) continue;

      rowsAffected += 1;
      if (distinctChanged.size < 100_000) distinctChanged.add(v);
      if (examples.length < 3) examples.push(`${v} -> ${canonical}`);
      if (onChange) onChange(rid, canonical);
    }

    return { rowsAffected, distinctChanged: distinctChanged.size, examples, unparseable, unparseableExamples };
  }

  for (const target of targets) {
    const { table: t, column } = target;
    const scan = scanColumn(t, column, null);
    plan.push({
      ...target,
      distinctRewritten: scan.distinctChanged,
      distinctUnparseable: scan.unparseable,
      unparseableExamples: scan.unparseableExamples,
      examples: scan.examples,
      rowsAffected: scan.rowsAffected,
      scanColumn,
    });
  }

  const changing = plan.filter((p) => p.rowsAffected > 0);
  const totalRows = changing.reduce((s, p) => s + p.rowsAffected, 0);
  const totalUnparseable = plan.reduce((s, p) => s + p.distinctUnparseable, 0);

  log('=== PLAN: values that would change ===');
  log(
    table(
      changing.map((p) => [
        `${p.table}.${p.column}`,
        p.rowsAffected,
        p.before.total,
        p.before.mixed ? 'MIXED' : '',
        p.examples[0] ?? '',
      ]),
      ['column', 'rows to rewrite', 'rows total', 'flag', 'example'],
    ),
  );
  log('');
  log(`columns to rewrite : ${changing.length}`);
  log(`rows to rewrite    : ${totalRows}`);
  if (totalUnparseable > 0) {
    log(`!! unparseable values left untouched: ${totalUnparseable}`);
    for (const p of plan.filter((x) => x.distinctUnparseable > 0)) {
      log(`   ${p.table}.${p.column}: ${p.distinctUnparseable} e.g. ${JSON.stringify(p.unparseableExamples)}`);
    }
  }
  log('');

  // -------------------------------------------------------------------------
  // Before snapshot
  // -------------------------------------------------------------------------
  log('=== BEFORE ===');
  log(
    table(
      changing.map((p) => [
        `${p.table}.${p.column}`,
        p.before.total - p.before.nulls,
        p.before.min,
        p.before.max,
      ]),
      ['column', 'non-null', 'min', 'max'],
    ),
  );
  log('');

  if (opts.dryRun) {
    log('DRY RUN — nothing was written.');
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            database: path.resolve(opts.dbPath),
            columnsDiscovered: discovered.length,
            columnsMixed: mixedColumns.map((c) => `${c.table}.${c.column}`),
            plan: changing.map((p) => ({
              column: `${p.table}.${p.column}`,
              rowsAffected: p.rowsAffected,
              rowsTotal: p.before.total,
              mixed: p.before.mixed,
              before: { min: p.before.min, max: p.before.max },
            })),
            totalRows,
            totalUnparseable,
          },
          null,
          2,
        ),
      );
    }
    db.close();
    return;
  }

  // -------------------------------------------------------------------------
  // Apply, in one transaction
  // -------------------------------------------------------------------------
  const apply = db.transaction(() => {
    let written = 0;
    for (const p of changing) {
      // Re-scan and update by rowid inside the transaction. Updating by rowid
      // (rather than by matching on the old value) is safe against a value that
      // normalizes to a string another row already holds.
      const update = db.prepare(`UPDATE "${p.table}" SET "${p.column}" = ? WHERE rowid = ?`);
      const pending = [];
      p.scanColumn(p.table, p.column, (rid, canonical) => pending.push([rid, canonical]));
      for (const [rid, canonical] of pending) {
        written += update.run(canonical, rid).changes;
      }
    }
    return written;
  });

  let written;
  try {
    written = apply();
  } catch (err) {
    console.error('\nTRANSACTION ROLLED BACK:', err instanceof Error ? err.message : String(err));
    db.close();
    process.exit(1);
  }

  log(`=== APPLIED: ${written} rows updated in one transaction ===`);
  log('');

  // -------------------------------------------------------------------------
  // After snapshot + verification
  // -------------------------------------------------------------------------
  const after = changing.map((p) => ({ p, a: profileColumn(db, p.table, p.column) }));

  log('=== AFTER ===');
  log(
    table(
      after.map(({ p, a }) => [
        `${p.table}.${p.column}`,
        a.total - a.nulls,
        a.min,
        a.max,
      ]),
      ['column', 'non-null', 'min', 'max'],
    ),
  );
  log('');

  log('=== BEFORE / AFTER format counts ===');
  log(
    table(
      after.map(({ p, a }) => [
        `${p.table}.${p.column}`,
        `${p.before.iso_z + p.before.offset_form} -> ${a.iso_z + a.offset_form}`,
        `${p.before.naive} -> ${a.naive}`,
        `${p.before.date_only} -> ${a.date_only}`,
        p.before.total === a.total ? 'ok' : `ROW COUNT CHANGED ${p.before.total}->${a.total}`,
      ]),
      ['column', 'offset-bearing', 'canonical', 'date-only', 'rowcount'],
    ),
  );
  log('');

  const stillOffsetBearing = after.filter(({ a }) => a.iso_z + a.offset_form + a.date_only > 0);
  const rowCountDrift = after.filter(({ p, a }) => p.before.total !== a.total);

  if (rowCountDrift.length > 0) {
    console.error('!! ROW COUNTS CHANGED — investigate before migrating:');
    for (const { p, a } of rowCountDrift) {
      console.error(`   ${p.table}.${p.column}: ${p.before.total} -> ${a.total}`);
    }
    process.exitCode = 1;
  }

  if (stillOffsetBearing.length > 0) {
    console.error('!! Columns still holding non-canonical values:');
    for (const { p, a } of stillOffsetBearing) {
      console.error(
        `   ${p.table}.${p.column}: ISO-Z=${a.iso_z} offset=${a.offset_form} date-only=${a.date_only}`,
      );
    }
    process.exitCode = 1;
  } else {
    log('All targeted columns now hold only canonical offset-less UTC timestamps.');
    log("Postgres migration may use a single cast: col::timestamp AT TIME ZONE 'UTC'");
  }

  log(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
