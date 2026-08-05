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

const checksum = (sql: string): string =>
  crypto.createHash('sha256').update(sql.trim()).digest('hex').slice(0, 16);

/**
 * Loads migrations from a directory, ordered by their numeric prefix.
 *
 * Ordering is numeric, not lexicographic: sorting "10-rename.sql" as a string places it
 * before "02-indexes.sql", which would apply a rename to tables that do not exist yet.
 */
export function loadMigrations(dirs: string | string[]): Migration[] {
  // Accepts several directories because the schema is currently split: db/pg-baseline holds
  // 01-03 and db/pg-migrations holds the rest. They are sorted together by numeric prefix, so
  // the split is invisible to ordering — and disappears entirely once the baseline folds into
  // 00-baseline.sql. Subdirectories are not read: db/pg-migrations/staged holds migrations that
  // are deliberately unapplied, and they must not count as pending.
  // Sorted again across the combined set: each directory sorts its own files, but concatenating
  // two sorted lists is not a sorted list, and relying on the caller to pass them in prefix order
  // would make correctness depend on an argument nobody would think to check.
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

/**
 * Does the ledger exist yet?
 *
 * Asked rather than assumed, because on a fresh database the FIRST migration is the one that
 * creates it: db/pg-baseline/01-tables.sql declares schema_migrations itself, without
 * IF NOT EXISTS. Creating the ledger before applying that file made the file fail with
 * "relation schema_migrations already exists", so a fresh install could not get past its own
 * first migration. That file is checksummed and applied in production, so it cannot be edited
 * to add IF NOT EXISTS — the runner has to stop pre-empting it instead.
 *
 * The two definitions still differ (this one has no app_commit, and dates its column
 * timestamptz rather than text). Whichever exists is used as-is; they collapse to one at
 * Phase 3b, when the baseline folds into 00-baseline.sql and stops declaring the ledger at all.
 */
async function ledgerExists(db: Db): Promise<boolean> {
  const row = await db.get<{ present: unknown }>(
    `SELECT 1 AS present FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = 'schema_migrations'`,
  );
  return row != null;
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
}

export async function migrationStatus(db: Db, dir: string | string[]): Promise<MigrationStatus> {
  const onDisk = loadMigrations(dir);
  // Reading must not create. No ledger means nothing has been applied, which is exactly what an
  // empty database should report — and creating one here would break the migration that declares it.
  const recorded = await ledgerExists(db)
    ? await db.all<{ id: string; checksum: string }>(`SELECT id, checksum FROM schema_migrations`)
    : [];
  const byId = new Map(recorded.map((r) => [r.id, r.checksum]));

  const applied: string[] = [];
  const pending: string[] = [];
  const drifted: MigrationStatus['drifted'] = [];

  for (const m of onDisk) {
    const seen = byId.get(m.id);
    if (seen === undefined) { pending.push(m.id); continue; }
    if (seen !== m.checksum) { drifted.push({ id: m.id, recorded: seen, actual: m.checksum }); continue; }
    applied.push(m.id);
  }
  return { applied, pending, drifted };
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

  if (status.drifted.length) {
    throw new MigrationDriftError(
      `${status.drifted.length} migration(s) changed after being applied:\n` +
      status.drifted.map((d) => `  ${d.id}: recorded ${d.recorded}, file is now ${d.actual}`).join('\n') +
      `\nAn applied migration must never be edited. Add a new migration instead — editing ` +
      `one means the database and the repository no longer describe the same schema.`
    );
  }

  const onDisk = loadMigrations(dir);
  const appliedNow: string[] = [];

  for (const m of onDisk) {
    if (!status.pending.includes(m.id)) continue;
    await db.withTransaction(async (tx) => {
      await tx.exec(m.sql);
      // After the migration, not before: the first one may be what creates the ledger. Inside
      // the transaction, so a migration that applies but cannot be recorded rolls back rather
      // than leaving the database ahead of its ledger.
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
  // An empty migration set is not a current schema, it is a missing one. loadMigrations returns
  // [] for a directory that does not exist, so a deployment that fails to ship db/pg-baseline and
  // db/pg-migrations — a container image copying only api/dist, say — would find nothing pending
  // and boot happily against ANY schema, including an empty database. That is the exact opposite
  // of what this gate exists to do, and it fails silently, which is worse than failing loudly.
  const found = loadMigrations(dir);
  if (found.length === 0) {
    throw new Error(
      'No migrations found in ' + (Array.isArray(dir) ? dir.join(', ') : dir) + '. '
      + 'The schema cannot be verified against an empty migration set, so refusing to serve. '
      + 'Check that db/pg-baseline and db/pg-migrations are present in the deployment.',
    );
  }

  const status = await migrationStatus(db, dir);

  if (status.drifted.length) {
    throw new MigrationDriftError(
      `Schema drift: ${status.drifted.map((d) => d.id).join(', ')} changed after being applied.`
    );
  }
  if (status.pending.length) {
    throw new MigrationPendingError(
      `${status.pending.length} migration(s) have not been applied: ${status.pending.join(', ')}\n` +
      `Run: npm run db:migrate`
    );
  }
}
