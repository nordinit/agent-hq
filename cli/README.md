# agent-hq

CLI launcher for [Agent HQ](https://github.com/nordinit/agent-hq) — task management for AI agent teams.

## Quick Start

```bash
npm install -g @nordinit/agent-hq
agent-hq start
```

That's it. Agent HQ will be running at [http://localhost:3500](http://localhost:3500).

## Requirements

- Node.js ≥ 18
- [Docker Desktop](https://docs.docker.com/get-docker/) (optional — only needed for `--docker`)
- Git (required for local/no-docker mode)

## Docker vs Local Mode

By default, Agent HQ runs in **local mode** — the API and UI run as native
Node.js processes with a local SQLite database.

Use Docker only when you explicitly want the Docker Compose stack:

```bash
agent-hq start --docker
```

Local mode:
- Clones the Agent HQ source from GitHub on first run (~/.agent-hq/source/)
- Installs OpenClaw automatically under `~/.openclaw` if it is not already available
- Starts or repairs the local OpenClaw gateway service automatically
- Configures the Agent HQ OpenClaw capability tools plugin and tool allow policy
- Installs dependencies and builds the API and UI
- Runs both as background Node processes
- Stores data in ~/.agent-hq/agent-hq.db (persists between restarts)
- Works on macOS, Linux, and Windows (Node 18+)

## Commands

| Command            | Description                          |
| ------------------ | ------------------------------------ |
| `agent-hq start`   | Start Agent HQ in local mode         |
| `agent-hq restart` | Restart Agent HQ                     |
| `agent-hq stop`    | Stop Agent HQ                        |
| `agent-hq status`  | Show current runtime status          |
| `agent-hq open`    | Open the UI in your browser          |
| `agent-hq help`    | Show help                            |

## Options

| Flag              | Description                          | Default |
| ----------------- | ------------------------------------ | ------- |
| `--port-api`      | Host port for the API                | 3501    |
| `--port-ui`       | Host port for the UI                 | 3500    |
| `--docker`        | Run with Docker Compose              | off     |
| `--no-docker`     | Alias for local mode                 | on      |

Environment variables `AGENT_HQ_API_PORT` and `AGENT_HQ_UI_PORT` also work.

## Examples

```bash
# Start in local mode (default)
agent-hq start

# Restart
agent-hq restart

# Start with Docker
agent-hq start --docker

# Start with custom ports
agent-hq start --port-ui 8080 --port-api 8081

# Check status
agent-hq status

# Stop
agent-hq stop
```

## License

Agent HQ is source-available under the Sustainable Use License. See [LICENSE](LICENSE).
