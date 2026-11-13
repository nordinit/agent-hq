/**
 * The PostgreSQL schemas that hold Agent HQ's tables (migration 51).
 *
 * Application SQL names tables without a schema, so the search path is what resolves them.
 * public comes first and holds only schema_migrations: the migration runner finds its ledger
 * through current_schema(), and an unqualified CREATE TABLE in a later migration lands in
 * public, where the schema layout test rejects it, instead of in whichever schema is first.
 */
export const APP_SCHEMAS = [
  'core',
  'agents',
  'workflow',
  'tasks',
  'runs',
  'chat',
  'access',
  'telemetry',
] as const;

export type AppSchema = typeof APP_SCHEMAS[number];

export const APP_SEARCH_PATH: readonly string[] = ['public', ...APP_SCHEMAS];

/**
 * Connection startup options for every Agent HQ pool. A database cloned from a template does not
 * inherit ALTER DATABASE settings, and a restore without --create drops them, so pools set the
 * search path themselves. Schemas that do not exist yet are skipped, which keeps a database that
 * predates migration 51 working. libpq splits options on whitespace, hence no spaces.
 */
export const PG_CONNECTION_OPTIONS = `-c search_path=${APP_SEARCH_PATH.join(',')}`;
