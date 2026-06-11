#!/bin/sh
# entrypoint.sh — OpenClaw agent container startup script
#
# 1. Validates required environment variables
# 2. Renders /root/.openclaw/openclaw.json from template + env vars (envsubst)
# 3. Copies identity docs from mounted workspace into the agent dir
# 4. Starts `openclaw gateway start` (or whatever CMD was passed)

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
RESET='\033[0m'

log()  { printf "[entrypoint] %s\n" "$1"; }
ok()   { printf "${GREEN}[entrypoint] ✓ %s${RESET}\n" "$1"; }
fail() { printf "${RED}[entrypoint] ✗ %s${RESET}\n" "$1" >&2; }

# ── Required env var check ────────────────────────────────────────────────────
MISSING=0
for VAR in OPENCLAW_MODEL AGENT_ID HOOKS_TOKEN GATEWAY_AUTH_TOKEN ANTHROPIC_API_KEY CONTAINER_PORT AGENT_HQ_API_URL; do
    eval "VAL=\$$VAR"
    if [ -z "$VAL" ]; then
        fail "Required env var not set: $VAR"
        MISSING=1
    else
        ok "$VAR is set"
    fi
done

if [ "$MISSING" -eq 1 ]; then
    fail "One or more required env vars are missing. Aborting."
    exit 1
fi

# ── Render openclaw.json from template ───────────────────────────────────────
TEMPLATE_FILE="/root/.openclaw/openclaw.template.json"
CONFIG_FILE="/root/.openclaw/openclaw.json"

if [ ! -f "$TEMPLATE_FILE" ]; then
    fail "openclaw.template.json not found at $TEMPLATE_FILE — image build error"
    exit 1
fi

log "Rendering openclaw.json from template..."
# envsubst replaces only the variables we explicitly name to avoid clobbering
# any literal ${...} in the JSON that aren't ours.
envsubst '${AGENT_ID} ${OPENCLAW_MODEL} ${HOOKS_TOKEN} ${GATEWAY_AUTH_TOKEN} ${ANTHROPIC_API_KEY} ${MINIMAX_API_KEY} ${CONTAINER_PORT}' \
    < "$TEMPLATE_FILE" > "$CONFIG_FILE"
ok "openclaw.json rendered (port ${CONTAINER_PORT}, agent ${AGENT_ID})"

# ── Copy identity docs from workspace into agent dir ─────────────────────────
# The workspace volume is mounted at /workspace. Identity docs (SOUL.md,
# IDENTITY.md, AGENTS.md, TOOLS.md, etc.) are COPY-ed into /workspace at
# build time and also need to live in /root/.openclaw/agent so openclaw
# picks them up as the agentDir backing.
AGENT_DIR="/root/.openclaw/agent"
mkdir -p "$AGENT_DIR"

for DOC in SOUL.md IDENTITY.md AGENTS.md TOOLS.md BOOTSTRAP.md HEARTBEAT.md USER.md; do
    SRC="/workspace/$DOC"
    if [ -f "$SRC" ]; then
        cp "$SRC" "$AGENT_DIR/$DOC"
        ok "Copied $DOC → $AGENT_DIR/$DOC"
    fi
done

# ── SSH directory permissions ─────────────────────────────────────────────────
if [ -d /root/.ssh ]; then
    chmod 700 /root/.ssh
    find /root/.ssh -type f \( -name "*.pem" -o -name "id_*" \) \
        ! -name "*.pub" | xargs -r chmod 600
fi

# ── Workspace check ───────────────────────────────────────────────────────────
if [ ! -d /workspace ]; then
    fail "/workspace directory not found. Mount a workspace volume."
    exit 1
fi
ok "/workspace is available"

log "Starting OpenClaw agent: ${AGENT_ID}"
log "Model:          ${OPENCLAW_MODEL}"
log "Agent HQ API:   ${AGENT_HQ_API_URL}"
log "Gateway port:   ${CONTAINER_PORT}"

# ── Hand off to CMD ───────────────────────────────────────────────────────────
exec "$@"
