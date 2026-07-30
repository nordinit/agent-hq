# Agent HQ — PostgreSQL Migration Plan

Status: planning
Branch: `feat/postgres-migration`
Last updated: 2026-07-28

## Scope of this document

This is the revised nine-phase plan for moving Agent HQ off single-file SQLite onto PostgreSQL. It
records the three architecture decisions that shape the sequencing, the phases with their exit
criteria, and the risks that actually threaten the cutover.

Every number below was measured, not estimated. Sources are the `feat/postgres-migration` worktree at
`/Users/nordini/agent-hq-postgres` and read-only queries against the live production database at
`~/.agent-hq/agent-hq.db`. Where a fact was not available to the author it is marked **[open]** rather
than filled in.

## Baseline

Production database, measured 2026-07-28:

| Property | Value |
|---|---|
| Size on disk | 2.7 GB |
| Tables | 72 |
| Indexes | 230 |
| Journal mode | WAL |
| `foreign_keys` | ON |

Largest tables by row count. These were read from the live production database, so the append-only
tables grow between queries — figures are accurate to the moment of measurement, not stable constants:

| Table | Rows |
|---|---:|
| `chat_messages` | 513,672 |
| `task_history` | 193,926 |
| `task_notes` | 114,724 |
| `session_messages` | 69,802 |
| `logs` | 62,870 |
| `dispatch_log` | 9,621 |
| `default_package_applications` | 8,095 |
| `job_instances` | 7,787 |
| `task_events` | ~7,700 |
| `instance_artifacts` | 6,559 |

The bulk of the volume is observability data — chat, history, notes, session messages, logs. The
operational core (`tasks` 681, `agents` 66, `sprints`) is small. This shapes the transfer strategy in
Phase 6: the hot tables are trivially fast, and essentially all transfer time is the append-only
observability tail.

Codebase surface, measured on the worktree:

| Property | Value |
|---|---:|
| Non-test TypeScript files under `api/src` | 266 |
| Test files under `api/src` | 129 |
| Non-test files importing `getDb` | 76 |
| `prepare(` call sites (non-test) | 1,831 |
| `.get(` call sites (non-test) | 1,048 |
| `.run(` call sites (non-test) | 706 |
| `.all(` call sites (non-test) | 385 |
| `.exec(` call sites (non-test) | 259 |
| `.transaction(` call sites (non-test) | 79 |
| `api/src/db/schema.ts` | 6,324 lines |
| Express route handlers already `async` | 40 |
| Express route handlers still synchronous | 234 |

`better-sqlite3` `^12.6.2` is the only database driver in `api/package.json`. There is no `pg`,
`postgres`, `pglite`, or ORM dependency present yet — Phase 4 introduces the first one.

Target engine available locally: **PostgreSQL 17.9** (Homebrew, aarch64-apple-darwin24.6.0), socket at
`/tmp`, superuser `nordini`, with `agent_hq_dev`, `agent_hq_test` and `agent_hq_rehearsal` already
provisioned.

## Architecture decisions

### AD-1 — The async conversion is executed on SQLite first, as its own shippable change

`better-sqlite3` is a synchronous API. Every Postgres driver is asynchronous. Converting the data
layer and converting the engine are therefore two changes that both touch the same ~3,900 call sites,
and doing them in one commit produces a diff nobody can review and a bisect range nobody can use.

**Decision:** land the full sync-to-async conversion while still running on `better-sqlite3`, wrapping
its synchronous calls in already-resolved promises. The engine does not change. The test suite must be
green against SQLite at the end of the phase.

Rationale:

- It separates a mechanical, high-volume, low-risk refactor (async plumbing) from a semantic,
  low-volume, high-risk one (SQL dialect and transaction semantics). Each gets reviewed on its own
  terms.
- If a regression appears after the engine swap, the async conversion is already known-good on the old
  engine, so the search space is the swap alone.
- It surfaces the real cost early. 234 of 274 route handlers are still synchronous; `.transaction(`
  appears at 79 sites and `better-sqlite3`'s transaction helper takes a *synchronous* callback, so
  every one of those is a genuine restructure rather than an `await` insertion. Finding that out in
  Phase 1 is much cheaper than finding it out mid-cutover.
- It is independently revertable. If the Postgres work is paused, the async layer is still a net
  improvement and ships on its own.

Cost accepted: one full pass over the data layer that delivers no user-visible benefit, and a
temporary state where the code is async but the engine is not.

### AD-2 — The `sprint` → `workflow` rename is deferred until after cutover

Two large migrations of the same tables must not be in flight at once.

`sprint_id` exists on **13 tables** and `sprint_type` on **6** (verified against the live database on
2026-07-28 — see `docs/sprint-to-workflow-data-model-migration-spec.md`, correction section, which
also documents that the original 2026-06-02 spike under-reported both lists). The tables carrying
those columns are the same tables the engine migration must move: `tasks`, `sprint_task_*`,
`recurring_task_series`, `story_point_model_routing`, `task_events`, `external_event_mappings`.

**Decision:** migrate the physical schema to Postgres under its **current** `sprint_*` names. Do the
rename afterwards, on Postgres, as a separate project.

Rationale:

- Renaming during the move means a row-count or checksum mismatch has two possible causes instead of
  one. Migration validation depends on being able to compare source and target table-for-table and
  column-for-column; a rename destroys that property exactly when it is most needed.
- The rename gets materially cheaper on Postgres. The 2026-06-02 spike's central objection was that
  SQLite requires full table rebuilds to rename FK-bound columns, and that compatibility views need
  `INSTEAD OF` triggers because SQLite foreign keys cannot target views. Postgres has transactional
  DDL, `ALTER TABLE ... RENAME COLUMN` that preserves constraints and indexes, and updatable views.
  Deferring converts the hardest part of the rename into a much easier one.
- The rename is a compatibility-window project (API aliases, MCP tool names, OpenAPI, agent
  contracts, deployed agents), not a schema project. Its critical path is client sunset, not DDL.
  Coupling it to an infrastructure cutover with a maintenance window helps neither.

Consequence accepted: Postgres ships carrying `sprint_*` physical names, and the workflow-terminology
debt documented in the recovered audit's F9 persists past cutover. This is deliberate.

### AD-3 — PGlite is the local/dev/test engine; server PostgreSQL is the production engine

Agent HQ's local-first property is load-bearing. Today a contributor clones, runs `npm run db:install`,
and has a working system with no external service. Requiring a PostgreSQL server for local development
would regress that, and it would regress CI, where 129 test files currently run against a file the
suite creates and throws away.

**Decision:** run PGlite (embedded Postgres compiled to WASM) for local development, the test suite,
and single-user self-hosted installs. Run server PostgreSQL 17 for the production deployment. Both are
reached through one engine-agnostic interface introduced in Phase 4.

Rationale:

- PGlite is real PostgreSQL, so the SQL dialect, type system and transaction semantics are the same
  ones production runs. That is the whole point: a `pg`-vs-PGlite split is far narrower than a
  Postgres-vs-SQLite split, so tests passing locally means substantially more than it does today.
- It preserves zero-dependency `npm install && npm test`, which keeps CI simple and keeps the
  self-hosting story in `docs/SELF_HOSTING.md` intact.
- Per-test isolation stays cheap — an in-memory PGlite instance per suite replaces the throwaway
  SQLite file, without a shared server that serialises the run.

Risks accepted, and the mitigation:

- PGlite is single-connection and has no concurrent-writer story, so it cannot validate connection
  pooling, lock contention, or the concurrency behaviour of the dispatcher and scheduler loops.
- PGlite and server Postgres can differ in extension availability and in some configuration
  defaults.

Mitigation: `agent_hq_rehearsal` on the real PostgreSQL 17 server is the authority. Phase 5 requires
the full suite green on **both** engines, and Phases 6 and 8 run against the server only. PGlite is
never the sole signal for anything concurrency-related.

**[open]** PGlite version to pin, and whether the production deployment is the local Homebrew server
or a managed host, are not yet decided. Both must be settled before Phase 4 closes.

## Phases

Nine phases, 0 through 8. A phase is done when its exit criteria are demonstrably met — a command that
was actually run, with its output recorded.

### Phase 0 — Baseline, freeze points, and rehearsal harness

Establish what "correct" means before anything changes.

- Capture the production baseline: per-table row counts for all 72 tables, index inventory,
  `PRAGMA foreign_key_check`, `PRAGMA integrity_check`.
- Stand up the comparison harness: given a source SQLite file and a target Postgres database, diff
  row counts per table, diff column inventories, and run a fixed set of representative queries
  against both, comparing results.
- Confirm the snapshot workflow. `~/.agent-hq/pg-migration-snapshots/prod-snapshot.db` (2.6 GB) is the
  working copy; production is read-only to all migration work.

**Exit:** harness runs end-to-end against the snapshot and a freshly installed `agent_hq_dev`,
reporting a clean diff on an empty target (i.e. it correctly reports every table as missing rows).
Baseline numbers committed to the repo.

### Phase 1 — Async conversion of the data layer, on SQLite (AD-1)

- Convert `getDb()` and every consumer to an async interface. All 1,831 `prepare(` sites and their
  ~2,100 `.get(`/`.run(`/`.all(` executions become awaited.
- Restructure all 79 `.transaction(` sites. `better-sqlite3`'s transaction helper requires a
  synchronous callback, so these cannot be mechanically awaited — each needs an explicit
  begin/commit/rollback scope that a real driver can honour.
- Convert the 234 remaining synchronous route handlers, and audit error propagation: an async handler
  that throws without a `catch` or `next(err)` produces an unhandled rejection rather than a 500.
- Engine unchanged. `better-sqlite3` stays.

**Exit:** `npx tsc --noEmit` clean; full suite green against SQLite; zero synchronous `getDb()`
consumers remain; no unhandled-rejection warnings in a full suite run.

### Phase 2 — SQL portability sweep, still on SQLite (AD-1)

Remove dialect-specific SQL while the old engine can still verify each change.

Known non-portable constructs, counted in non-test sources:

| Construct | Sites | Postgres equivalent |
|---|---:|---|
| `datetime('now')` | 411 | `now()` / `CURRENT_TIMESTAMP` |
| `PRAGMA ...` | 116 | no equivalent; replace with `information_schema` or drop |
| `AUTOINCREMENT` | 78 | `GENERATED ... AS IDENTITY` (DDL only) |
| `INSERT OR IGNORE` | 40 | `INSERT ... ON CONFLICT DO NOTHING` |
| `strftime(...)` | 2 | `to_char(...)` |
| `INSERT OR REPLACE` | 1 | `INSERT ... ON CONFLICT DO UPDATE` |
| `json_extract(...)` | 1 | `->` / `->>` / `jsonb_path_query` |

Also in scope, and not findable by grep — these need reading, not substitution:

- Type affinity. SQLite accepts a string into an `INTEGER` column; Postgres rejects it. Every insert
  path that relies on coercion breaks loudly at cutover.
- Boolean handling. SQLite stores 0/1; Postgres has a real `boolean`. Both the DDL and every
  comparison need to agree.
- Timestamp representation. Currently TEXT via `datetime('now')`; decide `timestamptz` and pin UTC.
- `LIMIT` without `ORDER BY` — permissive in SQLite, non-deterministic in Postgres.
- Empty-string vs NULL, where SQLite's looser comparison semantics have been relied on.

**Exit:** the constructs above are at zero in non-test sources or explicitly waived with a recorded
reason; full suite still green against SQLite.

### Phase 3 — PostgreSQL schema authorship

- Translate `api/src/db/schema.ts` (6,324 lines) into Postgres DDL: 72 tables, 230 indexes,
  constraints, and foreign keys.
- Resolve the type mapping decided in Phase 2 — identity columns, `boolean`, `timestamptz`,
  `jsonb` for the `*_json` columns.
- Preserve the non-mutating startup contract from `docs/database-migration-runbook.md` exactly.
  `db:install` / `db:migrate` remain the only paths that touch schema; the API still verifies the
  `schema_migrations` ledger (`STARTUP_SCHEMA_LEDGER_ID = 'init_schema'`) and still refuses to serve
  on a stale or missing schema. `startupVerifier.ts` currently reads `sqlite_master` and must be
  rewritten against `information_schema` without weakening that contract.
- Replace the `PRAGMA integrity_check` post-migrate verification with a Postgres equivalent
  (constraint validation plus the Phase 0 comparison harness).

**Exit:** `db:install` builds a complete schema on empty `agent_hq_dev`; the resulting table, column,
index and constraint inventory matches the Phase 0 baseline; a stale-schema start still fails with
`SCHEMA_MIGRATION_REQUIRED`.

### Phase 4 — Engine abstraction and PGlite wiring (AD-3)

- Introduce the engine-agnostic interface behind `getDb()`, with three implementations: existing
  SQLite (retained for rollback until Phase 8 closes), PGlite, and server `pg`.
- Add the driver dependencies. Pin the PGlite version; settle the connection-pool configuration for
  `pg`.
- Select engine by environment, defaulting local and test to PGlite and production to server
  Postgres.

**Exit:** the same test file passes unmodified against all three engines; engine selection is
environment-driven with no call-site conditionals; the PGlite version and pool settings are pinned in
`package.json` and committed config.

### Phase 5 — Test suite green on Postgres

- Port the Jest fixture layer (`jest-global-setup.ts`, `jest-after-env.ts`, `jest-setup-env.ts`) from
  throwaway SQLite files to per-suite PGlite instances.
- Fix every test that asserts on SQLite-specific behaviour. The recovered spike identified the
  sprint-named physical fixtures; the ordering, type-affinity and boolean assumptions from Phase 2
  will surface more.
- Run the full 129-file suite against server PostgreSQL 17 (`agent_hq_test`) as well as PGlite.

**Exit:** all 129 test files green on PGlite **and** on server Postgres; no test skipped or marked
engine-specific without a recorded reason; `npx tsc --noEmit` clean.

### Phase 6 — Data transfer and rehearsal

- Build the transfer tool: SQLite snapshot → Postgres, in FK-dependency order, with identity-sequence
  reset after load and deterministic type coercion per Phase 2's decisions.
- Rehearse against `agent_hq_rehearsal` using the full 2.6 GB snapshot. Not a subset — the
  observability tables are where the time goes and where encoding surprises live.
- Validate with the Phase 0 harness: row counts for all 72 tables, FK integrity, and representative
  query results compared source-to-target.
- Measure wall-clock transfer time. That number sets the maintenance window in Phase 8; anything else
  is a guess.
- Rehearse at least twice, with the second run on a fresh snapshot, to confirm repeatability.

**Exit:** two consecutive clean rehearsals; row counts match exactly on all 72 tables; zero FK
violations; transfer duration recorded and reproducible.

### Phase 7 — Operational readiness

- Rewrite `docs/BACKUP_RESTORE.md` for Postgres. The recovered version is entirely SQLite-specific —
  `sqlite3 .backup`, file-mtime retention pruning, file-copy restore. All of it is superseded:
  `pg_dump`/`pg_basebackup`, WAL archiving, retention, and a restore procedure that has actually been
  executed rather than merely written. The April 2026 incident in that document — an API restart
  against an empty database, 700+ tasks lost, no backup — is the reason this phase is not optional.
- Rewrite `docs/database-migration-runbook.md` for Postgres, preserving the non-mutating startup
  contract verbatim.
- Write the cutover runbook: preconditions, ordered steps, validation gates, rollback trigger, and
  the named person who calls the abort.
- Establish backups on the target **before** cutover, and prove a restore works by performing one.

**Exit:** a restore from a Postgres backup into a scratch database has been executed and verified;
both runbooks updated; cutover runbook reviewed; backup schedule live on the target.

### Phase 8 — Cutover and stabilization

1. Announce the window, sized from the Phase 6 measurement plus margin.
2. Stop `agent-hq-api` (pm2), and stop the scheduler and dispatcher loops.
3. Take a final SQLite backup, and verify it restores.
4. Run the transfer against production Postgres.
5. Run the Phase 0 harness against the loaded target. **This is the go/no-go gate.**
6. Start the API on the Postgres engine.
7. Smoke test: task list/create/update, board read, dispatcher assignment, recurring-series
   generation, MCP tool round-trip, OpenAPI surface.
8. Monitor. Keep the SQLite file untouched and the SQLite engine implementation in the build for the
   agreed stabilization period.
9. Only after stabilization closes: remove the SQLite engine implementation and `better-sqlite3`.

**Rollback:** until step 9, revert to the previous app commit and the untouched SQLite file. That
path stays open for the entire stabilization period and is the reason step 9 is last.

**Exit:** production serving from Postgres; harness clean; smoke tests pass; stabilization period
elapsed with no engine-attributed incident; SQLite dependency removed.

### After Phase 8 — deferred work

The `sprint` → `workflow` physical rename (AD-2) begins here, on Postgres, as a separate project. Its
prerequisites are `docs/sprint-to-workflow-data-model-migration-spec.md` (including the corrected
column inventory) and the F9 finding in `docs/data-model-legacy-audit-2026-06-03.md`.

## Top risks

Ordered by expected cost, not by likelihood.

**R1 — Silent data corruption during transfer.** The failure that matters is not a crash; it is a
transfer that completes, reports success, and has quietly mangled type-coerced values in a table
nobody smoke-tests. `task_events` is the worked example: ~7,700 rows of which only 18 have a non-null
`sprint_id`, so a spot check of non-null values passes while 99.8% of the column goes unverified.
*Mitigation:* full row-count comparison on all 72 tables, not a sample; two clean rehearsals; harness
result is a hard go/no-go gate at cutover step 5.

**R2 — Transaction-semantic drift in the async conversion.** The 79 `.transaction(` sites are the
riskiest part of Phase 1. `better-sqlite3`'s synchronous transaction callback cannot be mechanically
converted, and a botched conversion produces work that commits outside its intended transaction — a
bug that passes tests and corrupts data under concurrency. *Mitigation:* review these 79 sites
individually rather than as part of the bulk refactor; add explicit rollback tests around the
dispatcher and task write-model paths.

**R3 — Concurrency behaviour that no test can see.** PGlite is single-connection (AD-3). The
dispatcher, reconciler, watchdog and recurring-task scheduler all contend for the same rows; SQLite's
single-writer WAL model has been masking whatever locking assumptions they encode. Postgres row-level
locking will surface them under real load, and a green PGlite suite says nothing about it.
*Mitigation:* `agent_hq_rehearsal` on the real server is the authority for anything concurrent; Phase
5 requires green on both engines; treat the stabilization period as the real concurrency test and
staff it accordingly.

**R4 — Type-affinity breakage at cutover rather than in test.** SQLite's permissive affinity has
almost certainly been absorbing coercions somewhere in 1,831 prepared statements. Postgres rejects
them. The ones the test suite exercises get caught in Phase 5; the ones only production data reaches
do not. *Mitigation:* Phase 6 rehearses on the **full** snapshot, which is the only place real
production values meet the strict engine before cutover does.

**R5 — Backup gap at the moment of highest exposure.** Cutover is precisely when a mistake is most
likely and least recoverable, and the target's backup infrastructure is new. The April 2026 incident
recorded in `docs/BACKUP_RESTORE.md` is the precedent: no backup existed, and 700+ tasks were lost.
*Mitigation:* Phase 7 requires a **performed and verified** Postgres restore before cutover, not a
documented one; the pre-cutover SQLite backup is also restore-verified (step 3); the SQLite file stays
untouched through stabilization.

**R6 — Long-lived branch divergence.** `feat/postgres-migration` touches the data layer in 76 files
while other streams keep landing on `main` — the recent history shows active work on MCP scoping,
recurring series, and workspace reclamation, all of which touch that layer. Phases 1 and 2 alone are a
~3,900-site refactor, so every conflict is resolved against code the resolver did not write.
*Mitigation:* land Phase 1 and Phase 2 to `main` on their own (AD-1 makes this possible — they are
SQLite-only and independently valuable); rebase frequently; keep the engine-swap phases as short as
the plan allows.

## What this plan does not yet cover

- **[open]** Production hosting target for PostgreSQL — local Homebrew server vs managed host.
- **[open]** PGlite version pin.
- **[open]** Stabilization-period length and the named owner of the abort decision.
- **[open]** Whether the observability tables (`chat_messages`, `task_history`, `task_notes`,
  `session_messages`, `logs` — ~955,000 rows combined, the bulk of the 2.7 GB) transfer in full or get
  a retention cutoff applied at migration time. This is the single largest lever on window length and
  it is a product decision, not a technical one.
