<!--
RECOVERED DOCUMENT — PROVENANCE

Source: git blob de6b168409ce8d36d8e711a7120fd5245cca83e4
Commit: 9c4671ce8f1ec7b2f38f7b1f7673c99f1d6d2996 ("docs: spike sprint to workflow db migration",
        Cinder, 2026-06-02) — the only revision this file ever had.
Deleted by: 494509b5a131347e41964768ae0491f76570c8f2 ("Prepare repository for public release under
        nord-initiatives", 2026-06-11), which stripped internal specs, dated audits and ops runbooks.

This commit PREDATES the 2026-06-11 public re-root. `main` was re-rooted at b2c3705 ("Initial public
release"), so 9c4671c is NOT an ancestor of HEAD and this file is absent from the working tree, from
HEAD, and from a fresh clone. It survived only as an unreachable object in this worktree's object
store and would be destroyed by a routine `git gc`.

CONTENTS DESCRIBE THE PRE-MIGRATION STATE. Line numbers, file paths, table lists and recommendations
below reflect the repository as of 2026-06-02 and have not been re-verified against current code.
Read it as historical input, not as current fact.

One factual error has been identified and is corrected in the appended section
"CORRECTION (2026-07-28): Complete sprint_id Column Inventory" at the end of this file. The original
body is otherwise reproduced byte-for-byte.
-->

# Sprint to Workflow Physical Data Model Migration Spec

Task #708 spike, 2026-06-02.

## Verdict: PARTIAL

Question: Can Agent HQ safely rename the physical sprint tables and columns to workflow terminology now?

Evidence: Repository inventory with `rg -n -S "sprint|sprint_id|sprint_type"` and targeted schema inspection of `api/src/db/schema.ts`, backend domains, routes, MCP/OpenAPI surfaces, schedulers, dispatcher joins, and test fixtures. No schema migration was applied.

Recommendation: Defer the physical DB rename until a compatibility release removes direct runtime dependence on sprint-named tables and columns. Keep the current physical schema for now, continue exposing workflow terminology at the API/UI boundary, and only do the physical rename in a later maintenance-window migration with compatibility views/triggers and a rollback-tested SQLite rebuild path.

## Summary

Agent HQ is already partway through a logical terminology rename. User-facing workflow aliases exist in OpenAPI, MCP, and UI routes, but the canonical physical schema and many runtime SQL paths still use `sprints`, `sprint_id`, `sprint_type`, and `sprint_type_key`.

A direct physical rename now would be high risk because:

- Runtime dispatch, model routing, transition requirements, recurring tasks, lifecycle handoffs, OpenAPI/MCP clients, and tests still query sprint-named tables directly.
- SQLite cannot simply add foreign-key-compatible compatibility views; foreign keys cannot target views, and writable compatibility views require `INSTEAD OF` triggers.
- Several existing migrations already rebuild SQLite tables to change constraints and nullability. A full rename would need the same pattern across many FK-bound tables and indexes.
- `tasks.sprint_id` and `recurring_task_series.sprint_id` are hot-path fields for board placement and scheduled task generation.

## Inventory Method

Commands used:

```bash
rg -n --hidden -S "sprint|sprints|sprint_id|Sprint|Sprints" .
rg -n -S "CREATE TABLE|ALTER TABLE|CREATE INDEX|FOREIGN KEY|sprint_id|sprint_type|sprint_task|sprint_job|sprints|sprint" api/src/db api/src/domains api/src/services api/src/routes api/src/lib api/src/scheduler api/src/mcp api/src/openapi
rg -l -S "CREATE TABLE .*sprint|sprint_id INTEGER|sprint_type TEXT|sprint_type_key TEXT|sprint_task_|sprint_types|sprints \\(" api/src/**/*.test.ts
```

## Physical Table Mapping

Recommended final canonical names:

| Current physical table | Final physical table | Notes |
| --- | --- | --- |
| `sprints` | `workflows` | Core board/operating-cycle record. Existing `workflow_template_key` can keep its name. |
| `sprint_types` | `workflow_types` | Reusable workflow definitions. |
| `task_field_schemas.sprint_type_key` | `task_field_schemas.workflow_type_key` | Table name can stay because it is already task-centric. |
| `sprint_type_task_types` | `workflow_type_task_types` | Type-level task type allow-list. |
| `sprint_type_outcomes` | `workflow_type_outcomes` | Outcome catalog. |
| `sprint_type_task_statuses` | `workflow_type_task_statuses` | Type-level status catalog. |
| `sprint_type_relationship_types` | `workflow_type_relationship_types` | Relationship policy catalog. |
| `sprint_workflow_templates` | `workflow_templates` | Currently has both sprint and workflow terms. |
| `sprint_workflow_statuses` | `workflow_template_statuses` | Template status rows. |
| `sprint_workflow_transitions` | `workflow_template_transitions` | Template transition rows. |
| `sprint_task_statuses` | `workflow_task_statuses` | Workflow-instance status overrides. |
| `sprint_task_transitions` | `workflow_task_transitions` | Workflow-instance and workflow-type scoped transitions. |
| `sprint_task_transition_requirements` | `workflow_task_transition_requirements` | Evidence gates. |
| `sprint_task_transition_requirement_tombstones` | `workflow_task_transition_requirement_tombstones` | Defined in `api/src/domains/routing/policy.ts`. |
| `sprint_task_routing_rules` | `workflow_task_routing_rules` | Dispatcher routing rules. |
| `story_point_model_routing` | unchanged | Rename columns only; table is not sprint-specific. |
| `recurring_task_series` | unchanged | Rename fixed workflow FK column only. |
| `task_creation_events` | unchanged | Telemetry table; rename column only. |
| `task_outcome_metrics` | unchanged | Telemetry table; rename column only. |
| `agents` | unchanged | Legacy/internal `sprint_id` column should become `workflow_id` or be removed if unused. |
| `routing_config`, `lifecycle_rules` | unchanged/deprecate | Legacy compatibility tables; verify no workflow rename work should expand their usage. |
| Removed legacy tables: `sprint_job_schedules`, `sprint_job_assignments`, `sprint_schedule_fires` | none | Already dropped/disabled by prior migrations; do not reintroduce. |

## Physical Column Mapping

| Current column | Final column | Affected tables |
| --- | --- | --- |
| `sprint_id` | `workflow_id` | `tasks`, `recurring_task_series`, `task_creation_events`, `task_outcome_metrics`, `sprint_task_statuses`, `sprint_task_transitions`, `sprint_task_transition_requirements`, `sprint_task_transition_requirement_tombstones`, `sprint_task_routing_rules`, `story_point_model_routing`, `agents`, many test fixture tables. |
| `sprint_type` | `workflow_type` | `sprints`, `sprint_task_transitions`, `sprint_task_transition_requirements`, `sprint_task_routing_rules`, `story_point_model_routing`, request/response serializers, MCP/OpenAPI aliases. |
| `sprint_type_key` | `workflow_type_key` | `task_field_schemas`, `sprint_type_task_types`, `sprint_type_outcomes`, `sprint_type_task_statuses`, `sprint_type_relationship_types`, `sprint_workflow_templates`. |
| `source_sprint_id` | `source_workflow_id` | Create-workflow APIs and clone setup paths. |
| `sprint_name` | `workflow_name` | Read models, dispatcher payloads, task notification rows. |
| `sprintGoal` | `workflowGoal` | Dispatcher prompt/context builder parameters. |
| `sprintType` / `sprintId` | `workflowType` / `workflowId` | Runtime contracts should add workflow names first, then deprecate legacy names. |

Indexes to recreate with workflow terminology:

- `idx_sprints_project`, `idx_sprints_status`
- `idx_sprint_types_system`
- `idx_task_field_schemas_lookup`, `idx_task_field_schemas_base_unique`
- `idx_sprint_type_task_types_lookup`
- `idx_sprint_type_outcomes_lookup`
- `idx_sprint_type_relationship_types_lookup`
- `idx_sprint_workflow_templates_lookup`
- `idx_sprint_workflow_statuses_template_order`
- `idx_sprint_workflow_transitions_template_from`
- `idx_sprint_task_statuses_lookup`
- `idx_sprint_type_task_statuses_lookup`
- `idx_sprint_task_transitions_lookup`, `idx_sprint_task_transitions_scope_lookup`
- `idx_sprint_task_transition_requirements_lookup`, `idx_sprint_task_transition_requirements_scope_lookup`
- `idx_sprint_task_routing_rules_lookup`, `idx_sprint_task_routing_rules_scope_lookup`, `idx_sprint_task_routing_rules_scope_unique`
- `idx_spmr_scope_points`
- `idx_tce_sprint`, `idx_tom_sprint`
- `idx_recurring_task_series_project`

## Runtime Query Inventory

High-risk backend paths still directly depend on sprint physical names:

- Dispatcher: `api/src/services/dispatcher.ts`
  - Reads `tasks.sprint_id`, joins `sprints`, resolves `sprints.sprint_type`, reads `sprint_task_routing_rules`, reads `sprint_type_relationship_types`, resolves `story_point_model_routing.sprint_id/sprint_type`, and emits legacy `sprintId`/`sprintType` contract fields.
- Reconciler/watchdog: `api/src/scheduler/reconciler.ts`, `api/src/scheduler/watchdog.ts`
  - Filters dispatchability by joined sprint status and passes sprint context into lifecycle handoffs.
- Recurring tasks: `api/src/scheduler/recurringTaskScheduler.ts`, `api/src/routes/recurring-task-series.ts`
  - Treat `recurring_task_series.sprint_id` as the fixed workflow and validates sprint status, allowed task types, and statuses.
- Task routes/read/write model: `api/src/routes/tasks.ts`, `api/src/domains/tasks/*`
  - Accepts and stores `sprint_id`, resolves task field schemas by sprint/workflow type, and records lifecycle/evidence fields.
- Sprint/workflow routes: `api/src/routes/sprints.ts`, `api/src/domains/sprints/*`, `api/src/domains/sprint-definitions/*`
  - Current route implementation is still sprint-named even where exposed as workflow aliases.
- Routing rules and transition requirements: `api/src/routes/routing.ts`, `api/src/domains/routing/*`
  - Uses `sprint_task_*` tables, scoped default/override rules, tombstones, and scope derivation from `sprints`.
- Model routing: `api/src/routes/model-routing.ts`, `api/src/services/dispatcher.ts`
  - Uses `story_point_model_routing.sprint_id` and `story_point_model_routing.sprint_type`.
- MCP/OpenAPI clients: `api/src/mcp/server.ts`, `api/src/mcp/apiClient.ts`, `api/src/mcp/registerCatalog.ts`, `api/src/openapi/document.ts`
  - Expose both workflow aliases and legacy sprint args; many tool names still contain sprint type terminology.
- Notifications/release/lifecycle: `api/src/lib/taskNotifications.ts`, `api/src/lib/lifecycleHandoff.ts`, `api/src/lib/taskOutcome.ts`, `api/src/lib/taskRelease.ts`
  - Use sprint IDs/types in handoff payloads, transition resolution, and task notifications.

## Test Fixture Inventory

Tests with sprint-named physical fixtures or sprint-specific assertions include:

- DB/migration: `api/src/db/recurringTaskSchema.test.ts`, `api/src/db/sprintFieldSchemaMigration.test.ts`, `api/src/db/routingConfigScope.test.ts`
- Routes: `api/src/routes/sprints.test.ts`, `api/src/routes/routing.test.ts`, `api/src/routes/tasks.write-model.test.ts`, `api/src/routes/tasks.context.test.ts`, `api/src/routes/tasks.qa-evidence.test.ts`, `api/src/routes/tasks.resolve-field-schema.test.ts`, `api/src/routes/tasks.manual-override.test.ts`, `api/src/routes/recurring-task-series.test.ts`, `api/src/routes/model-routing.test.ts`, `api/src/routes/external-task-events.test.ts`, `api/src/routes/instances.lifecycle-handoff.test.ts`, `api/src/routes/agents.*.test.ts`, `api/src/routes/task518-emoji-roundtrip.test.ts`, `api/src/routes/taskRelationships.test.ts`
- Services/lib/scheduler/MCP/OpenAPI: `api/src/services/dispatcher.*.test.ts`, `api/src/lib/lifecycleHandoff.test.ts`, `api/src/lib/taskOutcome.scopedRouting.test.ts`, `api/src/lib/taskNotifications.test.ts`, `api/src/lib/sprintTypeConfig.test.ts`, `api/src/lib/taskRelease.test.ts`, `api/src/scheduler/recurringTaskScheduler.test.ts`, `api/src/scheduler/watchdog.test.ts`, `api/src/mcp/apiClient.test.ts`, `api/src/mcp/adminCrudCatalog.test.ts`, `api/src/openapi/openapi.test.ts`

These tests should be migrated in phases with compatibility expectations first, then physical-name assertions.

## Migration Strategy Decision

Use a longer compatibility window. Do not use dual-write columns as the main strategy.

Recommended approach:

1. Code-level alias phase first: introduce repository/domain helpers that read/write canonical `workflow_*` names while still targeting sprint physical columns.
2. Public API compatibility phase: prefer `workflow_id`, `workflow_type`, and `source_workflow_id` in request/response bodies while accepting `sprint_id`, `sprint_type`, and `source_sprint_id`.
3. Internal contract phase: add `workflowId`/`workflowType` to lifecycle, dispatcher, MCP, OpenAPI, and Agent HQ task contracts while preserving legacy `sprintId`/`sprintType`.
4. Physical rename phase: in a maintenance window, rename/rebuild tables and columns and create temporary writable compatibility views/triggers for old direct SQL clients.
5. Legacy removal phase: remove sprint compatibility views/triggers only after old clients and deployed agents no longer depend on them.

Avoid dual-write columns because `sprint_id` and `workflow_id` on the same table would create FK consistency problems, ambiguous source of truth, extra indexes, and every hot path would need conflict resolution. Views/triggers are a better temporary bridge after the physical rename.

## Proposed Rollout

### Phase 0: Backup and Preflight

- Require a full SQLite file backup using the existing backup flow before any schema-changing migration.
- Record current app commit, DB path, `PRAGMA foreign_key_check`, `PRAGMA integrity_check`, and row counts for every table in the mapping.
- Block if any orphaned sprint references exist in hot FK tables:
  - `tasks.sprint_id`
  - `recurring_task_series.sprint_id`
  - `sprint_task_*`
  - `story_point_model_routing.sprint_id`
  - telemetry tables
- Add a dry-run migration test that clones a real-ish seed DB into a temp file and verifies all row counts, indexes, FKs, and representative queries.

### Phase 1: Logical Workflow Canonicalization

- Introduce internal data access helpers that expose `workflow_id` and `workflow_type` while mapping to current physical `sprint_id` and `sprint_type`.
- Update dispatcher, recurring scheduler, routing policy, model routing, task write model, and lifecycle handoff code to use workflow terminology internally.
- Keep DB unchanged.
- Add regression tests that assert both old and new API fields work.

### Phase 2: Client Compatibility Expansion

- Make API responses include canonical workflow fields wherever sprint fields are still returned:
  - Tasks: `workflow_id`, `workflow_name`, `workflow_type`
  - Recurring task series: `workflow_id`
  - Routing/model rules: `workflow_id`, `workflow_type`
  - Lifecycle/MCP/OpenAPI contracts: `workflowId`, `workflowType`
- Keep accepting old fields and prefer workflow fields when both are present.
- Update UI and MCP clients to send workflow fields first.

### Phase 3: Physical Rename Migration

Implement as one explicit migration, not opportunistic `ensureColumn` fragments:

1. Start exclusive maintenance window.
2. Disable writers and scheduler/dispatcher loops.
3. Backup DB.
4. Run preflight checks.
5. `PRAGMA foreign_keys = OFF`.
6. Rename/rebuild parent tables first:
   - `sprints` to `workflows`
   - `sprint_types` to `workflow_types`
7. Rebuild child tables that need FK target or column-name changes:
   - `tasks`
   - `recurring_task_series`
   - `task_field_schemas`
   - all `sprint_type_*` / `sprint_task_*` tables
   - `story_point_model_routing`
   - telemetry tables
   - `agents` if the legacy column is retained
8. Recreate indexes with workflow names.
9. Recreate compatibility views/triggers for sprint-named old direct SQL access where practical:
   - `sprints`, `sprint_types`, `sprint_task_routing_rules`, `sprint_task_transitions`, `sprint_task_transition_requirements`, `sprint_task_statuses`
   - old column projection aliases such as `sprint_id AS workflow_id` cannot satisfy FKs, so this is only a temporary client bridge.
10. `PRAGMA foreign_keys = ON`.
11. Run `PRAGMA foreign_key_check` and `PRAGMA integrity_check`.
12. Run build/tests and smoke test:
   - task list/create/update
   - dispatcher rule resolution
   - transition outcome handoff
   - recurring series generation
   - model routing lookup
   - MCP workflow tools and legacy sprint aliases

### Phase 4: Compatibility Sunset

- Add runtime warnings/telemetry for legacy sprint API fields and sprint-named MCP tools.
- Publish removal date/version.
- Remove compatibility views/triggers after at least one release cycle with no legacy usage.
- Remove old tests or invert them to assert deprecation errors.

## Rollback Plan

Before Phase 3 commit:

- Restore the SQLite backup file.
- Restart API/schedulers on the previous app commit.
- Verify `PRAGMA integrity_check` and task board read path.

After Phase 3 commit but before compatibility sunset:

- Prefer DB file restore over reverse-renaming in place. The rename touches many FK-bound tables and indexes, so reverse migration is higher risk than backup restore.
- If restore is impossible, run a separately tested reverse rebuild migration from `workflow_*` back to `sprint_*`, then run the same integrity and smoke checks.

After compatibility views are removed:

- Rollback requires both app rollback and DB restore from the pre-sunset backup. Do not promise old-client support after this point without restoring compatibility views.

## Old-Client Support

Old clients should remain supported through:

- Request aliases: `sprint_id`, `sprint_type`, `source_sprint_id`.
- Response aliases: include both sprint and workflow names during compatibility.
- Route aliases: keep `/api/v1/sprints` and workflow routes pointing to the same handlers.
- MCP aliases: keep sprint-named tools until a documented removal window.
- Direct DB access: provide temporary views/triggers only for internal tools that still query old table names. Do not rely on those views for FK enforcement.

## High-Risk Areas

- `tasks.sprint_id`: hot path for task board placement, dispatcher eligibility, lifecycle handoff, notifications, release flow, task context, and API filtering.
- `recurring_task_series.sprint_id`: fixed workflow binding for scheduled task generation. Migration must preserve due indexes and idempotency behavior.
- Routing rules: `sprint_task_routing_rules` drives dispatcher assignment and has scoped default/override semantics across `project_id`, `sprint_type`, and nullable `sprint_id`.
- Transition requirements: `sprint_task_transition_requirements` gates outcomes and review evidence. Missing rows can falsely allow or block task movement.
- Model routing: `story_point_model_routing.sprint_id/sprint_type` is read by dispatcher thinking/model resolution.
- Dispatcher joins: joins from `tasks` to `sprints`, `sprint_task_routing_rules`, and `sprint_type_relationship_types` are runtime critical.
- MCP/OpenAPI clients: published tools and schemas still expose sprint fields; breaking these strands active automation.
- SQLite table rebuilds: changing FK-bearing column names and CHECK constraints requires rebuilds, index recreation, trigger recreation, and integrity checks.

## Follow-Up Implementation Tasks

1. Add workflow-named internal read/write DTOs and mapping helpers while keeping current physical schema.
2. Update task, routing, recurring, model routing, dispatcher, scheduler, and lifecycle code to use workflow terminology internally.
3. Expand API/OpenAPI/MCP compatibility so canonical workflow fields are preferred and sprint fields are legacy aliases.
4. Add compatibility tests for both workflow and sprint fields across tasks, routing, recurring series, model routing, dispatcher handoff, MCP tools, and OpenAPI.
5. Build a dry-run SQLite migration harness using a copied DB file with row-count, FK, index, trigger, and smoke-query assertions.
6. Implement the physical rename migration with explicit table rebuilds and compatibility views/triggers.
7. Add operational runbook docs for backup, maintenance window, validation, rollback, and old-client sunset.
8. After one compatibility release, remove sprint-named direct SQL usage from tests and runtime code.
9. After usage telemetry confirms no legacy clients, remove sprint compatibility views/triggers and deprecated API/MCP aliases.

## Acceptance Notes

- This spike produced a docs-only migration spec.
- No production DB schema, migration code, or physical table/column name was changed.
- The recommended decision is to defer the physical DB rename until a compatibility release has reduced direct sprint-schema dependence.

---

## CORRECTION (2026-07-28): Complete `sprint_id` Column Inventory

**This section was appended during document recovery. It is not part of the original 2026-06-02
spike.**

The "Physical Column Mapping" table above lists the tables carrying a `sprint_id` column. That list
is **incomplete**. It was assembled by repository search (`rg`) over `api/src/db/schema.ts` and the
domain code, not by querying a live database, so it missed columns added by incremental schema-init
migrations that the search patterns did not match.

### Method

Queried against the live production database read-only. No writes, no migration, no schema change:

```bash
sqlite3 "file:/Users/nordini/.agent-hq/agent-hq.db?mode=ro" \
  "SELECT m.name FROM sqlite_master m
   WHERE m.type='table'
     AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) p WHERE p.name='sprint_id')
   ORDER BY m.name;"
```

### Actual inventory — 13 tables

Row counts measured on the same database on 2026-07-28. This is the **live production** database, so
counts for append-only tables move between queries — `task_events` was observed at 7,698 and then
7,703 within the same session. Treat magnitudes as the fact and re-measure at migration time. The
non-null `sprint_id` counts were stable across repeated reads.

| # | Table | Rows | Rows with non-null `sprint_id` | In original spec? |
|---:|---|---:|---:|:--:|
| 1 | `agents` | 66 | 0 | yes |
| 2 | `external_event_mappings` | 28 | 0 | **NO — omitted** |
| 3 | `recurring_task_series` | 2 | 2 | yes |
| 4 | `sprint_task_routing_rules` | 770 | 670 | yes |
| 5 | `sprint_task_statuses` | 988 | 988 | yes |
| 6 | `sprint_task_transition_requirement_tombstones` | 30 | 30 | yes |
| 7 | `sprint_task_transition_requirements` | 156 | 125 | yes |
| 8 | `sprint_task_transitions` | 1259 | 1126 | yes |
| 9 | `story_point_model_routing` | 15 | 0 | yes |
| 10 | `task_creation_events` | 1 | 1 | yes |
| 11 | `task_events` | ~7,700 (growing) | 18 | **NO — omitted** |
| 12 | `task_outcome_metrics` | 5 | 0 | yes |
| 13 | `tasks` | 681 | 681 | yes |

The original spec listed 11 tables. The two omissions are **`task_events`** and
**`external_event_mappings`**.

Note on the row count: the audit that flagged this omission recorded `task_events` at 7,686 rows.
The live table now holds roughly 7,700 and climbs while you query it. The difference is ordinary
growth, not a discrepancy in the finding.

### Why the omissions matter

**`task_events` (~7,700 rows)** is by a wide margin the largest `sprint_id`-bearing table in the
database — larger than every other table in this list combined. Any rename or type-change migration
that iterates the mapping list above would have silently skipped it. Two further properties make it
the awkward case:

- `task_events.sprint_id` is declared `INTEGER` with **no foreign key** to `sprints(id)` and **no
  index**. It is denormalised event context, not a constrained reference.
- Only 18 of ~7,700 rows have a non-null `sprint_id`. A migration validated by checking that non-null
  values were carried over correctly would pass on a 0.2% sample while getting the column definition
  wrong for the whole table.

**`external_event_mappings`** carries a real constrained reference:

```sql
sprint_id INTEGER REFERENCES sprints(id) ON DELETE CASCADE
```

It is also missing from the spec's `sprint_type` mapping row and from the spec's index-recreation
list, which omits `idx_external_event_mappings_scope_lookup` (an index whose definition includes
`sprint_id`). A table rebuild driven by the original lists would have dropped that index and, because
the FK is `ON DELETE CASCADE`, silently changed delete semantics for external event mappings.

### Corrected `sprint_type` inventory — 6 tables

The spec's `sprint_type` row is short by the same table. Queried the same way:

| Table | In original spec? |
|---|:--:|
| `external_event_mappings` | **NO — omitted** |
| `sprints` | yes |
| `sprint_task_routing_rules` | yes |
| `sprint_task_transition_requirements` | yes |
| `sprint_task_transitions` | yes |
| `story_point_model_routing` | yes |

### Corrected index list

Every index whose definition references `sprint_id`, on the live database:

| Index | Table |
|---|---|
| `idx_external_event_mappings_scope_lookup` | `external_event_mappings` |
| `idx_recurring_task_series_project` | `recurring_task_series` |
| `idx_sprint_task_routing_rules_lookup` | `sprint_task_routing_rules` |
| `idx_sprint_task_routing_rules_scope_lookup` | `sprint_task_routing_rules` |
| `idx_sprint_task_routing_rules_candidate_unique` | `sprint_task_routing_rules` |
| `idx_sprint_task_statuses_lookup` | `sprint_task_statuses` |
| `idx_sprint_requirement_tombstones_sprint` | `sprint_task_transition_requirement_tombstones` |
| `idx_sprint_task_transition_requirements_lookup` | `sprint_task_transition_requirements` |
| `idx_sprint_task_transition_requirements_scope_lookup` | `sprint_task_transition_requirements` |
| `idx_sprint_task_transitions_lookup` | `sprint_task_transitions` |
| `idx_sprint_task_transitions_scope_lookup` | `sprint_task_transitions` |
| `idx_spmr_scope_points` | `story_point_model_routing` |
| `idx_tce_sprint` | `task_creation_events` |
| `idx_tom_sprint` | `task_outcome_metrics` |

Two differences from the spec's list are worth calling out:

- The spec names `idx_sprint_task_routing_rules_scope_unique`; the live database has
  `idx_sprint_task_routing_rules_candidate_unique`. The spec's name does not exist.
- The spec lists several `sprints`/`sprint_type`-family indexes (`idx_sprints_project`,
  `idx_sprints_status`, `idx_sprint_types_system`, the `task_field_schemas` and `sprint_type_*`
  lookups, the `sprint_workflow_*` indexes). Those are real, but they key on `sprints.id` /
  `sprint_type_key` rather than on a `sprint_id` column, which is why they do not appear in the
  query above. They still need recreating in any rename; they are simply out of scope for this
  specific correction.

**`tasks.sprint_id` has no dedicated index** on the live database, despite the spec correctly
identifying it as the hottest path in the system (board placement, dispatcher eligibility, lifecycle
handoff, notifications, release flow, task context, API filtering). It is FK-constrained to
`sprints(id)` but unindexed. That is a pre-existing performance characteristic, not a migration
defect, and it should be revisited when the table is rebuilt on the target engine.

### Standing instruction

Do not drive a schema migration from the mapping tables in the body of this document. Re-run the
`pragma_table_info` query against the actual target database at migration time and diff it against
the list here. The 2026-06-02 lists were search-derived and have now been shown to under-report by
two tables in `sprint_id` and one in `sprint_type`.
