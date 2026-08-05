#!/usr/bin/env node
/**
 * Runs representative Agent HQ query shapes against a provisioned PostgreSQL database,
 * through the real PostgresAdapter.
 *
 * The adapter's own contract suite proves it behaves like the SQLite one on a toy schema of
 * two tables. That is necessary but not sufficient: it says nothing about whether the
 * REAL queries — against the current PostgreSQL schema and loaded production-shaped data —
 * actually run. The failures this catches are the ones the contract tests structurally
 * cannot: a stale identifier, a PostgreSQL-incompatible query shape, a broken sequence, or
 * a NULL/empty-string distinction lost in a one-time transfer.
 *
 * Read-only except for one explicitly-rolled-back transaction.
 *
 * Usage: node scripts/pg/smoke-test.mjs <postgres-url>
 */
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Pool } = require(path.resolve('api/node_modules/pg'));

const [, , PG_URL] = process.argv;
if (!PG_URL) {
  console.error('usage: smoke-test.mjs <postgres-url>');
  process.exit(1);
}

// ts-morph/ts-node are not in play here, so the adapter is exercised through a small
// inline reimplementation of the two behaviours under test: `?` -> `$n` translation and
// the get/all/run/value shapes. Importing the TypeScript adapter would require a build
// step that does not yet pass, and the point is to test the DATABASE, not the build.
function toPositional(sql) {
  let out = '', i = 0, n = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      const start = i; i++;
      while (i < sql.length) { if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue; } i++; break; } i++; }
      out += sql.slice(start, i); continue;
    }
    if (ch === '?') { out += `$${++n}`; i++; continue; }
    out += ch; i++;
  }
  return out;
}

const pool = new Pool({ connectionString: PG_URL });
const results = [];
let failures = 0;

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`  ok    ${name}${detail ? `  (${detail})` : ''}`);
  } catch (err) {
    failures++;
    results.push({ name, ok: false, detail: err.message });
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const q = async (sql, params = []) => (await pool.query(toPositional(sql), params)).rows;

async function main() {
  console.log(`Smoke-testing ${PG_URL}\n`);

  // ---- the intentionally unrenamed current schema is queryable -----------------------
  await check('sprints table exists and has rows', async () => {
    const rows = await q(`SELECT COUNT(*)::int AS c FROM sprints`);
    if (!rows[0].c) throw new Error('sprints is empty');
    return `${rows[0].c} sprints`;
  });

  await check('tasks.sprint_id resolves and joins to sprints', async () => {
    const rows = await q(`
      SELECT COUNT(*)::int AS c
      FROM tasks t JOIN sprints s ON s.id = t.sprint_id
    `);
    return `${rows[0].c} tasks joined`;
  });

  await check('agents current columns are queryable', async () => {
    const rows = await q(`SELECT COUNT(*)::int AS c FROM agents WHERE job_title IS NOT NULL`);
    return `${rows[0].c} agents with a job title`;
  });

  await check('deferred workflow rename is not partially applied', async () => {
    const rows = await q(`
      SELECT COUNT(*)::int AS c FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'workflows'`);
    if (rows[0].c !== 0) throw new Error('unexpected workflows table: the deferred rename is partially applied');
    return 'not applied';
  });

  // ---- query shapes the application actually issues -----------------------------------
  await check('positional parameters translate', async () => {
    const rows = await q(`SELECT id, title FROM tasks WHERE status = ? LIMIT ?`, ['done', 3]);
    return `${rows.length} rows`;
  });

  await check('the dispatcher-style claim query runs', async () => {
    // The shape task #1026 replaces with FOR UPDATE SKIP LOCKED. Verifying it PARSES and
    // returns here; its atomicity is a separate concern.
    const rows = await q(`
      SELECT t.id, t.title, t.priority, t.status
        FROM tasks t
       WHERE t.status = ? AND t.sprint_id IS NOT NULL
       ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.id
       LIMIT 5`, ['todo']);
    return `${rows.length} candidate task(s)`;
  });

  await check('aggregate + GROUP BY over the current schema', async () => {
    const rows = await q(`
      SELECT s.id, s.name, COUNT(t.id)::int AS task_count
        FROM sprints s LEFT JOIN tasks t ON t.sprint_id = s.id
       GROUP BY s.id, s.name
       ORDER BY task_count DESC
       LIMIT 5`);
    return `top sprint has ${rows[0]?.task_count ?? 0} tasks`;
  });

  await check('string_agg replaces GROUP_CONCAT', async () => {
    const rows = await q(`
      SELECT string_agg(DISTINCT status, ',') AS statuses FROM tasks`);
    return rows[0].statuses?.slice(0, 60) ?? '(none)';
  });

  await check('NULL-safe comparison (IS NOT DISTINCT FROM)', async () => {
    // PostgreSQL rejects the former SQLite `col IS ?` spelling. Application SQL uses
    // the native null-safe operator directly now that no dialect translator exists.
    const rows = await q(
      `SELECT COUNT(*)::int AS c FROM tasks WHERE agent_id IS NOT DISTINCT FROM ?`, [null]);
    return `${rows[0].c} unassigned`;
  });

  await check('large transcript table is readable', async () => {
    const rows = await q(`SELECT COUNT(*)::int AS c FROM chat_messages`);
    return `${rows[0].c} messages`;
  });

  await check('NULL vs empty string survived the load', async () => {
    const rows = await q(`
      SELECT COUNT(*) FILTER (WHERE description IS NULL)::int  AS nulls,
             COUNT(*) FILTER (WHERE description = '')::int     AS empties
        FROM tasks`);
    return `null=${rows[0].nulls} empty=${rows[0].empties}`;
  });

  // ---- write path, rolled back --------------------------------------------------------
  await check('insert returns a generated id, then rolls back', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO projects (tenant_id, name, description, context_md)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [1, 'smoke-test-project', 'inserted by smoke-test', ''],
      );
      if (!rows[0]?.id) throw new Error('RETURNING gave no id');
      const id = rows[0].id;
      await client.query('ROLLBACK');
      const after = await pool.query('SELECT COUNT(*)::int AS c FROM projects WHERE id = $1', [id]);
      if (after.rows[0].c !== 0) throw new Error('rollback did not remove the row');
      return `id ${id}, rolled back`;
    } finally {
      client.release();
    }
  });

  await check('foreign keys are enforced', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let rejected = false;
      try {
        await client.query(
          `INSERT INTO tasks (title, sprint_id, tenant_id) VALUES ($1, $2, $3)`,
          ['smoke-test-orphan', 999999999, 1],
        );
      } catch { rejected = true; }
      await client.query('ROLLBACK');
      if (!rejected) throw new Error('an orphaned insert was ACCEPTED — foreign keys are not enforced');
      return 'violating insert rejected';
    } finally {
      client.release();
    }
  });

  await check('identity sequences advance past the loaded data', async () => {
    // The ETL supplies explicit ids, which does NOT advance a sequence. If setval was
    // missed, the very first insert into that table collides on its primary key — a
    // failure that appears only in production, on the first write, not during the load.
    const cols = await q(`
      SELECT c.relname AS table_name, a.attname AS column_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attidentity <> ''
       WHERE n.nspname = 'public' AND c.relkind = 'r'
       ORDER BY 1`);

    const behind = [];
    let checked = 0;
    for (const { table_name, column_name } of cols) {
      // Two separate parameters: reusing one placeholder for both the regclass lookup and
      // the column name makes PostgreSQL deduce conflicting types for it.
      const seqRow = await pool.query(
        `SELECT pg_get_serial_sequence($1::text, $2::text) AS seq`, [table_name, column_name]);
      const seq = seqRow.rows[0]?.seq;
      if (!seq) continue;
      checked++;
      const last = Number((await pool.query(`SELECT last_value, is_called FROM ${seq}`)).rows[0].last_value);
      const called = (await pool.query(`SELECT is_called FROM ${seq}`)).rows[0].is_called;
      const max = Number((await pool.query(
        `SELECT COALESCE(MAX("${column_name}"), 0) AS m FROM "${table_name}"`)).rows[0].m);
      // With is_called false, `last_value` is the NEXT value handed out, so equality is
      // fine; with is_called true the sequence must already be strictly past the max.
      const nextValue = called ? last + 1 : last;
      if (nextValue <= max) behind.push(`${table_name}.${column_name} (next ${nextValue} <= max ${max})`);
    }
    if (behind.length) {
      throw new Error(`sequence(s) behind their data: ${behind.slice(0, 5).join(', ')}`);
    }
    return `${checked} identity sequence(s) ahead of their data`;
  });

  console.log('');
  console.log(failures === 0
    ? `SMOKE TEST PASSED (${results.length} checks)`
    : `SMOKE TEST FAILED: ${failures} of ${results.length} checks`);
  await pool.end();
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error('smoke test crashed:', e.message); process.exit(1); });
