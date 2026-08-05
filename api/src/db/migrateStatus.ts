import '../config/loadRootEnv';
import { closeDb, getDb } from './client';
import { migrationStatus } from './pg/migrationRunner';
import { POSTGRES_MIGRATION_DIRS } from './pg/migrationDirs';

async function main(): Promise<void> {
  const status = await migrationStatus(getDb(), POSTGRES_MIGRATION_DIRS);
  const ok = status.pending.length === 0
    && status.drifted.length === 0
    && status.unexpected.length === 0;
  console.log(JSON.stringify({
    ok,
    engine: 'postgres',
    applied: status.applied,
    pending: status.pending,
    drifted: status.drifted,
    unexpected: status.unexpected,
  }, null, 2));
  if (!ok) process.exitCode = 1;
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
