# Terminology rename: sprint → workflow, job → agent

Status: schema done and verified; application and UI in progress.

## What already exists

This rename was started before the PostgreSQL migration and stalled partway. Finding that
out changed the plan, so it is worth stating plainly:

- **The API already speaks both vocabularies.** `api/src/lib/workflowCompatibility.ts`
  provides `normalizeWorkflowRequestAliases` (accepts `workflow_id` on requests and maps it
  to `sprint_id` internally) and `addWorkflowCompatibilityFields` (emits `workflow_id`
  alongside `sprint_id` in responses). `/api/v1/workflows` is already mounted as an alias
  of `/api/v1/sprints`.
- **The UI is partially migrated**: 27 `workflow_id` / 17 `workflow_type` references
  against 155 `sprint_id` / 107 `sprint_type`.

So this is not a breaking rename. It is an **inversion** of a compatibility layer that is
already in place and already exercised, which is a materially lower-risk operation.

## Direction

| Layer | Today | After |
|---|---|---|
| Database | `sprints`, `sprint_id`, `agents.job_title` | `workflows`, `workflow_id`, `agents.title` — **done** |
| Application SQL | `sprint_id` | `workflow_id` |
| API response | `sprint_id` primary, `workflow_id` alias | `workflow_id` primary, `sprint_id` deprecated alias |
| API request | both accepted | both accepted (unchanged) |
| UI | mixed | `workflow_*` only |

Requests keep accepting both. Only the *primary* response field changes, and the old name
stays as a deprecated alias — so no client breaks on the day this ships, and the alias can
be dropped in a later release once consumers have moved.

## Schema rename — done

Generated from the live catalog by `scripts/pg/generate-rename-mapping.mjs`, not from the
2026-06-02 spec, which undercounts (it lists 38 sprint-named indexes where there are 41,
and omits `task_events.sprint_id` and `external_event_mappings.sprint_id`).

- 14 tables, 27 columns, 41 indexes renamed
- 4 dead columns dropped, each verified empty against live data at generation time
- 3 non-goals recorded with justification

Verified by provisioning a full database from a production snapshot: 937,446 rows,
130 foreign keys, 16 workflow-named tables, 0 sprint-named.

### Non-goals, and why

- **`job_instances`** — 7,773 rows on the dispatch hot path, referenced by
  `tasks.active_instance_id`. Renaming it buys naming consistency at the cost of touching
  the most failure-sensitive table in the system during a migration that is already
  changing engines.
- **`logs.job_title`** — a run label, not the legacy "job" concept. Populated on all 62,954
  log rows and written on the logging hot path. Task #779 already draws this distinction
  and scopes run labels out.
- **MCP `job_id` alias** — already documented as legacy compatibility.

### Things the tickets got wrong

Worth recording, because both would have caused damage if taken at face value:

- Task #779 states `agents.schedule` is populated on 0 of 66 agents. It is
  `NOT NULL DEFAULT ''` and set on **all 66**. A `DROP COLUMN` on the ticket's wording would
  have run against every agent row. Deadness is now verified against the live data by
  comparing to the column's own declared default, not a bare `IS NOT NULL`.
- Two `job_id` columns (`task_creation_events`, `task_outcome_metrics`) appear in no ticket
  at all. Both unpopulated with no foreign key, so dropped.

## Application SQL

`scripts/pg/codemod-rename-sql.mjs` rewrites identifiers inside SQL strings only.

`sprint_id` occurs in this codebase as at least four different things:

1. a database column — must be renamed
2. a property on a row read back — must follow the column
3. a field in a JSON API request or response — a **contract**
4. a local variable or function name — cosmetic

A blanket text replacement cannot tell these apart and would silently rewrite the public
API. The codemod therefore changes (1) only and **reports** (2) and (3) for a separate,
deliberate pass. The report is as much the deliverable as the edit.

## Ordering

1. Schema rename — **done**, applied last in `provision.mjs` so the ETL can read a snapshot
   that still uses the old vocabulary. `ALTER ... RENAME` is metadata-only in PostgreSQL and
   carries constraints and indexes automatically.
2. Application SQL strings.
3. Row-shape properties, following their columns.
4. Invert `workflowCompatibility.ts` so `workflow_*` is primary.
5. UI, finishing the migration already begun.
6. OpenAPI: document `workflow_*` as canonical, mark `sprint_*` deprecated.
7. A later release drops the `sprint_*` response aliases.

Steps 2–6 land as their own commit series **after** the engine swap is verified working, so
that a cutover failure has exactly one possible cause rather than two.
