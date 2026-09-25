import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availableTelemetryDisplays, sortedTelemetryGroups, telemetryDimensionLabel, telemetryGroupLabel, telemetryTimeSeries, telemetryWidgetQuery } from './telemetryViews.ts';
import { buildTelemetryDefinition, newTelemetryGuide, telemetryGuideFromDefinition } from './telemetryBuilder.ts';
import { telemetryGuideSelectionIssue } from './telemetryBuilderOptions.ts';
import { metricAttributionIssues } from './telemetry-contracts/requirements.ts';
import type { GroupResult, TelemetryCatalog, TelemetryWidget } from './telemetryTypes.ts';
const catalog:TelemetryCatalog={fields:[],statuses:[],outcomes:[],projects:[],workflows:[],workflow_types:[],task_types:[],agents:[{id:1,name:'Vega'}],recipes:[],core_metrics:[]};
const count=buildTelemetryDefinition(newTelemetryGuide());
const group=(key:GroupResult['key'],value:GroupResult['value']):GroupResult=>({key,value,sample_count:1});

test('entry attribution cannot silently use a current snapshot, and legacy definitions can be repaired losslessly',()=>{
  const invalid={...count,attribution:'assigned_agent_at_entry' as const};
  assert.match(metricAttributionIssues(invalid)[0].message,/defined entry/);
  const reopened=telemetryGuideFromDefinition(invalid)!;
  assert.ok(reopened);assert.equal(reopened.recipe,'count');
  assert.match(telemetryGuideSelectionIssue(reopened,catalog)!,/journey/);
  assert.deepEqual(buildTelemetryDefinition(reopened),invalid);
});
test('journey count defines entry and success explicitly and survives guided reopening',()=>{
  const guide={...newTelemetryGuide(),recipe:'journey_count' as const,attribution:'assigned_agent_at_entry' as const,success:'event:task.finished',denominator:'all_started' as const};
  const definition=buildTelemetryDefinition(guide);
  assert.equal(definition.grain,'journey');assert.equal(definition.journey?.denominator,'all_started');
  assert.deepEqual(metricAttributionIssues(definition),[]);
  assert.deepEqual(buildTelemetryDefinition(telemetryGuideFromDefinition(definition)!),definition);
  assert.match(telemetryGuideSelectionIssue({...guide,start:''},catalog)!,/starts/);
});
test('single-agent and unknown group labels are explicit and never raw IDs',()=>{
  assert.equal(telemetryGroupLabel([1],{...count,group_by:[{field:'agent_id'}]},catalog),'Vega');
  assert.equal(telemetryDimensionLabel(null,'agent_id',catalog),'Unknown agent');
  assert.equal(telemetryDimensionLabel(99,'agent_id',catalog),'Agent #99');
});
test('sorting preserves exact ratios and distinguishes missing values from zero',()=>{
  const groups=[group([1],null),group([2],-3),group([3],0),group([4],{decimal:'0.1234567890123456789'})];
  const sorted=sortedTelemetryGroups(groups,'value_desc',item=>String(item.key));
  assert.deepEqual(sorted.map(item=>item.key[0]),[4,3,2,1]);assert.deepEqual(sorted[0].value,groups[3].value);
});
test('time series are chronological, separate agents, and retain missing buckets as gaps',()=>{
  const {times,series}=telemetryTimeSeries([group(['2026-09-03',1],3),group(['2026-09-01',1],1),group(['2026-09-02',2],2)]);
  assert.deepEqual(times,['2026-09-01','2026-09-02','2026-09-03']);
  assert.equal(series.length,2);assert.equal(series[0].groups[1],undefined);assert.equal(series[1].groups[0],undefined);
  assert.ok(!availableTelemetryDisplays(count).some(display=>display.value==='line'));
});
test('widgets retain pins, intersect scope, and do not turn snapshot counts into historical charts',()=>{
  const widget:TelemetryWidget={id:'one',metric_revision_id:'pinned',view:{group_by:[{field:'agent_id'}],scope:{project_id:11},from:'2026-09-01T00:00:00Z'}};
  const query=telemetryWidgetQuery(widget,count,{}, {from:'2026-08-01T00:00:00Z'});
  assert.equal(query.metric_revision_id,'pinned');assert.equal(query.from,undefined);assert.equal(query.scope?.project_id,11);
  assert.throws(()=>telemetryWidgetQuery(widget,count,{project_id:12}),/conflicts/);
  assert.equal(telemetryWidgetQuery({...widget,view:{scope:{include_archived:true}}},count,{include_archived:false}).scope?.include_archived,false);
  assert.equal(telemetryWidgetQuery({...widget,view:{timezone:'America/New_York'}},count,{}, {timezone:'UTC'}).timezone,'America/New_York');
});
