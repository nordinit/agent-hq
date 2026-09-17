# Metric analysis and dashboards

Telemetry **Analyze** opens a saved metric at an immutable revision. Agent breakdowns use that metric's attribution policy, resolve agent names, and include an explicit **Unknown agent** group. A single group remains visible. Select a group to inspect its retained contributing records; changing live tasks does not change that result's membership.

The number, horizontal bars, and table support current snapshots. Time charts require recorded history and a calendar bucket. Each group has a separate chronological series; missing values remain gaps. Funnel and distribution charts are available for matching measurements. Sorting and chart style update the presentation locally; changes to the query require **Run analysis**. The agent filter narrows the calculation; the group search only narrows the displayed rows.

**Save view** stores the pinned metric revision, breakdown, chart, sort, filters, and time settings separately from the metric. Updating the metric does not silently update existing views. Select the metric again to start a view of its latest revision.

The dashboard selector retains **Operational overview** and adds named metric dashboards. Create a dashboard, add saved views, and use **Edit dashboard** to arrange, duplicate, remove, or resize widgets. Drag handles and Earlier/Later buttons change order. Width and height controls provide keyboard-accessible resizing. Save persists the layout. Adding a view copies its pinned configuration, so later changes to the source view do not alter existing dashboards.

Shared project and time filters apply to dashboard widgets. A widget can narrow scope and override its time range; overrides are labeled. Current snapshots ignore historical dashboard dates and continue to describe current inventory. Refresh recalculates widgets; pending query edits are marked stale. Each widget has independent errors and can expand or open in Analyze.

## Validation and attribution

Selecting **Assigned agent at journey entry** for a count exposes a journey count with required entry and finish conditions. It defaults to one journey per task and all started journeys, including open journeys. The builder requires explicit conditions before preview or save. This measures recorded journeys and can differ from a current inventory count.

Existing invalid definitions are not rewritten. Analyze flags missing journey context and opens a repair path. The user can define a journey or choose **Current assigned agent**. The shared validator rejects incompatible attribution in REST, MCP, saving, preview, and import. Event actor/outcome attribution requires event or journey evidence; execution attribution requires execution-capable grains. Included records with missing attribution remain in the total, with a separate known/unknown attribution count and warning.

## Persistence and API

No database migration is needed. Existing report resources support `presentation: "view" | "dashboard" | "report"`; legacy reports remain compatible. A view has one metric; dashboards have at most ten. Entries retain `metric_revision_id` and may include `id`, `metric_id`, `title`, `display`, `view`, and `layout`. Layout widths are 4, 6, or 12 columns; heights are compact, regular, or tall.

Query requests accept `bucket` as an override (or null to remove a bucket). Saved report widgets apply their own group, filter, scope, and time settings. Global and widget population filters intersect. Contributor requests accept `group` as a JSON-encoded exact group key and filter before pagination. `metric_index` disambiguates repeated uses of the same metric revision.
