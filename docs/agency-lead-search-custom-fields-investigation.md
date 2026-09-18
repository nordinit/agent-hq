# Solo-voice lead-search custom fields

Investigated 2026-09-17 using production task records, captured dispatch prompts,
run transcripts, and current MCP capability policies. No production task fields,
agent instructions, permissions, or recurring-series configuration were changed.

## Finding

The sampled recurring searches save their results in CRM and task notes, but do
not write Agent HQ custom fields. This is an instruction and field-model gap;
there is no evidence of a rejected custom-field update in the four inspected runs.

| Task | James run | Casper review | Agent HQ field-update calls |
| --- | --- | --- | --- |
| 1612 | 99981976 | 99981979 | None |
| 1607 | 99981969 | 99981973 | None |

Both tasks are `ops` occurrences in Agency project 99, Lead Generation workflow
114, recurring series 3. Their `custom_fields` are empty. Their history contains
lifecycle updates and notes, but no custom-field writes.

The captured James prompt says to update structured fields for assigned **lead**
tasks. These recurring searches are **ops** tasks. The occurrence description
explicitly requires a task-visible run note and `record_lead_gen_run_metrics`
persistence to CRM; it does not require mirroring the results into Agent HQ fields.
Casper verifies CRM evidence and the occurrence note before closing.

For task 1612, the recorded CRM metrics response is successful: 10 candidates
reviewed, 1 qualified/upserted, 9 rejected, 0 proposals drafted, and 0 errors. The
proposal refusal was an expected commercial-viability decision, unrelated to
Agent HQ field persistence. Task 1607 also called CRM metrics persistence and
recorded 10 reviewed, 3 qualified/upserted, 7 rejected, and 1 proposal drafted.
Transcript entries were deduplicated by tool-call ID before checking calls.

## Capability and schema checks

- James has `tasks.write_active_custom_fields`; he can call
  `agent_hq_update_task` with only `custom_fields` while he owns the active run.
- Casper has `tasks.manage_project_tasks`, which permits project-scoped task edits.
- Both Agent HQ MCP assignments have unrestricted tool allowlists.
- The task-update tool accepts `custom_fields`. Its description mentions Project
  task CRUD but omits the narrower active-run permission, which is misleading.
- The resolved task schema has 49 optional fields, mostly describing a single
  opportunity/proposal. `run_metrics` is a textarea; it is not a set of numeric
  search-run metrics. No field is required by that schema.
- Valid Agent HQ select values differ from CRM values in some places:
  `source_platform` accepts `Freelancer`, and `pay_type` accepts `Fixed` or
  `Hourly`. Field updates validate these exact values. No such validation failure
  was observed in the sampled runs because no update was attempted.

## Recommended correction

Define an ops-specific search-run field contract with numeric counts suitable for
telemetry: reviewed, qualified, rejected, duplicate/skipped candidates, discovery
records written, proposals drafted/refused, and errors. Keep search family/query,
CRM run reference, persistence status, and timestamps alongside those counts.
Multiple lead/proposal IDs belong in a run-level list or structured text field;
a batch should not overwrite a single-lead field with an arbitrary candidate.

Update the recurring-series instructions to write supported Agent HQ fields and
read them back **before** posting `ready_for_review`, while James still owns the
active run. Update review instructions to compare those fields with the CRM run.
Use explicit required-field/transition rules for the agreed run evidence, treating
zero as a valid count. CRM remains the source of truth for lead/proposal records.
Historical backfill, if requested, should use authoritative CRM run records, not
unverified inference from prose notes.
