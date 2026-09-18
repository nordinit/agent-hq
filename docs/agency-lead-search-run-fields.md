# Agency recurring search run fields

Agency project 99, Lead Generation workflow 114, recurring series 3 uses a batch
run contract on its existing `ops` task type. Existing outcomes (`ready_for_review`
and `close`), assignments, and external-action boundaries are preserved.

## Definition and instructions

The production workflow definition contains 23 run fields: CRM run ID and status;
search family and queries; raw hits, reviewed candidates, recent-ledger skips and
same-run overlaps; qualified/upserted/rejected/duplicate counts; discovery records;
client identity unavailable; drafted/refused proposals; errors and duration;
lead/proposal/external project ID lists; and start/completion timestamps.

Fields are optional at task creation. Numeric fields enforce a minimum of zero and
whole numbers. Existing single-lead fields remain separate from batch results.

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

## One-time historical repair

The historical backfill was an operator-run, temporary script outside the product.
It is not part of Agent HQ's runtime or recurring behavior. It filled 137 tasks
from uniquely matched CRM run records and skipped 8 tasks with multiple runs.
Only explicit, valid values were copied. Missing values stayed empty; no comments
were parsed and no retry counts were combined. Existing task lifecycle and
assignment were preserved, and field writes were read back for verification.

Each populated task records the source CRM run and import provenance in its sync
fields. This changes current task values; it does not recreate historical
journey-entry telemetry snapshots.
