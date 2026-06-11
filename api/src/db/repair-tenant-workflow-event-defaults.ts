/**
 * Remove Dev Environment Lease Manager workflow-event defaults from non-default tenants.
 *
 * Usage:
 *   AGENT_HQ_DB_PATH=/path/to/agent-hq.db \
 *   npx tsx src/db/repair-tenant-workflow-event-defaults.ts
 *
 * This preserves the default tenant/global workflow-event rows and deletes only
 * tenant-scoped rows that match the seeded Dev lease-manager defaults exactly.
 */

import { closeDb, getDb, getDbPath } from './client';
import { initSchema } from './schema';
import { removeDevEnvironmentLeaseManagerWorkflowEventDefaultsForNonDefaultTenants } from '../domains/routing/externalEventMappings';

try {
  initSchema();
  const db = getDb();
  const result = removeDevEnvironmentLeaseManagerWorkflowEventDefaultsForNonDefaultTenants(db);
  console.log(JSON.stringify({
    ok: true,
    db_path: getDbPath(),
    ...result,
  }));
} finally {
  closeDb();
}
