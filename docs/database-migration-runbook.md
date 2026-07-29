<!--
RECOVERED DOCUMENT — PROVENANCE

Source: git blob b3d3c00ce2f70571d58636b9450c09a9a2c01929
Commit: 494509b5a131347e41964768ae0491f76570c8f2^ — i.e. the last revision of this file before
        494509b ("Prepare repository for public release under nord-initiatives", Cinder, 2026-06-11)
        deleted it as part of stripping ops runbooks from the public repo.

This content PREDATES the 2026-06-11 public re-root. `main` was re-rooted at b2c3705 ("Initial public
release"), so 494509b is NOT an ancestor of HEAD and this file is absent from the working tree, from
HEAD, and from a fresh clone. It survived only as an unreachable object in this worktree's object
store and would be destroyed by a routine `git gc`.

CONTENTS DESCRIBE THE PRE-MIGRATION STATE — SQLite, `better-sqlite3`, `AGENT_HQ_DB_PATH` pointing at
a single `.db` file, and `PRAGMA integrity_check` as the post-migrate verification. The non-mutating
startup contract it documents is still the governing rule and survives the Postgres migration
unchanged: the API verifies the `schema_migrations` ledger and refuses to serve if the schema is
missing or stale, and normal boot must never create, alter, rebuild, repair, backfill or seed. Only
the engine-specific mechanics below (PRAGMA checks, file paths, install command internals) are
superseded by the Postgres work.
-->

# Agent HQ database migration runbook

Agent HQ API startup is intentionally non-mutating. The `agent-hq-api` process verifies that the database was already installed or migrated and refuses to serve if the schema migration ledger is missing or stale. Normal API boot must not create tables, alter tables, rebuild tables, repair schema, backfill data, or seed starter records.

## Fresh install / bootstrap

Build the API first, then run the explicit install command against the target database:

```bash
cd api
npm run build
AGENT_HQ_DB_PATH=/path/to/agent-hq.db npm run db:install
npm run db:migrate:status
```

`db:install` is an alias for the explicit migration command. It initializes a fresh database, applies the current schema/data migrations, records the `schema_migrations` ledger, verifies SQLite integrity, and exits. It is the only supported path for fresh schema bootstrap.

## Upgrade / deploy sequence

Run migrations before restarting PM2 or any API process:

```bash
cd api
npm run build
AGENT_HQ_DB_PATH=/path/to/agent-hq.db npm run db:migrate
AGENT_HQ_DB_PATH=/path/to/agent-hq.db npm run db:migrate:status
pm2 restart agent-hq-api --update-env
```

For the checked-in production PM2 config, the default production database is `/Users/nordini/.agent-hq/agent-hq.db`, so the production restart path is:

```bash
cd /path/to/agent-hq/api
npm run build
AGENT_HQ_DB_PATH=/Users/nordini/.agent-hq/agent-hq.db npm run db:migrate
AGENT_HQ_DB_PATH=/Users/nordini/.agent-hq/agent-hq.db npm run db:migrate:status
pm2 restart agent-hq-api --update-env
```

For the checked-in dev PM2 config, use the environment-specific database path shown in `ecosystem.dev.config.js` before restarting `agent-hq-dev-api`.

## Startup failure mode

If the API is started against an old or uninstalled database, it exits before listening with a `SCHEMA_MIGRATION_REQUIRED` error and a command hint:

```text
Run the explicit database migration/install command before starting the API: cd api && npm run db:migrate.
```

That failure is expected. Do not work around it by reintroducing schema creation, ALTER TABLE statements, table rebuilds, backfills, repair, or seed execution in `api/src/index.ts` or other normal boot paths.
