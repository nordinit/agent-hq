# agent-hq

CLI launcher for [Agent HQ](https://github.com/nordinit/agent-hq).

## Quick start

```bash
npm install -g @nordinit/agent-hq
agent-hq start
```

When Docker is available, `start` launches the packaged Compose stack: PostgreSQL
17, a one-shot migration service, the API, and the UI. Data persists in the
`agent-hq-postgres-data` volume; agent workspaces, editable contracts, and uploads persist in the
`agent-hq-workspaces`, `agent-hq-contracts`, and `agent-hq-uploads` volumes. The UI is available at
[http://localhost:3500](http://localhost:3500).

## Requirements

- Node.js 18 or newer
- Docker Desktop / Docker Engine with Compose v2 for the default mode
- For `--no-docker`: Git and an existing PostgreSQL server

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
There is no SQLite fallback.

Native mode caches source under `~/.agent-hq/source/`, installs dependencies,
builds API/UI, runs the explicit database install command, and manages the two
Node processes through `~/.agent-hq/local.json`. Connection URLs are never stored
in that state file.

## Commands

| Command | Description |
|---|---|
| `agent-hq init` | Configure providers, runtime, and starter records |
| `agent-hq start` | Start Agent HQ |
| `agent-hq restart` | Restart Agent HQ |
| `agent-hq stop` | Stop Agent HQ |
| `agent-hq status` | Show runtime status |
| `agent-hq open` | Open the UI |
| `agent-hq help` | Show help |

Port overrides use `--port-api`, `--port-ui`, `AGENT_HQ_API_PORT`, and
`AGENT_HQ_UI_PORT`.

## License

Agent HQ is source-available under the Sustainable Use License. See [LICENSE](LICENSE).
