import { BUILTIN_FIELDS } from './catalog';
import { evaluateMetric,validateMetricDefinition } from './evaluator';
import { coreRuntimeRecipes } from './recipes';
import type { TelemetryEntity } from './contracts';

const as_of='2026-09-10T12:00:00Z';
const runtime=(id:string,state:unknown):TelemetryEntity=>({id,kind:'runtime_execution',fields:{runtime_state:state}});
const run=(id:string,status:string,runtime_ended_success:boolean):TelemetryEntity=>({id,kind:'run',fields:{status,runtime_ended_success}});
function calculate(key:string,entities:TelemetryEntity[]){
  return evaluateMetric({definition:coreRuntimeRecipes().find(metric=>metric.key===key)!,entities,catalog:BUILTIN_FIELDS,as_of});
}
it('separates failed run state from failed, cancelled and lost runtime execution classifications',()=>{
  const entities=[run('a','failed',true),run('b','done',false),run('c','running',false),
    runtime('a','succeeded'),runtime('b','failed'),runtime('c','cancelled'),runtime('d','lost'),
    {id:'task',kind:'task' as const,fields:{status:'failed',runtime_state:'failed'}}];
  expect(calculate('core.run_state_failures.v1',entities).value).toBe(1);
  expect(calculate('core.runtime_failures.v1',entities).value).toBe(1);
  expect(calculate('core.runtime_cancelled.v1',entities).value).toBe(1);
  expect(calculate('core.runtime_lost.v1',entities).value).toBe(1);
  const rate=calculate('core.runtime_failure_rate.v1',entities);
  expect(rate).toMatchObject({value:0.5,numerator:1,denominator:2});
  expect(rate.contributors.filter(row=>row.included).map(row=>row.entity_id).sort()).toEqual(['a','b']);
});
it('does not infer a lost execution from missing or unfamiliar provider evidence',()=>{
  const result=calculate('core.runtime_lost.v1',[runtime('lost','lost'),runtime('running','running'),runtime('missing',null),runtime('other','unknown')]);
  expect(result.value).toBe(1);expect(result.coverage.unknown).toBe(1);
  expect(result.contributors.find(row=>row.entity_id==='missing')?.included).toBe(false);
});
it('publishes unique platform versions valid for the canonical catalog grains',()=>{
  const recipes=coreRuntimeRecipes();expect(new Set(recipes.map(recipe=>recipe.key)).size).toBe(recipes.length);
  for(const recipe of recipes){expect(recipe.key).toMatch(/^core\..+\.v1$/);expect(validateMetricDefinition(recipe,BUILTIN_FIELDS)).toMatchObject({valid:true});}
});
