# PostgreSQL-only migration — completion handoff

Updated 2026-08-05. Companion to `docs/postgres-only-migration-spec.md`.

## Current state

The PostgreSQL-only release is implemented, verified, cut over in both development environments,
and deployed to production. Agent HQ uses PostgreSQL 17 as its system of record everywhere.
Production and both clean dev worktrees run the runtime tree from commit `c0d6116f`; the final
release history adds this completion documentation without changing that runtime.

All old development checkouts, original SQLite files, verified PostgreSQL dumps, repaired transfer
copies, and cutover reports were retained. They were not deleted or overwritten.

## Configuration ownership contract

Starter configuration is installation data, not continuously enforced policy:

```text
explicit install (once) -> create starter configuration
normal reads/writes     -> never reconcile starter configuration
explicit reinstall      -> recreate only because the operator requested it
```

A transition, requirement, status, mapping, or routing rule deleted after installation stays
deleted. The graph UI warning was removed because the automatic recreation behavior no longer
exists. Deletion persistence was verified in both clean dev deployments across API restarts.

## Schema and ownership state

- `db/pg-migrations/` is the sole schema authority; `00-baseline.sql` is the fresh-install
  baseline and deferred terminology migrations remain inactive under `staged/`.
- Startup and migration status are read-only. Explicit `db:install` and `db:migrate` are the only
  schema/installation boundaries.
- Historical baseline adoption requires the exact three legacy checksums. Changed, partial,
  pending, or unknown ledger state fails closed.
- Applied migration 17 remains immutable.
- Migration 18 supplies the runtime tenant/integrity schema.
- Migration 19 repairs historical ownership only when required, preserves intended column
  nullability, and does not seed configuration. Its deployed runner checksum is
  `de968393512bcad9`.
- Runtime writes derive ownership from linked records/request scope and reject missing or
  conflicting tenants. Audited production and dev runtime tables contain no NULL-owned data.

## Verification evidence

Final code verification:

- API: 164/164 suites and 1,533/1,533 tests; lint and build passed.
- UI: 176/176 tests; lint and production build passed.
- CLI: 17/17 tests.
- Repository whitespace validation passed.

Operational verification:

- Production and both development APIs return 200 from health checks.
- Production projects, tasks, routing configuration, and UI routes return 200.
- Both development deployments passed UI and core API/routing smoke tests.
- Each dev deployment passed an API delete, restart, database/API absence check, and explicit
  restoration of a starter transition.
- Migration ledgers in production and both dev databases are current through migration 19 with the
  expected checksum.
- The hook credential was rotated without exposing it: the new token was accepted, the old token
  was rejected, and all affected APIs recovered healthy.

## Deployment locations

Clean release worktrees:

- Production: `/Users/nordini/agent-hq-prod-main`
- Development 1: `/Users/nordini/agent-hq-dev-main`
- Development 2: `/Users/nordini/agent-hq-dev-2-main`

Preserved divergent development checkouts:

- `/Users/nordini/agent-hq-dev`
- `/Users/nordini/agent-hq-dev-2`

Backup and report directories:

- `/Users/nordini/agent-hq/backups/cutover/20260805T051421Z`
- `/Users/nordini/agent-hq/backups/cutover/20260805T054835Z-dev2`

The first directory contains the verified production pre-release dump, development 1 SQLite and
PostgreSQL artifacts, `CUTOVER-REPORT.md`, and `SHA256SUMS`. The second contains development 2
artifacts and its completion report. Sensitive artifacts and reports remain untracked inside
access-restricted backup directories.

## Data-transfer results

Development 1 loaded 71 tables and 1,658,504 rows with zero source-to-target count mismatches,
plus 295 indexes and 130 foreign keys. Its final representative counts include 54 projects, 133
sprints, 524 tasks, 209 agents, 5,109 jobs, 2,570 transitions, 924 scoped requirements, and 1,578
routing rules.

Development 2 loaded 68 tables and 5,777 rows with zero source-to-target count mismatches, plus 295
indexes and 130 foreign keys. Its final representative counts include 25 projects, 39 sprints, 24
tasks, 125 agents, 2 jobs, 703 transitions, 438 scoped requirements, and 594 routing rules.

Production's pre-release dump was restored into a scratch database before migration. Its critical
counts matched production: 8 projects, 44 sprints, 616 tasks, 68 agents, 7,860 jobs, 904
transitions, 217 requirements, and 496 routing rules.

## Release commits

- `61e9e289a6806292a2a701b9ead947bcf6d868fa` — PostgreSQL-only runtime, migration system,
  install-only starter configuration, graph warning removal, tests, CI, Docker, and CLI.
- `c0d6116f26e11619ea9855827b74a1d01adbd0c2` — legacy tenant ownership repair, strict runtime
  tenant writes, PM2 launch correction, and regression fixtures.
- The final documentation commit records the completed cutover.

## Ongoing operational rules

- Run explicit migration commands before starting a release with pending migrations.
- Do not edit an applied migration or weaken its checksum validation.
- Do not use startup, reads, routing changes, or background work to reconcile starter data.
- Do not run `docker compose down -v` during routine restarts; it deletes named data volumes.
- Keep the OpenClaw `better-sqlite3` exception isolated to its interoperability module.
- Preserve the retained SQLite files and cutover backups until separately approved for cleanup.
