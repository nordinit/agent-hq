# Configurable telemetry implementation and rollout

Implemented in the Agent HQ working tree, September 9–10, 2026. This replaces the fixed Telemetry workspace with configurable measurements. Production databases and running application builds have not been migrated or restarted by this work.

The accepted [specification](configurable-telemetry-spec.md) and [implementation plan](configurable-telemetry-implementation-plan.md) remain the design reference. The original [audit](telemetry-audit-2026-09-09.md) describes the replaced behavior.

## Delivered milestones

| Milestone | Implementation |
|---|---|
| M0 — contracts | Versioned typed expression/result contracts, structured validation errors, and executable fixtures for different success milestones, custom values, and the six-task first-pass example. |
| M1 — working measurement | Canonical field discovery, scoped current/event queries, typed aggregation, guided preview, and retained contributors. The UI and MCP use the same REST service. |
| M2 — reusable definitions | Metrics, optional profiles, reports, immutable revisions, optimistic edits, eight-level bindings, disabled overrides, explicit report pins and update previews. Binding inspection explains the current/proposed winner, inheritance, shadowed defaults and deeper overrides before saving. |
| M3 — durable evidence | Transactional database capture, outbox projection, causation, correction chains, coverage inspection, resumable backfill, source deletion and retention. Generations preserve historical field, status and outcome identities. |
| M4 — workflow measurements | Configurable first pass, denominators, reset/stage visits, attempts, cancellation, timeouts, duration pairing/pauses, blocked conditions, ordered funnels, attribution and compatible weighted ratios. Core runtime templates have platform versions. |
| M5 — reporting workspace | Guided/advanced builders, report charts/tables, definition inspection, included/excluded drilldown, snapshots, bounded background jobs, scoped MCP capabilities, and project/workflow portability. |
| M6 — replacement | The Telemetry page uses the new workspace. The disconnected schema editor and fabricated KPIs are removed from it. Reachable compatibility readers have tenant containment; legacy tables remain for existing consumers. |

Main implementation: [telemetry domain](../../api/src/domains/telemetry/), [REST router](../../api/src/routes/telemetry-v2.ts), [MCP tools](../../api/src/mcp/domains/telemetry.ts), and [workspace](../../ui/features/telemetry/TelemetryPage.tsx).

## What is configurable

A metric defines its population, entity grain, conditions, aggregation, grouping, time basis, missing-data policy and attribution. A journey additionally defines entry, success, rework, final failure, cancellation, attempts, reset and timeout. None of the evaluator's business-success logic depends on a status named `done`, `approved`, `submitted`, or on routing display order.

The supported aggregates are count, conditional count, distinct count, sum, mean, min, max, continuous percentile and explicit-bucket distribution. Ratios retain both components. Expressions include boolean predicates, arithmetic, conditional values, event existence/count and bounded durations. Ordered funnels and calendar buckets use the same engine.

Custom fields come from the effective task/workflow-type schemas. Telemetry does not introduce another custom-field editor. Scalar current queries support task, workflow, project, agent, run and runtime-execution grains; task custom values support task/event/journey grains. Unsupported allocation of one task value across multiple runs is rejected. The catalog exposes each field's supported grains and value bases.

Current inventory uses current canonical values. Historical event and journey metrics use recorded contexts at entry, event or resolution, including when a task subsequently moves. Current run/execution inventories follow current ownership; historical execution evidence is selected through event expressions. Current inventory does not accept an old `as_of` or occurrence-time window. Use an explicit creation-time predicate for a current cohort, a historical metric for milestones, or open a retained result for an earlier calculation.

The first-pass fixture produces 2/4 with the evaluated denominator, 1/4 when runtime or run-state failure is selected as rework, and 2/3 with a successful-only denominator. Pending and cancelled work are disclosed. Unknown history cannot establish a first-pass success. Blockage can independently mean a chosen field/status condition or unresolved prerequisites under configured terminality.

The guided signal catalog includes canonical routing transitions and external-event mappings with their scope and enabled/override metadata. Choosing one copies its explicit evidence predicate into the metric; later routing edits do not rewrite that measurement. Platform templates separately expose runtime failures, runtime failure rate, lost/cancelled executions, run-state failures, duration, token counts and missing handoffs.

## Definitions, identity and access

- A label edit preserves a field identity. Removal/recreation, incompatible type changes and key changes create a new generation. A saved revision retains its original catalog descriptors. It never silently reads a new same-key field or a colliding built-in field. Affected bindings show `needs_attention` from the canonical generation ledger, including profile references, even before the catalog is refreshed.
- Status and outcome keys also resolve to pinned identities. Label changes retain identity; removal, key changes, disablement and recreation retire it. Tasks preserve the identity assigned with their status, and accepted outcomes retain their captured identity. Existing historical revisions remain queryable; affected live bindings show `needs_attention` and require an explicit revision before reactivation. Unconfigured keys are recorded as unregistered identities and do not adopt a later configured same-key meaning.
- Saved report cards pin metric revisions. Revising a metric does not move existing reports or bindings. A comparison requires compatible explicit contracts; ratio rollups add numerators and denominators, and reject overlapping samples.
- Binding precedence is workflow+task type, workflow, project+workflow type+task type, project+workflow type, workflow type+task type, workflow type, project, tenant. A disabled winning binding stops inheritance.
- Project credentials cannot widen queries through fields, components, profiles, report revisions, imports, cached proofs or contributors. Retained results recheck source access. Source deletion or ownership changes invalidate affected retained evidence; some purge paths conservatively invalidate the tenant's retained results.
- Export/import uses new destination identities and revalidates references. Missing or ambiguous field, signal, entity or scope mappings remain inspectable drafts. An imported field generation is not silently substituted for a retired generation.

Project manifests retain the v1 format and optionally include telemetry definitions/bindings plus the canonical workflow types, task types, schemas, statuses and outcomes they use. Project import copies that configuration into the destination tenant/project, creates a distinct workflow type key when one already exists, and maps workflow, agent, schema and telemetry revision identities. It preserves task-type and milestone keys within the copied workflow type. Unresolved telemetry remains drafts with import warnings; old manifests without telemetry still import. Project export/import keeps its existing operator/full-administration permissions.

The agent capabilities are `telemetry.read`, `telemetry.query`, `telemetry.manage_metrics`, `telemetry.manage_reports` and `telemetry.export`. Scoped runtime agents do not receive these grants automatically. The existing capability editor grants them within the agent's assigned project. Import needs both management grants. Backfill and retention changes require tenant operator/full-administration access.

## Evidence and retention

See the [producer inventory](../telemetry-capture-inventory.md) for canonical sources, safe snapshots, transaction boundaries, coverage and purge behavior, and the [legacy consumer inventory](../telemetry-legacy-consumers.md) for compatibility endpoints/readers.

Capture begins at migration installation. Existing tasks can be bootstrapped, but their current values do not establish earlier state transitions. Backfill scans only trustworthy source rows and records their provenance; completing a scan does not make old best-effort history complete. Coverage reports installation/retention boundaries, pending observations and disabled producers. No production backfill was run during implementation.

The outbox and projection commit together during draining. Replays converge through source identity. Workers select pending rows rather than a maximum-ID checkpoint, so commits arriving out of sequence are not skipped. Corrections supersede previous versions before the effective-time filter. Retention preserves retraction ancestry so expiring a correction cannot revive its original event.

Default limits are explicit and configurable where noted:

| Setting | Default / bound |
|---|---|
| Interactive entity budget | 10,000; configurable up to 50,000 |
| Background entity budget | 50,000 maximum |
| Observation budget | Up to 20 per allowed entity, capped at 250,000 |
| Expanded samples | Bounded by the evaluation entity/sample budget |
| Report/family partitions | 10 per query |
| Grouping dimensions | 3; bounded group cardinality |
| SQL statement timeout | 5 seconds interactive / 30 seconds background |
| Retained proof size | 32 MiB UTF-8 |
| Contributor page | 50 default / 200 maximum |
| Query retention | 1 hour, configurable 1–168 hours |
| Frozen snapshot retention | 30 days, configurable 1–365 days |
| Snapshot count | 100 per tenant, configurable 1–1,000 |
| Observation history | 90 days, configurable 1–3,650 days; cutoff cannot move backward after deletion |
| Import package | 4 MiB, 100 definitions, bounded revisions/references |

Background work pins the compiled plan before queuing. Expiring claims recover interrupted workers. Cancellation prevents publication of a cancelled result. Concurrent identical queued requests deduplicate only when authorization, definition bundle, source revision and explicit evaluation instant match. There is no approximate cache of current values. Frozen reports retain the calculation and its proofs; they do not rerun mutable tables under an old result ID.

The implementation uses scoped, parameterized PostgreSQL reads and a bounded typed TypeScript evaluator with exact decimal arithmetic. This replaces the plan's proposed first-slice SQL aggregation compiler with one shared calculation path for numeric and journey measurements. No user SQL or JavaScript is executed. PostgreSQL numeric values are encoded without a lossy JavaScript-number conversion. Unsafe numeric results remain exact decimal objects in the API.

## Validation and performance

Validation is recorded from disposable PostgreSQL fixtures and isolated UI builds. No validation process uses the configured production database.

- The final UI has 233 passing tests, with TypeScript, lint, generated-contract drift checks and an isolated production build passing.
- [Browser acceptance](telemetry-browser-acceptance.json) uses real headless Chromium interactions with the production UI build and the disposable API, without mocking telemetry responses. It verifies a numeric total of 210 and matching six-record proof, metric/report saves, frozen snapshots, report revision pinning, a project binding yielding mean 35, inheritance and workflow disabling, configurable first pass at 2/4 and 2/3, invalid-draft errors, and a different project's submission milestone. No page errors occurred.
- API integration covers immutable status/outcome generations, retired references, exact decimal calculations, scoped authorization, producer faults, historical corrections, worker recovery, retention and project portability. The final full API run passed 239 of 240 suites and 2,419 of 2,421 tests. All telemetry-related suites passed. API TypeScript and SQL lint also passed. See the [API validation record](telemetry-api-validation.json) for commands, totals and failures.
- The full run had two failures in the existing routing suite: a 60-second setup/teardown hook timeout and a later contract-template read returning HTTP 500. The entire routing suite passed on an isolated retry (61 of 61 tests, 12.648 seconds). The cause remains unconfirmed; the retry does not make the original full run green.

Concurrent regression runs exposed a preexisting test-cleanup race: an idle connection interval was incorrectly treated as proof that a test database was abandoned. Cleanup now requires a recorded local owner whose process has definitely exited. Live, unknown and remote owners, and shared template databases, are retained. Database-free regressions cover this behavior; the final full-suite run is serialized with respect to the performance fixture.

The [performance report](../telemetry-performance.md) and its [raw measurements](../telemetry-performance-results.json) record the synthetic workload, hardware, query plans, latency, worker lag and retained storage. Limits are workload bounds, not a claim of production capacity. Reproduce the benchmark against a dedicated disposable test database before raising operational limits.

## Deployment sequence

1. Build and verify the release in its deployment checkout. Keep the API and UI on this same release. The UI includes generated browser-safe telemetry contracts; `node ui/scripts/sync-telemetry-contracts.js` refreshes them from the canonical API sources and the UI drift test verifies them.
2. Use the normal maintenance window to stop the previous API writers and take the normal database backup. Apply migrations through `npm run db:migrate` from the built API release. Do not use `db:install` on an existing installation. Migrations 26–30 add capture, definitions/proofs, retention, schema generations and status/outcome generations; they do not activate guessed business metrics or reconcile routing configuration. Migration 30 bootstraps the current task status identity and records its availability boundary without inventing earlier status entries.
3. Verify migration status, then start the new API and UI through the existing deployment process. The startup schema verifier runs before either telemetry worker. Analytics workers run even when task-dispatch automation is disabled.
4. Open Telemetry → Coverage. Check enabled producers and pending counts. Use bounded tenant-operator backfill requests for desired historical sources, repeating with the saved cursor until complete. Inspect the disclosed historical limitations.
5. Configure real success/rework meanings for the desired workflows. Preview the numeric-field and milestone recipes, inspect contributors, save a metric/report and grant intended agent capabilities. Confirm the same definition through an authorized agent.
6. Monitor pending evidence, query failures, retention sweeps and workload latency. Keep the legacy compatibility reader restrictions in this release.

Rollback is a UI rollback while keeping the compatible API, containment fixes and validated capture active. The old API may reject the newer migration ledger. Do not drop the telemetry tables or reverse canonical schema migrations as a UI rollback. If capture itself must be disabled, record the outage as a coverage gap.

Scheduled evaluations/alerts, business-hours calendars, advanced cohort statistics, personal sharing, external BI connections and additional custom-field entity editors remain the explicitly deferred extensions from the accepted specification.
