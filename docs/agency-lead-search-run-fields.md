# Agency recurring search run fields

The approved rollout targets Agency project 99, Lead Generation workflow 114,
recurring series 3, task type `ops`. It preserves the task type, existing outcome
keys (`ready_for_review` and `close`), assignments, and external-action boundaries.

## Definition and instructions

`scripts/agency-lead-search-contract.mjs` contains the exact 23 field definitions,
producer/reviewer instruction block, and conservative CRM mapping. Fields are
optional at task creation. Numeric fields enforce a minimum of zero and whole
numbers. Existing single-lead fields remain separate from batch results.

James must persist CRM metrics, read the run back, copy the structured snapshot to
his active task, and verify task readback before handoff. Casper compares that
snapshot with CRM before closing. Missing evidence uses the existing revision or
blocked paths. A real zero-result run is valid.

Migration 33 adds optional recurring-series scope to the existing gate system.
The 44 required-field gates apply to series 3 only, on its existing handoff and
closure outcomes. `same_run_overlaps` is recorded when known but is not a required
completion field. Other ops tasks and blocked outcomes remain unaffected.

The API validates gate ownership against its workflow and tenant. Series scope is
preserved in CRUD, resolution, dispatch evidence prompts, graphs, traces, and UI
editing. Deleting a series removes its gates rather than making them global.

## Historical backfill

The mapping uses one CRM run with explicit matching Agent HQ task, project, and
workflow identifiers. Conflicting recurrence identifiers, multiple runs, active
or nonterminal tasks, and existing field conflicts are skipped. Only present,
valid values are copied. Missing measurements and ID lists stay empty; no comment
parsing, guessed zeros, sums across retries, or `discovered`/`filtered` inference.
In particular, historical `fresh_candidates_reviewed` is populated only from that
explicit metadata field, not inferred from `searched`.

The task's custom fields are merged and read back; lifecycle and assignment remain
unchanged. CRM is read-only. Existing comments and unrelated fields are preserved.
Each backfill records its source run, source update time, import time, and missing
fields. This updates current task values; it does not recreate historical
journey-entry telemetry snapshots.

## Operational procedure

1. Build/test and deploy the API/UI with migration 33 before configuring gates.
2. Read `list_lead_gen_runs` from the configured Agency CRM MCP server (maximum 200)
   into a protected JSON file. This operation returned 160 runs during preparation,
   so pagination or a direct database export was unnecessary.
3. Save the series task inventory, including current custom fields, in a protected
   JSON file. The initial preview matched 137 tasks uniquely and skipped 8 with
   multiple CRM runs out of 145 closed occurrences.
4. Run `node scripts/apply-agency-lead-search-contract.mjs --config` against the
   intended Agent HQ API to install fields, verify instructions, and enable gates.
5. Run `node scripts/apply-agency-lead-search-contract.mjs --backfill <crm-runs.json> <task-snapshot.json>`.
   The script re-reads every task, skips concurrent changes, saves before snapshots,
   performs field-only writes, and verifies every result.

The scripts print their protected `/private/tmp/agency-lead-search-rollout-*`
backup/report directory. They are explicit operator commands, not startup hooks.
Restore field values/configuration from those snapshots only after checking for
subsequent edits. Re-running the backfill against refreshed task snapshots is
idempotent: already populated records are skipped.
