# Legacy telemetry compatibility (resolved)

The v1 compatibility API under `/api/v1/telemetry` (every path outside `/v2`) was removed on 2026-09-24. No UI page, MCP tool, CLI command, plugin, or agent contract called it; the configurable workspace at `/api/v1/telemetry/v2` had already replaced every report it served. The router (`api/src/routes/telemetry.ts`), the recommendations service only it used, its scope test, and the 2026-09-09 audit harness were removed with it. The old paths now return 404.

Removed endpoints: `/overview`, `/review`, `/review/:task_id`, `/schema-config` (already 410), `/creation-events`, `/outcome-metrics`, `/recommendations`, `/failure-taxonomy`, `/sessions`, `/pipeline-health`, `/bottlenecks`, `/failures`, `/integrity`, `/integrity-events`, `/integrity-events/:id/resolve`, `/routing`, `/templates`, `/events`, and `/integrity-taxonomy`.

## Retained tables

No table was dropped and no runtime writer changed.

| Table | Writers and readers after removal |
|---|---|
| `task_outcome_metrics` | Task creation maintains `spawned_defects` (`domains/tasks/writeModel.ts`); task reads (`domains/tasks/readModel.ts`) and reflection context (`lib/reflectionContext.ts`, labeled `legacy_recorded_summary`) read it. The other columns were only written by the removed outcome endpoints. |
| `task_events`, `task_history` | Written on every status transition. Read by task history, routing traces, and telemetry backfill. |
| `integrity_events` | No longer written, and dropped by migration `36-drop-integrity-events.sql`. Missing handoffs are measured by the `core.missing_handoffs.v1` telemetry metric. |
| `task_creation_events` | Only the removed creation-event endpoints wrote it. Retained as historical data. |
| `telemetry_schema_config` | Retired singleton, already unreachable (410). Retained, unread. |

The remaining tables stay in tenant scoping and in the agent-deletion reference check (`routes/agents.ts`).

## Follow-ups

- Drop `task_creation_events` and `telemetry_schema_config` in a later migration once their history is no longer wanted.
