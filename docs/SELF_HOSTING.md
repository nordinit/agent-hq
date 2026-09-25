# Self-hosting Agent HQ

Agent HQ uses PostgreSQL 17 as its system of record. The recommended deployment is
the repository's Docker Compose stack, which includes PostgreSQL, an explicit
one-shot migration service, the API, and the UI.

## Requirements

- Docker Engine with Compose v2, or Node.js 22+ plus PostgreSQL 17
- Git for source-checkout installs
- Enough persistent storage for PostgreSQL and logical backups

## Docker quick start

```bash
git clone https://github.com/nordinit/agent-hq.git
cd agent-hq
cp .env.example .env
# Set AGENT_HQ_POSTGRES_PASSWORD, and AGENT_HQ_OPERATOR_TOKEN to the output of
# `openssl rand -hex 32`, in .env.
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

`AGENT_HQ_OPERATOR_TOKEN` is required; see [Authentication](#authentication).

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

## Authentication

Agents run real CLIs with shell access on this host, so Agent HQ refuses anonymous callers.
There are no user accounts: one operator token, `AGENT_HQ_OPERATOR_TOKEN`, is the credential
for the operator.

- **Generate it** with `openssl rand -hex 32` and give the same value to the API and the UI.
  The API refuses to start without it (and anything under 32 characters), and Docker Compose
  refuses to run. `agent-hq start` generates one and keeps it in `~/.agent-hq/.env` (mode
  `0600`); `agent-hq token` prints it.
- **UI.** Every page asks for a signed-in session. Paste the token on the sign-in page, or run
  `agent-hq open`, which opens `/login?token=…`; the UI signs in and redirects the token out of
  the address bar. The session is an httpOnly, `SameSite=Lax` cookie (`Secure` over HTTPS)
  holding an expiry and an HMAC keyed from the token. It lasts seven days and renews while you
  use it. Nothing is stored server-side, so **rotating the token signs every browser out**;
  sign out in the sidebar ends only the current browser's session. The UI server attaches the
  token when it forwards `/api/v1` calls, and never sends it to the browser.
- **API.** Every `/api/v1` request presents exactly one credential:
  - the operator token, as `Authorization: Bearer <token>`, for full operator access; or
  - an agent's MCP API key, as `x-api-key: <key>` or `Authorization: Bearer <key>`. The
    request runs as that agent and is limited to the key's capability grants.

  A request with neither is refused with `401 api_auth_required`; a request with two different
  credentials with `401 api_credentials_conflict`. Answering without a credential: `/health`,
  `/openapi.json` (also `/api/v1/openapi.json`), `/mcp` and the MCP OAuth endpoints (which have
  their own authentication), and chat-attachment links the API signs for agents.
- **Chat WebSocket.** The browser opens `/api/v1/chat/ws` directly on the API port. The API
  accepts the UI's session cookie there (cookies are per host, not per port) or the operator
  token, after the existing `Origin` check.
- **Scripts and tools.** Send the operator token for operator actions, or an agent's MCP key
  for anything an agent should be limited in:

  ```bash
  curl -H "Authorization: Bearer $AGENT_HQ_OPERATOR_TOKEN" http://127.0.0.1:3501/api/v1/projects
  ```

### Report mode for existing installs

`AGENT_HQ_AUTH_MODE=report` serves requests that enforcement would refuse, exactly as before,
and logs each distinct caller once per process (by method, path pattern, user agent and remote
address):

```text
[api-auth:report] would reject GET /api/v1/tasks/:id (no credential) user-agent="curl/8.7.1" remote=127.0.0.1
```

Run an upgraded install in report mode until no new lines appear, fix each caller, then remove
the setting (enforce is the default). In enforce mode refusals are logged once per caller as
`[api-auth] rejected …`. Report mode is a migration aid: while it is on, an agent can still
reach everything without a key.

Keeping the API and UI on loopback remains the default. Publishing either beyond this host
still needs TLS in front, since the token and session cookie travel on every request.

## Native Node deployment

Native mode requires an existing PostgreSQL server.

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
export AGENT_HQ_OPERATOR_TOKEN=$(openssl rand -hex 32)   # keep it; the UI needs the same value
PORT=3501 DATABASE_URL=postgresql://user:password@127.0.0.1:5432/agent_hq npm start
```

Run the UI separately with `PORT=3500 AGENT_HQ_OPERATOR_TOKEN=… npm start`, or use the
checked-in PM2 ecosystem files, which pass `AGENT_HQ_OPERATOR_TOKEN` and
`AGENT_HQ_AUTH_MODE` from the repository `.env` to both processes. Production reads `DATABASE_URL`; dev maps the deliberately scoped
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

In both modes the first start generates the operator token into `~/.agent-hq/.env` and passes
it to the API and UI. `agent-hq open` opens the UI signed in, and `agent-hq token` prints the
token. The CLI also points the OpenClaw capability-tools plugin at that file
(`apiTokenFile`), so assigned tools keep loading.

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

Certificate verification is skipped only for a gateway on loopback (the local gateway's
self-signed certificate); every other gateway, and every other outbound HTTPS request, is
verified. Trust a self-signed remote gateway with `NODE_EXTRA_CA_CERTS`, or, as a last resort,
set `OPENCLAW_GATEWAY_TLS_INSECURE=1`, which exempts gateway sockets only.

The CLI manages one narrowly scoped external setting: on first start or when the bundled
capability-tools plugin path/version changes, it adds or updates that plugin entry in
`~/.openclaw/openclaw.json`, including the API URL and the path of the file holding the
operator token (never the token itself). Installs that wire the plugin by hand must give it a
credential; see `plugins/openclaw-capability-tools/README.md`. Subsequent starts compare the desired entry and do not rewrite an
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
success. Upgrading from a release without authentication: set `AGENT_HQ_OPERATOR_TOKEN` first,
and consider one run with `AGENT_HQ_AUTH_MODE=report` (see
[Report mode](#report-mode-for-existing-installs)). For native deployments, build first, take a verified backup, run `db:migrate`,
check status, then restart the API.

## Troubleshooting

- `MIGRATION_PENDING`: run the explicit migration command from the same release.
- `MIGRATION_DRIFT`: an applied SQL file changed; restore it and add a new migration.
- `No migrations found`: the image/release omitted `db/pg-migrations/`.
- Connection refused: verify host, port, TLS, credentials, and PostgreSQL readiness.
- Docker API never starts: inspect `docker compose logs agent-hq-migrate` first.
- API exits with `[api-auth] AGENT_HQ_OPERATOR_TOKEN is not set`: set it (see
  [Authentication](#authentication)).
- `401 api_auth_required` from a script or integration: send the operator token or an MCP key.
- The sign-in page says the token is not configured: the UI process lacks
  `AGENT_HQ_OPERATOR_TOKEN`, or it is shorter than 32 characters.
- Chat never connects: the page and the API must be reached under the same host name, so the
  browser sends the session cookie to the API port.

Do not work around startup verification by changing ledger rows manually. The legacy
baseline adoption path is implemented and validated by the migration command.
