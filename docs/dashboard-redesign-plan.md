# Agent HQ dashboard redesign

Design analysis and proposed implementation plan — September 23, 2026.

## Recommendation

Build one configurable dashboard page system with the visual language of Operational Overview, the data depth of the Agency dashboard, and a block editor inspired by Notion. Operational Overview and Agency become starter templates in the same system. A user can start with a polished page and change its structure, content, density, and appearance.

The core interaction is composing a page: headings, notes, sections, columns, compact metrics, charts, and linked operational views. Dragging identical analytical cards around does not provide that level of control.

## Evidence from the current app

Inspected both live dashboards at localhost:3500 and their React components, telemetry types, input validation, presentation helpers, and report portability code. No application behavior or saved dashboards were changed.

| Area | What works | What needs to change |
| --- | --- | --- |
| Operational Overview | Dark slate surfaces, subtle borders, colored metric accents, icons, compact values, clear sections, useful failure/completion lists | Fixed composition; seven cards leave an uneven last row; operational summaries cannot currently be added to a custom dashboard |
| Agency — Single-query lead search | Nine meaningful metrics, query breakdowns, contributors, denominators, pinned definitions, scope controls | Repeated full analysis tables, repeated action bars and metadata, a large filter form, internal scrolling, insufficient summary hierarchy |
| Current editor | Drag ordering, duplication, keyboard ordering, three widths and heights, per-widget settings, version conflict detection on save | Flat metric-only array; no headings, notes, columns, reusable sections, or linked operational lists; adding content requires an existing saved view |
| Data presentation | Exact values and retained evidence are available | Non-percent decimal strings render at full precision; technical provenance dominates normal reading |

The Agency page currently has nine snapshot metrics: verified searches, retrieved entries, reviewed candidates, qualified candidates per search, drafts per search, qualification rate, screening rejection rate, weighted candidate score, and commercial/pricing refusals. All nine should remain available in the redesign.

At inspection, the first three values were 9 searches, 140 retrieved entries, and 90 reviewed candidates. Qualification was 22/90; commercial refusals were 17/22 qualified candidates. These are captured values, not a live feed or historical trend.

A separate labeling issue exists in Operational Overview: its `Completed Today` value counts completed run instances created within the last 24 hours, while the completion list describes tasks. The new metric catalog must distinguish runs from tasks and define time boundaries precisely. A visual migration must not silently change either calculation.

## Proposed page and visual design

Keep the existing dark slate shell, rounded cards, amber interactions, readable type, and restrained status colors. Introduce shared spacing, card, title, number, and empty-state rules so small statistics and larger views feel related. Let users choose page width, comfortable/compact density, card/plain presentation, icons, and accent colors within this design system.

The Agency starter page should have:

1. A page title, short description, project scope, freshness indicator, and an Edit layout action. Its snapshot-only default should not show ineffective date inputs.
2. Six compact summary cards: searches, retrieved entries, reviewed candidates, qualification rate, qualified/search, and drafts/search. Show concise units and sensible display precision, with exact values in details.
3. A query-performance section with one configurable table and metric columns. Users can choose columns, sorting, and grouping. A grouped comparison view requires compatible grouping and populations across the underlying metric results; missing values stay missing.
4. A quality/outcomes section exposing screening rejection rate, weighted score, and commercial refusals, with their proper denominators. These should not be labeled alerts unless a user defines an alert rule or threshold.
5. Optional linked operational sections: failed runs, completed tasks, active agents, and task views, plus notes and links.

Selecting a metric or table group opens a detail panel with the full breakdown, contributing records, calculation description, quality/coverage, exact value, freshness, and an Analyze link. Keep partial, unavailable, stale, unknown-attribution, and filter-override indicators visible where they affect interpretation; move routine provenance and evidence expiry into details.

## What Notion-style customization means here

Notion's documented distinction between dashboard views and freeform pages with inline views is useful: this request needs the page composition of the latter, with stable alignment and an explicit editing state. References: [Notion dashboards](https://www.notion.com/help/dashboards), [columns, headings, and dividers](https://www.notion.com/help/columns-headings-and-dividers).

### First release

- An insertion menu available through + and slash commands; users can choose a metric directly or reuse a saved view.
- Headings, short rich text/notes, dividers, callouts, collapsible sections, and column groups.
- Number cards, charts supported by the selected measurement, query tables, failed-run lists, completed-task lists, and links.
- Drag blocks between sections and columns; resize column boundaries; visible drop previews; equivalent keyboard commands.
- A selected-block inspector for content, source, display, precision, filters, and appearance. Configuration stays out of the reading surface.
- Duplicate, remove with undo, undo/redo, template duplication, and an explicit Save layout action.
- Personal viewing filters distinct from saved shared defaults. Persist the selected dashboard and support direct dashboard URLs.
- Responsive layouts with predictable mobile stacking and accessible touch/keyboard interactions.

Use a shallow structure initially: page → sections → column groups → blocks. This supports meaningful page design while keeping editing, mobile ordering, and undo understandable. Allow independent stacking inside each column. Natural height should be the default; fixed scrollable regions are an explicit option for long lists.

### Follow-on work

Autosaved drafts with revision history, saved reusable sections, additional task presentations such as boards, richer text/image blocks, user-level dashboard defaults, and natural-language layout editing through the dashboard API. Real-time collaborative editing and arbitrary HTML/CSS are outside the first release.

## Technical approach

### Preserve the data engine

Reuse the telemetry query engine, immutable metric revisions, scope enforcement, attribution, and contributor evidence. Reuse existing operational endpoints for run/task blocks through explicit adapters. Keep the same result objects available to both summary renderers and the detailed Analyze experience.

Separate three concerns:

- **Data binding:** source/provider, pinned metric or saved view configuration, population, grouping, time basis, and filters.
- **Presentation:** number/table/chart/list, title, icon, unit label, precision, and detail behavior.
- **Composition:** block identity, section/column parent, order, column proportions, page width, and density.

Create dashboard-specific summary renderers instead of embedding `TelemetryResultCard` everywhere. Preserve exact decimal strings in the data layer; round only displayed text. Metric cards must support an approximately 120–150px content-led height, without the current 260/400/650px widget minimums.

### Versioned dashboard documents

Recommend a dedicated versioned dashboard document/resource for mixed content and layout. The existing telemetry report format is a flat `metrics[]` list capped at ten entries in both UI and server validation. Extending that report executor into a document editor would couple unrelated concerns.

A dashboard document should contain a schema version, title, scope, template origin, appearance, filter defaults, and a typed block tree. Metric blocks reference existing pinned definitions; operational blocks use approved providers. Reuse the existing immutable-revision and expected-revision conflict patterns. A database migration, dashboard API, capability checks, MCP contract, and import/export support are part of this work, not just React styling.

Use a read adapter to display legacy dashboard reports. Create an explicit converted copy when saving in the new editor, retain the source report and original revisions, and preserve metric IDs, pinned revisions, scope, grouping, and overrides. Keep the legacy page available during rollout. Convert Operational Overview into a template backed by its existing calculations before considering any semantic changes.

### Query and filter behavior

- Metric scopes remain authorization-constrained and cannot be widened by page filters or a copied template.
- Show project, time, and agent filters only when applicable, with clear per-block exceptions.
- Label current snapshots and historical intervals separately. Add relative dates and the user's timezone for historical data.
- Define temporary viewing filters separately from saved defaults; show when changes are pending calculation. Debounce filter changes and cancel superseded requests.
- Deduplicate matching data bindings so a number card and its detailed table can share a result and evidence identity. Use bounded concurrency and defer below-the-fold expensive views.
- Count static blocks separately from active data queries. Keep explicit performance budgets; do not simply remove the ten-query limit.
- Do not calculate trend arrows from snapshots, average subgroup percentages, or invent a funnel from unrelated totals.

The existing dnd-kit dependency is a reasonable starting point. A focused editor spike should verify cross-column dragging, nested drop targets, keyboard movement, and touch before committing to that implementation. Choose any rich-text dependency after testing the actual editing needs.

## Implementation sequence

| Phase | Deliverable | Completion check |
| --- | --- | --- |
| 1. Visual and data contract | Reviewable Agency and Operations layouts; metric inventory; definitions of time, units, scope, and drilldowns; editor interaction spike | Both layouts are understandable at a glance; all nine Agency metrics have a clear home; no invented history or changed metric meaning |
| 2. Shared dashboard foundation | Design primitives, compact renderers, detail panel, versioned documents, legacy adapter, both starter templates | New and old presentations agree for the same scope/as-of result; existing reports still open; original definitions remain recoverable |
| 3. Page editor | Sections, columns, insert menu, operational/content blocks, inspector, resize/reorder, undo/redo, save/conflict handling | A user can compose an Agency page from a template, add a note and failures list, rearrange it, and reload without losing settings |
| 4. Reliability and rollout | Responsive/keyboard QA, query scheduling, permissions, import/export/MCP coverage, opt-in migration and rollback | No scope leaks, silent overwrite, page-wide failure from one block, clipped long values, or incompatible date controls; migration is reversible |

The first production milestone is the two templates using the shared compact renderer and detail panel. That delivers the visual improvement while establishing the same components the editor will compose.

## Verification

Test behaviors that could change meaning or lose work: snapshot versus historical dates, scope intersections, ratio denominators, exact/display precision, duplicate metrics and contributor identity, legacy conversion, revision conflicts, undo and save/reload. Verify expired evidence and unavailable metrics explicitly.

Review desktop, narrow windows, mobile, keyboard, and touch using representative real and empty data. Set performance budgets from the existing nine-widget Agency page and measure first useful content and interaction latency. Do not make unsupported promises about speed before measuring.

## Main implementation references

- `ui/features/dashboard/OperationalDashboard.tsx`: legacy cards, run failures, completed tasks, shortcuts.
- `ui/features/dashboard/MetricDashboards.tsx`: selection, saving, global filters, saved-view insertion, ordering.
- `ui/features/dashboard/MetricDashboardWidget.tsx`: widget heights, controls, querying, expanded view, resizing.
- `ui/features/telemetry/TelemetryResults.tsx`: analytical rendering and retained contributors.
- `ui/lib/telemetryTypes.ts`, `ui/lib/telemetryViews.ts`, `ui/lib/telemetryPresentation.ts`: widget contract, scope/time behavior, exact value formatting.
- `api/src/domains/telemetry/definitions.ts`, `inputSchemas.ts`, `portability.ts`: validation, revisions, and migration compatibility.
- `api/src/mcp/domains/telemetry.ts`: agent-facing contracts that must remain compatible.
