#!/usr/bin/env node
/**
 * Generates the PostgreSQL baseline schema from a live SQLite snapshot.
 *
 * WHY FROM A SNAPSHOT AND NOT FROM api/src/db/schema.ts
 * -----------------------------------------------------
 * schema.ts is not a schema. It is a state-dependent repair engine: its inline
 * CREATE TABLE blocks declare 59 tables / 703 columns, while production actually has
 * 71 tables / 879 columns. 92 columns exist only as ensureTableColumn() ALTERs applied
 * at boot, and 12 tables are created in eight other files entirely. Translating
 * schema.ts would therefore produce a Postgres database that silently does not match
 * production. The live snapshot is the only honest source of truth.
 *
 * FAITHFUL-FIRST TYPE MAPPING
 * ---------------------------
 * This emits a faithful structural port, not a redesign:
 *   INTEGER -> bigint, TEXT -> text, REAL -> double precision, BLOB -> bytea.
 * Timestamp columns stay text and JSON columns stay text on purpose. The application
 * still reads and writes them as strings, so tightening them to timestamptz/jsonb here
 * would break the app in ways indistinguishable from genuine migration bugs. Type
 * tightening is a follow-up migration once the engine swap is proven; the candidates
 * are reported at the end of this script's output so the work is not forgotten.
 *
 * OUTPUT ORDER
 * ------------
 * Three files, matching the order an efficient load wants:
 *   01-tables.sql        tables, columns, defaults, checks, primary keys
 *   02-indexes.sql       indexes and unique constraints (created AFTER bulk load)
 *   03-foreign-keys.sql  foreign keys (added AFTER bulk load)
 * Splitting foreign keys out also removes any need to topologically sort the tables:
 * every table can be created independently, and the graph is closed at the end.
 *
 * Usage: node scripts/pg/generate-baseline-schema.mjs <sqlite-db> <out-dir>
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require(path.resolve('api/node_modules/better-sqlite3'));

const [, , SRC, OUT_DIR] = process.argv;
if (!SRC || !OUT_DIR) {
  console.error('usage: generate-baseline-schema.mjs <sqlite-db> <out-dir>');
  process.exit(1);
}

const db = new Database(SRC, { readonly: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

/** Postgres reserved words that appear as Agent HQ column names and must be quoted. */
const RESERVED = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'authorization', 'binary',
  'both', 'case', 'cast', 'check', 'collate', 'column', 'constraint', 'create', 'cross',
  'current_date', 'current_role', 'current_time', 'current_timestamp', 'current_user',
  'default', 'deferrable', 'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'for',
  'foreign', 'freeze', 'from', 'full', 'grant', 'group', 'having', 'ilike', 'in', 'initially',
  'inner', 'intersect', 'into', 'is', 'isnull', 'join', 'leading', 'left', 'like', 'limit',
  'localtime', 'localtimestamp', 'natural', 'not', 'notnull', 'null', 'offset', 'on', 'only',
  'or', 'order', 'outer', 'overlaps', 'placing', 'primary', 'references', 'right', 'select',
  'session_user', 'similar', 'some', 'symmetric', 'table', 'then', 'to', 'trailing', 'true',
  'union', 'unique', 'user', 'using', 'verbose', 'when', 'where', 'window', 'with',
]);

const q = (ident) => (RESERVED.has(ident.toLowerCase()) || /[^a-z0-9_]/.test(ident) ? `"${ident}"` : ident);

/** Columns whose contents are JSON or timestamps — reported, not converted. See header. */
const jsonbCandidates = [];
const timestampCandidates = [];

function mapType(declared, columnName, tableName) {
  const t = (declared || '').toUpperCase().trim();
  const name = columnName.toLowerCase();

  if (/_json$|^json$|_json_/.test(name) || name === 'overrides' || name === 'metadata') {
    jsonbCandidates.push(`${tableName}.${columnName}`);
  }
  if (/_at$|^created$|^updated$|_time$|_timestamp$/.test(name) && (t === 'TEXT' || t === '')) {
    timestampCandidates.push(`${tableName}.${columnName}`);
  }

  if (t === '' || t === 'TEXT' || t.startsWith('VARCHAR') || t.startsWith('CHAR') ||
      t.startsWith('CLOB') || t === 'DATETIME' || t === 'TIMESTAMP' || t === 'DATE') {
    return 'text';
  }
  if (t === 'INTEGER' || t === 'INT' || t === 'BIGINT' || t === 'SMALLINT' || t === 'BOOLEAN') {
    // BOOLEAN stays integral: the application reads and writes 0/1, and a real
    // boolean column would reject those literals.
    return 'bigint';
  }
  if (t === 'REAL' || t === 'FLOAT' || t === 'DOUBLE' || t.startsWith('DOUBLE')) return 'double precision';
  if (t.startsWith('NUMERIC') || t.startsWith('DECIMAL')) return 'numeric';
  if (t === 'BLOB') return 'bytea';
  console.warn(`[warn] unmapped declared type "${declared}" on ${tableName}.${columnName} -> text`);
  return 'text';
}

/**
 * Translates a SQLite column DEFAULT into its Postgres equivalent.
 *
 * datetime('now') is the important one: it yields 'YYYY-MM-DD HH:MM:SS' in UTC, and the
 * columns stay text, so the Postgres default must produce a byte-identical string.
 * now()::text would emit a different format (with timezone offset and microseconds) and
 * would silently corrupt ordering for every row inserted after the migration.
 */
function mapDefault(dflt, pgType) {
  if (dflt === null || dflt === undefined) return null;
  const raw = String(dflt).trim();
  const bare = raw.replace(/\s+/g, '').toLowerCase();

  if (bare === "(datetime('now'))" || bare === "datetime('now')" || bare === 'current_timestamp') {
    return `to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')`;
  }
  if (bare === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return raw;
  if (/^'.*'$/s.test(raw)) return raw;
  // Parenthesised or unrecognised expression: keep it but flag it for review.
  console.warn(`[warn] passing through unrecognised default: ${raw}`);
  return raw;
}

/** Splits a DDL body on commas that sit at parenthesis depth 0. */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0, cur = '', inStr = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      cur += ch;
      if (ch === "'") inStr = body[i + 1] === "'" ? (cur += body[++i], true) : false;
      continue;
    }
    if (ch === "'") { inStr = true; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Extracts per-column CHECK(...) expressions from the original CREATE TABLE text. */
function extractChecks(createSql) {
  const open = createSql.indexOf('(');
  const body = createSql.slice(open + 1, createSql.lastIndexOf(')'));
  const checks = new Map();
  const tableChecks = [];
  for (const seg of splitTopLevel(body)) {
    const m = seg.match(/CHECK\s*\((.*)\)\s*$/is);
    if (!m) continue;
    const lead = seg.slice(0, seg.toUpperCase().indexOf('CHECK')).trim();
    const colName = lead.split(/\s+/)[0]?.replace(/["'`\[\]]/g, '');
    if (colName && !/^(PRIMARY|UNIQUE|FOREIGN|CONSTRAINT)$/i.test(colName)) {
      checks.set(colName, m[1]);
    } else {
      tableChecks.push(m[1]);
    }
  }
  return { checks, tableChecks };
}

const tables = db.prepare(
  `SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
).all();

const tableSql = [];
const fkSql = [];
const idxSql = [];
let columnCount = 0;

for (const { name: table, sql: createSql } of tables) {
  const info = db.prepare(`PRAGMA table_info("${table}")`).all();
  const { checks, tableChecks } = extractChecks(createSql || '');
  const pkCols = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);

  // A single INTEGER PRIMARY KEY is SQLite's rowid alias and is what AUTOINCREMENT
  // attaches to. GENERATED BY DEFAULT (not ALWAYS) is required: the ETL supplies
  // explicit ids to preserve every existing foreign-key reference.
  const isRowidAlias = pkCols.length === 1 && /INTEGER/i.test(pkCols[0].type || '') &&
    new RegExp(`\\b${pkCols[0].name}\\b[^,]*PRIMARY\\s+KEY`, 'i').test(createSql || '');

  const lines = [];
  for (const col of info) {
    columnCount++;
    const pgType = mapType(col.type, col.name, table);
    const def = mapDefault(col.dflt_value, pgType);
    let line = `  ${q(col.name)} ${pgType}`;
    // Postgres rejects a column that is both an identity and has a DEFAULT. Singleton
    // config tables declare `id INTEGER PRIMARY KEY DEFAULT 1`; there the default is the
    // meaningful part and the column is never auto-assigned, so the default wins.
    if (isRowidAlias && col.pk === 1 && def === null) line += ' GENERATED BY DEFAULT AS IDENTITY';
    if (col.notnull) line += ' NOT NULL';
    if (def !== null) line += ` DEFAULT ${def}`;
    const chk = checks.get(col.name);
    if (chk) line += ` CHECK (${chk})`;
    lines.push(line);
  }

  if (pkCols.length) {
    lines.push(`  PRIMARY KEY (${pkCols.map((c) => q(c.name)).join(', ')})`);
  }
  for (const tc of tableChecks) lines.push(`  CHECK (${tc})`);

  tableSql.push(`CREATE TABLE ${q(table)} (\n${lines.join(',\n')}\n);`);

  // Foreign keys, emitted separately so table creation needs no dependency order.
  const fks = db.prepare(`PRAGMA foreign_key_list("${table}")`).all();
  const grouped = new Map();
  for (const fk of fks) {
    if (!grouped.has(fk.id)) grouped.set(fk.id, []);
    grouped.get(fk.id).push(fk);
  }
  for (const [id, cols] of grouped) {
    const ordered = cols.sort((a, b) => a.seq - b.seq);
    const from = ordered.map((c) => q(c.from)).join(', ');
    // A NULL "to" means the reference targets the parent's primary key implicitly.
    const to = ordered.map((c) => (c.to ? q(c.to) : null)).filter(Boolean);
    const target = ordered[0].table;
    const targetCols = to.length
      ? `(${to.join(', ')})`
      : (() => {
          const tpk = db.prepare(`PRAGMA table_info("${target}")`).all().filter((c) => c.pk > 0);
          return tpk.length ? `(${tpk.map((c) => q(c.name)).join(', ')})` : '';
        })();
    const onDelete = ordered[0].on_delete && ordered[0].on_delete !== 'NO ACTION'
      ? ` ON DELETE ${ordered[0].on_delete}` : '';
    const onUpdate = ordered[0].on_update && ordered[0].on_update !== 'NO ACTION'
      ? ` ON UPDATE ${ordered[0].on_update}` : '';
    fkSql.push(
      `ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(`fk_${table}_${id}`)} ` +
      `FOREIGN KEY (${from}) REFERENCES ${q(target)} ${targetCols}${onDelete}${onUpdate};`
    );
  }
}

// Indexes. Partial indexes carry a WHERE clause that only exists in the original DDL,
// so those are taken from sqlite_master rather than rebuilt from index_info.
const indexes = db.prepare(
  `SELECT name, tbl_name, sql FROM sqlite_master
   WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name`
).all();

for (const idx of indexes) {
  if (!idx.sql) continue; // implicit index backing a UNIQUE constraint; already emitted
  let stmt = idx.sql.trim().replace(/\s+/g, ' ');
  stmt = stmt.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?/i, (m, u) =>
    `CREATE ${u ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS `);
  // SQLite tolerates bare identifiers Postgres reserves; quote the index name.
  stmt = stmt.replace(/"/g, '');
  idxSql.push(stmt.endsWith(';') ? stmt : `${stmt};`);
}

const header = (title) =>
  `-- ${title}\n-- Generated by scripts/pg/generate-baseline-schema.mjs from ${path.basename(SRC)}\n` +
  `-- Do not edit by hand: regenerate from the snapshot instead.\n\n`;

fs.writeFileSync(path.join(OUT_DIR, '01-tables.sql'),
  header('Agent HQ PostgreSQL baseline: tables') + tableSql.join('\n\n') + '\n');
fs.writeFileSync(path.join(OUT_DIR, '02-indexes.sql'),
  header('Agent HQ PostgreSQL baseline: indexes') + idxSql.join('\n') + '\n');
fs.writeFileSync(path.join(OUT_DIR, '03-foreign-keys.sql'),
  header('Agent HQ PostgreSQL baseline: foreign keys') + fkSql.join('\n') + '\n');

console.log(`tables:      ${tables.length}`);
console.log(`columns:     ${columnCount}`);
console.log(`indexes:     ${idxSql.length}`);
console.log(`foreign keys:${fkSql.length}`);
console.log(`\nDeferred type tightening (kept as text for a faithful first port):`);
console.log(`  jsonb candidates     (${jsonbCandidates.length}): ${jsonbCandidates.slice(0, 6).join(', ')}${jsonbCandidates.length > 6 ? ', ...' : ''}`);
console.log(`  timestamptz candidates (${timestampCandidates.length}): ${timestampCandidates.slice(0, 6).join(', ')}${timestampCandidates.length > 6 ? ', ...' : ''}`);
fs.writeFileSync(path.join(OUT_DIR, 'deferred-type-tightening.json'),
  JSON.stringify({ jsonbCandidates, timestampCandidates }, null, 2));
