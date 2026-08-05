# PostgreSQL-only migration — handoff

Written 2026-08-04, at commit `d4e24f3e`.
Companion to `docs/postgres-only-migration-spec.md`, which holds the decisions and rationale.
This document is the *state of play* and the *order of work*, for a session picking this up cold.

Read the spec's decisions D1–D7 before starting. They are settled; do not re-litigate them.

---

## Where things actually stand

Production has run on PostgreSQL (`agent_hq_prod`) since 2026-07-29. Everything below is about
removing the SQLite code that is still in the repository.

| | Then | Now |
|---|---:|---:|
| Test files genuinely exercising PostgreSQL | 17 | **48** |
| Test files still pinned to SQLite | 78 | **57** |
| — of those, calling `initSchema()` | 31 | 25 |
| — of those, constructing `new Database(` | 52 | 37 |
| CI PostgreSQL coverage | 1 file, 12 tests | **whole suite** |

Both engines are green at HEAD: **164 suites on PostgreSQL, 162 on SQLite.**

Verify with:

```bash
cd api
npx jest                                                              # SQLite
AGENT_HQ_TEST_PG_URL="postgresql://localhost/postgres" npx jest       # PostgreSQL
```

### Done

- **Phase 0** — PostgreSQL backups exist and a restore has been performed (`scripts/backup-pg.sh`,
  launchd job `com.atlas-hq.backup`, daily 02:00 with `--verify`). The boot gate verifies real
  migrations. Dev `.env` files no longer point at production.
- **Phase 1** — `npm run db:install` creates a PostgreSQL database from empty. Verified
  byte-identical to production: 69 tables, 291 indexes, 130 FKs, 862 columns, diffed not counted.
- **Phase 2, partial** — 31 files converted, CI runs the full suite on PostgreSQL.
- **Phase 4, partial** — both dev *databases* migrated and current (`agent_hq_dev`,
  `agent_hq_dev_2`), data verified row-for-row. The dev *processes* still run on SQLite.

### Not done

Phase 2 remainder, Phase 3, Phase 3b, the rest of Phase 4, Phase 5.

---

## Traps already paid for

Each of these cost real time to find. Do not rediscover them.

1. **A green suite is not evidence of PostgreSQL.** A file calling `initSchema()` builds SQLite no
   matter what the environment says, and then passes. The only files that prove anything are those
   using `setupTestDb()`, where a hard invariant throws if the dialect is not `postgres`.

2. **Jest gives every test file a fresh module registry.** `pg/testFixture.ts` caches the worker
   pool in module state, so it is null again at the start of each file. The fixture reuses an
   existing worker database rather than recreating it; do not "fix" that back.

3. **Never `pg_terminate_backend` to clear a database.** The connection you kill is usually the one
   serving the test running right now. It converts a setup failure into a baffling mid-assertion
   error. Recorded in `testFixture.ts`.

4. **A failed statement poisons the whole PostgreSQL transaction.** Any `try { insert } catch {
   select }` duplicate-detector is broken on PostgreSQL — the recovery query cannot run. Wrap the
   insert in `db.withTransaction` (a savepoint). Fixed once in `recurringTaskScheduler.ts`; **look
   for this shape elsewhere, it is likely not the only one.**

5. **`Number.isFinite(Number(x))` is not a null guard.** `Number(null)` is `0`. There were 16 sites
   of this shape; only `taskNotifications.ts` is fixed. The others are worth auditing.

6. **The source schema is looser than the target.** SQLite declares 7 foreign keys on `tasks`; the
   baseline declares 10. `initSchema` and the baseline have also diverged on columns. Any tooling
   driven by `PRAGMA foreign_key_list` is blind to the difference — `purge-orphans.mjs` was, and is
   now fixed to parse the target's `ALTER TABLE` statements instead.

7. **`migrate.ts` ends in a top-level `void main()`.** Importing anything from it runs a migration.
   Shared constants live in `pg/migrationDirs.ts` for that reason.

8. **`loadMigrations` returns `[]` for a missing directory.** That once made the boot gate pass on
   any schema at all. It now refuses on an empty migration set — keep that.

---

## Phase 2 remainder — convert the last 57 test files

**The bulk of the work.** By directory: `db` 16, `routes` 14, `lib` 14, `services` 4, `scheduler` 3,
`runtimes` 3, `domains` 2, `mcp` 1. Get the current list with:

```bash
cd api
sort -u <(grep -rl 'initSchema(' src --include='*.test.ts') \
        <(grep -rl 'new Database(' src --include='*.test.ts')
```

### How to convert one

Replace the SQLite bootstrap — `initSchema()`, `new Database()`, `AGENT_HQ_DB_PATH` juggling, temp
files, hand-written `CREATE TABLE` blocks — with `setupTestDb()` / `teardownTestDb()` from
`api/src/db/testDb.ts`. Application code reaches its database through `getDb()` as it already does.
Read `api/src/routes/routing.audit.test.ts` for the shape.

Verify each file on **both** engines before keeping it:

```bash
cd api
AGENT_HQ_TEST_PG_URL="postgresql://localhost/postgres" npx jest <file> --runInBand
npx jest <file> --runInBand
```

### Rules that matter more than throughput

- **Never weaken a test to make it pass.** Not by deleting an assertion, loosening a matcher, or
  adding a skip. A test that cannot pass on PostgreSQL is a *finding*: report it and leave the file
  alone. Two of this migration's most valuable results came from agents that refused to pin an
  assertion.
- A hand-built fixture's minimal schema has no real foreign keys; the baseline does. Rows may now
  need a parent. **Insert the parent** — do not drop the constraint or the assertion.
- Genuinely SQLite-only tests (PRAGMA-driven repairs, legacy pre-tenant databases) belong in a
  `describeSqliteOnly(...)` block, keeping every assertion. They are deleted with `initSchema` at
  Phase 5, not before.
- The PostgreSQL template is DDL-only and truncated between tests. Anything `initSchema` seeded as a
  side effect — notably the **default tenant** — is absent and must be seeded explicitly.

### Known-hard files

- `db/sprintFieldSchemaMigration.test.ts`, `db/tasksStatusConstraintMigration.test.ts`,
  `db/danglingForeignKeyRepair.test.ts`, `db/startupVerifier*.test.ts`, `db/adapter/adapter.test.ts`
  — these test `initSchema` / the SQLite adapter *itself*. They are **deleted at Phase 5**, not
  converted.
- `lib/openclawOAuthProfiles.test.ts` — **keeps SQLite forever.** It reads external OpenClaw
  databases, which does not change.
- `domains/runs/transcriptProvider.terminal.test.ts` — was converted and reverted. It passes alone
  and fails in a full SQLite run: its CHECK-constraint assertion is order-dependent because
  `initSchema` rebuilds tables. Convert it *after* the SQLite path is gone, or diagnose the ordering.

### Exit

All files converted or explicitly quarantined; `db/testDb.test.ts` green (it lints for false-green
conversions); both engines green.

---

## Phase 3 — SQL portability sweep

Rewrite application SQL into PostgreSQL dialect so the translator becomes redundant. Counts are
non-test, excluding `db/adapter/` and `db/schema.ts`:

| Construct | Sites |
|---|---:|
| `datetime('now'` | 285 |
| `PRAGMA` | 39 |
| `INSERT OR IGNORE` | 30 |
| `sqlite_master` | 18 |
| `julianday` | 7 |
| `json_set` | 5 |
| `GROUP_CONCAT` | 3 |
| `strftime` | 2 |
| `json_extract` | 2 |
| raw `.prepare(` outside the adapter | 325 |

Five non-test files still hold the raw driver: `lib/openclawOAuthProfiles.ts` (stays),
`lib/tenantContext.ts`, `lib/timestamps.ts`, `db/schema.ts` (deleted at Phase 5),
`db/startupVerifier.ts`.

Two that cannot be mechanically rewritten:

- **`json_extract`** in `domains/tasks/readModel.ts:413,416` binds a `'$.a.b'` path as a
  *parameter*. PostgreSQL's equivalent takes bare key names, so **the caller must change**, not just
  the SQL.
- **`julianday`** — all 7 are in `routes/telemetry.ts`. The translator approximates it with a
  constant epoch offset; rewriting is better than trusting that.

Wire `findIncompatibilities()` from `db/adapter/dialect.ts` into a lint first — it detects the nine
constructs the translator refuses to translate and **currently has no caller on any execution path**,
so those reach PostgreSQL verbatim and fail at runtime. Cheap, and it ratchets.

**Exit:** that lint reads zero; no `.prepare(` outside `SqliteAdapter.ts` and
`openclawOAuthProfiles.ts`; both engines green.

---

## Phase 3b — fold the baseline into migration 00

`db/pg-baseline/` is *generated from a SQLite snapshot* by `scripts/pg/generate-baseline-schema.mjs`,
which requires `better-sqlite3` and a `.db` path. Its header says "regenerate from the snapshot
instead" — an instruction that becomes impossible once SQLite is gone.

Concatenate `01-tables.sql`, `02-indexes.sql`, `03-foreign-keys.sql` into
`db/pg-migrations/00-baseline.sql`, preserving statement order. This also settles the competing
`schema_migrations` definitions: the baseline currently declares the ledger itself, *without*
`IF NOT EXISTS`, which is why the runner must create it only *after* the migration that may have
declared it. One definition, owned by the runner.

Existing ledger rows key on filename, so folding changes checksums — re-record them once, on
production and both dev databases.

**Exit:** `db:install` builds from `db/pg-migrations` alone; inventory still matches production;
`db/pg-baseline/` is gone and nothing references it. Future regeneration is `pg_dump --schema-only`.

---

## Phase 4 remainder — deployment surface

**This was attempted and reverted.** Its adversarial reviewers found 43 blocker/wrong findings. The
work is real, but redo it with verification rather than reuse the reverted draft. Actual errors it
contained, as a checklist of what to get right:

- `SCHEMA_MIGRATION_REQUIRED` **does not occur on PostgreSQL.** The boot gate raises
  `MigrationPendingError` / `MigrationDriftError`. Several docs asserted the wrong code.
- `schema_migrations` has **no `version` column**. It keys on `id`.
- `docker/.env.agents.example` does not exist.
- The `agent-hq-data` volume no longer exists if compose is rewritten; docs referenced it anyway.
- `docker-compose.yml` declares **no `build:` section**, so "docker compose build" instructions fail.
- `cp .env.example .env && cd api && npm run db:install` does not work from a clean checkout —
  `db:install` runs `dist/`, so it needs a build first.

Two **genuine findings** from that attempt, worth keeping:

1. The container `WORKDIR` must be `/app/api`, and the image must `COPY db/`.
   `pg/migrationDirs.ts` resolves the repo root four levels up from its compiled location; with
   `dist` at `/app/dist` that lands at `/`, so the image looks for `/db/pg-baseline`.
2. **The image must carry `db/` even though it never migrates** — otherwise `loadMigrations` finds
   nothing and the boot gate passes vacuously. (The vacuous-pass itself is already fixed in code.)

Also in scope: `docs/SELF_HOSTING.md`, `docs/BACKUP_RESTORE.md`, `docs/ARCHITECTURE_OVERVIEW.md`,
`docs/INFRASTRUCTURE.md`, `docs/cli-onboarding.md`, `README.md:373`, `cli/README.md:23`, and a
`.env.example` (which does not exist).

### Moving the dev processes

The databases are ready and current. `ecosystem.dev.config.js` reads **only**
`AGENT_HQ_DEV_DATABASE_URL`, deliberately with no fallback to a plain `DATABASE_URL` — a fallback
resolves to `postgresql://localhost/agent_hq_prod` from this checkout, which would attach a dev API
to production. Both dev `.env` files already set the dev-scoped key.

Remaining: the dev checkouts at `~/agent-hq-dev` and `~/agent-hq-dev-2` are **separate git
checkouts at older commits**. They must pull this commit before `ecosystem.dev.config.js` knows the
key exists. Then `pm2 restart agent-hq-dev-api --update-env` and confirm `DATABASE_URL` is set.

---

## Phase 5 — removal

Only after a stabilization window with both dev instances on PostgreSQL.

Delete `db/schema.ts` (6,396 lines), `adapter/dialect.ts` (843 → ~130; keep `toPositionalParams`,
which is self-contained), `adapter/SqliteAdapter.ts`, `foreignKeyGuard.ts`, the SQLite branches of
`client.ts` / `startupVerifier.ts` / `testDb.ts`, and `getRawDb()`. Drop `Dialect` and every
`db.dialect ===` branch. Retire `AGENT_HQ_DB_PATH` and `DATABASE_PATH`.

Delete the 12 SQLite-coupled scripts in `scripts/pg/` — but **only after** Phase 2, since several
are codemods that phase needs. Keep `db/pg-migrations/` and `pg/migrationRunner.ts` permanently.

**`better-sqlite3` stays in `dependencies`.** `lib/openclawOAuthProfiles.ts` reads external OpenClaw
databases. Add a lint that it is imported nowhere else.

---

## Still open

- **Rotate `OPENCLAW_HOOKS_TOKEN`.** Both dev `.env` files carry production's live value. Needs
  coordinating with whatever consumes it.
- **Audit the other 15 `Number.isFinite(Number(x))` sites** (trap 5).
- **Look for more poisoned-transaction `try/catch` duplicate detectors** (trap 4).
- Retention for the ~18.5 GB of SQLite files now that a verified PostgreSQL restore exists.
- Whether self-hosting ships a PostgreSQL container or requires an external database.
- Stabilization window length, and who calls the abort.

## A note on running this with agents

The two workflow runs behind this state used ~5.2M subagent tokens and were both cut off by session
limits. If you fan out again:

- Run **one session at a time**. Two sessions share the budget.
- Batch conservatively and **stop the workflow before the limit hits** rather than after — a clean
  stop leaves whole files, a cut-off leaves half-edited ones.
- After any interruption, test every touched file individually on both engines before keeping it.
  `git diff --name-only` versus the workflow's reported list finds the casualties.
