import { closeDb, getDb, getDbPath } from './client';
import { initSchema } from './schema';
import { repairTenantOwnershipForMigration, verifyTenantSchemaForStartup } from '../lib/tenantContext';

async function main(): Promise<void> {
  await initSchema({ tenantMode: 'repair' });
  const db = getDb();
  const defaultTenantId = await repairTenantOwnershipForMigration(db);
  await verifyTenantSchemaForStartup(db);
  console.log(JSON.stringify({
    ok: true,
    db_path: getDbPath(),
    default_tenant_id: defaultTenantId,
  }));
}

// See migrate.ts: main() is async, so the original try/finally closed the database before the
// repair finished and let rejections pass silently with exit code 0.
void main()
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });
