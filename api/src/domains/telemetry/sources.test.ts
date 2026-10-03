import type { Db } from '../../db/adapter/types';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { seedTelemetryScenario } from './testScenario';
import { queryTelemetry, queryContributors, getQueryRecord, runTelemetryQueryJobs } from './queries';
import { captureSources, publishWithSources } from './sources';
import type { MetricDefinition } from './contracts';

let db:Db;
const access={tenantId:1,projectId:null,actor:'source-test'};
const count:MetricDefinition={version:1,key:'count',name:'Count',grain:'task',time_basis:'current',missing_policy:'exclude_and_report',measure:{kind:'aggregate',aggregate:'count'}};
beforeEach(async()=>{db=await setupTestDb();await seedTelemetryScenario(db);});
afterEach(async()=>{await teardownTestDb();});
async function calculate(grain:MetricDefinition['grain']='task',project=11,extra:Partial<MetricDefinition>={}) {
  return queryTelemetry(db,access,{definition:{...count,grain,...extra},scope:{project_id:project}}) as Promise<any>;
}
const proof=(id:string)=>queryContributors(db,access,id,{});

it('keeps every task widget and same-project run proof when a taskless run attaches to a task',async()=>{
  await db.run("INSERT INTO job_instances(id,tenant_id,agent_id,status) VALUES(502,1,101,'running')");
  const task=await calculate(), run=await calculate('run'), other=await calculate('task',12);
  const before=await proof(run.query_id);
  await db.run('UPDATE job_instances SET task_id=1001 WHERE id=502');
  expect(await proof(run.query_id)).toEqual(before);
  expect((await proof(task.query_id)).total).toBe(6);
  expect((await proof(other.query_id)).total).toBe(1);
  await db.run('UPDATE job_instances SET task_id=NULL WHERE id=502');
  expect(await proof(run.query_id)).toEqual(before);
});

it('recalculates agent filters and grouping from definitions while old snapshots stay internally consistent',async()=>{
  const filtered=await calculate('task',11,{population:{field:'agent_id',op:'eq',value:101}});
  const grouped=await calculate('task',11,{group_by:[{field:'agent_id'}]});
  const plain=await calculate();
  const old=await proof(filtered.query_id);
  await db.run('UPDATE tasks SET assigned_agent_id=102 WHERE id=1001');
  expect(await proof(filtered.query_id)).toEqual(old);
  expect((await calculate('task',11,{population:{field:'agent_id',op:'eq',value:101}})).value).toBe(5);
  const fresh=await calculate('task',11,{group_by:[{field:'agent_id'}]});
  expect(fresh.groups).toEqual(expect.arrayContaining([expect.objectContaining({key:[101],value:5}),expect.objectContaining({key:[102],value:1})]));
  expect((await getQueryRecord(db,access,grouped.query_id)).result.value).toBe(6);
  expect((await getQueryRecord(db,access,plain.query_id)).result.value).toBe(6);
});

it('revokes task, run and runtime proofs on a real project move, preserving unrelated results',async()=>{
  const task=await calculate(), run=await calculate('run'), runtime=await calculate('runtime_execution'), other=await calculate('task',12);
  await db.run('UPDATE tasks SET workflow_id=112,project_id=12 WHERE id=1003');
  for(const result of [task,run,runtime]) await expect(proof(result.query_id)).rejects.toMatchObject({code:'not_found'});
  expect((await proof(other.query_id)).total).toBe(1);
});

it('distinguishes a same-project agent reassignment from a taskless run moving projects',async()=>{
  await db.run("INSERT INTO agents(id,tenant_id,project_id,name,session_key) VALUES(103,1,11,'Same project','same')");
  await db.run("INSERT INTO job_instances(id,tenant_id,agent_id,status) VALUES(502,1,101,'running')");
  const task=await calculate(), run=await calculate('run');
  await db.run('UPDATE job_instances SET agent_id=103 WHERE id=502');
  expect((await proof(run.query_id)).total).toBe(2);
  await db.run('UPDATE job_instances SET agent_id=102 WHERE id=502');
  await expect(proof(run.query_id)).rejects.toMatchObject({code:'not_found'});
  expect((await proof(task.query_id)).total).toBe(6);
});

it('hard-deleting an excluded evidence row revokes its calculation but not another project',async()=>{
  const filtered=await calculate('task',11,{population:{field:'id',op:'eq',value:1001}}), other=await calculate('task',12);
  expect((await proof(filtered.query_id)).contributors.some((row:any)=>row.entity_id===1006&&!row.included)).toBe(true);
  await db.run('DELETE FROM tasks WHERE id=1006');
  await expect(proof(filtered.query_id)).rejects.toMatchObject({code:'not_found'});
  expect((await proof(other.query_id)).total).toBe(1);
});

it('deleting a runtime revokes its proof without deleting current task metrics',async()=>{
  const task=await calculate(), runtime=await calculate('runtime_execution');
  await db.run('DELETE FROM runtime_executions WHERE instance_id=501');
  await expect(proof(runtime.query_id)).rejects.toMatchObject({code:'not_found'});
  expect((await proof(task.query_id)).total).toBe(6);
});

it('rechecks canonical source access on reads even if a producer missed invalidation',async()=>{
  const result=await calculate('run');
  await db.exec('ALTER TABLE job_instances DISABLE TRIGGER telemetry_capture');
  try { await db.run('UPDATE job_instances SET task_id=1101 WHERE id=501'); }
  finally { await db.exec('ALTER TABLE job_instances ENABLE TRIGGER telemetry_capture'); }
  await expect(proof(result.query_id)).rejects.toMatchObject({code:'result_unavailable'});
});

it('rejects publication if a source moved or was deleted after evaluation',async()=>{
  const sources=await captureSources(db,1,[{source_type:'tasks',source_id:1001}]);
  await db.run('UPDATE tasks SET project_id=12,workflow_id=112 WHERE id=1001');
  const publish=jest.fn();
  await expect(publishWithSources(db,1,sources,null,publish)).rejects.toMatchObject({code:'result_unavailable'});
  expect(publish).not.toHaveBeenCalled();
});

it('retains source manifests for background work and rejects opaque legacy proofs',async()=>{
  const queued=await queryTelemetry(db,access,{definition:count,scope:{project_id:11},background:true});
  expect(await runTelemetryQueryJobs(db)).toEqual({processed:1});
  expect((await proof(queued.query_id)).total).toBe(6);
  await db.run('UPDATE telemetry_query_results SET sources_complete=false WHERE id=?',queued.query_id);
  await expect(proof(queued.query_id)).rejects.toMatchObject({code:'result_unavailable'});
});
