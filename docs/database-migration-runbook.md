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

## Baseline-00 adoption

Databases created before the baseline fold record `01-tables.sql`,
`02-indexes.sql`, and `03-foreign-keys.sql`. The explicit migration command verifies
their exact known checksums and records `00-baseline.sql` without replaying its DDL.
Partial or mismatched legacy ledgers fail closed. Startup only reports the pending
baseline and never performs adoption.

## Deployment order

1. Take and validate a `pg_dump --format=custom` backup.
2. Build and test the release against PostgreSQL 17.
3. Stop or drain writers when the release requires a maintenance window.
4. Run `db:migrate` once from the new release.
5. Require a clean `db:migrate:status` result.
6. Start/restart the API and verify `/health` plus a reversible read/write smoke test.

The API refuses to listen when migrations are absent, pending, or drifted. Relevant
error codes are `MIGRATION_PENDING` and `MIGRATION_DRIFT`; there is no SQLite
`SCHEMA_MIGRATION_REQUIRED` path.

## Docker

Compose runs `agent-hq-migrate` as a one-shot service after PostgreSQL is healthy.
The API depends on that service completing successfully and performs verification,
not migration, on its own boot.
