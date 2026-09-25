**Agent HQ telemetry functionality audit — September 9, 2026**

Telemetry does not currently deliver the configurable statistics system described in the request. The underlying task fields, workflow schemas, run records, and history provide useful building blocks, but the reporting layer is a collection of fixed reports and an independent task dashboard. Several displayed metrics are misleading, collection is incomplete, and important routes have correctness and tenant-isolation defects.

This audit covers checkout `6bfecc2e`, the current PostgreSQL migrations, task/schema integration, telemetry routes, UI, and agent access. It includes isolated execution against a disposable database, a read-only inspection of the local production UI, and read-only checks of the local production/development APIs. No application code or live records were changed. The schema-save UI defect below was established from code; saving live configuration was not attempted.

**Observed live state**

At approximately 22:18–22:22 America/New_York:

| Surface | Observation |
|---|---|
| Production API, port 3501, active tenant | 748 tasks including closed workflows; 1 creation-event record; 5 outcome-metric records; reported first-pass rate 0%; average recorded cycle time null |
| Development API, port 3511, active tenant | 618 tasks including closed workflows; 0 creation-event records; 4 outcome-metric records; reported first-pass rate 0%; average recorded cycle time null |
| Production UI, port 3500, All Projects | 739 tasks; 489 done; “First-Pass Rate” 66.2%; “Agent Coverage” 0.0%, 0 assigned; “Avg Cycle Time” 55.6h |
| Production UI after selecting Done | 489 matching rows, but headline totals and rates remained unchanged |
| Both local APIs with `/telemetry/overview?from=2026-01-01` | HTTP 500 |

These are snapshots of the active tenant, not installation-wide counts. The UI and backend figures use different populations and calculations; neither first-pass figure should be treated as a reliable QA success measurement. The outcome tables cover less than 1% of the task counts observed, and a record's presence alone does not establish that its quality fields were measured.

**What is implemented**

| Capability | Current functionality |
|---|---|
| Custom task fields | Canonical workflow/task-type field schemas, validation, task form rendering, persisted `custom_fields_json`, and custom-field updates are implemented outside telemetry. |
| Task review UI | Project selection, fixed status/priority/agent filters, search, sorting, notes, and a detail drawer. No custom-field report columns or aggregations. |
| Creation/outcome API | Fixed-column creation metadata and outcome records; POST and task-keyed PUT endpoints; overview, joined review, and recommendations. |
| Operational analytics API | Sessions, pipeline health, bottlenecks, failures, integrity, routing, templates, and task events. These reports are not connected to the telemetry page. |
| Schema Config UI | A separate installation-wide JSON configuration with labels, types, visibility, required/default values, and analytics switches. It does not drive canonical task capture or report queries. |
| Agent access | Agents can work with canonical tasks and schemas through existing tools. Routing graph analysis and task-path tracing also exist. There is no telemetry metric/query/report tool family. Ordinary MCP keys cannot directly use telemetry routes without full administrative access. |
| User-defined statistics | No metric definitions, formulas, configurable aggregation/grouping, reusable report queries, saved dashboards, custom-field time series, or telemetry export/scheduling implementation was found. |

Canonical field resolution is in [fields.ts](/Users/nordini/agent-hq/api/src/domains/tasks/fields.ts:48), with field definitions in [config.ts](/Users/nordini/agent-hq/api/src/domains/sprint-definitions/config.ts:4) and form rendering in [TaskModal.tsx](/Users/nordini/agent-hq/ui/features/tasks/TaskModal.tsx:289). Adjacent agent analysis tools are in [routing.ts](/Users/nordini/agent-hq/api/src/mcp/domains/routing.ts:24). Workflow request aliases are normalized centrally, so continued use of `sprint_id` internally is not itself evidence that `workflow_id` requests are broken.

**Prioritized findings**

P1 means repair before relying on telemetry for operational decisions or expanding its audience. P2 means a significant correctness or usability gap. Product gaps are distinguished from regressions.

1. **P1 — Most analytics routes do not enforce tenant isolation.**

   `/overview`, `/review`, and creation/outcome writes resolve the tenant, but recommendations, sessions, pipeline health, bottlenecks, failures, integrity, routing, templates, and events do not consistently do so. In a two-tenant fixture with tenant 2 active, `/sessions` returned both agents, recommendations counted both tenants' tasks/outcomes, `/events` returned all ten transitions, and integrity returned both tenants' affected tasks. `/bottlenecks?project_id=22` still included tenant 1's task in review bounces.

   More seriously, tenant 2 could resolve tenant 1's integrity event and create a new integrity event against tenant 1's task. The same fixture correctly rejected foreign task drilldown and foreign outcome updates with 404. This is a route-level ownership defect, not merely a missing project selector. Ordinary MCP keys are generally denied these routes, but administrative MCP access and the local operator API still require downstream tenant filtering. No cross-tenant writes were tested on live data.

   Evidence: [recommendations/sessions](/Users/nordini/agent-hq/api/src/routes/telemetry.ts:636), [pipeline reports](/Users/nordini/agent-hq/api/src/routes/telemetry.ts:759), [integrity writes](/Users/nordini/agent-hq/api/src/routes/telemetry.ts:995), [events](/Users/nordini/agent-hq/api/src/routes/telemetry.ts:1105), and [MCP authorization](/Users/nordini/agent-hq/api/src/lib/mcpApiAuth.ts:2152). Apply one shared authorized scope to every query and verify ownership before each mutation.

2. **P1 product gap — Custom-field analytics and schema controls are disconnected.**

   Telemetry configuration reads/writes only `telemetry_schema_config.id = 1`. Task capture instead resolves `task_field_schemas` by tenant, workflow type, and task type. No report reads `analytics_enabled`, visibility, defaults, or required-for-types settings. The telemetry review SELECT does not include canonical custom fields or resolved schema metadata; its detail endpoint returns raw task storage rather than the canonical enriched task shape.

   The fixture saved an analytics-enabled, required `revenue` field successfully. Canonical field resolution still returned only the existing `amount` field, and normal task creation accepted `{ amount: 30 }` without revenue. Switching tenants exposed the same telemetry configuration. Types also differ: telemetry offers `boolean` and `date`, whereas canonical schemas support `checkbox` and `url` and do not currently list `date`.

   Evidence: [schema routes](/Users/nordini/agent-hq/api/src/routes/telemetry.ts:312), [analytics toggle](/Users/nordini/agent-hq/ui/features/telemetry/TelemetryPage.tsx:470), [canonical types](/Users/nordini/agent-hq/api/src/domains/sprint-definitions/config.ts:21). Use canonical schemas as the field catalog and introduce real report definitions; expanding this separate schema editor will not enable statistics.

3. **P1 — Dashboard metric names do not match their calculations.**

   The page fetches `/tasks`, not `/telemetry/overview` or `/telemetry/review`. “First-Pass Rate” is `done / all loaded tasks`; a task that failed QA repeatedly still becomes a pass when done. “Confidence” starts at 0.85 and adjusts for priority, retries, blockers, and agent name, with no recorded confidence input. “Reroutes” means retry count. “Cycle time” is last task update minus creation, including unfinished tasks. Dependency presence is used for blocked/split flags without establishing that a blocker is unresolved or a split occurred.

   Executing the actual UI helper source returned `Pending` for both `failed` and `qa_pass` tasks and `Pass` for a done task with three retries. The live UI's 66.2% value exactly reflects 489/739. These numbers should be renamed to their actual meanings or replaced by measured metrics, with unknown data shown explicitly.

   Evidence: [UI helpers](/Users/nordini/agent-hq/ui/features/telemetry/TelemetryPage.tsx:56), [KPI calculations](/Users/nordini/agent-hq/ui/features/telemetry/TelemetryPage.tsx:1074), [dependency flags](/Users/nordini/agent-hq/ui/features/telemetry/TelemetryPage.tsx:865).

4. **P1 — Agent attribution still assumes the old task ownership model.**

   Current tasks distinguish assigned agent, active agent, and the agents on historical runs. `tasks.agent_id` tracks the active instance and becomes null without an active instance. Telemetry still uses that column for review filtering, metric defaults, and several agent summaries; the UI uses its associated `agent_name` for assignment/coverage and confidence.

   A fixture task with `assigned_agent_id=202` and `agent_id=NULL` disappeared from `/review?job_id=202`, and its new creation event received a null `job_id`. The live dashboard displayed zero assigned agents. Changing the label or substituting one ID everywhere will not fully solve attribution: reports need an explicit choice of assigned owner, executing agent, or outcome-producing agent.

   Evidence: [active ownership synchronization](/Users/nordini/agent-hq/api/src/domains/tasks/ownership.ts:8), [telemetry defaults](/Users/nordini/agent-hq/api/src/routes/telemetry.ts:25), [review filter](/Users/nordini/agent-hq/api/src/routes/telemetry.ts:177), [task read model](/Users/nordini/agent-hq/api/src/domains/tasks/readModel.ts:206).

5. **P1 — The legacy outcome/creation tables are not automatically maintained by ordinary workflows.**

   The normal create path persists custom fields and task history, but does not insert a creation event. No general collector was found that maintains first-pass QA, reopen/reroute counts, cycle time, or outcome quality when normal lifecycle transitions occur. The exceptional automatic writer maintains `spawned_defects`, potentially creating an otherwise default-valued outcome row. Thus the backend's default `first_pass_qa=0` can represent missing measurement, not an observed failure.

   A real `createTaskRecord` call in the isolated fixture persisted `{ amount: 30 }` and produced zero creation-event and outcome-metric records. Live coverage is correspondingly sparse. Runtime outcome callbacks and `task_outcome_metrics` are separate systems; recording a lifecycle outcome is not evidence that these summary metrics were populated.

   Evidence: [task creation](/Users/nordini/agent-hq/api/src/domains/tasks/writeModel.ts:295), [defect-only metric writer](/Users/nordini/agent-hq/api/src/domains/tasks/writeModel.ts:334), [outcome defaults](/Users/nordini/agent-hq/db/pg-migrations/00-baseline.sql:994). Define metrics from authoritative events/runs or maintain projections transactionally. Backfill only facts that existing history can establish.

6. **P1 — “Save field” and enable/disable use stale state.**

   `FieldCard` calls `onUpdate(index, local)` immediately followed by `onSave(index)`. The first schedules React state; the second closes over the old `fields` array and sends it to the API. The server response then restores those old values while showing “Saved.” The quick enable switch uses the same pattern. Add/delete construct their payload directly and do not have this particular problem.

   Reproduction from the code: edit a field's label, click Save field, inspect the PUT body or reload; the old field configuration is submitted. This was not exercised against live configuration. Pass the edited field or complete updated array directly into the save operation.

   Evidence: [child save](/Users/nordini/agent-hq/ui/features/telemetry/TelemetryPage.tsx:314), [quick toggle](/Users/nordini/agent-hq/ui/features/telemetry/TelemetryPage.tsx:368), [parent save](/Users/nordini/agent-hq/ui/features/telemetry/TelemetryPage.tsx:682).

7. **P1 — PostgreSQL breaks date-filtered overview and time-in-status reporting.**

   `/overview?from=...` and `?to=...` apply `tom.created_at`, but `task_outcome_metrics` has `recorded_at`, not `created_at`. Both local APIs and the fixture return HTTP 500. Bottlenecks reference the SELECT alias `dur` in WHERE; PostgreSQL rejects this with `column "dur" does not exist`. A broad catch suppresses the error and returns HTTP 200 with `time_in_status: []`, even when valid transitions exist.

   Evidence: [date helper and application](/Users/nordini/agent-hq/api/src/routes/telemetry.ts:14), [duration query/catch](/Users/nordini/agent-hq/api/src/routes/telemetry.ts:810). Use the correct time column and a CTE/subquery for duration filtering, and expose calculation failures rather than presenting missing data as a valid report.

8. **P1/P2 — Historical population and time semantics are unreliable.**

   The UI calls the standard task list without `include_closed=true`, so closing a workflow removes its history from “All time.” The fixture changed from one visible task to zero after closure; explicitly including closed workflows restored it. Status/priority/agent/search filters affect rows only, not KPIs, as confirmed in the live browser. The status dropdown and backend terminal/stage lists are hardcoded, excluding configurable workflow semantics.

   Date comparisons also operate on text. For a task created at `2026-09-08 12:00:00`, a lower bound of `2026-09-08T00:00:00Z` returned zero rows, while `2026-09-08 00:00:00` returned the expected rows. Pipeline completion dates use mutable `updated_at`, and routing/failure reports use current task state/last dispatch; later edits, retries, or ownership changes can alter past-period reports.

   Evidence: [closed-workflow exclusion](/Users/nordini/agent-hq/api/src/domains/tasks/readModel.ts:663), [page query](/Users/nordini/agent-hq/ui/features/telemetry/TelemetryPage.tsx:1063), [fixed statuses](/Users/nordini/agent-hq/ui/features/telemetry/TelemetryPage.tsx:1188), [pipeline timing](/Users/nordini/agent-hq/api/src/routes/telemetry.ts:771). Distinguish current inventory, task completion cohorts, and run/event history, with normalized timestamp boundaries.

9. **P2 — Subreports apply inconsistent filters and lose event dimensions.**

   Bottleneck duration and review-bounce queries ignore the outer project/workflow/type filters. Failure-stage totals ignore the agent/workflow/outcome filters and default date range used by the main report. In the fixture, an agent-202 failure report returned one task but failure stages from both agents. Some status emitters omit project/agent metadata, while `/events` filters the event's denormalized fields directly. Those events disappear from scoped views even though their owning task is in scope.

   Evidence: [bottlenecks](/Users/nordini/agent-hq/api/src/routes/telemetry.ts:810), [failure stages](/Users/nordini/agent-hq/api/src/routes/telemetry.ts:926), [event insertion](/Users/nordini/agent-hq/api/src/domains/tasks/history.ts:50), [eligibility emitters](/Users/nordini/agent-hq/api/src/services/eligibility.ts:115). Resolve missing dimensions at capture and reuse a common authorized report population across subqueries.

10. **P2 — Ingestion is not robust against retries or malformed values.**

    Repeating creation POST succeeds and creates duplicates: one task appeared twice in review, and total-created became two. Repeating outcome POST instead returns a raw unique-constraint 500. The API accepts a string `"false"` as true, negative reopen counts/cycle times, malformed failure JSON, and schema arrays containing null; the latter can break schema rendering. An integrity POST for a nonexistent task returned 201/`ok:true` but stored nothing because the emitter swallowed its FK error. Negative pagination yields 500.

    Evidence: [creation POST](/Users/nordini/agent-hq/api/src/routes/telemetry.ts:372), [outcome writes](/Users/nordini/agent-hq/api/src/routes/telemetry.ts:483), [schema validation](/Users/nordini/agent-hq/api/src/routes/telemetry.ts:334), [integrity emitter](/Users/nordini/agent-hq/api/src/domains/tasks/history.ts:92). Add typed validation, defined idempotency semantics, and truthful error responses. Keep unknown distinct from false/zero.

11. **P2 — Template analytics cannot compare historical instruction versions.**

    `/templates` groups historical runs by the agent's current `instructions_version` and current instruction-update timestamp. All older runs move under the newest version after an edit. It also reports runtime `done` as success without explicitly distinguishing runtime completion from workflow outcome, and treats absent token usage as zero. This is insufficient for evaluating which instruction version or agent configuration worked better.

    Evidence: [template query](/Users/nordini/agent-hq/api/src/routes/telemetry.ts:1082). Use immutable per-run instruction/config identity and measured usage coverage before presenting version comparisons or efficiency conclusions.

12. **P2 — Drilldown history uses the wrong response contract, and “Live” data is a snapshot.**

    The API returns `field`, `old_value`, and `new_value`; the drawer renders `from_status`, `to_status`, and `status`, and does not filter history to status changes. The fixture confirmed the API shape. The page loads on mount/project change, with no polling or event subscription. Load errors are only logged and requests lack stale-response protection, so a failed scope change may leave old data under the new scope label.

    Evidence: [history reader](/Users/nordini/agent-hq/api/src/domains/tasks/readModel.ts:710), [drawer renderer](/Users/nordini/agent-hq/ui/features/telemetry/TelemetryPage.tsx:1032), [loading behavior](/Users/nordini/agent-hq/ui/features/telemetry/TelemetryPage.tsx:1063). Render the actual history contract, disclose freshness, and handle failed/out-of-order requests explicitly.

**Recommended implementation order**

1. Repair tenant isolation, PostgreSQL failures, schema saving, and request validation. Correct or remove unsupported KPI claims and expose data coverage. These changes should precede broader use of the existing reports.
2. Define one reporting contract over canonical tasks, workflow schemas, runs, and events. Each metric needs a population/grain, field or measure, aggregation, filters, groupings, time basis, attribution rule, unit, and missing-value behavior. Derive statuses and fields from workflow definitions. Keep task counts separate from run/attempt/event counts.
3. Build a metric/query API and UI using that contract: count, distinct count, sum, average, min/max, percentiles, conditional rates, and typed comparisons are a useful first scope. Add saved reports and time buckets; calculate in the backend and return contributing records for drilldown. Do not introduce arbitrary executable SQL as a user-facing metric definition.
4. Add scoped agent tools to discover available fields/measures, preview a query, save a report, and retrieve results. Reuse the same authorization and execution path as the UI. Add scheduled snapshots/alerts and export after result semantics are trustworthy.

Acceptance examples that match the intended product: sum a numeric `amount` field by workflow/month; calculate approval rate by task type using configured outcomes; compare median/p95 time between configured stages by executing agent; track a checkbox/select distribution; filter by project, workflow, task type, and custom-field values together; retain results when workflows close; and get identical answers through UI and agent tools. Include multiple tenants, schema revisions, missing values, failed/retried runs, repeated requests, and date boundaries in acceptance coverage.

Historical task fields are mutable, and existing custom-field changes are recorded as JSON history rather than a dedicated versioned analytics fact model. Decide whether a report means “current value” or “value when the event happened.” Backfills should preserve uncertainty; old confidence, first-pass quality, and configuration attribution cannot safely be invented.

**Verification and deliverables**

- 49 existing API tests passed across runtime tenant scoping, workflow field-schema resolution, and lifecycle outcome evidence.
- All 210 existing UI tests passed. They do not exercise the telemetry page's save/filter behavior.
- [Audit harness](/Users/nordini/agent-hq/api/scripts/audit-telemetry.ts) completed with 40 recorded observations using a disposable PostgreSQL database built from current migrations. It exercises real routes and task/schema functions; it is an observation harness, not a passing regression suite. Mutation probes only touch synthetic data. It closes its server and drops its worker database.
- [Synthetic results](/Users/nordini/agent-hq/docs/telemetry-audit-2026-09-09-results.json) contain the HTTP responses and observed failures. Security probes exercise the route layer with active-tenant selection, not every deployed authentication combination.
- Live checks were read-only. The audit did not perform a full runtime-provider ingestion review, exhaustive deployment/security review, or scale benchmark.

To rerun the isolated observations from `api/`:

```sh
AGENT_HQ_TEST_PG_URL=postgresql://localhost/postgres npx tsx scripts/audit-telemetry.ts
```

The administrative test connection is used to create a separate test database; it is never selected as the application database.

The harness and the v1 routes it exercised were removed on 2026-09-24 (see [legacy telemetry consumers](telemetry-legacy-consumers.md)). Recover both from the repository history to rerun it.
