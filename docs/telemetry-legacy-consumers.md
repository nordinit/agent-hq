# Legacy telemetry compatibility and rollout

The configurable workspace uses `/api/v1/telemetry/v2`, canonical field schemas, and versioned measurement definitions. Existing legacy summary tables are retained for their remaining consumers. They are not an input to a guessed business first-pass metric in the new engine.

## Consumer inventory

| Legacy surface | Repository consumers | Release treatment |
|---|---|---|
| Telemetry page and its fixed KPI calculations | `ui/features/telemetry/TelemetryPage.tsx`; page route and sidebar link | Replaced by the configurable workspace. The browser no longer computes first pass/confidence/cycle time from a paginated task list. |
| Singleton `telemetry_schema_config` and `/schema-config` | Retired Telemetry Schema Config editor; no canonical task-schema reader | Both legacy GET and PUT now return 410 with the canonical catalog successor. The old singleton data remains stored and is not promoted into `task_field_schemas`. |
| `task_creation_events` | Legacy overview/review/recommendations; compatibility creation-event POST/PUT; generic administrative table access and agent deletion-reference accounting | Retain as legacy recorded metadata. The new observation engine captures real task creation directly. No automatic reconstruction of legacy confidence/scoping claims. |
| `task_outcome_metrics` | Legacy overview/review/recommendations; compatibility outcome POST/PUT; `lib/reflectionContext.ts`; `domains/tasks/readModel.ts`; `domains/tasks/writeModel.ts` | Retain. Task creation maintains `spawned_defects`, and task reads still expose that counter. Reflection context labels these summaries `legacy_recorded_summary`. Existing first-pass/reroute/cycle summaries are not substituted for configured definitions. |
| `/overview`, `/review`, `/review/:task_id`, `/recommendations` | Compatibility API; no direct current UI/MCP tool consumer after replacement | Preserve response shapes and add deprecation/successor headers. Enforce tenant and credential-project scope for all aggregates and drilldowns, including linked tasks and recommendation source queries. |
| `/sessions`, `/pipeline-health`, `/bottlenecks`, `/failures`, `/routing`, `/templates` | Compatibility API; old Telemetry subpanels replaced | Preserve as labeled compatibility endpoints with tenant/project containment on main queries and subordinate breakdowns. Their fixed business definitions remain legacy definitions. New reports should use catalog-backed recipes instead. |
| `/events`, `/integrity`, `/integrity-events`, `/integrity-events/:id/resolve` | Compatibility event/anomaly API; canonical lifecycle code still writes the source tables | Preserve scoped event inspection. Creation validates the canonical task and linked instance and succeeds only after a real insert. Resolving an event requires an authorized current task in the update predicate. |
| `/failure-taxonomy`, `/integrity-taxonomy` | Static compatibility vocabularies | Retain as static descriptions. These do not define success/rework for a new configurable metric. |
| `task_events`, `task_history` | Task/history inspection, routing traces, lifecycle diagnostics; selected trustworthy backfill adapters | Retain. New task observations come from canonical transactional triggers. Old best-effort logs remain partial historical evidence; duplicate mirrors are not counted as extra attempts. |

The inventory searched endpoint strings and legacy table references across the current API, MCP, and UI source, excluding generated dependencies and audit output. A generic administrative API can still read a retained table under its existing authorization; that is not a new metric definition. No table or column is dropped in this release.

## Containment applied to compatibility routes

The legacy router resolves the same tenant/project access boundary as v2. Scoped credentials cannot widen a report with query parameters or target a task outside their assigned project. Project/workflow parameters are resolved to tenant-owned canonical records before use. Foreign agent references are rejected; related agent/project/workflow names are joined within tenant ownership.

Each compatibility response carries `Deprecation: true` and a successor link to `/api/v1/telemetry/v2/catalog`. The changes contain legacy access and preserve necessary readers; they do not redefine the old business formulas to become the semantic oracle for the new system. In particular, the previously audited duration-query/formula limitations are reasons to configure a new measurement, not to label old outputs equivalent.

## Validation and operational boundary

`api/src/routes/telemetry.legacy-scope.test.ts` covers every legacy report with two tenants and two projects in one tenant, plus cross-project linked-task drilldown, foreign write/resolve attempts, nonexistent-task integrity writes, legacy metadata updates, and singleton-schema retirement. The existing `runtime-tenant-scope.test.ts` remains a compatibility regression.

The task `spawned_defects` writer and reflection reader remain intact. No real user's metric definition was invented, no production schema was migrated, and no production backfill was run as part of implementation testing. Deploy through the normal migration/release process, then configure actual workflow success/rework definitions. Coverage boundaries and partial old history remain visible after deployment.

Rollback should change the UI entry point while preserving validated capture and all tenant/project containment. Do not restore the disconnected singleton editor or unscoped legacy reports. Retained tables allow a later consumer-by-consumer cleanup without coupling deletion to this release.
