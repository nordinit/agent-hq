import path from 'path';

/**
 * Where the PostgreSQL migrations live, in prefix order.
 *
 * Its own module, with no imports beyond `path` and no side effects, because both the migrate
 * command and the read-only status command need it. Exporting it from `migrate.ts` looked
 * tidier and was wrong: that file ends in a top-level `void main()`, so importing the constant
 * ran a migration. `db:migrate:status` — a command whose entire purpose is to report without
 * touching anything — applied migrations as a side effect of asking what was applied.
 *
 * The two directories are separate only until Phase 3b folds the baseline into
 * `00-baseline.sql`; see docs/postgres-only-migration-spec.md.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../..');

export const POSTGRES_MIGRATION_DIRS = [
  path.join(REPO_ROOT, 'db/pg-baseline'),
  path.join(REPO_ROOT, 'db/pg-migrations'),
];
