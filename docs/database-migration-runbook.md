# Database migration runbook

PostgreSQL migration files under `db/pg-migrations/` are the sole schema authority.
API startup is read-only with respect to schema and configuration.

## Build first

Database commands execute compiled code:

```bash
cd api
npm ci
npm run build
```

## Fresh install

```bash
DATABASE_URL=postgresql://user:password@host:5432/agent_hq npm run db:install
```

`db:install` applies all migrations. It creates starter configuration only when the
database has no tenant; rerunning it against an installed database leaves all
operator-owned workflow configuration unchanged.

## Upgrade

```bash
DATABASE_URL=postgresql://user:password@host:5432/agent_hq npm run db:migrate:status
DATABASE_URL=postgresql://user:password@host:5432/agent_hq npm run db:migrate
DATABASE_URL=postgresql://user:password@host:5432/agent_hq npm run db:migrate:status
```

`db:migrate` applies schema migrations only. It never re-seeds routing rules,
transitions, requirements, statuses, or other configuration.

Each migration is checksummed and recorded by `id` in `schema_migrations`.
Applied files are immutable; change the schema with a new numbered file.

## Schemas

The tables live in eight schemas: `core`, `agents`, `workflow`,
`tasks`, `runs`, `chat`, `access` and `telemetry`. `public` holds only
`schema_migrations`. Application SQL names tables without a schema, and the search
path `public, core, agents, workflow, tasks, runs, chat, access, telemetry` resolves
them. Every Agent HQ pool sets that path when it connects (`api/src/db/pg/schemas.ts`).
The baseline also sets it as the database default, so psql and DBeaver sessions see
the same names. A restore without `--create` drops that default, but the API still works.

- Name the schema when a migration creates a table, function or view, for example
  `CREATE TABLE tasks.task_labels (...)`. An unqualified `CREATE TABLE` lands in
  `public`, and `schemaLayout.test.ts` fails.
- Keep table names unique across schemas, so that an unqualified name means one table.
- `00-schema.sql` runs `ALTER DATABASE … SET search_path`, which needs the database
  owner or a superuser.

## The whole-schema baseline

`00-schema.sql` creates the entire schema. On 2026-11-12 it replaced `00-baseline.sql` and
migrations 12 through 53, and it was checked to build a database identical to that chain. New
migrations continue the numbering from 54.

A database that applied the whole folded chain adopts the baseline. The explicit migration
command checks that every folded migration is in the ledger with its known checksum, then records
`00-schema.sql` without running it. The folded rows, and the older 01/02/03 rows, stay in the
ledger as provenance (`FOLDED_MIGRATIONS` in `api/src/db/pg/migrationRunner.ts`).

A ledger that holds only part of the chain fails closed, and so does one from before migration 00.
Migrate such a database with release `e88d5e77` first, which still ships the full chain, and then
with the current release. Startup and `db:migrate:status` only report the pending baseline; they
never adopt it.

## Deployment order

1. Take and validate a `pg_dump --format=custom` backup.
2. Build and test the release against PostgreSQL 17.
3. Stop or drain writers when the release requires a maintenance window.
4. Run `db:migrate` once from the new release.
5. Require a clean `db:migrate:status` result.
6. Start/restart the API and verify `/health` plus a reversible read/write smoke test.

The API refuses to listen when migrations are absent, pending, or drifted. Relevant
error codes are `MIGRATION_PENDING` and `MIGRATION_DRIFT`.

## Docker

Compose runs `agent-hq-migrate` as a one-shot service after PostgreSQL is healthy.
The API depends on that service completing successfully and performs verification,
not migration, on its own boot.
