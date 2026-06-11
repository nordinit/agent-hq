import { closeDb, getDb, getDbPath } from './client';
import { initSchema } from './schema';
import { repairTenantOwnershipForMigration, verifyTenantSchemaForStartup } from '../lib/tenantContext';

function main(): void {
  initSchema({ tenantMode: 'repair' });
  const db = getDb();
  const defaultTenantId = repairTenantOwnershipForMigration(db);
  verifyTenantSchemaForStartup(db);
  console.log(JSON.stringify({
    ok: true,
    db_path: getDbPath(),
    default_tenant_id: defaultTenantId,
  }));
}

try {
  main();
} finally {
  closeDb();
}
