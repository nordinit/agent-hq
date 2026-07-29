#!/usr/bin/env node
/**
 * Verifies a completed SQLite -> PostgreSQL load.
 *
 * Row counts alone are a weak check: a load can copy the right NUMBER of rows and still
 * corrupt every one of them. The checks that actually catch COPY-format damage are the
 * ones about value identity, so this compares:
 *
 *   1. row counts per table
 *   2. NULL vs empty-string counts per text column — CSV represents both as an empty
 *      field, and getting the NULL convention backwards silently rewrites thousands of
 *      values while keeping counts perfect
 *   3. checksums over sampled rows, to catch escaping damage in prose, JSON and
 *      transcript payloads containing quotes, backslashes, tabs and newlines
 *   4. structural totals: indexes and foreign keys actually present
 *
 * Usage: node scripts/pg/verify-migration.mjs <sqlite-db> <postgres-url>
 */
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require(path.resolve('api/node_modules/better-sqlite3'));
const { Client } = require(path.resolve('api/node_modules/pg'));

const [, , SRC, PG_URL] = process.argv;
if (!SRC || !PG_URL) {
  console.error('usage: verify-migration.mjs <sqlite-db> <postgres-url>');
  process.exit(1);
}

const sqlite = new Database(SRC, { readonly: true });
const pg = new Client({ connectionString: PG_URL });

let failures = 0;
const fail = (msg) => { console.error(`  FAIL  ${msg}`); failures++; };

async function main() {
  await pg.connect();

  const tables = sqlite.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).all().map((r) => r.name);

  // ---- 1. row counts -------------------------------------------------------------
  console.log('1. row counts');
  let totalRows = 0;
  for (const t of tables) {
    const s = sqlite.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
    const p = Number((await pg.query(`SELECT COUNT(*) AS c FROM "${t}"`)).rows[0].c);
    totalRows += p;
    if (s !== p) fail(`${t}: sqlite=${s} postgres=${p}`);
  }
  console.log(`   ${tables.length} tables, ${totalRows} rows compared`);

  // ---- 2. NULL vs empty string ---------------------------------------------------
  console.log('2. NULL vs empty-string fidelity');
  let checkedCols = 0;
  for (const t of tables) {
    const cols = sqlite.prepare(`PRAGMA table_info("${t}")`).all()
      .filter((c) => /TEXT|CHAR|CLOB|^$/i.test(c.type || ''));
    for (const c of cols) {
      const s = sqlite.prepare(
        `SELECT SUM(CASE WHEN "${c.name}" IS NULL THEN 1 ELSE 0 END) AS nulls,
                SUM(CASE WHEN "${c.name}" = '' THEN 1 ELSE 0 END) AS empties FROM "${t}"`
      ).get();
      const p = (await pg.query(
        `SELECT COUNT(*) FILTER (WHERE "${c.name}" IS NULL) AS nulls,
                COUNT(*) FILTER (WHERE "${c.name}" = '') AS empties FROM "${t}"`
      )).rows[0];
      checkedCols++;
      if (Number(s.nulls ?? 0) !== Number(p.nulls)) fail(`${t}.${c.name} NULLs: sqlite=${s.nulls} postgres=${p.nulls}`);
      if (Number(s.empties ?? 0) !== Number(p.empties)) fail(`${t}.${c.name} '': sqlite=${s.empties} postgres=${p.empties}`);
    }
  }
  console.log(`   ${checkedCols} text columns compared`);

  // ---- 3. value-level checksums over the largest tables ---------------------------
  console.log('3. value fidelity on sampled rows');
  const bySize = tables
    .map((t) => ({ t, n: sqlite.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c }))
    .sort((a, b) => b.n - a.n).slice(0, 8).filter((x) => x.n > 0);

  for (const { t } of bySize) {
    const pk = sqlite.prepare(`PRAGMA table_info("${t}")`).all().filter((c) => c.pk > 0);
    if (pk.length !== 1) continue;
    const key = pk[0].name;
    const cols = sqlite.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);

    const sample = sqlite.prepare(
      `SELECT * FROM "${t}" ORDER BY "${key}" LIMIT 200`
    ).all();
    if (!sample.length) continue;
    // The array cast has to match the key's real Postgres type: not every primary key
    // in this schema is an integer, and a bigint cast on a text key fails outright.
    const keyType = (await pg.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [t, key]
    )).rows[0]?.data_type ?? 'text';
    const castTo = /int/.test(keyType) ? 'bigint[]'
      : /double|numeric|real/.test(keyType) ? 'numeric[]'
      : 'text[]';
    const ids = sample.map((r) => (castTo === 'text[]' ? String(r[key]) : r[key]));
    const pgRows = (await pg.query(
      `SELECT * FROM "${t}" WHERE "${key}"::text = ANY($1::text[]) ORDER BY "${key}"`,
      [ids.map(String)]
    )).rows;

    if (pgRows.length !== sample.length) { fail(`${t}: sampled ${sample.length} rows, postgres returned ${pgRows.length}`); continue; }

    let mismatched = 0;
    for (let i = 0; i < sample.length; i++) {
      for (const c of cols) {
        const a = sample[i][c];
        const b = pgRows[i][c];
        const an = a === null || a === undefined ? null : (Buffer.isBuffer(a) ? a.toString('hex') : String(a));
        const bn = b === null || b === undefined ? null : (Buffer.isBuffer(b) ? b.toString('hex') : String(b));
        if (an !== bn) {
          if (mismatched === 0) fail(`${t}.${c} row ${sample[i][key]}: sqlite=${JSON.stringify(an)?.slice(0, 90)} postgres=${JSON.stringify(bn)?.slice(0, 90)}`);
          mismatched++;
        }
      }
    }
    console.log(`   ${t.padEnd(28)} ${sample.length} rows x ${cols.length} cols${mismatched ? `  ${mismatched} MISMATCHED` : '  ok'}`);
  }

  // ---- 4. structure ---------------------------------------------------------------
  console.log('4. structure');
  const idx = Number((await pg.query(
    `SELECT COUNT(*) AS c FROM pg_indexes WHERE schemaname='public'`)).rows[0].c);
  const fks = Number((await pg.query(
    `SELECT COUNT(*) AS c FROM pg_constraint WHERE contype='f'`)).rows[0].c);
  const sqliteIdx = sqlite.prepare(
    `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'`).get().c;
  console.log(`   indexes: postgres=${idx} (sqlite declared ${sqliteIdx}, plus primary keys)`);
  console.log(`   foreign keys: ${fks}`);
  if (fks === 0) fail('no foreign keys present');

  console.log(failures === 0 ? '\nVERIFICATION PASSED' : `\nVERIFICATION FAILED: ${failures} problem(s)`);
  await pg.end();
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error('verify failed:', e.message); process.exit(1); });
