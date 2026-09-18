/** Approved run-field contract and conservative CRM -> task mapping. No network side effects. */
export const scope = { project_id: 99, workflow_id: 114, recurring_series_id: 3, task_type: 'ops' };
export const marker = 'AGENT HQ SEARCH RUN FIELDS v1';
export const families = ['automation', 'ai', 'web_apps', 'business_systems', 'integrations'];
export const statuses = ['running', 'completed', 'completed_with_errors', 'failed'];
export const numberSources = {
  raw_search_hits: ['metadata', 'raw_search_hits'],
  fresh_candidates_reviewed: ['metadata', 'fresh_candidates_reviewed'],
  skipped_already_scanned: ['metadata', 'skipped_already_scanned'],
  same_run_overlaps: ['metadata', 'same_run_overlaps'],
  qualified: ['qualified'], upserted: ['upserted'], rejected: ['rejected'], duplicates: ['duplicates'],
  discovery_records_written: ['metadata', 'discovery_records_written'],
  client_identity_unavailable: ['clientIdentityUnavailable'],
  proposals_drafted: ['proposalsDrafted'],
  proposals_refused_unviable: ['metadata', 'proposals_refused_unviable'],
  errors: ['errors'], duration_ms: ['durationMs'],
};
const labels = {
  crm_run_id: 'CRM run ID', run_status: 'Run status', search_family: 'Search family',
  source_queries: 'Search queries', crm_lead_ids: 'CRM lead IDs', crm_proposal_ids: 'CRM proposal IDs',
  external_project_ids: 'External project IDs', run_started_at: 'Run started at', run_completed_at: 'Run completed at',
  raw_search_hits: 'Raw search hits', fresh_candidates_reviewed: 'Fresh candidates reviewed',
  skipped_already_scanned: 'Recently scanned candidates skipped', same_run_overlaps: 'Same-run overlaps',
  qualified: 'Qualified candidates', upserted: 'Leads upserted', rejected: 'Rejected candidates',
  duplicates: 'CRM duplicate candidates', discovery_records_written: 'Discovery records written',
  client_identity_unavailable: 'Client identity unavailable', proposals_drafted: 'Proposals drafted',
  proposals_refused_unviable: 'Proposals refused for viability', errors: 'Run errors', duration_ms: 'Run duration (ms)',
};
const field = (key, type, extra = {}) => ({ key, label: labels[key], type, required: false, ...extra });
export const fields = [
  field('crm_run_id', 'text', { help_text: 'Exact CRM runId; one run per search occurrence.' }),
  field('run_status', 'select', { options: statuses }),
  field('search_family', 'select', { options: families }),
  field('source_queries', 'textarea', { help_text: 'JSON array of exact queries executed; do not store planned queries.' }),
  ...Object.keys(numberSources).map(key => field(key, 'number', { minimum: 0, integer: true,
    help_text: key === 'fresh_candidates_reviewed' ? 'Unique fresh candidates actually reviewed in this occurrence; not raw hits.' : 'Whole nonnegative count for this occurrence. Unknown stays empty; zero means measured zero.' })),
  ...['crm_lead_ids', 'crm_proposal_ids', 'external_project_ids'].map(key => field(key, 'textarea', { help_text: 'JSON array of IDs from this run. [] means a confirmed empty list.' })),
  field('run_started_at', 'text', { help_text: 'ISO timestamp returned by CRM startedAt.' }),
  field('run_completed_at', 'text', { help_text: 'ISO timestamp returned by CRM completedAt.' }),
];
export const gateFields = fields.map(f => f.key).filter(k => k !== 'same_run_overlaps');
export const instructions = `\n\n${marker}
Applies to recurring series #3 search occurrences in Agency project #99 / Lead Generation workflow #114, task_type=ops. A search occurrence is a batch; single-lead fields cannot represent its results. This supplements the search, language, safety, pricing, and proposal rules above.

Producer (James), before ready_for_review:
1. Use one stable CRM run_id for this occurrence and retries. Persist the final snapshot through record_lead_gen_run_metrics, then read it with get_lead_gen_run. Confirm its agent_hq_context task_id/project_id/workflow_id matches THIS task. Preserve recurrence provenance exactly when available; never guess it.
2. Record explicit metadata: search_family; source_queries (queries actually executed); raw_search_hits; fresh_candidates_reviewed; skipped_already_scanned; same_run_overlaps; discovery_records_written; proposals_refused_unviable; crm_lead_ids; proposal_ids; external_project_ids. The metrics argument accepts only its live schema; additional run measurements belong in metadata. For future runs, metrics.searched means unique fresh candidates actually reviewed, metrics.discovered means raw_search_hits, and metrics.filtered means skipped_already_scanned. Do not send extra keys inside metrics.
3. Copy the read-back CRM record into THIS Agent HQ task's custom_fields with agent_hq_update_task while you still own its active run. Send custom_fields only (plus task_id and optional changed_by), preserving unrelated existing fields. Your tasks.write_active_custom_fields grant allows this even without broad project task CRUD permission.
4. Field mapping: crm_run_id=runId; run_status=status; run_started_at=startedAt; run_completed_at=completedAt; qualified=qualified; upserted=upserted; rejected=rejected; duplicates=duplicates; client_identity_unavailable=clientIdentityUnavailable; proposals_drafted=proposalsDrafted; errors=errors; duration_ms=durationMs. Copy the named metadata counts and search_family directly. JSON-stringify source_queries, crm_lead_ids, proposal_ids (to crm_proposal_ids), and external_project_ids for their textarea fields. Map platform freelancer to source_platform=Freelancer (case-sensitive).
5. All counts must be nonnegative integers. Write 0 only for measured zero, and [] only for a confirmed empty list. Do not infer fresh_candidates_reviewed from raw/discovered/filtered counts or fill an unknown with zero. Keep unavailable values empty and report the gap. Record run_metrics as a compact JSON source snapshot and crm_last_sync_reference=runId, crm_last_synced_at=current ISO time, crm_last_sync_status=synced after a verified readback; put an actual sync failure in crm_last_sync_error.
6. Read the Agent HQ task back; compare every required field with CRM. Only then post ready_for_review. CRM success alone and a comment alone are insufficient. If a write fails, correct a clear input error once using the returned schema; stable access/configuration/tool failures use the existing blocked path with exact evidence. Never claim the fields were saved when readback fails.

Reviewer (Casper), before close:
Read this task and its linked CRM run. Check task/project/workflow identity, final run status, counts, timestamps, exact query list, and lead/proposal/project IDs. All required fields must be present, supported by CRM, and equal to it; a zero-result run is valid. Confirm that no approval or marketplace submission occurred on this ops task. Use needs_revision for a correctable missing/mismatched snapshot, or the existing blocked path for a stable defect; do not close successfully while results are missing. Do not guess missing measurements. Review is not permission to approve or submit a proposal.

Historical backfill is an operator action, not a reason to reopen or rerun old tasks. Future runs must write complete explicit metadata. Existing comments remain explanatory evidence, not the metric store.
`;
const read = (o, path) => path.reduce((v,k) => v?.[k], o);
const integer = v => Number.isSafeInteger(v) && v >= 0;
const text = v => typeof v === 'string' && v.trim().length > 0;
const iso = v => text(v) && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
const list = v => Array.isArray(v) && v.every(x => text(x) || integer(x));
export function mapRun(run) {
  const values = {}, missing = [];
  if (!text(run.runId) || !statuses.includes(run.status)) return { values: {}, missing: ['invalid_run'] };
  values.crm_run_id = run.runId; values.run_status = run.status;
  if (run.platform === 'freelancer') values.source_platform = 'Freelancer';
  for (const [key,path] of Object.entries(numberSources)) {
    const value = read(run,path);
    if (integer(value)) values[key] = value; else missing.push(key);
  }
  const m = run.metadata ?? {};
  if (families.includes(m.search_family)) values.search_family = m.search_family; else missing.push('search_family');
  if (Array.isArray(m.source_queries) && m.source_queries.every(text)) values.source_queries = JSON.stringify(m.source_queries); else missing.push('source_queries');
  for (const [key,source] of Object.entries({crm_lead_ids:'crm_lead_ids',crm_proposal_ids:'proposal_ids',external_project_ids:'external_project_ids'})) {
    if (list(m[source])) values[key] = JSON.stringify(m[source]); else missing.push(key);
  }
  for (const [key,source] of Object.entries({run_started_at:'startedAt',run_completed_at:'completedAt'})) {
    if (iso(run[source])) values[key] = run[source]; else missing.push(key);
  }
  return {values,missing};
}
export function planBackfill(task, runs, importedAt) {
  const skip = reason => ({task_id:task.id,status:'skipped',reason});
  if (Number(task.project_id)!==scope.project_id || Number(task.workflow_id)!==scope.workflow_id || Number(task.recurring_series_id)!==scope.recurring_series_id || task.task_type!==scope.task_type) return skip('outside_series');
  if (task.active_instance_id || !['closed','done','cancelled','failed'].includes(task.status)) return skip('task_not_terminal');
  const matches = runs.filter(r => Number(r.metadata?.agent_hq_context?.task_id)===task.id);
  if (matches.length!==1) return skip(matches.length ? 'multiple_crm_runs' : 'no_crm_run');
  const run=matches[0], context=run.metadata.agent_hq_context;
  if (Number(context.project_id)!==scope.project_id || Number(context.workflow_id)!==scope.workflow_id) return skip('crm_scope_mismatch');
  if (run.status==='running') return skip('crm_run_still_running');
  const recurrence=run.metadata.recurrence;
  if (recurrence?.recurring_series_id!=null && Number(recurrence.recurring_series_id)!==scope.recurring_series_id) return skip('crm_series_mismatch');
  if (recurrence?.schedule_run_id!=null && task.schedule_run_id!=null && Number(recurrence.schedule_run_id)!==Number(task.schedule_run_id)) return skip('crm_occurrence_mismatch');
  const {values,missing}=mapRun(run);
  if (!values.crm_run_id) return skip('invalid_crm_run');
  const existing=task.custom_fields??{};
  const empty=v => v===null || v===undefined || v==='';
  if (Object.entries(values).some(([k,v])=>!empty(existing[k]) && existing[k]!==v)) return skip('existing_field_conflict');
  const patch=Object.fromEntries(Object.entries(values).filter(([k])=>empty(existing[k])));
  if (!Object.keys(patch).length) return skip('already_populated');
  const provenance={version:1,source:'crm_lead_gen_runs',mode:'historical_backfill',run_id:run.runId,imported_at:importedAt,source_updated_at:run.updatedAt??null,missing_fields:missing};
  for (const [k,v] of Object.entries({crm_last_sync_reference:run.runId,crm_last_synced_at:importedAt,crm_last_sync_status:missing.length?'partial':'synced',crm_last_sync_result:JSON.stringify(provenance),run_metrics:JSON.stringify({provenance,fields:values})})) if(empty(existing[k])) patch[k]=v;
  return {task_id:task.id,status:'ready',run_id:run.runId,patch,missing_fields:missing};
}
