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
 * The baseline is migration 00, so there is exactly one schema authority and one directory to
 * ship in every deployment. The array shape is retained for the migration runner's existing API.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../..');

export const POSTGRES_MIGRATION_DIRS = [
  path.join(REPO_ROOT, 'db/pg-migrations'),
];
