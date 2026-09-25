# agent-hq

CLI launcher for [Agent HQ](https://github.com/nordinit/agent-hq).

## Quick start

```bash
npm install -g @nordinit/agent-hq
agent-hq start
agent-hq open
```

When Docker is available, `start` pulls and launches the packaged Compose stack: PostgreSQL
17, a one-shot migration service, the API, and the UI. Data persists in the
`agent-hq-postgres-data` volume; agent workspaces, editable contracts, and uploads persist in the
`agent-hq-workspaces`, `agent-hq-contracts`, and `agent-hq-uploads` volumes. The UI is available at
[http://localhost:3500](http://localhost:3500), and the API and UI ports are published on
`127.0.0.1` only.

## Operator token

Every API request and every UI session needs the operator token. The first `start` generates
one and keeps it in `~/.agent-hq/.env` (mode `0600`); an `AGENT_HQ_OPERATOR_TOKEN` in the
environment takes precedence. `agent-hq open` opens the UI signed in, and `agent-hq token`
prints the token, for example to paste on the sign-in page or to send as
`Authorization: Bearer <token>` from a script.

Docker Compose also reads `~/.agent-hq/.env`, so plain `docker compose` commands run from
`~/.agent-hq` keep working.

## Requirements

- Node.js 22 or newer (native mode builds and runs the API and UI with the same Node; Agent HQ
  is tested on 22)
- Docker Desktop / Docker Engine with Compose v2 for the default mode
- For `--no-docker`: Git and an existing PostgreSQL 17 server

The Docker images contain no `git`, `claude`, `codex`, `hermes`, or `openclaw` binaries. To run
Claude Code, Codex, or Hermes agents, or workflows that check out a repository per task, use
native mode on the host where those tools are installed.

## Modes

```bash
# Default; bundled PostgreSQL
agent-hq start

# Require Docker explicitly
agent-hq start --docker

# Native Node processes; requires a PostgreSQL URL
DATABASE_URL=postgresql://user:password@127.0.0.1:5432/agent_hq \
  agent-hq start --no-docker
```

If Docker is unavailable, plain `start` exits with setup guidance. Native mode is
selected only by `--no-docker`, even when a PostgreSQL URL is already present.

Native mode caches source under `~/.agent-hq/source/`, installs dependencies,
builds API/UI, runs the explicit database install command, and manages the two
Node processes through `~/.agent-hq/local.json`. Connection URLs are never stored
in that state file.

## Commands

| Command | Description |
|---|---|
| `agent-hq init` | Plan or write a first-install setup config (`~/.agent-hq/config.json`); `--dry-run` prints the plan |
| `agent-hq onboard` | Connect a provider and a runtime and create starter records through the API |
| `agent-hq start` | Start Agent HQ, generating the operator token on first start |
| `agent-hq restart` | Restart Agent HQ |
| `agent-hq stop` | Stop Agent HQ |
| `agent-hq status` | Show runtime status |
| `agent-hq open` | Open the UI, signed in with the operator token |
| `agent-hq token` | Print the operator token |
| `agent-hq help` | Show help |

Port overrides use `--port-api`, `--port-ui`, `AGENT_HQ_API_PORT`, and
`AGENT_HQ_UI_PORT`.

## OpenClaw

On `start` and `restart`, the CLI adds or updates the bundled Agent HQ capability-tools plugin in
`~/.openclaw/openclaw.json` (its entry, load path, and tool allow entry), pointing it at the API
and at `~/.agent-hq/.env` for the token. The token itself is not copied into the OpenClaw config.
The file is rewritten only when something changed.

## License

Agent HQ is open source under the MIT License. See [LICENSE](LICENSE).
