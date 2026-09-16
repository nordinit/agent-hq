import { createHash } from 'crypto';
import type { Db } from '../../db/adapter/types';

/** The complete registry doubles as the producer inventory for coverage checks. */
export const TELEMETRY_CAPTURE_SOURCES = [
  'tasks', 'job_instances', 'runtime_executions', 'task_history',
  'external_task_event_receipts', 'task_relationships', 'task_dependencies',
  'task_field_schemas', 'routing_config_audit_log', 'agents', 'projects', 'sprints',
  'sprint_types', 'sprint_task_routing_rules', 'sprint_task_statuses',
  'sprint_task_transition_requirements', 'sprint_task_transitions', 'sprint_type_outcomes',
  'sprint_type_relationship_types', 'sprint_type_task_statuses', 'sprint_type_task_types',
  'external_event_mappings', 'story_point_model_routing',
  'routing_config', 'routing_transitions', 'task_statuses',
] as const;

export const TELEMETRY_BACKFILL_SOURCES = ['tasks', 'task_events', 'task_history',
  'job_instances', 'runtime_executions', 'routing_config_audit_log'] as const;
export type TelemetryBackfillSource = typeof TELEMETRY_BACKFILL_SOURCES[number];

export interface TelemetryObservationRow {
  id: number;
  tenant_id: number;
  source: string;
  source_key: string;
  entity_type: string;
  entity_id: number;
  task_id: number | null;
  project_id: number | null;
  workflow_id: number | null;
  agent_id: number | null;
  kind: string;
  occurred_at: string | Date;
  recorded_at: string | Date;
  sequence: number;
  causation_id: string | null;
  provenance: string;
  producer_version: number;
  payload: Record<string, unknown>;
}

/**
 * Scope a canonical mutation and its derived events to one cause. The setting is
 * connection/transaction-local, restored for nested callers, and never sent to a
 * different pooled connection. An external receipt's stable identity wins over
 * an inner outcome's identity. This is causation, not a claim that two independent
 * outcomes in a bulk transaction are the same event.
 */
export async function withTelemetryCausation<T>(db: Db, cause: string, fn: (tx: Db) => Promise<T>, context?: {outcomeAgentId?:number}): Promise<T> {
  if(context?.outcomeAgentId!==undefined&&(!Number.isSafeInteger(context.outcomeAgentId)||context.outcomeAgentId<=0))
    throw new Error('Invalid telemetry outcome agent');
  if (!db.inTransaction) return db.withTransaction(tx => withTelemetryCausation(tx, cause, fn, context));
  const previous = await db.value<string | null>(`SELECT current_setting('agent_hq.telemetry_causation_id', true)`);
  const safeCause = previous || `cause:${createHash('sha256').update(cause).digest('hex')}`;
  await db.value(`SELECT set_config('agent_hq.telemetry_causation_id', ?, true)`, safeCause);
  const previousOutcomeAgent=context?.outcomeAgentId===undefined?undefined:
    await db.value<string|null>(`SELECT current_setting('agent_hq.telemetry_outcome_agent_id',true)`);
  if(context?.outcomeAgentId!==undefined){
    await db.value(`SELECT set_config('agent_hq.telemetry_outcome_agent_id',?,true)`,String(context.outcomeAgentId));
  }
  const restore=async()=>{
    await db.value(`SELECT set_config('agent_hq.telemetry_causation_id', ?, true)`, previous || '');
    if(context?.outcomeAgentId!==undefined)await db.value(`SELECT set_config('agent_hq.telemetry_outcome_agent_id',?,true)`,previousOutcomeAgent||'');
  };
  try {
    const result = await fn(db);
    await restore();
    return result;
  } catch (error) {
    // If PostgreSQL aborted the transaction, restoration is impossible and its
    // rollback clears SET LOCAL. Do not replace the actual mutation error.
    try { await restore(); } catch { /* rollback owns cleanup */ }
    throw error;
  }
}

function boundedBatch(value: number | undefined, fallback = 200): number {
  return Math.min(1000, Math.max(1, Math.floor(value ?? fallback)));
}

/**
 * Drain committed pending rows, NOT rows above a maximum ID. A transaction can
 * allocate an earlier identity and commit after a later one has been projected.
 * SKIP LOCKED permits multiple processes; projection and acknowledgement commit
 * together. A crash before commit leaves the row pending and safe to retry.
 */
export async function drainTelemetryOutbox(
  db: Db,
  options: { tenantId?: number; batchSize?: number } = {},
): Promise<{ processed: number; pending: number; failed: number }> {
  const size = boundedBatch(options.batchSize);
  const tenantClause = options.tenantId == null ? '' : 'AND tenant_id = ?';
  const tenantParams = options.tenantId == null ? [] : [options.tenantId];
  let processed = 0;
  let failed = 0;
  // A row savepoint isolates one malformed historical record without losing all
  // other committed observations in this batch.
  await db.withTransaction(async tx => {
    const rows = await tx.all<{ id: number; tenant_id: number; source: string }>(`
      SELECT id, tenant_id, source FROM telemetry_outbox
      WHERE processed_at IS NULL AND (retry_at IS NULL OR retry_at <= clock_timestamp())
      ${tenantClause} ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED`, ...tenantParams, size);
    if(rows.length&&!await tx.value("SELECT 1 FROM telemetry_capture_sources WHERE source='telemetry_signals'"))
      await tx.run(`INSERT INTO telemetry_capture_sources(source,capture_started_at,limitations)
        SELECT 'telemetry_signals',MIN(LEAST(recorded_at,occurred_at)),'Status/outcome identities before this boundary are unknown.'
        FROM telemetry_outbox WHERE jsonb_exists(payload->'after','status_identity') OR jsonb_exists(payload->'after','outcome_identity')
        HAVING count(*)>0 ON CONFLICT(source) DO NOTHING`);
    // Register each producer once per batch. The guarded aggregate is not
    // evaluated for an existing registry, avoiding one history scan per fact.
    for(const source of new Set(rows.map(row=>row.source))){
      if(!await tx.value('SELECT 1 FROM telemetry_capture_sources WHERE source=?',source))
        await tx.run(`INSERT INTO telemetry_capture_sources(source,capture_started_at)
          SELECT source,MIN(recorded_at) FROM telemetry_outbox WHERE source=? GROUP BY source
          ON CONFLICT(source) DO NOTHING`,source);
    }
    const projected=new Map<string,{tenant_id:number;source:string}>();
    async function project(recordTx:Db,ids:number[]){
      await recordTx.run(`INSERT INTO telemetry_observations
        (tenant_id,source,source_key,entity_type,entity_id,task_id,project_id,workflow_id,agent_id,
         kind,occurred_at,recorded_at,sequence,causation_id,provenance,producer_version,payload)
        SELECT tenant_id,source,source_key,entity_type,entity_id,task_id,project_id,workflow_id,agent_id,
          kind,occurred_at,recorded_at,id,causation_id,provenance,producer_version,payload
        FROM telemetry_outbox o WHERE id=ANY(?::bigint[]) AND NOT EXISTS
          (SELECT 1 FROM telemetry_retention_state r WHERE r.tenant_id=o.tenant_id AND o.occurred_at<r.retained_from)
        ON CONFLICT(tenant_id,source_key) DO NOTHING`,ids);
      const expired=await recordTx.all<{tenant_id:number;keys:string[]}>(`SELECT o.tenant_id,
        telemetry_discarded_ancestry(o.tenant_id,array_agg(o.source_key)) AS keys
        FROM telemetry_outbox o JOIN telemetry_retention_state r ON r.tenant_id=o.tenant_id
        WHERE o.id=ANY(?::bigint[]) AND o.occurred_at<r.retained_from GROUP BY o.tenant_id`,ids);
      for(const discarded of expired){
        await recordTx.run('DELETE FROM telemetry_observations WHERE tenant_id=? AND source_key=ANY(?::text[])',discarded.tenant_id,discarded.keys);
        await recordTx.run('DELETE FROM telemetry_outbox WHERE tenant_id=? AND source_key=ANY(?::text[])',discarded.tenant_id,discarded.keys);
      }
      await recordTx.run(`UPDATE telemetry_outbox SET processed_at=clock_timestamp(),last_error=NULL,retry_at=NULL
        WHERE id=ANY(?::bigint[])`,ids);
    }
    let batchSucceeded=false;
    if(rows.length)try{
      await tx.withTransaction(recordTx=>project(recordTx,rows.map(row=>row.id)));
      batchSucceeded=true;processed+=rows.length;
      for(const row of rows)projected.set(`${row.tenant_id}:${row.source}`,row);
    }catch{/* A savepoint permits isolating malformed facts without losing the batch. */}
    if(!batchSucceeded)for (const row of rows) {
      try {
        await tx.withTransaction(recordTx=>project(recordTx,[row.id]));
        projected.set(`${row.tenant_id}:${row.source}`,row);processed++;
      } catch (error) {
        failed++;
        // Never retain DB error text: it can contain the rejected value or SQL.
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'projection_error';
        await tx.run(`UPDATE telemetry_outbox SET attempts = attempts + 1,
          retry_at = clock_timestamp() + LEAST(300,POWER(2,LEAST(attempts,8))) * INTERVAL '1 second',
          last_error = ? WHERE id = ?`, `Projection failed (${code.slice(0,64)}); pending retry.`,row.id);
      }
    }
    for(const row of projected.values())await tx.run(`INSERT INTO telemetry_source_coverage(tenant_id,source,last_projected_at)
      VALUES(?,?,clock_timestamp()) ON CONFLICT(tenant_id,source)
      DO UPDATE SET last_projected_at=EXCLUDED.last_projected_at,last_error=NULL`,row.tenant_id,row.source);
  });
  const pending = Number(await db.value(`SELECT COUNT(*) FROM telemetry_outbox WHERE processed_at IS NULL ${tenantClause}`, ...tenantParams) ?? 0);
  return { processed, pending, failed };
}

export interface TelemetrySourceCoverage {
  source: string;
  instrumented: boolean;
  capture_started_at: string | Date | null;
  retained_from: string | Date | null;
  history_complete: false;
  backfill_cursor: number;
  backfill_complete: boolean;
  last_projected_at: string | Date | null;
  pending: number;
  oldest_pending_at: string | Date | null;
  failed_pending: number;
  max_attempts: number;
  last_error: string | null;
  limitations: string[];
}

/** Caller authorizes the tenant/project scope; the service always reapplies it. */
export async function getTelemetryCoverage(db: Db, tenantId: number, projectIds?: number[]) {
  const scope = projectIds === undefined ? '' : projectIds.length ? `AND project_id IN (${projectIds.map(() => '?').join(',')})` : 'AND FALSE';
  const pending = await db.all<{ source: string; pending: number; oldest_pending_at: string | Date | null;
    failed_pending:number;max_attempts:number;last_error:string|null }>(`
    SELECT source,COUNT(*) AS pending,MIN(recorded_at) AS oldest_pending_at,
      COUNT(*) FILTER(WHERE attempts>0) AS failed_pending,MAX(attempts) AS max_attempts,MAX(last_error) AS last_error
    FROM telemetry_outbox WHERE tenant_id = ? AND processed_at IS NULL ${scope} GROUP BY source`, tenantId,...(projectIds || []));
  const sources = await db.all<{ source: string; capture_started_at: string | Date; limitations: string;
    backfill_cursor: number | null; backfill_complete: boolean | null; last_projected_at: string | Date | null }>(`
    SELECT s.source,s.capture_started_at,s.limitations,c.backfill_cursor,c.backfill_complete,c.last_projected_at
    FROM telemetry_capture_sources s LEFT JOIN telemetry_source_coverage c ON c.source=s.source AND c.tenant_id=?`,tenantId);
  const retainedFrom=await db.value<string|Date>(`SELECT retained_from FROM telemetry_retention_state WHERE tenant_id=?`,tenantId)??null;
  const installed = await db.all<{ source: string }>(`SELECT c.relname AS source FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgname='telemetry_capture' AND t.tgenabled IN ('O','A')`);
  const enabled = new Set(installed.map(row => row.source));
  if(Number(await db.value(`SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN ('O','A')
    AND tgname IN ('telemetry_signal_generation','telemetry_task_status_identity','telemetry_outcome_identity')`))===6)enabled.add('telemetry_signals');
  const coverage: TelemetrySourceCoverage[] = [...TELEMETRY_CAPTURE_SOURCES,'task_events','telemetry_signals'].map(source => {
    const row = sources.find(item => item.source === source);
    const lag = pending.find(item => item.source === source);
    const limitations = [row?.limitations || 'No durable capture boundary has been recorded.'];
    if (!enabled.has(source)) limitations.push('No active durable producer; absence of observations is not proof of absence.');
    if (source === 'task_history') limitations.push('Only accepted lifecycle outcomes are captured; task state is observed directly.');
    if (source === 'job_instances') limitations.push('Usage is cumulative per run; aggregate the latest version, never every update.');
    if (retainedFrom) limitations.push('History before the tenant retention boundary is unavailable. Extending retention cannot restore discarded evidence.');
    return { source,instrumented:enabled.has(source),capture_started_at:row?.capture_started_at || null,
      retained_from:retainedFrom,
      history_complete:false,backfill_cursor:Number(row?.backfill_cursor || 0),backfill_complete:row?.backfill_complete || false,
      last_projected_at:row?.last_projected_at || null,pending:Number(lag?.pending || 0),oldest_pending_at:lag?.oldest_pending_at || null,
      failed_pending:Number(lag?.failed_pending||0),max_attempts:Number(lag?.max_attempts||0),last_error:lag?.last_error||null,limitations };
  });
  return { sources:coverage,pending:coverage.reduce((total,row)=>total+row.pending,0),
    limitations:['Historical task scope and custom field values are unknown unless captured at the event.',
      'Legacy global configuration without a tenant owner is not attributed to a tenant.',
      'Backfill completion means available rows were scanned; it does not make old history complete.'] };
}

function parseObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') { try { return parseObject(JSON.parse(raw)); } catch { /* unknown */ } }
  return {};
}

/**
 * Bounded/resumable scan of source IDs. Historical task events have known state
 * changes but UNKNOWN historical scope/fields. Current rows bootstrap a boundary
 * at backfill time, never at their created_at timestamp. No legacy KPI summaries.
 * This is tenant-wide administrative work; project-scoped callers must not invoke it.
 */
export async function backfillTelemetry(db: Db, options: { tenantId: number; source?: TelemetryBackfillSource; batchSize?: number }) {
  const source = options.source || 'tasks';
  if (!TELEMETRY_BACKFILL_SOURCES.includes(source)) throw new Error('Unsupported telemetry backfill source');
  const size = boundedBatch(options.batchSize);
  return db.withTransaction(async tx => {
    await tx.run(`INSERT INTO telemetry_capture_sources(source) VALUES(?) ON CONFLICT(source) DO NOTHING`,source);
    await tx.run(`INSERT INTO telemetry_source_coverage(tenant_id,source) VALUES(?,?) ON CONFLICT(tenant_id,source) DO NOTHING`,options.tenantId,source);
    const checkpoint = await tx.get<{backfill_cursor:number}>(`SELECT backfill_cursor FROM telemetry_source_coverage WHERE tenant_id=? AND source=? FOR UPDATE`,options.tenantId,source);
    const cursor = Number(checkpoint?.backfill_cursor || 0);
    // source is a closed server-owned allowlist; never an interpolated request table.
    const rows = await tx.all<Record<string,unknown>>(`SELECT * FROM ${source} WHERE tenant_id=? AND id>? ORDER BY id LIMIT ?`,options.tenantId,cursor,size);
    let queued = 0;
    for (const row of rows) {
      const id = Number(row.id);
      const alreadyObserved = await tx.value(`SELECT EXISTS(SELECT 1 FROM telemetry_outbox
        WHERE tenant_id=? AND source=? AND provenance='observed' AND source_key LIKE ?)`,
      options.tenantId,source,`${source}:${id}:%`);
      if (alreadyObserved) continue;
      if (source === 'task_events') {
        // Once the canonical task trigger is active, its transition is the fact;
        // the best-effort task_events mirror must not create a second attempt.
        const afterCapture = await tx.value(`SELECT telemetry_timestamp(?,clock_timestamp()) >= date_trunc('second',capture_started_at)
          FROM telemetry_capture_sources WHERE source='tasks'`,row.created_at);
        if (afterCapture) continue;
      }
      let taskId = source === 'tasks' ? id : row.task_id == null ? null : Number(row.task_id);
      let agentId = row.agent_id == null ? null : Number(row.agent_id);
      if (source === 'runtime_executions') {
        const instance = await tx.get<{task_id:number|null;agent_id:number}>(`SELECT task_id,agent_id FROM job_instances WHERE tenant_id=? AND id=?`,options.tenantId,row.instance_id);
        taskId = instance?.task_id || null; agentId = instance?.agent_id || null;
      }
      const task = taskId == null ? undefined : await tx.get<Record<string,unknown>>(`SELECT * FROM tasks WHERE tenant_id=? AND id=?`,options.tenantId,taskId);
      if (taskId != null && !task) continue;
      const agentProjectId=task==null&&agentId!=null?await tx.value<number>(`SELECT project_id FROM agents WHERE tenant_id=? AND id=?`,options.tenantId,agentId):null;
      let kind: string;
      let payload: Record<string,unknown>;
      let occurredAt: unknown = null;
      let entityType = 'task';
      let entityId = taskId || id;
      let provenance = 'legacy_history';
      if (source === 'tasks') {
        kind = 'task.bootstrap'; provenance = 'bootstrap';
        const after = parseObject(await tx.value(`SELECT telemetry_task_snapshot(to_jsonb(t)) FROM tasks t WHERE tenant_id=? AND id=?`,options.tenantId,id));
        payload = {after,before:{},context:after,history_complete:false};
      } else if (source === 'task_events') {
        kind = 'task.changed'; occurredAt = row.created_at;
        payload = {before:{status:row.from_status},after:{status:row.to_status},changed_fields:['status'],historical_context_known:false,
          legacy_source_id:id,move_type:row.move_type};
      } else if (source === 'task_history') {
        if (row.field !== 'lifecycle_outcome') continue; // task_events owns legacy transition evidence.
        kind = 'task.outcome'; occurredAt = row.created_at;
        payload = {before:{},after:{outcome:row.new_value},historical_context_known:false,legacy_source_id:id};
      } else if (source === 'job_instances') {
        kind = 'run.bootstrap'; entityType='run'; entityId=id; provenance='bootstrap';
        const after = parseObject(await tx.value(`SELECT telemetry_run_snapshot(to_jsonb(j)) FROM job_instances j WHERE tenant_id=? AND id=?`,options.tenantId,id));
        delete after.agent_config_at_observation;
        payload={after,before:{},historical_configuration_known:false};
      } else if (source === 'runtime_executions') {
        kind='runtime.bootstrap';entityType='runtime_execution';entityId=id;provenance='bootstrap';
        const after:Record<string,unknown>={};
        for (const key of ['id','instance_id','runtime_type','driver','backend','state','boundary_version','boundary_fingerprint','started_at','ended_at','created_at']) after[key]=row[key];
        payload={after,before:{},historical_configuration_known:true};
      } else {
        kind='configuration.changed';entityType='configuration';entityId=id;occurredAt=row.created_at;
        // Trusted audit identities/fingerprints, without copying arbitrary text.
        payload={after:{entity_table:row.entity_table,entity_id:row.entity_id,action:row.action,workflow_type:row.workflow_type,
          before_fingerprint:createHash('sha256').update(String(row.before_json)).digest('hex'),
          after_fingerprint:createHash('sha256').update(String(row.after_json)).digest('hex')},before:{}};
      }
      if(provenance==='bootstrap'&&entityType!=='task')payload.context={project_id:task?.project_id??agentProjectId??null,agent_id:agentId,task_id:taskId};
      const result=await tx.run(`INSERT INTO telemetry_outbox(tenant_id,source,source_key,entity_type,entity_id,task_id,project_id,workflow_id,
        agent_id,kind,occurred_at,provenance,payload) VALUES(?,?,?,?,?,?,?,?,?,?,telemetry_timestamp(?,clock_timestamp()),?,?::jsonb)
        ON CONFLICT(tenant_id,source_key) DO NOTHING`,options.tenantId,source,`backfill:${source}:${id}`,entityType,entityId,taskId,
        task?.project_id ?? row.project_id ?? agentProjectId ?? null,task?.sprint_id ?? row.workflow_id ?? null,agentId,kind,occurredAt,provenance,JSON.stringify(payload));
      queued+=result.changes;
    }
    const nextCursor=rows.length ? Number(rows[rows.length-1].id):cursor;
    const complete=rows.length<size;
    await tx.run(`UPDATE telemetry_source_coverage SET backfill_cursor=?,backfill_complete=?,backfill_updated_at=clock_timestamp(),last_error=NULL
      WHERE tenant_id=? AND source=?`,nextCursor,complete,options.tenantId,source);
    return {source,scanned:rows.length,queued,cursor:nextCursor,complete,history_complete:false};
  });
}

/** Administrative purge; caller owns task authorization and canonical deletion. */
export async function purgeTelemetryTask(db:Db,tenantId:number,taskId:number):Promise<void>{
  await db.withTransaction(async tx=>{
    await tx.run(`DELETE FROM telemetry_outbox WHERE tenant_id=? AND task_id=?`,tenantId,taskId);
    await tx.run(`DELETE FROM telemetry_observations WHERE tenant_id=? AND task_id=?`,tenantId,taskId);
    // Frozen proofs can mention several tasks. Invalidate tenant results rather
    // than attempting to retain a partly deleted explanation under its old token.
    if(await tx.value(`SELECT to_regclass('public.telemetry_query_results') IS NOT NULL`)) {
      await tx.run(`DELETE FROM telemetry_query_results WHERE tenant_id=?`,tenantId);
    }
  });
}

/** Bound one scheduler turn while allowing backlog catch-up between polls. The
 * budget is checked between transactions; an in-flight batch commits atomically.
 */
export async function drainTelemetryCaptureBudget(db:Db,options:{batchSize?:number;budgetMs?:number}={}){
  const start=Date.now(),budget=Math.max(1,Math.min(5000,options.budgetMs??500));
  let processed=0,failed=0,pending=0,batches=0;
  do{
    const result=await drainTelemetryOutbox(db,{batchSize:options.batchSize??1000});
    processed+=result.processed;failed+=result.failed;pending=result.pending;batches++;
    if(result.processed===0||result.pending===0)break;
  }while(Date.now()-start<budget);
  return {processed,failed,pending,batches};
}

export function startTelemetryCaptureWorker(db:Db,options:{intervalMs?:number;batchSize?:number;onError?:(error:unknown)=>void}={}):()=>void{
  let stopped=false;let active=false;
  const tick=async()=>{
    if(stopped||active)return;active=true;
    try{await drainTelemetryCaptureBudget(db,{batchSize:options.batchSize});}
    catch(error){options.onError?.(error);}
    finally{active=false;}
  };
  const timer=setInterval(()=>{void tick();},Math.max(100,options.intervalMs??1000));
  timer.unref();void tick();
  return()=>{stopped=true;clearInterval(timer);};
}
