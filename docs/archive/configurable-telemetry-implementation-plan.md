**Configurable telemetry — implementation plan**

Status: Accepted and implemented in the working tree. Validation results and remaining limitations are recorded; production rollout has not been performed. Prepared September 9, 2026 against Agent HQ checkout `6bfecc2e`. Implements the [product and technical specification](/Users/nordini/agent-hq/docs/configurable-telemetry-spec.md), informed by the [current functionality audit](/Users/nordini/agent-hq/docs/telemetry-audit-2026-09-09.md). See the [implementation and rollout record](configurable-telemetry-release.md) for delivered behavior, validation and deployment steps.

The objective is a configurable measurement system that users and agents can use as it develops. Do not spend the opening phase repairing fixed first-pass, confidence, blockage, or cycle-time formulas. Build the new catalog, definition, evaluation, and explanation path; replace those formulas with configured definitions as that path becomes usable.

This document preserves the accepted build plan. Application changes and migrations are now present in the working tree; production migrations and backfills have not been applied.

**1. Build order and demonstrations**

| Milestone | User-visible result | Depends on |
|---|---|---|
| M0: Contract and fixtures | Agreed executable examples for the first two measurements | Specification |
| M1: First working slice | Select a custom numeric field or success milestone, preview a value, inspect its contributors | M0 |
| M2: Reuse and tracking | Save metrics, bind different meanings to different workflows, reopen a pinned report | M1 |
| M3: Observation coverage | Explain which history exists; capture task, routing, relationship, and runtime evidence reliably | Capture starts in M1; full coverage builds on M1–M2 |
| M4: Workflow measurements | Configure first pass, blockage, durations, conversion, and funnels from the same primitives | M2 plus relevant M3 sources |
| M5: Complete user and agent workspace | Guided and advanced builders, comparisons, history, agent tools, and definition portability | M2–M4 |
| M6: Default rollout | Replace the legacy workspace after a documented compatibility and release check | M5 |

Each milestone can be demonstrated without waiting for the entire release. M1 is intentionally small: current numeric aggregation and distinct tasks reaching a selected milestone after capture begins. It does not label milestone attainment as proof of first pass. M2 supplies useful saved reporting while broader historical sources and journey semantics are completed.

The dependency sequence is M0 → M1 → M2 → M4 → M5 → M6, with M3 expanding capture alongside the definition work. An individual recipe becomes available only after its required observations and coverage checks exist. Features in a milestone are not automatically all exposed at once.

**2. Repository boundaries**

Create a proposed `api/src/domains/telemetry/` domain with small modules for catalog adapters, versioned definitions, binding resolution, capture, query compilation, journey evaluation, coverage, and result explanations. Add modules as their milestone needs them. Keep the existing legacy router separate during replacement.

| Area | Existing integration points | Planned responsibility |
|---|---|---|
| Canonical schemas | [sprint-definitions/config.ts](/Users/nordini/agent-hq/api/src/domains/sprint-definitions/config.ts), [TaskFieldsSection.tsx](/Users/nordini/agent-hq/ui/features/sprintDefinitions/sections/TaskFieldsSection.tsx) | Effective typed fields, descriptor registration, links back to the canonical editor |
| Workflow interpretation | [routing/graph.ts](/Users/nordini/agent-hq/api/src/domains/routing/graph.ts), [routing/trace.ts](/Users/nordini/agent-hq/api/src/domains/routing/trace.ts), [terminality.ts](/Users/nordini/agent-hq/api/src/domains/tasks/terminality.ts) | Discover actual scoped statuses, outcomes, rules, and terminality; never infer business success from terminality |
| Task observations | [writeModel.ts](/Users/nordini/agent-hq/api/src/domains/tasks/writeModel.ts), [mutations.ts](/Users/nordini/agent-hq/api/src/domains/tasks/mutations.ts), [ownership.ts](/Users/nordini/agent-hq/api/src/domains/tasks/ownership.ts), [relationships.ts](/Users/nordini/agent-hq/api/src/domains/tasks/relationships.ts) | Atomic observation insertion at canonical writes, including assignment and scope changes |
| History and outcomes | [history.ts](/Users/nordini/agent-hq/api/src/domains/tasks/history.ts), [taskOutcome.ts](/Users/nordini/agent-hq/api/src/lib/taskOutcome.ts), [taskLifecycle.ts](/Users/nordini/agent-hq/api/src/lib/taskLifecycle.ts) | Source provenance, outcome-to-transition causation, legacy history adapters |
| Execution observations | [runtimeEnd.ts](/Users/nordini/agent-hq/api/src/domains/runs/runtimeEnd.ts), [runtimeFailureEvent.ts](/Users/nordini/agent-hq/api/src/domains/runs/runtimeFailureEvent.ts), [instanceStop.ts](/Users/nordini/agent-hq/api/src/domains/runs/instanceStop.ts) | Runtime, run, cancellation, usage, and semantic-handoff facts with separate classifications |
| Transactions/configuration | [adapter/types.ts](/Users/nordini/agent-hq/api/src/db/adapter/types.ts), [routing/audit.ts](/Users/nordini/agent-hq/api/src/domains/routing/audit.ts) | Reuse transaction handles and audited configuration patterns; preserve safe execution-time context |
| API and jobs | [index.ts](/Users/nordini/agent-hq/api/src/index.ts), [scheduler/index.ts](/Users/nordini/agent-hq/api/src/scheduler/index.ts) | New versioned router, bounded queries, retryable capture/backfill workers |
| Agent access | [mcpApiAuth.ts](/Users/nordini/agent-hq/api/src/lib/mcpApiAuth.ts), [mcp/registrar.ts](/Users/nordini/agent-hq/api/src/mcp/registrar.ts), [mcp/catalog.ts](/Users/nordini/agent-hq/api/src/mcp/catalog.ts), [toolPermissions.ts](/Users/nordini/agent-hq/api/src/mcp/toolPermissions.ts) | Scoped capabilities and tools using the same domain service as REST |
| User interface | [TelemetryPage.tsx](/Users/nordini/agent-hq/ui/features/telemetry/TelemetryPage.tsx), [ui/lib/api/index.ts](/Users/nordini/agent-hq/ui/lib/api/index.ts) | Report workspace, typed API client, builder, explanations, and coverage states |

Add incremental PostgreSQL migrations under `db/pg-migrations/`, choosing the next available number when implementing. Existing sprint/workflow naming compatibility remains intact. This project must not depend on finishing the physical table rename or introducing a separate warehouse.

**3. M0 — define the smallest shared contract**

Keep this a short implementation setup step, not a separate platform project.

1. Define version-1 Zod contracts for catalog references, authorized query scope, expressions, metric definitions, results, and structured errors. Make unsupported operations explicit. Assign one owner for profile resolution in the compiled definition bundle; conflicting profile references must fail validation.
2. Implement the minimal typed operator registry needed by M1: field predicates, boolean composition, count/distinct count, count-if, sum, mean, and selected status-entry predicates. Reserve versioned extension points for temporal operations; do not advertise unimplemented operators.
3. Establish the result contract immediately: definition explanation, sample count, coverage, numerator/denominator where relevant, fixed evaluation context, and contributing-record identity.
4. Create deterministic fixtures for a custom numeric field and three workflows with success milestones `done`, `approved`, and `submitted`. Prepare the six-task first-pass fixture from the specification for M4.

Completion: the contracts can express those examples with different configuration and no workflow-specific conditions inside the evaluator. Maintain plain-language expected values alongside the fixtures so tests assert product meaning, not merely generated SQL structure.

**4. M1 — ship the first working measurement slice**

Suggested reviewable changes:

- **Catalog and query service:** Read effective task schemas and workflow configuration within tenant/project scope. Register stable descriptor identities for the selected fields/statuses. Build `/catalog`, `/definitions/validate`, and `/queries/preview` behind the new router. Compile a task-grain numeric aggregate using PostgreSQL numeric arithmetic. Reject incompatible field references and joins that would multiply task values.
- **Capture baseline and milestone measure:** Add minimal outbox, observation, context, coverage, and result storage. Capture task creation and status transitions atomically through the producer paths used by the demonstration. Start a retryable worker and expose its coverage boundary. Evaluate distinct task entries into a selected status. For other write paths, explicitly report incomplete coverage until instrumentation is complete.
- **Preview and drilldown UI:** Add a typed telemetry client and small explorer within the Telemetry feature. Choose scope, field or milestone, aggregation, filters, and grouping; display actual values and contributors. Numeric zero, empty population, missing data, and query failure have distinct states. Capture the submitted draft directly rather than relying on a state update to finish before Save/Preview reads it.
- **Agent parity:** Register read-only catalog and preview tools over the same query service. This establishes one execution path before more editing features are added.

The preview must not independently recompute KPI values from the paginated tasks endpoint. It must apply filters to the aggregate and contributor population together, including an explicit archived-workflow policy.

Completion demonstration: an operator selects an existing numeric custom field, obtains a sum grouped by project, and can account for it from contributing tasks. Then the operator chooses a different success milestone for each of three workflows and gets distinct task counts from the same query engine. An authorized agent obtains the same answer. Historical milestone counting is limited to verified coverage, visibly.

**5. M2 — save, reuse, and track definitions**

Suggested reviewable changes:

- **Definition storage:** Add metric/profile families and immutable revision tables, revision hashes, dependency manifests, optimistic concurrency, and actor audit. Validate canonical references and prevent cycles. Editing a label preserves descriptor identity; incompatible schema changes require explicit handling.
- **Bindings:** Implement the eight-level resolution order, explicit disabled overrides, unique specificity, pinned profiles, and scope applicability. Add an inspection API/UI explaining the winning definition for a selected task context. Resolve a report's requested family into a pinned bundle; missing coverage or bindings remain visible.
- **Saved reports:** Store report revisions, explicit measure revisions, filters, timezone, attribution, and display preferences. Support KPI cards, a grouped table, and a basic time series where the metric's time basis allows it. Reopening a report uses its saved definition bundle; updating definitions is a deliberate revision with an impact preview.
- **Write tools and permissions:** Add scoped metric/report save tools and capabilities. Make changing a metric independent of permissions to change workflow configuration. Use normal authorization for every referenced resource and every component expression.

Tracking at this milestone means re-evaluating a saved, stable definition over available current/history data, with explicit freshness and manual refresh. Scheduled evaluations are a later extension.

Completion: two projects can use the same family name with different success predicates without overwriting one another. Workflow overrides and explicit disables are inspectable. Concurrent edits return a conflict instead of silently losing work. A report can stay on an old definition and compare a proposed revision before switching.

**6. M3 — complete the evidence needed by workflow metrics**

Capture starts in M1 to accumulate real history while the rest is built. This milestone broadens it to the supported sources and makes coverage auditable.

First produce a writer inventory, including direct SQL writers. For every supported event, record its canonical owner, transaction boundary, idempotency key, dimensions, producer version, and test. A best-effort log call is not proof of durable coverage.

| Source | Required work |
|---|---|
| Task lifecycle | Creation, field changes, status changes, delete, import/clone, and reconciliation; include before/after values and effective schema descriptors |
| Ownership and relationships | Assignment/scope/type changes, dependency additions/removals, and prerequisite resolution effects; distinguish assigned owner from the executing agent |
| Outcomes and external events | Record accepted outcomes and mapped external events; propagate causation into resulting transitions to prevent double-counted attempts |
| Dispatch and execution | Inventory dispatcher, eligibility/reconciliation, callbacks, runtime-end, instance-stop, and lifecycle-handoff writers; preserve runtime versus semantic outcome |
| Configuration | Record safe schema/routing and execution configuration references; retain historical instruction/model fingerprints rather than grouping by current agent configuration |

Implementation requirements:

1. Put minimal outbox writes in the same transaction as canonical DB changes, using the supplied transaction handle. Where the write path is not transactional, refactor that boundary before claiming coverage. Preserve callback retry/reconciliation for external actions already completed.
2. Normalize stable source IDs, effective/recorded time, sequence, causation, and correction versions. Process committed pending rows with retry and gap tracking; acknowledge only after durable projection writes. Replaying duplicates must converge.
3. Store typed field/context snapshots needed for entry, event, and resolution values. Capture only declared analytics data, with safe runtime descriptors. Record field removal/type changes without rewriting older evidence.
4. Add coverage APIs and operator-visible worker/backfill state. A recent successful worker heartbeat is insufficient proof that every producer has been instrumented.
5. Implement resumable backfill adapters for trustworthy existing task history, events, runs, and routing audit records. Source keys make re-running safe. Bootstrap unknown intervals honestly; do not import the legacy first-pass boolean as a reconstruction of workflow history.
6. Define deletion/retention behavior before retaining production snapshots. Test purge through facts, projections, query results, report snapshots, and caches.

Completion: recorded fixtures through each canonical producer produce the same logical facts as replay/backfill, including duplicate deliveries, corrections, late events, and transactions that commit out of ID order. A worker outage recovers without dropped observations. An uninstrumented or ambiguous source produces a coverage limitation, not an assertion that an event never happened.

**7. M4 — configurable journeys, rates, and durations**

Build a deterministic journey reducer over normalized observations and a compiled definition bundle. Separate event normalization from journey interpretation so users can change business definitions without changing recorded runtime facts.

Suggested reviewable changes:

- **Journey lifecycle:** Start, resolve, cancel, disqualify, count attempts, timeout, and reset under explicit policies. Support first-per-task and non-overlapping reset/stage-visit journeys. Preserve causal ordering and classify unresolvable contradictions as unknown.
- **Expressions and aggregation:** Add bounded event predicates, duration pairing, derived numeric values, conditional measures, distributions, continuous percentiles, ratios, and compatible component dependencies. Apply missing-data policy to the shared eligible population before numerator/denominator aggregation.
- **Recipes:** Build inspectable configuration templates for first-pass, milestone conversion, selected-stage dwell time, blocked-at-snapshot, ever-blocked, percent-time-blocked, and basic ordered funnels. Recipe conditions come from the catalog/profile. No hardcoded success/rework/status names enter the evaluator.
- **Attribution and comparison:** Support the documented current/entry/event agent and scope bases. Add explicit comparison contracts, compatibility checks, and weighted ratio rollups. Show separately when definitions cannot be combined.
- **Core runtime templates:** Publish versioned definitions for the supported runtime facts. Distinguish execution failure, run-state failure, cancellation/loss, missing handoff, and workflow rejection. Normalize cumulative usage before aggregation.

Completion demonstration: the six-task fixture gives 2/4 first pass by default, 1/4 when runtime failure is selected as rework, and 2/3 with a successful-only denominator. Each result has an explanation for every sample. Reopening, missing history, status changes, and task movement obey the saved definition. A custom numeric field can be summed at submission time while its current value subsequently changes.

**8. M5 — complete the reporting workspace**

Build on the working explorer rather than adding a second builder/evaluator.

- Add the guided recipe flow and advanced structured-expression editor with shared validation, plain-language interpretation, impact preview, and actionable missing-reference errors.
- Complete report charts, configured funnels, definition panels, filters, and paginated explanations for included and excluded records. Never show a failed request as zero. Cancel/discard stale responses when users change scope or filters.
- Add workflow-definition/instance Metrics areas with inherited bindings and overrides. Add “Measure this stage/transition” to the routing graph and links to canonical field editing.
- Complete agent tools for metrics, reports, contributors, and query status. Include profile/binding operations through an explicit shared API contract rather than an agent-only mutation shortcut.
- Implement expiring result retention and manual frozen report snapshots. Guarantee consistent drilldown through retained contribution proofs or versioned observation references. A current-table query cannot simply rerun later under its old result token after tasks change.
- Add asynchronous bounded evaluation for eligible heavy queries, with cancellation, deduplication, job status, and result expiry. Cache only when authorization, definition, data revision, and time parameters match.
- Integrate definition/profile/report export and import with project/workflow portability. Map canonical references to destination identities and revalidate scopes/types. Unresolved references remain drafts; do not activate broken definitions or copy source tenant IDs.

Completion: users can create, save, reuse, compare, revise, and explain supported measurements without code. Agents can do the equivalent within their capabilities. A copied workflow's telemetry references map to the destination configuration. A new tenant sees core evidence and recipe drafts, with no guessed business first-pass rate.

**9. M6 — replace the legacy experience and release**

1. Inventory consumers of every legacy telemetry endpoint/table, including MCP advanced tools, reflection/quality readers, and `spawned_defects`. Classify each as replaced, retained as a labeled legacy measure, or unused. The old singleton schema settings are not canonical field definitions and must not be automatically promoted.
2. Keep the new workspace opt-in during implementation. Compare new definitions with hand-verifiable fixtures and actual task evidence; agreement with legacy KPIs is not a release criterion. Invite configuration of the desired success/rework meanings in real workflows before changing the default.
3. Enforce tenant/project containment on still-reachable legacy routes, or disable routes proven unused. This is a rollout prerequisite because old access must not bypass new scoped reporting; it is not a preceding repair campaign for old metric calculations.
4. Switch the Telemetry page to the new workspace when acceptance checks pass. Retire the disconnected Schema Config editor and fabricated KPI calculations. Preserve necessary compatibility readers until their consumers migrate.
5. Publish coverage start dates, supported operators/value bases, retention settings, performance results, and migration behavior. Explain that incomplete older history cannot be recovered solely from current task state.
6. Remove obsolete tables/columns only in a later separately reviewed migration after consumer evidence supports removal. Avoid coupling that deletion to the initial UI switch.

Rollback: the new UI can be disabled without undoing canonical task changes. Keep durable capture active where validated so reverting a UI does not create new history gaps. If capture itself must be disabled for operational reasons, record the exact coverage gap. Retain new definitions/data for forward recovery; do not attempt destructive schema rollback during an incident. No rollout path may reopen the legacy tenant-isolation issues.

**10. Validation and release evidence**

Use the existing PostgreSQL-backed API test fixtures and UI test infrastructure. The [audit harness](/Users/nordini/agent-hq/api/scripts/audit-telemetry.ts) documents legacy failures; it is evidence for migration, not the new semantic oracle.

| Test layer | Meaningful coverage |
|---|---|
| Contract/evaluator fixtures | Configured milestones, denominators, missing values, attempt/reset policies, interval pairing, exact decimal sums, continuous percentiles, incompatible units, comparison weighting |
| PostgreSQL integration | Tenant/project authorization across every endpoint and dependency, scoped catalog reads, transaction atomicity, fan-out prevention, timestamps/DST, descriptor versions, producer capture, duplicate/correction handling, backfill and purge |
| UI interactions | Choosing real custom fields; definition preview/save; inherited override; all-card filter consistency; empty/error/partial/stale states; definition update preview; matching aggregate and contributor values |
| REST/MCP parity | Identical definition/filter/as-of/data revision yields identical values, sample membership, and access restrictions |
| Replay/recovery | Worker restart, retry, out-of-order commit, late observations, result expiry, permission change, and frozen snapshot behavior |

Before release, publish a synthetic performance fixture with representative task, event, field, tenant, and group counts, plus machine/database settings. Measure current-field aggregation, a grouped first-pass query, duration distribution, and contributor paging. Record query plans, p50/p95 latency, worker lag, and storage growth. Tune indexes and limits from those measurements; do not assert scale based only on small fixtures. Exercise budget rejection and asynchronous fallback as product behavior.

The final release checklist is the specification's acceptance table plus the producer inventory, consumer migration inventory, and measured performance report. Run relevant lifecycle/routing/runtime regression suites when capture touches those paths, along with telemetry and UI suites. Broaden testing when a failure or changed boundary warrants it.

**11. Draft defaults and later work**

The plan can begin with these explicit defaults: optional reusable profiles; free metric names; immutable revisions; report definitions pinned on save; one journey per task unless reset is configured; evaluated first-pass denominator excluding open/cancelled work; unknown evidence excluded and disclosed; runtime failure disqualifies business success only when selected; one agent attribution per sample; separate cross-definition series until comparison compatibility is declared; and PostgreSQL with a typed expression engine.

Choices such as start milestone, rework, final failure, all-started versus evaluated denominator, and cancellation treatment remain metric configuration. They do not require a universal product answer before building. The builder must explain their effect.

Scheduled snapshots/alerts, business-hours calendars, advanced cohort statistics, external BI, authenticated personal sharing, and custom-field editors for additional entity types follow the first complete release. Their implementation should extend the same catalog and evaluator. They are not prerequisites for the first useful custom metric.
