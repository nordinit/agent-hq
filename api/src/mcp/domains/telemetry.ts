import { z } from 'zod';
import type { McpDomainContext } from '../registrar';

const scopeFields = {
  project_id: z.number().int().positive().optional().describe('Project filter. A scoped credential always stays inside its assigned project, including when omitted.'),
  workflow_id: z.number().int().positive().optional().describe('Workflow instance filter.'),
  workflow_type: z.string().min(1).max(128).optional().describe('Canonical workflow type key.'),
  task_type: z.string().min(1).max(128).optional().describe('Canonical task type within the selected workflow/type.'),
  include_archived: z.boolean().optional().describe('Include closed/archived workflow records; defaults to true for historical reporting.'),
};
const scope = z.object(scopeFields).strict();
const expression = z.record(z.string(), z.unknown()).describe('Bounded structured telemetry expression from the catalog. The shared REST validator rejects arbitrary SQL/JavaScript and unknown operators.');
const id = z.string().min(1).max(200);
const queryFields = {
  definition: expression.optional().describe('Draft metric definition; choose exactly one of definition, metric_revision_id, report_revision_id, or family_key.'),
  metric_revision_id: id.optional().describe('Pinned immutable metric revision.'),
  report_revision_id: id.optional().describe('Pinned immutable report revision.'),
  family_key: z.string().min(1).max(128).optional().describe('Resolve this metric family through its scope bindings.'),
  scope: scope.optional(),
  from: z.string().optional().describe('Inclusive ISO timestamp with UTC offset; occurrence/journey metrics only. Current inventory requires an explicit created_at population predicate for a creation cohort.'),
  to: z.string().optional().describe('Exclusive ISO timestamp with UTC offset.'),
  as_of: z.string().optional().describe('Fixed ISO evaluation instant. Historical as_of is unavailable for current-state inventory.'),
  timezone: z.string().optional().describe('IANA timezone for calendar buckets; defaults to UTC.'),
  group_by: z.array(expression).max(3).optional().describe('At most three catalog field/value expressions; applies consistently to the result and contributors.'),
  filter: expression.optional().describe('An additional narrowing predicate; cannot broaden authorized project scope. Task-title regex: {field:"title",op:"matches_regex",value:"^(Lead|Proposal):",flags:"i"}. Patterns use RE2 syntax; flags i/m/s are optional. Put the predicate in definition.population to save it with a metric.'),
  background: z.boolean().optional().describe('Queue bounded background evaluation; inspect status with agent_hq_get_telemetry_query.'),
  profile_revision_id: id.optional().describe('Pinned measurement profile for symbolic signal references.'),
};
const pathId = (value: string): string => encodeURIComponent(value);

export function registerTelemetryTools(ctx: McpDomainContext): void {
  const { api, registerTool, wrap } = ctx;
  const options = (...paths: string[]) => ({ domain: 'telemetry', rest_paths: paths.map(path => `/api/v1/telemetry/v2${path}`) });
  registerTool(['agent_hq_list_telemetry_catalog'], 'List authorized canonical fields, workflow signals, recipes, scope choices, units and historical availability for configurable telemetry. Business success and blockage are configured, never inferred from status labels. Requires telemetry.read.', scopeFields,
    args => wrap(() => api.telemetryGet('/catalog', args))(), options('/catalog'));
  registerTool(['agent_hq_validate_telemetry_definition'], 'Validate a draft metric, canonical field references, scoped profile bindings and bounded formulas without calculating or activating it. Requires telemetry.query.',
    { definition: expression, scope: scope.optional(), profile_revision_id: id.optional() }, args => wrap(() => api.telemetryWrite('POST', '/definitions/validate', args))(), options('/definitions/validate'));
  registerTool(['agent_hq_preview_telemetry_metric'], 'Preview a configured metric using the same evaluator and contributor evidence as the UI. Inspect numerator, denominator, exclusions, unknown history and calculation meaning before saving. Requires telemetry.query.', queryFields,
    args => wrap(() => api.telemetryWrite('POST', '/queries/preview', args))(), options('/queries/preview'));
  registerTool(['agent_hq_query_telemetry_metrics'], 'Calculate a draft, pinned metric/report revision or effective metric family within authorized scope. Returns exact values, coverage, versions, freshness and a retained query ID for consistent contributor inspection. Requires telemetry.query.', queryFields,
    args => wrap(() => api.telemetryWrite('POST', '/queries', args))(), options('/queries'));
  registerTool(['agent_hq_get_telemetry_query'], 'Read a retained telemetry result or queued/running query status. Expired results require recalculation; existing query IDs never bypass current source access. Requires telemetry.read.', { query_id: id },
    ({ query_id }) => wrap(() => api.telemetryGet(`/queries/${pathId(query_id)}`))(), options('/queries/:id'));
  registerTool(['agent_hq_cancel_telemetry_query'], 'Cancel an authorized pending telemetry evaluation. Does not modify tasks or workflow execution. Requires telemetry.query.', { query_id: id },
    ({ query_id }) => wrap(() => api.telemetryWrite('DELETE', `/queries/${pathId(query_id)}`))(), options('/queries/:id'));
  registerTool(['agent_hq_get_telemetry_contributors'], 'Inspect the records and inclusion/exclusion explanations retained for a specific calculation. Contributors use the original pinned values and time boundary while rechecking current access. Requires telemetry.read.',
    { query_id: id, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional(), metric_revision_id: id.optional(), metric_index: z.number().int().min(0).optional(), included: z.boolean().optional() },
    ({ query_id, ...params }) => wrap(() => api.telemetryGet(`/queries/${pathId(query_id)}/contributors`, params))(), options('/queries/:id/contributors'));

  for (const [collection, singular, capability] of [['metrics', 'metric', 'telemetry.manage_metrics'], ['profiles', 'profile', 'telemetry.manage_metrics'], ['reports', 'report', 'telemetry.manage_reports']] as const) {
    registerTool([`agent_hq_list_telemetry_${collection}`], `List saved telemetry ${collection} visible in the selected project/workflow scope, including inherited definitions. Requires telemetry.read.`, scopeFields,
      args => wrap(() => api.telemetryGet(`/${collection}`, args))(), options(`/${collection}`));
    registerTool([`agent_hq_get_telemetry_${singular}`], `Read one telemetry ${singular} and its immutable revisions. Requires telemetry.read.`, { definition_id: id },
      ({ definition_id }) => wrap(() => api.telemetryGet(`/${collection}/${pathId(definition_id)}`))(), options(`/${collection}/:id`));
    registerTool([`agent_hq_save_telemetry_${singular}`], `Save a new named telemetry ${singular} with an immutable initial revision. ${singular === 'profile' ? 'Profile definition is {signals:{name:predicate}}.' : singular === 'report' ? 'Report definition pins metrics as {metrics:[{metric_revision_id,title?,display?}],scope?,timezone?,group_by?}.' : 'Metric definition uses the catalog expression contract; success, rework and denominator remain explicit.'} Requires ${capability}.`,
      { key: z.string().min(1).max(128), name: z.string().min(1).max(200), description: z.string().max(4000).optional(), scope: scope.optional(), definition: expression, ...(singular === 'metric' ? { profile_revision_id: id.optional() } : {}) },
      args => wrap(() => api.telemetryWrite('POST', `/${collection}`, args))(), options(`/${collection}`));
    registerTool([`agent_hq_revise_telemetry_${singular}`], `Create an immutable new revision of a telemetry ${singular}. Supply the current expected revision to prevent lost updates. Existing pinned reports/bindings remain on their selected versions. Requires ${capability}.`,
      { definition_id: id, expected_revision_id: id, definition: expression, name: z.string().min(1).max(200).optional(), description: z.string().max(4000).optional(), ...(singular === 'metric' ? { profile_revision_id: id.optional() } : {}) },
      ({ definition_id, ...body }) => wrap(() => api.telemetryWrite('POST', `/${collection}/${pathId(definition_id)}/revisions`, body))(), options(`/${collection}/:id/revisions`));
    registerTool([`agent_hq_archive_telemetry_${singular}`], `Archive a telemetry ${singular} while preserving revisions referenced by historical calculations. Requires ${capability}.`, { definition_id: id },
      ({ definition_id }) => wrap(() => api.telemetryWrite('DELETE', `/${collection}/${pathId(definition_id)}`))(), options(`/${collection}/:id`));
  }
  registerTool(['agent_hq_list_telemetry_bindings'], 'Inspect inherited and overriding metric-family bindings for a selected scope. A disabled binding explicitly suppresses inheritance. Requires telemetry.read.', scopeFields,
    args => wrap(() => api.telemetryGet('/bindings', args))(), options('/bindings'));
  registerTool(['agent_hq_preview_telemetry_binding'], 'Explain the winning metric binding, its origin, shadowed defaults, and deeper overrides for a selected context. Optionally preview an unsaved override without changing configuration. Requires telemetry.read.',
    {family_key:z.string().min(1).max(128),scope,override:z.object({metric_revision_id:id.nullable().optional(),profile_revision_id:id.nullable().optional(),disabled:z.boolean().optional()}).strict().optional()},
    args=>wrap(()=>api.telemetryWrite('POST','/bindings/preview',args))(),options('/bindings/preview'));
  registerTool(['agent_hq_save_telemetry_binding'], 'Bind a metric revision and optional pinned profile to a project/workflow scope, or explicitly disable inheritance. Supply expected_version when replacing a binding. This does not alter routing configuration. Requires telemetry.manage_metrics.',
    { family_key: z.string().min(1).max(128), scope, metric_revision_id: id.nullable().optional(), profile_revision_id: id.nullable().optional(), disabled: z.boolean().optional(), expected_version: z.number().int().min(0).optional() },
    args => wrap(() => api.telemetryWrite('PUT', '/bindings', args))(), options('/bindings'));
  registerTool(['agent_hq_list_telemetry_snapshots'], 'List retained frozen report snapshots visible in the authorized project. Requires telemetry.read.', { report_id: id.optional() },
    ({ report_id }) => wrap(() => api.telemetryGet(report_id ? `/reports/${pathId(report_id)}/snapshots` : '/snapshots'))(), options('/reports/:id/snapshots', '/snapshots'));
  registerTool(['agent_hq_freeze_telemetry_report'], 'Freeze a completed calculation of a saved report using its pinned definitions and retained contributor evidence. Snapshot expiry follows operator retention settings. Requires telemetry.manage_reports.',
    { report_id: id, query_id: id }, ({ report_id, ...body }) => wrap(() => api.telemetryWrite('POST', `/reports/${pathId(report_id)}/snapshots`, body))(), options('/reports/:id/snapshots'));
  registerTool(['agent_hq_get_telemetry_coverage'], 'Read capture boundaries, historical gaps, pending evidence and backfill status for the selected scope. A healthy worker does not prove missing old history exists. Requires telemetry.read.', scopeFields,
    args => wrap(() => api.telemetryGet('/coverage', args))(), options('/coverage'));
  registerTool(['agent_hq_export_telemetry_definitions'], 'Export selected authorized metrics, profiles and reports with their dependencies for explicit remapping to another workflow/project. Does not export task records. Requires telemetry.export.',
    { scope: scope.optional(), metric_ids: z.array(id).max(100).optional(), report_ids: z.array(id).max(100).optional(), profile_ids: z.array(id).max(100).optional() },
    args => wrap(() => api.telemetryWrite('POST', '/export', args))(), options('/export'));
  registerTool(['agent_hq_import_telemetry_definitions'], 'Import an exported telemetry package into a destination scope with explicit canonical reference mappings. The API revalidates every reference and keeps unresolved definitions from activation. Requires telemetry.manage_metrics and telemetry.manage_reports.',
    { bundle: z.unknown().describe('Previously exported telemetry package.'), scope, reference_map: z.record(z.string(), z.string()).describe('Map source canonical field/status/workflow reference IDs to destination IDs.') },
    args => wrap(() => api.telemetryWrite('POST', '/import', args))(), options('/import'));
}
