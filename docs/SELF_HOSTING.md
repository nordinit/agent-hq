# Self-hosting Agent HQ

Agent HQ uses PostgreSQL 17 as its system of record. The recommended deployment is
the repository's Docker Compose stack, which includes PostgreSQL, an explicit
one-shot migration service, the API, and the UI.

## Requirements

- Docker Engine with Compose v2, or Node.js 20+ plus PostgreSQL 17
- Git for source-checkout installs
- Enough persistent storage for PostgreSQL and logical backups

## Docker quick start

```bash
git clone https://github.com/nordinit/agent-hq.git
cd agent-hq
cp .env.example .env
# Set AGENT_HQ_POSTGRES_PASSWORD in .env.
docker compose up --build -d
docker compose ps
```

Services:

| Service | Purpose | Exposure |
|---|---|---|
| `agent-hq-postgres` | PostgreSQL 17 | private Compose network |
| `agent-hq-migrate` | one-shot install/migration | none |
| `agent-hq-api` | Express API | `3501` by default |
| `agent-hq-ui` | Next.js UI | `3500` by default |

Four named volumes persist operator data:

- `agent-hq-postgres-data` contains the PostgreSQL cluster.
- `agent-hq-workspaces` contains starter and agent workspace files.
- `agent-hq-contracts` contains editable task-contract templates. Docker initializes it
  from the templates shipped in the image on first use.
- `agent-hq-uploads` contains project, workflow, task, and chat attachment files.

`docker compose down` keeps all four. `docker compose down -v` deletes all four, including
workspace files, contract edits, and uploads; do not use it as a routine restart command.

The migration container is the only schema writer during startup. The API waits for
it to succeed, then verifies the migration ledger without changing schema or config.

## Configuration

Copy `.env.example` and set the values needed by your deployment:

```dotenv
AGENT_HQ_API_PORT=3501
AGENT_HQ_UI_PORT=3500
AGENT_HQ_POSTGRES_DB=agent_hq
AGENT_HQ_POSTGRES_USER=agenthq
AGENT_HQ_POSTGRES_PASSWORD=replace-with-a-long-url-safe-random-value
NEXT_PUBLIC_API_URL=https://agent-hq.example.com/api
```

PostgreSQL is not published to the host by default. The bundled local password is
therefore network-private, but it should still be replaced. Because Compose also interpolates
this value into a connection URI, use URL-safe characters. If a password contains URI-reserved
characters, set `AGENT_HQ_POSTGRES_PASSWORD` to its literal value and provide a separate
`DATABASE_URL` whose password component is percent-encoded.

### External PostgreSQL

Set a complete `DATABASE_URL` to make Agent HQ use an external PostgreSQL 17 server:

```dotenv
DATABASE_URL=postgresql://agenthq:password@db.example.com:5432/agent_hq
```

The bundled database container may remain running but is unused when this override is
set. Ensure the external server accepts connections from both the migration and API
containers, and back it up independently.

## Native Node deployment

Native mode requires an existing PostgreSQL server; there is no file-database fallback.

```bash
git clone https://github.com/nordinit/agent-hq.git
cd agent-hq/api
npm ci
npm run build
DATABASE_URL=postgresql://user:password@127.0.0.1:5432/agent_hq npm run db:install

cd ../ui
npm ci
npm run build

cd ../api
PORT=3501 DATABASE_URL=postgresql://user:password@127.0.0.1:5432/agent_hq npm start
```

Run the UI separately with `PORT=3500 npm start`, or use the checked-in PM2 ecosystem
files. Production reads `DATABASE_URL`; dev maps the deliberately scoped
`AGENT_HQ_DEV_DATABASE_URL` to the API process so a copied production environment cannot
silently attach dev to production.

## CLI launcher

`agent-hq start` uses Docker by default when Docker is available, giving a complete
PostgreSQL-backed install. `--docker` forces that mode. Native mode is explicit:

```bash
DATABASE_URL=postgresql://user:password@127.0.0.1:5432/agent_hq \
  agent-hq start --no-docker
```

Native mode fails clearly if neither `DATABASE_URL` nor `AGENT_HQ_DATABASE_URL` is set.

## Schema and configuration lifecycle

- `npm run db:install` installs schema and, only for a tenant-empty database, initial defaults.
- `npm run db:migrate` applies numbered schema migrations only.
- `npm run db:migrate:status` is read-only and reports applied, pending, and drifted IDs.
- API boot verifies and refuses stale schema; it never migrates or repairs.
- Starter workflow rows become operator-owned after installation. Deleting or editing a
  transition is durable; unrelated routing changes do not recreate it.
- A deliberate tenant-create or explicit reinstall action may create defaults for that tenant.

See [database-migration-runbook.md](database-migration-runbook.md) for upgrade order.

## Backups

Use PostgreSQL logical backups for the system of record:

```bash
pg_dump --format=custom --no-owner --file=agent-hq.dump "$DATABASE_URL"
pg_restore --list agent-hq.dump >/dev/null
```

Regularly restore into a disposable database and run `db:migrate:status`. See
[BACKUP_RESTORE.md](BACKUP_RESTORE.md).

PostgreSQL archives do not include files from `agent-hq-workspaces`, `agent-hq-contracts`, or
`agent-hq-uploads`. Back up those volumes separately if you use container-managed workspaces,
edit contract templates, or accept uploaded files.

## OpenClaw and runtime settings

Agent HQ can connect to a host OpenClaw gateway or containerized agent gateways. Pass
gateway URLs/tokens as environment variables or configure them through supported setup
flows. Never bake secrets into images. When the API runs in Docker and OpenClaw runs on
the host, use a host-reachable address such as `host.docker.internal` where supported.

The CLI manages one narrowly scoped external setting: on first start or when the bundled
capability-tools plugin path/version changes, it adds or updates that plugin entry in
`~/.openclaw/openclaw.json`. Subsequent starts compare the desired entry and do not rewrite an
unchanged file. This is OpenClaw integration state, not Agent HQ workflow/routing configuration.

The external OpenClaw product may itself store OAuth profiles in SQLite. Agent HQ reads those
files and, during an explicitly requested OAuth-profile sync, may update OpenClaw's profile store.
Those external files are not Agent HQ's system of record.

## Upgrades

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose ps
```

Compose waits for PostgreSQL, runs the one-shot migration, and starts the API only on
success. For native deployments, build first, take a verified backup, run `db:migrate`,
check status, then restart the API.

## Troubleshooting

- `MIGRATION_PENDING`: run the explicit migration command from the same release.
- `MIGRATION_DRIFT`: an applied SQL file changed; restore it and add a new migration.
- `No migrations found`: the image/release omitted `db/pg-migrations/`.
- Connection refused: verify host, port, TLS, credentials, and PostgreSQL readiness.
- Docker API never starts: inspect `docker compose logs agent-hq-migrate` first.

Do not work around startup verification by changing ledger rows manually. The legacy
baseline adoption path is implemented and validated by the migration command.
