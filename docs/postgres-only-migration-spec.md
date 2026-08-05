# Agent HQ — PostgreSQL-only migration and SQLite removal

Status: completed and deployed
Completed: 2026-08-05
Supersedes: the "After Phase 8 / step 9" item in `docs/postgres-migration-plan.md`

## Purpose

Agent HQ now uses PostgreSQL 17 as its only system-of-record database in production,
development, tests, native installs, and container installs. The old Agent HQ SQLite runtime,
schema engine, SQL translation layer, and transfer/repair utilities have been removed from the
release.

This release also fixes the configuration-ownership bug exposed by the graph UI. Starter routing
configuration is created only at an explicit installation boundary. After installation,
transitions, requirements, statuses, mappings, and rules belong to the operator. Deleting one is a
durable configuration change; reads, route evaluation, routing changes, API restarts, and schema
migrations do not recreate it. The obsolete graph warning was removed with that behavior.

## Release invariants

1. PostgreSQL 17 is the only Agent HQ database engine.
2. `db/pg-migrations/` is the only schema authority.
3. API startup and migration status are read-only.
4. Schema changes occur only through explicit `db:install` or `db:migrate` commands.
5. Starter configuration is generated only by an explicit install or operator-requested reinstall.
6. Ordinary runtime activity never reconciles or restores starter configuration.
7. Applied SQL migrations are immutable and their checksums are verified.
8. Existing SQLite files, PostgreSQL dumps, and cutover evidence are retained.

## Delivered architecture

### PostgreSQL-only runtime, tests, and CI

`api/src/db/client.ts` requires `DATABASE_URL` or `AGENT_HQ_DATABASE_URL` and opens only a
`PostgresAdapter`. The Agent HQ `SqliteAdapter`, SQLite dialect translator, `initSchema`, SQLite
repair engine, and engine-selection branches are gone.

The Jest harness requires `AGENT_HQ_TEST_PG_URL` and clones PostgreSQL worker databases. CI runs
against PostgreSQL 17. Portability guards prevent application code from reintroducing SQLite SQL
or raw `better-sqlite3` access outside the documented OpenClaw exception.

### One schema and migration authority

`db/pg-migrations/00-baseline.sql` is the folded baseline. Active numbered migrations live in the
same directory; deferred terminology-renaming migrations remain under `staged/` and are not
loaded.

An existing database can adopt migration 00 only during explicit migration and only when the
three historical ledger entries have their exact immutable checksums. Partial, changed, pending,
or unknown migration history fails closed. Startup and status never perform adoption or modify the
ledger.

Migration `17-skill-package-files-and-content-repair.sql` was already part of production history
and remains byte-for-byte immutable. Migration `18-runtime-event-tenant-and-integrity-types.sql`
adds the runtime ownership/integrity schema. Migration
`19-backfill-legacy-tenant-ownership.sql` performs the one-time legacy ownership repair when data
requires it, preserves the folded baseline's intended nullability, and does nothing to an empty
uninstalled database. Migration 19 does not seed, delete, or recreate configuration.

The deployed migration 19 runner checksum is `de968393512bcad9`; its file SHA-256 is
`60a3eca94aad098c7cc11a5780e28bc04a6a3f303cbc6a940663fb24d8d34152`.

### Read-only startup and strict ownership writes

Before opening listeners or background writers, the API verifies that the migration ledger is
current and that required installed records and tenant ownership are valid. A missing or stale
installation fails with an actionable error. Startup does not create tables, apply migrations,
repair data, backfill ownership, update ledger rows, or seed configuration.

Runtime writes now derive tenant ownership from their linked instance, agent, task, project, or
request scope and reject conflicts or unresolved ownership. This includes chat messages, task
history and notes, job instances, outcome metrics, routing rules, sessions, and runtime logs.

### Install-only starter configuration

`db:migrate` applies schema SQL only. `db:install` may create the initial tenant and starter
configuration only when no tenant exists. Re-running install after a tenant exists leaves
configuration unchanged. An explicit default-package reinstall may recreate starter rows because
the operator requested it; no ordinary code path has that authority.

The durable behavior is:

```text
explicit install (once) -> create starter configuration
normal reads/writes     -> never reconcile starter configuration
explicit reinstall      -> recreate only on operator request
```

Deletion durability was exercised in both development deployments: a starter transition was
deleted through the API, remained absent after API restart in PostgreSQL and through the API, and
was then restored explicitly to avoid altering the retained environment data.

### Docker, native CLI, and process configuration

Both Compose surfaces bundle PostgreSQL 17 and run migrations before the API. Named volumes retain
the PostgreSQL cluster, workspaces, editable contracts, and uploads. An external PostgreSQL 17
server remains supported through an explicit URL. `docker compose down -v` removes those volumes
and is therefore destructive.

The CLI is Docker-first. Explicit native mode (`--no-docker`) requires a PostgreSQL URL and has no
SQLite fallback. PM2 configurations execute the API and UI commands directly so a restart does not
misinterpret the Node executable as an NVM version.

### Intentional external SQLite exception

`better-sqlite3` remains only for `api/src/lib/openclawOAuthProfiles.ts` and its tests. That module
interoperates with OpenClaw-owned provider and auth-profile stores. Those files belong to another
product and are not an Agent HQ data engine. The portability guard rejects the dependency
everywhere else.

## Verification and cutover record

The final committed runtime was verified with:

- API: 164 suites and 1,533 tests passed; lint and build passed.
- UI: 176 tests passed; lint and production build passed.
- CLI: 17 tests passed.
- Development 1: 71 tables, 1,658,504 rows, 295 indexes, and 130 foreign keys transferred with
  zero row-count mismatches; health and core API/UI checks passed.
- Development 2: 68 tables, 5,777 rows, 295 indexes, and 130 foreign keys transferred with zero
  row-count mismatches; health and core API/UI checks passed.
- Production: the exact pre-release dump was restored to a scratch database and compared before
  migrations; the final release, migrations, health, projects, tasks, routing configuration, and UI
  checks passed.
- Production and both development databases are current through migration 19 and contain no
  NULL-owned rows in the audited runtime ownership columns.
- `OPENCLAW_HOOKS_TOKEN` was rotated atomically across Agent HQ and OpenClaw without printing or
  committing it. The new credential was accepted, the previous credential rejected, and all three
  APIs returned 200 after restart.

The implementation commits are `61e9e289` (PostgreSQL-only migration) and `c0d6116f` (legacy
ownership repair and strict runtime writes). This completion record accompanies the final release
history.

## Retained recovery artifacts

Old development checkouts and their original SQLite databases remain intact. Verified cutover
artifacts and reports are retained under:

- `backups/cutover/20260805T051421Z/` for production and development 1;
- `backups/cutover/20260805T054835Z-dev2/` for development 2.

The production pre-release dump is
`backups/cutover/20260805T051421Z/agent_hq_prod-before-release.dump`, with SHA-256
`ecaa780a0a718339d3eb9b1e70539b7887533089bddaf76e241877c53bab305c`.

The clean release worktrees are:

- `/Users/nordini/agent-hq-prod-main`;
- `/Users/nordini/agent-hq-dev-main`;
- `/Users/nordini/agent-hq-dev-2-main`.

## Completion checklist

- [x] PostgreSQL-only runtime adapter and environment contract.
- [x] PostgreSQL-only Jest harness and PostgreSQL 17 CI service.
- [x] Folded baseline and a single active migration directory.
- [x] Exact legacy-baseline adoption with read-only boot and status behavior.
- [x] Install-only starter configuration and no automatic route reseeding.
- [x] Graph warning removed.
- [x] Strict tenant ownership for runtime writes and one-time legacy repair.
- [x] Bundled PostgreSQL 17 Compose deployment and persistent data volumes.
- [x] Docker-first CLI; native mode requires PostgreSQL.
- [x] External OpenClaw SQLite access isolated and documented.
- [x] Full API, UI, and CLI verification passed.
- [x] Fresh verified backups retained; original SQLite files preserved.
- [x] Both dev deployments moved to clean official-main worktrees and PostgreSQL databases.
- [x] Transition deletion durability verified across API restarts.
- [x] Exact migrations deployed and production functional checks passed.
- [x] Shared OpenClaw hook token rotated and smoke-tested.
- [x] Verified release committed on `main`.

## Ongoing guardrails

- Never edit an applied migration to change a recorded checksum.
- Never use API startup as a migration or installation mechanism.
- Never call starter installers from routing reads, writes, or background jobs.
- Never recreate deleted configuration without an explicit install/reinstall request.
- Never treat OpenClaw-owned SQLite files as an Agent HQ storage option.
- Retain the cutover artifacts until an operator separately approves their removal.
