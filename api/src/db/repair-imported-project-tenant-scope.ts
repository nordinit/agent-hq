import { closeDb, getDb } from './client';
import type { Db } from './adapter/types';
import { repairImportedProjectTenantScope } from '../lib/projectPortability';

type Args = {
  projectId?: number;
  tenantId?: number;
  all: boolean;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { all: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all') {
      args.all = true;
      continue;
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--project-id') {
      args.projectId = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--tenant-id') {
      args.tenantId = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.projectId != null && !Number.isInteger(args.projectId)) throw new Error('--project-id must be an integer');
  if (args.tenantId != null && !Number.isInteger(args.tenantId)) throw new Error('--tenant-id must be an integer');
  if (!args.all && args.projectId == null) throw new Error('Pass --project-id <id> or --all');
  return args;
}

async function projectRows(db: Db, projectId?: number): Promise<Array<{ id: number; tenant_id: number | null }>> {
  if (projectId != null) {
    return await db.all('SELECT id, tenant_id FROM projects WHERE id = ?', projectId) as Array<{ id: number; tenant_id: number | null }>;
  }
  return await db.all('SELECT id, tenant_id FROM projects WHERE tenant_id IS NOT NULL ORDER BY id') as Array<{ id: number; tenant_id: number | null }>;
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = getDb();
  const rows = await projectRows(db, args.projectId);
  if (!rows.length) throw new Error(args.projectId == null ? 'No tenant-owned projects found' : `Project ${args.projectId} not found`);

  let results: Awaited<ReturnType<typeof repairImportedProjectTenantScope>>[] = [];
  try {
    await db.withTransaction(async (tx) => {
      for (const row of rows) {
        results.push(await repairImportedProjectTenantScope(tx, {
          projectId: row.id,
          tenantId: args.tenantId ?? row.tenant_id ?? undefined,
        }));
      }
      if (args.dryRun) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, dry_run: args.dryRun, repaired: results }, null, 2)}\n`);
}

class DryRunRollback extends Error {}

// Keep the transaction alive until every repair completes, then close the shared pool.
void run()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
