# PostgreSQL-only migration — handoff

Updated 2026-08-04. Companion to `docs/postgres-only-migration-spec.md`.

## Current state

The PostgreSQL-only implementation is present in the shared worktree. The remaining work is to
stabilize the combined edits, perform the old dev and production operational cutovers, verify the
release, commit it, and push it to `origin/main`.

Do not describe this as deployed yet. Full API verification has not completed for the final
combined worktree, the old dev processes have not been moved to clean official-main checkouts in
this turn, and the production release has not been deployed in this turn.

## What is implemented

- Runtime database access is PostgreSQL-only. `DATABASE_URL` or `AGENT_HQ_DATABASE_URL` is
  required; the SQLite adapter, dialect translator, `initSchema`, repair engine, and SQLite runtime
  branches are removed.
- Jest requires PostgreSQL and CI runs the API suite against PostgreSQL 17.
- `db/pg-migrations/` is the sole active schema directory. The old three-file baseline is folded
  into `00-baseline.sql`; deferred rename migrations stay under `staged/`.
- Explicit migration can adopt migration 00 only from the exact historical 01/02/03 checksums.
  Startup and status are read-only and reject pending, changed, or unknown ledger entries.
- `db:migrate` changes schema only. `db:install` installs starter configuration only when no tenant
  exists. Ordinary reads, routing changes, and restarts do not reseed deleted configuration.
- The graph UI no longer warns that a deleted starter transition may be recreated, because the
  automatic recreation path has been removed.
- Compose bundles PostgreSQL 17 and persists PostgreSQL data, workspaces, editable contracts, and
  uploads in separate named volumes.
- The CLI is Docker-first. Explicit native mode requires a PostgreSQL URL.
- The only intentional `better-sqlite3` use is OpenClaw OAuth/profile interoperability. It reads
  and writes OpenClaw-owned SQLite files, not Agent HQ data.
- The SQLite transfer/repair/codemod tools are slated for deletion with this release. Preserve a
  usable pre-removal copy until the final dev transfers and comparisons are complete.

## Configuration ownership contract

This is the behavior that prompted the work and must survive every cleanup:

```text
explicit install (once) -> create starter configuration
normal reads/writes     -> never reconcile starter configuration
explicit reinstall      -> recreate only because the operator requested it
```

A transition, requirement, status, mapping, or routing rule deleted after installation stays
deleted. Treat any later automatic recreation as a release blocker.

## Migration ledger constraints

Keep these rules exact:

1. `00-baseline.sql` is the current baseline and normal fresh-install path.
2. An old PostgreSQL database with all three exact 01/02/03 ledger entries may be adopted by an
   explicit `db:migrate`; partial or altered history fails without writes.
3. The exact historical `init_schema` provenance row is tolerated but never generated anew.
4. Applied migration IDs absent from the running release are an error. This prevents an old release
   from booting against a newer database.
5. `17-skill-package-files-and-content-repair.sql` is unrelated concurrent feature work, but
   production has already recorded its exact contents. Do not edit, omit, squash, or renumber it.

## External SQLite exception

Do not remove `better-sqlite3` from dependencies. `openclawOAuthProfiles.ts` deliberately accesses
OpenClaw's SQLite stores: provider discovery is read-only, while OAuth profile synchronization can
write OpenClaw's auth-profile store. Keep the exception isolated to that module and its tests. It
does not authorize SQLite in Agent HQ's data layer, fixtures, CLI, or deployment configuration.

## Remaining sequence

### 1. Stabilize the shared worktree

- Wait for all in-flight implementation edits to finish and inspect the complete diff.
- Remove stale SQLite-era test comments where they obscure current behavior, without weakening
  tests.
- Confirm migration 17 is unchanged from the already-recorded production bytes.
- Confirm the obsolete transfer-tool deletions do not remove the only copy needed for the final dev
  import; use a preserved checkout if they do.

### 2. Verify code before touching deployments

Run the repository's final API lint, PostgreSQL suite, and build from the combined worktree. Run the
UI verification/build and CLI tests as well. Do not copy old green counts into the release notes;
record the results from the final tree.

At minimum, retain focused coverage for:

- fresh PostgreSQL install and idempotent install rerun;
- exact legacy baseline adoption and rejection of partial/changed ledgers;
- startup verification producing zero writes;
- deleting a starter transition/requirement and observing no recreation;
- Docker/native CLI mode selection;
- SQL portability and `better-sqlite3` isolation.

### 3. Back up before each operational change

Take fresh PostgreSQL dumps and consistent SQLite backups before cutover. Retain every existing
`.db`, WAL, dump, and prior backup; this task does not authorize cleanup. Verify new PostgreSQL
archives before relying on them.

Compose database dumps do not contain `agent-hq-workspaces`, `agent-hq-contracts`, or
`agent-hq-uploads`; back up those named volumes separately when they contain operator changes.

### 4. Cut over development safely

The old dev checkouts have divergent history. Preserve them rather than forcing them onto main.
Create clean checkouts/worktrees from the verified release, carry forward only the intended dev
environment settings, and point each process at its own PostgreSQL database.

For each dev instance:

1. quiesce writers;
2. create/verify SQLite and PostgreSQL backups;
3. complete or repeat the data transfer from the preserved tooling copy;
4. run the explicit migration/status commands from the release checkout;
5. start the API only after the read-only boot gate passes;
6. compare critical row counts and exercise health, routing, task, and integration paths;
7. confirm deleting a starter transition remains durable.

Keep the old checkouts and databases intact until both clean dev deployments are stable.

### 5. Build and deploy the exact production release

Use a clean worktree at the release commit so excluded or concurrent dirty files cannot leak into
the build. Before restart, take and verify a fresh production PostgreSQL dump. Apply migrations
explicitly, verify ledger status, then deploy the API/UI and run health and functional smoke checks.

Production already uses PostgreSQL; this is a code/deployment cutover, not permission to discard
the frozen SQLite rollback files. Preserve those files after a successful deployment.

### 6. Rotate the shared hook token

Rotate `OPENCLAW_HOOKS_TOKEN` coherently across Agent HQ environments and its OpenClaw consumer,
restart the affected processes, and smoke-test the hook. Never print the token into logs or commit
it.

### 7. Commit and push

Review staged paths carefully because unrelated concurrent feature edits have shared this
worktree. Commit only the verified release contents, confirm the commit is on `main`, and push that
commit to `origin/main` after production checks pass.

## Operational cautions

- Never edit an applied migration to make the ledger green; run the release that owns the recorded
  migration bytes.
- Never start the API as a migration mechanism. A boot failure is an instruction to run the
  explicit command or use the correct release.
- Never use `docker compose down -v` during a routine restart; it removes database, workspace, and
  contract volumes.
- Never delete the old SQLite files or PostgreSQL dumps during this turn.
- Never "fix" a PostgreSQL test by weakening an assertion, skipping it, or substituting a SQLite
  fixture.
- Never allow an ordinary routing read/write to call a starter installer.

## Release exit criteria

The migration is complete only when all of the following are true and have fresh evidence from the
final release tree:

- API lint, PostgreSQL tests, and build pass.
- UI verification/build and CLI tests pass.
- Both clean dev deployments use their own PostgreSQL databases and pass data/behavior checks.
- Migration status is current and read-only boot succeeds in dev and production.
- Starter configuration remains operator-owned after install.
- Production backup, migration, deploy, health, and functional smoke checks pass.
- The shared hook token has been rotated without exposing it.
- All backups remain available.
- The verified commit is pushed to `origin/main`.
