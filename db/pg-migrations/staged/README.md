# Staged migrations

These are written and reviewed but deliberately **not** applied, and must stay out of the
migration sequence the boot verifier checks. `loadMigrations` reads `*.sql` from its directory
and does not recurse, so files here are invisible to it — which is the point.

A migration in the parent directory means "this must be applied, and the API refuses to serve
until it is". A migration here means "this is ready for a project that has not started yet".
Conflating the two is why `verifyStartupSchema` was once pointed only at the detached generated
baseline: with `10` and `11` sitting in the active sequence unapplied, verifying the real
directory would have refused to boot production, so verification was aimed somewhere it could
not fail. The baseline is now migration 00 in the active directory, so every active migration is
boot-gated and only this staged subdirectory is ignored.

## What is here

- `10-rename-legacy-terminology.sql`, `11-rename-compatibility-views.sql` — the
  `sprint_*` → `workflow_*` physical rename. Deferred by AD-2 in
  `docs/postgres-migration-plan.md` and still deferred by
  `docs/postgres-only-migration-spec.md`: the application writes `sprint_*` names, so applying
  these would break it. They move back one directory up when that project starts.

## Promoting one

Move the file to `db/pg-migrations/`, renumber it above the highest applied migration if
anything has landed since, and run `npm run db:migrate`.
