import '../config/loadRootEnv';
import { closeDb, getDb } from './client';
import { ensureConfiguredRuntimeMcpApiKey } from '../lib/mcpApiAuth';
import { ensureCanonicalAtlasSessionKey } from '../lib/atlasAgent';
import { repairTenantOwnershipForMigration } from '../lib/tenantContext';
import { bootstrapRoutingAndWorkflowDefaults } from './bootstrapDefaults';
import { migrationStatus, runMigrations } from './pg/migrationRunner';
import { POSTGRES_MIGRATION_DIRS } from './pg/migrationDirs';
import type { Db } from './adapter/types';

/**
 * Explicit PostgreSQL schema command.
 *
 * `db:migrate` applies numbered schema migrations only. It never reconciles
 * operator-owned routing, transitions, requirements, or other configuration.
 * `db:install` passes --install and may create starter data only when the
 * database has no tenant at all. Once a tenant exists, later invocations leave
 * configuration untouched.
 */

async function hasAnyTenant(db: Db): Promise<boolean> {
  const row = await db.get<{ present: unknown }>(`SELECT 1 AS present FROM tenants LIMIT 1`);
  return row != null;
}

export async function installInitialConfiguration(db: Db): Promise<{
  installed: boolean;
  runtimeMcpKey?: string;
  atlasIdentity?: unknown;
}> {
  return await db.withTransaction(async (tx) => {
    // Serialize installers so two first boots cannot each create a default tenant.
    await tx.exec('LOCK TABLE tenants IN SHARE ROW EXCLUSIVE MODE');
    if (await hasAnyTenant(tx)) return { installed: false };

    // This is the one explicit installation boundary. Create the tenant first so every
    // subsequently seeded configuration row is tenant-owned; inserting global defaults before
    // the tenant existed left NULL tenant_id rows that the read-only startup verifier rejected.
    await repairTenantOwnershipForMigration(tx);
    await bootstrapRoutingAndWorkflowDefaults(tx);
    const runtimeMcpKey = await ensureConfiguredRuntimeMcpApiKey(tx);
    const atlasIdentity = await ensureCanonicalAtlasSessionKey(tx);
    return {
      installed: true,
      runtimeMcpKey: runtimeMcpKey.status,
      atlasIdentity,
    };
  });
}

async function main(): Promise<void> {
  const db = getDb();
  const installRequested = process.argv.includes('--install');
  const before = await migrationStatus(db, POSTGRES_MIGRATION_DIRS);

  if (before.drifted.length > 0 || before.unexpected.length > 0) {
    throw new Error(
      `Schema drift: changed=${before.drifted.map((entry) => entry.id).join(',') || 'none'}; `
      + `unexpected=${before.unexpected.map((entry) => entry.id).join(',') || 'none'}. `
      + 'Use the release that owns every applied migration; an applied migration is immutable.',
    );
  }

  const applied = await runMigrations(db, POSTGRES_MIGRATION_DIRS);
  const initialConfiguration = installRequested
    ? await installInitialConfiguration(db)
    : { installed: false };

  const after = await migrationStatus(db, POSTGRES_MIGRATION_DIRS);
  if (after.pending.length > 0 || after.drifted.length > 0 || after.unexpected.length > 0) {
    throw new Error(
      `Migration did not converge: pending=${after.pending.join(',') || 'none'}; `
      + `drifted=${after.drifted.map((entry) => entry.id).join(',') || 'none'}; `
      + `unexpected=${after.unexpected.map((entry) => entry.id).join(',') || 'none'}`,
    );
  }

  console.log(JSON.stringify({
    ok: true,
    engine: 'postgres',
    command: installRequested ? 'install' : 'migrate',
    applied,
    already_applied: before.applied.length,
    initial_configuration: initialConfiguration.installed ? 'installed' : 'unchanged',
    runtime_mcp_api_key: initialConfiguration.runtimeMcpKey,
    atlas_identity: initialConfiguration.atlasIdentity,
  }));
}

if (require.main === module) {
  void main()
    .catch((error) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDb();
    });
}
