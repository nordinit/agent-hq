import type { GroupResult, MetricDefinition, Scalar, TelemetryCatalog, TelemetryDisplay, TelemetryQuery, TelemetryQueryResponse, TelemetryResult, TelemetryScope, TelemetryView, TelemetryWidget } from './telemetryTypes.ts';

export const telemetryDisplays: {value: TelemetryDisplay; label: string}[] = [
  {value:'card',label:'Number'}, {value:'bar',label:'Horizontal bars'}, {value:'table',label:'Table'},
  {value:'line',label:'Time series'}, {value:'funnel',label:'Funnel'}, {value:'distribution',label:'Distribution'},
];
export function availableTelemetryDisplays(definition?: MetricDefinition) {
  return telemetryDisplays.filter(item => item.value !== 'line' || definition?.time_basis !== 'current')
    .filter(item => item.value !== 'funnel' || definition?.measure.kind === 'funnel')
    .filter(item => item.value !== 'distribution' || definition?.measure.kind === 'aggregate' && definition.measure.aggregate === 'distribution');
}
export function telemetryNumber(value: Scalar | undefined): number | null {
  if(value == null || typeof value === 'boolean') return null;
  const number = Number(typeof value === 'object' ? value.decimal : value);
  return Number.isFinite(number) ? number : null;
}
export function telemetryDimensionLabel(value: Scalar, field: string | undefined, catalog?: TelemetryCatalog | null): string {
  if(value == null) return field?.includes('agent') ? 'Unknown agent' : 'Unknown';
  const raw = typeof value === 'object' ? value.decimal : String(value);
  const choices = field?.includes('agent') ? catalog?.agents : field === 'project_id' ? catalog?.projects : field === 'workflow_id' ? catalog?.workflows : undefined;
  if(choices) return choices.find(item => String(item.id) === raw)?.name ?? `${field?.includes('agent') ? 'Agent' : field === 'project_id' ? 'Project' : 'Workflow'} #${raw}`;
  if(field === 'status') return catalog?.statuses.find(item => item.key === raw)?.label ?? raw;
  if(field === 'workflow_type') return catalog?.workflow_types.find(item => item.key === raw)?.name ?? raw;
  return raw;
}
export function telemetryGroupLabel(key: Scalar[], definition?: MetricDefinition, catalog?: TelemetryCatalog | null) {
  const expressions = definition?.group_by ?? [];
  return key.map((value,index) => {
    if(definition?.bucket && index === 0) return String(value ?? 'Unknown time');
    const expression=expressions[index - (definition?.bucket ? 1 : 0)];
    return telemetryDimensionLabel(value, expression && 'field' in expression ? expression.field : undefined, catalog);
  }).join(' · ') || 'All included records';
}
export function sortedTelemetryGroups(groups: GroupResult[], sort: TelemetryView['sort'], label: (group: GroupResult) => string) {
  return [...groups].sort((a,b) => {
    if(sort === 'label') return label(a).localeCompare(label(b),undefined,{numeric:true});
    const av=telemetryNumber(a.value),bv=telemetryNumber(b.value);
    if(av==null) return bv==null?0:1;
    if(bv==null) return -1;
    return sort === 'value_asc' ? av-bv : bv-av;
  });
}
/** Keep each attribution series separate; never interpolate a missing bucket as zero. */
export function telemetryTimeSeries(groups: GroupResult[]) {
  const times=[...new Set(groups.map(group=>String(group.key[0])))].filter(value=>Number.isFinite(Date.parse(value))).sort((a,b)=>Date.parse(a)-Date.parse(b));
  const series=new Map<string,Map<string,GroupResult>>();
  for(const group of groups){
    const key=JSON.stringify(group.key.slice(1));
    const points=series.get(key)??new Map<string,GroupResult>();
    points.set(String(group.key[0]),group);series.set(key,points);
  }
  return {times,series:[...series].map(([key,points])=>({key,groups:times.map(time=>points.get(time))}))};
}
const SCOPE_FILTERS = {project_id:'project',workflow_id:'workflow',workflow_type:'workflow type',task_type:'task type'} as const;
export type TelemetryScopeConflict = {key: keyof typeof SCOPE_FILTERS; own: string|number; dashboard: string|number};
/**
 * The first filter a metric (or saved view) and a dashboard both set to different values. The
 * server intersects the two, so a dashboard narrowed to one workflow or task type can never show a
 * metric that belongs to another — better to say so before the block is added.
 */
export function telemetryScopeConflict(own: TelemetryScope|undefined, dashboard: TelemetryScope|undefined): TelemetryScopeConflict|null {
  for(const key of Object.keys(SCOPE_FILTERS) as (keyof typeof SCOPE_FILTERS)[]) {
    const a=own?.[key],b=dashboard?.[key];
    if(a!=null&&b!=null&&a!==b) return {key,own:a,dashboard:b};
  }
  return null;
}
/** "workflow Development" when the catalog knows the name, otherwise "workflow 115". */
export function telemetryScopeValueLabel(key: keyof typeof SCOPE_FILTERS, value: string|number, catalog?: TelemetryCatalog|null): string {
  const name=key==='project_id'?catalog?.projects.find(item=>item.id===value)?.name
    :key==='workflow_id'?catalog?.workflows.find(item=>item.id===value)?.name
    :key==='workflow_type'?catalog?.workflow_types.find(item=>item.key===value)?.name
    :catalog?.task_types.find(item=>item.key===value)?.label;
  return `${SCOPE_FILTERS[key]} ${name??value}`;
}
export function telemetryScopeConflictMessage(conflict: TelemetryScopeConflict, catalog?: TelemetryCatalog|null): string {
  return `This metric is limited to ${telemetryScopeValueLabel(conflict.key,conflict.own,catalog)}, but this dashboard only covers ${telemetryScopeValueLabel(conflict.key,conflict.dashboard,catalog)}. Remove the block, or use a dashboard without that filter.`;
}
export function telemetryWidgetQuery(widget: TelemetryWidget, definition: MetricDefinition, scope: TelemetryScope, window: {from?:string;to?:string;timezone?:string} = {}): TelemetryQuery {
  // The server intersects these requested filters with the immutable metric scope.
  const view=widget.view??{};
  const conflict=telemetryScopeConflict(view.scope,scope);
  if(conflict) throw new Error(telemetryScopeConflictMessage(conflict));
  return {metric_revision_id:widget.metric_revision_id,scope:{...scope,...view.scope,include_archived:scope.include_archived===false||view.scope?.include_archived===false?false:view.scope?.include_archived??scope.include_archived},timezone:view.timezone??window.timezone??'UTC',
    group_by:view.group_by??definition.group_by??[],bucket:view.bucket===undefined?definition.bucket??null:view.bucket,filter:view.filter,
    ...(definition.time_basis==='current'?{}:{from:view.from??window.from,to:view.to??window.to})};
}
export function telemetryResponseResults(response: TelemetryQueryResponse): TelemetryResult[] {
  if(response.error) throw new Error(typeof response.error==='string'?response.error:response.error.message??'Calculation failed.');
  return (response.results??(response.coverage?[response as TelemetryResult]:[])).map(result=>({...result,query_id:result.query_id??response.query_id,expires_at:result.expires_at??response.expires_at,as_of:result.as_of??response.as_of!}));
}
