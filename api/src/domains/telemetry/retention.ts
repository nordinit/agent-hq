import type { Db } from '../../db/adapter/types';

/** One bounded tenant sweep. The worker rotates oldest-swept tenants fairly.
 * Historical evidence and retained query artifacts have independent lifetimes.
 * Canonical hard deletions still purge both immediately via capture triggers.
 */
export async function enforceTelemetryRetention(db:Db,options:{tenantId?:number;batchSize?:number}={}){
  const batchSize=Math.max(1,Math.min(10000,Math.trunc(options.batchSize??1000)||1000));
  return db.withTransaction(async tx=>{
    const tenant=await tx.get<{id:number;days:number}>(`SELECT t.id,COALESCE(s.history_retention_days,90) AS days
      FROM tenants t LEFT JOIN telemetry_settings s ON s.tenant_id=t.id
      LEFT JOIN telemetry_retention_state r ON r.tenant_id=t.id
      ${options.tenantId===undefined?'':'WHERE t.id=?'}
      ORDER BY r.last_swept_at NULLS FIRST,t.id LIMIT 1 FOR UPDATE OF t SKIP LOCKED`,
    ...(options.tenantId===undefined?[]:[options.tenantId]));
    if(!tenant)return {tenant_id:null,observations_deleted:0,outbox_deleted:0,results_deleted:0,retained_from:null};
    const state=await tx.get<{retained_from:Date}>(`INSERT INTO telemetry_retention_state(tenant_id,retained_from)
      VALUES(?,clock_timestamp()-make_interval(days=>?)) ON CONFLICT(tenant_id) DO UPDATE SET
      retained_from=GREATEST(telemetry_retention_state.retained_from,EXCLUDED.retained_from),last_swept_at=clock_timestamp()
      RETURNING retained_from`,tenant.id,tenant.days);
    const roots=await tx.all<{source_key:string}>(`SELECT source_key FROM
      (SELECT source_key FROM telemetry_observations WHERE tenant_id=? AND occurred_at<?::timestamptz
        ORDER BY occurred_at,id LIMIT ? FOR UPDATE SKIP LOCKED) observations UNION SELECT source_key FROM
      (SELECT source_key FROM telemetry_outbox WHERE tenant_id=? AND occurred_at<?::timestamptz
        ORDER BY occurred_at,id LIMIT ? FOR UPDATE SKIP LOCKED) outbox`,
    tenant.id,state!.retained_from,batchSize,tenant.id,state!.retained_from,batchSize);
    const discarded=await tx.value<string[]>(`SELECT telemetry_discarded_ancestry(?,?::text[])`,tenant.id,roots.map(row=>row.source_key));
    const observations=await tx.run(`DELETE FROM telemetry_observations WHERE tenant_id=? AND source_key=ANY(?::text[])`,tenant.id,discarded);
    // Pending old backfill is discarded too; projection never recreates expired
    // evidence. This also bounds the durable retry queue under retention.
    const outbox=await tx.run(`DELETE FROM telemetry_outbox WHERE tenant_id=? AND source_key=ANY(?::text[])`,tenant.id,discarded);
    const results=await tx.run(`DELETE FROM telemetry_query_results WHERE id IN
      (SELECT id FROM telemetry_query_results WHERE tenant_id=? AND expires_at<=clock_timestamp()
        ORDER BY expires_at,id LIMIT ? FOR UPDATE SKIP LOCKED)`,tenant.id,batchSize);
    return {tenant_id:tenant.id,observations_deleted:observations.changes,outbox_deleted:outbox.changes,
      results_deleted:results.changes,retained_from:state!.retained_from};
  });
}
