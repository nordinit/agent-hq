import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Db } from '../adapter/types';

/**
 * The PostgreSQL migration runner — the replacement for db/schema.ts.
 *
 * WHY THIS IS A DIFFERENT KIND OF THING
 * db/schema.ts was not a schema. It was a state-dependent repair engine: 6,324 lines that
 * inspected the live database on every boot and patched whatever it found, using
 * ensureTableColumn() ALTERs and table rebuilds. That approach hid real drift — its inline
 * CREATE TABLE blocks declared 59 tables / 703 columns while production actually had
 * 71 / 879 — and made "is my schema correct?" unanswerable without running it.
 *
 * This runner is ordinary and boring by design:
 *   - migrations are numbered SQL files, applied once, in order
 *   - each is recorded with a checksum
 *   - a checksum that no longer matches is DRIFT and fails loudly
 *   - nothing inspects the live schema to decide what to do
 *
 * The consequence worth stating: the schema is whatever the migrations say, and that can
 * be known by reading them. It is no longer a function of how the database happened to
 * evolve.
 */

export interface Migration {
  id: string;
  checksum: string;
  sql: string;
}

export class MigrationDriftError extends Error {
  readonly code = 'MIGRATION_DRIFT';
  constructor(message: string) {
    super(message);
    this.name = 'MigrationDriftError';
  }
}

export class MigrationPendingError extends Error {
  readonly code = 'MIGRATION_PENDING';
  constructor(message: string) {
    super(message);
    this.name = 'MigrationPendingError';
  }
}

/**
 * The whole schema in one migration: the squash of 00-baseline.sql and 12 through 53, made on
 * 2026-11-12 and verified to build a database identical to that chain.
 */
export const SCHEMA_BASELINE_ID = '00-schema.sql';

/**
 * Every migration folded into 00-schema.sql, with the checksum it was applied with. The files no
 * longer ship. A database that applied all of them already has the schema 00-schema.sql creates,
 * so the explicit migrate command records it without running it; the old rows stay as provenance.
 */
export const FOLDED_MIGRATIONS: ReadonlyArray<{ id: string; checksum: string }> = [
  { id: '00-baseline.sql', checksum: '3372e6772906d885' },
  { id: '12-drop-dead-workflow-template-model.sql', checksum: '2e74d43fa72e3644' },
  { id: '13-drop-sprints-workflow-template-key.sql', checksum: 'bfb0833ab5535f62' },
  { id: '14-routing-config-audit-log.sql', checksum: '69a4e1fca2f0de6b' },
  { id: '15-drop-global-transition-requirements.sql', checksum: 'd0dce274103b2c43' },
  { id: '16-job-instance-stopped-status.sql', checksum: '5145645d6c089f44' },
  { id: '17-skill-package-files-and-content-repair.sql', checksum: '44d2c6a78f456646' },
  { id: '18-runtime-event-tenant-and-integrity-types.sql', checksum: '31b9ced088060456' },
  { id: '19-backfill-legacy-tenant-ownership.sql', checksum: 'de968393512bcad9' },
  { id: '20-runtime-executions-and-checkpoints.sql', checksum: '7b870ac6ac235581' },
  { id: '21-agent-teams.sql', checksum: 'd229d2757a2a4edd' },
  { id: '22-dispatch-context-bundles.sql', checksum: '679086c9e79dd51d' },
  { id: '23-mcp-oauth.sql', checksum: '55f7302baa840a7f' },
  { id: '24-mcp-api-key-role.sql', checksum: '879c007f920a3ce2' },
  { id: '25-drop-legacy-mcp-admin-flags.sql', checksum: '208387d2e2bcc05f' },
  { id: '26-telemetry-capture.sql', checksum: '0cdf752fef447b7d' },
  { id: '27-telemetry-definitions.sql', checksum: 'e2e874388f6b0c33' },
  { id: '28-telemetry-retention.sql', checksum: '3a2c57408ba3e32a' },
  { id: '29-telemetry-field-generations.sql', checksum: 'aefcf9098517e8fd' },
  { id: '30-telemetry-signal-generations.sql', checksum: '30263a8174a9b20d' },
  { id: '31-workflow-environment-setup.sql', checksum: 'de038c265624cadb' },
  { id: '32-workflow-terminology.sql', checksum: '592d5fba5560aeaf' },
  { id: '33-recurring-series-gates.sql', checksum: '462d0bd4b2a8d15c' },
  { id: '34-runtime-abort-target.sql', checksum: '026783e56edcbd40' },
  { id: '35-dashboard-pages.sql', checksum: '2ce8d035eb9f71d5' },
  { id: '36-drop-integrity-events.sql', checksum: '7800d01789835b85' },
  { id: '37-openclaw-mcp-reconciliation.sql', checksum: '5264996f9ac5e760' },
  { id: '38-telemetry-source-invalidation.sql', checksum: 'e4aeccf786e59525' },
  { id: '39-openclaw-mcp-recovery.sql', checksum: 'c93a1f13d43421cc' },
  { id: '40-dispatch-retry-backoff.sql', checksum: 'fd7ce2b87b7c2a4a' },
  { id: '41-telemetry-outcome-evidence.sql', checksum: '3fa12578381b65d5' },
  { id: '42-telemetry-invalidation-scan.sql', checksum: '77759470ad00c5ef' },
  { id: '43-agent-call-liveness.sql', checksum: '0cab6bb4dad2259c' },
  { id: '44-openclaw-automatic-recovery.sql', checksum: '81ff4d42d41a2b2e' },
  { id: '45-openclaw-mcp-targeted-sync.sql', checksum: '784c37877333da64' },
  { id: '46-keep-same-agent.sql', checksum: 'e233e1987c7602ea' },
  { id: '47-built-in-runtime-failed.sql', checksum: 'b5737a49c3c74a98' },
  { id: '48-drop-agent-schedule.sql', checksum: '675db284d07d0920' },
  { id: '49-execution-authority.sql', checksum: '3ad77021011efd71' },
  { id: '50-retire-openclaw-and-legacy-tables.sql', checksum: 'd0f492f5357e411f' },
  { id: '51-organize-schemas.sql', checksum: '0eab208ca2ddfc2d' },
  { id: '52-project-archive.sql', checksum: 'a48b19082cb41b90' },
  { id: '53-drop-system-policies.sql', checksum: 'abc601fe976784c0' },
];

/** The commit that last shipped the folded chain, for databases that applied only part of it. */
const LAST_UNFOLDED_RELEASE = 'e88d5e77';

/** The baseline folded into 00-baseline.sql earlier. Databases that predate 00 recorded these. */
const PRE_BASELINE_LEDGER = [
  { id: '01-tables.sql', checksum: '55312bc3474ba438' },
  { id: '02-indexes.sql', checksum: 'c5ca4ac7657a4b47' },
  { id: '03-foreign-keys.sql', checksum: '6adec7d22ec4e219' },
] as const;

/** Ledger rows that are known and immutable but no longer have a file on disk. */
const RETAINED_LEGACY_LEDGER = new Map<string, string>([
  ...PRE_BASELINE_LEDGER.map(({ id, checksum: legacyChecksum }) => [id, legacyChecksum] as const),
  // Databases created by the original data-transfer path retain this provenance row. It never
  // represented PostgreSQL DDL, but its exact value is immutable and known.
  ['init_schema', 'initSchema'],
  ...FOLDED_MIGRATIONS.map(({ id, checksum: foldedChecksum }) => [id, foldedChecksum] as const),
]);

const checksum = (sql: string): string =>
  crypto.createHash('sha256').update(sql.trim()).digest('hex').slice(0, 16);

/**
 * Loads migrations from a directory, ordered by their numeric prefix.
 *
 * Ordering is numeric, not lexicographic: sorting "10-rename.sql" as a string places it
 * before "02-indexes.sql", which would apply a rename to tables that do not exist yet.
 */
export function loadMigrations(dirs: string | string[]): Migration[] {
  // The application has one authoritative directory, db/pg-migrations. Array support remains a
  // small utility convenience for isolated tests and tooling, and the combined set is sorted
  // again so correctness never depends on argument order. Subdirectories are deliberately not
  // read: db/pg-migrations/staged contains migrations that are not approved for application.
  return (Array.isArray(dirs) ? dirs : [dirs])
    .flatMap((dir) => loadMigrationsFromDir(dir))
    .sort((a, b) => a.order - b.order);
}

function loadMigrationsFromDir(dir: string): Array<Migration & { order: number }> {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => {
      const prefix = Number(/^(\d+)/.exec(f)?.[1] ?? NaN);
      if (Number.isNaN(prefix)) {
        throw new Error(
          `Migration "${f}" has no numeric prefix. Order would be undefined, and an ` +
          `out-of-order migration can rename or alter an object that does not exist yet.`
        );
      }
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      return { id: f, order: prefix, checksum: checksum(sql), sql };
    })
    .sort((a, b) => a.order - b.order);
}

function requireMigrations(dirs: string | string[]): Migration[] {
  const found = loadMigrations(dirs);
  if (found.length === 0) {
    throw new Error(
      'No migrations found in ' + (Array.isArray(dirs) ? dirs.join(', ') : dirs) + '. '
      + 'The schema cannot be migrated or verified against an empty migration set. '
      + 'Check that db/pg-migrations is present in the deployment.',
    );
  }
  return found;
}

/** Asked rather than assumed so status and boot remain read-only on an empty database. */
async function ledgerExists(db: Db): Promise<boolean> {
  const row = await db.get<{ present: unknown }>(
    `SELECT 1 AS present FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = 'schema_migrations'`,
  );
  return row != null;
}

function validateFoldedLedger(
  recorded: Array<{ id: string; checksum: string }>,
): 'absent' | 'complete' {
  const byId = new Map(recorded.map((row) => [row.id, row.checksum]));
  const present = FOLDED_MIGRATIONS.filter(({ id }) => byId.has(id));
  if (present.length === 0) {
    // A database from before migration 00 holds only 01/02/03. Running 00-schema.sql on it would
    // collide with its tables, so it has to go through the folded chain first.
    if (PRE_BASELINE_LEDGER.some(({ id }) => byId.has(id))) {
      throw new MigrationDriftError(
        `Cannot apply ${SCHEMA_BASELINE_ID}: this database predates migration 00-baseline.sql. ` +
        `Migrate it with release ${LAST_UNFOLDED_RELEASE}, which still ships the full chain, then retry.`,
      );
    }
    return 'absent';
  }

  const missing = FOLDED_MIGRATIONS.filter(({ id }) => !byId.has(id)).map(({ id }) => id);
  const mismatched = FOLDED_MIGRATIONS
    .filter(({ id, checksum: expected }) => {
      const actual = byId.get(id);
      return actual !== undefined && actual !== expected;
    })
    .map(({ id, checksum: expected }) => `${id}: recorded ${byId.get(id)}, expected ${expected}`);

  if (missing.length || mismatched.length) {
    const details = [
      missing.length ? `missing ${missing.join(', ')}` : '',
      ...mismatched,
    ].filter(Boolean).join('\n  ');
    throw new MigrationDriftError(
      `Cannot adopt ${SCHEMA_BASELINE_ID}: the ledger holds only part of the folded migration chain, ` +
      `or a folded checksum differs.\n  ${details}\n` +
      `No schema changes were made. Migrate with release ${LAST_UNFOLDED_RELEASE}, which still ships ` +
      `the full chain, then retry.`,
    );
  }

  return 'complete';
}

/**
 * Records 00-schema.sql for a database that already applied every folded migration.
 *
 * This is deliberately reachable only from runMigrations(), the explicit migration command.
 * migrationStatus() and verifyMigrationsCurrent() never call it, so starting the API or asking
 * for status cannot mutate the ledger. The folded rows remain in the ledger as provenance.
 */
async function adoptSchemaBaseline(db: Db, baseline: Migration): Promise<boolean> {
  if (!await ledgerExists(db)) return false;

  return await db.withTransaction(async (tx) => {
    // Serialize explicit migrators and re-read after taking the lock. This makes the decision and
    // the new ledger row one atomic operation rather than a check-then-write race.
    await tx.exec('LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE');
    const recorded = await tx.all<{ id: string; checksum: string }>(
      `SELECT id, checksum FROM schema_migrations`,
    );
    if (validateFoldedLedger(recorded) === 'absent') return false;

    await tx.run(
      `INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)
       ON CONFLICT (id) DO NOTHING`,
      baseline.id,
      baseline.checksum,
    );
    return true;
  });
}

/**
 * Masks comments and quoted bodies without changing string offsets.
 *
 * Some migrations (12-15, now folded) were authored with BEGIN/COMMIT wrappers. Executing one inside
 * Db.withTransaction() lets its COMMIT end the runner's transaction before the ledger insert,
 * destroying the all-or-nothing guarantee. We identify only transaction control at the outer
 * edges and strip it from the execution copy; the checksum remains over the original file.
 */
function maskNonCode(sql: string): string {
  const chars = sql.split('');
  const mask = (index: number): void => { if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' '; };

  for (let i = 0; i < sql.length;) {
    if (sql.startsWith('--', i)) {
      while (i < sql.length && sql[i] !== '\n') { mask(i); i++; }
      continue;
    }
    if (sql.startsWith('/*', i)) {
      let depth = 0;
      while (i < sql.length) {
        if (sql.startsWith('/*', i)) { depth++; mask(i); mask(i + 1); i += 2; continue; }
        if (sql.startsWith('*/', i)) {
          depth--; mask(i); mask(i + 1); i += 2;
          if (depth === 0) break;
          continue;
        }
        mask(i); i++;
      }
      continue;
    }
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i];
      mask(i++);
      while (i < sql.length) {
        mask(i);
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { mask(i + 1); i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (sql[i] === '$') {
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (delimiter) {
        for (let j = 0; j < delimiter.length; j++) mask(i + j);
        i += delimiter.length;
        const end = sql.indexOf(delimiter, i);
        const stop = end < 0 ? sql.length : end + delimiter.length;
        while (i < stop) { mask(i); i++; }
        continue;
      }
    }
    i++;
  }
  return chars.join('');
}

function sqlForExecution(sql: string): string {
  const masked = maskNonCode(sql);
  const firstCode = masked.search(/\S/);
  if (firstCode < 0) return sql;

  const begin = /^BEGIN(?:\s+(?:WORK|TRANSACTION))?\s*;/i.exec(masked.slice(firstCode));
  const commit = /\bCOMMIT(?:\s+(?:WORK|TRANSACTION))?\s*;\s*$/i.exec(masked);

  if (!begin && !commit) return sql;
  if (!begin || !commit || commit.index < firstCode + begin[0].length) {
    throw new Error(
      'Migration contains unmatched outer transaction control. Each migration is already run ' +
      'atomically by the migration runner; remove the unmatched BEGIN or COMMIT.',
    );
  }

  const beginEnd = firstCode + begin[0].length;
  const commitEnd = commit.index + commit[0].trimEnd().length;
  return sql.slice(0, firstCode) + sql.slice(beginEnd, commit.index) + sql.slice(commitEnd);
}

async function ensureLedger(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      applied_by  text NOT NULL DEFAULT 'agent-hq-api'
    )
  `);
}

export interface MigrationStatus {
  applied: string[];
  pending: string[];
  drifted: Array<{ id: string; recorded: string; actual: string }>;
  /** Ledger entries this release cannot account for (usually a newer/stale release mismatch). */
  unexpected: Array<{ id: string; recorded: string; expected?: string }>;
}

export async function migrationStatus(db: Db, dir: string | string[]): Promise<MigrationStatus> {
  const onDisk = requireMigrations(dir);
  // Reading must not create. No ledger means nothing has been applied, which is exactly what an
  // empty database should report — and creating one here would break the migration that declares it.
  const recorded = await ledgerExists(db)
    ? await db.all<{ id: string; checksum: string }>(`SELECT id, checksum FROM schema_migrations`)
    : [];
  const byId = new Map(recorded.map((r) => [r.id, r.checksum]));

  const applied: string[] = [];
  const pending: string[] = [];
  const drifted: MigrationStatus['drifted'] = [];
  const unexpected: MigrationStatus['unexpected'] = [];
  const onDiskIds = new Set(onDisk.map((migration) => migration.id));

  for (const m of onDisk) {
    const seen = byId.get(m.id);
    if (seen === undefined) { pending.push(m.id); continue; }
    if (seen !== m.checksum) { drifted.push({ id: m.id, recorded: seen, actual: m.checksum }); continue; }
    applied.push(m.id);
  }

  for (const row of recorded) {
    if (onDiskIds.has(row.id)) continue;
    const retainedChecksum = RETAINED_LEGACY_LEDGER.get(row.id);
    if (retainedChecksum === row.checksum) continue;
    unexpected.push({
      id: row.id,
      recorded: row.checksum,
      ...(retainedChecksum === undefined ? {} : { expected: retainedChecksum }),
    });
  }

  return { applied, pending, drifted, unexpected };
}

/**
 * Applies every pending migration, each inside its own transaction.
 *
 * Per-migration transactions rather than one enclosing transaction: PostgreSQL rolls the
 * whole transaction back on any error, so a single wrapper would discard migrations that
 * had already succeeded and leave the ledger disagreeing with the schema. One transaction
 * each means a failure stops the run with everything before it durably applied and
 * recorded.
 */
export async function runMigrations(db: Db, dir: string | string[]): Promise<string[]> {
  const status = await migrationStatus(db, dir);

  if (status.drifted.length || status.unexpected.length) {
    throw new MigrationDriftError(
      [
        status.drifted.length
          ? `${status.drifted.length} migration(s) changed after being applied:\n${status.drifted.map((d) => `  ${d.id}: recorded ${d.recorded}, file is now ${d.actual}`).join('\n')}`
          : '',
        status.unexpected.length
          ? `${status.unexpected.length} ledger migration(s) are absent from this release:\n${status.unexpected.map((d) => `  ${d.id}: recorded ${d.recorded}${d.expected ? `, expected ${d.expected}` : ''}`).join('\n')}`
          : '',
        'The database and repository must describe the same migration sequence. Use the release that owns every applied migration; never delete or edit an applied migration.',
      ].filter(Boolean).join('\n'),
    );
  }

  const onDisk = loadMigrations(dir);
  const pending = new Set(status.pending);
  const appliedNow: string[] = [];

  const schemaBaseline = onDisk.find((migration) => migration.id === SCHEMA_BASELINE_ID);
  if (schemaBaseline && pending.has(SCHEMA_BASELINE_ID)) {
    if (await adoptSchemaBaseline(db, schemaBaseline)) {
      pending.delete(SCHEMA_BASELINE_ID);
      console.log(
        `[migrate] adopted ${SCHEMA_BASELINE_ID}: the ledger already holds every folded migration, ` +
        `kept as provenance`,
      );
    }
  }

  for (const m of onDisk) {
    if (!pending.has(m.id)) continue;
    await db.withTransaction(async (tx) => {
      await tx.exec(sqlForExecution(m.sql));
      // Inside the same runner-owned transaction, so a migration that applies but cannot be
      // recorded rolls back rather than leaving the database ahead of its ledger.
      await ensureLedger(tx);
      await tx.run(
        `INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)
         ON CONFLICT (id) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
        m.id, m.checksum,
      );
    });
    appliedNow.push(m.id);
    console.log(`[migrate] applied ${m.id}`);
  }

  return appliedNow;
}

/**
 * Boot-time gate. Refuses to start against a database whose schema does not match the
 * repository.
 *
 * Deliberately does NOT apply anything. Migrating implicitly on startup means every
 * process that happens to boot — including a stale one during a rolling deploy — can
 * mutate the schema, and two of them can race. Applying migrations is an explicit,
 * single-actor operation.
 */
export async function verifyMigrationsCurrent(db: Db, dir: string | string[]): Promise<void> {
  const status = await migrationStatus(db, dir);

  if (status.drifted.length || status.unexpected.length) {
    const details = [
      status.drifted.length
        ? `changed after application: ${status.drifted.map((d) => d.id).join(', ')}`
        : '',
      status.unexpected.length
        ? `recorded but absent from this release: ${status.unexpected.map((d) => d.id).join(', ')}`
        : '',
    ].filter(Boolean);
    throw new MigrationDriftError(
      `Schema drift: ${details.join('; ')}.`,
    );
  }
  if (status.pending.length) {
    throw new MigrationPendingError(
      `${status.pending.length} migration(s) have not been applied: ${status.pending.join(', ')}\n` +
      `Run: npm run db:migrate`
    );
  }
}
