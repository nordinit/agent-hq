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

// Wrapped in an async function because `module: commonjs` has no top-level await, and every
// step here needs one. Unawaited, this script did three wrong things at once: it queried before
// initSchema() had created anything, it spread a *Promise* into the output — so `...result`
// contributed no keys and the report always claimed success while omitting deleted/tenants —
// and the finally closed the database before the DELETE had run at all.
async function main(): Promise<void> {
  await initSchema();
  const db = getDb();
  const result = await removeDevEnvironmentLeaseManagerWorkflowEventDefaultsForNonDefaultTenants(db);
  console.log(JSON.stringify({
    ok: true,
    db_path: getDbPath(),
    ...result,
  }));
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });
