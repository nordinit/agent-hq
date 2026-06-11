# Frontend UI folder architecture

This document records the intended ownership boundaries for the Agent HQ frontend after the UI-folder refactor moves.

It complements `docs/ui-folder-refactor-phase-0-inventory.md`, which captured the initial inventory and migration plan. This file describes the steady-state architecture the frontend should now follow.

## Goals
- Make route ownership obvious.
- Keep feature logic with the feature that owns it.
- Keep shared UI truly shared.
- Reduce ambiguous imports that hide domain ownership.
- Preserve truthful boundaries between route shells, feature modules, primitives, and shared infrastructure.

## Current boundary model

### `ui/app/*`
Route entrypoints, route-level layouts, and thin page shells.

Use `ui/app/*` for:
- Next.js route files
- route-specific composition
- light route wiring
- URL and layout concerns

Do not keep large feature orchestration here when it can live in a feature module.

Preferred pattern:
- route file imports one page-sized feature container from `ui/features/*`
- route file stays small and easy to scan

Examples:
- `ui/app/tasks/page.tsx` → `ui/features/tasks/TasksPage`
- `ui/app/chat/page.tsx` → `ui/features/chat/ChatPage`
- `ui/app/logs/page.tsx` → `ui/features/observability/LogsPage`
- `ui/app/page.tsx` → `ui/features/dashboard/DashboardPage`

### `ui/features/*`
Feature-owned UI modules.

Use `ui/features/*` for:
- page-sized feature containers
- domain sections
- feature-local state and hooks
- feature-local composition helpers
- feature-specific error boundaries
- feature-owned presentation components that are not truly cross-feature

Current feature homes include:
- `ui/features/tasks/*`
- `ui/features/chat/*`
- `ui/features/routing/*`
- `ui/features/settings/*`
- `ui/features/observability/*`
- `ui/features/dashboard/*`
- `ui/features/telemetry/*`

This is the default home for product UI behavior.

### `ui/components/ui/*`
Primitive design-system building blocks.

Use this folder for:
- small reusable primitives
- low-level composable UI pieces
- styling-focused building blocks with minimal product knowledge

Examples:
- `badge`
- `button`
- `card`

These should stay domain-light.

### `ui/components/*`
Truly shared cross-feature components only.

Use this folder for components that are genuinely shared across features and are not owned by one product domain.

Examples that still fit here:
- app-shell pieces
- onboarding surfaces reused across the app shell
- generic cross-feature widgets

Do not use this folder as a holding area for feature modules.

### `ui/lib/*`
Shared infrastructure and narrow common helpers.

Use `ui/lib/*` for:
- API access and transport helpers
- shared formatting helpers
- shared metadata helpers
- hooks used across multiple features
- common vocabularies reused by multiple domains

Do not move page-sized UI or domain-owned feature orchestration here.

## Import rules

### Preferred import direction
- `ui/app/*` may import from `ui/features/*`, `ui/components/*`, `ui/components/ui/*`, and `ui/lib/*`
- `ui/features/*` may import from `ui/components/*`, `ui/components/ui/*`, and `ui/lib/*`
- `ui/components/*` may import from `ui/components/ui/*` and `ui/lib/*`
- `ui/components/ui/*` should stay close to primitive-only concerns

### Avoid
- new feature code importing through compatibility shims in `ui/components/*` when the real owner lives in `ui/features/*`
- hiding feature ownership behind generic component paths
- placing feature-specific containers back into `ui/components/*`

## Compatibility shim policy
Several feature modules were temporarily re-exported from `ui/components/*` during the migration so route changes could land in smaller diffs.

That compatibility layer should be treated as transitional only.

Rule:
- New imports should target the owner path under `ui/features/*`.
- Remove thin re-export files from `ui/components/*` once no in-repo imports depend on them.

Examples of owner paths that should be imported directly:
- `@/features/tasks/TaskBoard`
- `@/features/tasks/TaskBoardComponents`
- `@/features/tasks/TaskBoardErrorBoundary`
- `@/features/tasks/TaskDetailPanel`
- `@/features/chat/ChatWidget`
- `@/features/routing/ExternalEventsRoutingSection`
- `@/features/settings/ConnectionsManager`
- `@/features/settings/ProviderConnectionsManager`
- `@/features/observability/ProjectAuditLog`

## Practical placement guide

### Put code in `ui/app/*` when
- it is a route entrypoint
- it exists mainly to wire URL-level behavior
- it is a thin shell over a feature page

### Put code in `ui/features/*` when
- it owns task, chat, routing, settings, telemetry, or other domain behavior
- it coordinates API calls, local state, and UI for one feature
- it is page-sized or section-sized and clearly belongs to one domain

### Put code in `ui/components/*` when
- multiple unrelated features use it
- it has no single obvious domain owner
- it is shared presentation or shell UI, not a feature container

### Put code in `ui/components/ui/*` when
- it is a primitive building block
- it has little or no product logic

### Put code in `ui/lib/*` when
- it is infrastructure or shared helper logic
- it is not itself UI

## Architecture guardrails for future refactors
- Prefer direct imports from the owning feature path.
- Keep route files thin once a feature page exists.
- Avoid recreating generic `components` dumping-ground behavior.
- Keep feature-local helpers close to their feature unless they are proven cross-feature.
- Move files without logic changes first, then do behavior changes separately when possible.
- If a temporary compatibility export is needed for reviewability, document it and remove it as soon as downstream imports are updated.

## Current cleanup status
The initial feature moves are complete for several high-weight surfaces, including tasks, chat, routing, settings, dashboard, observability, and telemetry page modules.

Residual cleanup after the large moves should follow these rules:
- delete duplicate or abandoned components once the feature-owned version is the only in-repo consumer
- treat route files that still point at `ui/components/*` page containers as follow-up move candidates into `ui/features/*`
- prefer removing compatibility clutter over keeping parallel implementations with overlapping names
- when adding repo-level verification commands for refactor work, make sure they are runnable in the same deployed environment QA uses, or document clearly that they are worktree-only checks rather than lease-target gates

The next consistency bar is simple:
- import feature-owned modules from `ui/features/*`
- reserve `ui/components/*` for truly shared components
- keep this document aligned with the real folder structure as more routes are split

## Known follow-up candidates
These are the kinds of files that still deserve review when continuing the refactor:
- duplicate UI controls where both `ui/components/*` and `ui/features/*` versions exist for the same job
- page-sized screens still living under `ui/components/*`
- app-shell shared components that are importing feature-owned behavior and may deserve a clearer home over time

When cleaning these up, prefer one ownership move at a time so deploy and QA evidence stay easy to trust.

## Verification boundary note
The UI-folder refactor added narrow non-interactive checks around shared status helpers. Those checks are useful because they avoid full-app lint noise, but they still depend on lint tooling being present wherever QA is expected to run them.

Practical rule:
- if QA is expected to run `npm run verify` on a lease-selected deployed checkout, the deploy artifact must include the tools that command needs
- if the deployed environment intentionally excludes those tools, QA should validate with a different committed command that matches the deployed runtime contract

Do not rely on undeclared assumptions about devDependencies being present in shared Dev.
