/** Disposable PostgreSQL benchmark; never opens the application's configured DB.
 * Run from api/: AGENT_HQ_TEST_PG_URL=postgresql://localhost/postgres
 *   node --import tsx src/tooling/benchmarkTelemetry.ts
 */
import {performance} from 'perf_hooks';
import os from 'os';
import fs from 'fs';
import path from 'path';
import type {Db} from '../db/adapter/types';
import {setupTestDb} from '../db/testDb';
import {dropWorkerDatabase} from '../db/pg/testFixture';
import {drainTelemetryOutbox} from '../domains/telemetry/capture';
import {queryTelemetry,queryContributors} from '../domains/telemetry/queries';
import {getTelemetryCatalog} from '../domains/telemetry/catalog';
import {numericRecipe,firstPassRecipe,durationRecipe} from '../domains/telemetry/recipes';

const access={tenantId:1,projectId:null,actor:'disposable_benchmark'},scope={project_id:1};
const counts=(process.env.TELEMETRY_BENCH_COUNTS??'1000,10000').split(',').map(Number);
const repeats=Number(process.env.TELEMETRY_BENCH_REPEATS??10);
if(counts.some(n=>!Number.isSafeInteger(n)||n<1||n>10000)||!Number.isInteger(repeats)||repeats<3||repeats>30)throw new Error('Invalid bounded benchmark workload');
const pct=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
const rounded=(n:number)=>Math.round(n*100)/100;
type Trace={sql:string;params:unknown[];ms:number};
function traceDb(db:Db,traces:Trace[]):Db{
  return new Proxy(db,{get(target,key){
    if(key==='withTransaction')return (fn:(tx:Db)=>unknown)=>target.withTransaction(tx=>Promise.resolve(fn(traceDb(tx,traces))));
    const original=Reflect.get(target,key,target);
    if(['all','get','run','value','exec'].includes(String(key)))return async(sql:string,...params:unknown[])=>{
      const start=performance.now();try{return await original.apply(target,[sql,...params]);}
      finally{traces.push({sql,params,ms:performance.now()-start});}
    };
    return typeof original==='function'?original.bind(target):original;
  }});
}
async function seed(db:Db,count:number){
  await db.run(`INSERT INTO tenants(id,name,slug) VALUES(1,'Benchmark','telemetry-benchmark')`);
  await db.run(`INSERT INTO projects(id,tenant_id,name) VALUES(1,1,'Benchmark')`);
  await db.run(`INSERT INTO sprint_types(tenant_id,key,name) VALUES(1,'benchmark','Benchmark')`);
  await db.run(`INSERT INTO sprints(id,tenant_id,project_id,name,sprint_type) VALUES(1,1,1,'Benchmark','benchmark')`);
  await db.run(`INSERT INTO task_field_schemas(tenant_id,sprint_type_key,schema_json)
    VALUES(1,'benchmark','{"fields":[{"key":"amount","label":"Amount","type":"number"}]}')`);
  await db.run(`INSERT INTO agents(id,tenant_id,project_id,name,session_key,model)
    SELECT n,1,1,'Agent '||n,'benchmark-'||n,'benchmark' FROM generate_series(1,10) n`);
  const start=performance.now();
  await db.run(`INSERT INTO tasks(tenant_id,title,sprint_id,project_id,status,task_type,assigned_agent_id,custom_fields_json)
    SELECT 1,'Task '||n,1,1,'draft','benchmark',(n%10)+1,jsonb_build_object('amount',(n%100)+1)::text FROM generate_series(1,?) n`,count);
  await db.run(`UPDATE tasks SET status='in_progress' WHERE tenant_id=1`);
  await db.run(`UPDATE tasks SET status='submitted' WHERE tenant_id=1`);
  await db.run(`UPDATE tasks SET status=CASE WHEN id%5=0 THEN 'needs_changes' ELSE 'review' END WHERE tenant_id=1`);
  await db.run(`UPDATE tasks SET status=CASE WHEN id%10=0 THEN 'rejected' ELSE 'approved' END WHERE tenant_id=1`);
  const captureMs=performance.now()-start;
  // Synthetic history with five real producer snapshots per task and a known
  // observation boundary, so timing benchmarks also verify nonempty results.
  await db.run(`WITH ranked AS (SELECT id,task_id,row_number() OVER(PARTITION BY task_id ORDER BY id)-1 AS step
    FROM telemetry_outbox WHERE source='tasks') UPDATE telemetry_outbox o SET occurred_at=
    clock_timestamp()-interval '1 day'+r.step*(60+r.task_id%90)*interval '1 second' FROM ranked r WHERE r.id=o.id`);
  const pending=Number(await db.value('SELECT count(*) FROM telemetry_outbox WHERE processed_at IS NULL'));
  const lag=await db.value('SELECT EXTRACT(EPOCH FROM clock_timestamp()-MIN(recorded_at)) FROM telemetry_outbox WHERE processed_at IS NULL');
  const projectionStart=performance.now();let processed=0;
  while(true){const batch=await drainTelemetryOutbox(db,{batchSize:1000});processed+=batch.processed;if(!batch.pending)break;if(batch.failed)throw new Error('Projection failed');}
  const projectionMs=performance.now()-projectionStart;
  await db.run(`UPDATE telemetry_capture_sources SET capture_started_at=clock_timestamp()-interval '2 days'`);
  await db.exec('ANALYZE tasks');await db.exec('ANALYZE telemetry_observations');await db.exec('ANALYZE telemetry_outbox');
  return {capture_ms:rounded(captureMs),pending_before:pending,oldest_pending_seconds_before:Number(lag),processed,
    projection_ms:rounded(projectionMs),projection_per_second:rounded(processed/(projectionMs/1000)),pending_after:0};
}
async function workload(count:number){
  const db=await setupTestDb();const worker=await seed(db,count);
  const catalog=await getTelemetryCatalog(db,access,scope),amount=catalog.fields.find(f=>f.key==='amount');
  if(!amount)throw new Error('Amount field missing');
  const start={field:'event.type',op:'eq' as const,value:'task.created'};
  const success={field:'event.to_status',op:'eq' as const,value:'approved'};
  const first=firstPassRecipe({key:'first_pass',name:'First pass',start,success,rework:{field:'event.to_status',op:'eq',value:'needs_changes'},unsuccessful:{field:'event.to_status',op:'eq',value:'rejected'}});
  first.group_by=[{field:'assigned_agent_id',basis:'at_entry'}];
  const duration=durationRecipe({key:'duration',name:'Duration distribution',start,end:{field:'event.to_status',op:'in',value:['approved','rejected']},aggregate:'distribution'});
  if(duration.measure.kind==='aggregate')duration.measure.buckets=[300000,450000,600000];
  const definitions={current_sum:numericRecipe({key:'amount',name:'Amount',field:amount.id}),first_pass_grouped:first,duration_distribution:duration};
  const metrics:Record<string,unknown>={};const plans:Record<string,unknown>={};let proofId='';
  for(const [name,definition] of Object.entries(definitions)){
    const traces:Trace[]=[];let result:any;
    for(let warm=0;warm<2;warm++)await queryTelemetry(db,access,{definition,scope});
    const times=[];
    for(let i=0;i<repeats;i++){
      const begin=performance.now();result=await queryTelemetry(i===0?traceDb(db,traces):db,access,{definition,scope});times.push(performance.now()-begin);
    }
    proofId=result.query_id;
    if(result.quality!=='complete'||result.sample_count!==count)throw new Error(`${name} produced incomplete/empty benchmark: ${JSON.stringify(result.coverage)}`);
    metrics[name]={p50_ms:rounded(pct(times,.5)),p95_ms:rounded(pct(times,.95)),min_ms:rounded(Math.min(...times)),max_ms:rounded(Math.max(...times)),samples:repeats,
      value:result.value,numerator:result.numerator,denominator:result.denominator,sample_count:result.sample_count,groups:result.groups.length,distribution:result.distribution};
    const slow=traces.filter(t=>/^\s*SELECT/i.test(t.sql)).sort((a,b)=>b.ms-a.ms).slice(0,3);
    plans[name]=await Promise.all(slow.map(async trace=>({sql:trace.sql,measured_ms:rounded(trace.ms),plan:await db.all('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+trace.sql,...trace.params)})));
  }
  const paging=[];let page:any;
  for(let i=0;i<repeats;i++){const begin=performance.now();page=await queryContributors(db,access,proofId,{offset:Math.max(0,count-200),limit:200});paging.push(performance.now()-begin);}
  if(page.total!==count)throw new Error('Contributor proof count mismatch');
  metrics.contributor_page={p50_ms:rounded(pct(paging,.5)),p95_ms:rounded(pct(paging,.95)),samples:repeats,total:page.total,page_size:page.contributors.length};
  const storage=await db.all(`SELECT relname,pg_total_relation_size(relid) AS total_bytes,n_live_tup AS estimated_rows FROM pg_stat_user_tables
    WHERE relname IN ('tasks','telemetry_outbox','telemetry_observations','telemetry_query_results') ORDER BY relname`);
  const counts=await db.get(`SELECT (SELECT count(*) FROM tasks) AS tasks,(SELECT count(*) FROM telemetry_observations) AS observations,
    (SELECT count(*) FROM telemetry_query_results) AS query_results`);
  const result={count,counts,worker,metrics,storage,plans,rss_bytes:process.memoryUsage().rss};
  process.stdout.write(JSON.stringify({count,counts,worker,metrics,storage,rss_bytes:result.rss_bytes})+'\n');
  return result;
}
export async function runTelemetryBenchmark(){
  if(!process.env.AGENT_HQ_TEST_PG_URL)throw new Error('Explicit disposable PostgreSQL fixture URL required');
  const db=await setupTestDb();
  const environment={measured_at:new Date().toISOString(),platform:os.platform(),release:os.release(),arch:os.arch(),cpu:os.cpus()[0]?.model,cpu_threads:os.cpus().length,total_memory_bytes:os.totalmem(),node:process.version,
    postgres:await db.value('SELECT version()'),settings:await db.all(`SELECT name,setting,unit FROM pg_settings WHERE name IN ('shared_buffers','work_mem','max_connections','fsync','synchronous_commit') ORDER BY name`)};
  const destination=path.resolve(process.cwd(),'../docs/telemetry-performance-results.json');
  const results=[];
  for(const count of counts){
    try{results.push(await workload(count));}
    catch(error){
      results.push({count,error:error instanceof Error?error.message:String(error)});
      fs.writeFileSync(destination,JSON.stringify({environment,repeats,warmups:2,results},null,2)+'\n');
      throw error;
    }
    fs.writeFileSync(destination,JSON.stringify({environment,repeats,warmups:2,results},null,2)+'\n');
  }
  process.stdout.write(`Results: ${destination}\n`);
}
if(require.main===module)runTelemetryBenchmark().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>dropWorkerDatabase());
