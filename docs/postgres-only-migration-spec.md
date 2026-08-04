# Agent HQ — Postgres-only migration and SQLite removal

Status: proposed
Last updated: 2026-08-04
Supersedes: the "After Phase 8 / step 9" line item in `docs/postgres-migration-plan.md`

## Scope of this document

`docs/postgres-migration-plan.md` (2026-07-28) planned the move onto PostgreSQL in nine phases and
ended with a single step 9: *"Only after stabilization closes: remove the SQLite engine
implementation and `better-sqlite3`."* Production cut over on 2026-07-29 and has been serving from
`agent_hq_prod` since. That one line is the entire remaining project, and it is much larger than one
line — this document specifies it.

Every number below was measured on 2026-08-04 against this worktree and the live production
database. Anything not established is marked **[open]** rather than guessed.

## What changed versus the migration plan

Two of the plan's three architecture decisions were not executed as written. The spec has to start
from what was actually built.

**AD-3 (PGlite for dev and test) was not implemented.** There is no PGlite dependency. What shipped
instead is an engine adapter (`api/src/db/adapter/`, 1,836 lines) with a **843-line SQLite→Postgres
SQL translator** (`dialect.ts`), so one SQLite-dialect codebase runs on both engines. That is a
different architecture with a different retirement path: the plan's step 9 assumed deleting an
implementation, whereas the real work is deleting a *translation layer* and rewriting the SQL it was
translating.

**The plan's Phase 2 SQL portability sweep did not happen.** It was scoped at 411 `datetime('now')`
sites. Today there are **962** across `api/src`, 352 of them in application code outside `schema.ts`
and the adapter. The translator absorbed the problem rather than the sweep removing it.

**AD-1 (async conversion) and AD-2 (defer the `sprint`→`workflow` rename) held.** The data layer is
async, and `db/pg-migrations/10` and `11` — the rename migrations — remain staged and unapplied
because the application still writes `sprint_*` names.

## Where we actually are

Production (`agent_hq_prod`, PostgreSQL 17): 71 tables, 224 indexes, 130 foreign keys, from
`db/pg-baseline/`. `getEngine()` returns `postgres` because `.env` sets `DATABASE_URL`;
`AGENT_HQ_DB_PATH` is deliberately left set beside it as a one-line rollback to the SQLite file,
frozen at cutover (`~/.agent-hq/agent-hq.db`, 2.87 GB, mtime Jul 30, zero-length WAL).

| Surface | Measure |
|---|---:|
| `api/src/db/` total | 13,643 lines / 45 files |
| `api/src/db/schema.ts` (`initSchema`) | **6,396 lines** |
| `api/src/db/adapter/dialect.ts` | **843 lines** |
| Test files under `api/src` | **160** |
| — SQLite-pinned | **104** (65%) |
| — touching the Postgres harness | 18 (11%), of which 6 Postgres-only |
| — engine-neutral | 50 (31%) |
| Postgres coverage in CI | **1 file, 12 tests, 0.25 s** |
| `datetime('now')` in app code (excl. `schema.ts`, adapter, tests) | 352 |
| `PRAGMA` in app code | 62 |
| `INSERT OR IGNORE` in app code | 30 |
| Raw `.prepare()` still held outside the adapter | 347 across 12 files |
| Dev instances still on SQLite | 2 (`agent-hq-dev`, `agent-hq-dev-2`) |

The headline is the CI row. `npm test` runs all 160 files **entirely on SQLite**; a single extra job
runs `adapter.postgres.test.ts` against Postgres. A green suite is therefore evidence about SQLite,
not about the engine production runs. `.github/workflows/ci.yml:58` already says so in a comment.

## Three defects to fix now, independent of this project

These are live and do not depend on any decision below. **All three were fixed on 2026-08-04.**

**P0-1 — Production Postgres has no backup. FIXED 2026-08-04.** The only backup job is
`~/Library/LaunchAgents/com.atlas-hq.backup.plist` → `scripts/backup-db.sh`, which runs
`sqlite3 "$DB_PATH" ".backup ..."` against `${AGENT_HQ_DB_PATH:-~/.agent-hq/agent-hq.db}` — the
*frozen pre-cutover SQLite file*. It has produced six identical 2.87 GB copies of a database
production no longer writes to, most recently Aug 4 02:00. There is no `pg_dump` or
`pg_basebackup` anywhere in `scripts/`, cron, or launchd. The rollback target is a Jul 30 snapshot;
everything written to Postgres since is unrecoverable. `docs/BACKUP_RESTORE.md` records an April 2026
incident — an API restart against an empty database, 700+ tasks lost, no backup — which is the same
failure with the same cause.

*Resolution:* `scripts/backup-pg.sh` takes a `pg_dump --format=custom` of `agent_hq_prod`, checks the
archive's table of contents on every run, and under `--verify` restores into a scratch database and
compares row counts against the source before dropping it. The launchd job now runs it with
`--verify` at 02:00. First run: 1657 MB → 374 MB, 683 TOC entries, and a **performed** restore
matching source counts on all seven checked tables (`tasks` 615, `projects` 8, `agents` 67, `sprints`
44, `sprint_task_transitions` 902, `sprint_task_routing_rules` 495,
`sprint_task_transition_requirements` 170). `backup-db.sh` now refuses to run without an explicit
override.

**P0-2 — `verifyMigrationsCurrent` is pointed at the wrong directory. FIXED 2026-08-04.** `startupVerifier.ts:181`
passes `db/pg-baseline`, which contains only `01`–`03`. `db/pg-migrations/*.sql` is therefore never
verified at boot, so a pending migration does not block startup — the exact guarantee the
non-mutating startup contract exists to provide.

*Root cause, and why it is not a one-line fix:* migrations `10` and `11` sit in the sequence
deliberately unapplied (AD-2 defers the rename), so verifying the real directory would have refused
to boot production. The check was aimed where it could not fail. Both files now live in
`db/pg-migrations/staged/`, which `loadMigrations` does not read, and the verifier takes both
directories. Proven against the production ledger: 6 applied / 0 pending / 0 drifted boots, and an
unapplied migration raises `MigrationPendingError`.

**P0-3 — Dev `.env` files point at production. FIXED 2026-08-04.** Both `~/agent-hq-dev/.env` and
`~/agent-hq-dev-2/.env` set `AGENT_HQ_DB_PATH=/Users/nordini/.agent-hq/agent-hq.db` and
`PORT=3501`/`UI_PORT=3500` — production's file and ports. The running processes use different values,
so they were started from older config; `ecosystem.dev.config.js` reads
`env.AGENT_HQ_DB_PATH || <repo>/agent-hq-dev.db`, so a plain `pm2 restart` would attach a dev API to
the production SQLite file.

*Resolution:* both files now carry the ports and database paths their processes actually use (3511/3510
and 3521/3520, each with its own local `.db`), verified by restarting both APIs and confirming they
came back on their own databases with the production SQLite file untouched. **Still open:** both `.env`
files carry production's live `OPENCLAW_HOOKS_TOKEN`; rotating it needs to be coordinated with whatever
consumes it.

## What "Postgres-only" means, and what it does not

**In scope:** Agent HQ's own system of record is PostgreSQL everywhere — production, both dev
instances, local development, and the test suite. `initSchema`, `dialect.ts`, `SqliteAdapter`, the
SQLite branches of the test harness, and the SQLite-shaped CLI commands are deleted. Application SQL
is written in PostgreSQL dialect rather than translated into it.

**Not in scope — and this is a real constraint:** `better-sqlite3` cannot leave `dependencies`.
`api/src/lib/openclawOAuthProfiles.ts` opens **external OpenClaw SQLite files** read-only
(`new Database(filePath, { readonly: true, fileMustExist: true })` at lines 334 and 611). Those are
another product's databases. "Postgres-only" is a statement about Agent HQ's own data, not about the
absence of a SQLite library, and the plan's step 9 wording ("remove … `better-sqlite3`") is wrong on
that point. The dependency stays; what leaves is every use of it in the data layer.

Also out of scope: the `sprint`→`workflow` rename (AD-2 still holds — `db/pg-migrations/10` and `11`
stay staged), and converting `text` timestamps to `timestamptz` / `bigint` flags to `boolean` /
`text` JSON to `jsonb`. The baseline is deliberately 556 `text` + 323 `bigint` with **zero**
`boolean`, `jsonb` or `timestamptz` columns, and `db/pg-baseline/deferred-type-tightening.json`
already records ~30 deferred `jsonb` candidates. Type tightening is a separate project; doing it here
would mean the SQLite removal cannot be validated by comparison.

## Decisions

### D1 — Real PostgreSQL is the test and development engine. PGlite is not adopted.

The plan's AD-3 chose PGlite to preserve zero-dependency `npm install && npm test`. That property is
already gone: production requires a server, `db/pg-baseline` is the only truthful schema, and the
per-worker template-clone fixture (`api/src/db/pg/testFixture.ts`, 198 lines) exists and works today
across 18 files. Adding PGlite now would mean maintaining a *third* engine's quirks to protect a
property the cutover already spent.

It also cannot test what matters. PGlite is single-connection; the dispatcher, reconciler, watchdog
and scheduler contend for the same rows, which was R3 in the original plan and is still unaddressed.

**Cost accepted:** contributors and self-hosters need a PostgreSQL server.
`docs/SELF_HOSTING.md`, both `docker-compose.yml` files and both Dockerfiles currently describe a
SQLite-only deployment and set `AGENT_HQ_DB_PATH=/data/agent-hq.db` with no mention of
`DATABASE_URL`. Phase 4 owns that, and it is not optional — a Docker user today cannot run on
Postgres at all.

### D2 — `db/pg-baseline` + `db/pg-migrations` become the only schema authority. `initSchema` is deleted, not ported.

`initSchema` is not a schema definition. `migrationRunner.ts`'s own header calls it *"a
state-dependent repair engine that inspected the live database on every boot and patched whatever it
found"*, and records that its inline `CREATE TABLE` blocks declared 59 tables / 703 columns while
production actually had 71 / 879. Porting a repair engine to an engine that has never needed
repairing would be porting the bug.

It is also structurally un-portable: line 1 is `import Database from 'better-sqlite3'`, line 790 is
`const db = getRawDb()`, and it uses 22 raw-driver acquisitions, `PRAGMA table_info`,
`PRAGMA foreign_keys` toggling, `sqlite_master`, and SQLite's create-copy-drop-rename rebuild.

### D3 — The Postgres install path is rebuilt **before** anything is deleted.

`npm run db:install` / `db:migrate` is the only supported bootstrap per
`docs/database-migration-runbook.md`, and it **cannot create a Postgres database**. Verified
2026-08-04: with `DATABASE_URL` set to a fresh empty database, `migrate.ts` calls `initSchema()`,
which ignores `DATABASE_URL` entirely and operates on the SQLite file at `resolveDbPath()`, then
`bootstrapRoutingAndWorkflowDefaults(getDb())` fails against the untouched Postgres target with
`relation "projects" does not exist`. The scratch database was left with zero tables.

Postgres schema is applied today by `scripts/pg/provision.mjs` shelling out to `psql -f`.
`runMigrations()` in `api/src/db/pg/migrationRunner.ts` — which applies each migration in its own
transaction and records the ledger properly — **has no caller anywhere in the repo**.

So a fresh clone has no supported way to create a Postgres database, and removing SQLite without
fixing this leaves the repo with no install path at all.

There are also **four** different `schema_migrations` definitions, all `CREATE TABLE IF NOT EXISTS`,
so whichever runs first wins: `db/pg-baseline/01-tables.sql:568` (5 columns, `applied_at text`),
`migrationRunner.ensureLedger()` (4 columns, `applied_at timestamptz`),
`scripts/pg/provision.mjs ensureLedger()` (4 columns, different `applied_by` default), and the
SQLite one written by `migrate.ts`. One definition must win.

### D4 — Tests convert by flipping the default engine, in tranches, with CI as the gate.

The suite is SQLite by default because of one line — `api/src/db/jest-setup-env.ts` sets
`AGENT_HQ_DB_PATH=':memory:'` in every worker. Nothing opts *into* SQLite; 104 files simply inherit
it.

Converting file-by-file while the default stays SQLite means the suite is dual-engine indefinitely
and every conversion is invisible to CI. Instead: make Postgres the default, let the 104 files fail
loudly, and convert them in tranches by directory, with CI running the whole suite on Postgres from
the first tranche onward.

Two pieces of scaffolding already exist and make this cheaper than the file count suggests.
`setupTestDb()` already branches on engine, so files that use it convert for free — that is why 12 of
the 18 harness files are already dual-engine. And `api/src/db/testDb.test.ts` is a meta-test that
greps for unguarded `initSchema(` calls, i.e. a lint against false-green conversions.

The hard subset is the **52 files that construct `new Database(` directly** and the 34 that call
`initSchema()`; those hand-build schemas and need real edits, not a harness swap.

### D5 — `dialect.ts` is retired last, and `findIncompatibilities()` is wired into CI first.

While any SQLite-dialect SQL remains in application code, the translator is load-bearing. It is
retired only after the SQL sweep, and its deletion is the last commit of the project.

But `findIncompatibilities()` — the function that detects the 9 constructs the translator refuses to
translate — **has zero callers on the execution path.** It is exercised only by `adapter.test.ts`.
Anything in that category reaches PostgreSQL verbatim and fails at runtime; `dialect.ts`'s own
comments record that this is exactly how `INSERT OR IGNORE` and `IS ?` reached production. Wiring it
into a build-time lint is a small change that stops the bleeding on day one, and it is Phase 0 work.

Note that one refused construct needs a **caller** change rather than a SQL change:
`api/src/domains/tasks/readModel.ts:413,416` binds a `'$.a.b'` path parameter to `json_extract`, and
PostgreSQL's equivalent takes bare key names.

### D6 — Every environment moves before the code is deleted.

Both dev instances run SQLite, and `ecosystem.dev.config.js` has no `DATABASE_URL` key at all, so a
dev instance cannot be moved to Postgres by editing `.env`. Their data is real (`agent-hq-dev.db` is
1.65 GB with an actively written WAL). They move first, and run on Postgres through a stabilization
window, so the removal commit is not the first time dev exercises the engine.

### D7 — The baseline stops being a generated snapshot and becomes migration 00.

`db/pg-baseline/` is generated from a SQLite file: `scripts/pg/generate-baseline-schema.mjs` takes
a `.db` path and `require`s `better-sqlite3`, and the generated header says *"Do not edit by hand:
regenerate from the snapshot instead."* Once SQLite is gone that instruction cannot be followed —
the baseline becomes a frozen artifact whose provenance story is dead, and whose generator must be
deleted along with everything else that opens a `.db`.

**Decision:** fold `01-tables.sql`, `02-indexes.sql` and `03-foreign-keys.sql` into a single
`db/pg-migrations/00-baseline.sql` and retire the separate baseline directory. Future regeneration
is `pg_dump --schema-only` against production, not a SQLite snapshot.

This also settles the four competing `schema_migrations` definitions (D3): the baseline stops being
a special case that sits outside the migration sequence and creates its own ledger, so exactly one
definition remains — the runner's.

Do this after the SQL sweep and before removal, while `pg_dump` tooling is fresh from Phase 0 and
before the generator is deleted, so the fold can be verified by regenerating and diffing.

## What survives the removal

The migration tooling splits three ways, and only one of the three is permanent.

**Deleted with SQLite.** Twelve of the twenty-one files in `scripts/pg/` are SQLite-coupled —
`provision.mjs`, `migrate-data.mjs`, `purge-orphans.mjs`, `report-orphans.mjs`,
`verify-migration.mjs`, `generate-baseline-schema.mjs`, `analyze-call-sites.mjs` — plus
`scripts/normalize-timestamps.mjs`. They exist to move data out of a `.db` file; with no `.db` file
there is nothing to move.

Sequencing nuance: several of the SQLite-coupled ones are codemods —
`codemod-tests-to-adapter.mjs`, `codemod-to-adapter.mjs`, `fix-from-tsc.mjs`,
`fix-test-handles.mjs` — which are needed **for** Phase 2 and deleted **after** it, not before.

**Kept permanently.** `db/pg-migrations/` and `api/src/db/pg/migrationRunner.ts` have nothing to do
with SQLite; they are ordinary schema evolution and become more central once Phase 1 gives
`runMigrations` its first caller. `migrate.ts` and `migrateStatus.ts` are rewritten, not removed.

**Shrinks but survives.** `dialect.ts` goes from 843 lines to roughly 130. `toPositionalParams`
does its own string-literal scanning and does not depend on the rest of the file, so `?` → `$n`
survives alone while the datetime translation, the `literalMask` machinery the other rewriters
need, and `findIncompatibilities` all go. Keeping `?` placeholders as house style is the obvious
call against rewriting more than three thousand call sites to `$n`.

## Phases

A phase is done when its exit criteria have been demonstrated by a command that was actually run,
with output recorded.

### Phase 0 — Stop the bleeding (P0 defects; no migration work)

- ~~`pg_dump`-based backup of `agent_hq_prod`, on a schedule, with a **restore actually performed**
  into a scratch database and verified. Retire or repoint `scripts/backup-db.sh`.~~ **Done 2026-08-04.**
- ~~Fix `startupVerifier.ts:181` to verify `db/pg-migrations`, and add a test that a pending
  migration blocks boot.~~ **Done 2026-08-04.**
- ~~Fix the two dev `.env` files~~ **done 2026-08-04**; rotate the shared `OPENCLAW_HOOKS_TOKEN`
  (still outstanding).
- Wire `findIncompatibilities()` into a lint over `api/src` and record the current violation count as
  a ratchet.

**Exit:** a Postgres restore has been executed; a pending migration demonstrably fails startup; dev
`.env` no longer names production; the incompatibility lint runs in CI.

### Phase 1 — A working Postgres install path (D3) — **DONE 2026-08-04**

- Give `runMigrations()` a caller: `db:install` / `db:migrate` create and migrate a Postgres database
  from `db/pg-baseline` + `db/pg-migrations`, replacing `psql -f` in `scripts/pg/provision.mjs`.
- Collapse the four `schema_migrations` definitions to one.
- Rewrite `migrateStatus.ts` (currently `sqlite_master` + `PRAGMA integrity_check`) against
  `information_schema`.
- Preserve the non-mutating startup contract verbatim: boot verifies the ledger and refuses on stale
  or missing schema, and never creates, alters, backfills or seeds.

**Exit:** `npm run db:install` builds a complete, correct Postgres schema on an empty database from a
clean clone; the inventory matches production's 71/224/130; `db:migrate:status` works; a stale schema
still fails with `SCHEMA_MIGRATION_REQUIRED`.

*Result:* `db:install` against an empty database applies all six migrations and produces a schema
whose column list and index list are **byte-identical** to production (69 tables / 291 indexes / 130
FKs / 862 columns, diffed). Re-running is a no-op, and `verifyStartupSchema` accepts the result, so
a fresh clone can now create a database the API will serve from. `db:migrate:status` reports
applied/pending/drifted on both engines.

Two defects surfaced doing it. `runMigrations` created the ledger before applying anything, which
made `db/pg-baseline/01-tables.sql` — which declares `schema_migrations` itself, without
`IF NOT EXISTS` — fail on every fresh install; since that file is checksummed and applied in
production it cannot gain the clause, so the runner stops pre-empting it and creates the ledger
after the migration that may have declared it. And `migrateStatus` imported a path constant from
`migrate.ts`, whose top-level `void main()` meant the status command applied migrations as a side
effect of being asked what was applied; the constant moved to a side-effect-free module.

The four competing `schema_migrations` definitions still exist — Phase 3b collapses them.

### Phase 2 — Postgres becomes the default test engine (D4)

- Invert `jest-setup-env.ts`: Postgres by default, SQLite only where a file explicitly asks.
- Convert the 104 SQLite-pinned files in tranches by directory. Replace the 52 hand-built schemas
  with the shared fixture; delete the 34 `initSchema()` calls.
- Replace the hardcoded `APPLIED_MIGRATIONS` list in `pg/testFixture.ts` with a read of
  `db/pg-migrations`, so the fixture cannot drift from production again.
- CI runs the full suite on PostgreSQL 17 from the first tranche.

**Exit:** all 160 files green on Postgres; zero unguarded `initSchema(` in tests; CI's Postgres job
runs the whole suite; `describeSqliteOnly` has no remaining users.

### Phase 3 — SQL portability sweep (the plan's Phase 2, finally)

Rewrite application SQL into PostgreSQL dialect so the translator becomes redundant: 352
`datetime('now')`, 62 `PRAGMA`, 30 `INSERT OR IGNORE`, 18 `sqlite_master`, 14 `julianday` (all in
`routes/telemetry.ts`), 5 `json_set`, 4 `strftime`, 3 `GROUP_CONCAT`, 2 `json_extract`, and the 347
raw `.prepare()` sites outside the adapter — concentrated in `lib/tenantContext.ts` (91),
`lib/defaultInstallPackage.ts` (43) and `domains/routing/policy/seed.ts` (35).

**Exit:** the incompatibility lint from Phase 0 reads zero; no `.prepare()` outside
`SqliteAdapter.ts` and `openclawOAuthProfiles.ts`; suite green on Postgres.

### Phase 3b — Fold the baseline into migration 00 (D7)

- Concatenate `db/pg-baseline/{01-tables,02-indexes,03-foreign-keys}.sql` into
  `db/pg-migrations/00-baseline.sql`, preserving statement order.
- Collapse to one `schema_migrations` definition, owned by the runner.
- Point `verifyMigrationsCurrent` at `db/pg-migrations` (this is also the P0-2 fix) and confirm the
  existing ledger rows still verify against the folded file's checksum, or re-record them once.
- Replace `pg-baseline/rename-mapping.json` and `deferred-type-tightening.json` references, both of
  which outlive the directory.

**Exit:** `db:install` builds the schema from `db/pg-migrations` alone; the resulting inventory
matches production's 71/224/130; `db/pg-baseline/` is gone and no code references it.

### Phase 4 — Environments and deployment (D1, D6)

- Move both dev instances to Postgres; add `DATABASE_URL` to `ecosystem.dev.config.js`.
- Rewrite `docs/SELF_HOSTING.md`, both `docker-compose.yml` files, `api/Dockerfile` and
  `docker/Dockerfile.api` for Postgres. Add the `.env.example` the repo does not have.
- Update `docs/BACKUP_RESTORE.md`, `docs/database-migration-runbook.md`,
  `docs/ARCHITECTURE_OVERVIEW.md`, `docs/INFRASTRUCTURE.md`, `docs/cli-onboarding.md`,
  `README.md:373` and `cli/README.md:23`.

**Exit:** a Docker deployment runs on Postgres from a clean checkout; both dev instances serve from
Postgres; no doc describes SQLite as the system of record.

### Phase 5 — Removal

Only after a stabilization window with both dev instances on Postgres and no engine-attributed
incident:

- Delete `api/src/db/schema.ts` (6,396), `adapter/dialect.ts` (843), `adapter/SqliteAdapter.ts` (118),
  `foreignKeyGuard.ts` (97), the SQLite branches of `client.ts`, `startupVerifier.ts`, `testDb.ts`,
  and the `getRawDb()` escape hatch.
- Collapse the `Db` interface: drop `Dialect`, the `dialect` field and every `db.dialect ===` branch.
- Retire `AGENT_HQ_DB_PATH`, `DATABASE_PATH` and the rollback comment in
  `ecosystem.production.config.js`.
- Keep `better-sqlite3` in `dependencies` for `openclawOAuthProfiles.ts` (D5), and add a lint that it
  is imported nowhere else.

**Exit:** `getEngine()` is gone; `grep -r better-sqlite3 api/src` returns only
`openclawOAuthProfiles.ts`; full suite green on Postgres; production unaffected.

## Risks

**R1 — Removing the rollback path.** `ecosystem.production.config.js` keeps `AGENT_HQ_DB_PATH` set
specifically so the frozen SQLite file is one line from being live. Phase 5 deletes that. *Mitigation:*
Phase 0's verified `pg_dump` restore replaces it, and Phase 5 does not start until that exists. The
frozen file and the six backups stay on disk regardless — they cost 18.5 GB and nothing else.

**R2 — The suite has never run on the production engine.** 104 of 160 files have no Postgres path,
and CI's Postgres coverage is 12 tests. Every "green suite" claim in the repo's history, including
this session's, is SQLite evidence. Phase 2 is where the accumulated Postgres-only defects surface,
and there is no way to know how many there are before starting. *Mitigation:* convert in tranches so
failures arrive in reviewable batches; treat the first tranche's defect density as the estimate for
the rest.

**R3 — Type affinity, unpriced.** SQLite accepts a string into an integer column; Postgres does not.
The baseline's 323 `bigint` columns include every boolean flag (`enabled bigint NOT NULL DEFAULT 1`),
and every timestamp is `text`. The translator does not touch booleans at all. Production has been
running on Postgres since Jul 29 without incident, which is real evidence — but only for paths
production exercises. *Mitigation:* Phase 2 on real data surfaces the rest; type tightening stays out
of scope so failures have one cause, not two.

**R4 — `initSchema` deletion removes undocumented repairs.** 6,396 lines of accumulated
`ensureTableColumn` calls and table rebuilds encode fixes for problems nobody remembers. Deleting it
is correct (D2) but assumes `db/pg-baseline` captured everything that mattered, and the baseline was
generated from a snapshot rather than derived from the repairs. *Mitigation:* the baseline already
describes production truthfully (71/879 vs 59/703); Phase 1's install path must be diffed against
production's live inventory, not just against itself.

**R5 — Two dev instances hold real data.** `agent-hq-dev.db` is 1.65 GB with an active WAL, and
`agent-hq-dev-2.db` has a WAL larger than the database, i.e. un-checkpointed. Moving them means a data
transfer, not a config change. *Mitigation:* Phase 4 reuses the production transfer tooling in
`scripts/pg/`; checkpoint both WALs before copying anything.

## Open questions

- **[open]** Retention for the 18.5 GB of SQLite files (`backups/` ×6 at 2.7 GB, `~/.agent-hq` ×2,
  `agent-hq.db` at 2.4 GB). Keep, archive, or delete after Phase 0's restore is proven?
- **[open]** Stabilization window length between Phase 4 and Phase 5, and who calls the abort.
- **[open]** Does self-hosting ship a Postgres container in `docker-compose.yml`, or require an
  external database? This decides how much of `docs/SELF_HOSTING.md` survives.
- **[open]** Whether `scripts/pg/provision.mjs` is retired by Phase 1 or kept for one-off snapshot
  imports.
- **[open]** Effort for Phase 2 is genuinely unknown until the first tranche lands (see R2). No
  estimate is offered here rather than a fabricated one.
