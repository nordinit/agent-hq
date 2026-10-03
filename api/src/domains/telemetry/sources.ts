import type { Db } from '../../db/adapter/types';
import { TelemetryError } from './access';

export interface SourceIdentity { source_type: string; source_id: number }
export interface SourceReference extends SourceIdentity { project_id: number | null }
const tables: Record<string, string> = { task: 'tasks', run: 'job_instances', runtime_execution: 'runtime_executions', agent: 'agents', workflow: 'workflows', project: 'projects' };
export function sourceIdentity(kind: string, id: number | string): SourceIdentity | undefined {
  return tables[kind] ? { source_type: tables[kind], source_id: Number(id) } : undefined;
}

/** Capture access dependencies in the same snapshot as the metric's values. */
export async function captureSources(db: Db, tenantId: number, roots: SourceIdentity[]): Promise<SourceReference[]> {
  const sources = await db.all<SourceReference>('SELECT * FROM telemetry_expand_sources(?,?::jsonb)', tenantId, JSON.stringify(roots));
  const identities = new Set(sources.map(source => `${source.source_type}:${source.source_id}`));
  if (roots.some(root => !identities.has(`${root.source_type}:${root.source_id}`))) unavailable();
  return sources.map(source => ({ ...source, source_id: Number(source.source_id), project_id: source.project_id == null ? null : Number(source.project_id) }));
}

function unavailable(): never { throw new TelemetryError('result_unavailable', 'Source access changed. Recalculate this result.', 409); }

export async function verifySources(db: Db, tenantId: number, sources: SourceReference[], projectId: number | null = null): Promise<void> {
  if (projectId != null && sources.some(source => source.project_id !== projectId)) unavailable();
  const changed = await db.value<boolean>(`SELECT EXISTS (
    SELECT 1 FROM jsonb_to_recordset(?::jsonb) AS s(source_type text,source_id bigint,project_id bigint)
    LEFT JOIN telemetry_source_context c ON c.tenant_id=? AND c.source_type=s.source_type AND c.source_id=s.source_id
    WHERE c.source_id IS NULL OR c.project_id IS DISTINCT FROM s.project_id
  )`, JSON.stringify(sources), tenantId);
  if (changed) unavailable();
}

/** Serialize publication with canonical access changes, without locking live work during evaluation. */
export async function publishWithSources<T>(db: Db, tenantId: number, sources: SourceReference[], projectId: number | null, publish: (tx: Db) => Promise<T>): Promise<T> {
  return db.withTransaction(async tx => {
    await tx.get('SELECT pg_advisory_xact_lock_shared(hashtextextended(?,0))', `telemetry-proof:${tenantId}`);
    await verifySources(tx, tenantId, sources, projectId);
    return publish(tx);
  });
}

export async function retainSources(db: Db, tenantId: number, queryId: string, sources: SourceReference[]): Promise<void> {
  await db.run(`INSERT INTO telemetry_query_sources(tenant_id,query_id,source_type,source_id,project_id)
    SELECT ?,?,s.* FROM jsonb_to_recordset(?::jsonb) AS s(source_type text,source_id bigint,project_id bigint)
    ON CONFLICT DO NOTHING`, tenantId, queryId, JSON.stringify(sources));
  await db.run('UPDATE telemetry_query_results SET sources_complete=true,source_count=(SELECT count(*) FROM telemetry_query_sources WHERE query_id=?) WHERE tenant_id=? AND id=?', queryId, tenantId, queryId);
}
