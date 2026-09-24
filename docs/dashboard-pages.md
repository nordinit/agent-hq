# Configurable dashboard pages

The Dashboard route now uses the Operational Overview visual style with configurable pages. Choose Operational overview, an existing dashboard, or New dashboard. Existing Agency reports open through a read adapter with six summary cards, a query comparison table, three outcome metrics, and the original explanatory notes. Select a number or comparison cell to inspect exact values, the breakdown, and retained contributing records.

## Editing

Select **Edit layout** to show the page and block settings. Add content with **+ Add block** or `/` outside a text field. Available content includes pinned metrics, saved single-metric views, comparison tables, operational statistics and lists, headings, Markdown notes, callouts, dividers, and links.

Sections contain one to four independently stacked columns. Drag a block by its handle, use Earlier/Later buttons, or choose Move to column in its settings. Column proportion sliders also support keyboard arrow keys. Page settings control width and density; block settings control titles, card/plain appearance, accents, icons, precision, display type, and source overrides. Comparison settings select metric columns, ordering, and the visible row limit. Undo/redo applies to edits during the current editing session.

**Save layout** creates an immutable revision and checks the expected prior revision. Editing a legacy report creates a new dashboard page, retaining the original report. Cancel returns to the starting layout. Unsaved changes prevent switching dashboards and prompt before following links or leaving the page. The selected dashboard is remembered in this browser and can be opened with `/?dashboard=<id>`.

## Data behavior

- Layout changes do not recalculate metrics. Shared bindings and identical query requests reuse a result, with at most three metric queries in flight. Source/filter changes are debounced and obsolete responses are ignored.
- Metric definitions, scope enforcement, ratios, exact decimal values, and evidence retention remain the existing telemetry engine's responsibility. Rounding affects only dashboard display. Missing and zero-denominator values remain unavailable.
- Comparison tables align exact group keys and refuse incompatible group, time-basis, attribution, scope, or time-window combinations. Each metric keeps its own population; the UI labels this explicitly. Columns never average ratios together.
- Snapshot pages omit historical date controls. Historical metrics support saved dates, relative range shortcuts, and explicit UTC boundaries. Viewing filters are temporary; editing changes the page's saved defaults.
- Operational blocks use the existing statistics and completed-task endpoints and support project scope. They are unavailable on workflow/task-type-scoped pages. Create a project-scoped page to combine operational blocks with narrower, individually scoped metric bindings.
- Detail drawers retain the full calculation, coverage, quality warnings, and contributor evidence. Ratio contributors show numerator/denominator components rather than incorrectly formatting numerator counts as percentages. Saved, unchanged sources can open in Analyze; temporary filter overrides stay in the current result drawer.

## Storage, API, and rollout

Migration `35-dashboard-pages.sql` permits `kind=dashboard` in the existing telemetry revision store. It does not rewrite saved reports or metrics. Apply the migration and deploy the API before the new UI. A migration regression test verifies existing report revisions and metric pins remain identical.

Dashboard endpoints are under `/api/v1/telemetry/v2/dashboards`: list, create, read, revise (`/:id/revisions`), and archive. They use `telemetry.read` and `telemetry.manage_reports`. Equivalent MCP tools and the catalog's `dashboard` JSON schema expose the same contract. Export accepts `dashboard_ids` and includes pinned metric dependencies; import remaps dependencies using the existing scope and reference validation.

Page documents have a schema version, appearance, scope/date defaults, metric bindings, and a section/column/block tree. Limits are 24 sections, 80 blocks total, 40 blocks per column, and 10 metric bindings. Column weights are integers totaling 12 per section. Block/column/section identities must be unique. Link blocks accept HTTP(S) URLs and local paths.

Legacy dashboards remain available in the selector. Rolling back the UI does not require deleting new page documents or reversing the additive resource-kind migration. Autosaved drafts, a revision-history/restore UI, reusable sections, richer text/image editing, and simultaneous collaborative editing remain follow-on work.

## Isolated preview and verification

`api/scripts/dashboard-smoke-server.ts` creates a disposable PostgreSQL test database with nine synthetic Agency metrics, retaining real query and contributor behavior. It never selects a saved Agent HQ database. Set `AGENT_HQ_TEST_PG_URL` to the test PostgreSQL server and run the script with `tsx`; it prints the preview URL and serves on loopback port 56183. Stop it with SIGINT/SIGTERM to close workers and remove its owned test database.

Run a separate UI preview with `AGENT_HQ_INTERNAL_BASE_URL=http://127.0.0.1:56183`, `AGENT_HQ_NEXT_DIST_DIR=.next/dashboard-preview`, and Next's development server on loopback port 3560. The optional distribution directory keeps preview builds separate from ordinary app output.

Automated coverage includes exact decimal presentation, block movement/removal, column budgets, legacy conversion, immutable pins, revision conflicts, scoped access, migration preservation, import/export remapping, and MCP contracts. Browser checks cover card/details rendering, group-specific contributors, note insertion and movement, formatting, save/reload, dragging, resizing, undo/redo, unsaved navigation, and narrow layouts. Screenshots use the synthetic preview data.
