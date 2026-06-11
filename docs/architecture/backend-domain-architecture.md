# Backend domain architecture

This document closes the first backend domain-refactor pass by making the ownership model explicit.

## Goal

New backend business logic should land in an owning domain slice instead of growing `api/src/lib` into a second catch-all layer.

## Domain owners

### `api/src/domains/tasks`
- Task read and write models
- Task history and context assembly
- Task release and evidence-aware task semantics
- Task request-actor helpers

### `api/src/domains/routing`
- Routing transitions and requirements
- Status policy and task-type workflow rules
- Routing admin/config CRUD

### `api/src/domains/sprint-definitions`
- Sprint types and allowed task types
- Task field schemas
- Configured outcomes and workflow metadata
- Sprint-definition router helpers

### `api/src/domains/runs`
- Run and instance lifecycle helpers
- Runtime-end reconciliation
- Transcript providers and OpenClaw transcript backfill
- Token usage and token backfill

### `api/src/domains/sprints`
- Sprint CRUD/admin flows
- Sprint lifecycle read models and admin helpers

### `api/src/domains/chat`
- Canonical chat-session helpers and session-facing read models

## Placement rules

1. New business logic goes in `domains/<domain>`.
2. `routes/` should stay transport-focused.
3. `services/` should coordinate domains, runtimes, and dispatch flows without becoming a new ownership layer.
4. `lib/` is reserved for:
   - generic/shared utilities,
   - shared vocabularies and low-level adapters,
   - temporary compatibility exports during migration.

## `api/src/lib` boundary rules

- If a file owns domain behavior, move or collapse it into `domains/<domain>`.
- If an old import path still matters during the migration, keep a thin `lib/` re-export and mark it as a compatibility export.
- New internal imports should target the owner path, not the compatibility path.
- If no owner domain exists yet, the file may stay in `lib/` only when it is truly cross-domain or infrastructure-oriented.

## Current phase-0 leftovers

The remaining non-compat `lib/` files fall into two buckets:

- **Intentional shared utilities** such as auth helpers, workspace/runtime adapters, shared vocabularies, and gateway/OpenClaw integration helpers.
- **Follow-up domain moves** such as `taskOutcome.ts`, `taskRelease.ts`, `taskLifecycle.ts`, `taskStop.ts`, `taskNotifications.ts`, `canonicalSessions.ts`, `reflectionContext.ts`, `gatewayTranscriptCapture.ts`, `projectAudit.ts`, and `sprintWorkflow.ts`.

Those follow-up files are intentionally left in place for this cleanup pass so task #482 does not become another broad migration.

## Audit reference

See `api/src/lib/README.md` for the file-by-file classification used in this pass.
