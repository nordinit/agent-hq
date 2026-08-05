import { getDb } from './client';
import { verifyMigrationsCurrent } from './pg/migrationRunner';
import { POSTGRES_MIGRATION_DIRS } from './pg/migrationDirs';
import { verifyTenantSchemaForStartup } from '../lib/tenantContext';

/**
 * Non-mutating API boot gate. Schema changes are performed only by the explicit
 * db:install/db:migrate command; an API process refuses pending or drifted SQL.
 */
export async function verifyStartupSchema(): Promise<void> {
  const db = getDb();
  // Keep migration errors first: a database with pending SQL should be told to migrate before
  // tenant-level validation asks it to install configuration. Both checks are strictly read-only.
  await verifyMigrationsCurrent(db, POSTGRES_MIGRATION_DIRS);
  await verifyTenantSchemaForStartup(db);
}
