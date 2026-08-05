# PostgreSQL backup and restore

Agent HQ's system of record is PostgreSQL 17. Database backups must be logical PostgreSQL
archives; copying the PostgreSQL container volume or old SQLite files is not a supported
database backup. Docker-managed workspace files and editable contract templates are separate
operator data and need a file backup as well.

## Create and verify a backup

Run from a host with PostgreSQL 17 client tools and `DATABASE_URL` set:

```bash
mkdir -p backups/pg
stamp=$(date -u +%Y-%m-%d_%H-%M-%S)
pg_dump --format=custom --no-owner --file="backups/pg/agent-hq_${stamp}.dump" "$DATABASE_URL"
pg_restore --list "backups/pg/agent-hq_${stamp}.dump" >/dev/null
```

Archive verification proves the file is readable. A restore drill proves it is
usable and should be run regularly:

```bash
createdb agent_hq_restore_check
pg_restore --no-owner --exit-on-error --dbname=agent_hq_restore_check \
  backups/pg/agent-hq_YYYY-MM-DD_HH-MM-SS.dump
DATABASE_URL=postgresql:///agent_hq_restore_check npm --prefix api run db:migrate:status
dropdb agent_hq_restore_check
```

Use an exact, disposable database name and confirm it before `dropdb`. Store at
least one encrypted copy off the application host and monitor both job exit status
and archive age.

## Restore after an incident

1. Stop the Agent HQ API so no writes occur during the restore.
2. Preserve the damaged database for investigation.
3. Create a new empty PostgreSQL database; do not restore over a live database.
4. Restore the selected custom-format archive with `pg_restore --exit-on-error`.
5. Point `DATABASE_URL` at the restored database and run `npm run db:migrate`.
6. Require `npm run db:migrate:status` to report no pending or drifted migration.
7. Start the API and verify `/health`, row counts, a read, and a reversible write.

Example:

```bash
createdb agent_hq_restored
pg_restore --no-owner --exit-on-error --dbname=agent_hq_restored \
  backups/pg/agent-hq_YYYY-MM-DD_HH-MM-SS.dump
cd api
DATABASE_URL=postgresql:///agent_hq_restored npm run db:migrate
DATABASE_URL=postgresql:///agent_hq_restored npm run db:migrate:status
```

The API never creates, migrates, repairs, or seeds a database at boot. A missing,
pending, or drifted migration prevents startup with `MIGRATION_PENDING` or
`MIGRATION_DRIFT` until an operator runs the explicit command.

## Docker volume recovery

The bundled service stores PostgreSQL files in `agent-hq-postgres-data`. Treat the
volume as runtime storage, not a portable backup. Restore a `pg_dump` archive into
a new database/container, verify it, then switch the application connection.

The stack also stores agent workspaces in `agent-hq-workspaces`, editable contract templates in
`agent-hq-contracts`, and uploaded files in `agent-hq-uploads`. Back them up separately while the
API and migration service are stopped.
For example, copy their contents from a stopped one-shot container into an encrypted backup
location, and restore them before starting the API. A `pg_dump` archive does not contain these
volumes.

`docker compose down` retains all named volumes. `docker compose down -v` permanently removes
the database, workspaces, contract edits, and uploads and must only be used when intentionally
discarding all of them.

## Legacy files

Pre-cutover `.db` files may be retained as historical rollback evidence, but the
PostgreSQL-only application cannot open them. Do not present them as current backups.
