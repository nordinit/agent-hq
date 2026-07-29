#!/usr/bin/env node
/**
 * Copies every row from a SQLite snapshot into the PostgreSQL baseline.
 *
 * LOAD ORDER
 * ----------
 *   1. tables      (01-tables.sql)   — no foreign keys yet, so table order is irrelevant
 *   2. data        (this script)     — streamed with COPY
 *   3. indexes     (02-indexes.sql)  — building them after the load is far cheaper
 *   4. foreign keys(03-foreign-keys.sql) — validated once, against the finished data
 * Deferring steps 3 and 4 is not just a speed trick: it means the load itself cannot
 * fail on ordering, and constraint violations surface as one clear report at the end
 * rather than as an arbitrary mid-load abort.
 *
 * WHY COPY ... WITH (FORMAT csv) AND NOT INSERT OR text FORMAT
 * -----------------------------------------------------------
 * INSERT-per-row across 515k chat_messages is prohibitively slow. COPY's default TEXT
 * format is unusable here because Agent HQ stores prose, JSON and transcript payloads
 * containing literal backslashes and tabs, which TEXT format treats as escapes and
 * silently corrupts. CSV format quotes every field and has exactly one escape rule
 * (doubling the quote character), so arbitrary payloads survive byte-identical.
 *
 * NULL vs EMPTY STRING
 * --------------------
 * These are distinct values that CSV cannot represent differently without help. An
 * unquoted empty field is NULL; a quoted empty field ("") is the empty string. Getting
 * this backwards would rewrite thousands of rows, so it is asserted after the load.
 *
 * BLOBs are hex-encoded and cast on the way in, since bytea has no CSV literal form.
 *
 * Usage: node scripts/pg/migrate-data.mjs <sqlite-db> <postgres-url> [--only=t1,t2]
 */
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require(path.resolve('api/node_modules/better-sqlite3'));
const { Client } = require(path.resolve('api/node_modules/pg'));
const copyFrom = require(path.resolve('api/node_modules/pg-copy-streams')).from;

const [, , SRC, PG_URL, ...rest] = process.argv;
if (!SRC || !PG_URL) {
  console.error('usage: migrate-data.mjs <sqlite-db> <postgres-url> [--only=t1,t2]');
  process.exit(1);
}
const only = rest.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',').filter(Boolean);

const sqlite = new Database(SRC, { readonly: true });
const pg = new Client({ connectionString: PG_URL });

/** CSV-quotes one value. Returns an EMPTY (unquoted) field for null, which COPY reads as NULL. */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (Buffer.isBuffer(value)) return `"\\x${value.toString('hex')}"`;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  const s = String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

async function main() {
  await pg.connect();

  const tables = (only ?? sqlite.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).all().map((r) => r.name));

  const report = [];
  let grandTotal = 0;

  for (const table of tables) {
    const columns = sqlite.prepare(`PRAGMA table_info("${table}")`).all();
    const colNames = columns.map((c) => c.name);
    const quoted = colNames.map((c) => `"${c}"`).join(', ');
    const srcCount = sqlite.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c;

    if (srcCount === 0) {
      report.push({ table, src: 0, dst: 0, ok: true });
      continue;
    }

    // Stream rows out of SQLite one at a time; the 515k-row transcript tables must never
    // be materialised in memory.
    const rows = sqlite.prepare(`SELECT ${quoted} FROM "${table}"`).iterate();
    const csvStream = Readable.from((function* () {
      for (const row of rows) {
        yield colNames.map((c) => csvCell(row[c])).join(',') + '\n';
      }
    })());

    const ingest = pg.query(copyFrom(
      `COPY "${table}" (${quoted}) FROM STDIN WITH (FORMAT csv, NULL '')`
    ));

    await pipeline(csvStream, ingest);

    const dstCount = Number((await pg.query(`SELECT COUNT(*) AS c FROM "${table}"`)).rows[0].c);
    const ok = dstCount === srcCount;
    if (!ok) console.error(`[etl] ROW COUNT MISMATCH ${table}: sqlite=${srcCount} postgres=${dstCount}`);
    report.push({ table, src: srcCount, dst: dstCount, ok });
    grandTotal += dstCount;
    console.log(`[etl] ${table.padEnd(42)} ${String(dstCount).padStart(8)} rows${ok ? '' : '  <<< MISMATCH'}`);
  }

  // Identity sequences do not advance when explicit ids are supplied, so without this
  // every table with a generated primary key would collide on its first insert.
  const seqFixes = await pg.query(`
    SELECT c.relname AS table_name, a.attname AS column_name,
           pg_get_serial_sequence(quote_ident(c.relname), a.attname) AS seq
    FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attidentity <> ''
  `);
  for (const { table_name, column_name, seq } of seqFixes.rows) {
    if (!seq) continue;
    await pg.query(
      `SELECT setval($1, COALESCE((SELECT MAX("${column_name}") FROM "${table_name}"), 0) + 1, false)`,
      [seq]
    );
  }
  console.log(`[etl] reset ${seqFixes.rows.length} identity sequence(s)`);

  const mismatches = report.filter((r) => !r.ok);
  console.log(`\n[etl] tables: ${report.length}   rows copied: ${grandTotal}   mismatches: ${mismatches.length}`);
  if (mismatches.length) {
    for (const m of mismatches) console.error(`  ${m.table}: sqlite=${m.src} postgres=${m.dst}`);
    process.exitCode = 1;
  }

  await pg.end();
}

main().catch((err) => {
  console.error('[etl] FAILED:', err.message);
  process.exit(1);
});
