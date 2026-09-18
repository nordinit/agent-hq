import { setupTestDb, teardownTestDb } from '../../db/testDb';
import type { Db } from '../../db/adapter/types';
import { createTransitionRequirement, updateTransitionRequirement } from './requirements';
import { loadWorkflowTaskTransitionRequirements } from './policy/statuses';
import { requireReleaseGate } from '../../lib/taskRelease';
import { parseFieldSchema } from '../workflow-definitions/config';
import { validateTaskCustomFields } from '../tasks/fields';
import { postTaskOutcome } from '../tasks/release';

let db: Db, tenantId: number, workflowId: number, seriesId: number, taskId: number;
beforeEach(async () => {
  db = await setupTestDb();
  tenantId = Number((await db.run("INSERT INTO tenants (name, slug) VALUES ('Search gates', 'search-gates')")).lastInsertId);
  const projectId = Number((await db.run("INSERT INTO projects (tenant_id, name) VALUES (?, 'Search')", tenantId)).lastInsertId);
  await db.run("INSERT INTO workflow_types (tenant_id, key, name) VALUES (?, 'search_test', 'Search test')", tenantId);
  workflowId = Number((await db.run("INSERT INTO workflows (tenant_id, project_id, name, workflow_type) VALUES (?, ?, 'Search', 'search_test')", tenantId, projectId)).lastInsertId);
  seriesId = Number((await db.run(`INSERT INTO recurring_task_series (tenant_id, project_id, workflow_id, title_template, task_type, story_points, status_on_create, schedule_expression, timezone) VALUES (?, ?, ?, 'Search', 'ops', 1, 'ready', 'every 60m', 'UTC')`, tenantId, projectId, workflowId)).lastInsertId);
  taskId = Number((await db.run(`INSERT INTO tasks (tenant_id, project_id, workflow_id, recurring_series_id, title, task_type, status) VALUES (?, ?, ?, ?, 'Search', 'ops', 'in_progress')`, tenantId, projectId, workflowId, seriesId)).lastInsertId);
  await db.run(`INSERT INTO task_field_schemas (tenant_id, workflow_type_key, task_type, schema_json) VALUES (?, 'search_test', 'ops', ?)`, tenantId, JSON.stringify({fields:[{key:'count',type:'number',minimum:0,integer:true}]}));
});
afterEach(async () => { await teardownTestDb(); });
const input = () => ({tenant_id:tenantId, workflow_id:workflowId, task_type:'ops', outcome:'ready_for_review', field_name:'count', recurring_series_id:seriesId});

test('series gate applies only to matching occurrences; zero passes; normal ops stays ungated', async () => {
  await createTransitionRequirement(db,input());
  const task={id:taskId,status:'in_progress',workflow_id:workflowId,task_type:'ops'};
  expect((await requireReleaseGate(db,{...task,recurring_series_id:seriesId},'ready_for_review','ops')).errors).toHaveLength(1);
  expect((await requireReleaseGate(db,{...task,recurring_series_id:seriesId,custom_fields_json:'{"count":0}'},'ready_for_review','ops')).errors).toEqual([]);
  expect((await requireReleaseGate(db,task,'ready_for_review','ops')).errors).toEqual([]);
  expect(await loadWorkflowTaskTransitionRequirements(db,workflowId,'ready_for_review','ops',seriesId+1)).toEqual([]);
  expect(await loadWorkflowTaskTransitionRequirements(db,workflowId,'blocked','ops',seriesId)).toEqual([]);
});
test('scope survives updates, rejects foreign series/tenant and cannot be attached to a default', async () => {
  const gate=await createTransitionRequirement(db,input()) as {id:number};
  expect(await updateTransitionRequirement(db,{id:gate.id,tenant_id:tenantId,workflow_id:workflowId,message:'updated'})).toMatchObject({recurring_series_id:seriesId,message:'updated'});
  await expect(createTransitionRequirement(db,{...input(),recurring_series_id:seriesId+500})).rejects.toThrow('does not belong');
  await expect(createTransitionRequirement(db,{...input(),workflow_id:undefined,project_id:1,workflow_type:'search_test'})).rejects.toThrow();
  await expect(createTransitionRequirement(db,{...input(),tenant_id:tenantId+100})).rejects.toThrow();
});
test('generic and series-specific gates accumulate without masking each other', async () => {
  await createTransitionRequirement(db,input());
  await createTransitionRequirement(db,{...input(),recurring_series_id:null});
  expect(await loadWorkflowTaskTransitionRequirements(db,workflowId,'ready_for_review','ops',seriesId)).toHaveLength(2);
  expect(await loadWorkflowTaskTransitionRequirements(db,workflowId,'ready_for_review','ops')).toHaveLength(1);
});
test('outcome preview reads task series and refuses missing evidence without changing task', async () => {
  await createTransitionRequirement(db,input());
  const result=await postTaskOutcome(db,taskId,{outcome:'ready_for_review',dry_run:true},'user');
  expect(result).toMatchObject({ok:false,dry_run:true,applied:false});
  expect(await db.get('SELECT status FROM tasks WHERE id = ?',taskId)).toEqual({status:'in_progress'});
});
test('numeric constraints round trip and reject negative, fractional and non-number counts', () => {
  const schema=parseFieldSchema({fields:[{key:'count',type:'number',minimum:0,integer:true}]});
  expect(schema.fields[0]).toMatchObject({minimum:0,integer:true});
  expect(()=>validateTaskCustomFields({},schema)).not.toThrow();
  expect(()=>validateTaskCustomFields({count:0},schema)).not.toThrow();
  for(const count of [-1,0.5,'2',NaN]) expect(()=>validateTaskCustomFields({count},schema)).toThrow();
  expect(()=>parseFieldSchema({fields:[{key:'count',type:'text',minimum:0}]})).toThrow();
});
