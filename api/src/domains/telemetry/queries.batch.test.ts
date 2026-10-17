import type {Db} from '../../db/adapter/types';
import {setupTestDb,teardownTestDb} from '../../db/testDb';
import {seedTelemetryScenario} from './testScenario';
import {createDefinition} from './definitions';
import {queryTelemetry,queryTelemetryBatch,queryContributors} from './queries';
import type {MetricDefinition} from './contracts';

let db:Db;
const access={tenantId:1,projectId:null,actor:'batch_test'};
const count:MetricDefinition={version:1,key:'batch_count',name:'Count',grain:'task',time_basis:'current',missing_policy:'exclude_and_report',measure:{kind:'aggregate',aggregate:'count'}};
beforeEach(async()=>{db=await setupTestDb();await seedTelemetryScenario(db);});
afterEach(async()=>{await teardownTestDb();});
function trace(db:Db,calls:string[]):Db {
  return new Proxy(db,{get(target,property){
    if(property==='withTransaction')return (fn:(tx:Db)=>Promise<unknown>)=>target.withTransaction(tx=>fn(trace(tx,calls)));
    if(property==='all')return (sql:string,...args:unknown[])=>{calls.push(sql);return target.all(sql,...args);};
    const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
  }});
}
it('shares task reads across formulas, keeps distinct filtered results and independent drilldowns',async()=>{
  const metric=await createDefinition(db,access,'metric',{key:count.key,name:count.name,scope:{project_id:11},definition:count});
  const all={metric_revision_id:metric.latest_revision_id,scope:{project_id:11}};
  const one={...all,filter:{field:'id',op:'eq',value:1001}};
  const expected=await queryTelemetry(db,access,all) as any;
  const calls:string[]=[];
  const batch=await queryTelemetryBatch(trace(db,calls),access,{queries:[{binding_id:'all',query:all},{binding_id:'one',query:one}]});
  expect(batch.results.every(item=>!item.error)).toBe(true);
  expect(batch.results[0].response.value).toBe(expected.value);
  expect(batch.results[1].response.value).toBe(1);
  expect(batch.results[0].response.query_id).not.toBe(batch.results[1].response.query_id);
  expect(batch.results[0].response.as_of).toBe(batch.results[1].response.as_of);
  expect(calls.filter(sql=>sql.includes('SELECT t.id,telemetry_task_snapshot'))).toHaveLength(1);
  const proof=await queryContributors(db,access,batch.results[1].response.query_id,{included:'true'});
  expect(proof.contributors.map((item:any)=>item.entity_id)).toEqual([1001]);
});
it('isolates missing metrics and SQL timeouts without poisoning later cards',async()=>{
  const metric=await createDefinition(db,access,'metric',{key:count.key,name:count.name,scope:{},definition:count});
  const wrapper=(current:Db):Db=>new Proxy(current,{get(target,property){
    if(property==='withTransaction')return (fn:(tx:Db)=>Promise<unknown>)=>target.withTransaction(tx=>fn(wrapper(tx)));
    if(property==='all')return async(sql:string,...args:unknown[])=>{
      if(sql.includes('SELECT t.id,telemetry_task_snapshot')&&args.includes(12)){
        await target.exec('SET LOCAL statement_timeout=1');
        await target.value('SELECT pg_sleep(0.02)');
      }
      return target.all(sql,...args);
    };
    const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
  }});
  const batch=await queryTelemetryBatch(wrapper(db),access,{queries:[
    {binding_id:'missing',query:{metric_revision_id:'missing'}},
    {binding_id:'timeout',query:{metric_revision_id:metric.latest_revision_id,scope:{project_id:12}}},
    {binding_id:'ok',query:{metric_revision_id:metric.latest_revision_id,scope:{project_id:11}}},
  ]});
  expect(batch.results[0].error?.code).toBe('unknown_reference');
  expect(batch.results[1].error?.code).toBe('query_limit_exceeded');
  expect(batch.results[2].response.state).toBe('complete');
});
it('does not share or expose data beyond the credential project',async()=>{
  const metric=await createDefinition(db,access,'metric',{key:count.key,name:count.name,scope:{},definition:count});
  const batch=await queryTelemetryBatch(db,{...access,projectId:11},{queries:[
    {binding_id:'allowed',query:{metric_revision_id:metric.latest_revision_id,scope:{project_id:11}}},
    {binding_id:'denied',query:{metric_revision_id:metric.latest_revision_id,scope:{project_id:12}}},
  ]});
  expect(batch.results[0].response.state).toBe('complete');
  expect(batch.results[1].error?.code).toBe('forbidden');
});
