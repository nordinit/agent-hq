#!/usr/bin/env node
/**
 * Generates the legacy-terminology rename mapping and migration, from the LIVE catalog.
 *
 * Task #775 is explicit that the mapping must be regenerated programmatically rather than
 * taken from the 2026-06-02 spec, and checking confirms why: the spec undercounts. It
 * lists 38 sprint-named indexes where the database has 41, omits task_events.sprint_id
 * and external_event_mappings.sprint_id, and predates workflow_files,
 * workflow_file_versions and provider_connections entirely. A hand-maintained list of
 * this shape is wrong the moment anything ships.
 *
 * THREE SEPARATE RENAMES, NOT ONE
 *   1. sprint -> workflow        physical tables, columns and indexes (#775)
 *   2. job -> agent              agents.job_title/job_instructions and dead columns (#779)
 *   3. deprecated API shims      handled in code, not here (#777)
 *
 * FAILS CLOSED
 * Any object matching the legacy vocabulary that this script cannot map is a hard error.
 * A rename that silently skips an object leaves the schema half-renamed, which is worse
 * than not renaming at all: application code then has to know which half it is talking to.
 *
 * WHY THIS IS CHEAP IN POSTGRESQL
 * ALTER TABLE ... RENAME and RENAME COLUMN are transactional and metadata-only, and carry
 * foreign keys, indexes and constraints automatically. None of SQLite's 12-step table
 * rebuild is needed, and the whole migration commits or rolls back as one unit.
 *
 * Usage: node scripts/pg/generate-rename-mapping.mjs <postgres-url> <out-dir>
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Client } = require(path.resolve('api/node_modules/pg'));

const [, , PG_URL, OUT_DIR] = process.argv;
if (!PG_URL || !OUT_DIR) {
  console.error('usage: generate-rename-mapping.mjs <postgres-url> <out-dir>');
  process.exit(1);
}

/**
 * Columns deliberately NOT renamed, each with the reason. Recorded here rather than in a
 * document so the fail-closed check can consult it and so the justification travels with
 * the code.
 */
const INTENTIONAL_NON_GOALS = {
  'job_instances':
    'Not renamed: 7,773 rows on the dispatch hot path, referenced by tasks.active_instance_id. ' +
    'A rename here buys naming consistency at the cost of touching the most failure-sensitive ' +
    'table in the system during a migration that is already changing engines.',
  'job_instance_id':
    'Not renamed: follows job_instances, which is out of scope for the same reason.',
  'logs.job_title':
    'Not renamed: this is a RUN LABEL, not the legacy "job" concept. It is populated on all ' +
    '62,954 log rows and is written on the logging hot path. Task #779 already draws this ' +
    'distinction and scopes run labels out of the jobs-to-agents cleanup. Renaming it is a ' +
    'separate, product-facing decision about what the field is called in the log stream.',
};

/**
 * Legacy-named columns that are DEAD and dropped rather than renamed, keyed by table.
 *
 * Each entry is verified against the live database before it is emitted: a column is only
 * dropped if it currently holds no values anywhere. Dropping on the strength of a stale
 * belief that a column is unused is exactly how a migration destroys data, so the belief
 * is re-checked at generation time and the script fails closed if it no longer holds.
 */
const DEAD_COLUMNS = [
  { table: 'agents', column: 'sprint_id', reason: 'populated on 0 of 66 agents' },
  { table: 'agents', column: 'schedule', reason: 'populated on 0 of 66 agents' },
  { table: 'task_creation_events', column: 'job_id', reason: 'unpopulated, no foreign key' },
  { table: 'task_outcome_metrics', column: 'job_id', reason: 'unpopulated, no foreign key' },
];

/**
 * sprint -> workflow, applied per underscore-delimited segment.
 *
 * Segment-wise rather than by regex word boundary, because `\b` does NOT match between an
 * underscore and a letter — `_` is a word character. A `\bsprints\b` pattern therefore
 * silently misses idx_sprints_project, idx_sprints_status, idx_sprints_tenant and
 * sprints_pkey, leaving four indexes carrying the old vocabulary. Splitting on `_` has no
 * such blind spot.
 */
/**
 * Names where the mechanical sprint -> workflow substitution produces a stuttering result.
 *
 * These three tables hold the workflow DEFINITION attached to a sprint type, so they were
 * named sprint_workflow_*. Substituting the prefix yields workflow_workflow_statuses and
 * friends. The redundant prefix is dropped instead; the targets are verified free of
 * collisions by the check below.
 */
const EXPLICIT_RENAMES = {
  sprint_workflow_statuses: 'workflow_statuses',
  sprint_workflow_templates: 'workflow_templates',
  sprint_workflow_transitions: 'workflow_transitions',
  idx_sprint_workflow_statuses_template_order: 'idx_workflow_statuses_template_order',
  idx_sprint_workflow_transitions_template_from: 'idx_workflow_transitions_template_from',
  idx_sprint_workflow_templates_lookup: 'idx_workflow_templates_lookup',
};

function renameSprintIdentifier(name) {
  if (EXPLICIT_RENAMES[name]) return EXPLICIT_RENAMES[name];
  // Derived names — sprint_workflow_statuses_pkey and the like — must follow their table,
  // so an explicit rename also applies as a prefix substitution. Longest key first, so a
  // more specific override always wins over a shorter one.
  for (const key of Object.keys(EXPLICIT_RENAMES).sort((a, b) => b.length - a.length)) {
    if (name.startsWith(`${key}_`)) {
      return `${EXPLICIT_RENAMES[key]}${name.slice(key.length)}`;
    }
  }
  return name
    .split('_')
    .map((segment) => {
      if (segment === 'sprints') return 'workflows';
      if (segment === 'sprint') return 'workflow';
      return segment;
    })
    .join('_');
}

/** agents.job_* -> agents.* (#779). */
const AGENT_COLUMN_RENAMES = {
  job_title: 'title',
  job_instructions: 'instructions',
  job_instructions_updated_at: 'instructions_updated_at',
};

/**
 * Columns on `agents` that are dead and dropped rather than renamed. Populated on 0 of 66
 * agents in production. Their WRITERS must be removed first — api/src/routes/agents.ts
 * writes agents.schedule on every create and update, so dropping the column without that
 * sweep breaks agent CRUD outright.
 */


const client = new Client({ connectionString: PG_URL });

async function main() {
  await client.connect();

  const tables = (await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`
  )).rows.map((r) => r.table_name);

  const columns = (await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='public' ORDER BY table_name, ordinal_position`
  )).rows;

  const indexes = (await client.query(
    `SELECT indexname, tablename FROM pg_indexes
      WHERE schemaname='public' ORDER BY indexname`
  )).rows;

  const tableRenames = [];
  const columnRenames = [];
  const indexRenames = [];
  const columnDrops = [];
  const unmapped = [];

  // ---- 1. tables --------------------------------------------------------------------
  for (const t of tables) {
    if (!/sprint/i.test(t)) continue;
    const to = renameSprintIdentifier(t);
    if (to === t) { unmapped.push(`table ${t}`); continue; }
    tableRenames.push({ from: t, to });
  }

  // ---- 2. columns -------------------------------------------------------------------
  for (const { table_name, column_name } of columns) {
    if (DEAD_COLUMNS.some((d) => d.table === table_name && d.column === column_name)) {
      continue; // handled below, after verifying emptiness against the live data
    }
    if (table_name === 'agents' && AGENT_COLUMN_RENAMES[column_name]) {
      columnRenames.push({ table: table_name, from: column_name, to: AGENT_COLUMN_RENAMES[column_name] });
      continue;
    }
    if (!/sprint/i.test(column_name)) continue;
    const to = renameSprintIdentifier(column_name);
    if (to === column_name) { unmapped.push(`column ${table_name}.${column_name}`); continue; }
    columnRenames.push({ table: table_name, from: column_name, to });
  }

  // ---- 3. indexes -------------------------------------------------------------------
  // Renaming a table does NOT rename its indexes in PostgreSQL, so they are handled
  // explicitly. Left alone they would keep advertising the old vocabulary in every
  // EXPLAIN plan and every catalog query.
  for (const { indexname } of indexes) {
    if (!/sprint/i.test(indexname)) continue;
    const to = renameSprintIdentifier(indexname);
    if (to === indexname) { unmapped.push(`index ${indexname}`); continue; }
    indexRenames.push({ from: indexname, to });
  }

  // ---- verify every dead column really is dead --------------------------------------
  for (const dead of DEAD_COLUMNS) {
    const exists = columns.some((c) => c.table_name === dead.table && c.column_name === dead.column);
    if (!exists) continue;

    // "Unpopulated" means holding nothing beyond NULL or the column's OWN declared
    // default. A bare IS NOT NULL test is too crude: agents.schedule is
    // NOT NULL DEFAULT '' and reads as populated on all 66 rows while carrying no
    // information at all. Comparing against the declared default is what actually
    // distinguishes "every row was explicitly given a value" from "the default was never
    // overridden".
    const { rows: meta } = await client.query(
      `SELECT column_default FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
      [dead.table, dead.column]
    );
    const columnDefault = meta[0]?.column_default ?? null;
    const predicate = columnDefault
      ? `"${dead.column}" IS NOT NULL AND "${dead.column}" <> (${columnDefault})`
      : `"${dead.column}" IS NOT NULL`;
    const { rows } = await client.query(
      `SELECT COUNT(*)::bigint AS populated FROM "${dead.table}" WHERE ${predicate}`
    );
    const populated = Number(rows[0].populated);
    if (populated > 0) {
      unmapped.push(
        `column ${dead.table}.${dead.column} is marked dead ("${dead.reason}") but now holds ` +
        `${populated} row(s) with a value other than its default — refusing to drop it`
      );
      continue;
    }
    columnDrops.push({ table: dead.table, column: dead.column, reason: dead.reason });
  }

  // ---- fail closed ------------------------------------------------------------------
  // Anything still carrying the legacy vocabulary after mapping is an error, unless it is
  // a recorded non-goal.
  const stillLegacy = [];
  for (const { table_name, column_name } of columns) {
    const renamed = columnRenames.find((c) => c.table === table_name && c.from === column_name);
    const dropped = columnDrops.find((c) => c.table === table_name && c.column === column_name);
    if (renamed || dropped) continue;
    if (/^job_/i.test(column_name) || /sprint/i.test(column_name)) {
      const nonGoal = Object.keys(INTENTIONAL_NON_GOALS).some(
        (k) => k === `${table_name}.${column_name}` || column_name.includes(k)
      );
      if (!nonGoal) stillLegacy.push(`${table_name}.${column_name}`);
    }
  }
  for (const t of tables) {
    if (tableRenames.find((r) => r.from === t)) continue;
    if (/sprint/i.test(t)) stillLegacy.push(`table ${t}`);
    if (/^job_/i.test(t) && !INTENTIONAL_NON_GOALS[t]) stillLegacy.push(`table ${t}`);
  }

  // ---- collision check ---------------------------------------------------------------
  // A rename onto an existing name fails mid-migration and, because the whole thing is one
  // transaction, aborts every other rename with it. Cheaper to catch here.
  const existingTables = new Set(tables);
  const renamedAway = new Set(tableRenames.map((r) => r.from));
  for (const r of tableRenames) {
    if (existingTables.has(r.to) && !renamedAway.has(r.to)) {
      unmapped.push(`table rename ${r.from} -> ${r.to} collides with an existing table`);
    }
  }
  const seenTargets = new Map();
  for (const r of tableRenames) {
    if (seenTargets.has(r.to)) {
      unmapped.push(`table renames ${seenTargets.get(r.to)} and ${r.from} both target ${r.to}`);
    }
    seenTargets.set(r.to, r.from);
  }
  // Nothing should still stutter after the explicit overrides.
  for (const r of [...tableRenames, ...indexRenames]) {
    if (/(\b|_)(\w+)_\2(\b|_)/.test(r.to) || r.to.includes('workflow_workflow')) {
      unmapped.push(`rename target "${r.to}" stutters — add an entry to EXPLICIT_RENAMES`);
    }
  }

  // ---- emit -------------------------------------------------------------------------
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const sql = [
    '-- Legacy terminology rename: sprint -> workflow, job -> agent',
    '-- Generated by scripts/pg/generate-rename-mapping.mjs from the live catalog.',
    '-- Do not edit by hand: regenerate instead.',
    '--',
    '-- ALTER ... RENAME is transactional and metadata-only in PostgreSQL: foreign keys,',
    '-- indexes and constraints follow automatically, and the whole migration is one unit.',
    '',
    'BEGIN;',
    '',
    '-- 1. tables',
    ...tableRenames.map((r) => `ALTER TABLE "${r.from}" RENAME TO "${r.to}";`),
    '',
    '-- 2. columns',
    // Column renames are emitted with the table's NEW name, since the table rename above
    // has already been applied within this transaction.
    ...columnRenames.map((r) => {
      const t = tableRenames.find((x) => x.from === r.table);
      return `ALTER TABLE "${t ? t.to : r.table}" RENAME COLUMN "${r.from}" TO "${r.to}";`;
    }),
    '',
    '-- 3. drop dead columns — each verified to hold zero values at generation time',
    '--    agents.schedule has WRITERS in api/src/routes/agents.ts that must be removed',
    '--    first, or agent create and update start failing on a missing column.',
    ...columnDrops.map((c) => {
      const t = tableRenames.find((x) => x.from === c.table);
      return `ALTER TABLE "${t ? t.to : c.table}" DROP COLUMN "${c.column}";  -- ${c.reason}`;
    }),
    '',
    '-- 4. indexes (a table rename does not rename its indexes)',
    ...indexRenames.map((r) => `ALTER INDEX "${r.from}" RENAME TO "${r.to}";`),
    '',
    'COMMIT;',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(OUT_DIR, '10-rename-legacy-terminology.sql'), sql);

  // A one-release compatibility layer, so a rollback of the application does not require
  // a rollback of the schema.
  const compat = [
    '-- One-release compatibility views, mapping the OLD names onto the renamed tables.',
    '-- Generated; see 10-rename-legacy-terminology.sql.',
    '--',
    '-- These exist so an application rollback does not require a schema rollback. They are',
    '-- READ-ONLY: a simple view over a renamed table is auto-updatable in PostgreSQL, which',
    '-- would let stale code keep writing through the old vocabulary indefinitely and quietly',
    '-- defeat the migration. WITH (security_barrier) plus an explicit rule blocks writes.',
    '-- Remove this file one release after the rename ships.',
    '',
    'BEGIN;',
    ...tableRenames.map((r) => [
      `CREATE VIEW "${r.from}" WITH (security_barrier) AS SELECT * FROM "${r.to}";`,
      `CREATE RULE "${r.from}_no_insert" AS ON INSERT TO "${r.from}" DO INSTEAD NOTHING;`,
      `CREATE RULE "${r.from}_no_update" AS ON UPDATE TO "${r.from}" DO INSTEAD NOTHING;`,
      `CREATE RULE "${r.from}_no_delete" AS ON DELETE TO "${r.from}" DO INSTEAD NOTHING;`,
    ].join('\n')),
    'COMMIT;',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, '11-rename-compatibility-views.sql'), compat);

  const mapping = {
    generatedFrom: 'live catalog',
    tableRenames, columnRenames, columnDrops, indexRenames,
    intentionalNonGoals: INTENTIONAL_NON_GOALS,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'rename-mapping.json'), JSON.stringify(mapping, null, 2));

  console.log(`tables renamed:  ${tableRenames.length}`);
  console.log(`columns renamed: ${columnRenames.length}`);
  console.log(`columns dropped: ${columnDrops.length}`);
  console.log(`indexes renamed: ${indexRenames.length}`);
  console.log(`non-goals:       ${Object.keys(INTENTIONAL_NON_GOALS).length} (recorded with justification)`);

  if (unmapped.length) {
    console.error(`\nFAILED CLOSED: ${unmapped.length} object(s) matched the legacy vocabulary but produced no rename:`);
    for (const u of unmapped) console.error(`  ${u}`);
  }
  if (stillLegacy.length) {
    console.error(`\nFAILED CLOSED: ${stillLegacy.length} object(s) would still carry legacy naming after the migration:`);
    for (const s of stillLegacy) console.error(`  ${s}`);
  }
  if (unmapped.length || stillLegacy.length) process.exitCode = 1;
  else console.log('\nfail-closed check: every legacy-named object is renamed, dropped, or a recorded non-goal.');

  await client.end();
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
