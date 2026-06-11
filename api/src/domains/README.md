# Backend domain ownership

`api/src/domains` is the source-of-truth home for backend business logic.

## Current domain slices
- `tasks/` — task read/write models, release semantics, task context, task history, request-actor helpers.
- `routing/` — status policy, transitions, requirements, routing admin/config flows.
- `sprint-definitions/` — sprint types, field schemas, configured outcomes, workflow metadata, sprint-type router helpers.
- `runs/` — instance lifecycle helpers, transcript providers, token usage/backfill, runtime-end reconciliation.
- `sprints/` — sprint CRUD/admin and sprint-specific lifecycle helpers.
- `chat/` — canonical chat-session helpers.

## Placement rules
- Put new backend business logic in the owning `domains/<domain>` slice.
- Keep `routes/` focused on transport concerns: request parsing, HTTP responses, auth wiring.
- Keep `services/` focused on orchestration and cross-domain flows.
- Keep `lib/` limited to generic/shared utilities, shared vocabularies, runtime adapters, and temporary compatibility exports.

## Compatibility rule
- New internal imports should target the owning domain path directly.
- Use a `lib/` re-export only when preserving an older path is materially useful during migration.
- When a `lib/` file becomes a compatibility export, mark it as such in the file header.

See `docs/architecture/backend-domain-architecture.md` for the current layout and `api/src/lib/README.md` for the phase-0 lib audit.
