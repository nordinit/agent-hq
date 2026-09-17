import type {Db} from '../../db/adapter/types';
import {setupTestDb,teardownTestDb} from '../../db/testDb';
import {seedTelemetryScenario} from './testScenario';
import {createDefinition,saveBinding} from './definitions';
import {queryTelemetry,queryContributors} from './queries';
import {firstPassRecipe,milestoneRecipe} from './recipes';
import type {MetricDefinition} from './contracts';
import type {TelemetryScope} from './access';

let db:Db;
const access={tenantId:1,projectId:null,actor:'family_test'};
const selected={field:'id',op:'eq',value:1001};
beforeEach(async()=>{db=await setupTestDb();await seedTelemetryScenario(db);});
afterEach(async()=>{await teardownTestDb();});
async function bind(definition:MetricDefinition,scope:TelemetryScope){
  const metric=await createDefinition(db,access,'metric',{key:definition.key,name:definition.name,scope:{},definition});
  const saved=await saveBinding(db,access,{family_key:'acceptance',scope,metric_revision_id:metric.latest_revision_id});
  return {metric,binding:saved.binding};
}
async function move(){
  await db.run("UPDATE tasks SET workflow_id=112,project_id=12,status='review' WHERE id=1001");
  await db.run("UPDATE tasks SET status='submitted' WHERE id=1001");
}
const first=(key:string,success:string)=>firstPassRecipe({key,name:key,start:{field:'event.type',op:'eq',value:'task.created'},success:{field:'event.to_status',op:'eq',value:success}});

it('selects a journey family binding from recorded entry context after a project and workflow move',async()=>{
  const approval=await bind(first('approval','approved'),{workflow_id:111});
  const submission=await bind(first('submission','submitted'),{workflow_id:112});
  await move();
  const result=await queryTelemetry(db,access,{family_key:'acceptance',filter:selected}) as any;
  const old=result.results.find((row:any)=>row.binding_id===approval.binding.id),current=result.results.find((row:any)=>row.binding_id===submission.binding.id);
  expect(old).toMatchObject({numerator:1,denominator:1,value:1});
  expect(current.denominator).toBe(0);
  const proof=await queryContributors(db,access,result.query_id,{included:'true',metric_revision_id:approval.metric.latest_revision_id}) as any;
  expect(proof.contributors.filter((row:any)=>row.entity_id===1001)).toHaveLength(1);
  const historicalScope=await queryTelemetry(db,access,{family_key:'acceptance',scope:{project_id:11},filter:selected}) as any;
  expect(historicalScope.results.find((row:any)=>row.binding_id===approval.binding.id).denominator).toBe(1);
  const scoped=await queryTelemetry(db,{...access,projectId:11},{family_key:'acceptance',filter:selected}) as any;
  expect(scoped.results.every((row:any)=>row.sample_count===0)).toBe(true);
});

it('applies event-time overrides without counting later events in a broader historical partition',async()=>{
  const approved=milestoneRecipe({key:'approved_events',name:'Approved',milestone:{field:'event.to_status',op:'eq',value:'approved'}});
  approved.measure={kind:'aggregate',aggregate:'count',where:{field:'event.to_status',op:'eq',value:'approved'}};
  const submitted=milestoneRecipe({key:'submitted_events',name:'Submitted',milestone:{field:'event.to_status',op:'eq',value:'submitted'}});
  submitted.measure={kind:'aggregate',aggregate:'count',where:{field:'event.to_status',op:'eq',value:'submitted'}};
  const fallback=await bind(approved,{}),override=await bind(submitted,{workflow_id:112});
  await move();await db.run("UPDATE tasks SET status='approved' WHERE id=1001");
  const result=await queryTelemetry(db,access,{family_key:'acceptance',filter:selected}) as any;
  expect(result.results.find((row:any)=>row.binding_id===fallback.binding.id).value).toBe(1);
  expect(result.results.find((row:any)=>row.binding_id===override.binding.id).value).toBe(1);
});

it('keeps run inventories on current task context',async()=>{
  const run:MetricDefinition={version:1,key:'runs',name:'Runs',grain:'run',time_basis:'current',missing_policy:'exclude_and_report',measure:{kind:'aggregate',aggregate:'count'}};
  const old=await bind(run,{workflow_id:111}),current=await bind({...run,key:'new_runs'},{workflow_id:112});
  await db.run("UPDATE tasks SET workflow_id=112,project_id=12 WHERE id=1003");
  const result=await queryTelemetry(db,access,{family_key:'acceptance'}) as any;
  expect(result.results.find((row:any)=>row.binding_id===old.binding.id).value).toBe(0);
  expect(result.results.find((row:any)=>row.binding_id===current.binding.id).value).toBe(1);
});
