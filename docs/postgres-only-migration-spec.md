# Agent HQ — PostgreSQL-only migration and SQLite removal

Status: implementation in progress; core code is present, final verification and cutover pending
Last updated: 2026-08-04
Supersedes: the "After Phase 8 / step 9" item in `docs/postgres-migration-plan.md`

## Purpose

The release contract is that Agent HQ's system of record is PostgreSQL everywhere: production,
development, tests, native installs, and container installs. The old SQLite schema engine and SQL
translation layer are no longer runtime alternatives in the new code. Existing dev processes still
need their operational cutover before the deployment fully matches that contract.

This change also closes a configuration-ownership bug exposed by the graph UI. Starter routing
configuration is installed at an explicit installation boundary. After that, transitions,
requirements, statuses, mappings, and rules belong to the operator. Deleting one is a durable
configuration change; a later read, route evaluation, API restart, or schema migration must not
recreate it.

The code change is present in the shared worktree. The old dev deployments, production release,
fresh backups, full verification, commit, and push are still pending in this turn. Nothing in this
document claims those operational steps have already run.

## Required invariants

1. PostgreSQL 17 is the only Agent HQ database engine.
2. `db/pg-migrations/` is the only schema authority.
3. API startup and migration status are strictly read-only.
4. Schema changes happen only through explicit `db:install` or `db:migrate` commands.
5. Starter configuration is generated only by an explicit install operation. Once installed,
   ordinary application activity never reconciles or restores it.
6. Applied SQL migrations are immutable, including migrations unrelated to this project.
7. Existing SQLite files and PostgreSQL dumps are retained through cutover and verification.

## Implemented architecture

### PostgreSQL-only runtime, tests, and CI

`api/src/db/client.ts` now requires `DATABASE_URL` or `AGENT_HQ_DATABASE_URL` and opens only a
`PostgresAdapter`. `SqliteAdapter`, the SQLite dialect translator, `initSchema`, the SQLite repair
engine, and engine-selection branches have been removed from the working tree.

The Jest harness requires `AGENT_HQ_TEST_PG_URL`, clones PostgreSQL worker databases, and has no
SQLite fallback. CI supplies PostgreSQL 17 and runs the API lint, full test command, and build
against that service. Tests may still use SQLite-shaped mock objects when testing an isolated
adapter contract; those mocks are not a data engine.

SQL portability checks prevent application code from reintroducing SQLite-only SQL or raw
`better-sqlite3` access outside the explicit OpenClaw exception below.

### One migration directory

`db/pg-migrations/00-baseline.sql` is the folded baseline. The former
`db/pg-baseline/{01-tables,02-indexes,03-foreign-keys}.sql` files are no longer a second schema
authority. Active numbered migrations live beside `00-baseline.sql`; deferred rename migrations
remain under `db/pg-migrations/staged/` and are not loaded.

Existing databases can adopt migration 00 only through the explicit migration runner and only
when all three historical ledger rows have the exact known immutable checksums. Partial or changed
legacy ledgers fail closed. The historical `init_schema` provenance row is tolerated only with its
exact known value. Boot and status never perform this adoption.

The ledger check also rejects applied migration IDs that the running release does not own. This
prevents an older release from booting after a newer migration has already been applied.

`17-skill-package-files-and-content-repair.sql` is unrelated to the PostgreSQL-only migration, but
it has already been recorded in the production ledger. It must remain byte-for-byte exact and must
ship with the release; do not rewrite, squash, renumber, or omit it while cleaning up this project.
It remains a one-time, explicitly applied historical migration, not permission to add continuous
configuration reconciliation.

### Read-only startup

API startup awaits two checks before starting listeners or background writers:

- the migration ledger must have no pending, changed, or unknown entries;
- tenant ownership and required installed records must validate without writes.

A missing or stale installation is rejected with an actionable install/migration error. Startup
does not create tables, update ledger rows, repair ownership, backfill data, or seed configuration.
The compatibility name `ensureTenantSchema` is validation-only.

### Install-only starter configuration

`db:migrate` applies schema SQL only. It never creates or reconciles starter configuration.

`db:install` may create initial configuration only when the database has no tenant. The installer
locks the tenant table, creates the first tenant, applies the default install package, and records
the installation. Running it again after a tenant exists leaves configuration unchanged.

Tenant/starter onboarding is likewise an explicit installation action. An explicitly requested
default-package reinstall is allowed to recreate starter rows because the operator directly asked
for a reinstall; it is not an automatic repair path.

Ordinary routing and graph operations do not call starter seeders. In particular:

- listing or evaluating routes does not recreate transitions, statuses, rules, or requirements;
- deleting a seeded transition or requirement remains deleted;
- API restart and subsequent workflow routing do not restore deleted starter rows;
- the graph UI warning that claimed a routing change might recreate a starter transition has been
  removed because that behavior is no longer part of the system contract.

### Docker and CLI defaults

Both Compose surfaces bundle PostgreSQL 17 by default and run migrations before the API. They use
four named volumes:

- `agent-hq-postgres-data` for the PostgreSQL cluster;
- `agent-hq-workspaces` for operator and agent workspace files;
- `agent-hq-contracts` for editable task-contract templates.
- `agent-hq-uploads` for project, workflow, task, and chat attachment files.

An external PostgreSQL 17 server remains supported through an explicit `DATABASE_URL`. Removing
Compose volumes removes all four data classes, so `docker compose down -v` is destructive.

The CLI uses Docker by default when Docker is available. Native mode is explicit (`--no-docker`)
and refuses to start without `DATABASE_URL` or `AGENT_HQ_DATABASE_URL`; there is no local SQLite
fallback.

## Intentional external SQLite exception

`better-sqlite3` remains a dependency only for `api/src/lib/openclawOAuthProfiles.ts` and its
tests. That module interoperates with OpenClaw-owned SQLite files: one path reads OpenClaw provider
metadata and the OAuth synchronization path writes OpenClaw's auth-profile store. These databases
belong to another product and are not Agent HQ's system of record.

This is an intentional external read/write integration exception, not a second Agent HQ engine.
The portability lint should continue to reject `better-sqlite3` imports everywhere else.

## Retired transfer and repair tooling

The SQLite-to-PostgreSQL transfer scripts, snapshot baseline generator, SQLite repair tools, and
migration codemods were temporary project tooling. Their deletion is part of this release, but the
last dev data transfer and its verification must finish first (using the preserved old checkout or
pre-removal copy where necessary). Permanent PostgreSQL migration, backup, status, and smoke-test
tooling stays.

Do not delete old `.db`, WAL, backup, or dump files as part of code cleanup. File retention is an
operational decision after the new dev and production deployments have passed verification.

## Settled decisions and rationale

### Real PostgreSQL, not PGlite

The earlier migration plan proposed PGlite for development and tests. It was never adopted, and it
would not exercise the multi-connection behavior used by dispatchers, schedulers, reconcilers, and
watchdogs. Using PostgreSQL 17 in CI and Docker tests the same engine and major version as
production.

### Migrations, not a boot-time repair engine

The former `initSchema` implementation inspected live state and changed it on boot. That made the
schema depend on history and mixed schema evolution with configuration seeding. Numbered,
checksummed migrations make schema state reviewable and drift detectable. They are applied once by
an explicit command.

### Operator ownership after install

Starter data is a template, not policy continuously enforced by Agent HQ. Automatic reconciliation
made a legitimate delete appear temporary and was the reason for the graph warning. The new
boundary is simple: install creates; normal operation reads and changes only what the operator
requested.

### Deferred schema modernization

The `sprint` to `workflow` rename and PostgreSQL type tightening remain separate projects. Mixing
renames or broad type changes into engine removal would make data comparison and rollback harder.
The staged migrations are therefore still intentionally inactive.

## Completion checklist

Code-shape items are implemented in the shared worktree; they are not considered released until
the remaining checks finish.

- [x] PostgreSQL-only runtime adapter and environment contract.
- [x] PostgreSQL-only Jest harness and PostgreSQL 17 CI service.
- [x] Folded `00-baseline.sql` and a single active migration directory.
- [x] Exact, explicit legacy-baseline adoption with read-only boot/status behavior.
- [x] Install-only starter configuration and no ordinary route reseeding.
- [x] Graph warning removed.
- [x] Bundled PostgreSQL 17 Compose deployment and persistent database/workspace/contract volumes.
- [x] Docker-first CLI; native mode requires a PostgreSQL URL.
- [x] External OpenClaw SQLite access isolated and documented.
- [ ] Complete the API test/lint/build verification for the final combined worktree.
- [ ] Take fresh backups and preserve all existing SQLite and PostgreSQL backup artifacts.
- [ ] Move both old dev deployments to clean official-main checkouts and PostgreSQL databases.
- [ ] Verify dev behavior and data before retiring the final transfer tooling.
- [ ] Apply/verify the exact migration set and deploy the production release.
- [ ] Rotate the shared OpenClaw hooks token and smoke-test integrations.
- [ ] Commit and push the verified release to `origin/main`.

## Abort conditions

Stop the cutover without deleting backups if any of these occur:

- a migration checksum or unknown-ledger error cannot be explained by the exact release contents;
- dev or production row-count/data comparisons do not match the documented migration scope;
- startup writes schema or starter configuration;
- a deleted starter transition returns without an explicit install/reinstall request;
- the full PostgreSQL suite, build, or deployment smoke checks fail.
