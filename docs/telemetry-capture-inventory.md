# Telemetry observation producers and retention

Implementation: [migration 26](../db/pg-migrations/26-telemetry-capture.sql) and [capture service](../api/src/domains/telemetry/capture.ts). This inventory describes the new measurement evidence, not the legacy quality summaries. No production migration or production backfill was run during implementation.

## Transaction boundary and identity

Every instrumented canonical table has an `AFTER INSERT OR UPDATE OR DELETE` row trigger. A relevant change inserts a bounded observation envelope into `telemetry_outbox` inside the writer's transaction. A failed outbox insert fails the canonical statement. The trigger is below REST/MCP/domain helpers, so direct SQL imports, reconciliation, administrative edits, and future writers use the same capture boundary without relying on a best-effort application log.

An observed source key contains table, canonical row ID, and outbox sequence. A logical update is emitted once; writes that only change excluded runtime secrets or heartbeat metadata do not create extra facts. A transaction that rolls back also rolls back its facts. The sequence provides stable source ordering; independent events with insufficient causal evidence are not assigned an invented business order.

`withTelemetryCausation` sets an identifier on the transaction's actual database connection. Nested semantic outcomes inherit an external receipt's cause. The accepted mutation section of `applyTaskOutcome` groups task changes, semantic outcome history, and run bookkeeping. External event handling marks the receipt processed within the same transaction as its accepted action. Repeated accepted receipt delivery retains the existing receipt deduplication.

The worker drains committed **pending rows**, using `FOR UPDATE SKIP LOCKED`, rather than a maximum-ID checkpoint. Projection and acknowledgement commit together. Duplicate replay uses the unique `(tenant_id, source_key)` constraint. Per-record savepoints isolate projection failures; bounded exponential retries leave failed rows pending. Error state stores a database error code, not SQL text or rejected values.

## Writer inventory

The direct-SQL inventory used `rg` across `api/src`, excluding test files. At implementation time the principal task/run/runtime/schema/dependency pattern found 116 mutation sites across 35 files. This is an aid to regression selection; coverage is guaranteed by the table triggers rather than that count.

| Canonical source | Producer paths and observations | Dimensions, exclusions, and tests |
|---|---|---|
| `tasks` | `domains/tasks/writeModel.ts`, `mutations.ts`, `ownership.ts`; `services/dispatcher.ts`, `eligibility.ts`; `scheduler/reconciler.ts`, `watchdog.ts`; `lib/taskOutcome.ts`, `taskLifecycle.ts`, `taskStop.ts`; run callbacks/handoff/failure; workflow administration. Creation, field/status/owner/type/scope changes, cancellation, import/clone and deletion. | Tenant derived from the canonical task/workflow. Executing `agent_id` and assigned `assigned_agent_id` are separate. Before/after snapshots contain builtin metadata and only fields declared in the effective tenant/workflow/task-type schema. Direct SQL, rollback, capture failure, and scope tests exercise the boundary. |
| `job_instances` | Dispatcher, runtime adapters, reconciler/watchdog, `domains/runs/{runtimeEnd,instanceClose,instanceStop,stopInstanceExecution,lifecycleHandoff,observability,callbacks,tokenBackfill}.ts`, `lib/taskLifecycle.ts`, chat persistence. Run state, runtime-end classification, semantic-handoff state, cumulative usage. | Never copy payloads, responses, transcripts, sessions, error strings or worktree paths. Runtime success and semantic/run failure remain distinct. Usage is cumulative per run: evaluators use the selected/latest version, not the sum of callback updates. |
| `runtime_executions` | `runtimes/runtimeExecutionStore.ts`; drivers and execution reconciler through that store. Preparation/launch/state/end observations. | Runtime/driver/backend, versioned boundary fingerprint, start/end times and instance ID only. No launch spec, opaque handle, environment values, transcript cursor or arbitrary terminal metadata. |
| `task_history` | `domains/tasks/history.ts`, called by accepted outcome handling. | Only `lifecycle_outcome` records create semantic outcome observations. Other task-history fields duplicate authoritative task capture or contain unbounded text. An outcome-to-transition cause is preserved; uncorrelated legacy rows do not prove causation. |
| `external_task_event_receipts` | `routes/external-task-events.ts`. | Observe accepted processing state, event/source, mapping ID/kind/target and receipt fingerprint. Exclude request payload, messages, URLs and environment/lease metadata. Receipt and action now commit together. |
| `task_relationships`, `task_dependencies` | `domains/tasks/relationships.ts`, `writeModel.ts`, `mutations.ts`; cascades from task removal. | Relationship identities and add/remove facts. The dependency table supplies configured prerequisite effects; relationship existence alone is never an implicit blockage definition. Cross-tenant relationships are not combined. |
| Dependency effects | Task status/workflow changes, dependency additions/removals, workflow/type/global terminality edits. | `task.dependencies_changed` snapshots preserve `unresolved_dependencies`. Terminality resolves workflow override → workflow type → global status configuration. Counts from different concurrently completing blockers serialize per dependent. `dependencies_within_project` and `dependencies_within_tenant` allow readers to redact unauthorized/invalid derived information. Unknown previous counts remain null. |
| `task_field_schemas` | `domains/workflow-definitions/router.ts`, starter/default install/import paths. | Effective field descriptors include schema ID and content fingerprint. Old observations retain their descriptors when a field is renamed, removed or changes type. |
| Configuration tables | `workflow_task_{routing_rules,statuses,transition_requirements,transitions}`, `workflow_type_{outcomes,relationship_types,task_statuses,task_types}`, `workflow_types`, `external_event_mappings`, `story_point_model_routing`, `routing_config`, `routing_transitions`, `routing_config_audit_log`, `agents`, `projects`, `workflows`. | Explicit safe configuration keys and audit fingerprints; no arbitrary metadata, credentials or instructions. Agent instructions are represented by fingerprints and version. Execution attribution uses execution-time observations, never current agent configuration from a later callback. |
| Global `task_statuses` | Global status editing and provisioning. | Recompute scoped dependent facts affected by terminality changes. Global configuration is not silently assigned to an arbitrary tenant. |

The task snapshot bounds a declared scalar value to 8 KiB and the normal envelope to 256 KiB. Oversized field values are omitted with `fields_complete: false`; oversized envelopes preserve a small lifecycle fact and mark truncation. Text metadata is bounded. Field absence never becomes a numeric zero.

## Coverage and backfill

`telemetry_capture_sources` records installation boundaries and producer versions. `telemetry_source_coverage` records each tenant's backfill cursor and projection state. The coverage endpoint inspects enabled database triggers as well as pending observations. A healthy worker heartbeat alone does not establish history coverage. Project-restricted coverage counts only authorized pending facts.

The backfill service is a bounded tenant-administrative operation. It scans a closed allowlist of sources, saves its cursor in the same transaction as queued observations, and uses deterministic `backfill:<table>:<id>` keys:

| Adapter | Historical promise |
|---|---|
| Current tasks | Bootstrap current fields at backfill time. Never fabricate `task.created` or claim current fields existed at the original creation time. |
| Old `task_events` | Preserve recorded before/after status and effective timestamp. Historical scope and field context remain unknown. Skip the live interval already covered by canonical task triggers. |
| Outcome `task_history` | Preserve accepted outcome records with unknown historical context. Skip rows already captured live. |
| Current runs/executions | Bootstrap authoritative run/runtime metadata. Strip the current agent's instructions fingerprint from old-run attribution. |
| Routing audit | Preserve safe audit identities and fingerprints of recorded before/after configuration. |

Backfill completion means the available rows were scanned. It **does not** turn older best-effort history into complete history. Legacy first-pass booleans, synthetic confidence, mutable cycle-time summaries, `task_creation_events`, and `task_outcome_metrics` are not reconstructed as authoritative workflow facts. Re-running a completed source can collect later IDs; existing queued keys stay idempotent.

The projection scheduler runs immediately at startup and then once per second, with an overlap guard. Each turn projects batches of up to 1,000 while an elapsed 500 ms budget remains, checked between transactions. It stops on an empty queue or when no pending row is currently retry-eligible. These defaults use the measured projection capacity without an unbounded drain loop; an already-running transaction completes atomically.

## Status and outcome identity

Migration 30 tracks immutable generations for global task statuses, workflow-type statuses, workflow-instance statuses, and task-type/workflow-type outcomes. Labels create new catalog descriptor revisions while preserving identity. Key/scope changes, deletion/recreation, and disabling/re-enabling outcomes retire the old generation. Canonical signal writes and catalog reads share a global advisory lock; readers share that lock across tenants while writers are exclusive. Existing per-tenant field-catalog locks remain separate.

A task retains the status identity assigned at its last status/workflow change. A same-key canonical recreation therefore cannot relabel an unchanged task's current or previous state. Task snapshots expose an unknown identity if the assignment producer is disabled or the stored identity disagrees with the current raw key. Accepted outcomes record their effective identity atomically in the outbox. Same-outcome timestamp corrections preserve the original identity; corrections to another outcome resolve against the recorded context and historical generation interval when that evidence exists.

User-facing definitions retain existing raw status/outcome key selectors. Compilation pins their authorized catalog identities in immutable `dependencies.signals`; explicit opaque signal IDs select one exact source identity. Unconfigured keys use an explicit unregistered marker, preventing an older definition from adopting a later canonical meaning. Profile and component references retain their originating revision's pins. New ad-hoc filters resolve independently against the current catalog. Platform run/workflow state fields are not rewritten as task signal identities.

The virtual `telemetry_signals` coverage source records when identity capture became available and checks all six required generation/assignment/outcome triggers. Older observations without identity evidence remain unknown. Retired signals keep historical descriptors and remain queryable through their saved revisions. Their bindings report `needs_attention`; activation requires an explicit new valid revision, while disabling a binding remains possible. Export/import retains signal descriptors and requires explicit replacement of retired identities.

## Deletion, retention, and rollback

Task hard deletion purges its outbox/observations and frozen query proofs, then retains only a minimal field-free deletion tombstone. Workflow/project deletion purges scoped historical payloads as the canonical task cascades run. Run/execution deletion purges the corresponding execution history. Agent deletion purges agent configuration and execution evidence; surviving tasks retain their own history with historical agent IDs. Tenant deletion cascades through all tenant-owned capture tables. Cached/frozen query results are invalidated rather than returning partially purged explanations under an old result token.

Processed outbox rows support replay while they remain inside the tenant's `history_retention_days` window (default 90 days). The retention worker rotates tenants, selects at most 1,000 expired roots from each fact store per sweep, and atomically discards observations, outbox records, and any superseded ancestors. Ancestor removal can exceed that root count; it prevents a corrected fact from reappearing if a correction moves before the retained window. Late projection also discards expired evidence and its superseded ancestors. No prompts or transcripts are copied to either store.

`telemetry_retention_state.retained_from` advances monotonically. Coverage uses the later of this tenant boundary and the actual producer installation boundary, so extending a retention setting never claims to restore discarded history. Retained query results and frozen report proofs have separate explicit expiry policies (`query_retention_hours` and `snapshot_retention_days`); a history sweep does not silently shorten a frozen artifact's lifetime. Canonical deletion still invalidates both immediately. Agent, workflow, run, and runtime ownership changes invalidate retained tenant proofs, including artifacts with no task IDs. Taskless executions capture their canonical agent project and are included in project/agent/run deletion purges.

Removing source evidence or disabling database triggers is an operational coverage change and must not be presented as uninterrupted history. Disabling the telemetry UI should leave validated capture running. No destructive schema rollback is part of the UI rollback path.

## Validation

`api/src/domains/telemetry/capture.test.ts` exercises direct SQL capture, atomic rollback, enforced capture failure, replay, genuine out-of-order commits, cumulative runtime facts, schema overrides, bounds, cause propagation, history coverage/backfill, project/tenant filtering, deletion, dependency resolution/configuration changes, and concurrent blockers. Relevant task outcome, accepted external-event, runtime-end and semantic-handoff regression suites are also run. All database testing uses disposable PostgreSQL fixtures; it does not migrate or backfill production.
