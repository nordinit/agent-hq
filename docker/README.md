# Docker Agent Container

This directory contains the template and supporting files for running a single
OpenClaw agent in a Docker container, as well as the full-fleet Compose config.

---

## Agent fleet port map

`docker-compose.agents.yml` defines one service per Agency agent.
All services expose port 3700 inside the container; each maps to a unique host port.

| Service name | Agent ID          | Host port |
|--------------|-------------------|-----------|
| `pixel`      | agency-frontend   | **3710**  |
| `forge`      | agency-backend    | **3711**  |
| `harbor`     | agency-devops     | **3712**  |
| `scout`      | agency-qa         | **3713**  |
| `rook`       | agency-qa2        | **3714**  |
| `archer`     | agency-sales      | **3715**  |
| `wren`       | agency-pm         | **3716**  |
| `maven`      | agency-ads        | **3717**  |
| `pulse`      | pulse             | **3718**  |

Update each agent's Remote Gateway URL in Agent HQ to match its host port,
e.g. `http://localhost:3710` for `pixel`. The underlying compatibility field
is still stored as `hooks_url`.

---

## Starting the full fleet

```sh
# 1. Copy the env template and fill in secrets
cp docker/.env.agents.example .env.agents
$EDITOR .env.agents   # set ANTHROPIC_API_KEY, HOOKS_TOKEN, GATEWAY_AUTH_TOKEN

# 2. Build all images (run from repo root)
docker compose -f docker/docker-compose.agents.yml --env-file .env.agents build

# 3. Start the fleet
docker compose -f docker/docker-compose.agents.yml --env-file .env.agents up -d

# 4. Tail logs for a specific agent
docker compose -f docker/docker-compose.agents.yml logs -f forge
```

To start a single agent:
```sh
docker compose -f docker/docker-compose.agents.yml --env-file .env.agents up -d forge
```

> **No host-side openclaw.json required.** The entrypoint script uses `envsubst`
> to render `openclaw.json` at container startup from the template baked into the
> image (`/root/.openclaw/openclaw.template.json`).  All secrets stay in `.env.agents`
> and never touch the image layers.

---

## Directory layout

```
docker/
├── Dockerfile.agent                  # Parameterized agent container template
├── docker-compose.agents.yml         # Full agent fleet definition
├── .env.agents.example               # Env var template — copy to .env.agents
├── entrypoint.sh                     # Startup script: validates env, renders openclaw.json, launches openclaw
├── README.md                         # This file
├── keys/                             # Per-agent SSH key pairs (gitignored)
│   └── <AGENT_ID>/                   # e.g. agency-backend/
│       ├── id_ed25519                # Private key (never commit)
│       └── id_ed25519.pub            # Public key
└── config/
    ├── openclaw.template.json        # envsubst template — baked into image, rendered at startup
    ├── openclaw.agent.template.json  # Legacy manual-fill template (kept for reference)
    └── <AGENT_ID>/                   # One directory per agent slug
        ├── SOUL.md                   # Agent persona and mandate
        ├── IDENTITY.md               # Name, role, slug, session key
        ├── AGENTS.md                 # Operating manual
        ├── TOOLS.md                  # Tool notes and environment config
        ├── BOOTSTRAP.md              # Startup checklist          (optional)
        ├── HEARTBEAT.md              # Heartbeat template         (optional)
        └── USER.md                   # Client / project context   (optional)
```

---

## What each container needs

| Layer | What | How it gets there |
|-------|------|-------------------|
| Base image | Node.js LTS (22) on Debian slim | `FROM node:22-slim` |
| System tools | Chromium (headless), git, ssh, curl, envsubst | `apt-get` at build time |
| OpenClaw binary | `openclaw` CLI | `npm install -g openclaw` at build time |
| Agent identity files | SOUL.md, IDENTITY.md, AGENTS.md, TOOLS.md | `COPY` at build time from `config/<AGENT_ID>/` |
| openclaw.json template | Gateway config template (no secrets) | `COPY` at build time from `config/openclaw.template.json` |
| openclaw.json (rendered) | Final config with auth tokens, agent list | Rendered at container startup via `envsubst` from template + env vars |
| Workspace | Agent working directory | Named volume or bind-mount at `-v workspace:/workspace` |
| SSH keys | git / remote server access | Bind-mount at runtime (`-v ~/.ssh:/root/.ssh:ro`) |

---

## Exposed ports

| Port | Service | Notes |
|------|---------|-------|
| **3700** | OpenClaw gateway | Default for containerized agents. Map to any host port with `-p <host>:3700`. |

Each agent container runs its own gateway on port 3700 inside the container.
When running multiple agents on the same host, map each to a unique host port:

```
agent-backend  → -p 3700:3700
agent-frontend → -p 3701:3700
agent-qa       → -p 3702:3700
```

---

## Required environment variables

| Variable | Description | Example |
|----------|-------------|---------|
| `OPENCLAW_MODEL` | Model string for inference | `anthropic/claude-sonnet-4-6` |
| `ANTHROPIC_API_KEY` | Anthropic API key — rendered into openclaw.json at startup | `sk-ant-...` |
| `AGENT_ID` | Agent slug — must match the slug baked into the image at build time | `agency-backend` |
| `HOOKS_TOKEN` | Gateway hooks auth token — rendered into openclaw.json at startup | `abc123...` |
| `GATEWAY_AUTH_TOKEN` | Gateway HTTP auth token — rendered into openclaw.json at startup | `xyz456...` |
| `CONTAINER_PORT` | Internal gateway port (default `3700`) | `3700` |
| `AGENT_HQ_API_URL` | Agent HQ API base URL | `http://host.docker.internal:3501` |

The entrypoint script will abort on launch if any of these are missing or empty.
It then renders `openclaw.json` from `/root/.openclaw/openclaw.template.json` via
`envsubst`, so secrets never need to be pre-staged on the host.

---

## Building an agent image

### 1. Create the agent config directory

Copy the example and customize for your agent:

```sh
cp -r docker/config/example-agent docker/config/agency-backend
# Edit SOUL.md, IDENTITY.md, AGENTS.md, TOOLS.md for the agent
```

### 2. Build the image

Run from the **repo root** (so the build context includes `docker/config/`):

```sh
docker build \
  -f docker/Dockerfile.agent \
  --build-arg AGENT_ID=agency-backend \
  --build-arg NODE_VERSION=22 \
  --build-arg OPENCLAW_VERSION=latest \
  -t openclaw-agent:agency-backend \
  .
```

> **Build context:** Always build from the repo root — the Dockerfile COPYs from
> `docker/config/<AGENT_ID>/`, which must be reachable from the build context.

---

## Running a single agent container

No host-side `openclaw.json` staging is required.  Pass all secrets as env vars
and the entrypoint renders the config at startup.

```sh
docker run -d \
  --name openclaw-agency-backend \
  \
  # Required env vars
  -e OPENCLAW_MODEL="anthropic/claude-sonnet-4-6" \
  -e ANTHROPIC_API_KEY="<your-anthropic-api-key>" \
  -e AGENT_ID="agency-backend" \
  -e HOOKS_TOKEN="<your-hooks-token>" \
  -e GATEWAY_AUTH_TOKEN="<your-gateway-auth-token>" \
  -e CONTAINER_PORT="3700" \
  -e AGENT_HQ_API_URL="http://host.docker.internal:3501" \
  \
  # Workspace volume
  -v openclaw-workspace-agency-backend:/workspace \
  \
  # SSH keys (bind-mount read-only)
  -v ~/.ssh:/root/.ssh:ro \
  \
  # Expose the gateway
  -p 3711:3700 \
  \
  openclaw-agent:agency-backend
```

### Verify the container started

```sh
docker logs openclaw-agency-backend
# Should show entrypoint validation checks and "Starting OpenClaw agent: agency-backend"

docker ps | grep agency-backend
```

---

## Running multiple agents on the same host

Each agent gets its own container, image, workspace volume, and host port mapping.
Use the fleet Compose file for the full set, or `docker run` individually:

```sh
# Agency backend — host port 3711
docker run -d --name openclaw-agency-backend \
  -e AGENT_ID="agency-backend" \
  -e OPENCLAW_MODEL="anthropic/claude-sonnet-4-6" \
  -e ANTHROPIC_API_KEY="<key>" \
  -e HOOKS_TOKEN="<token>" \
  -e GATEWAY_AUTH_TOKEN="<gw-token>" \
  -e CONTAINER_PORT="3700" \
  -e AGENT_HQ_API_URL="http://host.docker.internal:3501" \
  -v openclaw-ws-agency-backend:/workspace \
  -v ~/.ssh:/root/.ssh:ro \
  -p 3711:3700 \
  openclaw-agent:agency-backend

# Agency frontend — host port 3710
docker run -d --name openclaw-agency-frontend \
  -e AGENT_ID="agency-frontend" \
  -e OPENCLAW_MODEL="anthropic/claude-sonnet-4-6" \
  -e ANTHROPIC_API_KEY="<key>" \
  -e HOOKS_TOKEN="<token>" \
  -e GATEWAY_AUTH_TOKEN="<gw-token>" \
  -e CONTAINER_PORT="3700" \
  -e AGENT_HQ_API_URL="http://host.docker.internal:3501" \
  -v openclaw-ws-agency-frontend:/workspace \
  -v ~/.ssh:/root/.ssh:ro \
  -p 3710:3700 \
  openclaw-agent:agency-frontend
```

Agent HQ hooks target the agent's gateway URL. Update the agent record in
Agent HQ with the correct host+port for each container (see port map above).

---

## Stopping and removing a container

```sh
docker stop openclaw-agency-backend
docker rm openclaw-agency-backend
```

---

## Environment notes

- **Chromium** is installed system-wide at `/usr/bin/chromium`. The env vars
  `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` and
  `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` tell OpenClaw and Puppeteer to
  use it instead of downloading their own bundle.
- **SSH keys** at `/root/.ssh` are bind-mounted read-only. The entrypoint
  script ensures correct permissions (`700` for the directory, `600` for
  private key files) on every startup.
- **Workspace** at `/workspace` persists in a Docker named volume. The
  openclaw config symlinks `/root/.openclaw/workspace-<AGENT_ID>` → `/workspace`
  so OpenClaw resolves the workspace correctly.
- **openclaw.json** is never written into the image. It is always injected
  at runtime to keep secrets out of image layers.
